# HomeHub Implementation Plan

Each phase is independently deployable and testable. Later phases build on earlier ones.

---

## Phase 1 — Project Bootstrap ✅

**Goal:** Running Docker Compose skeleton with all services defined but minimal logic.

### Tasks

- [x] Initialize pnpm workspace monorepo (`pnpm-workspace.yaml`)
- [x] Create `packages/backend`, `packages/mcp-server`, `packages/frontend`, `packages/scheduler`
- [x] Write `docker-compose.yml` with all 6 services (frontend, backend, mcp-server, scheduler, ollama, tailscale)
- [x] Write `docker-compose.override.yml` for local dev (volume mounts, hot reload)
- [x] Write `.env.example` with all required environment variables
- [x] Create `/data` volume directory structure
- [x] Dockerfile for each Node.js service (`node:24-alpine`)
- [x] Nginx config for the Angular frontend container
- [x] Health check endpoints on backend (`GET /health`) and mcp-server
- [x] Verify all containers start and communicate on the internal Docker network

### Notes
- `tplink-smarthome-api` latest is v5.0.0 (not 7.x) — version corrected in backend package.json
- Tailscale service uses Docker `profile: remote-access` — opt-in with `--profile remote-access`
- Frontend serves a static placeholder page until Angular is scaffolded in Phase 4
- mcp-server existing scaffold moved from repo root into `packages/mcp-server/`

### Deliverable ✅

`docker compose config` validates clean. All 3 Node.js packages typecheck with zero errors.

---

## Phase 2 — Backend: Kasa Device Layer ✅

**Goal:** Discover and control Kasa plugs from the backend. No UI yet.

### Tasks

- [x] Install `tplink-smarthome-api` in backend (v5.0.0 — latest available)
- [x] `KasaService` (`src/kasa/kasa.service.ts`):
  - `discoverDevices(timeoutMs)` — UDP broadcast, returns `DiscoveredDevice[]`
  - `setPowerState(ip, state)` — toggle relay
  - `getEnergyMetrics(ip)` — returns normalized `{ wattage, voltage, current }` (null if no emeter)
  - `getPowerState(ip)` — returns current on/off
- [x] SQLite DB (`src/db/index.ts`) — WAL mode, foreign keys, auto-migration on startup
- [x] Device alias management — `devices` table with alias, ip, model, has_emeter
- [x] In-memory state cache with configurable polling (`src/kasa/device.cache.ts`)
- [x] REST endpoints: `GET/POST/PATCH/DELETE /api/devices`, `POST /api/devices/:id/on|off`, `GET /api/devices/:id/energy`, `GET /api/devices/energy/summary`, `POST /api/devices/discover`
- [ ] Unit tests for KasaService with mock TCP responses (deferred — no test runner set up yet)

### Notes
- `tplink-smarthome-api` v5 emits `AnyDevice` (Plug | Bulb) on discovery — typed accordingly
- Emeter normalises both v1 (`power`, `voltage`) and v2 (`power_mw`, `voltage_mv`) response formats
- Poll interval defaults to 30s, controlled by `ENERGY_POLL_INTERVAL_SECONDS` env var

### Deliverable ✅

`curl http://localhost:3000/api/devices` returns list of plugs with cached state.
`curl -X POST http://localhost:3000/api/devices/living-room/on` toggles the plug.

---

## Phase 3 — Backend: Auth + Users ✅

**Goal:** Secure all API endpoints. Create household accounts.

### Tasks

- [x] `jsonwebtoken`, `bcrypt`, `cookie-parser` — already in package.json from Phase 1
- [x] SQLite `users` table added to DB migration (`db/index.ts`)
- [x] `AuthService` (`auth/auth.service.ts`):
  - `createUser`, `validateCredentials`, `listUsers`, `updatePassword`, `deleteUser`
  - `issueTokens` — access JWT (15m) + refresh JWT (7d)
  - `verifyAccessToken` / `verifyRefreshToken`
  - `seedAdminIfEmpty` — creates default admin from env vars on first boot
- [x] `POST /api/auth/login` — returns access token in body, refresh token in `httpOnly` cookie
- [x] `POST /api/auth/refresh` — reads cookie, rotates refresh token, returns new access token
- [x] `POST /api/auth/logout` — clears cookie
- [x] `authenticate` middleware — verifies Bearer token, attaches `req.user`
- [x] `requireAdmin` middleware — 403 if role is not admin
- [x] All `/api/*` routes protected; `/api/auth/*` and `/health` are public
- [x] `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id/password`, `DELETE /api/users/:id`

### Smoke test results ✅
- `GET /health` → 200 public ✓
- `POST /api/auth/login` correct creds → 200 + JWT ✓
- `POST /api/auth/login` wrong password → 401 ✓
- `GET /api/devices` no token → 401 ✓
- `GET /api/devices` valid token → 200 `[]` ✓
- `GET /api/users` admin token → 200 user list ✓

### Deliverable ✅

All API routes require valid JWT. Default admin seeded on first boot.

---

## Phase 4 — Frontend: Dashboard + Auth ✅

**Goal:** Angular UI with login, live plug dashboard, and toggle controls.

### Tasks

- [ ] Create Angular v21 app in `packages/frontend` (`ng new`)
- [ ] Configure standalone components, signals-based state
- [ ] `AuthService` (Angular) — login, logout, token refresh, route guards
- [ ] Login page — username/password form, stores JWT, redirects to dashboard
- [ ] `DeviceService` — HTTP calls to backend, Socket.io connection for live state
- [ ] Dashboard page:
  - Plug tile component — shows alias, on/off state, live wattage
  - Toggle button with optimistic UI update
  - Real-time updates via Socket.io (no polling)
- [ ] Install and configure Socket.io on backend; broadcast state changes on every toggle
- [ ] `HttpInterceptor` — attaches JWT to every outbound request, handles 401 → refresh flow
- [ ] Mobile-responsive layout (CSS Grid, Angular CDK breakpoints)
- [ ] Nginx config: serve Angular build, proxy `/api` and `/socket.io` to backend

### Deliverable

Open browser → login → see all plugs → click to toggle → state updates instantly across all open tabs.

---

## Phase 5 — Scheduler: Cron + Solar Automation ✅

**Goal:** Create and persist time-based and solar-event-based schedules.

### Tasks

- [ ] Install `node-cron`, `suncalc` in scheduler package
- [ ] SQLite `schedules` table — id, device_id, trigger_type, trigger_value, solar_event, solar_offset_minutes, state, enabled, label
- [ ] `SchedulerService`:
  - `loadSchedules()` — read all enabled schedules from DB on startup, register cron jobs
  - `addSchedule(schedule)` — write to DB, register cron job
  - `removeSchedule(id)` — cancel cron job, delete from DB
  - `enableSchedule(id)` / `disableSchedule(id)`
- [ ] Solar schedule engine:
  - `midnight` cron fires daily → calls `suncalc.getTimes(new Date(), lat, lon)`
  - For each solar-type schedule, compute today's event time → register one-shot cron
  - Supports events: `sunrise`, `sunset`, `dusk`, `dawn`, `goldenHour`, `solarNoon`
  - Supports `offset_minutes` (e.g. `sunset - 30min`)
- [ ] Scheduler exposes REST: `GET /schedules`, `POST /schedules`, `DELETE /schedules/:id`, `PATCH /schedules/:id/toggle`
- [ ] Backend proxies schedule routes to scheduler service (or scheduler calls backend API)
- [ ] Frontend Schedules page:
  - List view with enable/disable toggle per schedule
  - Create form: pick device, trigger type (cron | solar event), time or event + offset, on/off action, label
  - Human-readable next-run display

### Deliverable

Create schedule "turn on porch at sunset" → next evening, plug turns on automatically.

---

## Phase 6 — Natural Language (Ollama + Tool Calling) ✅

**Goal:** Household members can type plain English commands to control plugs and schedules.

### Tasks

- [x] Pull Ollama model on container start: `llama3.2:3b` (default, configurable via env `OLLAMA_MODEL`)
- [x] Backend `NlpService` (`src/nlp/nlp.service.ts`):
  - Tools: `list_devices`, `set_power_state`, `get_energy_metrics`, `create_schedule`, `list_schedules`, `delete_schedule`, `get_sunrise_sunset`
  - `processMessage(userMessage, history)` — sends messages + tools to Ollama, loops on tool calls (max 6 iterations)
  - Tool execution: maps Ollama tool calls to DB/Kasa services; emits socket events on state change
  - Returns `{ response: string, actions: ActionTaken[] }`
- [x] `POST /api/nlp` — accepts `{ message, history[] }`, returns JSON (non-streaming)
- [x] Frontend Chat page (`features/chat/chat.component.ts`):
  - Signal-based state, animated typing indicator
  - Chat bubbles with user/assistant avatars
  - Action chips below assistant messages (e.g. "Turned off: Living Room Lamp")
  - Suggestion buttons shown when history is empty
  - Last 10 history entries passed for conversational continuity
  - Auto-scrolls to latest message
- [x] `/chat` route wired in `app.routes.ts`, nav link added to dashboard topbar
- [x] `suncalc` + `@types/suncalc` added to backend package.json

### Deliverable

Type "turn off everything at midnight" → Ollama creates cron schedules for all devices.
Type "which lights are on right now?" → Ollama calls get_all_states, responds naturally.

---

## Phase 7 — MCP Server ✅

**Goal:** Expose HomeHub as an MCP server for external AI agents (Claude Desktop, Cursor, etc.).

