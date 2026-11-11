/**
 * When HomeHub's own rules don't understand a message, a small model first
 * tries to say it again plainly, using the home's real names:
 *
 *   "turn on ffice liights for 6 min"  →  "turn on office lights for 6 minutes"
 *
 * The rules then run the plain version exactly as if it had been typed. The
 * model never switches anything itself, and it is asked for one short line,
 * so it answers in seconds even on a Raspberry Pi, where the full tool-using
 * chat can take a minute.
 *
 * A small model can be wrong, so what it says is only used when it keeps to
 * what the person wrote (isFaithful): the same on or off, the same length of
 * time, and a name made of words they typed, give or take a slip. Anything
 * else goes to the full chat model as before.
 */
import { cleanUp, parseCameraCommand, parsePowerCommand } from './commands';
import { listDeviceNames, listSceneNames, normalize } from './find-device';
import { logger } from '../logger';

export interface RewriteOptions {
  url?:       string;
  model?:     string;
  keepAlive?: string;
  /** Past this the full chat model takes over. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** The home's names, when not read from the database (tests). */
  names?:     { devices: string[]; scenes: string[] };
}

const NONE = 'NONE';

export function buildRewritePrompt(devices: string[], scenes: string[]): string {
  const list = (names: string[]) => (names.length ? names.map((n) => `- ${n}`).join('\n') : '(none)');
  return `You turn a message to a smart home into one plain command. People type fast, so fix spelling slips and odd word order, but never change what they asked for.

Reply with exactly one line, in one of these forms:
turn on <device>
turn off <device>
turn on <device> for <number> minutes
run <scene>
what's on
is <device> on
${NONE}

Always use a device, room or scene name from the lists below, written in full exactly as listed, even when they typed only part of it ("porch" for "Back Porch").
Reply ${NONE} if the message is anything else: a question about schedules, energy, sunrise or the weather, more than one command, a name you can't match, or if you aren't sure.

Devices and rooms:
${list(devices)}

Scenes:
${list(scenes)}`;
}

/** A few worked examples, with names that aren't the home's, so the format is clear. */
const EXAMPLES: Array<[string, string]> = [
  ['tunr off the porch lihgt', 'turn off porch light'],
  ['bedroom fan on for 2 hrs', 'turn on bedroom fan for 120 minutes'],
  ['wats on rite now', "what's on"],
  ['when does the sun set', NONE],
];

/** The instructions, the worked examples, then the message: the same start every time, so Ollama caches it. */
function rewriteMessages(text: string, names: { devices: string[]; scenes: string[] }) {
  return [
    { role: 'system', content: buildRewritePrompt(names.devices, names.scenes) },
    ...EXAMPLES.flatMap(([q, a]) => [{ role: 'user', content: q }, { role: 'assistant', content: a }]),
    { role: 'user', content: text },
  ];
}

/**
 * Have Ollama read the instructions now, at startup, so it has them cached
 * and the first real rewrite takes seconds rather than most of a minute.
 */
export async function primeRewrite(opts: RewriteOptions = {}): Promise<boolean> {
  const url   = opts.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model = opts.model ?? process.env.OLLAMA_REWRITE_MODEL ?? process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  const names = opts.names ?? { devices: listDeviceNames(), scenes: listSceneNames() };
  const started = Date.now();
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${url}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model, messages: rewriteMessages('hello', names), stream: false,
        ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
        options: { temperature: 0, num_predict: 1 },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5 * 60_000),
    });
    logger.info({ model, ok: res.ok, ms: Date.now() - started }, 'NLP rewrite instructions read');
    return res.ok;
  } catch (err: any) {
    logger.warn({ model, err: err.message }, 'NLP rewrite instructions not read');
    return false;
  }
}

