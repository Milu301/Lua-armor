'use strict';

require('dotenv').config();
const express   = require('express');
const session   = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const compression = require('compression');
const path      = require('path');
const fetch     = require('node-fetch');

const app = express();

const PORT              = process.env.PORT || 3000;
const SESSION_SECRET    = process.env.SESSION_SECRET || 'fallback-secret-change-me';
const PANEL_NAME        = process.env.PANEL_NAME || 'AuroraHud';
const ACCENT_COLOR      = process.env.ACCENT_COLOR || '8b5cf6';
const DAILY_RESET_LIMIT = Math.max(1, Number(process.env.DAILY_RESET_LIMIT || 3));
const LUARMOR_API_KEY   = process.env.LUARMOR_API_KEY || '';
const LUARMOR_PROJECT_ID = process.env.LUARMOR_PROJECT_ID || '';

let SERVER_IP = null;

async function detectServerIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const d = await r.json();
    SERVER_IP = d.ip || null;
    console.log(`🌐 Detected outbound IP: ${SERVER_IP}`);
  } catch {
    SERVER_IP = null;
    console.log('⚠️  Could not detect outbound IP');
  }
}

// FIX 1: CSP — added connectSrc for api.luarmor.net, fontSrc includes data:
// This stops the font CSP error and allows API fetch() calls to work
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https://cdn.discordapp.com", "https://i.imgur.com"],
      connectSrc: ["'self'", "https://api.luarmor.net", "https://api.ipify.org"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 12,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', {
    error: 'Too many login attempts. Please wait 15 minutes.',
    panelName: PANEL_NAME, accentColor: ACCENT_COLOR,
  }),
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40,
  standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, message: 'Rate limit exceeded.' }),
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.locals.panelName   = PANEL_NAME;
  res.locals.accentColor = ACCENT_COLOR;
  res.locals.user        = req.session.user || null;
  res.locals.dailyLimit  = DAILY_RESET_LIMIT;
  res.locals.serverIp    = SERVER_IP;
  next();
});

async function luarmorGet(urlPath, query = {}) {
  const params = new URLSearchParams(query);
  const url = `https://api.luarmor.net/v3/projects/${encodeURIComponent(LUARMOR_PROJECT_ID)}${urlPath}${params.toString() ? '?' + params : ''}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: LUARMOR_API_KEY, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    const json = await res.json().catch(() => ({ success: false, message: 'Invalid response' }));
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { success: false, message: err.message } };
  }
}

async function luarmorPost(urlPath, body) {
  const url = `https://api.luarmor.net/v3/projects/${encodeURIComponent(LUARMOR_PROJECT_ID)}${urlPath}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: LUARMOR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 8000,
    });
    const json = await res.json().catch(() => ({ success: false, message: 'Invalid response' }));
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { success: false, message: err.message } };
  }
}

