'use strict';

require('dotenv').config();
const express     = require('express');
const session     = require('express-session');
const pgSession   = require('connect-pg-simple')(session);
const rateLimit   = require('express-rate-limit');
const helmet      = require('helmet');
const compression = require('compression');
const bcrypt      = require('bcryptjs');
const { Pool }    = require('pg');
const path        = require('path');
const fetch       = require('node-fetch');
const crypto      = require('crypto');

const app = express();

/* ─── Config ─── */
const PORT          = process.env.PORT || 3000;
const DATABASE_URL  = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PANEL_NAME    = process.env.PANEL_NAME || 'LuarmorHub';
const DISCORD_URL   = process.env.DISCORD_URL || 'https://discord.gg/tHrR89y7kn';
const PANEL_LOGO    = process.env.PANEL_LOGO || 'https://cdn.discordapp.com/icons/1398423987817807934/a_6f62815e5aee24b4964bd4113626e3fe.webp?size=64';

/* Dynamic settings (overrides env vars, editable from admin panel) */
let dynSettings = { panel_name: PANEL_NAME, discord_url: DISCORD_URL, panel_logo: PANEL_LOGO };

if (!DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }

/* ─── PostgreSQL Pool ─── */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
});
const db = {
  query: (text, params) => pool.query(text, params),
  one:   async (text, params) => { const r = await pool.query(text, params); return r.rows[0] || null; },
  all:   async (text, params) => { const r = await pool.query(text, params); return r.rows; },
};

/* ─── Dynamic Settings ─── */
async function loadSettings() {
  try {
    const rows = await db.all('SELECT key, value FROM settings');
    rows.forEach(r => { dynSettings[r.key] = r.value; });
  } catch {}
}

