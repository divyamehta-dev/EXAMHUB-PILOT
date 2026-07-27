// ══════════════════════════════════════════════════════════════════
// ExamHub v2 — Shared Utilities (Supabase-backed)
// ══════════════════════════════════════════════════════════════════
const API_BASE = '/api';

// ── Theme Logic ────────────────────────────────────────────────────
function initTheme() {
  const theme = localStorage.getItem('eh_theme') || 'light';
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('eh_theme', next);
}
initTheme();

// ── Auth Helpers ───────────────────────────────────────────────────
function getToken()  { return localStorage.getItem('eh_token'); }
function getUser()   { try { return JSON.parse(localStorage.getItem('eh_user')); } catch { return null; } }
function setAuth(token, user) {
  localStorage.setItem('eh_token', token);
  localStorage.setItem('eh_user', JSON.stringify(user));
}
function clearAuth() {
  localStorage.removeItem('eh_token');
  localStorage.removeItem('eh_user');
}
function logout() {
  clearAuth();
  window.location.href = '/login.html';
}
function requireAuth(role) {
  const token = getToken();
  const user  = getUser();
  if (!token || !user) { window.location.href = '/login.html'; return null; }
  if (role && user.role !== role) {
    window.location.href = user.role === 'admin' ? '/admin/dashboard.html' : '/student/dashboard.html';
    return null;
  }
  return user;
}

// ── API Fetch ──────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(API_BASE + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(options.headers || {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  // Session expired or token invalid — clear auth and redirect to login
  if (res.status === 401) {
    clearAuth();
    if (!window.location.pathname.includes('/login.html')) {
      showToast('Your session has expired. Please log in again.', 'warning', 3000);
      setTimeout(() => { window.location.href = '/login.html'; }, 1500);
    }
    throw new Error(data.error || 'Session expired. Please log in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ── Toast ──────────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 4000) {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type === 'error' ? 'error' : type}`;
  toast.innerHTML = `<span style="font-size:1rem;font-weight:700">${icons[type] || 'ℹ'}</span><span>${esc(message)}</span>`;
  container.appendChild(toast);
  const timer = setTimeout(() => removeToast(toast), duration);
  toast.onclick = () => { clearTimeout(timer); removeToast(toast); };
}
function removeToast(el) { el.style.opacity = '0'; el.style.transform = 'translateX(16px)'; el.style.transition = 'all 0.2s'; setTimeout(() => el.remove(), 200); }

// ── Navbar Builder ─────────────────────────────────────────────────
function buildNavbar(active) {
  const user = getUser();
  const nav  = document.getElementById('navbar');
  if (!user || !nav) return;
  const isAdmin = user.role === 'admin';
  const links = isAdmin
    ? [
        { href: '/admin/dashboard.html', label: 'Dashboard' },
        { href: '/admin/exams.html', label: 'Exams' },
        { href: '/admin/questions.html', label: 'Questions' },
        { href: '/admin/schedule.html', label: 'Schedule' },
        { href: '/admin/students.html', label: 'Students' },
        { href: '/admin/results.html', label: 'Results' }
      ]
    : [
        { href: '/student/dashboard.html', label: 'My Exams' },
        { href: '/student/results.html', label: 'My Results' }
      ];
  const initials = (user.name || 'U').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  nav.innerHTML = `<div class="navbar-inner">
    ${links.map(l => `<a href="${l.href}" class="nav-link${active === l.label ? ' active' : ''}">${esc(l.label)}</a>`).join('')}
    <div class="nav-separator"></div>
    <div class="nav-actions">
      <button class="btn btn-icon" onclick="toggleTheme()" title="Toggle Theme" style="background:transparent;border:none;font-size:1.1rem;cursor:pointer">🌓</button>
      <div class="nav-separator" style="margin:0 4px"></div>
      <span style="font-size:.8rem;color:var(--text-muted)">${isAdmin ? '🔑 Admin' : '👤 ' + esc(user.name?.split(' ')[0] || '')}</span>
      <button class="btn btn-secondary btn-sm" onclick="logout()">Sign Out</button>
    </div>
  </div>`;
}

// ── Modal ──────────────────────────────────────────────────────────
function openModal(id)  { const m = document.getElementById(id); if (m) { m.classList.add('active'); document.body.style.overflow = 'hidden'; } }
function closeModal(id) { const m = document.getElementById(id); if (m) { m.classList.remove('active'); document.body.style.overflow = ''; } }
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
    document.body.style.overflow = '';
  }
});

