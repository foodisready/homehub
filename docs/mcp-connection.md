# Connecting Claude Desktop to HomeHub

HomeHub exposes an MCP server on port **3001** using the StreamableHTTP transport.

---

## On the home network (local access)

Add the following to your `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "homehub": {
      "type": "http",
      "url": "http://<RASPBERRY_PI_IP>:3001/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_SECRET>"
      }
    }
  }
}
```

Replace `<RASPBERRY_PI_IP>` with your Pi's LAN IP (e.g. `192.168.1.100`)
and `<YOUR_MCP_SECRET>` with the secret shown in HomeHub under **Settings → Integrations → AI assistant (MCP)** (select **Show secret**). HomeHub generates it on first start; setting `MCP_SECRET` in `.env` replaces it.

---

## Over Tailscale (remote access)

Once Tailscale is running (Phase 9), replace the IP with your Pi's Tailscale address:

```json
{
  "mcpServers": {
    "homehub": {
      "type": "http",
      "url": "http://homehub.<TAILNET>.ts.net:3001/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_SECRET>"
      }
    }
  }
}
```

---

## Available tools

| Tool | Description |
|------|-------------|
| `list_devices` | All plugs with live state and wattage |
| `get_all_states` | Quick snapshot of every device |
| `set_power_state` | Turn a plug on or off |
| `get_energy_metrics` | Live power draw (HS110 / KP115 only) |
| `create_schedule` | Automate a plug at a cron time or solar event |
| `delete_schedule` | Remove a schedule by ID |
| `list_schedules` | List all automation schedules |
| `get_sunrise_sunset` | Solar event times for today or a given date |

---

## Security notes

- The MCP secret is always set in production: HomeHub generates one in its data volume if `.env` has none. Outside Docker with no secret anywhere, auth is off (dev only).
- The MCP server signs in to the backend with HomeHub's internal key, as the first admin account. Its changes show in Activity as the AI assistant's. It needs no admin password.
- In the Docker deployment the MCP server is only reachable from inside the home network
  (or over Tailscale) — it is not exposed to the public internet.