### Tasks

- [x] `@modelcontextprotocol/sdk` already in mcp-server package (pre-installed in scaffold)
- [x] Transport: `StreamableHTTPServerTransport` with per-session server instances
- [x] `src/services/backend.service.ts` — HTTP client with auto-login + 401 retry
- [x] `src/tools/homehub-tools.ts` — 8 tools registered via `registerHomeHubTools()`:
  - `list_devices`, `get_all_states`, `set_power_state`, `get_energy_metrics`
  - `create_schedule`, `delete_schedule`, `list_schedules`, `get_sunrise_sunset`
- [x] `src/mcp-server.ts` updated with HomeHub tool registration + system instructions
- [x] MCP auth: `Authorization: Bearer <MCP_SECRET>` middleware on `/mcp` (disabled if `MCP_SECRET` unset)
- [x] `suncalc` added to mcp-server deps for solar times tool
- [x] `docs/mcp-connection.md` — Claude Desktop config snippets for local and Tailscale access

### Deliverable

Add HomeHub MCP server to Claude Desktop config → Claude can turn plugs on/off and create schedules from conversation.

---

## Phase 8 — Energy Monitoring + History ✅

**Goal:** Track and visualize power consumption over time.

### Tasks

- [x] `device.cache.ts` — writes `energy_readings` row on every poll cycle for emeter devices; emits `device:energy` socket event
- [x] Daily prune: `DELETE WHERE recorded_at < -90 days`, runs on startup + every 24h
- [x] `src/routes/energy.ts` — `GET /api/devices/:id/energy/history?range=24h|7d|30d`; time-bucketed averages (1h / 6h / 1d buckets)
- [x] Frontend Energy page (`features/energy/energy.component.ts`):
  - Inline SVG line charts (no extra deps) with area fill, y-axis tick labels, x-axis time labels
  - 24h / 7d / 30d range selector
  - Summary cards: live total draw, device count, estimated monthly cost (reads `kwhRate` from localStorage)
  - "Energy" nav link in dashboard topbar

### Deliverable

Energy page shows wattage over time per plug. Dashboard shows live total household wattage.

---

## Phase 9 — Remote Access (Tailscale / Headscale) ✅

**Goal:** Secure remote access for household members outside the home, with no cloud dependency.

### Tasks

**Option A — Tailscale (simpler):**
- [x] `tailscale/tailscale` container already in `docker-compose.yml` with `profiles: remote-access`
- [x] `TS_AUTHKEY` configured via env var, `TS_EXTRA_ARGS=--advertise-tags=tag:homehub`
- [x] `docs/REMOTE_ACCESS.md` — step-by-step Tailscale setup, ACL config, member onboarding

**Option B — Headscale (fully self-hosted):**
- [x] `docs/REMOTE_ACCESS.md` — full Headscale docker-compose snippet, config.yaml, user + preauthkey creation, client setup

**Common:**
- [x] JWT auth enforced over tailnet regardless of Tailscale encryption (defense in depth)
- [x] Member onboarding: install Tailscale, join tailnet, admin creates HomeHub account, add to phone home screen

### Deliverable

Household member on mobile outside home → Tailscale active → opens browser to Pi tailnet IP → logs in → controls plugs.

---

## Phase 10 — Polish + Hardening ✅

**Goal:** Production-ready on Raspberry Pi. Reliable, observable, and easy to maintain.

### Tasks

- [x] `src/env.ts` — validates required env vars on startup, exits with a clear error if missing or still set to placeholder values
- [x] Graceful shutdown: backend (SIGTERM → close HTTP server), scheduler (SIGTERM → clearAll), mcp-server (SIGTERM → close HTTP server)
- [x] Docker health checks: all services already had health checks from Phase 1
- [x] Log rotation: Docker `json-file` driver with `max-size: 10m` / `max-file: 5` on all services (YAML anchor `&default-logging` for DRY config)
- [x] Ollama model pull: already in docker-compose `command` block from Phase 1
- [x] SQLite WAL mode: already in `db/index.ts` from Phase 2
- [x] `src/db/backup.ts` — copies DB to `/data/backups/db-YYYY-MM-DD.sqlite`, keeps last 7 days, runs on startup + daily
- [x] PWA: `public/manifest.webmanifest` (name, icons, shortcuts), `public/sw.js` (app-shell cache-first, network-pass-through for /api and /socket.io), `src/index.html` updated with manifest link + Apple meta tags, SW registered in `main.ts`
- [x] Settings page (`features/settings/settings.component.ts`): device list with alias/IP editing, discovery trigger, user management (add/delete/change-password, admin only), kWh rate preference (localStorage)
- [x] `/settings` route + "Settings" nav link in dashboard topbar
- [x] `docs/GETTING_STARTED.md` updated throughout the project

### Deliverable

