/**
 * Understanding a command with a model that must fill in a form, rather than chat and call tools:
 *
 *   "tắt đèn phòng khách"  →  { action: 'off', target: 'Living room lights', lang: 'vi' }
 *
 * The form's target only accepts the home's own devices and rooms (the model server enforces the
 * schema), so a model can't make a name up, and the language it was asked in stops mattering:
 * HomeHub writes the reply itself. Small models are far more reliable at this than at a free
 * conversation with tools, and it's one short answer, so it's quick.
 *
 * A prototype for the command test set (homehub-business/evals); not used by Chat or voice yet.
 */

export const ACTIONS = ['on', 'off', 'open', 'close', 'scene', 'question', 'unclear'] as const;
export const LANGS = ['en', 'yue', 'zh', 'vi'] as const;

export interface Understanding {
  action:  typeof ACTIONS[number];
  /** The devices the chosen target means: one device, or a room's lights. */
  devices: string[];
  scene:   string | null;
  minutes: number | null;
  lang:    typeof LANGS[number];
}

export interface HomeNames {
  /** light: whether "<room> lights" includes it (not a camera, door, valve or protected device). */
  devices: { alias: string; nicknames: string[]; room: string | null; light?: boolean; on?: boolean }[];
  scenes:  { name: string; nicknames: string[] }[];
}

/**
 * What a message can mean: each device, and each room's lights. The model picks one. A list of
 * devices would let it pick several, and small models, Ollama 0.35's especially, then keep adding
 * names until the answer runs out (every device in the house for "tắt hết đèn phòng khách").
 */
export interface Target { label: string; devices: string[]; about: string }

export function targets(home: HomeNames): Target[] {
  const list: Target[] = home.devices.map((d) => ({
    label:   d.alias,
    devices: [d.alias],
    about:   [d.room ? `room: ${d.room}` : '', d.nicknames.length ? `also called: ${d.nicknames.join(', ')}` : '',
      d.on === undefined ? '' : d.on ? 'now on' : 'now off'].filter(Boolean).join('; '),
  }));
  const taken = new Set(list.map((t) => t.label.toLowerCase()));
  const rooms = [...new Set(home.devices.map((d) => d.room).filter((r): r is string => !!r))];
  for (const room of rooms) {
    const lights = home.devices.filter((d) => d.room === room && d.light !== false).map((d) => d.alias);
    const label = `${room} lights`;
    if (lights.length < 2 || taken.has(label.toLowerCase())) continue;
    list.push({ label, devices: lights, about: `all of: ${lights.join(', ')}` });
    taken.add(label.toLowerCase());
  }
  return list;
}

/** The form, as a JSON schema. The target and scene can only be the home's own. */
export function understandingSchema(home: HomeNames) {
  const scenes = home.scenes.map((s) => s.name);
  return {
    type: 'object',
    properties: {
      action:  { type: 'string', enum: [...ACTIONS] },
      target:  { anyOf: [{ type: 'string', enum: targets(home).map((t) => t.label) }, { type: 'null' }] },
      scene:   scenes.length ? { anyOf: [{ type: 'string', enum: scenes }, { type: 'null' }] } : { type: 'null' },
      minutes: { anyOf: [{ type: 'integer', minimum: 1, maximum: 1440 }, { type: 'null' }] },
      lang:    { type: 'string', enum: [...LANGS] },
    },
    required: ['action', 'target', 'scene', 'minutes', 'lang'],
    additionalProperties: false,
  };
}

/** Each target with what it is, one line each, as the model sees them. */
export function catalog(home: HomeNames): string {
  const lines = targets(home).map((t) => `- ${t.label}${t.about ? ` (${t.about})` : ''}`);
  const scenes = home.scenes.map((s) => `- ${s.name}${s.nicknames.length ? ` (also called: ${s.nicknames.join(', ')})` : ''}`);
  return `Targets:\n${lines.join('\n')}\n\nScenes:\n${scenes.length ? scenes.join('\n') : '(none)'}`;
}