async function luarmorPatch(urlPath, body) {
  const url = `https://api.luarmor.net/v3/projects/${encodeURIComponent(LUARMOR_PROJECT_ID)}${urlPath}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: LUARMOR_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: 8000,
    });
    const json = await res.json().catch(() => ({ success: false, message: 'Invalid response' }));
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { success: false, message: err.message } };
  }
}

async function getUser(userKey) {
  const { json } = await luarmorGet('/users', { user_key: userKey });
  const users = Array.isArray(json?.users) ? json.users : [];
  return users[0] || null;
}

const resetTracker = new Map();
function dayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function getResetCount(k) { return resetTracker.get(`${k}:${dayKey()}`) || 0; }
function incResetCount(k) {
  const key = `${k}:${dayKey()}`;
  const n = (resetTracker.get(key) || 0) + 1;
  resetTracker.set(key, n);
  return n;
}
setInterval(() => {
  const today = dayKey();
  for (const [k] of resetTracker) { if (!k.endsWith(today)) resetTracker.delete(k); }
}, 60 * 60 * 1000);

// For page routes — redirect to login
function auth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}

// ✅ FIX: For API routes — return JSON 401, NOT a redirect.
// Previously auth() returned a 302 redirect on expired session. fetch() followed
// it to /login HTML, r.json() threw a parse error → caught as "Network error".
// Now API routes get a clean JSON error and the UI shows a helpful message.
function apiAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({
    success: false,
    message: 'Session expired. Please refresh the page and log in again.',
    expired: true,
  });
}

app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', loginLimiter, async (req, res) => {
  const key = (req.body.key || '').trim();
  if (!key || key.length < 6 || key.length > 128)
    return res.render('login', { error: 'Please enter a valid key.' });
  if (!LUARMOR_API_KEY || !LUARMOR_PROJECT_ID)
    return res.render('login', { error: 'Panel not configured. Contact the administrator.' });

  const luaUser = await getUser(key);
  if (!luaUser)
    return res.render('login', { error: 'Key not found. Double-check and try again.' });
  if (luaUser.banned || luaUser.blacklisted)
    return res.render('login', { error: 'This key is banned. Contact staff.' });

  req.session.user = {
    key,
    discordId:  luaUser.discord_id  || null,
    note:       luaUser.note        || null,
    status:     luaUser.status      || 'unknown',
    authExpire: luaUser.auth_expire || null,
    loginAt:    Date.now(),
  };
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// FIX 2: Pass "luaUser" to match dashboard.ejs (was "lu" before — caused ReferenceError)
app.get('/dashboard', auth, async (req, res) => {
  const luaUser = await getUser(req.session.user.key);
  if (luaUser) {
    req.session.user.status     = luaUser.status      || req.session.user.status;
    req.session.user.discordId  = luaUser.discord_id  || req.session.user.discordId;
    req.session.user.note       = luaUser.note        || req.session.user.note;
    req.session.user.authExpire = luaUser.auth_expire || req.session.user.authExpire;
  }
  const resetsToday = getResetCount(req.session.user.key);
  const resetsLeft  = Math.max(0, DAILY_RESET_LIMIT - resetsToday);
  res.render('dashboard', { luaUser, resetsToday, resetsLeft, page: 'dashboard' });
});

app.get('/ip-info', auth, (req, res) => res.render('ipinfo', { page: 'ipinfo' }));

app.get('/api/userinfo', apiAuth, apiLimiter, async (req, res) => {
  const luaUser = await getUser(req.session.user.key);
  const resetsToday = getResetCount(req.session.user.key);
  const resetsLeft  = Math.max(0, DAILY_RESET_LIMIT - resetsToday);
  res.json({ success: true, user: luaUser, resetsToday, resetsLeft, dailyLimit: DAILY_RESET_LIMIT });
});

app.post('/api/reset-hwid', apiAuth, apiLimiter, async (req, res) => {
  const userKey     = req.session.user.key;
  const resetsToday = getResetCount(userKey);
  if (resetsToday >= DAILY_RESET_LIMIT)
    return res.json({ success: false, message: `Daily limit reached (${DAILY_RESET_LIMIT}/${DAILY_RESET_LIMIT}). Resets at 00:00 UTC.` });
  const luaUser = await getUser(userKey);
  if (!luaUser)
    return res.json({ success: false, message: 'Could not verify your key with Luarmor. Try again.' });
  if (luaUser?.banned || luaUser?.blacklisted)
    return res.json({ success: false, message: 'Your key is banned. Contact staff.' });
  const { status, json } = await luarmorPost('/users/resethwid', { user_key: userKey, force: true });
  if (!json?.success) {
    console.error(`[reset-hwid] Luarmor error HTTP ${status}: ${json?.message}`);
    return res.json({ success: false, message: json?.message || `API error (HTTP ${status})` });
  }
  const newCount  = incResetCount(userKey);
  const remaining = Math.max(0, DAILY_RESET_LIMIT - newCount);
  res.json({ success: true, message: json.message || 'HWID reset successfully.', resetsToday: newCount, resetsLeft: remaining, dailyLimit: DAILY_RESET_LIMIT });
});

app.post('/api/link-discord', apiAuth, apiLimiter, async (req, res) => {
  const discordId = (req.body.discord_id || '').trim();
  if (!discordId || !/^\d{15,20}$/.test(discordId))
    return res.json({ success: false, message: 'Invalid Discord ID (must be 15-20 digits).' });
  const { status, json } = await luarmorPost('/users/linkdiscord', { user_key: req.session.user.key, discord_id: discordId, force: true });
  if (json?.success) req.session.user.discordId = discordId;
  res.json({ success: json?.success || false, message: json?.message || `API error (HTTP ${status})` });
});

app.post('/api/update-note', apiAuth, apiLimiter, async (req, res) => {
  const note = (req.body.note || '').trim().slice(0, 100);
  const { status, json } = await luarmorPatch('/users', { user_key: req.session.user.key, note });
  if (json?.success) req.session.user.note = note;
  res.json({ success: json?.success || false, message: json?.message || `API error (HTTP ${status})` });
});

app.get('/api/server-ip', apiAuth, apiLimiter, async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const d = await r.json();
    SERVER_IP = d.ip || SERVER_IP;
    res.json({ success: true, ip: SERVER_IP });
  } catch {
    res.json({ success: false, ip: SERVER_IP, message: 'Could not detect IP.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now(), ip: SERVER_IP }));
app.use((req, res) => res.status(404).render('404'));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { message: 'Internal server error.' }); });

async function main() {
  await detectServerIp();
  app.listen(PORT, () => {
    console.log(`✅ Luarmor Panel v2 running on port ${PORT}`);
    console.log(`🔑 API Key:    ${LUARMOR_API_KEY    ? '✓ set' : '✗ MISSING'}`);
    console.log(`📦 Project ID: ${LUARMOR_PROJECT_ID ? '✓ set' : '✗ MISSING'}`);
    console.log(`📊 Daily limit: ${DAILY_RESET_LIMIT} resets`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });