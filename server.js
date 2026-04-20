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
const fs          = require('fs');
const http        = require('http');
const { Server }  = require('socket.io');
const multer      = require('multer');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 5 * 1024 * 1024, // 5MB max
});

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

/* ─── Ensure upload directories exist ─── */
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'chat');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ─── PostgreSQL Pool ─── */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

/* Prevent unhandled 'error' events from idle client drops crashing the process */
pool.on('error', (err, client) => {
  console.error('[Pool] Unexpected error on idle client — connection will be discarded:', err.message);
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(16) DEFAULT 'en';
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_free BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS user_keys (
      id          SERIAL PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      luarmor_key TEXT NOT NULL UNIQUE,
      project_id  INT REFERENCES projects(id) ON DELETE SET NULL,
      label       VARCHAR(64) NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_keys_user ON user_keys(user_id);
    DROP TABLE IF EXISTS live_sessions;
    CREATE TABLE live_sessions (
      roblox_user_id  VARCHAR(32) NOT NULL PRIMARY KEY,
      roblox_username VARCHAR(64) NOT NULL DEFAULT '',
      user_id         INT REFERENCES users(id) ON DELETE SET NULL,
      place_id        VARCHAR(32) NOT NULL DEFAULT '',
      place_name      VARCHAR(128) NOT NULL DEFAULT '',
      job_id          VARCHAR(64) NOT NULL DEFAULT '',
      inventory       JSONB NOT NULL DEFAULT '{}',
      kick_requested  BOOL NOT NULL DEFAULT false,
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          SERIAL PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username    VARCHAR(32) NOT NULL,
      role        VARCHAR(16) NOT NULL DEFAULT 'user',
      content     TEXT,
      image_url   TEXT,
      deleted     BOOL NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC);
    CREATE TABLE IF NOT EXISTS bug_reports (
      id          SERIAL PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username    VARCHAR(32) NOT NULL,
      title       VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      status      VARCHAR(16) NOT NULL DEFAULT 'open',
      admin_note  VARCHAR(512) NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_bug_reports_user   ON bug_reports(user_id);
    CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified_seller BOOL NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS shop_listings (
      id          SERIAL PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username    VARCHAR(32) NOT NULL,
      title       VARCHAR(128) NOT NULL,
      description TEXT NOT NULL,
      price       VARCHAR(64) NOT NULL DEFAULT 'Negotiable',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS private_chats (
      id SERIAL PRIMARY KEY,
      user1_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user2_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user1_id, user2_id)
    );
    CREATE TABLE IF NOT EXISTS private_messages (
      id SERIAL PRIMARY KEY,
      chat_id INT NOT NULL REFERENCES private_chats(id) ON DELETE CASCADE,
      sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  /* Seed admin from env — fully idempotent */
  const adminUser = (process.env.ADMIN_USERNAME || '').toLowerCase().trim();
  const adminPass = process.env.ADMIN_PASSWORD || '';
  if (adminUser && adminPass) {
    const hash = await bcrypt.hash(adminPass, 12);
    const existing = await db.one('SELECT id FROM users WHERE username=$1', [adminUser]);
    if (existing) {
      await db.query(
        'UPDATE users SET password_hash=$1, role=$2, is_active=true WHERE id=$3',
        [hash, 'admin', existing.id]
      );
      console.log(`  ✓ Admin updated: ${adminUser}`);
    } else {
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

async function getLuaUser(dbUser) {
  if (!dbUser?.luarmor_key || !dbUser?.project_id) return null;
  const proj = await db.one('SELECT * FROM projects WHERE id=$1', [dbUser.project_id]);
  if (!proj) return null;
  const { json } = await luarmorReq('GET', proj.luarmor_project_id, proj.luarmor_api_key,
    `/users?user_key=${encodeURIComponent(dbUser.luarmor_key)}`);
  const users = Array.isArray(json?.users) ? json.users : [];
  return users[0] || null;
}

/* ─── Reset quota ─── */
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

/* ─── Multer — chat image uploads ─── */
const chatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  },
});
const chatUpload = multer({
  storage: chatStorage,
  limits:  { fileSize: 4 * 1024 * 1024 }, // 4 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

/* ─── Middleware ─── */
const sessionMiddleware = session({
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
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      styleSrc:      ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:       ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com", "data:"],
      scriptSrc:     ["'self'", "'unsafe-inline'", "https://publisher.linkvertise.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc:        ["'self'", "data:", "blob:", "https://cdn.discordapp.com", "https://i.imgur.com", "https:"],
      connectSrc:    ["'self'", "https://api.luarmor.net", "https://api.ipify.org", "https://linkvertise.com", "https://*.linkvertise.com", "ws:", "wss:"],
      frameSrc:      ["https://linkvertise.com", "https://*.linkvertise.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});

app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
}));
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(sessionMiddleware);

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
const chatLimiter = rateLimit({ windowMs: 5*1000, max: 3,
  handler: (req,res) => res.status(429).json({ success:false, message:'Sending too fast. Slow down.' }) });

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
function modOrAdmin(req, res, next) {
  const r = req.session.user?.role;
  if (r === 'admin' || r === 'mod') return next();
  res.status(403).render('error', { message: 'Access denied.' });
}
function modOrAdminApi(req, res, next) {
  const r = req.session.user?.role;
  if (r === 'admin' || r === 'mod') return next();
  res.status(403).json({ success:false, message:'Insufficient permissions.' });
}

/* ─── Socket.io — shared session + chat ─── */
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

/* Track online users: Map<userId, { username, role, socketId }> */
const onlineUsers = new Map();

io.on('connection', (socket) => {
  const sess = socket.request.session?.user;
  if (!sess) { socket.disconnect(true); return; }

  const { id: userId, username, role } = sess;
  onlineUsers.set(userId, { username, role, socketId: socket.id });
  io.emit('online_count', onlineUsers.size);

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('online_count', onlineUsers.size);
  });

  /* Client requests online users list */
  socket.on('get_online', () => {
    socket.emit('online_list', Array.from(onlineUsers.values()).map(u => ({ username: u.username, role: u.role })));
  });
});

/* ─────────────────────────────────────
   PAGE ROUTES
───────────────────────────────────── */
app.get('/', (_req, res) => res.redirect('/home'));

app.get('/home', async (req, res) => {
  let project = null;
  if (req.session.user?.projectId) {
    project = await db.one('SELECT id, name, icon, daily_reset_limit FROM projects WHERE id=$1', [req.session.user.projectId]);
  }
  res.render('home', { project, disableAds: true });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null, disableAds: true });
});

app.post('/login', loginLimiter, async (req, res) => {
  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();

  if (!username || !password)
    return res.render('login', { error: 'Please fill in all fields.', disableAds: true });

  const user = await db.one('SELECT * FROM users WHERE username=$1 AND is_active=true', [username]);
  if (!user) return res.render('login', { error: 'Invalid username or password.', disableAds: true });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('login', { error: 'Invalid username or password.', disableAds: true });

  const proj = user.project_id
    ? await db.one('SELECT * FROM projects WHERE id=$1', [user.project_id])
    : null;

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
    avatarUrl: user.avatar_url || '',
    language: user.language || 'en'
  };
  await db.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
  res.redirect('/dashboard');
});

app.get('/register', async (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const projects = await db.all('SELECT id,name,slug,color,gradient,icon,description,daily_reset_limit FROM projects WHERE is_active=true AND is_free=false ORDER BY sort_order');
  res.render('register', { error: null, projects, disableAds: true });
});

app.post('/register', registerLimiter, async (req, res) => {
  const getProjects = () => db.all('SELECT id,name,slug,color,gradient,icon,description,daily_reset_limit FROM projects WHERE is_active=true AND is_free=false ORDER BY sort_order');
  const fail = async (msg) => res.render('register', { error: msg, projects: await getProjects(), disableAds: true });

  const username = (req.body.username || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();
  const confirm  = (req.body.confirm  || '').trim();
  let   key      = (req.body.key      || '').trim();

  if (!username || !password)              return fail('Username and password are required.');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail('Username must be 3-20 chars (letters, numbers, underscore).');
  if (password.length < 8)                 return fail('Password must be at least 8 characters.');
  if (password !== confirm)                return fail('Passwords do not match.');

  const existsUser = await db.one('SELECT id FROM users WHERE username=$1', [username]);
  if (existsUser) return fail('That username is already taken.');

  /* If the user accidentally pasted a FREE- key treat as free registration */
  if (key && key.toUpperCase().startsWith('FREE-')) key = '';

  let finalKey = key;
  let finalProject = null;
  let finalDiscordId = '';
  let fullProject = null;

  if (key) {
    if (key.length < 6 || key.length > 256) return fail('Invalid Luarmor key length.');
    const existsKey = await db.one('SELECT id FROM users WHERE luarmor_key=$1', [key]);
    if (existsKey) return fail('This Luarmor key is already registered to an account.');

    const found = await findProjectForKey(key);
    if (!found) return fail('Key not found in any active project. Make sure you purchased or requested access, then try again.');

    const { project, luaUser } = found;

    if (luaUser.banned || luaUser.blacklisted)
      return fail('This key is banned. Contact staff on Discord.');
    
    finalProject = project.id;
    fullProject = project;
    finalDiscordId = luaUser.discord_id || '';
  } else {
    finalKey = `FREE-${username}-${Date.now()}`;
    const freeProject = await db.one('SELECT * FROM projects WHERE is_free=true AND is_active=true LIMIT 1');
    if (freeProject) {
      finalProject = freeProject.id;
      fullProject = freeProject;
    }
  }

  const hash = await bcrypt.hash(password, 12);
  const scriptToken = crypto.randomBytes(16).toString('hex');
  const newUser = await db.one(
    `INSERT INTO users (username, password_hash, luarmor_key, project_id, discord_id, script_token)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [username, hash, finalKey, finalProject, finalDiscordId, scriptToken]
  );

  if (key && !finalDiscordId && fullProject) {
    await luarmorReq('POST', fullProject.luarmor_project_id, fullProject.luarmor_api_key,
      '/users/linkdiscord', { user_key: key, discord_id: '', force: false }).catch(() => {});
  }

  req.session.user = {
    id: newUser.id, username, role: 'user',
    luarmorKey: finalKey, projectId: finalProject, project: fullProject,
    discordId: finalDiscordId,
    note: '', scriptToken,
    avatarUrl: '',
    language: 'en'
  };
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/home')));

app.get('/dashboard', auth, async (req, res) => {
  const { id, projectId } = req.session.user;
  const dbUserRaw = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  if (!dbUserRaw) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  const { password_hash, script_token, ...dbUser } = dbUserRaw;
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

  const history = await db.all(`
    SELECT reset_date, reset_count FROM reset_log
    WHERE user_id=$1 ORDER BY reset_date DESC LIMIT 7
  `, [id]);

  const liveSessions = await db.all(`
    SELECT roblox_username, roblox_user_id, place_name, place_id, inventory, last_seen
    FROM live_sessions
    WHERE user_id=$1 AND last_seen > NOW() - INTERVAL '35 seconds'
    ORDER BY last_seen DESC
  `, [id]);

  const userKeys = await db.all(`
    SELECT uk.id, uk.luarmor_key, uk.label, uk.created_at,
           p.name AS project_name, p.icon AS project_icon, p.color AS project_color,
           p.daily_reset_limit
    FROM user_keys uk
    LEFT JOIN projects p ON p.id = uk.project_id
    WHERE uk.user_id = $1
    ORDER BY uk.created_at ASC
  `, [id]);

  res.render('dashboard', {
    dbUser, proj, luaUser,
    resetsToday, resetsLeft, dailyLimit, pct, pfClass, ringOffset,
    announcements, history, liveSessions, userKeys, disableAds: true
  });
});

app.get('/chat', auth, async (req, res) => {
  const messages = await db.all(`
    SELECT m.id, m.username, m.role, m.content, m.image_url, m.created_at
    FROM chat_messages m
    WHERE m.deleted = false
    ORDER BY m.created_at DESC LIMIT 80
  `);
  messages.reverse();
  const onlineCount = onlineUsers.size;
  res.render('chat', { messages, onlineCount, page: 'chat' });
});

/* ── Bug Reports ─────────────────────────────────── */
app.get('/bugs', auth, async (req, res) => {
  const { id } = req.session.user;
  const reports = await db.all(
    'SELECT id, title, description, status, admin_note, created_at FROM bug_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',
    [id]
  );
  res.render('bugs', { reports, page: 'bugs', success: null, error: null, disableAds: true });
});

app.post('/bugs', auth, async (req, res) => {
  const { id, username } = req.session.user;
  const title       = (req.body.title       || '').trim().slice(0, 128);
  const description = (req.body.description || '').trim().slice(0, 2000);
  const fetchReports = () => db.all(
    'SELECT id, title, description, status, admin_note, created_at FROM bug_reports WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30',
    [id]
  );
  if (!title || !description) {
    return res.render('bugs', { reports: await fetchReports(), page: 'bugs', success: null, error: 'Title and description are required.', disableAds: true });
  }
  await db.query('INSERT INTO bug_reports (user_id, username, title, description) VALUES ($1,$2,$3,$4)', [id, username, title, description]);
  res.render('bugs', { reports: await fetchReports(), page: 'bugs', success: 'Report submitted! Staff will review it shortly.', error: null, disableAds: true });
});

/* ── Mod Panel ───────────────────────────────────── */
app.get('/mod', auth, modOrAdmin, async (req, res) => {
  const users = await db.all(`
    SELECT u.id, u.username, u.role, u.is_active, u.total_resets, u.created_at,
           p.name AS project_name, p.icon AS project_icon
    FROM users u
    LEFT JOIN projects p ON p.id = u.project_id
    ORDER BY u.created_at DESC LIMIT 200
  `);
  res.render('mod', { users, page: 'mod', disableAds: true });
});

/* ── Mod API ─────────────────────────────────────── */
app.post('/api/mod/user/:id/reset-hwid', apiAuth, modOrAdminApi, async (req, res) => {
  const id   = Number(req.params.id);
  const user = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  const proj = user.project_id ? await db.one('SELECT * FROM projects WHERE id=$1', [user.project_id]) : null;
  if (!proj) return res.json({ success: false, message: 'User has no project assigned.' });
  const { json } = await luarmorReq('POST', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users/resethwid', { user_key: user.luarmor_key, force: true });
  res.json({ success: json?.success || false, message: json?.message || 'Done.' });
});

app.post('/api/mod/user/:id/blacklist', apiAuth, modOrAdminApi, async (req, res) => {
  const id = Number(req.params.id);
  if (req.session.user.id === id) return res.json({ success: false, message: "Can't blacklist yourself." });
  const target = await db.one('SELECT role FROM users WHERE id=$1', [id]);
  if (!target) return res.json({ success: false, message: 'User not found.' });
  if (target.role === 'admin') return res.json({ success: false, message: "Can't blacklist an admin." });
  await db.query('UPDATE users SET is_active=false WHERE id=$1', [id]);
  res.json({ success: true, message: 'User blacklisted.' });
});

app.post('/api/mod/user/:id/unblacklist', apiAuth, modOrAdminApi, async (req, res) => {
  const id     = Number(req.params.id);
  const target = await db.one('SELECT role FROM users WHERE id=$1', [id]);
  if (!target) return res.json({ success: false, message: 'User not found.' });
  await db.query('UPDATE users SET is_active=true WHERE id=$1', [id]);
  res.json({ success: true, message: 'User reinstated.' });
});

app.get('/admin', auth, adminOnly, async (req, res) => {
  const [projectsRaw, usersRaw, announcements, totalUsers, activeToday, totalResets, chatCount, openBugs] = await Promise.all([
    db.all('SELECT p.*, COUNT(u.id) AS user_count FROM projects p LEFT JOIN users u ON u.project_id=p.id GROUP BY p.id ORDER BY p.sort_order'),
    db.all('SELECT u.id, u.username, u.luarmor_key, u.role, u.project_id, u.discord_id, u.note, u.is_active, u.total_resets, u.created_at, u.last_login, p.name AS project_name, p.color AS project_color, p.icon AS project_icon FROM users u LEFT JOIN projects p ON p.id=u.project_id ORDER BY u.created_at DESC LIMIT 100'),
    db.all('SELECT a.*, u.username AS author_name FROM announcements a LEFT JOIN users u ON u.id=a.author_id ORDER BY a.pinned DESC, a.created_at DESC LIMIT 30'),
    db.one('SELECT COUNT(*) AS c FROM users'),
    db.one('SELECT COUNT(DISTINCT user_id) AS c FROM reset_log WHERE reset_date=CURRENT_DATE'),
    db.one('SELECT SUM(total_resets) AS c FROM users'),
    db.one('SELECT COUNT(*) AS c FROM chat_messages WHERE deleted=false'),
    db.one("SELECT COUNT(*) AS c FROM bug_reports WHERE status='open'"),
  ]);

  const projects = projectsRaw.map(p => { const { luarmor_api_key, ...safe } = p; return safe; });
  const users = usersRaw.map(u => {
    const { luarmor_key, ...safe } = u;
    safe.key_prefix = u.luarmor_key ? u.luarmor_key.slice(0, 16) + '…' : '—';
    return safe;
  });

  const chatMessages = await db.all(`
    SELECT cm.id, cm.username, cm.role, cm.content, cm.image_url, cm.deleted, cm.created_at
    FROM chat_messages cm WHERE cm.deleted = false ORDER BY cm.created_at DESC LIMIT 50
  `);

  const bugReports = await db.all('SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT 100');

  res.render('admin', {
    projects, users, announcements,
    stats: { totalUsers: totalUsers.c, activeToday: activeToday.c, totalResets: totalResets.c || 0, chatMessages: chatCount.c, openBugs: openBugs.c },
    settings: { ...dynSettings },
    chatMessages: chatMessages.reverse(),
    bugReports,
    disableAds: true
  });
});

/* ─────────────────────────────────────
   ADMIN API — Projects CRUD
───────────────────────────────────── */
app.get('/api/admin/project/:id', apiAuth, adminApiOnly, async (req, res) => {
  const proj = await db.one('SELECT * FROM projects WHERE id=$1', [Number(req.params.id)]);
  if (!proj) return res.status(404).json({ success: false, message: 'Project not found.' });
  res.json({ success: true, project: proj });
});

app.get('/api/admin/user/:id', apiAuth, adminApiOnly, async (req, res) => {
  const user = await db.one(
    `SELECT u.id, u.username, u.luarmor_key, u.role, u.project_id, u.discord_id,
            u.note, u.is_active, u.is_verified_seller, u.total_resets, u.created_at, u.last_login,
            p.name AS project_name
     FROM users u LEFT JOIN projects p ON p.id=u.project_id
     WHERE u.id=$1`,
    [Number(req.params.id)]
  );
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user });
});

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

  const isFree = req.body.is_free === true || req.body.is_free === 'true';

  try {
    const proj = await db.one(`
      INSERT INTO projects (name,slug,luarmor_project_id,luarmor_api_key,color,gradient,icon,daily_reset_limit,description,is_free)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
    `, [name, slug, pid, pkey, color, grad, icon, limit, desc, isFree]);
    res.json({ success: true, id: proj.id, message: `Project "${name}" created.` });
  } catch (e) {
    res.json({ success: false, message: e.detail || e.message });
  }
});

app.patch('/api/admin/project/:id', apiAuth, adminApiOnly, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['name','luarmor_project_id','luarmor_api_key','color','gradient','icon','daily_reset_limit','description','is_active','sort_order','is_free'];
  const fields = []; const vals = []; let i = 1;
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let val = req.body[key];
    if (key === 'daily_reset_limit' || key === 'sort_order') val = Number(val);
    if (key === 'is_active' || key === 'is_free') val = val === true || val === 'true';
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

app.delete('/api/admin/project/:id/hard', apiAuth, adminApiOnly, async (req, res) => {
  const id = Number(req.params.id);
  // Unlink users from this project
  await db.query('UPDATE users SET project_id=NULL WHERE project_id=$1', [id]);
  // Delete project
  await db.query('DELETE FROM projects WHERE id=$1', [id]);
  res.json({ success: true, message: 'Project completely deleted.' });
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
  const allowed = ['role','project_id','discord_id','note','is_active','username','is_verified_seller'];
  const fields = []; const vals = []; let i = 1;
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    let val = req.body[key];
    if (key === 'role' && !['user','admin','mod'].includes(val)) continue;
    if (key === 'is_active' || key === 'is_verified_seller') val = val === true || val === 'true';
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
   ADMIN API — Live Sessions (all users)
───────────────────────────────────── */
app.get('/api/admin/live-sessions', apiAuth, adminApiOnly, async (_req, res) => {
  const sessions = await db.all(`
    SELECT ls.user_id, ls.roblox_user_id, ls.roblox_username,
           ls.place_id, ls.place_name, ls.job_id,
           ls.inventory, ls.last_seen,
           COALESCE(u.username, NULL) AS username,
           (ls.user_id IS NULL) AS is_guest
    FROM live_sessions ls
    LEFT JOIN users u ON u.id = ls.user_id
    WHERE ls.last_seen > NOW() - INTERVAL '35 seconds'
    ORDER BY is_guest ASC, COALESCE(u.username, ls.roblox_username) ASC, ls.last_seen DESC
  `);
  res.json({ sessions });
});

/* ─────────────────────────────────────
   ADMIN API — Stats
───────────────────────────────────── */
app.get('/api/admin/stats', apiAuth, adminApiOnly, async (_req, res) => {
  const [totalUsers, activeToday, totalResets, newToday, liveSessions] = await Promise.all([
    db.one('SELECT COUNT(*) AS c FROM users'),
    db.one('SELECT COUNT(DISTINCT user_id) AS c FROM reset_log WHERE reset_date=CURRENT_DATE'),
    db.one('SELECT SUM(total_resets) AS c FROM users'),
    db.one("SELECT COUNT(*) AS c FROM users WHERE created_at >= CURRENT_DATE"),
    db.one("SELECT COUNT(*) AS c FROM live_sessions WHERE last_seen > NOW() - INTERVAL '35 seconds'"),
  ]);
  res.json({ success: true, stats: {
    totalUsers:   Number(totalUsers.c),
    activeToday:  Number(activeToday.c),
    totalResets:  Number(totalResets.c || 0),
    newToday:     Number(newToday.c),
    liveNow:      Number(liveSessions.c),
  }});
});

/* ─────────────────────────────────────
   MOD API — User Actions
───────────────────────────────────── */
app.post('/api/mod/user/:id/reset-hwid', apiAuth, modOrAdminApi, async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.one('SELECT * FROM users WHERE id=$1', [id]);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  if (user.role === 'admin') return res.json({ success: false, message: 'Cannot reset admin HWID.' });
  
  const proj = user.project_id ? await db.one('SELECT * FROM projects WHERE id=$1', [user.project_id]) : null;
  if (!proj) return res.json({ success: false, message: 'User has no project assigned.' });
  
  const { json } = await luarmorReq('POST', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users/resethwid', { user_key: user.luarmor_key, force: true });
  res.json({ success: json?.success || false, message: json?.message || 'HWID Reset successful.' });
});

app.post('/api/mod/user/:id/blacklist', apiAuth, modOrAdminApi, async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.one('SELECT role FROM users WHERE id=$1', [id]);
  if (!user) return res.json({ success: false, message: 'User not found.' });
  if (user.role === 'admin') return res.json({ success: false, message: 'Cannot blacklist admin.' });
  
  await db.query('UPDATE users SET is_active=false WHERE id=$1', [id]);
  res.json({ success: true, message: 'User blacklisted.' });
});

app.post('/api/mod/user/:id/unblacklist', apiAuth, modOrAdminApi, async (req, res) => {
  const id = Number(req.params.id);
  await db.query('UPDATE users SET is_active=true WHERE id=$1', [id]);
  res.json({ success: true, message: 'User reinstated.' });
});

/* ─────────────────────────────────────
   ADMIN API — Bug Reports
───────────────────────────────────── */
app.patch('/api/admin/bug-reports/:id', apiAuth, adminApiOnly, async (req, res) => {
  const id = Number(req.params.id);
  const allowed = ['open','in_progress','resolved','wontfix'];
  const { status, admin_note } = req.body;
  const fields = []; const vals = []; let i = 1;
  if (status && allowed.includes(status)) { fields.push(`status=$${i++}`); vals.push(status); }
  if (admin_note !== undefined) { fields.push(`admin_note=$${i++}`); vals.push(String(admin_note).slice(0,512)); }
  if (!fields.length) return res.json({ success: false, message: 'Nothing to update.' });
  vals.push(id);
  await db.query(`UPDATE bug_reports SET ${fields.join(',')} WHERE id=$${i}`, vals);
  res.json({ success: true, message: 'Updated.' });
});

/* ─────────────────────────────────────
   SETTINGS API
───────────────────────────────────── */
app.get('/settings', auth, async (req, res) => {
  const dbUser = await db.one('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
  res.render('settings', { user: req.session.user, dbUser, page: 'settings', disableAds: true });
});

app.post('/api/settings', auth, async (req, res) => {
  const userId = req.session.user.id;
  const avatarUrl = (req.body.avatar_url || '').trim().slice(0, 500);
  const language = (req.body.language || 'en').trim().slice(0, 16);
  const discordId = (req.body.discord_id || '').trim().slice(0, 32);

  await db.query(
    'UPDATE users SET avatar_url=$1, language=$2, discord_id=$3 WHERE id=$4',
    [avatarUrl, language, discordId, userId]
  );
  req.session.user.discordId = discordId; // update session
  req.session.user.avatarUrl = avatarUrl;
  req.session.user.language  = language;
  res.json({ success: true, message: 'Settings saved' });
});

/* Self-service password change */
app.post('/api/user/change-password', auth, async (req, res) => {
  const userId = req.session.user.id;
  const pwd = (req.body.password || '').trim();
  if (pwd.length < 8) return res.json({ success: false, message: 'Password must be at least 8 characters.' });
  const hash = await bcrypt.hash(pwd, 12);
  await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
  res.json({ success: true, message: 'Password changed.' });
});

app.post('/api/user/check-free-key', auth, async (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ success: false, message: 'Key required.' });
  try {
    const found = await findProjectForKey(key);
    if (!found) return res.json({ success: false, message: 'Key not found in any active project.' });
    const { project, luaUser } = found;
    res.json({
      success: true,
      auth_expire: luaUser.auth_expire,
      project_name: project.name,
      status: luaUser.status,
      banned: luaUser.banned
    });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

/* ─────────────────────────────────────
   SHOP API
───────────────────────────────────── */
app.get('/shop', auth, async (req, res) => {
  const listings = await db.all(`
    SELECT sl.*, u.is_verified_seller 
    FROM shop_listings sl
    JOIN users u ON sl.user_id = u.id
    ORDER BY sl.created_at DESC
  `);
  res.render('shop', { user: req.session.user, page: 'shop', listings });
});

app.post('/api/shop/listing', auth, async (req, res) => {
  const { id: userId, username } = req.session.user;
  const title = (req.body.title || '').trim().slice(0, 128);
  const description = (req.body.description || '').trim().slice(0, 1000);
  const price = (req.body.price || 'Negotiable').trim().slice(0, 64);
  if (!title || !description) return res.json({ success: false, message: 'Title and description required' });
  await db.query(
    'INSERT INTO shop_listings (user_id, username, title, description, price) VALUES ($1,$2,$3,$4,$5)',
    [userId, username, title, description, price]
  );
  res.json({ success: true });
});

app.delete('/api/shop/listing/:id', auth, async (req, res) => {
  const listingId = Number(req.params.id);
  const { id: userId, role } = req.session.user;
  const listing = await db.one('SELECT user_id FROM shop_listings WHERE id=$1', [listingId]);
  if (!listing) return res.json({ success: false, message: 'Not found' });
  if (listing.user_id !== userId && role !== 'admin' && role !== 'mod') {
    return res.json({ success: false, message: 'Unauthorized' });
  }
  await db.query('DELETE FROM shop_listings WHERE id=$1', [listingId]);
  res.json({ success: true });
});

/* ─────────────────────────────────────
   PRIVATE CHAT API
───────────────────────────────────── */
app.get('/private-chats', auth, async (req, res) => {
  const userId = req.session.user.id;
  let chats;
  if (req.session.user.role === 'admin') {
    chats = await db.all(`
      SELECT pc.id, u1.username as u1_name, u2.username as u2_name, pc.created_at
      FROM private_chats pc
      JOIN users u1 ON pc.user1_id = u1.id
      JOIN users u2 ON pc.user2_id = u2.id
      ORDER BY pc.created_at DESC
    `);
  } else {
    chats = await db.all(`
      SELECT pc.id, 
             CASE WHEN pc.user1_id = $1 THEN u2.username ELSE u1.username END as other_user_name,
             pc.created_at
      FROM private_chats pc
      JOIN users u1 ON pc.user1_id = u1.id
      JOIN users u2 ON pc.user2_id = u2.id
      WHERE pc.user1_id = $1 OR pc.user2_id = $1
      ORDER BY pc.created_at DESC
    `, [userId]);
  }
  res.render('private_chats', { user: req.session.user, page: 'private_chats', chats });
});

app.post('/api/private-chat/start', auth, async (req, res) => {
  const { seller_id } = req.body;
  const user1 = Math.min(req.session.user.id, seller_id);
  const user2 = Math.max(req.session.user.id, seller_id);
  if (user1 === user2) return res.json({ success: false, message: 'Cannot chat with yourself' });
  
  let chat = await db.one('SELECT id FROM private_chats WHERE user1_id=$1 AND user2_id=$2', [user1, user2]);
  if (!chat) {
    chat = await db.one('INSERT INTO private_chats (user1_id, user2_id) VALUES ($1,$2) RETURNING id', [user1, user2]);
  }
  res.json({ success: true, chat_id: chat.id });
});

app.get('/private-chat/:id', auth, async (req, res) => {
  const chatId = Number(req.params.id);
  const userId = req.session.user.id;
  const role = req.session.user.role;
  
  const chat = await db.one('SELECT * FROM private_chats WHERE id=$1', [chatId]);
  if (!chat) return res.redirect('/private-chats');
  if (chat.user1_id !== userId && chat.user2_id !== userId && role !== 'admin') {
    return res.redirect('/private-chats');
  }
  
  const messages = await db.all(`
    SELECT pm.*, u.username 
    FROM private_messages pm
    JOIN users u ON pm.sender_id = u.id
    WHERE pm.chat_id=$1
    ORDER BY pm.created_at ASC
  `, [chatId]);
  
  const otherUserId = chat.user1_id === userId ? chat.user2_id : chat.user1_id;
  const otherUser = await db.one('SELECT username FROM users WHERE id=$1', [otherUserId]);
  const otherUserName = otherUser ? otherUser.username : 'Unknown';

  res.render('private_chat_view', { user: req.session.user, page: 'private_chats', chat, messages, otherUserName, otherUserId: otherUserId });
});

app.post('/api/private-chat/:id/message', auth, async (req, res) => {
  const chatId = Number(req.params.id);
  const userId = req.session.user.id;
  const content = (req.body.content || '').trim().slice(0, 1000);
  if (!content) return res.json({ success: false });
  
  const chat = await db.one('SELECT * FROM private_chats WHERE id=$1', [chatId]);
  if (!chat || (chat.user1_id !== userId && chat.user2_id !== userId && req.session.user.role !== 'admin')) {
    return res.json({ success: false, message: 'Unauthorized' });
  }
  
  await db.query(
    'INSERT INTO private_messages (chat_id, sender_id, content) VALUES ($1,$2,$3)',
    [chatId, userId, content]
  );
  res.json({ success: true });
});

/* ─────────────────────────────────────
   CHAT API
───────────────────────────────────── */

/* GET /api/chat/messages — last 80 messages */
app.get('/api/chat/messages', apiAuth, async (req, res) => {
  const before = req.query.before ? Number(req.query.before) : null;
  const sql = before
    ? `SELECT id, user_id, username, role, content, image_url, created_at
       FROM chat_messages WHERE deleted=false AND id < $1
       ORDER BY created_at DESC LIMIT 40`
    : `SELECT id, user_id, username, role, content, image_url, created_at
       FROM chat_messages WHERE deleted=false
       ORDER BY created_at DESC LIMIT 80`;
  const params = before ? [before] : [];
  const msgs = await db.all(sql, params);
  res.json({ success: true, messages: msgs.reverse() });
});

/* POST /api/chat/message — text message */
app.post('/api/chat/message', apiAuth, chatLimiter, async (req, res) => {
  const { id: userId, username, role } = req.session.user;
  const content = (req.body.content || '').trim().slice(0, 500);
  if (!content) return res.json({ success: false, message: 'Empty message.' });

  /* Basic XSS prevention — strip HTML tags */
  const safe = content.replace(/<[^>]*>/g, '');

  const msg = await db.one(
    `INSERT INTO chat_messages (user_id, username, role, content)
     VALUES ($1,$2,$3,$4) RETURNING id, user_id, username, role, content, image_url, created_at`,
    [userId, username, role, safe]
  );

  io.emit('chat_message', msg);
  res.json({ success: true, message: msg });
});

/* POST /api/chat/image — image upload */
app.post('/api/chat/image', apiAuth, chatLimiter, chatUpload.single('image'), async (req, res) => {
  if (!req.file) return res.json({ success: false, message: 'No valid image provided (max 4MB, jpg/png/gif/webp).' });

  const { id: userId, username, role } = req.session.user;
  const imageUrl = `/uploads/chat/${req.file.filename}`;
  let content = (req.body.content || '').trim().slice(0, 500);
  content = content.replace(/<[^>]*>/g, ''); // basic xss

  const msg = await db.one(
    `INSERT INTO chat_messages (user_id, username, role, content, image_url)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, user_id, username, role, content, image_url, created_at`,
    [userId, username, role, content, imageUrl]
  );

  io.emit('chat_message', msg);
  res.json({ success: true, message: msg });
});

/* DELETE /api/chat/message/:id — admin or own message */
app.delete('/api/chat/message/:id', apiAuth, async (req, res) => {
  const msgId = Number(req.params.id);
  const { id: userId, role } = req.session.user;

  const msg = await db.one('SELECT user_id FROM chat_messages WHERE id=$1', [msgId]);
  if (!msg) return res.json({ success: false, message: 'Message not found.' });

  if (role !== 'admin' && msg.user_id !== userId)
    return res.json({ success: false, message: 'Not allowed.' });

  await db.query('UPDATE chat_messages SET deleted=true WHERE id=$1', [msgId]);

  /* Delete image file if present */
  const fullMsg = await db.one('SELECT image_url FROM chat_messages WHERE id=$1', [msgId]);
  if (fullMsg?.image_url) {
    const filePath = path.join(__dirname, 'public', fullMsg.image_url);
    fs.unlink(filePath, () => {});
  }

  io.emit('chat_delete', { id: msgId });
  res.json({ success: true });
});

/* GET /api/chat/online — online users count */
app.get('/api/chat/online', apiAuth, (_req, res) => {
  res.json({ count: onlineUsers.size });
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

/* ─────────────────────────────────────
   USER KEYS
───────────────────────────────────── */
app.get('/api/user-keys', apiAuth, async (req, res) => {
  const rows = await db.all(`
    SELECT uk.id, uk.luarmor_key, uk.label, uk.created_at,
           p.name AS project_name, p.icon AS project_icon, p.color AS project_color,
           p.daily_reset_limit
    FROM user_keys uk LEFT JOIN projects p ON p.id = uk.project_id
    WHERE uk.user_id=$1 ORDER BY uk.created_at ASC
  `, [req.session.user.id]);
  res.json({ success: true, keys: rows });
});

app.post('/api/user-keys', apiAuth, apiLimiter, async (req, res) => {
  const { id } = req.session.user;
  const key   = (req.body.key   || '').trim();
  const label = (req.body.label || '').trim().slice(0, 64);
  if (!key || key.length < 6) return res.json({ success: false, message: 'Invalid key.' });

  const count = await db.one('SELECT COUNT(*) AS c FROM user_keys WHERE user_id=$1', [id]);
  if (Number(count.c) >= 10) return res.json({ success: false, message: 'Max 10 additional keys.' });

  const taken = await db.one(
    'SELECT id FROM users WHERE luarmor_key=$1 UNION SELECT id FROM user_keys WHERE luarmor_key=$1',
    [key]
  );
  if (taken) return res.json({ success: false, message: 'This key is already registered.' });

  const found = await findProjectForKey(key);
  if (!found) return res.json({ success: false, message: 'Key not found in any active project.' });
  const { project } = found;

  await db.query(
    'INSERT INTO user_keys (user_id, luarmor_key, project_id, label) VALUES ($1,$2,$3,$4)',
    [id, key, project.id, label || project.name]
  );
  res.json({ success: true, message: `Key added (${project.name}).`, project_name: project.name, project_icon: project.icon, project_color: project.color });
});

app.delete('/api/user-keys/:id', apiAuth, async (req, res) => {
  const keyId = Number(req.params.id);
  const r = await db.query('DELETE FROM user_keys WHERE id=$1 AND user_id=$2', [keyId, req.session.user.id]);
  if (r.rowCount === 0) return res.json({ success: false, message: 'Key not found.' });
  res.json({ success: true });
});

app.post('/api/reset-hwid-extra', apiAuth, apiLimiter, async (req, res) => {
  const { id } = req.session.user;
  const keyId  = Number(req.body.key_id);
  if (!keyId) return res.json({ success: false, message: 'key_id required.' });

  const ukRow = await db.one('SELECT * FROM user_keys WHERE id=$1 AND user_id=$2', [keyId, id]);
  if (!ukRow) return res.json({ success: false, message: 'Key not found.' });

  const proj = ukRow.project_id ? await db.one('SELECT * FROM projects WHERE id=$1', [ukRow.project_id]) : null;
  if (!proj) return res.json({ success: false, message: 'No project for this key.' });

  const { json } = await luarmorReq('POST', proj.luarmor_project_id, proj.luarmor_api_key,
    '/users/resethwid', { user_key: ukRow.luarmor_key, force: true });
  res.json({ success: json?.success || false, message: json?.message || 'Done.' });
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

app.post('/api/kick-session', apiAuth, async (req, res) => {
  const robloxUserId = (req.body.roblox_user_id || '').trim();
  if (!robloxUserId) return res.json({ success: false, message: 'Missing roblox_user_id.' });
  const { id, role } = req.session.user;
  const where = role === 'admin'
    ? 'roblox_user_id=$1'
    : 'roblox_user_id=$1 AND user_id=$2';
  const params = role === 'admin' ? [robloxUserId] : [robloxUserId, id];
  const r = await db.query(`UPDATE live_sessions SET kick_requested=true WHERE ${where}`, params);
  if (r.rowCount === 0) return res.json({ success: false, message: 'Session not found.' });
  res.json({ success: true });
});

app.get('/api/live-status', apiAuth, async (req, res) => {
  const sessions = await db.all(`
    SELECT roblox_username, roblox_user_id, place_name, place_id, inventory, last_seen
    FROM live_sessions
    WHERE user_id=$1 AND last_seen > NOW() - INTERVAL '35 seconds'
    ORDER BY last_seen DESC
  `, [req.session.user.id]);
  res.json({ online: sessions.length > 0, sessions });
});

/* ─────────────────────────────────────
   HEARTBEAT — called from Roblox executor
───────────────────────────────────── */
const heartbeatLimiter = rateLimit({ windowMs: 60*1000, max: 240,
  handler: (_req, res) => res.status(429).json({ ok: false }) });

app.get('/api/heartbeat', heartbeatLimiter, async (req, res) => {
  const rn = (req.query.rn || '').slice(0, 64);
  const ri = (req.query.ri || '').slice(0, 32);
  const pi = (req.query.pi || '').slice(0, 32);
  const pn = (req.query.pn || '').slice(0, 128);
  const ji = (req.query.ji || '').slice(0, 64);

  const robloxId = (ri || '').trim();
  if (!robloxId) return res.status(400).json({ ok: false });

  const key = (req.query.key || '').trim();
  let userId = null;
  if (key && key.length >= 6) {
    const dbUser = await db.one('SELECT id FROM users WHERE luarmor_key=$1', [key]);
    if (dbUser) userId = dbUser.id;
  }

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

  const existing = await db.one(
    'SELECT kick_requested FROM live_sessions WHERE roblox_user_id=$1',
    [robloxId]
  );
  const shouldKick = !!(existing && existing.kick_requested);

  await db.query(`
    INSERT INTO live_sessions (roblox_user_id, roblox_username, user_id, place_id, place_name, job_id, inventory, kick_requested, last_seen)
    VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW())
    ON CONFLICT (roblox_user_id) DO UPDATE SET
      roblox_username=$2,
      user_id=COALESCE($3, live_sessions.user_id),
      place_id=$4, place_name=$5, job_id=$6,
      inventory=$7, kick_requested=false, last_seen=NOW()
  `, [robloxId, rn, userId, pi, pn, ji, JSON.stringify(inventory)]);

  res.json({ ok: true, kick: shouldKick });
});

app.get('/api/offline', heartbeatLimiter, async (req, res) => {
  const ri = (req.query.ri || '').slice(0, 32).trim();
  if (!ri) return res.status(400).json({ ok: false });
  await db.query('DELETE FROM live_sessions WHERE roblox_user_id=$1', [ri]);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok:true, ts: Date.now() }));
app.use((req, res) => res.status(404).render('404'));
app.use((err, req, res, next) => { console.error(err); res.status(500).render('error', { message:'Internal server error.' }); });

/* ─── Boot ─── */
async function main() {
  await initDB();
  await loadSettings();
  server.listen(PORT, async () => {
    console.log(`\n✅ ${dynSettings.panel_name || PANEL_NAME} running on port ${PORT}`);
    console.log(`🔗 Discord: ${dynSettings.discord_url || DISCORD_URL}`);
    console.log(`💾 Sessions: PostgreSQL (persistent)`);
    console.log(`💬 Chat: Socket.io enabled`);
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