/* ─── DB Schema ─── */
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id SERIAL PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      slug VARCHAR(32) NOT NULL UNIQUE,
      luarmor_project_id VARCHAR(128) NOT NULL,
      luarmor_api_key TEXT NOT NULL,
      color VARCHAR(20) NOT NULL DEFAULT '#8b5cf6',
      gradient VARCHAR(80) NOT NULL DEFAULT 'linear-gradient(135deg,#8b5cf6,#6366f1)',
      icon VARCHAR(8) NOT NULL DEFAULT '⚡',
      daily_reset_limit INT NOT NULL DEFAULT 3,
      description TEXT NOT NULL DEFAULT '',
      features JSONB NOT NULL DEFAULT '[]',
      is_active BOOL NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) NOT NULL UNIQUE,
      password_hash VARCHAR(128) NOT NULL,
      luarmor_key TEXT NOT NULL UNIQUE,
      project_id INT REFERENCES projects(id),
      discord_id VARCHAR(32) NOT NULL DEFAULT '',
      note VARCHAR(100) NOT NULL DEFAULT '',
      role VARCHAR(16) NOT NULL DEFAULT 'user',
      is_active BOOL NOT NULL DEFAULT true,
      total_resets INT NOT NULL DEFAULT 0,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reset_log (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
      reset_count INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, reset_date)
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(128) NOT NULL,
      content TEXT NOT NULL,
      type VARCHAR(16) NOT NULL DEFAULT 'info',
      pinned BOOL NOT NULL DEFAULT false,
      is_active BOOL NOT NULL DEFAULT true,
      author_id INT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" VARCHAR NOT NULL COLLATE "default",
      "sess" JSON NOT NULL,
      "expire" TIMESTAMPTZ NOT NULL,
      PRIMARY KEY ("sid")
    );
    CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
    CREATE INDEX IF NOT EXISTS idx_users_project ON users(project_id);
    CREATE TABLE IF NOT EXISTS settings (
      key VARCHAR(64) PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS script_token VARCHAR(32) UNIQUE;
    DROP TABLE IF EXISTS live_sessions;
    CREATE TABLE live_sessions (
      user_id         INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      roblox_user_id  VARCHAR(32) NOT NULL DEFAULT '',
      roblox_username VARCHAR(64) NOT NULL DEFAULT '',
      place_id        VARCHAR(32) NOT NULL DEFAULT '',
      place_name      VARCHAR(128) NOT NULL DEFAULT '',
      job_id          VARCHAR(64) NOT NULL DEFAULT '',
      inventory        JSONB NOT NULL DEFAULT '{}',
      kick_requested   BOOL NOT NULL DEFAULT false,
      last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, roblox_user_id)
    );
  `);

  /* Seed projects from env vars PROJECT_N_* */
  for (let i = 1; i <= 10; i++) {
    const name  = process.env[`PROJECT_${i}_NAME`];
    const pid   = process.env[`PROJECT_${i}_LUARMOR_ID`];
    const pkey  = process.env[`PROJECT_${i}_LUARMOR_KEY`];
    if (!name || !pid || !pkey) continue;

    const slug    = name.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const color   = process.env[`PROJECT_${i}_COLOR`]   || '#8b5cf6';
    const grad    = process.env[`PROJECT_${i}_GRADIENT`] || `linear-gradient(135deg,${color},${color}cc)`;
    const icon    = process.env[`PROJECT_${i}_ICON`]     || '⚡';
    const limit   = Number(process.env[`PROJECT_${i}_LIMIT`] || 3);
    const desc    = process.env[`PROJECT_${i}_DESC`]     || '';
    const order   = i;

    await db.query(`
      INSERT INTO projects (name, slug, luarmor_project_id, luarmor_api_key, color, gradient, icon, daily_reset_limit, description, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (slug) DO UPDATE SET
        luarmor_project_id=EXCLUDED.luarmor_project_id,
        luarmor_api_key=EXCLUDED.luarmor_api_key,
        color=EXCLUDED.color, gradient=EXCLUDED.gradient,
        icon=EXCLUDED.icon, daily_reset_limit=EXCLUDED.daily_reset_limit,
        description=EXCLUDED.description
    `, [name, slug, pid, pkey, color, grad, icon, limit, desc, order]);
    console.log(`  ✓ Project seeded: ${name}`);
  }

  /* Seed admin from env — fully idempotent, never crashes */
  const adminUser = (process.env.ADMIN_USERNAME || '').toLowerCase().trim();
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (adminUser && adminPass) {
    const hash = await bcrypt.hash(adminPass, 12);
    const existing = await db.one('SELECT id FROM users WHERE username=$1', [adminUser]);
    if (existing) {
      /* User already exists — just update password + role */
      await db.query(
        'UPDATE users SET password_hash=$1, role=$2, is_active=true WHERE id=$3',
        [hash, 'admin', existing.id]
      );
      console.log(`  ✓ Admin updated: ${adminUser}`);
    } else {
      /* New admin — generate a unique internal key */
      let adminKey = process.env.ADMIN_LUARMOR_KEY || '';
      if (!adminKey || adminKey === 'admin-key-placeholder') {
        adminKey = `admin-${adminUser}-${Date.now()}`;
      }
      const keyTaken = await db.one('SELECT id FROM users WHERE luarmor_key=$1', [adminKey]);
      if (keyTaken) adminKey = `admin-${adminUser}-${Date.now()}`;
      await db.query(
        `INSERT INTO users (username, password_hash, luarmor_key, role, is_active)
         VALUES ($1,$2,$3,'admin',true)`,
        [adminUser, hash, adminKey]
      );
      console.log(`  ✓ Admin created: ${adminUser}`);
    }
  }

  console.log('✅ Database ready');
}

/* ─── Luarmor API ─── */
async function luarmorReq(method, projectId, apiKey, urlPath, body) {
  const url = `https://api.luarmor.net/v3/projects/${encodeURIComponent(projectId)}${urlPath}`;
  try {
    const opts = {
      method,
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      timeout: 8000,
    };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    const json = await res.json().catch(() => ({ success: false, message: 'Invalid response' }));
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { success: false, message: err.message } };
  }
}

/* Find which project a key belongs to — checks all active projects */
async function findProjectForKey(userKey) {
  const projects = await db.all('SELECT * FROM projects WHERE is_active=true ORDER BY sort_order');
  for (const proj of projects) {
    const { json } = await luarmorReq('GET', proj.luarmor_project_id, proj.luarmor_api_key,
      `/users?user_key=${encodeURIComponent(userKey)}`);
    const users = Array.isArray(json?.users) ? json.users : [];
    if (users.length > 0) return { project: proj, luaUser: users[0] };
  }
  return null;
}

/* Get Luarmor user for a DB user */
async function getLuaUser(dbUser) {
  if (!dbUser?.luarmor_key || !dbUser?.project_id) return null;
  const proj = await db.one('SELECT * FROM projects WHERE id=$1', [dbUser.project_id]);
  if (!proj) return null;
  const { json } = await luarmorReq('GET', proj.luarmor_project_id, proj.luarmor_api_key,
    `/users?user_key=${encodeURIComponent(dbUser.luarmor_key)}`);
  const users = Array.isArray(json?.users) ? json.users : [];
  return users[0] || null;
}

/* ─── Reset quota (PostgreSQL-backed, survives restarts) ─── */
function todayUTC() {
  return new Date().toISOString().slice(0,10);
}

