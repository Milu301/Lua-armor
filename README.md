# 🔑 Luarmor Panel v2

A modern, dark-themed web dashboard for Luarmor script key management. Users sign in with their key, can reset their HWID, view account info, link their Discord, and set custom notes.

## ✨ Features

- **Secure login** with Luarmor key (verified live via API)
- **HWID Reset** with configurable daily limit
- **Key details** — status, expiry, executions, HWID, Discord link
- **Link Discord** from the dashboard
- **Custom note** editor (syncs to Luarmor)
- **IP Whitelist Guide** — built-in page to get your server's outbound IP and steps to whitelist it in Luarmor
- Rate limiting, Helmet.js security, session management

---

## 🚀 Deploy on Railway

### Step 1 — Push to GitHub

```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/YOUR/repo.git
git push -u origin main
```

### Step 2 — Create Railway project

Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → select your repo.

### Step 3 — Add environment variables

In Railway → your service → **Variables**:

| Variable | Required | Description |
|---|---|---|
| `LUARMOR_API_KEY` | ✅ | From luarmor.net/profile |
| `LUARMOR_PROJECT_ID` | ✅ | From luarmor.net/projects |
| `SESSION_SECRET` | ✅ | Any long random string (32+ chars) |
| `DAILY_RESET_LIMIT` | ➖ | Resets per day (default: `3`) |
| `PANEL_NAME` | ➖ | Display name (default: `AuroraHud`) |
| `ACCENT_COLOR` | ➖ | Hex color without # (default: `8b5cf6`) |
| `NODE_ENV` | ➖ | Set to `production` for secure cookies |

### Step 4 — Whitelist your Railway IP in Luarmor ⚠️

**This is the most important step.** Without it, Luarmor blocks all API calls.

1. After your first deploy, go to your panel URL → **Whitelist IP Guide** (sidebar)
2. Click **Refresh IP** to detect the current outbound IP
3. Copy it and go to [luarmor.net/profile](https://luarmor.net/profile)
4. Paste it in **"Whitelisted IPs for API access"** and save

**On Railway Hobby plan:** The IP may change on redeploy. Re-do step 3-4 if it stops working.
**On Railway Pro plan:** Go to Settings → Networking → Enable Static IPs → whitelist that IP once and never again.

---

## ⚙️ Local development

```bash
cp .env.example .env   # fill in your values
npm install
node server.js
```

Open [http://localhost:3000](http://localhost:3000)

> For local dev you need to whitelist your home/office IP in Luarmor too.

---

## 📁 File structure

```
luarmor-panel/
├── server.js              # Express app, all routes + API logic
├── package.json
├── railway.toml
├── .env.example
├── public/
│   └── css/style.css      # All styles
└── views/
    ├── login.ejs           # Login page
    ├── dashboard.ejs       # Main panel
    ├── ipinfo.ejs          # IP whitelist guide
    ├── 404.ejs
    ├── error.ejs
    └── partials/
        ├── head.ejs
        └── sidebar.ejs
```

---

## 🔒 Security notes

- Keys are never stored in plaintext — only in an encrypted session cookie
- Sessions use `httpOnly`, `sameSite: lax`, and `secure` in production
- Login: 12 attempts / 15 min rate limit
- API endpoints: 40 requests / min rate limit
- Helmet.js with strict Content Security Policy

---

## 🎨 Customization

| What | How |
|---|---|
| Brand color | `ACCENT_COLOR` env var (hex without #) |
| Panel name | `PANEL_NAME` env var |
| Daily reset limit | `DAILY_RESET_LIMIT` env var |
| Styles | Edit `public/css/style.css` |
