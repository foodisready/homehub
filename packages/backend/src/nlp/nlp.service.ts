import SunCalc from 'suncalc';
import { solarLocation } from '../home/home-settings';
import { getDb } from '../db';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getCachedState } from '../kasa/device.cache';
import { answerStatusQuestion } from './status';
import { answerAsked, answerMissed, FOLLOW_UP_MS } from './question-reader';
import { describeWeather, getWeather, WeatherError } from '../home/weather';
import { getDriver } from '../drivers/registry';
import { applyPower, assistantMaySwitch, isProtectedDevice, type PowerDevice } from '../devices/power';
import { logger } from '../logger';
import { findDeviceByName, findDeviceGroup, listDeviceNames, notALight } from './find-device';
import { isCamera, isGarageDoor, runGroupCommand, runPowerCommand, type ThermostatAsk } from './commands';
import { runVacuumCommand, cleanRoomsByName } from './vacuum-rooms';
import { hasChinese, MANDARIN, runNativeCommand } from './native-commands';
import { recordCommand } from './command-log';
import { looksLikeToolCall, toolArguments, toolCallInText } from './tool-args';
import { asksForLater, primeRewrite, rewriteMessage } from './rewrite';
import { answerKind, askText, confirm, declined, propose, refusedText, setPending, takePending, type Lang, type Proposal } from './confirm';
import { understandPrompt, understandWithClaude, understandWithOllama, type HomeNames, type UnderstandResult } from './understand';
import { CLAUDE_LABEL, claudeErrorText, claudeInUse, recordClaudeFailure, recordClaudeUse } from './ai-choice';
import { chatWithClaude, ClaudeChatError } from './claude-chat';
import { warmupDone, warmupStarted, warmupStep } from './warmup';
import { cronProblem } from '../routes/cron-check';
import { PLAN_DECLINED, runSetupTool, setPlan, SETUP_TOOL_NAMES, SETUP_TOOLS, takePlan } from './setup-tools';
import { HISTORY_TOOL, runHistoryTool } from './history-tool';

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

