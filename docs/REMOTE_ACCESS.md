# Remote Access — Tailscale & Headscale

HomeHub supports two remote access options. Both are zero-config VPNs — no port forwarding, no firewall holes, no public IP required.

| | Tailscale (Option A) | Headscale (Option B) |
|---|---|---|
| Control plane | Tailscale cloud (free tier) | Self-hosted on your Pi |
| Client apps | Official Tailscale apps | Official Tailscale apps |
| Setup effort | ~5 minutes | ~30 minutes |
| Fully offline | No (auth pings Tailscale) | Yes |

**Recommendation:** Start with Option A. Switch to Headscale if you want zero cloud dependency.

---

## Option A — Tailscale (Recommended)

### 1. Create a Tailscale account

Sign up at [tailscale.com](https://tailscale.com) — the free personal plan supports up to 3 users and 100 devices.

### 2. Generate an auth key

1. Go to **Admin Console → Settings → Keys → Generate auth key**
2. Check **Reusable** and set expiry to **No expiry** (for the Pi — it stays connected permanently)
3. Copy the key

### 3. Configure HomeHub

In your `.env` file:

```env
TS_AUTHKEY=tskey-auth-<your-key-here>
```

### 4. Start the Tailscale sidecar

```bash
docker compose --profile remote-access up -d
```

The `tailscale` service uses Docker profile `remote-access` so it only runs when explicitly enabled. After startup, the Pi will appear in your Tailscale admin console as **homehub**.

### 5. Find the Pi's tailnet IP

```bash
# On the Pi:
docker exec homehub-tailscale-1 tailscale ip -4
# → something like 100.64.x.x
```

Or check the Tailscale admin console at tailscale.com/admin/machines.

### 6. Access HomeHub remotely

From any device with Tailscale active:

```
http://100.64.x.x:4200        # Dashboard
http://100.64.x.x:3001/mcp    # MCP server (Claude Desktop)
```

---

## Option B — Headscale (Fully Self-Hosted)

Headscale replaces the Tailscale control plane with one running on your Pi. All coordination stays on your LAN.

### 1. Add Headscale to docker-compose.yml

Add this service alongside the existing ones:

```yaml
headscale:
  image: headscale/headscale:latest
  command: headscale serve
  volumes:
    - ./data/headscale:/etc/headscale
    - headscale-data:/var/lib/headscale
  ports:
    - "8080:8080"
  restart: unless-stopped
  networks:
    - homehub-net
```

Add volume:
```yaml
volumes:
  headscale-data:
```

### 2. Create Headscale config

```bash
mkdir -p data/headscale
```

Create `data/headscale/config.yaml`:

```yaml
server_url: http://<PI_LAN_IP>:8080
listen_addr: 0.0.0.0:8080
ip_prefixes:
  - 100.64.0.0/10
dns_config:
  base_domain: homehub.local
db_type: sqlite3
db_path: /var/lib/headscale/db.sqlite
private_key_path: /var/lib/headscale/private.key
noise:
  private_key_path: /var/lib/headscale/noise_private.key
log:
  level: info
```

### 3. Create a user and pre-auth key

```bash
# Create user
docker exec homehub-headscale-1 headscale users create homehub

# Create a reusable pre-auth key
docker exec homehub-headscale-1 headscale preauthkeys create \
  --user homehub --reusable --expiration 0s
# → outputs a key like: <long-auth-key>
```

### 4. Connect the Pi to Headscale

In `.env`:
```env
TS_AUTHKEY=<headscale-preauthkey>
TS_EXTRA_ARGS=--login-server http://<PI_LAN_IP>:8080 --advertise-tags=tag:homehub
```

### 5. Connect household members to Headscale

Each member installs the Tailscale client and uses the custom login server:

```bash
# macOS / Linux
tailscale up --login-server http://<PI_LAN_IP>:8080

# iOS / Android
# Settings → Account → Use a different server → http://<PI_LAN_IP>:8080
```

After connecting, approve them in Headscale:

```bash
docker exec homehub-headscale-1 headscale nodes list
docker exec homehub-headscale-1 headscale nodes approve --identifier <node-id>
```

---

## Tailscale ACLs (Access Control)

In the Tailscale admin console → **Access Controls**, lock down who can reach HomeHub:

```json
{
  "tagOwners": {
    "tag:homehub": ["autogroup:owner"]
  },
  "acls": [
    {
      "action": "accept",
      "src":    ["autogroup:member"],
      "dst":    ["tag:homehub:4200", "tag:homehub:3001"]
    }
  ]
}
```

This allows all Tailscale users in your tailnet to reach port 4200 (dashboard) and 3001 (MCP server) on the Pi. All other ports are blocked.

---

## Household Member Onboarding

### Step 1 — Install Tailscale

| Platform | Download |
|----------|----------|
| iOS      | App Store → "Tailscale" |
| Android  | Play Store → "Tailscale" |
| macOS    | App Store or [tailscale.com/download](https://tailscale.com/download) |
| Windows  | [tailscale.com/download](https://tailscale.com/download) |

### Step 2 — Join the tailnet

**Option A (Tailscale cloud):** Admin shares an invite link from the Tailscale admin console → **Users → Invite users**.

**Option B (Headscale):** Admin sends them a pre-auth key:

```bash
docker exec homehub-headscale-1 headscale preauthkeys create \
  --user homehub --reusable --expiration 90d
```

They run `tailscale up --login-server http://<PI_LAN_IP>:8080 --auth-key <key>`.

### Step 3 — Create their HomeHub account

Log in as admin → Dashboard → Settings → Users → **Add user**. Give them a username and temporary password. They can change their password after first login.

### Step 4 — Share the URL

Send them the tailnet URL: `http://<pi-tailnet-ip>:4200`

For easy access, they can add it to their phone home screen:
- iOS Safari: Share → **Add to Home Screen**
- Android Chrome: Menu → **Add to Home Screen**

> The PWA manifest (added in Phase 10) makes it install with a proper icon and full-screen experience.

---

## Security Notes

- JWT auth is always enforced — Tailscale provides encrypted transport, but HomeHub requires login regardless. This is defense in depth.
- `MCP_SECRET` should be a strong random value (`openssl rand -base64 32`). Anyone with the MCP secret can control all plugs.
- The Tailscale sidecar uses Docker `cap_add: NET_ADMIN, SYS_MODULE` — required for WireGuard tunnel creation.
- Never expose port 3000 (backend) or 3002 (scheduler) to the tailnet directly — all external access should go through Nginx on port 4200.
- Periodically rotate `TS_AUTHKEY` and `JWT_SECRET` for production deployments.
