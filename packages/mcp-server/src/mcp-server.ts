/**
 * mcp-server.ts
 *
 * Factory that creates and configures the HomeHub MCP server instance.
 */

import { IncomingHttpHeaders } from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHomeHubTools } from './tools/homehub-tools';

/**
 * Creates a new McpServer with all HomeHub tools registered.
 *
 * @param initialHeaders - HTTP headers from the initializing request (reserved for future per-session auth)
 */
export function createMcpServer(_initialHeaders: IncomingHttpHeaders): McpServer {
  const server = new McpServer(
    { name: 'homehub', version: '1.0.0' },
    {
      capabilities: {
        tools:     { listChanged: true },
        resources: { listChanged: false },
        prompts:   { listChanged: false },
      },
      instructions: `You are connected to HomeHub — a local smart home controller for TP-Link Kasa smart plugs.

AVAILABLE TOOLS:
- list_devices       — show all plugs with live state and wattage
- get_all_states     — quick snapshot of all device states
- set_power_state    — turn a specific plug on or off
- get_energy_metrics — live power draw for energy-monitoring plugs (HS110/KP115)
- create_schedule    — automate a plug at a fixed time (cron) or solar event (sunrise/sunset/etc.)
- delete_schedule    — remove a schedule by ID
- list_schedules     — list all automation schedules
- get_sunrise_sunset — solar event times for today or a given date

GUIDELINES:
- Always call list_devices before set_power_state if the exact alias is unknown.
- When creating solar schedules, call get_sunrise_sunset first to confirm the time.
- Aliases are case-insensitive but must match an existing device.
- Cron format: "minute hour day month weekday", e.g. "0 21 * * *" = 9 PM every day.`,
    },
  );

  registerHomeHubTools(server);

  return server;
}