/**
 * For a spoken command: the wake word was said just before it, and speech recognition can catch its
 * end at the start of the words, misheard. Heard on the Pi: "冇有熄啊亮灯" after 老友, which Claude read
 * as "didn't turn off A-Leung's lamp", unclear. Told this, it reads 熄啊亮灯, off.
 */
export function wakeNote(wake: string): string {
  return `\n\nThis message was spoken to a speaker straight after its wake word, "${wake}". Speech recognition sometimes catches the end of the wake word at the start of the message, misheard: after 老友 it can come out as 冇有 or 老有, after Xin Chào as chào. Words at the start that sound like the wake word are not part of the message: "冇有熄啊亮灯" after 老友 is 熄啊亮灯, off. Only those: 有冇, the other way round, is the usual way to ask, so 有冇 with any on or off word ("有冇開廚房燈？", "有冇熄啊亮燈呀？", "有冇閂燈？") asks whether a light is on or off, a question.`;
}

export function understandPrompt(home: HomeNames): string {
  return `You read one message to a smart home and fill in a form saying what it asks for. Messages come in English, Cantonese, Mandarin or Vietnamese, often from speech recognition, so expect misheard words and simplified characters for Cantonese.

action:
- on / off: switch something on or off (開, 着, 打开, bật, mở = on; 關, 熄, 关, 閂, tắt = off)
- open / close: a garage door (開車房門, mở cửa ga-ra = open; 關/鎖車房門, đóng cửa ga-ra = close)
- scene: run one of the scenes
- question: a question, such as the time or what's on
- unclear: anything else, or you can't tell what is meant

target: the one device, or the one room's lights, that the message means, written exactly as in the list. A device's other names and its room count. null for a question, a scene, or unclear.
"now on" or "now off" in the list is how a device is at the moment. A clear on or off word is read as said, even if it's already so. When the word for on or off was misheard and can't be made out, but the device is clear, the person most likely wants to change it: "欧亮灯" (啊亮燈, its word lost) is off when that lamp is now on, and on when it's now off.
minutes: only if a length of time is said ("for 10 minutes", 十分鐘, mười phút), else null.
lang: the language of the message: en, yue (Cantonese), zh (Mandarin), vi (Vietnamese).

${catalog(home)}`;
}

export interface UnderstandResult {
  understanding: Understanding | null;
  ms:            number;
  error?:        string;
}

/** Actions that never lead to a question: the form stops being written once it says one of these. */
const NOTHING_TO_SWITCH = new Set<string>(['scene', 'question', 'unclear']);

/**
 * Asks a local model through Ollama, with the form as its required output format.
 *
 * The answer streams in, action first. When the action is a question, a scene or unclear,
 * nothing will be switched, so HomeHub stops the model there: on a Pi 4, writing the rest of
 * the form takes about 10 s that "幾點" would otherwise wait before the chat model answers it.
 */
