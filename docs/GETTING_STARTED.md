# Getting Started with HomeHub

Local-first smart plug automation for Raspberry Pi. No cloud accounts required.

---

## Prerequisites

- **Raspberry Pi 5** (8GB RAM recommended) running a 64-bit OS (Raspberry Pi OS or Ubuntu 24.04)
- **Docker** + **Docker Compose v2** installed on the Pi
- **Node.js v24** (for local development only — not needed on the Pi)
- **pnpm** package manager (`npm install -g pnpm`)
- TP-Link Kasa smart plugs on your local network with static IPs assigned via your router

---

## Quick Start (Raspberry Pi)

1. **Clone the repo**
   ```bash
   git clone <repo-url> homehub
   cd homehub
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` — at minimum set:
   - `JWT_SECRET`, `JWT_REFRESH_SECRET` and `INTERNAL_API_KEY` — generate each with `openssl rand -base64 32`
   - `WATCHTOWER_HTTP_API_TOKEN` — generate with `openssl rand -hex 32`
   - `ADMIN_PASSWORD` — your initial admin password
   - `LATITUDE` / `LONGITUDE` — your home coordinates (for solar scheduling)
   - `TS_AUTHKEY` — your Tailscale auth key (or leave blank if using Headscale)

3. **Build and start all services**
   ```bash
   docker compose -f docker-compose.yml up -d --build
   ```
   Name the file explicitly: a plain `docker compose up` also applies `docker-compose.override.yml`, which runs the development builds.

   First startup will take several minutes — Ollama needs to pull the LLM model.

4. **Open the dashboard**

   From your home network: `http://<pi-ip>:4200`
   Log in with `admin` and the password you set in `.env`.

---

## Local Development

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Start with hot reload**
   ```bash
   docker compose up   # uses docker-compose.override.yml automatically
   ```

3. **Run backend tests**
   ```bash
   pnpm --filter backend test
   ```

---

## First-Time Setup Checklist

- [ ] Log in as admin and visit **Settings** to confirm your location (lat/lon) is correct
- [ ] Go to **Settings → Devices → Discover** to find your Kasa plugs on the network
- [ ] Assign friendly aliases to each plug (e.g. "living-room-lamp", "porch-light")
- [ ] Create household member accounts under **Settings → Users**
- [ ] Share your Tailscale network (or Headscale invite) with household members for remote access
- [ ] Try the **Chat** tab — type "what plugs are on?" to verify natural language is working

---

## Documentation

| Doc | Description |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, data flows, service breakdown |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Phase-by-phase build plan with task checklists |
| [DOCKER_COMPOSE.md](./DOCKER_COMPOSE.md) | Full Docker Compose reference and Dockerfiles |
| [API_SPEC.md](./API_SPEC.md) | REST API and WebSocket event reference |
| [KASA_SMART_PLUG.md](./KASA_SMART_PLUG.md) | Kasa local API research and MCP integration notes |
| [REMOTE_ACCESS.md](./REMOTE_ACCESS.md) | Tailscale and Headscale setup, ACLs, member onboarding |
| [mcp-connection.md](./mcp-connection.md) | Claude Desktop MCP connection config |
| [VOICE_CONTROL.md](./VOICE_CONTROL.md) | Plan for local voice control, hardware options and AI models |

---

## Troubleshooting

**Plugs not discovered:**
The Kasa discovery uses UDP broadcast. If the backend runs in `network_mode: host`, it can reach the LAN directly. If not, add your plug IPs manually in Settings → Devices.

**A lamp shows as offline after a router or power change:**
Routers can give a device a new IP address, and HomeHub then stops reaching it. To fix it:
1. Go to **Settings → Devices** and select **+ Discover on network**.
2. If the lamp is listed as moved, select **Update address**. It should show as online again within about 30 seconds.
3. To stop it happening again, reserve the device's address in your router's DHCP settings.

Don't add the lamp as a new device, or you'll lose its link to its existing schedules and history.

If the lamp isn't listed as moved, run the scan again, because a scan can occasionally miss a device. If it's still missing, HomeHub couldn't match it. This can happen if you renamed it in HomeHub before it was linked to its MAC address, or if it's a Shelly or Tuya device, which don't support moved-device detection yet. Find its new address in your router's device list, then enter it under **Settings → Devices → Edit**. You can check an address first with **Probe**.

If you see "Another device already uses that name or IP address", an old entry is holding that address. Update that device first. If two lamps swapped addresses, edit one to any unused address, update the other, then correct the first.

**Ollama slow on first chat:**
The model loads into RAM on first request. Subsequent requests are fast. If RAM is tight, switch to `llama3.2:3b` (the smallest capable tool-calling model) via `OLLAMA_MODEL` in `.env`.

**Can't reach the hub remotely:**
Ensure Tailscale is running on both the Pi and your phone/laptop. The hub's tailnet IP is shown in the Tailscale admin console.

**JWT errors after restart:**
If `JWT_SECRET` changed in `.env`, all existing tokens are invalidated — just log in again.
