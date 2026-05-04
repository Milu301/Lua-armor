# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Run locally (requires .env)
node server.js

# Run with auto-reload during development
npm run dev          # uses nodemon

# Generate a SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

No test suite or linter is configured. There is no build step — it's plain Node.js served directly.

## Architecture

Single-file Express app (`server.js`) with EJS templates. No separate router files — all routes are defined inline in `server.js`. PostgreSQL via `pg` pool with a hand-rolled `db` helper (`db.query`, `db.one`, `db.all`). No ORM.

### Core data flow

1. User registers with an AuroraSafe key → server calls AuroraSafe API to verify the key and detect which script/project it belongs to → user row created in DB with `project_id`
2. On login, a session is created with: `{ id, username, role, luarmorKey, projectId, discordId, scriptToken }`
3. Dashboard route fetches fresh data from AuroraSafe API on every page load (`getLuaKey()`) — there is no local caching of AuroraSafe key state

### Multi-project model

Up to 10 projects are configured via `SCRIPT_N_*` env vars. Each project maps to an AuroraSafe script via `script_id`. When a user registers, `findScriptForKey()` searches all scripts via AuroraSafe API to find which script the key belongs to. All AuroraSafe API calls go through `safeReq()` using the master `AURORASAFE_API_KEY`.

### Live sessions (Roblox integration)

`/api/heartbeat` — called by the Roblox script every ~8 seconds with query params (`rn`, `ri`, `pi`, `pn`, `ji`, `inv`). Upserts a row in `live_sessions`. Rows expire after 35 seconds of no heartbeat (filtered in queries with `last_seen > NOW() - INTERVAL '35 seconds'`). The `kick` field in the response tells the Roblox script to disconnect. `/api/offline` deletes the session row on disconnect.

### HWID Reset quota

Stored in `reset_log(user_id, reset_date, reset_count)`. Resets to 0 daily at midnight UTC (date-keyed rows). Daily limit comes from the user's project's `daily_reset_limit` column.

### Auth middleware

- `auth` — redirects to `/login` if no session (page routes)
- `apiAuth` — returns 401 JSON if no session (API routes)
- `adminOnly` — checks `req.session.user.role === 'admin'`, renders error page
- `adminApiOnly` — same but returns 403 JSON

### DB schema (all created in `initDB()` on startup)

- `projects` — tiers/plans, each mapped to an AuroraSafe script via `script_id`
- `users` — panel accounts, linked to a project; `script_token` used by Roblox integration
- `user_keys` — extra AuroraSafe keys a user can add beyond their primary key
- `reset_log` — daily HWID reset counter per user
- `live_sessions` — ephemeral Roblox session rows (35s TTL, no migration needed)
- `announcements` — admin-posted messages shown on dashboard
- `session` — connect-pg-simple session table
- `settings` — key/value store for panel branding overrides (editable from admin UI)

### Security rules to maintain

- `luarmor_key` for users must **never** be embedded in bulk HTML (e.g. `data-search`, `onclick`). Fetch via `GET /api/admin/user/:id`.
- `password_hash` and `script_token` must be stripped before passing `dbUser` to any template. The dashboard route already does this with destructuring.
- All admin API endpoints must use both `apiAuth` and `adminApiOnly` middleware.
- Every response carries `X-Robots-Tag: noindex` — do not remove it.

## Deployment

Deployed on Railway. `railway.toml` sets `startCommand = "node server.js"` and health check at `/health`.

## Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Express session signing key (32+ chars) |
| `AURORASAFE_API_URL` | URL of AuroraSafe backend API |
| `AURORASAFE_API_KEY` | AuroraSafe API key for admin access |
| `SCRIPT_N_NAME` / `SCRIPT_N_ID` | Per-project script mapping (N = 1–10) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Auto-created admin account on first boot |
| `NODE_ENV=production` | Enables `secure` cookies over HTTPS |

Projects are seeded from env vars on every startup (`initDB()`). Changing a project's env vars and redeploying updates it in the DB via `ON CONFLICT DO UPDATE`.

## Views

All templates are EJS in `views/`. `views/partials/head.ejs` includes the CSS link, global JS (ripple, scroll-reveal, IntersectionObserver), and the scroll progress bar. `views/partials/sidebar.ejs` renders for all authenticated pages. Styles are all in `public/css/style.css` (single file, ~3200+ lines).