async function getResetCount(userId) {
  const r = await db.one(
    'SELECT reset_count FROM reset_log WHERE user_id=$1 AND reset_date=$2',
    [userId, todayUTC()]
  );
  return r ? Number(r.reset_count) : 0;
}

async function incResetCount(userId) {
  await db.query(`
    INSERT INTO reset_log (user_id, reset_date, reset_count) VALUES ($1, $2, 1)
    ON CONFLICT (user_id, reset_date) DO UPDATE SET reset_count = reset_log.reset_count + 1
  `, [userId, todayUTC()]);
  await db.query('UPDATE users SET total_resets=total_resets+1 WHERE id=$1', [userId]);
  return getResetCount(userId);
}

/* ─── Middleware ─── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc:        ["'self'", "data:", "https://cdn.discordapp.com", "https://i.imgur.com", "https:"],
      connectSrc:    ["'self'", "https://api.luarmor.net", "https://api.ipify.org"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

/* PostgreSQL session store — sessions persist across Railway restarts */
app.use(session({
  store: new pgSession({ pool, tableName: 'session', createTableIfMissing: false }),
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

app.use((req, res, next) => {
  res.locals.panelName  = dynSettings.panel_name  || PANEL_NAME;
  res.locals.discordUrl = dynSettings.discord_url || DISCORD_URL;
  res.locals.panelLogo  = dynSettings.panel_logo  || PANEL_LOGO;
  res.locals.user       = req.session.user || null;
  next();
});

/* Rate limiters */
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 15,
  handler: (req,res) => res.status(429).render('login', { error: 'Too many attempts. Wait 15 min.' }) });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 10,
  handler: (req,res) => res.status(429).render('register', { error: 'Too many registrations. Try later.', projects: [] }) });
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 40,
  handler: (req,res) => res.status(429).json({ success:false, message:'Rate limit exceeded.' }) });

/* Auth guards */
function auth(req, res, next) {
  if (req.session.user) return next();
  res.redirect('/login');
}
function apiAuth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ success:false, message:'Session expired. Log in again.', expired:true });
}
function adminOnly(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).render('error', { message: 'Access denied.' });
}
function adminApiOnly(req, res, next) {
  if (req.session.user?.role === 'admin') return next();
  res.status(403).json({ success:false, message:'Admin only.' });
}

/* ─────────────────────────────────────
   PAGE ROUTES
───────────────────────────────────── */
app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

/* Login */
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', loginLimiter, async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();

  if (!username || !password)
    return res.render('login', { error: 'Please fill in all fields.' });

  const user = await db.one('SELECT * FROM users WHERE username=$1 AND is_active=true', [username]);
  if (!user) return res.render('login', { error: 'Invalid username or password.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('login', { error: 'Invalid username or password.' });

  const proj = user.project_id
    ? await db.one('SELECT * FROM projects WHERE id=$1', [user.project_id])
    : null;

  /* Ensure script_token exists — generate lazily for older accounts */
  let scriptToken = user.script_token;
  if (!scriptToken) {
    scriptToken = crypto.randomBytes(16).toString('hex');
    await db.query('UPDATE users SET script_token=$1 WHERE id=$2', [scriptToken, user.id]);
  }

  req.session.user = {
    id: user.id, username: user.username, role: user.role,
    luarmorKey: user.luarmor_key, projectId: user.project_id,
    project: proj,
    discordId: user.discord_id || '',
    note: user.note || '', scriptToken,
  };
  await db.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
  res.redirect('/dashboard');
});

/* Register */
app.get('/register', async (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const projects = await db.all('SELECT id,name,slug,color,gradient,icon,description,daily_reset_limit FROM projects WHERE is_active=true ORDER BY sort_order');
  res.render('register', { error: null, projects });
});

