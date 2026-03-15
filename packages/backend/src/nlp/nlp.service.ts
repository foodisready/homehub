import SunCalc from 'suncalc';
import { getDb } from '../db';
import { getCachedState } from '../kasa/device.cache';
import { setPowerState, getEnergyMetrics } from '../kasa/kasa.service';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ActionTaken {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

// ── Ollama wire types ──────────────────────────────────────────

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  name?: string;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

// ── Tool definitions ───────────────────────────────────────────

const TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_devices',
      description: 'List all smart plugs with their current on/off state, online status, and wattage',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_power_state',
      description: 'Turn a smart plug on or off by its name/alias',
      parameters: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Device alias (name). Use list_devices first if unsure.' },
          state: { type: 'string', enum: ['on', 'off'], description: '"on" to turn on, "off" to turn off' },
        },
        required: ['alias', 'state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_energy_metrics',
      description: 'Get current wattage, voltage, and current for a device that supports energy monitoring',
      parameters: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Device alias/name' },
        },
        required: ['alias'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description: 'Create a schedule to automatically turn a device on or off at a fixed time or solar event',
      parameters: {
        type: 'object',
        properties: {
          alias:                { type: 'string',  description: 'Device alias' },
          label:                { type: 'string',  description: 'Human-readable label, e.g. "Porch on at sunset"' },
          trigger_type:         { type: 'string',  enum: ['cron', 'solar'], description: '"cron" for fixed time, "solar" for sunrise/sunset' },
          state:                { type: 'string',  enum: ['on', 'off'], description: '"on" or "off"' },
          cron_expression:      { type: 'string',  description: 'Cron expression (required for cron), e.g. "0 21 * * *" for 9 PM daily' },
          solar_event:          { type: 'string',  enum: ['sunrise', 'sunset', 'dawn', 'dusk', 'goldenHour', 'solarNoon'], description: 'Solar event (required for solar)' },
          solar_offset_minutes: { type: 'string',  description: 'Minutes offset from solar event, e.g. "-30" for 30 min before' },
        },
        required: ['alias', 'label', 'trigger_type', 'state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedules',
      description: 'List all automation schedules',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_schedule',
      description: 'Delete an automation schedule by its ID',
      parameters: {
        type: 'object',
        properties: {
          schedule_id: { type: 'string', description: 'Schedule ID (use list_schedules to find it)' },
        },
        required: ['schedule_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sunrise_sunset',
      description: 'Get sunrise, sunset, and other solar event times for today or a specific date',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date string YYYY-MM-DD (optional, defaults to today)' },
        },
      },
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const db = getDb();

  switch (name) {
    case 'list_devices': {
      const rows = db.prepare('SELECT * FROM devices ORDER BY alias').all() as any[];
      return rows.map((d) => {
        const cached = getCachedState(d.id);
        return {
          id:      d.id,
          alias:   d.alias,
          state:   cached?.state  ?? false,
          online:  cached?.online ?? false,
          wattage: cached?.wattage ?? null,
        };
      });
    }

    case 'set_power_state': {
      const alias = String(args.alias ?? '');
      const state = String(args.state ?? '') === 'on';
      const device = db.prepare('SELECT * FROM devices WHERE alias = ? COLLATE NOCASE').get(alias) as any;
      if (!device) return { error: `Device "${alias}" not found. Use list_devices to see available devices.` };
      await setPowerState(device.ip, state);
      emitDeviceState(device.id, device.alias, state, getCachedState(device.id)?.wattage ?? null);
      return { success: true, alias: device.alias, state: state ? 'on' : 'off' };
    }

    case 'get_energy_metrics': {
      const alias = String(args.alias ?? '');
      const device = db.prepare('SELECT * FROM devices WHERE alias = ? COLLATE NOCASE').get(alias) as any;
      if (!device) return { error: `Device "${alias}" not found` };
      if (!device.has_emeter) return { error: `"${alias}" does not support energy monitoring` };
      const metrics = await getEnergyMetrics(device.ip);
      return { alias: device.alias, ...metrics };
    }

    case 'create_schedule': {
      const alias               = String(args.alias ?? '');
      const label               = String(args.label ?? '');
      const triggerType         = String(args.trigger_type ?? '') as 'cron' | 'solar';
      const state               = String(args.state ?? '') === 'on';
      const cronExpression      = args.cron_expression ? String(args.cron_expression) : null;
      const solarEvent          = args.solar_event ? String(args.solar_event) : null;
      const solarOffsetMinutes  = args.solar_offset_minutes ? parseInt(String(args.solar_offset_minutes), 10) : 0;

      const device = db.prepare('SELECT * FROM devices WHERE alias = ? COLLATE NOCASE').get(alias) as any;
      if (!device) return { error: `Device "${alias}" not found` };
      if (triggerType === 'cron' && !cronExpression) return { error: 'cron_expression is required for cron schedules' };
      if (triggerType === 'solar' && !solarEvent)    return { error: 'solar_event is required for solar schedules' };

      const row = db.prepare(`
        INSERT INTO schedules (device_id, label, trigger_type, cron_expression, solar_event, solar_offset_minutes, state, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(device.id, label, triggerType, cronExpression, solarEvent, solarOffsetMinutes, state ? 1 : 0);

      // Notify scheduler to reload
      const schedulerUrl = process.env.SCHEDULER_URL;
      if (schedulerUrl) {
        fetch(`${schedulerUrl}/reload`, {
          method: 'POST',
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY ?? '' },
        }).catch(() => {});
      }

      return { success: true, id: Number(row.lastInsertRowid), label, device: device.alias, triggerType, state: state ? 'on' : 'off' };
    }

    case 'list_schedules': {
      const rows = db.prepare(`
        SELECT s.*, d.alias AS device_alias
        FROM schedules s
        JOIN devices d ON d.id = s.device_id
        ORDER BY s.created_at DESC
      `).all() as any[];
      return rows.map((r) => ({
        id:                 r.id,
        label:              r.label,
        device:             r.device_alias,
        triggerType:        r.trigger_type,
        cronExpression:     r.cron_expression,
        solarEvent:         r.solar_event,
        solarOffsetMinutes: r.solar_offset_minutes,
        state:              r.state === 1 ? 'on' : 'off',
        enabled:            r.enabled === 1,
      }));
    }

    case 'delete_schedule': {
      const id = parseInt(String(args.schedule_id ?? ''), 10);
      const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
      if (result.changes === 0) return { error: `Schedule #${id} not found. Use list_schedules to find IDs.` };
      const schedulerUrl = process.env.SCHEDULER_URL;
      if (schedulerUrl) {
        fetch(`${schedulerUrl}/reload`, {
          method: 'POST',
          headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY ?? '' },
        }).catch(() => {});
      }
      return { success: true, deleted_id: id };
    }

    case 'get_sunrise_sunset': {
      const lat = parseFloat(process.env.LATITUDE  ?? '37.7749');
      const lon = parseFloat(process.env.LONGITUDE ?? '-122.4194');
      const d   = args.date ? new Date(String(args.date)) : new Date();
      const t   = SunCalc.getTimes(d, lat, lon);
      return {
        date:       d.toDateString(),
        sunrise:    t.sunrise.toISOString(),
        sunset:     t.sunset.toISOString(),
        dawn:       t.dawn.toISOString(),
        dusk:       t.dusk.toISOString(),
        solarNoon:  t.solarNoon.toISOString(),
        goldenHour: t.goldenHour.toISOString(),
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Main entry point ───────────────────────────────────────────

export async function processMessage(
  userMessage: string,
  history: ChatMessage[],
): Promise<{ response: string; actions: ActionTaken[] }> {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

  const systemPrompt = `You are HomeHub, a helpful smart home assistant. You control TP-Link Kasa smart plugs and manage automation schedules.

Use the provided tools when the user wants to control devices or manage schedules. Be concise and friendly. After taking actions, briefly summarize what you did.

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;

  const messages: OllamaMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10).map((m) => ({ role: m.role as OllamaMessage['role'], content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const actions: ActionTaken[] = [];
  const MAX_ITERATIONS = 6;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages, tools: TOOLS, stream: false }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data         = await res.json() as any;
    const assistantMsg = data.message as OllamaMessage;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls?.length) {
      return { response: assistantMsg.content ?? '', actions };
    }

    // Execute each tool call and append results
    for (const call of assistantMsg.tool_calls) {
      const toolName = call.function.name;
      const toolArgs = call.function.arguments ?? {};
      logger.info({ tool: toolName, args: toolArgs }, 'NLP tool call');

      let result: unknown;
      try {
        result = await executeTool(toolName, toolArgs);
      } catch (err: any) {
        result = { error: err.message };
      }

      actions.push({ tool: toolName, args: toolArgs, result });
      messages.push({ role: 'tool', content: JSON.stringify(result), name: toolName });
    }
  }

  return { response: 'Done — actions completed.', actions };
}