// ── Confirm Dialog ─────────────────────────────────────────────────
function confirmDialog(message, confirmLabel = 'Confirm', dangerous = false) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.innerHTML = `<div class="modal" style="max-width:420px">
      <div class="modal-header"><h3 class="modal-title">Confirm Action</h3></div>
      <p style="color:var(--text-secondary);margin-bottom:20px;font-size:.875rem">${esc(message)}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn btn-secondary" id="c-no">Cancel</button>
        <button class="btn btn-${dangerous ? 'danger' : 'primary'}" id="c-yes">${esc(confirmLabel)}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#c-yes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#c-no').onclick  = () => { overlay.remove(); resolve(false); };
  });
}

// ── Loading ────────────────────────────────────────────────────────
function showLoading(msg = '') {
  let el = document.getElementById('_loading');
  if (!el) {
    el = document.createElement('div');
    el.id = '_loading';
    el.className = 'loading-overlay';
    el.innerHTML = `<div class="spinner"></div>${msg ? `<span style="font-size:.85rem;color:var(--text-muted)">${esc(msg)}</span>` : ''}`;
    document.body.appendChild(el);
  }
}
function hideLoading() { document.getElementById('_loading')?.remove(); }

// ── Formatting ─────────────────────────────────────────────────────
function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
function formatDate(iso) { if (!iso) return '—'; return new Date(iso).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); }
function formatDateTime(iso) { if (!iso) return '—'; return new Date(iso).toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
function formatTime(secs) {
  if (!secs) return '0m 0s';
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}
function formatDuration(mins) { if (mins < 60) return `${mins} min`; return `${Math.floor(mins/60)}h ${mins%60}m`; }
function pct(score, total) { if (!total) return 0; return Math.min(100, Math.round((score / total) * 100)); }
function formatPct(score, total) { return pct(score, total) + '%'; }

// ── Timer ──────────────────────────────────────────────────────────
function createCountdown(totalSeconds, onTick, onEnd) {
  let remaining = totalSeconds;
  onTick(remaining);
  const iv = setInterval(() => {
    remaining--;
    onTick(remaining);
    if (remaining <= 0) { clearInterval(iv); onEnd(); }
  }, 1000);
  return { stop: () => clearInterval(iv), getRemaining: () => remaining };
}
function formatTimerDisplay(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// ── CSV Download ───────────────────────────────────────────────────
function downloadCSV(csvString, filename) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Proctoring ─────────────────────────────────────────────────
let _procResultId    = null;
let _violationCount  = 0;
const MAX_VIOLATIONS = 5;          // auto-submit after 5 violations
let _procOnAutoSubmit = null;      // callback set by exam page

function initProctoring(resultId, onAutoSubmit) {
  _procResultId    = resultId;
  _procOnAutoSubmit = onAutoSubmit || null;
  _violationCount  = 0;

  // Tab / window switch
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) showViolationWarning('tab_switch', '🔄 Tab Switch Detected', 'You have switched away from the exam window. This has been recorded.');
  });

  // Fullscreen exit
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) showViolationWarning('fullscreen_exit', '⛶ Fullscreen Exited', 'You have exited fullscreen mode. Please return to fullscreen immediately.');
  });

  // Right-click
  document.addEventListener('contextmenu', e => {
    e.preventDefault();
    showViolationWarning('context_menu', '🖱️ Right-Click Blocked', 'Right-clicking is not allowed during the exam.', false);
  });

  // Copy / Paste
  document.addEventListener('copy',  e => { e.preventDefault(); showViolationWarning('copy_attempt',  '📋 Copy Blocked',  'Copying content is not allowed during the exam.', false); });
  document.addEventListener('cut',   e => { e.preventDefault(); showViolationWarning('copy_attempt',  '✂️ Cut Blocked',   'Cutting content is not allowed during the exam.', false); });
  document.addEventListener('paste', e => { e.preventDefault(); showViolationWarning('paste_attempt', '📋 Paste Blocked', 'Pasting content is not allowed during the exam.', false); });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    const blocked = (e.ctrlKey || e.metaKey) && ['c','v','x','a','u','s','p'].includes(e.key.toLowerCase());
    if (blocked) { e.preventDefault(); showViolationWarning('copy_attempt', '⌨️ Keyboard Shortcut Blocked', `Ctrl+${e.key.toUpperCase()} is not allowed during the exam.`, false); }
    // PrintScreen
    if (e.key === 'PrintScreen') { e.preventDefault(); showViolationWarning('suspicious_activity', '🖨️ Screenshot Blocked', 'Taking screenshots is not allowed during the exam.', false); }
  });

  // Window blur (switch to another app)
  window.addEventListener('blur', () => {
    showViolationWarning('focus_loss', '👁️ Focus Lost', 'The exam window lost focus. Please keep the exam window active at all times.');
  });
}

function showViolationWarning(type, title, message, countViolation = true) {
  if (countViolation) {
    _violationCount++;
    updateViolationBadge();
    logProctoring(type, message);
  } else {
    logProctoring(type, message);
  }

  // Show overlay warning
  let overlay = document.getElementById('_proctor-warning');
  if (overlay) overlay.remove();

  const remaining = MAX_VIOLATIONS - _violationCount;
  const isLast = remaining <= 0;

  overlay = document.createElement('div');
  overlay.id = '_proctor-warning';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;
    display:flex;align-items:center;justify-content:center;padding:20px;
    animation:fadeIn .2s ease;
  `;
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:32px;max-width:480px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.5)">
      <div style="font-size:2.5rem;margin-bottom:12px">${isLast ? '🚨' : '⚠️'}</div>
      <div style="font-size:1.1rem;font-weight:800;color:${isLast ? '#dc2626' : '#d97706'};margin-bottom:8px">${title}</div>
      <p style="font-size:.88rem;color:#374151;margin-bottom:16px;line-height:1.5">${message}</p>
      ${countViolation ? `
        <div style="background:${isLast ? '#fef2f2' : '#fffbeb'};border:1px solid ${isLast ? '#fecaca' : '#fde68a'};border-radius:8px;padding:12px;margin-bottom:16px">
          <div style="font-size:.8rem;font-weight:700;color:${isLast ? '#dc2626' : '#d97706'}">
            ⚠ Violation ${_violationCount} of ${MAX_VIOLATIONS}
          </div>
          <div style="font-size:.75rem;color:#6b7280;margin-top:4px">
            ${isLast ? 'Exam will be auto-submitted now!' : `${remaining} more violation${remaining !== 1 ? 's' : ''} will trigger auto-submit`}
          </div>
        </div>` : ''}
      ${isLast
        ? `<button onclick="this.closest('#_proctor-warning').remove();if(typeof _procOnAutoSubmit==='function')_procOnAutoSubmit();" style="background:#dc2626;color:#fff;border:none;border-radius:6px;padding:10px 28px;font-weight:700;cursor:pointer;font-size:.9rem;width:100%">Exam Auto-Submitted</button>`
        : `<button onclick="this.closest('#_proctor-warning').remove();${!document.fullscreenElement ? 'requestFullscreen();' : ''}" style="background:#1e4d9a;color:#fff;border:none;border-radius:6px;padding:10px 28px;font-weight:700;cursor:pointer;font-size:.9rem">⛶ I Understand — Return to Exam</button>`
      }
    </div>`;
  document.body.appendChild(overlay);

  if (isLast && _procOnAutoSubmit) {
    setTimeout(() => { overlay.remove(); _procOnAutoSubmit(); }, 3000);
  }
}

function updateViolationBadge() {
  let badge = document.getElementById('_violation-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = '_violation-badge';
    badge.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#dc2626;color:#fff;border-radius:8px;padding:6px 12px;font-size:.75rem;font-weight:700;z-index:500;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.appendChild(badge);
  }
  badge.textContent = `⚠ Violations: ${_violationCount}/${MAX_VIOLATIONS}`;
  badge.style.background = _violationCount >= MAX_VIOLATIONS - 1 ? '#dc2626' : '#d97706';
}

async function logProctoring(type, details) {
  if (!_procResultId) return;
  try {
    await apiFetch('/proctor/log', { method: 'POST', body: { result_id: _procResultId, event_type: type, details } });
  } catch {}
}

function requestFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

// ── Draggable Panels ───────────────────────────────────────────────
function makeDraggable(panelId, handleId) {
  const panel  = document.getElementById(panelId);
  const handle = document.getElementById(handleId) || panel;
  if (!panel) return;
  let sx = 0, sy = 0, x = 0, y = 0;
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    sx = e.clientX - panel.offsetLeft;
    sy = e.clientY - panel.offsetTop;
    document.addEventListener('mousemove', drag);
    document.addEventListener('mouseup', stopDrag);
  });
  function drag(e) {
    x = e.clientX - sx; y = e.clientY - sy;
    panel.style.left = Math.max(0, x) + 'px';
    panel.style.top  = Math.max(0, y) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  }
  function stopDrag() { document.removeEventListener('mousemove', drag); document.removeEventListener('mouseup', stopDrag); }
}
