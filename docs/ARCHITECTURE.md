# HomeHub Architecture

**Stack:** Node.js v24 · Angular v21 · Ollama · MCP · SQLite · Tailscale/Headscale · Docker Compose
**Target Hardware:** Raspberry Pi 5 (8GB RAM recommended)
**Design Principle:** 100% local-first — no TP-Link cloud, no external AI APIs, no mandatory third-party accounts.

---

## System Diagram

```
                        Outside Home
                             │
                        Tailscale /
                        Headscale VPN
                             │
┌────────────────────────────┼──────────────────────────────┐
│            Raspberry Pi 5 (Docker Host)                    │
│                            │                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  docker-compose.yml                   │  │
│  │                                                       │  │
│  │  ┌──────────┐   ┌──────────┐   ┌──────────────────┐  │  │
│  │  │ frontend │   │ backend  │   │     ollama        │  │  │
│  │  │ Angular  │◄──│ Node.js  │──►│  Local LLM        │  │  │
│  │  │ + Nginx  │   │ Express  │   │  (llama3.2:3b or  │  │  │
│  │  │ :4200    │   │ :3000    │   │   qwen2.5:7b)     │  │  │
│  │  └──────────┘   └────┬─────┘   └──────────────────┘  │  │
│  │                      │                                  │  │
│  │          ┌───────────┼──────────────┐                  │  │
│  │          │           │              │                   │  │
│  │   ┌──────────┐  ┌──────────┐  ┌──────────┐            │  │
│  │   │scheduler │  │  mcp-    │  │tailscale │            │  │
│  │   │node-cron │  │  server  │  │ sidecar  │            │  │
│  │   │+ suncalc │  │ MCP SDK  │  │  :41641  │            │  │
│  │   └──────────┘  └──────────┘  └──────────┘            │  │
│  │                                                        │  │
│  │  Shared volume: /data  (SQLite db, Ollama models)      │  │
│  └──────────────────────────────────────────────────────┘  │
│                            │                               │
└────────────────────────────┼───────────────────────────────┘
                             │  Local LAN (TCP port 9999)
                    ┌────────┴─────────┐
                    │  TP-Link Kasa    │
                    │  Smart Plugs     │
                    │  (static IPs)    │
                    └──────────────────┘
```

---

## Services

### `frontend` — Angular v21 + Nginx

- Serves the Angular SPA from an Nginx container
- Communicates with backend via REST and Socket.io
- Auth: JWT stored in `httpOnly` cookie via Angular `HttpInterceptor`
- Views: Dashboard · Chat · Schedules · Energy · Settings

### `backend` — Node.js v24 / Express

The central hub. Owns all business logic and hardware communication.

Responsibilities:
- Kasa device control via `tplink-smarthome-api` (local TCP, no TP-Link cloud)
- Device state cache + energy history in SQLite
- JWT authentication (access 15min / refresh 7 days)
- WebSocket via Socket.io for real-time plug state push
- REST API consumed by frontend, scheduler, and MCP server
- Ollama HTTP client for natural language processing with tool calling

### `mcp-server` — @modelcontextprotocol/sdk

- Exposes plug controls as MCP tools over StreamableHTTP transport
- Allows external AI agents (Claude Desktop, Cursor, custom bots) to control the hub
- Tool registry: `list_devices`, `set_power_state`, `get_energy_metrics`, `get_all_states`, `create_schedule`, `get_sunrise_sunset`, `get_weather` (Open-Meteo, `home/weather.ts`). The time, the date and the weather are also answered by rules in `nlp/questions.ts`, before any model

### `scheduler` — Node.js v24

- Two trigger types:
  - **Cron**: `node-cron` for fixed time schedules
  - **Solar**: `suncalc` computes sunrise/sunset/dusk/dawn from lat/lon, re-scheduled daily at midnight
- Persists all schedules to SQLite
- Posts to backend REST API to execute plug actions at trigger time

### `ollama` — Local LLM

- Runs entirely on-device, no external API calls
- Exposes OpenAI-compatible API at `:11434`
- Used for natural language commands with native tool calling
- Recommended models for Raspberry Pi 5:
  - `llama3.2:3b` — fast, good tool calling, low RAM
  - `qwen2.5:7b` — better reasoning, ~5GB RAM
- Model weights persisted to `/data/ollama` volume

### `tailscale` — Remote Access Sidecar

- WireGuard-based mesh VPN — no port forwarding, works behind CGNAT
- Option A: **Tailscale** free tier (up to 20 devices, minimal metadata to Tailscale Inc.)
- Option B: **Headscale** — fully self-hosted coordination server, zero external dependency
- The frontend and backend are accessed over the tailnet IP from outside the home

---

## Data Flow

### Manual Toggle (UI → Plug)

```
User clicks toggle
  → Angular POST /api/devices/:id/on
  → backend: tplink-smarthome-api.setPowerState()
  → Kasa plug (TCP)
  → backend: Socket.io broadcast new state
  → All connected Angular clients update live
```

### Natural Language Command

```
User types "turn off the office lamp after 10pm"
  → Angular POST /api/nlp { message }
  → backend: POST ollama /api/chat (with tool definitions)
  → Ollama reasons → returns tool call: create_schedule(...)
  → backend executes tool → writes schedule to SQLite
  → backend: response streamed back to Angular chat UI
```

### Solar Schedule (daily)

```
Scheduler: midnight cron fires
  → suncalc.getTimes(tomorrow, lat, lon)
  → computes sunset time (e.g. 19:42)
  → node-cron.schedule('42 19 * * *', () => POST /api/devices/porch/on)
  → next day at 19:42 → plug turns on
```

### Remote Access

```
User on mobile (outside home)
  → connects via Tailscale app
  → traffic routes peer-to-peer over WireGuard to Pi tailnet IP
  → hits frontend :4200 or backend :3000 directly on tailnet
  → JWT auth still required (defense in depth)
```

---

## Authentication

- No external identity provider — fully self-hosted
- Accounts stored in SQLite with `bcrypt`-hashed passwords
- **Roles:**
  - `admin` — full access: manage users, devices, schedules, settings
  - `member` — can toggle plugs, use chat, view schedules/energy
- Token strategy: short-lived JWT access token + rotating refresh token in `httpOnly` cookie
- Admin creates household member accounts from the Settings UI (no self-registration)

---

## Storage

Single SQLite file at `/data/db.sqlite` (mounted volume, survives container restarts).

Tables:
- `users` — id, name, hashed_password, role, created_at
- `devices` — id, alias, ip, model, icon
- `schedules` — id, device_id, trigger_type (cron|solar), trigger_value, state (on|off), enabled, label
- `energy_readings` — id, device_id, wattage, voltage, current, recorded_at

---

## Port Map

| Service | Internal Port | Exposed to Host |
|---|---|---|
| frontend | 80 | 4200 |
| backend | 3000 | 3000 |
| mcp-server | 3001 | 3001 (tailnet only) |
| ollama | 11434 | 11434 (internal only) |
| tailscale | 41641 | host network |

Ollama is **not** exposed outside the Pi — only the backend calls it internally.
MCP server is accessible on the tailnet for external AI agent use.

---

## Technology Versions

| Technology | Version |
|---|---|
| Node.js | v24 LTS |
| Angular | v21 |
| TypeScript | v5.7+ |
| SQLite driver | `better-sqlite3` |
| tplink-smarthome-api | latest |
| suncalc | latest |
| @modelcontextprotocol/sdk | latest |
| Docker Compose | v2 |
| Ollama | latest |
| Tailscale | latest |