export async function understandWithOllama(
  text: string,
  home: HomeNames,
  opts: { url: string; model: string; fetchImpl?: typeof fetch; keepAlive?: string },
): Promise<UnderstandResult> {
  const t0 = Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const stop = new AbortController();
  try {
    const res = await doFetch(`${opts.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        stream: true,
        format: understandingSchema(home),
        keep_alive: opts.keepAlive ?? '30m',
        options: { temperature: 0, num_predict: 80 },
        messages: [{ role: 'system', content: understandPrompt(home) }, { role: 'user', content: text }],
      }),
      signal: stop.signal,
    });
    if (!res.ok) return { understanding: null, ms: Date.now() - t0, error: `Ollama ${res.status}: ${await res.text()}` };

    let form = '';
    for await (const chunk of ollamaChunks(res)) {
      form += chunk;
      const action = /^\s*\{\s*"action"\s*:\s*"([a-z]+)"/.exec(form)?.[1];
      if (action && NOTHING_TO_SWITCH.has(action)) {
        stop.abort();   // Ollama stops generating when the request goes away
        return {
          understanding: { action: action as Understanding['action'], devices: [], scene: null, minutes: null, lang: 'en' },
          ms: Date.now() - t0,
        };
      }
    }
    return { understanding: parseUnderstanding(form, home), ms: Date.now() - t0 };
  } catch (err) {
    return { understanding: null, ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** The text of each piece of an Ollama /api/chat stream (one JSON object per line). */
async function* ollamaChunks(res: Response): AsyncGenerator<string> {
  if (!res.body) {
    // A test double may give the whole answer at once.
    const data = await res.json() as { message?: { content?: string } };
    yield data.message?.content ?? '';
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = done ? '' : lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const piece = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (piece.error) throw new Error(`Ollama: ${piece.error}`);
        if (piece.message?.content) yield piece.message.content;
      } catch (err) {
        if ((err as Error).message.startsWith('Ollama:')) throw err;   // a malformed line is skipped
      }
    }
    if (done) return;
  }
}

/**
 * Asks Claude, with the same form as structured output. The key is the household's own, from
 * Settings (ai-choice.ts), or, without one, ANTHROPIC_API_KEY (the eval).
 * Effort is low: this is a short classification, not reasoning.
 */
export async function understandWithClaude(
  text: string,
  home: HomeNames,
  opts: { model?: string; apiKey?: string; timeoutMs?: number; wake?: string } = {},
): Promise<UnderstandResult & { inputTokens?: number; outputTokens?: number; status?: number }> {
  const t0 = Date.now();
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  // A person is waiting: one quick retry, then this HomeHub's own model takes over.
  const client = new Anthropic({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.timeoutMs ? { timeout: opts.timeoutMs, maxRetries: 1 } : {}),
  });
  // Number limits aren't needed for the API's structured output; HomeHub checks them anyway.
  const schema = JSON.parse(JSON.stringify(understandingSchema(home)).replace(/,"minimum":1,"maximum":1440/g, ''));
  try {
    const res = await client.messages.create({
      model: opts.model ?? 'claude-haiku-5-5',
      max_tokens: 1024,
      system: understandPrompt(home) + (opts.wake ? wakeNote(opts.wake) : ''),
      messages: [{ role: 'user', content: text }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    });
    const usage = { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    if (res.stop_reason === 'refusal') return { understanding: null, ms: Date.now() - t0, error: 'refused', ...usage };
    const raw = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { understanding: parseUnderstanding(raw, home), ms: Date.now() - t0, ...usage };
  } catch (err) {
    if (err instanceof Anthropic.APIError) return { understanding: null, ms: Date.now() - t0, error: `Claude ${err.status}: ${err.message}`, ...(err.status !== undefined ? { status: err.status } : {}) };
    return { understanding: null, ms: Date.now() - t0, error: (err as Error).message };
  }
}

/** The model's form, checked again here: anything outside the schema counts as unclear. */
export function parseUnderstanding(raw: string, home: HomeNames): Understanding | null {
  let v: { action?: unknown; target?: unknown; scene?: unknown; minutes?: unknown; lang?: unknown };
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || !ACTIONS.includes(v.action as Understanding['action'])) return null;
  const target = targets(home).find((t) => t.label === v.target);
  const scenes = new Set(home.scenes.map((s) => s.name));
  return {
    action:  v.action as Understanding['action'],
    devices: target ? target.devices : [],
    scene:   typeof v.scene === 'string' && scenes.has(v.scene) ? v.scene : null,
    minutes: Number.isInteger(v.minutes) && (v.minutes as number) > 0 ? v.minutes as number : null,
    lang:    LANGS.includes(v.lang as Understanding['lang']) ? v.lang as Understanding['lang'] : 'en',
  };
}
