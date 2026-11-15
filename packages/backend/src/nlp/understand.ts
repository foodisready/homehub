/**
 * Understanding a command with a model that must fill in a form, rather than chat and call tools:
 *
 *   "bật đèn bếp"  →  { action: 'on', devices: ['Kitchen lights', 'Kitchen counter lights'], lang: 'vi' }
 *
 * The form's device field only accepts the home's real device names (the model server enforces
 * the schema), so a model can't make a name up, and the language it was asked in stops mattering:
 * HomeHub writes the reply itself. Small models are far more reliable at this than at a free
 * conversation with tools, and it's one short answer, so it's quick.
 *
 * A prototype for the command test set (homehub-business/evals); not used by Chat or voice yet.
 */

export const ACTIONS = ['on', 'off', 'open', 'close', 'scene', 'question', 'unclear'] as const;
export const LANGS = ['en', 'yue', 'zh', 'vi'] as const;

export interface Understanding {
  action:  typeof ACTIONS[number];
  devices: string[];
  scene:   string | null;
  minutes: number | null;
  lang:    typeof LANGS[number];
}

export interface HomeNames {
  devices: { alias: string; nicknames: string[]; room: string | null }[];
  scenes:  { name: string; nicknames: string[] }[];
}

/** The form, as a JSON schema. Device and scene names are limited to the home's own. */
export function understandingSchema(home: HomeNames) {
  const aliases = home.devices.map((d) => d.alias);
  const scenes = home.scenes.map((s) => s.name);
  return {
    type: 'object',
    properties: {
      action:  { type: 'string', enum: [...ACTIONS] },
      devices: { type: 'array', items: { type: 'string', enum: aliases } },
      scene:   scenes.length ? { anyOf: [{ type: 'string', enum: scenes }, { type: 'null' }] } : { type: 'null' },
      minutes: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1440 }, { type: 'null' }] },
      lang:    { type: 'string', enum: [...LANGS] },
    },
    required: ['action', 'devices', 'scene', 'minutes', 'lang'],
    additionalProperties: false,
  };
}

/** Each device with its room and other names, one line each, as the model sees them. */
export function catalog(home: HomeNames): string {
  const devices = home.devices.map((d) => {
    const extra = [d.room ? `room: ${d.room}` : '', d.nicknames.length ? `also called: ${d.nicknames.join(', ')}` : ''].filter(Boolean);
    return `- ${d.alias}${extra.length ? ` (${extra.join('; ')})` : ''}`;
  });
  const scenes = home.scenes.map((s) => `- ${s.name}${s.nicknames.length ? ` (also called: ${s.nicknames.join(', ')})` : ''}`);
  return `Devices:\n${devices.join('\n')}\n\nScenes:\n${scenes.length ? scenes.join('\n') : '(none)'}`;
}

export function understandPrompt(home: HomeNames): string {
  return `You read one message to a smart home and fill in a form saying what it asks for. Messages come in English, Cantonese, Mandarin or Vietnamese, often from speech recognition, so expect misheard words and simplified characters for Cantonese.

action:
- on / off: switch devices on or off (開, 着, 打开, bật, mở = on; 關, 熄, 关, 閂, tắt = off)
- open / close: a garage door (開車房門, mở cửa ga-ra = open; 關/鎖車房門, đóng cửa ga-ra = close)
- scene: run one of the scenes
- question: a question, such as the time or what's on
- unclear: anything else, or you can't tell which device is meant

devices: every device the message means, by its exact name from the list. A device's other names and its room count: "kitchen lights" in a room means the lights in that room. Leave it empty for a question, a scene, or unclear.
minutes: only if a length of time is said ("for 10 minutes", 十分鐘, mười phút), else null.
lang: the language of the message: en, yue (Cantonese), zh (Mandarin), vi (Vietnamese).

${catalog(home)}`;
}

export interface UnderstandResult {
  understanding: Understanding | null;
  ms:            number;
  error?:        string;
}

/** Asks a local model through Ollama, with the form as its required output format. */
export async function understandWithOllama(
  text: string,
  home: HomeNames,
  opts: { url: string; model: string; fetchImpl?: typeof fetch; keepAlive?: string },
): Promise<UnderstandResult> {
  const t0 = Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${opts.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        format: understandingSchema(home),
        keep_alive: opts.keepAlive ?? '30m',
        options: { temperature: 0, num_predict: 120 },
        messages: [{ role: 'system', content: understandPrompt(home) }, { role: 'user', content: text }],
      }),
    });
    if (!res.ok) return { understanding: null, ms: Date.now() - t0, error: `Ollama ${res.status}: ${await res.text()}` };
    const data = await res.json() as { message?: { content?: string } };
    return { understanding: parseUnderstanding(data.message?.content ?? '', home), ms: Date.now() - t0 };
  } catch (err) {
    return { understanding: null, ms: Date.now() - t0, error: (err as Error).message };
  }
}

/**
 * Asks Claude, with the same form as structured output. Reads the API key the SDK's usual way
 * (ANTHROPIC_API_KEY); customer boxes will go through a HomeHub relay instead (HARDWARE_PLAN.md).
 * Effort is low: this is a short classification, not reasoning.
 */
export async function understandWithClaude(
  text: string,
  home: HomeNames,
  opts: { model?: string } = {},
): Promise<UnderstandResult & { inputTokens?: number; outputTokens?: number }> {
  const t0 = Date.now();
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  // Number limits aren't needed for the API's structured output; HomeHub checks them anyway.
  const schema = JSON.parse(JSON.stringify(understandingSchema(home)).replace(/,"minimum":1,"maximum":1440/g, ''));
  try {
    const res = await client.messages.create({
      model: opts.model ?? 'claude-haiku-5-5',
      max_tokens: 1024,
      system: understandPrompt(home),
      messages: [{ role: 'user', content: text }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    });
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (res.stop_reason === 'refusal') return { understanding: null, ms: Date.now() - t0, error: 'refused', ...usage };
    const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { understanding: parseUnderstanding(raw, home), ms: Date.now() - t0, ...usage };
  } catch (err) {
    if (err instanceof Anthropic.APIError) return { understanding: null, ms: Date.now() - t0, error: `Claude ${err.status}: ${err.message}` };
    return { understanding: null, ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** The model's form, checked again here: anything outside the schema counts as unclear. */
export function parseUnderstanding(raw: string, home: HomeNames): Understanding | null {
  let v: Partial<Understanding>;
  try { v = JSON.parse(raw); } catch { return null; }
  const aliases = new Set(home.devices.map((d) => d.alias));
  const scenes = new Set(home.scenes.map((s) => s.name));
  if (!v || !ACTIONS.includes(v.action as Understanding['action'])) return null;
  const devices = Array.isArray(v.devices) ? [...new Set(v.devices.filter((d): d is string => typeof d === 'string' && aliases.has(d)))] : [];
  return {
    action:  v.action as Understanding['action'],
    devices,
    scene:   typeof v.scene === 'string' && scenes.has(v.scene) ? v.scene : null,
    minutes: Number.isInteger(v.minutes) && (v.minutes as number) > 0 ? v.minutes as number : null,
    lang:    LANGS.includes(v.lang as Understanding['lang']) ? v.lang as Understanding['lang'] : 'en',
  };
}
