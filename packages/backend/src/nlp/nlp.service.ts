import SunCalc from 'suncalc';
import { getDb } from '../db';
import { getCachedState } from '../kasa/device.cache';
import { getDriver } from '../drivers/registry';
import { emitDeviceState } from '../socket';
import { logger } from '../logger';
import { findDeviceByName } from './find-device';

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
      const match = findDeviceByName(alias);
      if ('error' in match) return { error: match.error };
      const device = match.device as any;
      const driverConfig = device.driver_config ? JSON.parse(device.driver_config) : undefined;
      await getDriver(device.driver_type ?? 'kasa').setPower(device.ip, state, driverConfig);
      emitDeviceState(device.id, device.alias, state, getCachedState(device.id)?.wattage ?? null);
      return { success: true, alias: device.alias, state: state ? 'on' : 'off' };
    }

    case 'get_energy_metrics': {
      const alias = String(args.alias ?? '');
      const match = findDeviceByName(alias);
      if ('error' in match) return { error: match.error };
      const device = match.device as any;
      if (!device.has_emeter) return { error: `"${alias}" does not support energy monitoring` };
      const driverConfig = device.driver_config ? JSON.parse(device.driver_config) : undefined;
      const metrics = await getDriver(device.driver_type ?? 'kasa').getEnergy(device.ip, driverConfig);
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

      const match = findDeviceByName(alias);
      if ('error' in match) return { error: match.error };
      const device = match.device as any;
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

// ── Shared helpers ─────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are HomeHub, a helpful smart home assistant. You control smart plugs and switches (TP-Link Kasa, Shelly, and others) and manage automation schedules.

Use the provided tools when the user wants to control devices or manage schedules. Be concise and friendly. After taking actions, briefly summarize what you did.

IMPORTANT: When reporting device states, always use the exact data returned by the list_devices tool. Never guess or assume device states. Only report devices as "on" if their state field is true in the tool result.

Do NOT output raw JSON or tool call syntax in your responses. Always respond in plain English.

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
}

/**
 * Run the tool-call loop until Ollama stops requesting tools.
 * Returns the messages array (ready for a final text call) and all actions taken.
 */
export async function resolveTools(
  userMessage: string,
  history: ChatMessage[],
): Promise<{ messages: OllamaMessage[]; actions: ActionTaken[] }> {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
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

    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

    const data         = await res.json() as any;
    const assistantMsg = data.message as OllamaMessage;
    messages.push(assistantMsg);

    // No more tool calls — messages are ready for final text response
    if (!assistantMsg.tool_calls?.length) return { messages, actions };

    for (const call of assistantMsg.tool_calls) {
      const toolName = call.function.name;
      const toolArgs = call.function.arguments ?? {};
      logger.info({ tool: toolName, args: toolArgs }, 'NLP tool call');

      let result: unknown;
      try { result = await executeTool(toolName, toolArgs); }
      catch (err: any) { result = { error: err.message }; }

      actions.push({ tool: toolName, args: toolArgs, result });
      messages.push({ role: 'tool', content: JSON.stringify(result), name: toolName });
    }
  }

  return { messages, actions };
}

// ── Non-streaming entry point ───────────────────────────────────

export async function processMessage(
  userMessage: string,
  history: ChatMessage[],
): Promise<{ response: string; actions: ActionTaken[] }> {
  const { messages, actions } = await resolveTools(userMessage, history);

  // The last message is already a text response (no tool calls) — return it directly
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' && !last.tool_calls?.length && last.content) {
    return { response: last.content, actions };
  }

  // Shouldn't reach here normally, but fall back to a final call
  return { response: 'Done — actions completed.', actions };
}

// ── Streaming entry point ───────────────────────────────────────

export type StreamEvent =
  | { type: 'action'; action: ActionTaken }
  | { type: 'token';  content: string }
  | { type: 'done' }
  | { type: 'error';  message: string };

export async function* processMessageStream(
  userMessage: string,
  history: ChatMessage[],
): AsyncGenerator<StreamEvent> {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

  let messages: OllamaMessage[];
  let actions: ActionTaken[];

  try {
    ({ messages, actions } = await resolveTools(userMessage, history));
  } catch (err: any) {
    yield { type: 'error', message: err.message };
    return;
  }

  // Emit each action taken
  for (const action of actions) yield { type: 'action', action };

  // Check if last message already has text (resolveTools returned early on final text)
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' && !last.tool_calls?.length && last.content) {
    // Stream it character-by-character to simulate streaming from cache
    // (In practice resolveTools already made the final non-streaming call)
    yield { type: 'token', content: last.content };
    yield { type: 'done' };
    return;
  }

  // Stream final response from Ollama
  let streamRes: Response;
  try {
    streamRes = await fetch(`${ollamaUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages, stream: true }),
    });
    if (!streamRes.ok) throw new Error(`Ollama error ${streamRes.status}`);
  } catch (err: any) {
    yield { type: 'error', message: err.message };
    return;
  }

  const reader  = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let   buf         = '';
  let   accumulated = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line) as any;
          if (chunk.message?.content) {
            accumulated += chunk.message.content;
            yield { type: 'token', content: chunk.message.content };
          }
          if (chunk.done) {
            // If the entire response looks like a raw tool-call JSON, suppress it
            const trimmed = accumulated.trim();
            if (trimmed.startsWith('{') && trimmed.includes('"name"') && trimmed.includes('"parameters"')) {
              // Model output a tool call as text — emit a fallback message instead
              yield { type: 'error', message: 'Model returned invalid output. Try switching to a better model (e.g. qwen2.5:3b) via OLLAMA_MODEL.' };
            } else {
              yield { type: 'done' };
            }
            return;
          }
        } catch { /* skip malformed chunk */ }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done' };
}