Production-grade deployment. `docker compose up -d` on a fresh Pi → everything works. Household members have the app on their phone home screens.

---

## Phase 11 — Setup Without a Technical Helper

**Goal:** someone who has never used a terminal can set up HomeHub, add their devices and get their family on it, without help.

**Already in place:** the one-line installer, account creation in the browser, generated secrets, device discovery, nightly backups with download, upload and restore in Settings, and one-tap updates from the dashboard.

Work in this order:

### 11a — First-run wizard ✅

Replaces landing on an empty dashboard with a setup notice.

- [x] **Your home:** take the time zone from the browser, and find the location from a town or postcode. Nobody types coordinates.
- [x] **Find devices:** scan automatically and list what was found by brand. "Add all" adds them in one tap; each can still be skipped.
- [x] **Name and group:** suggest a name and room for each device. The admin accepts or edits them.
- [x] **Starter automations:** offer optional examples, such as "lights on at sunset, off at 11 PM" and "porch light off in the morning". Each is one tap.
- [x] **Invite family:** show a QR code that creates a family login on their phone, with "Add to Home Screen" steps.
- [x] It can be skipped or resumed, and opened again later from Settings.

### 11b — Guided cloud brands

- [ ] A card for each brand (Wyze, Meross, Tuya) that says what it needs, where to find it, and has a **Test** button that answers in plain words.
- [ ] Tuya local keys: fetch them automatically if possible, otherwise give step-by-step help. Recommend local-control brands when buying.

### 11c — Looks after itself

- [ ] A plain-language health page, for example "Living room lamp hasn't answered since 3 PM. Is it plugged in?". No logs.
- [ ] If an update doesn't start, go back to the previous version automatically.
- [ ] Moving to new hardware: restore a backup during first-run setup.

### 11d — Ready-to-flash image

- [ ] A Raspberry Pi Imager image: choose HomeHub, enter Wi-Fi in Imager, plug in, then open `homehub.local` on a phone.
- [ ] A build pipeline for the image in GitHub Actions, with checksums for each release.

### 11e — Away from home

- [ ] A guided remote-access flow: install Tailscale on the phone, sign in, then scan a code. HomeHub handles its own side.

### 11f — Test with someone who isn't the developer

- [ ] Give a fresh Pi to a non-technical person and watch the setup without helping. Every point where they hesitate becomes a task here. Repeat after each of 11a–11d.

### Deliverable

A non-technical household goes from unboxing to family members controlling lights on their phones in under 30 minutes, with no terminal and no outside help.

---

## Phase 12 — Matter

**Goal:** most new smart plugs, lights and switches work with HomeHub, whatever the brand.

- [x] matter.js 0.18 as a controller inside the backend, loaded only when a home has Matter devices
- [x] Pairing by code, shared from Google Home, Apple Home, Alexa or SmartThings (multi-admin)
- [x] Each on/off endpoint becomes a HomeHub device, including power-strip outlets and bridged devices
- [x] Live state from subscriptions, so outside changes appear immediately and are recorded as such
- [x] Pairing data in SQLite (`matter_storage`), so backups and restores carry it; backup before a matter.js version change
- [x] Unpair on delete; HomeHub shown as "HomeHub" in other apps
- [ ] Dimming and colour (LevelControl, ColorControl)
- [ ] Energy readings from plugs that report them (ElectricalPowerMeasurement)
- [ ] Sensors: contact, motion, leak, temperature
- [ ] Commissioning brand-new devices over Bluetooth, where the host has a usable adapter
- [ ] Try with real devices from several brands

---

## Dependency Graph

```
Phase 1 (Bootstrap)
  └── Phase 2 (Kasa Layer)
        └── Phase 3 (Auth)
              └── Phase 4 (Frontend Dashboard)
                    ├── Phase 5 (Scheduler)
                    │     └── Phase 6 (NLP / Ollama)
                    │           └── Phase 7 (MCP Server)
                    └── Phase 8 (Energy Monitoring)
  Phase 9 (Remote Access) — can be done after Phase 4, independent of 5-8
  Phase 10 (Polish) — final, depends on all above
```

---

## Environment Variables Reference

```env
# Backend
NODE_ENV=production
PORT=3000
JWT_SECRET=<strong-random-secret>
JWT_REFRESH_SECRET=<strong-random-secret>
ADMIN_USER=admin
ADMIN_PASSWORD=<initial-admin-password>
DB_PATH=/data/db.sqlite

# Location (for solar scheduling)
LATITUDE=37.7749
LONGITUDE=-122.4194

# Ollama
OLLAMA_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2:3b

# MCP Server
MCP_SECRET=<strong-random-secret>

# Tailscale (Option A)
TS_AUTHKEY=<tailscale-auth-key>

# Headscale (Option B)
HEADSCALE_URL=http://headscale:8080
```
