-- ================================================================
-- ExamHub v2 — Supabase PostgreSQL Schema
-- Run this entire file in Supabase SQL Editor
-- ================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users (extends Supabase Auth) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.users (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  roll_number   TEXT UNIQUE,
  phone         TEXT,
  dob           DATE,
  gender        TEXT CHECK (gender IN ('male','female','other')),
  role          TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin','examiner')),
  is_active     BOOLEAN DEFAULT true,
  avatar_url    TEXT,
  branch        TEXT,
  batch         TEXT,
  semester      TEXT,
  section       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Exams ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exams (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title             TEXT NOT NULL,
  description       TEXT,
  instructions      TEXT,
  exam_code         TEXT UNIQUE,
  total_duration    INT NOT NULL DEFAULT 60,  -- minutes
  total_marks       INT NOT NULL DEFAULT 100,
  pass_percentage   INT NOT NULL DEFAULT 40,
  shuffle_questions BOOLEAN DEFAULT false,
  shuffle_options   BOOLEAN DEFAULT false,
  is_published      BOOLEAN DEFAULT false,
  allow_review      BOOLEAN DEFAULT true,
  show_result       BOOLEAN DEFAULT true,     -- show result immediately after submit
  created_by        UUID REFERENCES public.users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Exam Sections ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exam_sections (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id          UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,             -- e.g. "Verbal Ability"
  description      TEXT,
  duration         INT,                       -- minutes (null = shared from exam)
  total_questions  INT DEFAULT 0,
  marks_per_q      NUMERIC(5,2) DEFAULT 1,
  negative_marks   NUMERIC(5,2) DEFAULT 0,   -- marks deducted per wrong answer
  sort_order       INT DEFAULT 1,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Questions ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.questions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id          UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  section_id       UUID REFERENCES public.exam_sections(id) ON DELETE SET NULL,
  type             TEXT NOT NULL CHECK (type IN ('mcq','msq','subjective','numeric')),
  -- mcq = single correct, msq = multiple correct, numeric = integer/decimal answer
  content          TEXT NOT NULL,             -- question text (supports HTML)
  explanation      TEXT,                      -- shown after exam
  marks            NUMERIC(5,2) DEFAULT 1,
  negative_marks   NUMERIC(5,2) DEFAULT 0,
  difficulty       TEXT DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  sort_order       INT DEFAULT 1,
  tags             TEXT[],
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Options (MCQ / MSQ answers) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.options (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  is_correct  BOOLEAN DEFAULT false,
  sort_order  INT DEFAULT 1
);

-- ── Numeric Answers ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.numeric_answers (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question_id    UUID NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  correct_value  NUMERIC NOT NULL,
  tolerance      NUMERIC DEFAULT 0          -- acceptable range ± tolerance
);

-- ── Exam Schedules (batch management) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.exam_schedules (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id      UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  batch_name   TEXT NOT NULL,
  start_time   TIMESTAMPTZ NOT NULL,
  end_time     TIMESTAMPTZ NOT NULL,
  max_attempts INT DEFAULT 1,
  is_active    BOOLEAN DEFAULT true,
  created_by   UUID REFERENCES public.users(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Schedule Enrollments ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enrollments (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  schedule_id UUID NOT NULL REFERENCES public.exam_schedules(id) ON DELETE CASCADE,
  student_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(schedule_id, student_id)
);

-- ── Results (exam attempts) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.results (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exam_id           UUID NOT NULL REFERENCES public.exams(id),
  schedule_id       UUID REFERENCES public.exam_schedules(id),
  student_id        UUID NOT NULL REFERENCES public.users(id),
  student_name      TEXT,
  roll_number       TEXT,
  status            TEXT DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','graded')),
  total_score       NUMERIC(8,2) DEFAULT 0,
  total_marks       NUMERIC(8,2) DEFAULT 0,
  percentage        NUMERIC(5,2) DEFAULT 0,
  passed            BOOLEAN DEFAULT false,
  time_taken        INT DEFAULT 0,            -- seconds
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  submitted_at      TIMESTAMPTZ,
  graded_at         TIMESTAMPTZ,
  tab_switches      INT DEFAULT 0,
  fullscreen_exits  INT DEFAULT 0,
  ip_address        TEXT,
  browser_info      TEXT
);

-- ── Section-wise Result Breakdown ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.result_sections (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  result_id     UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
  section_id    UUID REFERENCES public.exam_sections(id),
  section_name  TEXT,
  score         NUMERIC(8,2) DEFAULT 0,
  max_score     NUMERIC(8,2) DEFAULT 0,
  attempted     INT DEFAULT 0,
  correct       INT DEFAULT 0,
  wrong         INT DEFAULT 0,
  skipped       INT DEFAULT 0
);

-- ── Result Answers (per-question records) ────────────────────────
CREATE TABLE IF NOT EXISTS public.result_answers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  result_id       UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES public.questions(id),
  section_id      UUID REFERENCES public.exam_sections(id),
  answer_text     TEXT,                       -- for subjective / numeric
  selected_options UUID[],                    -- for MCQ/MSQ option IDs
  is_correct      BOOLEAN,
  is_marked_review BOOLEAN DEFAULT false,
  status          TEXT DEFAULT 'not_visited' CHECK (status IN ('not_visited','not_answered','answered','marked_review','answered_marked')),
  marks_awarded   NUMERIC(5,2) DEFAULT 0,
  admin_feedback  TEXT,
  graded_by       UUID REFERENCES public.users(id),
  time_spent      INT DEFAULT 0              -- seconds on this question
);

-- ── Proctoring Logs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.proctoring_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  result_id   UUID NOT NULL REFERENCES public.results(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN ('tab_switch','fullscreen_exit','copy_attempt','paste_attempt','context_menu','focus_loss','suspicious_activity')),
  timestamp   TIMESTAMPTZ DEFAULT NOW(),
  details     TEXT
);

-- ================================================================
-- Row Level Security (RLS) Policies
-- ================================================================
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.numeric_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.result_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.result_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proctoring_logs ENABLE ROW LEVEL SECURITY;

-- Users: can read their own record; admins can read all
CREATE POLICY "users_self_read" ON public.users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "users_admin_read" ON public.users FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "users_admin_write" ON public.users FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

-- Exams: published ones visible to all authenticated users
CREATE POLICY "exams_read_published" ON public.exams FOR SELECT USING (is_published = true);
CREATE POLICY "exams_admin_all" ON public.exams FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

-- Sections / Questions / Options: visible if exam is visible
CREATE POLICY "sections_read" ON public.exam_sections FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.exams WHERE id = exam_id AND (is_published = true OR
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')))
);
CREATE POLICY "sections_admin" ON public.exam_sections FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

CREATE POLICY "questions_admin" ON public.questions FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "questions_student_read" ON public.questions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.exams WHERE id = exam_id AND is_published = true)
);
CREATE POLICY "options_admin" ON public.options FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "options_student_read" ON public.options FOR SELECT USING (true);

-- Schedules: all authenticated users can read; admin writes
CREATE POLICY "schedules_read" ON public.exam_schedules FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "schedules_admin" ON public.exam_schedules FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

-- Enrollments
CREATE POLICY "enrollments_self" ON public.enrollments FOR SELECT USING (student_id = auth.uid());
CREATE POLICY "enrollments_admin" ON public.enrollments FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

-- Results
CREATE POLICY "results_self" ON public.results FOR SELECT USING (student_id = auth.uid());
CREATE POLICY "results_self_insert" ON public.results FOR INSERT WITH CHECK (student_id = auth.uid());
CREATE POLICY "results_self_update" ON public.results FOR UPDATE USING (student_id = auth.uid());
CREATE POLICY "results_admin" ON public.results FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

-- Result details
CREATE POLICY "result_answers_self" ON public.result_answers FOR ALL USING (
  EXISTS (SELECT 1 FROM public.results WHERE id = result_id AND student_id = auth.uid())
);
CREATE POLICY "result_answers_admin" ON public.result_answers FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "result_sections_self" ON public.result_sections FOR ALL USING (
  EXISTS (SELECT 1 FROM public.results WHERE id = result_id AND student_id = auth.uid())
);
CREATE POLICY "result_sections_admin" ON public.result_sections FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

CREATE POLICY "proctoring_admin" ON public.proctoring_logs FOR ALL USING (
  EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);
CREATE POLICY "proctoring_self_insert" ON public.proctoring_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.results WHERE id = result_id AND student_id = auth.uid())
);

