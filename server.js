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
const DISCORD_URL   = process.env.DISCORD_URL || 'https://discord.gg/dnUMzRhDuK';
const PANEL_LOGO    = process.env.PANEL_LOGO || 'https://cdn.discordapp.com/icons/1398423987817807934/a_6f62815e5aee24b4964bd4113626e3fe.webp?size=64';

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

  /* Seed admin from env */
  const adminUser = (process.env.ADMIN_USERNAME || '').toLowerCase();
  const adminPass = process.env.ADMIN_PASSWORD;
  const adminKey  = process.env.ADMIN_LUARMOR_KEY || 'admin-key-placeholder';
  if (adminUser && adminPass) {
    const exists = await db.one('SELECT id FROM users WHERE username=$1', [adminUser]);
    if (!exists) {
      const hash = await bcrypt.hash(adminPass, 12);
      await db.query(
        `INSERT INTO users (username, password_hash, luarmor_key, role) VALUES ($1,$2,$3,'admin')
         ON CONFLICT (username) DO NOTHING`,
        [adminUser, hash, adminKey]
      );
      console.log(`  ✓ Admin user created: ${adminUser}`);
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
  res.locals.panelName  = PANEL_NAME;
  res.locals.discordUrl = DISCORD_URL;
  res.locals.panelLogo  = PANEL_LOGO;
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

  req.session.user = {
    id: user.id, username: user.username, role: user.role,
    luarmorKey: user.luarmor_key, projectId: user.project_id,
    project: proj,
    discordId: user.discord_id || '',
    note: user.note || '',
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
  const newUser = await db.one(
    `INSERT INTO users (username, password_hash, luarmor_key, project_id, discord_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [username, hash, key, project.id, luaUser.discord_id || '']
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
    note: '',
  };
  res.redirect('/dashboard');
});

/* Logout */
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

/* Dashboard */
app.get('/dashboard', auth, async (req, res) => {
  const { id, luarmorKey, projectId } = req.session.user;
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

  res.render('dashboard', {
    dbUser, proj, luaUser,
    resetsToday, resetsLeft, dailyLimit, pct, pfClass, ringOffset,
    announcements, history,
  });
});

/* IP Info */
app.get('/ip-info', auth, async (_req, res) => {
  let serverIp = null;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const d = await r.json();
    serverIp = d.ip || null;
  } catch {}
  res.render('ipinfo', { serverIp });
});

app.get('/api/server-ip', apiAuth, async (req, res) => {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const d = await r.json();
    res.json({ ip: d.ip || null });
  } catch (e) {
    res.json({ ip: null, error: e.message });
  }
});

/* Admin panel */
app.get('/admin', auth, adminOnly, async (req, res) => {
  const [projects, users, announcements] = await Promise.all([
    db.all('SELECT p.*, COUNT(u.id) AS user_count FROM projects p LEFT JOIN users u ON u.project_id=p.id GROUP BY p.id ORDER BY p.sort_order'),
    db.all('SELECT u.*, p.name AS project_name, p.color AS project_color FROM users u LEFT JOIN projects p ON p.id=u.project_id ORDER BY u.created_at DESC LIMIT 50'),
    db.all('SELECT a.*, u.username AS author_name FROM announcements a LEFT JOIN users u ON u.id=a.author_id ORDER BY a.created_at DESC LIMIT 20'),
  ]);
  const totalUsers   = await db.one('SELECT COUNT(*) AS c FROM users');
  const activeToday  = await db.one(`SELECT COUNT(DISTINCT user_id) AS c FROM reset_log WHERE reset_date=CURRENT_DATE`);
  const totalResets  = await db.one('SELECT SUM(total_resets) AS c FROM users');
  res.render('admin', { projects, users, announcements,
    stats: { totalUsers: totalUsers.c, activeToday: activeToday.c, totalResets: totalResets.c || 0 } });
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

app.get('/health', (req, res) => res.json({ ok:true, ts: Date.now() }));
app.use((req, res) => res.status(404).render('404'));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { message:'Internal server error.' }); });

/* ─── Boot ─── */
async function main() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n✅ ${PANEL_NAME} running on port ${PORT}`);
    console.log(`🔗 Discord: ${DISCORD_URL}`);
    console.log(`💾 Sessions: PostgreSQL (persistent)`);
  });
}
main().catch(e => { console.error('Boot error:', e); process.exit(1); });