/** The home's time zone (Settings → Home sets TZ), else the computer's. */
function homeTz(): string {
  const tz = process.env.TZ || process.env.TIMEZONE;
  try { if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } } catch { /* not a zone */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// ── Tool definitions ───────────────────────────────────────────

export const TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_devices',
      description: 'List every device by name, sorted into on, off and offline',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_power_state',
      description: 'Turn a smart plug on or off by its name/alias, optionally turning it back off after a set time',
      parameters: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'Device alias (name). Use list_devices first if unsure.' },
          state: { type: 'string', enum: ['on', 'off'], description: '"on" to turn on, "off" to turn off' },
          minutes: { type: 'string', description: 'Only with state "on": turn the device off after this many minutes, e.g. "60" for an hour' },
        },
        required: ['alias', 'state'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clean_rooms',
      description: 'Send the robot vacuum to clean particular rooms, or the whole house. Rooms are the names it was given in HomeHub.',
      parameters: {
        type: 'object',
        properties: {
          rooms: { type: 'string', description: 'Room names separated by commas, e.g. "Kitchen, Living Room", or "whole house"' },
        },
        required: ['rooms'],
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
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: "The weather outside the home: now, today's high, low and chance of rain, and tomorrow's",
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Tool executor ──────────────────────────────────────────────

/**
 * A tool call's timer. Small models fill in every parameter, so "", "0", 0
 * and null mean no timer, not a timer of nothing. Anything else unreadable
 * stays NaN, which the tool refuses.
 */
export function timerMinutes(value: unknown): number | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const minutes = Number(value);
  return minutes === 0 ? undefined : minutes;
}

/** Who is asking: schedules, like the Schedules page, are an admin's to add and delete. */
export interface ToolContext { who: string; admin: boolean }
const NOBODY_IN_PARTICULAR: ToolContext = { who: 'chat', admin: false };
const SCHEDULES_ADMIN_ONLY = 'Only an admin can add or delete schedules, as on the Schedules page. Tell the user to ask an admin. Nothing was changed.';
const SOLAR = new Set(['sunrise', 'sunset', 'dawn', 'dusk', 'goldenHour', 'solarNoon']);

async function executeTool(name: string, args: Record<string, unknown>, userMessage = '', ctx: ToolContext = NOBODY_IN_PARTICULAR): Promise<unknown> {
  const db = getDb();

  switch (name) {
    case 'list_devices': {
      const rows = db.prepare('SELECT * FROM devices ORDER BY alias').all() as any[];
      // Just the names, sorted by state: a small model misreads long lists, and on an
      // older computer every word it reads adds time. Energy has its own tool.
      const states = rows.map((d) => ({ alias: d.alias as string, cached: getCachedState(d.id) }));
      return {
        on:      states.filter((d) => d.cached?.online && d.cached.state).map((d) => d.alias),
        off:     states.filter((d) => d.cached?.online && !d.cached.state).map((d) => d.alias),
        offline: states.filter((d) => !d.cached?.online).map((d) => d.alias),
      };
    }

    case 'clean_rooms': {
      if (asksForLater(userMessage)) {
        return { error: 'The user asked for this at a later time or on a schedule, not now. Use create_schedule, or ask them when. Nothing was started.' };
      }
      return cleanRoomsByName(String(args.rooms ?? ''));
    }

    case 'set_power_state': {
      const alias = String(args.alias ?? '');
      const state = String(args.state ?? '') === 'on';
      // A small model may switch now what was asked for later ("every day at
      // sunset") and then say it's scheduled. Now isn't what was asked.
      if (asksForLater(userMessage)) {
        return { error: 'The user asked for this at a later time or on a schedule, not now. Use create_schedule, or ask them when. Nothing was switched.' };
      }
      const minutes = timerMinutes(args.minutes);
      if (minutes !== undefined && !(minutes > 0)) return { error: 'minutes must be a positive number' };
      if (minutes !== undefined && !state) return { error: 'minutes only works when turning a device on' };

      // A room or a shared name ("Brenden's room lights") is all of its
      // devices, as when it's typed and the rules switch it.
      const group = findDeviceGroup(alias) as unknown as PowerDevice[];
      if (group.length) {
        const { response, actions } = await runGroupCommand(group, { name: alias, state, ...(minutes ? { minutes } : {}) });
        const switched = actions.filter((a) => (a.result as any)?.success).map((a) => String(a.args.alias));
        return switched.length
          ? { success: true, alias: switched.join(', '), state: state ? 'on' : 'off', ...(minutes ? { minutes } : {}), note: response }
          : { error: response || `Nothing in ${alias} could be switched.` };
      }

      const match = findDeviceByName(alias);
      if ('error' in match) return { error: match.error };
      const device = match.device as unknown as PowerDevice;
      if (!assistantMaySwitch(device, state)) {
        return { error: `${device.alias} is protected. Tell the user to use its tile on the dashboard.` };
      }
      await applyPower(device, state, minutes);
      return { success: true, alias: device.alias, state: state ? 'on' : 'off', ...(minutes ? { minutes } : {}) };
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

      if (!ctx.admin) return { error: SCHEDULES_ADMIN_ONLY };
      if (triggerType !== 'cron' && triggerType !== 'solar') return { error: 'trigger_type must be "cron" or "solar"' };
      const match = findDeviceByName(alias);
      if ('error' in match) return { error: match.error };
      const device = match.device as any;
      // The same rule as switching now: Chat never opens a garage door or pauses a camera, later included.
      if (!assistantMaySwitch(device, state)) {
        return { error: isGarageDoor(device)
          ? `For safety, Chat can't schedule ${device.alias} to open. It can schedule it to close; to open it at a time, an admin can add that on the Schedules page.`
          : `${device.alias} is protected, so Chat can't schedule it ${state ? 'on' : 'off'}. An admin can add that on the Schedules page.` };
      }
      if (triggerType === 'cron' && !cronExpression) return { error: 'cron_expression is required for cron schedules' };
      if (triggerType === 'solar' && !solarEvent)    return { error: 'solar_event is required for solar schedules' };
      if (triggerType === 'solar' && !SOLAR.has(solarEvent!)) return { error: `solar_event must be one of ${[...SOLAR].join(', ')}` };
      // One the scheduler can't read would be saved and never run.
      const problem = triggerType === 'cron' ? cronProblem(cronExpression!) : null;
      if (problem) return { error: `${problem} Nothing was saved.` };
      if (!Number.isFinite(solarOffsetMinutes) || Math.abs(solarOffsetMinutes) > 720) return { error: 'solar_offset_minutes must be a number of minutes, up to 720 either way' };

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
      if (!ctx.admin) return { error: SCHEDULES_ADMIN_ONLY };
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
      const { lat, lon } = solarLocation();
      const d   = args.date ? new Date(String(args.date)) : new Date();
      const t   = SunCalc.getTimes(d, lat, lon);
      const local = (x: Date) => x.toLocaleTimeString('en-US', { timeZone: homeTz(), hour: 'numeric', minute: '2-digit' });
      return {
        date:       d.toDateString(),
        // In the home's time zone, as a person would say them.
        sunriseLocal: local(t.sunrise),
        sunsetLocal:  local(t.sunset),
        sunrise:    t.sunrise.toISOString(),
        sunset:     t.sunset.toISOString(),
        dawn:       t.dawn.toISOString(),
        dusk:       t.dusk.toISOString(),
        solarNoon:  t.solarNoon.toISOString(),
        goldenHour: t.goldenHour.toISOString(),
      };
    }

    case 'get_weather': {
      try {
        const w = await getWeather();
        return { ...w, now: { ...w.now, conditions: describeWeather(w.now.code) }, temperatureUnit: w.unit === 'F' ? 'Fahrenheit' : 'Celsius' };
      } catch (err: any) {
        return { error: err instanceof WeatherError ? err.message : "The weather isn't available right now." };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Shared helpers ─────────────────────────────────────────────

const TOOL_NAMES = TOOLS.map((t) => t.function.name);

/**
 * The most a reply may run to. A small model sometimes doesn't stop: on a Pi
 * one wrote for over 5 minutes, and the request failed. A chat reply or a tool
 * call is far shorter than this.
 */
export const MAX_REPLY_TOKENS = 300;

/** A reply saying something was switched: "are now on", "has been turned off", "switched on". */
const SAYS_SWITCHED = /\b(?:(?:is|are|was|were|has been|have been|now)\s+(?:now\s+)?(?:turned\s+|switched\s+)?(?:on|off)|(?:turned|switched)\s+(?:on|off))\b/i;

const switchedAnything = (actions: ActionTaken[]) =>
  actions.some((a) => a.tool === 'set_power_state' && (a.result as any)?.success);

/** What a tool's error says, for a person rather than the model. */
const forPeople = (error: string) =>
  error.split(/(?<=\.)\s+/).filter((s) => !/^(?:Ask|Tell|Use)\b/.test(s)).join(' ').trim();

/**
 * A small model can say "Brenden's room lights are now on" without having
 * switched anything (seen on the Pi with qwen2.5:1.5b). HomeHub never passes
 * that on: a reply that says something was switched must have a switch that
 * worked behind it. A report of what's on, after list_devices, is left alone.
 */
export function honestReply(reply: string, actions: ActionTaken[]): string {
  if (switchedAnything(actions) || !SAYS_SWITCHED.test(reply)) return reply;
  const tried = actions.filter((a) => a.tool === 'set_power_state');
  if (!tried.length && actions.length) return reply;   // e.g. a list of what's on
  return didntSwitch(actions);
}

/** Said when nothing was switched, with the reason a tool gave, if any. */
export function didntSwitch(actions: ActionTaken[]): string {
  const why = actions.filter((a) => a.tool === 'set_power_state')
    .map((a) => forPeople(String((a.result as any)?.error ?? ''))).find(Boolean);
  return why
    ? `I didn't switch anything. ${why}`
    : "I didn't switch anything, as I couldn't work out which device you meant. Try its name as it's shown on the dashboard.";
}

/** Said instead of a reply the model garbled. */
/**
 * The chat model couldn't be reached ("fetch failed", "Ollama error 500"): say so plainly, in the
 * language typed, and what still works, rather than showing the network's own words.
 */
export function chatModelDown(text: string): string {
  if (hasChinese(text)) {
    return MANDARIN.test(text)
      ? 'HomeHub 的对话模型现在没有响应，我暂时只能执行简单指令，例如“打开厨房灯”。详情请看 Health 页面。'
      : 'HomeHub 嘅對話模型而家冇回應，我暫時只可以做簡單指令，例如「開廚房燈」。詳情可以睇 Health。';
  }
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) {
    return 'Mô hình trò chuyện của HomeHub hiện chưa trả lời, nên tôi chỉ làm được các lệnh đơn giản, như “bật đèn bếp”. Xem chi tiết ở trang Health.';
  }
  return 'HomeHub’s chat model isn’t answering right now, so I can only do simple commands, such as “turn on the kitchen lights” or “turn on the fan for 30 minutes”. Health has details.';
}

export const NOT_UNDERSTOOD = "Sorry, I didn't manage that. Try saying it another way, such as \"turn on the office lights\".";

/**
 * How long Ollama keeps the model in memory after a reply. Loading it takes
 * seconds, so a computer with memory to spare keeps it for a day; a small one,
 * such as a 4 GB Pi, lets it go after 5 minutes. OLLAMA_KEEP_ALIVE overrides.
 * The line is 7 GiB because an "8 GB" computer reports less: a Pi 4 shows 7.6.
 */
export function keepAlive(totalBytes = os.totalmem()): string {
  const set = process.env.OLLAMA_KEEP_ALIVE?.trim();
  if (set) return set;
  return totalBytes >= 7 * 1024 ** 3 ? '24h' : '5m';
}

/**
 * Load the chat models when HomeHub starts, on a computer that keeps them
 * loaded (keepAlive), so the first message after a restart or update doesn't
 * wait a minute for a Pi to load one. Ollama may still be starting, so this
 * tries again for a while. It never blocks or fails startup.
 */
export async function warmModels(
  opts: { fetchImpl?: typeof fetch; tries?: number; waitMs?: number; totalBytes?: number } = {},
): Promise<string[]> {
  const keep = keepAlive(opts.totalBytes);
  if (keep === '5m' || keep === '0') return [];   // it would be unloaded again before anyone asks
  warmupStarted();
  try {
    const loaded = await warmSteps(keep, opts);
    warmupDone(loaded.length > 0);
    return loaded;
  } catch (err) {
    warmupDone(false);
    throw err;
  }
}

async function warmSteps(
  keep: string,
  opts: { fetchImpl?: typeof fetch; tries?: number; waitMs?: number },
): Promise<string[]> {
  const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const main = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  const models = [...new Set([main, process.env.OLLAMA_REWRITE_MODEL?.trim() || main])];
  const doFetch = opts.fetchImpl ?? fetch;
  const tries = opts.tries ?? 10;
  const waitMs = opts.waitMs ?? 30_000;

  const loaded: string[] = [];
  for (const model of models) {
    for (let i = 0; i < tries; i++) {
      try {
        // A request with no prompt only loads the model.
        const res = await doFetch(`${url}/api/generate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: keep }),
        });
        if (res.ok) { loaded.push(model); logger.info({ model }, 'AI model loaded'); break; }
      } catch { /* Ollama isn't up yet */ }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  // The rewrite's instructions first: a typed command uses them first, and
  // Ollama answers one request at a time, so a command waits behind these.
  const rewriteModel = models[models.length - 1];
  if (loaded.length === 0) return loaded;
  warmupStep(2);
  if (loaded.includes(rewriteModel)) await primeRewrite({ url, model: rewriteModel, keepAlive: keep, fetchImpl: opts.fetchImpl });

  // The form's instructions next: an unknown command reaches it before the chat model. On a Pi 4,
  // reading them takes about 100 s, and every command after that about 13 s.
  warmupStep(3);
  if (loaded.includes(main) && askingOn()) {
    try {
      await doFetch(`${url}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: main, stream: false, keep_alive: keep,
          messages: [{ role: 'system', content: understandPrompt(homeNames()) }, { role: 'user', content: 'hello' }],
          options: { num_predict: 1 },
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch { /* only slower on the first command */ }
  }

  // The chat model's instructions, with and without its tools (the final
  // answer is written without them), read now so they're cached.
  warmupStep(4);
  if (loaded.includes(main)) {
    for (const tools of [TOOLS, undefined]) {
      try {
        await doFetch(`${url}/api/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: main, stream: false, keep_alive: keep, ...(tools ? { tools } : {}),
            messages: [{ role: 'system', content: buildSystemPrompt() }, { role: 'user', content: 'hello' }],
            options: { num_predict: 1 },
          }),
          signal: AbortSignal.timeout(5 * 60_000),
        });
      } catch { /* only slower on the first message */ }
    }
  }
  return loaded;
}

/**
 * The chat model's instructions, with the home's device and room names, read
 * from the database each time, so a model doesn't invent names like
 * "pavilion_porch". They change rarely, so Ollama caches them: on a Pi only the
 * first message after a change pays to read them. The date comes last, so a
 * new day only re-reads that line.
 */
/**
 * The local model doesn't have the setup tools (setup-tools.ts), so it says where to go instead of
 * claiming to have set something up.
 */
const LOCAL_SETUP_NOTE = '\nYou cannot set up spoken reminders or daily check-ins here, or look up what happened earlier. If asked, say reminders and check-ins can be added on the Family page, past changes are on the Activity page, and Chat can do both with Claude turned on in Settings → AI.';

export function buildSystemPrompt(names: string[] = listDeviceNames()): string {
  const list = names.length ? names.map((n) => `- ${n}`).join('\n') : '(none yet)';
  return `You are HomeHub, a helpful smart home assistant. You control smart plugs and switches (TP-Link Kasa, Shelly, and others) and manage automation schedules.

Use the provided tools when the user wants to control devices or manage schedules. Be concise and friendly. After taking actions, briefly summarize what you did.

IMPORTANT: When reporting device states, always use the exact data returned by the list_devices tool. Never guess or assume device states. To say which devices are on, report exactly the names in the "on" list of the tool result, and no others.

Do NOT output raw JSON or tool call syntax in your responses. Reply in plain words, in the language the user wrote in: Vietnamese to Vietnamese, Cantonese to Cantonese, Mandarin to Mandarin, English to English. Never translate a device name: use it exactly as listed.

Devices, rooms and their other names in this home. For a tool's alias, use one of these names exactly; never make one up:
${list}

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`;
}

/**
 * Run the tool-call loop until Ollama stops requesting tools.
 * Returns the messages array (ready for a final text call) and all actions taken.
 */
export async function resolveTools(
  userMessage: string,
  history: ChatMessage[],
  ctx: ToolContext = NOBODY_IN_PARTICULAR,
): Promise<{ messages: OllamaMessage[]; actions: ActionTaken[] }> {
  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';

  const messages: OllamaMessage[] = [
    { role: 'system', content: buildSystemPrompt() + LOCAL_SETUP_NOTE },
    ...history.slice(-10).map((m) => ({ role: m.role as OllamaMessage['role'], content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const actions: ActionTaken[] = [];
  const MAX_ITERATIONS = 6;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // Temperature 0: the same message gets the same decision (at the default,
      // qwen2.5:1.5b called the tool one time and only claimed to the next).
      body:    JSON.stringify({ model, messages, tools: TOOLS, stream: false, keep_alive: keepAlive(), options: { num_predict: MAX_REPLY_TOKENS, temperature: 0 } }),
    });

    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);

    const data         = await res.json() as any;
    const assistantMsg = data.message as OllamaMessage;

    // A call written out as text is made after all; one too broken to read
    // isn't shown, since a person can't do anything with it.
    if (!assistantMsg.tool_calls?.length && assistantMsg.content) {
      const call = toolCallInText(assistantMsg.content, TOOL_NAMES);
      if (call) {
        assistantMsg.tool_calls = [{ function: call }];
        assistantMsg.content = '';
      } else if (looksLikeToolCall(assistantMsg.content, TOOL_NAMES)) {
        assistantMsg.content = NOT_UNDERSTOOD;
      }
    }
    messages.push(assistantMsg);

    // No more tool calls — messages are ready for final text response
    if (!assistantMsg.tool_calls?.length) return { messages, actions };

    for (const call of assistantMsg.tool_calls) {
      const toolName = call.function.name;
      const toolArgs = toolArguments(call.function.arguments);
      logger.info({ tool: toolName, args: toolArgs }, 'NLP tool call');

      let result: unknown;
      try { result = await executeTool(toolName, toolArgs, userMessage, ctx); }
      catch (err: any) { result = { error: err.message }; }

      actions.push({ tool: toolName, args: toolArgs, result });
      messages.push({ role: 'tool', content: JSON.stringify(result), name: toolName });
    }
  }

  return { messages, actions };
}

// ── HomeHub's own rules, then a plain rewrite ───────────────────

type Handled = { response: string; actions: ActionTaken[] };

const CHAT_QUESTION = { timeoutMs: 6_000, windowMs: FOLLOW_UP_MS.chat };

const byRules = async (text: string, who: string): Promise<Handled | null> => {
  const ruled = await runVacuumCommand(text) ?? await runPowerCommand(text) ?? await runNativeCommand(text);
  if (ruled?.ask) {
    // Turning a thermostat off: asked first, and done on a yes (byAnswer).
    const lang: Lang = 'lang' in ruled && typeof ruled.lang === 'string' ? ruled.lang as Lang : 'en';
    const proposal = thermostatProposal(ruled.ask, lang, text);
    setPending(who, proposal);
    return { response: askText(proposal), actions: [] };
  }
  return ruled ?? answerStatusQuestion(text) ?? await answerAsked(text, { who, ...CHAT_QUESTION });
};

/** The question for turning thermostats off, as a proposal a yes carries out. */
export function thermostatProposal(ask: ThermostatAsk, lang: Lang, text: string): Proposal {
  return { deviceIds: ask.deviceIds, aliases: ask.aliases, names: ask.aliases, state: false, minutes: null, door: false, lang, phrase: null, text };
}

/** A question the rules missed, read by Claude with the household's key (question-reader.ts). */
const byQuestion = (text: string, who: string): Promise<Handled | null> => answerMissed(text, { who, ...CHAT_QUESTION });

/**
 * After the rules: the command form and, with a key, the question reader, at the same time. A device the
 * form would ask about comes first; then a question; else null and the chat model has it, as before.
 * Recorded as the model's, but not listed in Teach HomeHub when a question was answered.
 */
async function byModelReading(text: string, who: string) {
  const [asked, question] = await Promise.all([byForm(text, who), byQuestion(text, who)]);
  recordCommand(text, 'model', { resolved: !isHandled(asked) && question !== null });
  return { asked, answer: isHandled(asked) ? asked : question };
}

// ── "Did you mean…?" (confirm.ts) ───────────────────────────────

/** CHAT_ASK=off goes back to the chat model for every command the rules don't know. */
const askingOn = () => process.env.CHAT_ASK?.trim().toLowerCase() !== 'off';

/** The home's devices, rooms and scenes, as the form offers them. */
export function homeNames(): HomeNames {
  const db = getDb();
  const devices = db.prepare('SELECT id, alias, nicknames, room, driver_type, is_protected FROM devices').all() as
    (PowerDevice & { id: number; alias: string; nicknames: string | null; room: string | null; driver_type: string | null })[];
  const scenes = db.prepare('SELECT name, nicknames FROM scenes').all() as { name: string; nicknames: string | null }[];
  const list = (v: string | null): string[] => { try { const a = JSON.parse(v ?? '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  return {
    devices: devices.map((d) => ({
      alias: d.alias, nicknames: list(d.nicknames), room: d.room,
      // As "<room> lights" reads elsewhere: not a camera, a door, a valve or a protected device.
      light: !isCamera(d) && !isGarageDoor(d) && !isProtectedDevice(d) && !notALight(d),
      ...(d.driver_type === 'roomba' ? { vacuum: true } : {}),
      // On or off now, so a misheard verb can be read as the likely change (understandPrompt). Not for a
      // camera or a garage door, and not when it's offline or not yet known.
      ...(() => {
        const c = isCamera(d) || isGarageDoor(d) ? undefined : getCachedState(d.id);
        return c?.online ? { on: c.state } : {};
      })(),
    })),
    scenes: scenes.map((sc) => ({ name: sc.name, nicknames: list(sc.nicknames) })),
  };
}

/** A yes or no to the question this person was just asked. Anything else drops the question. */
async function byAnswer(text: string, who: string): Promise<Handled | null> {
  // Setting something up from Chat (setup-tools.ts): saved only on a yes.
  const plan = takePlan(who);
  if (plan) {
    const kind = answerKind(text);
    if (kind === 'yes') {
      try { return { response: plan.run(), actions: [] }; }
      catch (err) {
        logger.warn({ err }, 'Chat setup not saved');
        return { response: (err as Error).message || 'It couldn’t be saved.', actions: [] };
      }
    }
    if (kind === 'no') return { response: PLAN_DECLINED[plan.lang], actions: [] };
    // Anything else is a new message: the question lapses, as a switch's does.
  }
  const proposal = takePending(who);
  if (!proposal) return null;
  const kind = answerKind(text);
  if (kind === 'yes') {
    const done = await confirm(proposal);
    return { response: done.response, actions: done.actions };
  }
  if (kind === 'no') return { response: declined(proposal), actions: [] };
  return null;
}

/**
 * The model fills in a form, and HomeHub asks before doing what it read. Null when the model
 * didn't name anything to switch, or couldn't be reached: then the chat model has it, as before.
 */
async function byForm(text: string, who: string): Promise<Handled & { lang?: never } | { lang: Lang } | null> {
  if (!askingOn()) return null;
  // "Every day at 11pm" is a schedule, not a switch now: the chat model has the schedule tools.
  if (asksForLater(text)) return null;
  const home = homeNames();
  let read: UnderstandResult | null = null;
  const key = claudeInUse();
  if (key) {
    const r = await understandWithClaude(text, home, { apiKey: key, timeoutMs: 8_000 });
    if (r.inputTokens) recordClaudeUse(r.inputTokens, r.outputTokens ?? 0);
    if (r.error) {
      // Not reached, or the key stopped working: this HomeHub's model answers instead.
      logger.warn({ err: r.error }, 'Claude form not filled; using the local model');
      recordClaudeFailure(r.error === 'refused' ? 'Claude declined to answer one message.' : claudeErrorText(r.status, r.error));
    } else read = r;
  }
  read ??= await understandWithOllama(text, home, {
    url:   process.env.OLLAMA_URL ?? 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL ?? 'llama3.2:3b',
    keepAlive: keepAlive(),
  });
  if (read.error) logger.warn({ err: read.error }, 'NLP form not filled');
  const reading = propose(text, read.understanding);
  logger.info({ ms: read.ms, read: read.understanding, reading: reading?.kind ?? null }, 'NLP form');
  if (!reading) return read.understanding ? { lang: read.understanding.lang } : null;
  if (reading.kind === 'refuse') return { response: refusedText(reading), actions: [] };
  setPending(who, reading.proposal);
  return { response: askText(reading.proposal), actions: [] };
}

const isHandled = (r: Awaited<ReturnType<typeof byForm>>): r is Handled => !!r && 'response' in r;

// ── Voice: "Did you mean…?" out loud ────────────────────────────

/** What the speaker says back for a voice command the rules missed, in the language it was heard in. */
export interface VoiceAsk {
  say:  string;
  lang: Lang;
  /** Set when HomeHub is asking: the speaker listens for a yes or no and sends it with this id. */
  confirmId?: string;
}

/**
 * A voice command the rules didn't understand, with Claude in use: Claude fills in the form, and the
 * speaker asks "Should I turn on Kitchen light?" before anything is switched, as Chat does. Null when Claude
 * isn't in use, couldn't answer, or read nothing to switch: the speaker says it didn't understand.
 *
 * Only Claude, not this HomeHub's model: on heard speech the small model asked the wrong question
 * too often (the command test set) to be worth a question out loud. wake: the wake word the speaker
 * was woken with, which Claude is told about (see understandPrompt).
 */
export async function askForVoice(text: string, lang: Lang | null, wake = ''): Promise<VoiceAsk | null> {
  if (!askingOn() || asksForLater(text)) return null;
  const key = claudeInUse();
  if (!key) return null;
  // Shorter than Chat's: someone is standing at the speaker waiting.
  const r = await understandWithClaude(text, homeNames(), { apiKey: key, timeoutMs: 6_000, ...(wake ? { wake } : {}) });
  if (r.inputTokens) recordClaudeUse(r.inputTokens, r.outputTokens ?? 0);
  if (r.error) {
    logger.warn({ err: r.error }, 'Claude form not filled for voice');
    recordClaudeFailure(r.error === 'refused' ? 'Claude declined to answer one message.' : claudeErrorText(r.status, r.error));
    return null;
  }
  const reading = propose(text, r.understanding);
  logger.info({ ms: r.ms, read: r.understanding, reading: reading?.kind ?? null }, 'Voice form');
  if (!reading) return null;
  // Said in the voice the speaker heard, whatever language Claude thought it was.
  if (reading.kind === 'refuse') {
    const said = { ...reading, lang: lang ?? reading.lang };
    return { say: refusedText(said), lang: said.lang };
  }
  const proposal = { ...reading.proposal, lang: lang ?? reading.proposal.lang };
  const confirmId = randomUUID();
  setPending(`voice:${confirmId}`, proposal);
  return { say: askText(proposal), lang: proposal.lang, confirmId };
}

/**
 * The yes or no heard after the speaker asked. Null when it isn't asking that any more (answered,
 * or more than two minutes ago).
 */
export async function answerVoiceAsk(confirmId: string, answer: 'yes' | 'no'): Promise<Handled & { lang: Lang } | null> {
  const proposal = takePending(`voice:${confirmId}`);
  if (!proposal) return null;
  if (answer === 'no') return { response: declined(proposal), actions: [], lang: proposal.lang };
  const done = await confirm(proposal);
  return { response: done.response, actions: done.actions, lang: proposal.lang };
}

/** How Claude should answer, on top of the chat model's instructions. */
function claudeStyle(): string {
  const tz = homeTz();
  const now = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' });
  // The date too, as YYYY-MM-DD, for reminders and looking things up ("in 20 minutes", "last night").
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  return `

Replies may be read aloud: answer in one or two short sentences of plain text, with no markdown, lists or headings.
The home's time zone is ${tz}, and it's now ${now} there (${today}). Say times in the home's time zone, the way people say them ("5:02 PM").
Switching a device asks the person first: call set_power_state for what they most likely mean, and HomeHub asks them "Should I turn on …?" itself. Don't offer to switch something in your own words, and never say something was switched.
HomeHub learns names: when someone says yes to its question, it remembers the words they used for next time, and an admin can add nicknames on a device's page. Never say HomeHub can't remember a name.`;
}

/**
 * The rules didn't understand it: a small model says it again plainly
 * ("turn on ffice liights" → "turn on office lights"), and if the rules
 * understand that, they act on it. Null leaves it to the full chat model.
 */
/**
 * With the household's Anthropic key: Claude Haiku answers, with the same tools as the local chat.
 * Null when there's no key or Claude couldn't answer; then this HomeHub's model does, as before.
 */
async function byClaudeChat(text: string, history: ChatMessage[], who: string, lang: Lang | undefined, admin = false): Promise<Handled | null> {
  const key = claudeInUse();
  if (!key) return null;
  // Claude never switches anything itself either: a switch becomes "Did you mean…?", as with the form.
  let asked: Handled | null = null;
  const ctx: ToolContext = { who, admin };
  const execute = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === HISTORY_TOOL.function.name) return runHistoryTool(args);
    if (SETUP_TOOL_NAMES.has(name)) {
      if (asked) return { error: 'HomeHub is already asking the user about one change. Wait for their answer.' };
      const r = runSetupTool(name, args, ctx);
      if (r.ask) {
        takePending(who);   // one question at a time
        setPlan(who, r.ask);
        asked = { response: r.ask.question, actions: [] };
      }
      return r.result;
    }
    if (name !== 'set_power_state' || asksForLater(text)) return executeTool(name, args, text, ctx);
    if (asked) return { error: 'HomeHub is already asking the user about one change. Wait for their answer.' };
    const alias = String(args.alias ?? '');
    const group = findDeviceGroup(alias);
    const one = group.length ? null : findDeviceByName(alias);
    const devices = group.length ? group.map((d) => d.alias) : one && !('error' in one) ? [String(one.device.alias)] : [];
    if (!devices.length) return { error: one && 'error' in one ? one.error : `No device is called ${alias}.` };
    const minutes = timerMinutes(args.minutes) ?? null;
    const reading = propose(text, { action: String(args.state) === 'on' ? 'on' : 'off', devices, scene: null, minutes, lang: lang ?? 'en' });
    if (!reading) return { error: 'Nothing there can be switched.' };
    if (reading.kind === 'refuse') {
      asked = { response: refusedText(reading), actions: [] };
      return { error: 'HomeHub doesn’t do that from chat or voice.' };
    }
    setPending(who, reading.proposal);
    asked = { response: askText(reading.proposal), actions: [] };
    return { asking: true, note: 'HomeHub is asking the user to confirm. Nothing was switched yet.' };
  };
  try {
    const r = await chatWithClaude(text, history, {
      apiKey: key, system: buildSystemPrompt() + claudeStyle(), tools: [...TOOLS, ...SETUP_TOOLS, HISTORY_TOOL], execute, stop: () => asked !== null,
    });
    recordClaudeUse(r.inputTokens, r.outputTokens);
    if (asked) return asked;
    for (const a of r.actions) logger.info({ tool: a.tool, args: a.args }, 'Claude tool call');
    const response = r.response
      ? honestReply(r.response, r.actions)
      : r.actions.some((a) => a.tool === 'set_power_state') ? didntSwitch(r.actions) : NOT_UNDERSTOOD;
    return { response, actions: r.actions };
  } catch (err) {
    const e = err as ClaudeChatError;
    logger.warn({ err: e.message, status: e.status }, 'Claude chat failed; using the local model');
    recordClaudeFailure(e.message === 'refused' ? 'Claude declined to answer one message.' : claudeErrorText(e.status, e.message));
    return null;
  }
}

async function byRewrite(text: string): Promise<Handled | null> {
  const plain = await rewriteMessage(text, { keepAlive: keepAlive() });
  return plain ? byRules(plain, 'rewrite') : null;
}

// ── Non-streaming entry point ───────────────────────────────────

export async function processMessage(
  userMessage: string,
  history: ChatMessage[],
  who = 'chat',
  role?: string,
): Promise<{ response: string; actions: ActionTaken[] }> {
  const ctx: ToolContext = { who, admin: role === 'admin' };
  const answered = await byAnswer(userMessage, who);
  if (answered) return answered;

  const handled = await byRules(userMessage, who);
  if (handled) {
    recordCommand(userMessage, 'rules');
    return handled;
  }

  const { asked, answer } = await byModelReading(userMessage, who);
  if (answer) return answer;

  const claude = await byClaudeChat(userMessage, history, who, asked?.lang, ctx.admin);
  if (claude) return claude;

  const rewritten = await byRewrite(userMessage);
  if (rewritten) return rewritten;

  const { messages, actions } = await resolveTools(userMessage, history, ctx);

  // The last message is already a text response (no tool calls) — return it directly
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' && !last.tool_calls?.length && last.content) {
    return { response: honestReply(last.content, actions), actions };
  }

  // Shouldn't reach here normally, but fall back to a final call
  return { response: 'Done — actions completed.', actions };
}

// ── Streaming entry point ───────────────────────────────────────

export type StreamEvent =
  /** Who answers: HomeHub's own rules, or the AI model (named). Sent first. */
  | { type: 'meta'; by: 'rules' | 'model'; model?: string }
  | { type: 'action'; action: ActionTaken }
  | { type: 'token';  content: string }
  | { type: 'done' }
  | { type: 'error';  message: string };

export async function* processMessageStream(
  userMessage: string,
  history: ChatMessage[],
  who = 'chat',
  role?: string,
): AsyncGenerator<StreamEvent> {
  const ctx: ToolContext = { who, admin: role === 'admin' };
  const answered = await byAnswer(userMessage, who);
  if (answered) {
    yield { type: 'meta', by: 'rules' };
    for (const action of answered.actions) yield { type: 'action', action };
    yield { type: 'token', content: answered.response };
    yield { type: 'done' };
    return;
  }

  const handled = await byRules(userMessage, who);
  if (handled) recordCommand(userMessage, 'rules');
  if (handled) {
    yield { type: 'meta', by: 'rules' };
    for (const action of handled.actions) yield { type: 'action', action };
    yield { type: 'token', content: handled.response };
    yield { type: 'done' };
    return;
  }

  const ollamaUrl = process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model     = process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  yield { type: 'meta', by: 'model', model: claudeInUse() ? CLAUDE_LABEL : model };

  const { asked, answer } = await byModelReading(userMessage, who);
  if (answer) {
    for (const action of answer.actions) yield { type: 'action', action };
    yield { type: 'token', content: answer.response };
    yield { type: 'done' };
    return;
  }

  const claude = await byClaudeChat(userMessage, history, who, asked?.lang, ctx.admin);
  if (claude) {
    for (const action of claude.actions) yield { type: 'action', action };
    yield { type: 'token', content: claude.response };
    yield { type: 'done' };
    return;
  }

  const rewritten = await byRewrite(userMessage);
  if (rewritten) {
    for (const action of rewritten.actions) yield { type: 'action', action };
    yield { type: 'token', content: rewritten.response };
    yield { type: 'done' };
    return;
  }

  let messages: OllamaMessage[];
  let actions: ActionTaken[];

  try {
    ({ messages, actions } = await resolveTools(userMessage, history, ctx));
  } catch (err: any) {
    logger.warn({ reason: err?.message }, 'Chat model not answering');
    yield { type: 'error', message: chatModelDown(userMessage) };
    return;
  }

  // Emit each action taken
  for (const action of actions) yield { type: 'action', action };

  // Check if last message already has text (resolveTools returned early on final text)
  const last = messages[messages.length - 1];
  if (last.role === 'assistant' && !last.tool_calls?.length && last.content) {
    // Stream it character-by-character to simulate streaming from cache
    // (In practice resolveTools already made the final non-streaming call)
    yield { type: 'token', content: honestReply(last.content, actions) };
    yield { type: 'done' };
    return;
  }

  // A switch was tried and none worked: the answer is checked whole before
  // it's shown, so it can't say otherwise. (Streaming can't be taken back.)
  if (actions.some((a) => a.tool === 'set_power_state') && !switchedAnything(actions)) {
    let answer = '';
    try {
      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, messages, stream: false, keep_alive: keepAlive(), options: { num_predict: MAX_REPLY_TOKENS } }),
      });
      if (res.ok) answer = ((await res.json()) as any).message?.content ?? '';
    } catch { /* answered below */ }
    yield { type: 'token', content: answer ? honestReply(answer, actions) : didntSwitch(actions) };
    yield { type: 'done' };
    return;
  }

  // Stream final response from Ollama
  let streamRes: Response;
  try {
    streamRes = await fetch(`${ollamaUrl}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model, messages, stream: true, keep_alive: keepAlive(), options: { num_predict: MAX_REPLY_TOKENS } }),
    });
    if (!streamRes.ok) throw new Error(`Ollama error ${streamRes.status}`);
  } catch (err: any) {
    logger.warn({ reason: err?.message }, 'Chat model not answering');
    yield { type: 'error', message: chatModelDown(userMessage) };
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
            if (looksLikeToolCall(trimmed, TOOL_NAMES)) {
              // Model output a tool call as text — emit a fallback message instead
              yield { type: 'error', message: NOT_UNDERSTOOD };
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