app.post('/register', registerLimiter, async (req, res) => {
  const getProjects = () => db.all('SELECT id,name,slug,color,gradient,icon,description,daily_reset_limit FROM projects WHERE is_active=true ORDER BY sort_order');
  const fail = async (msg) => res.render('register', { error: msg, projects: await getProjects() });

  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();
  const confirm  = (req.body.confirm  || '').trim();
  const key      = (req.body.key      || '').trim();

  if (!username || !password || !key)      return fail('All fields are required.');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail('Username must be 3-20 chars (letters, numbers, underscore).');
  if (password.length < 8)                 return fail('Password must be at least 8 characters.');
  if (password !== confirm)                return fail('Passwords do not match.');
  if (key.length < 6 || key.length > 256)  return fail('Invalid Luarmor key length.');

  const existsUser = await db.one('SELECT id FROM users WHERE username=$1', [username]);
  if (existsUser) return fail('That username is already taken.');

  const existsKey = await db.one('SELECT id FROM users WHERE luarmor_key=$1', [key]);
  if (existsKey) return fail('This Luarmor key is already registered to an account.');

  /* Find the project this key belongs to */
  const found = await findProjectForKey(key);
  if (!found) return fail('Key not found in any active project. Make sure you purchased or requested access, then try again.');

  const { project, luaUser } = found;

  if (luaUser.banned || luaUser.blacklisted)
    return fail('This key is banned. Contact staff on Discord.');

  const hash = await bcrypt.hash(password, 12);
  const scriptToken = crypto.randomBytes(16).toString('hex');
  const newUser = await db.one(
    `INSERT INTO users (username, password_hash, luarmor_key, project_id, discord_id, script_token)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [username, hash, key, project.id, luaUser.discord_id || '', scriptToken]
  );

  /* Auto-link Discord in Luarmor if not already */
  if (!luaUser.discord_id) {
    await luarmorReq('POST', project.luarmor_project_id, project.luarmor_api_key,
      '/users/linkdiscord', { user_key: key, discord_id: '', force: false }).catch(() => {});
  }

  req.session.user = {
    id: newUser.id, username, role: 'user',
    luarmorKey: key, projectId: project.id, project,
    discordId: luaUser.discord_id || '',
    note: '', scriptToken,
  };
  res.redirect('/dashboard');
});

/* Logout */
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

/* Dashboard */
app.get('/dashboard', auth, async (req, res) => {
  const { id, projectId } = req.session.user;
  const dbUser = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  const proj   = projectId ? await db.one('SELECT * FROM projects WHERE id=$1', [projectId]) : null;
  const luaUser = await getLuaUser(dbUser);

  const dailyLimit  = proj?.daily_reset_limit || 3;
  const resetsToday = await getResetCount(id);
  const resetsLeft  = Math.max(0, dailyLimit - resetsToday);
  const pct         = Math.min(100, Math.round((resetsToday / dailyLimit) * 100));
  const pfClass     = pct >= 100 ? 'pf-red' : pct >= 70 ? 'pf-yellow' : 'pf-green';
  const ringOffset  = Math.round(314 * (1 - pct / 100));

  const announcements = await db.all(`
    SELECT * FROM announcements WHERE is_active=true ORDER BY pinned DESC, created_at DESC LIMIT 5
  `);

  /* Reset history for sparkline */
  const history = await db.all(`
    SELECT reset_date, reset_count FROM reset_log
    WHERE user_id=$1 ORDER BY reset_date DESC LIMIT 7
  `, [id]);

  /* Live Roblox sessions (heartbeat within last 5 minutes = online) */
  const liveSessions = await db.all(`
    SELECT roblox_username, roblox_user_id, place_name, place_id, inventory, last_seen
    FROM live_sessions
    WHERE user_id=$1 AND last_seen > NOW() - INTERVAL '5 minutes'
    ORDER BY last_seen DESC
  `, [id]);

  res.render('dashboard', {
    dbUser, proj, luaUser,
    resetsToday, resetsLeft, dailyLimit, pct, pfClass, ringOffset,
    announcements, history, liveSessions,
  });
});


/* Admin panel */
app.get('/admin', auth, adminOnly, async (req, res) => {
  const [projects, users, announcements, totalUsers, activeToday, totalResets] = await Promise.all([
    db.all('SELECT p.*, COUNT(u.id) AS user_count FROM projects p LEFT JOIN users u ON u.project_id=p.id GROUP BY p.id ORDER BY p.sort_order'),
    db.all('SELECT u.*, p.name AS project_name, p.color AS project_color, p.icon AS project_icon FROM users u LEFT JOIN projects p ON p.id=u.project_id ORDER BY u.created_at DESC LIMIT 100'),
    db.all('SELECT a.*, u.username AS author_name FROM announcements a LEFT JOIN users u ON u.id=a.author_id ORDER BY a.pinned DESC, a.created_at DESC LIMIT 30'),
    db.one('SELECT COUNT(*) AS c FROM users'),
    db.one('SELECT COUNT(DISTINCT user_id) AS c FROM reset_log WHERE reset_date=CURRENT_DATE'),
    db.one('SELECT SUM(total_resets) AS c FROM users'),
  ]);
  res.render('admin', {
    projects, users, announcements,
    stats: { totalUsers: totalUsers.c, activeToday: activeToday.c, totalResets: totalResets.c || 0 },
    settings: { ...dynSettings },
  });
});

/* ─────────────────────────────────────
   ADMIN API — Projects CRUD
───────────────────────────────────── */
app.post('/api/admin/project', apiAuth, adminApiOnly, async (req, res) => {
  const name  = (req.body.name  || '').trim();
  const pid   = (req.body.luarmor_project_id || '').trim();
  const pkey  = (req.body.luarmor_api_key    || '').trim();
  if (!name || !pid || !pkey)
    return res.json({ success: false, message: 'Name, Project ID and API Key are required.' });

  const slug  = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 32);
  const color = (req.body.color || '#8b5cf6').trim();
  const grad  = (req.body.gradient || `linear-gradient(135deg,${color},${color}cc)`).trim();
  const icon  = (req.body.icon  || '⚡').trim();
  const limit = Math.max(1, Number(req.body.daily_reset_limit) || 3);
  const desc  = (req.body.description || '').trim();

  try {
    const proj = await db.one(`
      INSERT INTO projects (name,slug,luarmor_project_id,luarmor_api_key,color,gradient,icon,daily_reset_limit,description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
    `, [name, slug, pid, pkey, color, grad, icon, limit, desc]);
    res.json({ success: true, id: proj.id, message: `Project "${name}" created.` });
  } catch (e) {
    res.json({ success: false, message: e.detail || e.message });
  }
});

app.patch('/api/admin/project/:id', apiAuth, adminApiOnly, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['name','luarmor_project_id','luarmor_api_key','color','gradient','icon','daily_reset_limit','description','is_active','sort_order'];
  const fields = []; const vals = []; let i = 1;
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let val = req.body[key];
    if (key === 'daily_reset_limit' || key === 'sort_order') val = Number(val);
    if (key === 'is_active') val = val === true || val === 'true';
    fields.push(`${key}=$${i++}`); vals.push(val);
  }
  if (!fields.length) return res.json({ success: false, message: 'Nothing to update.' });
  vals.push(id);
  await db.query(`UPDATE projects SET ${fields.join(',')} WHERE id=$${i}`, vals);
  res.json({ success: true, message: 'Project updated.' });
});

app.delete('/api/admin/project/:id', apiAuth, adminApiOnly, async (req, res) => {
  await db.query('UPDATE projects SET is_active=false WHERE id=$1', [req.params.id]);
  res.json({ success: true, message: 'Project disabled.' });
});

/* ─────────────────────────────────────
   ADMIN API — Users CRUD
───────────────────────────────────── */
app.get('/api/admin/users', apiAuth, adminApiOnly, async (req, res) => {
  const q      = (req.query.q || '').trim();
  const lim    = Math.min(100, Number(req.query.limit)  || 50);
  const offset = Math.max(0,   Number(req.query.offset) || 0);
  const vals   = [];
  let where    = 'WHERE 1=1';
  if (q) {
    vals.push(`%${q}%`);
    where += ` AND (u.username ILIKE $1 OR u.luarmor_key ILIKE $1 OR u.discord_id ILIKE $1)`;
  }
  const [users, total] = await Promise.all([
    db.all(`SELECT u.*, p.name AS project_name, p.color AS project_color, p.icon AS project_icon
            FROM users u LEFT JOIN projects p ON p.id=u.project_id
            ${where} ORDER BY u.created_at DESC LIMIT ${lim} OFFSET ${offset}`, vals),
    db.one(`SELECT COUNT(*) AS c FROM users u ${where}`, vals),
  ]);
  res.json({ success: true, users, total: Number(total.c) });
});

app.patch('/api/admin/user/:id', apiAuth, adminApiOnly, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['role','project_id','discord_id','note','is_active','username'];
  const fields = []; const vals = []; let i = 1;
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let val = req.body[key];
    if (key === 'role' && !['user','admin','mod'].includes(val)) continue;
    if (key === 'is_active') val = val === true || val === 'true';
    if (key === 'project_id') val = val ? Number(val) : null;
    if (key === 'note') val = String(val).slice(0, 100);
    if (key === 'username') val = String(val).toLowerCase().trim();
    fields.push(`${key}=$${i++}`); vals.push(val);
  }
  if (!fields.length) return res.json({ success: false, message: 'Nothing to update.' });
  vals.push(id);
  try {
    await db.query(`UPDATE users SET ${fields.join(',')} WHERE id=$${i}`, vals);
    res.json({ success: true, message: 'User updated.' });
  } catch (e) {
    res.json({ success: false, message: e.detail || e.message });
  }
});

app.delete('/api/admin/user/:id', apiAuth, adminApiOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (req.session.user.id === id) return res.json({ success: false, message: "Can't delete your own account." });
  await db.query('DELETE FROM reset_log WHERE user_id=$1', [id]);
  await db.query('DELETE FROM users WHERE id=$1', [id]);
  res.json({ success: true, message: 'User deleted.' });
});

app.post('/api/admin/user/:id/force-reset', apiAuth, adminApiOnly, async (req, res) => {
  const id   = Number(req.params.id);
  const user = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  const proj = user.project_id ? await db.one('SELECT * FROM projects WHERE id=$1', [user.project_id]) : null;
  if (!proj)  return res.json({ success: false, message: 'User has no project assigned.' });
  const { json } = await luarmorReq('POST', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users/resethwid', { user_key: user.luarmor_key, force: true });
  res.json({ success: json?.success || false, message: json?.message || 'Done.' });
});

app.post('/api/admin/user/:id/change-password', apiAuth, adminApiOnly, async (req, res) => {
  const id  = Number(req.params.id);
  const pwd = (req.body.password || '').trim();
  if (pwd.length < 8) return res.json({ success: false, message: 'Password must be 8+ characters.' });
  const hash = await bcrypt.hash(pwd, 12);
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);
  res.json({ success: true, message: 'Password changed.' });
});

/* ─────────────────────────────────────
   ADMIN API — Settings
───────────────────────────────────── */
app.get('/api/admin/settings', apiAuth, adminApiOnly, (_req, res) => {
  res.json({ success: true, settings: { ...dynSettings } });
});

app.post('/api/admin/settings', apiAuth, adminApiOnly, async (req, res) => {
  const allowed = ['panel_name','panel_logo','discord_url'];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    const val = String(req.body[key]).trim();
    await db.query(`INSERT INTO settings (key,value,updated_at) VALUES ($1,$2,NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, val]);
    dynSettings[key] = val;
  }
  res.json({ success: true, message: 'Settings saved.' });
});