/** The model's one line, tidied; null for NONE or anything unusable. */
export function readRewrite(output: string): string | null {
  const line = output.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  // "Turned on the lamp" is how some people say it, and how a model echoes it.
  const text = line.replace(/^["'`]+|["'`.]+$/g, '').trim().replace(/^turned\s+(on|off)\b/i, 'turn $1');
  if (!text || text.toUpperCase().startsWith(NONE) || text.length > 120) return null;
  return text;
}

/** Edits (a letter added, dropped, changed, or two swapped) to turn a into b. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const words = (text: string) => normalize(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** Slips allowed in a word of this length: none in short words, where one slip makes another word. */
const slipsFor = (word: string) => (word.length <= 3 ? 0 : word.length <= 6 ? 1 : 2);

/** Words the model may add to a name without them being typed: they don't pick out a device. */
const FILLER = new Set(['the', 'my', 'light', 'lights', 'lamp', 'lamps', 'cam', 'cams', 'camera', 'cameras']);

const sameWord = (word: string, typed: string) => editDistance(word, typed) <= slipsFor(word);

/**
 * The model's name is made of words that were typed, give or take a slip.
 * It may finish a name ("porch" → "Front Porch") only when the typed words
 * fit exactly one of the home's names, and the words it adds are from that
 * name. "kitchn" fits several kitchen names, so it may not pick one.
 */
function nameWasTyped(name: string, original: string, known: string[]): boolean {
  const typed = words(original);
  const named = words(name).filter((w) => !FILLER.has(w));
  const fromTyped = named.filter((w) => typed.some((t) => sameWord(w, t)));
  if (!fromTyped.length) return false;
  const added = named.filter((w) => !fromTyped.includes(w));
  if (!added.length) return true;

  const fits = [...new Set(known.map((n) => words(n).join(' ')))]
    .filter((n) => fromTyped.every((w) => n.split(' ').includes(w)));
  return fits.length === 1 && added.every((w) => fits[0].split(' ').includes(w));
}

// Not "open" or "close": for a door or a valve those aren't on and off.
const ON  = /\b(?:o+n+|start|resume|unpause)\b/;
const OFF = /\b(?:o+f+|stop|pause|shut|out)\b/;
const QUESTION_START = /^(?:is|are|was|were|what|whats|what's|which|when|where|why|how|who|did|does|do|can|could|should|will|would|tell|show|list)\b/;
const LATER = /\b(?:in|after)\s+(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|half|a\s+few|few)\b|\b(?:at|until|till|by)\s+\d|\b(?:tomorrow|tonight|morning|evening|afternoon|sunset|sunrise|dusk|dawn|every|daily|weekdays?|weekends?|later|o'?clock|[ap]\.?m\.?)\b/;
const DIMMING = /%|\b(?:dim|dimmer|brighten|brightness|bright|percent|colou?r|warm|cool)\b/;
const NUMBER_WORD: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};

/** Every number in the text, as typed: "6 min" gives 6, "two hours" gives 2. */
function numbersIn(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) found.push(Number(m[0]));
  for (const w of words(text)) if (w in NUMBER_WORD && w !== 'a' && w !== 'an') found.push(NUMBER_WORD[w]);
  return found;
}

/** The person gave a length of time: "for 6 min", "for an hour", "for half an hour". */
const givesDuration = (text: string) => /\bfor\s+(?:\d|a\b|an\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|half|quarter)/.test(text);

/** The model's minutes come from a number typed: as minutes, as hours, or half an hour. */
function sameDuration(minutes: number, original: string): boolean {
  if (/\bhalf\s+(?:an\s+)?h/.test(original) && minutes === 30) return true;
  const typed = numbersIn(original);
  if (/\bfor\s+an?\s+h/.test(original)) typed.push(1);
  return typed.some((n) => n === minutes || n * 60 === minutes || (n + 0.5) * 60 === minutes);
}

/**
 * Whether the model kept to what was written. Switching something by mistake
 * is worse than a slow answer, so when in doubt this says no.
 */
export function isFaithful(original: string, rewritten: string, known: string[] = []): boolean {
  const said = cleanUp(original).replace(/[?？]+$/, '');
  const asked = /[?？]\s*$/.test(original.trim()) || QUESTION_START.test(said);
  const plain = cleanUp(rewritten);

  // Questions about what's on only read, so a slip there switches nothing.
  if (/^what'?s on$/.test(plain)) return asked || /\bon\b/.test(said);
  const one = plain.match(/^is\s+(.+?)\s+on$/);
  if (one) return nameWasTyped(one[1], said, known);

  if (asked) return false;
  // Later, at a time, or every day is a schedule; dimming isn't on or off.
  // The rules only switch now, so these are the full model's.
  if (LATER.test(said) || DIMMING.test(said)) return false;

  const scene = plain.match(/^run\s+(.+)$/);
  if (scene) return nameWasTyped(scene[1], said, known);

  const command = parseCameraCommand(plain) ?? parsePowerCommand(plain);
  if (!command) return false;

  // One clear on or off in what was written, and it's the same one.
  const on = ON.test(said);
  const off = OFF.test(said);
  if (on === off || command.state !== on) return false;

  // A length of time only if one was given, and the same one.
  if (command.minutes ? !sameDuration(command.minutes, said) : givesDuration(said)) return false;

  return nameWasTyped(command.name, said, known);
}

/**
 * The message said plainly, or null when the model can't, isn't sure, takes
 * too long, or strays from what was written.
 */
export async function rewriteMessage(text: string, opts: RewriteOptions = {}): Promise<string | null> {
  const url       = opts.url ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
  const model     = opts.model ?? process.env.OLLAMA_REWRITE_MODEL ?? process.env.OLLAMA_MODEL ?? 'llama3.2:3b';
  // Generous: the full chat model it would hand over to is slower still. A Pi 4
  // reads about 14 words a second, so new instructions (names changed) take ~40 s
  // once; after that Ollama has them cached and a rewrite takes ~3 s.
  const timeoutMs = opts.timeoutMs ?? Number(process.env.OLLAMA_REWRITE_TIMEOUT_MS ?? 60_000);
  const doFetch   = opts.fetchImpl ?? fetch;
  const names     = opts.names ?? { devices: listDeviceNames(), scenes: listSceneNames() };

  const messages = rewriteMessages(text, names);

  const started = Date.now();
  try {
    const res = await doFetch(`${url}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model, messages, stream: false,
        ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
        options: { temperature: 0, num_predict: 32 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}`);
    const data = await res.json() as { message?: { content?: string } };
    const rewritten = readRewrite(data.message?.content ?? '');
    const faithful = rewritten !== null && isFaithful(text, rewritten, [...names.devices, ...names.scenes]);
    logger.info({ text, rewritten, faithful, model, ms: Date.now() - started }, 'NLP rewrite');
    return faithful ? rewritten : null;
  } catch (err: any) {
    logger.warn({ text, model, ms: Date.now() - started, err: err.message }, 'NLP rewrite failed');
    return null;
  }
}