-- ================================================================
-- Functions & Triggers
-- ================================================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER exams_updated_at BEFORE UPDATE ON public.exams FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER questions_updated_at BEFORE UPDATE ON public.questions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-create user profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, name, email, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'role', 'student')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ================================================================
-- Seed Data — Admin account
-- ================================================================
-- NOTE: After running this schema, create an admin user via Supabase Auth
-- dashboard (Authentication > Users > Add User), then run:
--
-- UPDATE public.users SET role = 'admin' WHERE email = 'admin@examhub.com';
--
-- ================================================================

-- Sample Exam
INSERT INTO public.exams (id, title, description, instructions, exam_code, total_duration, total_marks, pass_percentage, is_published)
VALUES (
  uuid_generate_v4(),
  'TCS NQT — Cognitive Skills',
  'National Qualifier Test — Cognitive Skills Assessment covering Verbal Ability, Numerical Ability, and Logical Reasoning.',
  E'1. Read each question carefully before answering.\n2. Each question has only one correct answer unless stated otherwise.\n3. There is negative marking — 0.33 marks will be deducted for each wrong answer.\n4. Do not press the browser back button during the exam.\n5. The exam will auto-submit when the timer expires.\n6. Ensure stable internet connection throughout the exam.',
  'TCS-NQT-2024',
  90,
  90,
  40,
  true
) RETURNING id;
