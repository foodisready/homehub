/**
 * homehub-tools.ts
 *
 * Registers all HomeHub MCP tools on the given McpServer instance.
 * Each tool proxies to the backend REST API via backendService.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import SunCalc from 'suncalc';
import { apiRequest } from '../services/backend.service';

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function safeErr(e: unknown) {
  return err(e instanceof Error ? e.message : String(e));
}

export function registerHomeHubTools(server: McpServer): void {

  // ── list_devices ─────────────────────────────────────────────
  server.registerTool(
    'list_devices',
    {
      description: 'List all registered smart plugs with their current on/off state, online status, and live wattage.',
      inputSchema: {},
    },
    async () => {
      try {
        const devices = await apiRequest<any[]>('GET', '/api/devices');
        if (!devices.length) return ok('No devices registered yet.');
        const lines = devices.map((d) =>
          `• ${d.alias} — ${d.state ? 'ON' : 'OFF'} | ${d.online ? 'online' : 'offline'}${d.wattage != null ? ` | ${d.wattage.toFixed(1)} W` : ''}`
        );
        return ok(`Devices (${devices.length}):\n${lines.join('\n')}`);
      } catch (e) { return safeErr(e); }
    },
  );

  // ── get_all_states ────────────────────────────────────────────
  server.registerTool(
    'get_all_states',
    {
      description: 'Get a quick snapshot of every device — name, on/off, online, and current wattage.',
      inputSchema: {},
    },
    async () => {
      try {
        const devices = await apiRequest<any[]>('GET', '/api/devices');
        const onDevices  = devices.filter((d) => d.state);
        const offDevices = devices.filter((d) => !d.state);
        const totalW     = devices.reduce((s, d) => s + (d.wattage ?? 0), 0);
        const lines = [
          `Total: ${devices.length} device(s), ${onDevices.length} on, ${offDevices.length} off`,
          totalW > 0 ? `Live draw: ${totalW.toFixed(1)} W` : '',
          '',
          ...devices.map((d) =>
            `${d.state ? '🟢' : '⚫'} ${d.alias}${d.wattage != null ? ` (${d.wattage.toFixed(1)} W)` : ''}`
          ),
        ].filter(Boolean);
        return ok(lines.join('\n'));
      } catch (e) { return safeErr(e); }
    },
  );

  // ── set_power_state ───────────────────────────────────────────
  server.registerTool(
    'set_power_state',
    {
      description: 'Turn a smart plug on or off by its alias/name.',
      inputSchema: {
        device_alias: z.string().describe('Device name/alias, e.g. "Living Room Lamp"'),
        state:        z.enum(['on', 'off']).describe('"on" to turn on, "off" to turn off'),
      },
    },
    async ({ device_alias, state }) => {
      try {
        const action = state === 'on' ? 'on' : 'off';
        const result = await apiRequest<any>('POST', `/api/devices/${encodeURIComponent(device_alias)}/${action}`, {});
        return ok(`Turned ${state.toUpperCase()}: ${result.alias ?? device_alias}`);
      } catch (e) { return safeErr(e); }
    },
  );

  // ── get_energy_metrics ────────────────────────────────────────
  server.registerTool(
    'get_energy_metrics',
    {
      description: 'Get live wattage, voltage, and current for a device that supports energy monitoring (HS110 / KP115).',
      inputSchema: {
        device_alias: z.string().describe('Device name/alias'),
      },
    },
    async ({ device_alias }) => {
      try {
        const m = await apiRequest<any>('GET', `/api/devices/${encodeURIComponent(device_alias)}/energy`);
        const lines = [
          `Energy metrics for: ${m.alias ?? device_alias}`,
          m.wattage != null ? `  Power:   ${m.wattage.toFixed(2)} W`   : '  Power:   n/a',
          m.voltage != null ? `  Voltage: ${m.voltage.toFixed(1)} V`   : '  Voltage: n/a',
          m.current != null ? `  Current: ${m.current.toFixed(3)} A`   : '  Current: n/a',
        ];
        return ok(lines.join('\n'));
      } catch (e) { return safeErr(e); }
    },
  );

  // ── create_schedule ───────────────────────────────────────────
  server.registerTool(
    'create_schedule',
    {
      description: 'Create an automation schedule to turn a device on or off at a fixed time (cron) or solar event (sunrise, sunset, etc.).',
      inputSchema: {
        device_alias:         z.string().describe('Device alias'),
        label:                z.string().describe('Human-readable label, e.g. "Porch on at sunset"'),
        trigger_type:         z.enum(['cron', 'solar']).describe('"cron" for fixed time, "solar" for sunrise/sunset event'),
        state:                z.enum(['on', 'off']).describe('Action: "on" or "off"'),
        cron_expression:      z.string().optional().describe('Cron expression — required when trigger_type is "cron", e.g. "0 21 * * *"'),
        solar_event:          z.enum(['sunrise', 'sunset', 'dawn', 'dusk', 'goldenHour', 'solarNoon'])
                                .optional().describe('Solar event — required when trigger_type is "solar"'),
        solar_offset_minutes: z.number().optional().describe('Minutes offset from the solar event (negative = before)'),
      },
    },
    async (params) => {
      try {
        const { device_alias, label, trigger_type, state, cron_expression, solar_event, solar_offset_minutes } = params;

        const devices = await apiRequest<any[]>('GET', '/api/devices');
        const device  = devices.find((d) => d.alias.toLowerCase() === device_alias.toLowerCase());
        if (!device) return err(`Device "${device_alias}" not found. Available: ${devices.map((d) => d.alias).join(', ')}`);

        const payload: Record<string, unknown> = {
          deviceId:    device.id,
          label,
          triggerType: trigger_type,
          state:       state === 'on',
        };
        if (trigger_type === 'cron')  payload.cronExpression     = cron_expression;
        if (trigger_type === 'solar') payload.solarEvent         = solar_event;
        if (solar_offset_minutes)     payload.solarOffsetMinutes = solar_offset_minutes;

        const created = await apiRequest<any>('POST', '/api/schedules', payload);
        return ok(`Schedule created (id: ${created.id})\n  "${label}"\n  Device: ${device_alias}\n  Trigger: ${trigger_type === 'cron' ? cron_expression : `${solar_event}${solar_offset_minutes ? ` ${solar_offset_minutes > 0 ? '+' : ''}${solar_offset_minutes}min` : ''}`}\n  Action: Turn ${state.toUpperCase()}`);
      } catch (e) { return safeErr(e); }
    },
  );

  // ── delete_schedule ───────────────────────────────────────────
  server.registerTool(
    'delete_schedule',
    {
      description: 'Delete an automation schedule by its ID. Use list_schedules to find IDs.',
      inputSchema: {
        schedule_id: z.number().describe('The numeric schedule ID to delete'),
      },
    },
    async ({ schedule_id }) => {
      try {
        await apiRequest('DELETE', `/api/schedules/${schedule_id}`);
        return ok(`Schedule #${schedule_id} deleted.`);
      } catch (e) { return safeErr(e); }
    },
  );

  // ── list_schedules ────────────────────────────────────────────
  server.registerTool(
    'list_schedules',
    {
      description: 'List all automation schedules with their trigger, device, and enabled status.',
      inputSchema: {},
    },
    async () => {
      try {
        const schedules = await apiRequest<any[]>('GET', '/api/schedules');
        if (!schedules.length) return ok('No schedules configured yet.');
        const lines = schedules.map((s) => {
          const trigger = s.triggerType === 'cron'
            ? s.cronExpression
            : `${s.solarEvent}${s.solarOffsetMinutes ? ` ${s.solarOffsetMinutes > 0 ? '+' : ''}${s.solarOffsetMinutes}min` : ''}`;
          return `• [${s.id}] "${s.label}" — ${s.deviceAlias} ${s.state ? 'ON' : 'OFF'} @ ${trigger} (${s.enabled ? 'enabled' : 'disabled'})`;
        });
        return ok(`Schedules (${schedules.length}):\n${lines.join('\n')}`);
      } catch (e) { return safeErr(e); }
    },
  );

  // ── get_sunrise_sunset ────────────────────────────────────────
  server.registerTool(
    'get_sunrise_sunset',
    {
      description: 'Get sunrise, sunset, and other solar event times for today or a given date.',
      inputSchema: {
        date: z.string().optional().describe('ISO date YYYY-MM-DD (optional, defaults to today)'),
      },
    },
    async ({ date }) => {
      try {
        const lat = parseFloat(process.env.LATITUDE  ?? '37.7749');
        const lon = parseFloat(process.env.LONGITUDE ?? '-122.4194');
        const d   = date ? new Date(date) : new Date();
        const t   = SunCalc.getTimes(d, lat, lon);

        const fmt = (dt: Date) => dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TIMEZONE ?? 'America/Los_Angeles' });

        const lines = [
          `Solar times for ${d.toDateString()}:`,
          `  Dawn:        ${fmt(t.dawn)}`,
          `  Sunrise:     ${fmt(t.sunrise)}`,
          `  Solar noon:  ${fmt(t.solarNoon)}`,
          `  Golden hour: ${fmt(t.goldenHour)}`,
          `  Sunset:      ${fmt(t.sunset)}`,
          `  Dusk:        ${fmt(t.dusk)}`,
        ];
        return ok(lines.join('\n'));
      } catch (e) { return safeErr(e); }
    },
  );
}