/* ─────────────────────────────────────
   ADMIN API — Stats
───────────────────────────────────── */
app.get('/api/admin/stats', apiAuth, adminApiOnly, async (_req, res) => {
  const [totalUsers, activeToday, totalResets, newToday] = await Promise.all([
    db.one('SELECT COUNT(*) AS c FROM users'),
    db.one('SELECT COUNT(DISTINCT user_id) AS c FROM reset_log WHERE reset_date=CURRENT_DATE'),
    db.one('SELECT SUM(total_resets) AS c FROM users'),
    db.one("SELECT COUNT(*) AS c FROM users WHERE created_at >= CURRENT_DATE"),
  ]);
  res.json({ success: true, stats: {
    totalUsers:  Number(totalUsers.c),
    activeToday: Number(activeToday.c),
    totalResets: Number(totalResets.c || 0),
    newToday:    Number(newToday.c),
  }});
});

/* ─────────────────────────────────────
   API ROUTES
───────────────────────────────────── */
app.get('/api/userinfo', apiAuth, apiLimiter, async (req, res) => {
  const { id } = req.session.user;
  const dbUser  = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  const luaUser = await getLuaUser(dbUser);
  const proj    = dbUser.project_id ? await db.one('SELECT * FROM projects WHERE id=$1', [dbUser.project_id]) : null;
  const resetsToday = await getResetCount(id);
  const dailyLimit  = proj?.daily_reset_limit || 3;
  const resetsLeft  = Math.max(0, dailyLimit - resetsToday);
  res.json({ success:true, user: luaUser, dbUser, project: proj, resetsToday, resetsLeft, dailyLimit });
});

