require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const { createClient } = require('@supabase/supabase-js');

// Initialize Gemini Client
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB memory limit

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Supabase Client (server-side, uses service role key) ──────────────────────
const supabaseUrl = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'placeholder-service-key';
const anonKey = process.env.SUPABASE_ANON_KEY || 'placeholder-anon-key';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n❌  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables\n');
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const supabaseAuthClient = createClient(supabaseUrl, anonKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// General API: 200 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
});

// Auth routes: 10 attempts per 15 minutes (brute-force protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' }
});

// PDF parse: 5 per minute (Gemini calls are expensive)
const pdfLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many PDF uploads. Please wait a moment.' }
});

// ── Allowed Origins (set CORS_ORIGINS env var as comma-separated list) ────────
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

// Middleware
app.use(helmet({
  contentSecurityPolicy: false // disabled to avoid breaking inline scripts in HTML pages
}));
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (server-to-server, curl, Postman)
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '5mb' }));
app.use('/api', apiLimiter);                        // apply general limit to all /api routes
app.use('/api/auth', authLimiter);                  // stricter limit on auth routes
app.use('/api/questions/parse-pdf', pdfLimiter);    // limit Gemini PDF calls
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Middleware ────────────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    // Verify token with Supabase (use anon client so JWT is properly validated, not bypassed)
    const { data: { user }, error } = await supabaseAuthClient.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

    // Get user profile (role etc.)
    const { data: profile } = await supabase.from('users').select('*').eq('id', user.id).single();
    req.user = { ...user, ...profile };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}

