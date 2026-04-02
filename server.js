'use strict';

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

const app = express();

// ── Config
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback-secret-change-me';
const PANEL_NAME = process.env.PANEL_NAME || 'Luarmor Panel';
const ACCENT_COLOR = process.env.ACCENT_COLOR || '8b5cf6';
const DAILY_RESET_LIMIT = Math.max(1, Number(process.env.DAILY_RESET_LIMIT || 3));

// ── Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://cdn.discordapp.com"],
    },
  },
}));
app.use(compression());

// ── Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

// ── Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Demasiados intentos. Espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { success: false, message: 'Demasiadas solicitudes. Intenta en un momento.' },
});

// ── View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Pass globals to all views
app.use((req, res, next) => {
  res.locals.panelName = PANEL_NAME;
  res.locals.accentColor = ACCENT_COLOR;
  res.locals.user = req.session.user || null;
  res.locals.dailyLimit = DAILY_RESET_LIMIT;
  next();
});

// ── Luarmor API helper
const LUARMOR_API_KEY = process.env.LUARMOR_API_KEY || '';
const LUARMOR_PROJECT_ID = process.env.LUARMOR_PROJECT_ID || '';

async function luarmorRequest(method, path, body = null) {
  const fetch = require('node-fetch');
  const url = `https://api.luarmor.net/v3/projects/${encodeURIComponent(LUARMOR_PROJECT_ID)}${path}`;
  const opts = {
    method,
    headers: {
      'Authorization': LUARMOR_API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body && (method === 'POST' || method === 'PATCH')) {
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { success: false, message: text }; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { success: false, message: err.message } };
  }
}

async function luarmorGetUsers(filters = {}) {
  const fetch = require('node-fetch');
  const params = new URLSearchParams();
  if (filters.user_key) params.set('user_key', filters.user_key);
  if (filters.discord_id) params.set('discord_id', filters.discord_id);
  if (filters.identifier) params.set('identifier', filters.identifier);

  const url = `https://api.luarmor.net/v3/projects/${encodeURIComponent(LUARMOR_PROJECT_ID)}/users${params.toString() ? '?' + params : ''}`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': LUARMOR_API_KEY, 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { success: false, message: text }; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { success: false, message: err.message } };
  }
}

// ── In-memory daily reset tracking (persists until server restart)
// For production persistent storage, upgrade to Redis/DB
const resetTracker = new Map(); // key: `${userKey}:${dayKey}` => count

function utcDayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function getResetCount(userKey) {
  const k = `${userKey}:${utcDayKey()}`;
  return resetTracker.get(k) || 0;
}

function incResetCount(userKey) {
  const k = `${userKey}:${utcDayKey()}`;
  const current = resetTracker.get(k) || 0;
  resetTracker.set(k, current + 1);
  return current + 1;
}

// Clean old entries every hour
setInterval(() => {
  const today = utcDayKey();
  for (const [k] of resetTracker) {
    if (!k.endsWith(today)) resetTracker.delete(k);
  }
}, 60 * 60 * 1000);

// ── Auth middleware
function requireAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Home → redirect
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// ── Login page
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

// ── Login POST
app.post('/login', loginLimiter, async (req, res) => {
  const key = (req.body.key || '').trim();
  if (!key || key.length < 6 || key.length > 128) {
    return res.render('login', { error: 'Ingresa una key válida.' });
  }

  if (!LUARMOR_API_KEY || !LUARMOR_PROJECT_ID) {
    return res.render('login', { error: 'Panel no configurado. Contacta al administrador.' });
  }

  const { status, json } = await luarmorGetUsers({ user_key: key });

  if (!json?.success) {
    const msg = status === 0 ? 'Error de conexión con Luarmor. Intenta de nuevo.' : (json?.message || 'Error al verificar key.');
    return res.render('login', { error: msg });
  }

  const users = Array.isArray(json.users) ? json.users : [];
  if (!users.length) {
    return res.render('login', { error: 'Key no encontrada. Verifica e intenta de nuevo.' });
  }

  const user = users[0];

  if (user.banned || user.blacklisted) {
    return res.render('login', { error: 'Esta key está bloqueada (banned). Contacta al staff.' });
  }

  // Save session
  req.session.user = {
    key: key,
    discordId: user.discord_id || null,
    note: user.note || null,
    status: user.status || 'unknown',
    authExpire: user.auth_expire || null,
    lastLogin: Date.now(),
  };

  res.redirect('/dashboard');
});

