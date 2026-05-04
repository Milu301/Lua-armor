# 🔑 AuroraSafe Panel v5

A modern, dark-themed web dashboard for AuroraSafe script key management. Users sign in with their key, can reset their HWID, view account info, link their Discord, and set custom notes.

## ✨ Features

- **Secure login** with AuroraSafe key (verified live via API)
- **Dashboard** with live key status, executions, reset quota
- **HWID Reset** with quota tracking and ring progress UI
- **Live Sessions** — see Roblox accounts executing in real time
- **Multi-key manager** — add and manage multiple keys
- **Discord integration** — OAuth2 login and account linking
- **Global chat** — real-time chat between all panel users
- **Custom note** editor (syncs to AuroraSafe)
- **Admin panel** — manage users, settings, announcements
- **Bold Payments** — built-in payment processing for key delivery

## 🚀 Quick Start

### Step 1 — Clone and install

```bash
npm install
```

### Step 2 — Configure environment

Copy `.env.example` to `.env` and fill in your values. The critical ones:

| Variable | Required? | Source |
|---|---|---|
| `DATABASE_URL` | ✅ | Railway PostgreSQL URL |
| `SESSION_SECRET` | ✅ | Generate via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `AURORASAFE_API_URL` | ✅ | Your AuroraSafe backend URL |
| `AURORASAFE_API_KEY` | ✅ | From AuroraSafe admin > Settings > API Keys |
| `DISCORD_CLIENT_ID` | ✅ (for OAuth) | From Discord Developer Portal |
| `DISCORD_CLIENT_SECRET` | ✅ (for OAuth) | From Discord Developer Portal |
| `SCRIPT_N_NAME` / `SCRIPT_N_ID` | ✅ | Per-project script mapping |

### Step 3 — Deploy to Railway

Use `railway.toml` for automatic deployment:
- Start: `node server.js`
- Health check: `/health`

### Step 4 — Connect to AuroraSafe

This panel connects to your private AuroraSafe backend for:
- Key validation and generation
- Script protection and obfuscation  
- HWID management
- Gateway/ad delivery

Make sure `AURORASAFE_API_URL` points to your AuroraSafe backend URL.

## 📁 Project Structure

```
aurorasafe-panel/
├── server.js         # Main Express app (all routes)
├── public/
│   ├── css/style.css # Design system
│   └── js/           # Client-side JS
├── views/
│   ├── partials/     # head.ejs, sidebar.ejs
│   ├── dashboard.ejs # Main dashboard
│   ├── login.ejs     # Auth pages
│   ├── register.ejs
│   └── admin.ejs     # Admin panel
└── .env              # Environment configuration
```

## 🔒 Security

- All API keys are validated server-side only
- Keys are never exposed in client HTML (fetched via secure API)
- Session-based auth with secure, httpOnly cookies
- XSS protection, rate limiting, input validation
- Anti-source-view (right-click disabled, DevTools detection)

## 📄 License

Private — All rights reserved.