async function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ── Expose Supabase config to authenticated users only ───────────────────────
// Note: The anon key is designed to be public, but we gate it behind auth
// so that only logged-in users can query Supabase if ever needed client-side.
app.get('/api/config', authenticate, (req, res) => {
  res.json({ supabaseUrl, supabaseAnonKey: anonKey });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Register new student
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, roll_number, phone, dob, gender } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });

    // Create Supabase auth user
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email, password,
      email_confirm: true,
      user_metadata: { name, role: 'student' }
    });
    if (authErr) return res.status(400).json({ error: authErr.message });

    // Update profile with extra fields
    await supabase.from('users').update({ name, roll_number, phone, dob, gender }).eq('id', authData.user.id);

    // Sign in to get token
    const { data: signIn, error: signInErr } = await supabaseAuthClient.auth.signInWithPassword({ email, password });
    if (signInErr) return res.status(400).json({ error: signInErr.message });

    const { data: profile } = await supabase.from('users').select('*').eq('id', authData.user.id).single();
    res.json({ token: signIn.session.access_token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data, error } = await supabaseAuthClient.auth.signInWithPassword({ email, password });
    if (error) return res.status(400).json({ error: 'Invalid email or password' });

    const { data: profile, error: profileErr } = await supabase.from('users').select('*').eq('id', data.user.id).single();

    if (!profile?.is_active) return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });

    res.json({ token: data.session.access_token, user: profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user
app.get('/api/auth/me', authenticate, (req, res) => res.json({ user: req.user }));

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN - STUDENT MANAGEMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Get all students
app.get('/api/admin/students', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('*').eq('role', 'student').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update student details
app.put('/api/admin/students/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { branch, batch, semester, section, roll_number, name } = req.body;
    const { data, error } = await supabase.from('users').update({ branch, batch, semester, section, roll_number, name }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle student status
app.put('/api/admin/students/:id/status', authenticate, requireAdmin, async (req, res) => {
  try {
    const { is_active } = req.body;
    const { data, error } = await supabase.from('users').update({ is_active }).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk Import Students via CSV (Simplified)
app.post('/api/admin/students/bulk-import', authenticate, requireAdmin, async (req, res) => {
  try {
    const students = req.body.students; // Array of objects parsed by frontend
    if (!Array.isArray(students)) return res.status(400).json({ error: 'Expected an array of students' });

    let imported = 0;
    let errors = [];

    for (const student of students) {
      try {
        // Create Supabase auth user
        const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
          email: student.email,
          // Generate a random secure password if none provided
          password: student.password || Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8).toUpperCase() + '!9',
          email_confirm: true,
          user_metadata: { name: student.name, role: 'student' }
        });

        if (authErr) { errors.push(`Email ${student.email}: ${authErr.message}`); continue; }

        // Update profile
        await supabase.from('users').update({
          name: student.name,
          roll_number: student.roll_number,
          branch: student.branch,
          batch: student.batch,
          semester: student.semester,
          section: student.section
        }).eq('id', authData.user.id);

        imported++;
      } catch (err) {
        errors.push(`Email ${student.email}: ${err.message}`);
      }
    }

    res.json({ success: true, imported, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXAM ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// List exams
app.get('/api/exams', authenticate, async (req, res) => {
  try {
    let query = supabase.from('exams').select('*, exam_sections(*)');
    if (req.user.role !== 'admin') query = query.eq('is_published', true);
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single exam
app.get('/api/exams/:id', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exams')
      .select('*, exam_sections(*)')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Exam not found' });
    if (req.user.role !== 'admin' && !data.is_published) return res.status(403).json({ error: 'Exam not available' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Allowed fields for exam create/update (whitelist to prevent injection of unexpected columns)
const EXAM_ALLOWED_FIELDS = [
  'title', 'exam_code', 'description', 'instructions',
  'total_duration', 'total_marks', 'pass_percentage',
  'is_published', 'shuffle_questions', 'shuffle_options',
  'show_result', 'enable_certificate'
];
function pickExamFields(body) {
  return EXAM_ALLOWED_FIELDS.reduce((acc, k) => {
    if (k in body) acc[k] = body[k];
    return acc;
  }, {});
}

// Create exam (admin)
app.post('/api/exams', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exams').insert({
      ...pickExamFields(req.body),
      created_by: req.user.id
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update exam (admin)
app.put('/api/exams/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exams').update(pickExamFields(req.body)).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete exam (admin)
app.delete('/api/exams/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('exams').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Allowed fields for sections (whitelist)
const SECTION_ALLOWED_FIELDS = ['name', 'description', 'duration', 'marks_per_q', 'negative_marks', 'sort_order'];
function pickSectionFields(body) {
  return SECTION_ALLOWED_FIELDS.reduce((acc, k) => {
    if (k in body) acc[k] = body[k];
    return acc;
  }, {});
}

// ── Sections ──────────────────────────────────────────────────────────────────
app.get('/api/exams/:examId/sections', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exam_sections').select('*').eq('exam_id', req.params.examId).order('sort_order');
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/exams/:examId/sections', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exam_sections').insert({ ...pickSectionFields(req.body), exam_id: req.params.examId }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/sections/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exam_sections').update(pickSectionFields(req.body)).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/sections/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('exam_sections').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Get questions for admin (with answers)
app.get('/api/questions', authenticate, requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('questions').select('*, options(*), numeric_answers(*)');
    if (req.query.examId) query = query.eq('exam_id', req.query.examId);
    if (req.query.sectionId) query = query.eq('section_id', req.query.sectionId);
    const { data, error } = await query.order('sort_order');
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get questions for student (no correct answers)
app.get('/api/exam-questions/:examId', authenticate, async (req, res) => {
  try {
    const { data: questions, error } = await supabase.from('questions')
      .select('*, options(id, content, sort_order), exam_sections(id, name)')
      .eq('exam_id', req.params.examId)
      .order('sort_order');
    if (error) throw error;

    // Shuffle if needed
    const { data: exam } = await supabase.from('exams').select('shuffle_questions, shuffle_options').eq('id', req.params.examId).single();
    let qs = questions;
    if (exam?.shuffle_questions) qs = qs.sort(() => Math.random() - 0.5);
    if (exam?.shuffle_options) {
      qs = qs.map(q => ({ ...q, options: q.options?.sort(() => Math.random() - 0.5) || [] }));
    }
    // Sort options by sort_order if not shuffled
    if (!exam?.shuffle_options) {
      qs = qs.map(q => ({ ...q, options: (q.options || []).sort((a, b) => a.sort_order - b.sort_order) }));
    }
    res.json(qs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create question (admin)
app.post('/api/questions', authenticate, requireAdmin, async (req, res) => {
  try {
    const { options: optData, numeric_answer, ...qData } = req.body;
    const { data: question, error: qErr } = await supabase.from('questions').insert(qData).select().single();
    if (qErr) throw qErr;

    // Insert options for MCQ/MSQ
    if (optData?.length && (qData.type === 'mcq' || qData.type === 'msq')) {
      const opts = optData.map((o, i) => ({ question_id: question.id, content: o.content, is_correct: o.is_correct, sort_order: i + 1 }));
      await supabase.from('options').insert(opts);
    }
    // Insert numeric answer
    if (numeric_answer !== undefined && qData.type === 'numeric') {
      await supabase.from('numeric_answers').insert({ question_id: question.id, correct_value: numeric_answer.correct_value, tolerance: numeric_answer.tolerance || 0 });
    }

    const { data: full } = await supabase.from('questions').select('*, options(*), numeric_answers(*)').eq('id', question.id).single();
    res.json(full);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Parse PDF using Gemini (admin) - Serverless compatible with memory storage
app.post('/api/questions/parse-pdf', authenticate, requireAdmin, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    console.log('Received PDF upload:', req.file.originalname, 'Size:', req.file.size);
    if (!ai) return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in .env' });

    const prompt = `You are an expert exam parser. Analyze this PDF and extract all questions, options, and answers.
Return the result strictly as a JSON array of objects with this structure:
[{
  "content": "Question text here",
  "type": "mcq" | "msq" | "subjective" | "numeric",
  "marks": 1,
  "difficulty": "easy" | "medium" | "hard",
  "options": [
    { "content": "Option text", "is_correct": true | false }
  ]
}]
Infer the "type" accurately: if multiple options are correct, it's "msq". If it has options but only 1 is correct, it's "mcq". If it requires a typed answer, it's "subjective" or "numeric".
Do not include markdown codeblocks (\`\`\`json) in your response, just return the raw JSON array.`;

    console.log('Generating content with gemini-2.5-flash using memory buffer...');
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { inlineData: { data: req.file.buffer.toString('base64'), mimeType: req.file.mimetype || 'application/pdf' } },
        { text: prompt }
      ]
    });
    console.log('Generation successful.');

    let resultText = response.text;
    resultText = resultText.replace(/^\`\`\`(json)?/m, '').replace(/\`\`\`$/m, '').trim();

    const parsedQuestions = JSON.parse(resultText);
    res.json(parsedQuestions);

  } catch (err) {
    console.error('Error parsing PDF with Gemini:', err);
    res.status(500).json({ error: 'Error parsing PDF with Gemini: ' + err.message });
  }
});

// Bulk Create questions (admin)
app.post('/api/questions/bulk', authenticate, requireAdmin, async (req, res) => {
  try {
    const questionsArr = req.body.questions;
    if (!Array.isArray(questionsArr)) return res.status(400).json({ error: 'Expected an array of questions' });

    let insertedCount = 0;
    for (const q of questionsArr) {
      const { options: optData, numeric_answer, ...qData } = q;
      const { data: question, error: qErr } = await supabase.from('questions').insert(qData).select().single();
      if (qErr) continue;

      if (optData?.length && (qData.type === 'mcq' || qData.type === 'msq')) {
        const opts = optData.map((o, i) => ({ question_id: question.id, content: o.content, is_correct: o.is_correct, sort_order: i + 1 }));
        await supabase.from('options').insert(opts);
      }
      if (numeric_answer !== undefined && qData.type === 'numeric') {
        await supabase.from('numeric_answers').insert({ question_id: question.id, ...numeric_answer });
      }
      insertedCount++;
    }
    res.json({ success: true, count: insertedCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update question (admin)
app.put('/api/questions/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { options: optData, numeric_answer, ...qData } = req.body;
    const { data, error } = await supabase.from('questions').update(qData).eq('id', req.params.id).select().single();
    if (error) throw error;

    if (optData) {
      await supabase.from('options').delete().eq('question_id', req.params.id);
      if (optData.length) {
        const opts = optData.map((o, i) => ({ question_id: req.params.id, content: o.content, is_correct: o.is_correct, sort_order: i + 1 }));
        await supabase.from('options').insert(opts);
      }
    }
    if (numeric_answer !== undefined) {
      await supabase.from('numeric_answers').delete().eq('question_id', req.params.id);
      if (numeric_answer) await supabase.from('numeric_answers').insert({ question_id: req.params.id, ...numeric_answer });
    }
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete question (admin)
app.delete('/api/questions/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('questions').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/schedules', authenticate, async (req, res) => {
  try {
    let query = supabase.from('exam_schedules').select('*, exams(title, exam_code)');
    if (req.user.role !== 'admin') {
      // Student: schedules where they're enrolled
      const { data: enrollments } = await supabase.from('enrollments').select('schedule_id').eq('student_id', req.user.id);
      const ids = (enrollments || []).map(e => e.schedule_id);
      if (!ids.length) return res.json([]);
      query = query.in('id', ids);
    }
    const { data, error } = await query.order('start_time', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/schedules/:id/enrollments', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('enrollments').select('*, users(name, email, roll_number)').eq('schedule_id', req.params.id);
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Allowed fields for schedules (whitelist)
const SCHEDULE_ALLOWED_FIELDS = ['exam_id', 'batch_name', 'start_time', 'end_time', 'max_attempts', 'is_active'];
function pickScheduleFields(body) {
  return SCHEDULE_ALLOWED_FIELDS.reduce((acc, k) => {
    if (k in body) acc[k] = body[k];
    return acc;
  }, {});
}

app.post('/api/schedules', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exam_schedules').insert({ ...pickScheduleFields(req.body), created_by: req.user.id }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/schedules/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('exam_schedules').update(pickScheduleFields(req.body)).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/schedules/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('exam_schedules').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enroll students in bulk
app.post('/api/schedules/:id/enroll', authenticate, requireAdmin, async (req, res) => {
  try {
    const { student_ids } = req.body;
    const enrollments = student_ids.map(sid => ({ schedule_id: req.params.id, student_id: sid }));
    const { data, error } = await supabase.from('enrollments').upsert(enrollments, { onConflict: 'schedule_id,student_id' }).select();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESULT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Start exam (create in-progress result)
app.post('/api/results/start', authenticate, async (req, res) => {
  try {
    const { exam_id, schedule_id } = req.body;

    // Verify enrollment
    if (schedule_id) {
      const { data: enroll } = await supabase.from('enrollments')
        .select('id').eq('schedule_id', schedule_id).eq('student_id', req.user.id).single();
      if (!enroll) return res.status(403).json({ error: 'You are not enrolled in this exam schedule' });
    }

    // Check if already started/submitted
    const { data: existing } = await supabase.from('results')
      .select('id, status').eq('exam_id', exam_id).eq('student_id', req.user.id);

    const submitted = existing?.find(r => r.status === 'submitted' || r.status === 'graded' || r.status === 'pending_grading');
    if (submitted) return res.status(400).json({ error: 'You have already submitted this exam', result_id: submitted.id });

    const inProgress = existing?.find(r => r.status === 'in_progress');
    if (inProgress) return res.json({ result_id: inProgress.id, resumed: true });

    const { data: exam } = await supabase.from('exams').select('total_marks').eq('id', exam_id).single();
    const { data: result, error } = await supabase.from('results').insert({
      exam_id,
      schedule_id,
      student_id: req.user.id,
      student_name: req.user.name,
      roll_number: req.user.roll_number,
      total_marks: exam?.total_marks || 0,
      status: 'in_progress',
      ip_address: req.ip,
      browser_info: req.headers['user-agent']
    }).select().single();
    if (error) throw error;
    res.json({ result_id: result.id, resumed: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-save answers
app.post('/api/results/:id/save', authenticate, async (req, res) => {
  try {
    const { answers } = req.body; // [{ question_id, section_id, selected_options, answer_text, status, is_marked_review, time_spent }]
    if (!answers?.length) return res.json({ success: true });

    // Verify ownership
    const { data: result } = await supabase.from('results').select('student_id').eq('id', req.params.id).single();
    if (!result || result.student_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    const upserts = answers.map(a => ({
      result_id: req.params.id,
      question_id: a.question_id,
      section_id: a.section_id,
      selected_options: a.selected_options || [],
      answer_text: a.answer_text || null,
      status: a.status || 'not_answered',
      is_marked_review: a.is_marked_review || false,
      time_spent: a.time_spent || 0
    }));

    const { error } = await supabase.from('result_answers').upsert(upserts, { onConflict: 'result_id,question_id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Submit exam
app.post('/api/results/:id/submit', authenticate, async (req, res) => {
  try {
    const { time_taken, answers } = req.body;
    const resultId = req.params.id;

    // Verify ownership
    const { data: result } = await supabase.from('results').select('*, exams(*)').eq('id', resultId).single();
    if (!result || result.student_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    if (result.status !== 'in_progress') return res.status(400).json({ error: 'Exam already submitted' });

    // Save final answers
    if (answers?.length) {
      const upserts = answers.map(a => ({
        result_id: resultId,
        question_id: a.question_id,
        section_id: a.section_id,
        selected_options: a.selected_options || [],
        answer_text: a.answer_text || null,
        status: a.status || 'not_answered',
        is_marked_review: a.is_marked_review || false,
        time_spent: a.time_spent || 0
      }));
      await supabase.from('result_answers').upsert(upserts, { onConflict: 'result_id,question_id' });
    }

    // Auto-grade MCQ / MSQ / Numeric
    const { data: resultAnswers } = await supabase.from('result_answers').select('*').eq('result_id', resultId);
    const { data: questions } = await supabase.from('questions').select('*, options(*), numeric_answers(*), exam_sections(*)').eq('exam_id', result.exam_id);
    const { data: sections } = await supabase.from('exam_sections').select('*').eq('exam_id', result.exam_id);

    let totalScore = 0;
    const sectionScores = {};

    // Init section scores
    (sections || []).forEach(s => {
      sectionScores[s.id] = { section_id: s.id, section_name: s.name, score: 0, max_score: 0, attempted: 0, correct: 0, wrong: 0, skipped: 0 };
    });

    // Grade each answer
    const gradedUpdates = [];
    for (const qa of (resultAnswers || [])) {
      const q = questions?.find(x => x.id === qa.question_id);
      if (!q) continue;

      const sectionId = q.section_id;
      const sc = sectionId ? (sectionScores[sectionId] || { section_id: sectionId, section_name: 'Unknown', score: 0, max_score: 0, attempted: 0, correct: 0, wrong: 0, skipped: 0 }) : null;
      if (sc) { sc.max_score += parseFloat(q.marks); sectionScores[sectionId] = sc; }

      let isCorrect = null;
      let marksAwarded = 0;

      if (qa.status === 'not_visited' || qa.status === 'not_answered') {
        if (sc) sc.skipped++;
      } else if (q.type === 'mcq') {
        const correctOpt = q.options?.find(o => o.is_correct);
        isCorrect = qa.selected_options?.length === 1 && qa.selected_options[0] === correctOpt?.id;
        marksAwarded = isCorrect ? parseFloat(q.marks) : -parseFloat(q.negative_marks || 0);
        if (sc) { sc.attempted++; isCorrect ? sc.correct++ : sc.wrong++; }
      } else if (q.type === 'msq') {
        const correctIds = (q.options?.filter(o => o.is_correct) || []).map(o => o.id).sort();
        const selectedIds = (qa.selected_options || []).sort();
        isCorrect = JSON.stringify(correctIds) === JSON.stringify(selectedIds);
        marksAwarded = isCorrect ? parseFloat(q.marks) : -parseFloat(q.negative_marks || 0);
        if (sc) { sc.attempted++; isCorrect ? sc.correct++ : sc.wrong++; }
      } else if (q.type === 'numeric') {
        const na = q.numeric_answers?.[0];
        if (na && qa.answer_text !== null && qa.answer_text !== '') {
          const val = parseFloat(qa.answer_text);
          isCorrect = Math.abs(val - parseFloat(na.correct_value)) <= parseFloat(na.tolerance || 0);
          marksAwarded = isCorrect ? parseFloat(q.marks) : -parseFloat(q.negative_marks || 0);
          if (sc) { sc.attempted++; isCorrect ? sc.correct++ : sc.wrong++; }
        }
      }
      // subjective — leave for admin grading

      totalScore += marksAwarded;
      if (sc) { sc.score += marksAwarded; sectionScores[sectionId] = sc; }

      gradedUpdates.push({ id: qa.id, is_correct: isCorrect, marks_awarded: marksAwarded });
    }

    // Update answer records with grades — single batch upsert instead of N sequential calls
    if (gradedUpdates.length) {
      await supabase.from('result_answers').upsert(
        gradedUpdates.map(u => ({ id: u.id, is_correct: u.is_correct, marks_awarded: u.marks_awarded })),
        { onConflict: 'id' }
      );
    }

    // Insert section scores
    const sectionRows = Object.values(sectionScores).map(s => ({ ...s, result_id: resultId }));
    if (sectionRows.length) await supabase.from('result_sections').upsert(sectionRows, { onConflict: 'result_id,section_id' });

    // Has subjective questions pending admin grading?
    const hasPending = questions?.some(q => q.type === 'subjective');

    const percentage = result.exams?.total_marks > 0 ? (totalScore / result.exams.total_marks) * 100 : 0;
    const passed = percentage >= (result.exams?.pass_percentage || 40);

    const { data: finalResult, error: updateErr } = await supabase.from('results').update({
      status: hasPending ? 'pending_grading' : 'submitted',
      total_score: Math.max(0, totalScore),
      percentage: Math.max(0, percentage),
      passed: hasPending ? false : passed,
      time_taken,
      submitted_at: new Date().toISOString()
    }).eq('id', resultId).select().single();
    if (updateErr) throw updateErr;

    res.json(finalResult);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get my results
app.get('/api/results/mine', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('results')
      .select('*, exams(title, exam_code), result_sections(*)')
      .eq('student_id', req.user.id)
      .order('started_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single result
app.get('/api/results/:id', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('results')
      .select('*, exams(*), result_sections(*), result_answers(*, questions(content, type, marks, negative_marks, options(*), numeric_answers(*)))')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Result not found' });
    if (req.user.role !== 'admin' && data.student_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all results (admin)
app.get('/api/results', authenticate, requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('results').select('*, exams(title, exam_code), result_sections(*)');
    if (req.query.examId) query = query.eq('exam_id', req.query.examId);
    const { data, error } = await query.order('submitted_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Leaderboard
app.get('/api/results/leaderboard/:examId', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase.from('results')
      .select('student_name, roll_number, total_score, total_marks, percentage, passed, time_taken, submitted_at')
      .eq('exam_id', req.params.examId)
      .in('status', ['submitted', 'graded'])
      .order('total_score', { ascending: false })
      .order('time_taken', { ascending: true });
    if (error) throw error;
    res.json((data || []).map((r, i) => ({ ...r, rank: i + 1 })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Grade subjective (admin)
app.put('/api/results/:id/grade', authenticate, requireAdmin, async (req, res) => {
  try {
    const { grades } = req.body; // { answer_id: { marks, feedback } }
    let bonusScore = 0;
    for (const [answerId, grade] of Object.entries(grades)) {
      await supabase.from('result_answers').update({
        marks_awarded: grade.marks,
        admin_feedback: grade.feedback,
        is_correct: grade.marks > 0,
        graded_by: req.user.id
      }).eq('id', answerId);
      bonusScore += grade.marks;
    }

    // Recalculate total
    const { data: allAnswers } = await supabase.from('result_answers').select('marks_awarded').eq('result_id', req.params.id);
    const newTotal = (allAnswers || []).reduce((s, a) => s + (a.marks_awarded || 0), 0);

    const { data: result } = await supabase.from('results').select('total_marks, exams(pass_percentage)').eq('id', req.params.id).single();
    const percentage = result?.total_marks > 0 ? (Math.max(0, newTotal) / result.total_marks) * 100 : 0;

    const { data: updated } = await supabase.from('results').update({
      total_score: Math.max(0, newTotal),
      percentage: Math.max(0, percentage),
      passed: percentage >= (result?.exams?.pass_percentage || 40),
      status: 'graded',
      graded_at: new Date().toISOString()
    }).eq('id', req.params.id).select().single();

    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export results as CSV (admin)
app.get('/api/results/export/:examId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('results')
      .select('student_name, roll_number, total_score, total_marks, percentage, passed, time_taken, submitted_at, status, result_sections(*)')
      .eq('exam_id', req.params.examId)
      .order('total_score', { ascending: false });
    if (error) throw error;

    let csv = 'Rank,Name,Roll Number,Score,Total Marks,Percentage,Status,Time Taken (s),Submitted At\n';
    (data || []).forEach((r, i) => {
      csv += `${i + 1},"${r.student_name || ''}","${r.roll_number || ''}",${r.total_score},${r.total_marks},${r.percentage?.toFixed(2)}%,${r.passed ? 'PASS' : 'FAIL'},${r.time_taken},"${r.submitted_at || ''}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="results_${req.params.examId}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Proctoring log
app.post('/api/proctor/log', authenticate, async (req, res) => {
  try {
    const { result_id, event_type, details } = req.body;

    // Verify ownership
    const { data: result } = await supabase.from('results').select('student_id').eq('id', result_id).single();
    if (!result || result.student_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    // Increment counters on result row
    if (event_type === 'tab_switch') {
      const { data: r } = await supabase.from('results').select('tab_switches').eq('id', result_id).single();
      await supabase.from('results').update({ tab_switches: (r?.tab_switches || 0) + 1 }).eq('id', result_id);
    }
    if (event_type === 'fullscreen_exit') {
      const { data: r } = await supabase.from('results').select('fullscreen_exits').eq('id', result_id).single();
      await supabase.from('results').update({ fullscreen_exits: (r?.fullscreen_exits || 0) + 1 }).eq('id', result_id);
    }

    await supabase.from('proctoring_logs').insert({ result_id, event_type, details });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get proctoring logs for admin
app.get('/api/proctor/logs/:resultId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('proctoring_logs')
      .select('*')
      .eq('result_id', req.params.resultId)
      .order('timestamp', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats (admin)
app.get('/api/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const [{ count: students }, { count: exams }, { count: submissions }, { count: activeSessions }] = await Promise.all([
      supabase.from('users').select('*', { count: 'exact', head: true }).eq('role', 'student'),
      supabase.from('exams').select('*', { count: 'exact', head: true }),
      supabase.from('results').select('*', { count: 'exact', head: true }).in('status', ['submitted', 'graded']),
      supabase.from('results').select('*', { count: 'exact', head: true }).eq('status', 'in_progress')
    ]);
    res.json({ totalStudents: students || 0, totalExams: exams || 0, totalSubmissions: submissions || 0, activeExams: activeSessions || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Users list (admin)
app.get('/api/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('users').select('id, name, email, roll_number, role, is_active, created_at').eq('role', 'student').order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ── 404 Catch-All ──────────────────────────────────────────────────────────────
// Serve a custom 404 page for any unmatched routes
app.use((req, res) => {
  if (req.accepts('html')) {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── Start Server ───────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🚀 ExamHub v2 running at http://localhost:${PORT}`);
    console.log(`   Supabase: ${supabaseUrl}`);
    console.log(`   Admin: Update user role to 'admin' in Supabase dashboard\n`);
  });
}

module.exports = app;