app.post('/api/reset-hwid', apiAuth, apiLimiter, async (req, res) => {
  const { id, luarmorKey, projectId } = req.session.user;

  const proj = projectId ? await db.one('SELECT * FROM projects WHERE id=$1', [projectId]) : null;
  if (!proj) return res.json({ success:false, message:'No project configured for your account.' });

  const dailyLimit  = proj.daily_reset_limit;
  const resetsToday = await getResetCount(id);
  if (resetsToday >= dailyLimit)
    return res.json({ success:false, message:`Daily limit reached (${dailyLimit}/${dailyLimit}). Resets at 00:00 UTC.` });

  const luaUser = await getLuaUser({ luarmor_key: luarmorKey, project_id: projectId });
  if (!luaUser)         return res.json({ success:false, message:'Could not verify your key.' });
  if (luaUser.banned)   return res.json({ success:false, message:'Your key is banned. Contact staff.' });

  const { ok, status, json } = await luarmorReq('POST', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users/resethwid', { user_key: luarmorKey, force: true });

  if (!json?.success) {
    console.error(`[reset] HTTP ${status}: ${json?.message}`);
    return res.json({ success:false, message: json?.message || `API error (HTTP ${status})` });
  }

  const newCount = await incResetCount(id);
  const remaining = Math.max(0, dailyLimit - newCount);
  res.json({ success:true, message: json.message || 'HWID reset successfully.',
    resetsToday: newCount, resetsLeft: remaining, dailyLimit });
});

app.post('/api/link-discord', apiAuth, apiLimiter, async (req, res) => {
  const { luarmorKey, projectId } = req.session.user;
  const discordId = (req.body.discord_id || '').trim();
  if (!discordId || !/^\d{15,20}$/.test(discordId))
    return res.json({ success:false, message:'Invalid Discord ID (15-20 digits).' });

  const proj = projectId ? await db.one('SELECT * FROM projects WHERE id=$1', [projectId]) : null;
  if (!proj) return res.json({ success:false, message:'No project found.' });

  const { json } = await luarmorReq('POST', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users/linkdiscord', { user_key: luarmorKey, discord_id: discordId, force: true });

  if (json?.success) {
    await db.query('UPDATE users SET discord_id=$1 WHERE id=$2', [discordId, req.session.user.id]);
    req.session.user.discordId = discordId;
  }
  res.json({ success: json?.success || false, message: json?.message || 'Error.' });
});

app.post('/api/update-note', apiAuth, apiLimiter, async (req, res) => {
  const { luarmorKey, projectId } = req.session.user;
  const note = (req.body.note || '').trim().slice(0, 100);

  const proj = projectId ? await db.one('SELECT * FROM projects WHERE id=$1', [projectId]) : null;
  if (!proj) return res.json({ success:false, message:'No project found.' });

  const { json } = await luarmorReq('PATCH', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users', { user_key: luarmorKey, note });

  if (json?.success) await db.query('UPDATE users SET note=$1 WHERE id=$2', [note, req.session.user.id]);
  res.json({ success: json?.success || false, message: json?.message || 'Error.' });
});

app.post('/api/change-password', apiAuth, apiLimiter, async (req, res) => {
  const { id } = req.session.user;
  const current = (req.body.current || '').trim();
  const next    = (req.body.next    || '').trim();
  const confirm = (req.body.confirm || '').trim();

  if (!current || !next) return res.json({ success:false, message:'Fill in all fields.' });
  if (next.length < 8)   return res.json({ success:false, message:'New password must be 8+ characters.' });
  if (next !== confirm)  return res.json({ success:false, message:'Passwords do not match.' });

  const user = await db.one('SELECT password_hash FROM users WHERE id=$1', [id]);
  const ok = await bcrypt.compare(current, user.password_hash);
  if (!ok) return res.json({ success:false, message:'Current password is incorrect.' });

  const hash = await bcrypt.hash(next, 12);
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, id]);
  res.json({ success:true, message:'Password updated successfully.' });
});

/* Admin API */
app.post('/api/admin/announcement', apiAuth, adminApiOnly, async (req, res) => {
  const title   = (req.body.title   || '').trim().slice(0,128);
  const content = (req.body.content || '').trim().slice(0,2000);
  const type    = ['info','success','warning','danger'].includes(req.body.type) ? req.body.type : 'info';
  const pinned  = req.body.pinned === 'true';
  if (!title || !content) return res.json({ success:false, message:'Title and content required.' });
  await db.query(
    'INSERT INTO announcements (title,content,type,pinned,author_id) VALUES ($1,$2,$3,$4,$5)',
    [title, content, type, pinned, req.session.user.id]
  );
  res.json({ success:true, message:'Announcement posted.' });
});

app.delete('/api/admin/announcement/:id', apiAuth, adminApiOnly, async (req, res) => {
  await db.query('UPDATE announcements SET is_active=false WHERE id=$1', [req.params.id]);
  res.json({ success:true });
});

app.post('/api/admin/toggle-user', apiAuth, adminApiOnly, async (req, res) => {
  const userId = Number(req.body.user_id);
  const user = await db.one('SELECT is_active FROM users WHERE id=$1', [userId]);
  if (!user) return res.json({ success:false, message:'User not found.' });
  await db.query('UPDATE users SET is_active=$1 WHERE id=$2', [!user.is_active, userId]);
  res.json({ success:true, active: !user.is_active });
});

/* Kick a live session */
app.post('/api/kick-session', apiAuth, async (req, res) => {
  const robloxUserId = (req.body.roblox_user_id || '').trim();
  if (!robloxUserId) return res.json({ success: false, message: 'Missing roblox_user_id.' });
  const { id, role } = req.session.user;
  /* Users can only kick their own sessions; admins can kick any */
  const where = role === 'admin'
    ? 'roblox_user_id=$1'
    : 'roblox_user_id=$1 AND user_id=$2';
  const params = role === 'admin' ? [robloxUserId] : [robloxUserId, id];
  const r = await db.query(`UPDATE live_sessions SET kick_requested=true WHERE ${where}`, params);
  if (r.rowCount === 0) return res.json({ success: false, message: 'Session not found.' });
  res.json({ success: true });
});

/* Live session status — called from dashboard JS */
app.get('/api/live-status', apiAuth, async (req, res) => {
  const sessions = await db.all(`
    SELECT roblox_username, roblox_user_id, place_name, place_id, inventory, last_seen
    FROM live_sessions
    WHERE user_id=$1 AND last_seen > NOW() - INTERVAL '5 minutes'
    ORDER BY last_seen DESC
  `, [req.session.user.id]);
  res.json({ online: sessions.length > 0, sessions });
});

/* ─────────────────────────────────────
   HEARTBEAT — called from Roblox executor (no session auth)
───────────────────────────────────── */
const heartbeatLimiter = rateLimit({ windowMs: 60*1000, max: 240,
  handler: (_req, res) => res.status(429).json({ ok: false }) });

app.get('/api/heartbeat', heartbeatLimiter, async (req, res) => {
  const key = (req.query.key || '').trim();
  if (!key || key.length < 6) return res.status(400).json({ ok: false });

  const dbUser = await db.one('SELECT id FROM users WHERE luarmor_key=$1', [key]);
  if (!dbUser) return res.status(401).json({ ok: false });

  const rn = (req.query.rn || '').slice(0, 64);   // roblox username
  const ri = (req.query.ri || '').slice(0, 32);   // roblox user id
  const pi = (req.query.pi || '').slice(0, 32);   // place id
  const pn = (req.query.pn || '').slice(0, 128);  // place name
  const ji = (req.query.ji || '').slice(0, 64);   // job id

  /* Parse inventory: "Wood:10,Stone:5,Gold:2" → { Wood:10, Stone:5, Gold:2 } */
  const invRaw = (req.query.inv || '').slice(0, 2000);
  const inventory = {};
  if (invRaw) {
    invRaw.split(',').forEach(part => {
      const idx = part.lastIndexOf(':');
      if (idx > 0) {
        const name  = part.slice(0, idx).trim();
        const count = Number(part.slice(idx + 1)) || 0;
        if (name && count > 0) inventory[name] = count;
      }
    });
  }

  const robloxId = ri || 'unknown';
  /* Check if a kick was requested BEFORE upserting (so we can return it) */
  const existing = await db.one(
    'SELECT kick_requested FROM live_sessions WHERE user_id=$1 AND roblox_user_id=$2',
    [dbUser.id, robloxId || 'unknown']
  );
  const shouldKick = !!(existing && existing.kick_requested);

  await db.query(`
    INSERT INTO live_sessions (user_id, roblox_user_id, roblox_username, place_id, place_name, job_id, inventory, kick_requested, last_seen)
    VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW())
    ON CONFLICT (user_id, roblox_user_id) DO UPDATE SET
      roblox_username=$3, place_id=$4, place_name=$5, job_id=$6,
      inventory=$7, kick_requested=false, last_seen=NOW()
  `, [dbUser.id, robloxId, rn, pi, pn, ji, JSON.stringify(inventory)]);

  res.json({ ok: true, kick: shouldKick });
});

app.get('/health', (req, res) => res.json({ ok:true, ts: Date.now() }));
app.use((req, res) => res.status(404).render('404'));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { message:'Internal server error.' }); });

/* ─── Boot ─── */
async function main() {
  await initDB();
  await loadSettings();
  app.listen(PORT, async () => {
    console.log(`\n✅ ${dynSettings.panel_name || PANEL_NAME} running on port ${PORT}`);
    console.log(`🔗 Discord: ${dynSettings.discord_url || DISCORD_URL}`);
    console.log(`💾 Sessions: PostgreSQL (persistent)`);
    try {
      const r = await fetch('https://api.ipify.org?format=json', { timeout: 6000 });
      const d = await r.json();
      console.log(`🌐 Outbound IP (whitelist this in Luarmor): ${d.ip}`);
    } catch {
      console.log(`🌐 Outbound IP: could not detect (check Railway logs later)`);
    }
  });
}
main().catch(e => { console.error('Boot error:', e); process.exit(1); });