// ── Logout
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  const userKey = req.session.user.key;
  const { json } = await luarmorGetUsers({ user_key: userKey });
  const users = Array.isArray(json?.users) ? json.users : [];
  const luaUser = users[0] || null;

  const resetsToday = getResetCount(userKey);
  const resetsLeft = Math.max(0, DAILY_RESET_LIMIT - resetsToday);

  // Update session with fresh data
  if (luaUser) {
    req.session.user.status = luaUser.status || req.session.user.status;
    req.session.user.discordId = luaUser.discord_id || req.session.user.discordId;
    req.session.user.note = luaUser.note || req.session.user.note;
    req.session.user.authExpire = luaUser.auth_expire || req.session.user.authExpire;
  }

  res.render('dashboard', {
    luaUser,
    resetsToday,
    resetsLeft,
    dailyLimit: DAILY_RESET_LIMIT,
  });
});

// ── HWID Reset
app.post('/api/reset-hwid', requireAuth, apiLimiter, async (req, res) => {
  const userKey = req.session.user.key;

  const resetsToday = getResetCount(userKey);
  if (resetsToday >= DAILY_RESET_LIMIT) {
    return res.json({
      success: false,
      message: `Límite diario alcanzado (${DAILY_RESET_LIMIT}/${DAILY_RESET_LIMIT}). Se reinicia a las 00:00 UTC.`,
    });
  }

  // Check if user is banned first
  const { json: checkJson } = await luarmorGetUsers({ user_key: userKey });
  const users = Array.isArray(checkJson?.users) ? checkJson.users : [];
  const luaUser = users[0];

  if (luaUser?.banned || luaUser?.blacklisted) {
    return res.json({ success: false, message: 'Tu key está bloqueada. Contacta al staff.' });
  }

  const { status, json } = await luarmorRequest('POST', '/users/resethwid', {
    user_key: userKey,
    force: true,
  });

  if (!json?.success) {
    return res.json({
      success: false,
      message: json?.message || `Error HTTP ${status}`,
    });
  }

  const newCount = incResetCount(userKey);
  const remaining = Math.max(0, DAILY_RESET_LIMIT - newCount);

  return res.json({
    success: true,
    message: json.message || 'HWID reseteado correctamente.',
    resetsToday: newCount,
    resetsLeft: remaining,
    dailyLimit: DAILY_RESET_LIMIT,
  });
});

// ── Get fresh user info (AJAX)
app.get('/api/userinfo', requireAuth, apiLimiter, async (req, res) => {
  const userKey = req.session.user.key;
  const { json } = await luarmorGetUsers({ user_key: userKey });
  const users = Array.isArray(json?.users) ? json.users : [];
  const luaUser = users[0] || null;

  const resetsToday = getResetCount(userKey);
  const resetsLeft = Math.max(0, DAILY_RESET_LIMIT - resetsToday);

  return res.json({
    success: true,
    user: luaUser,
    resetsToday,
    resetsLeft,
    dailyLimit: DAILY_RESET_LIMIT,
  });
});

// ── Link Discord ID
app.post('/api/link-discord', requireAuth, apiLimiter, async (req, res) => {
  const discordId = (req.body.discord_id || '').trim();
  if (!discordId || !/^\d{15,20}$/.test(discordId)) {
    return res.json({ success: false, message: 'ID de Discord inválido (debe ser numérico, 15-20 dígitos).' });
  }

  const { status, json } = await luarmorRequest('POST', '/users/linkdiscord', {
    user_key: req.session.user.key,
    discord_id: discordId,
    force: true,
  });

  if (json?.success) {
    req.session.user.discordId = discordId;
  }

  return res.json({
    success: json?.success || false,
    message: json?.message || `Error HTTP ${status}`,
  });
});

// ── Key info (for display)
app.get('/api/keyinfo', requireAuth, apiLimiter, async (req, res) => {
  const userKey = req.session.user.key;
  const { json } = await luarmorGetUsers({ user_key: userKey });
  const users = Array.isArray(json?.users) ? json.users : [];
  return res.json({ success: true, user: users[0] || null });
});

// ── Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── 404
app.use((req, res) => {
  res.status(404).render('404');
});

// ── Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Error interno del servidor.' });
});

// ── Start
app.listen(PORT, () => {
  console.log(`✅ Luarmor Panel corriendo en puerto ${PORT}`);
  console.log(`🔑 API Key: ${LUARMOR_API_KEY ? '✓ configurada' : '✗ FALTA'}`);
  console.log(`📦 Project ID: ${LUARMOR_PROJECT_ID ? '✓ configurado' : '✗ FALTA'}`);
  console.log(`📊 Límite diario de resets: ${DAILY_RESET_LIMIT}`);
});

module.exports = app;
