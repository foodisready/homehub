/**
 * Scores ways of understanding commands against a test set, on a copy of a home's names in a temp
 * database with stubbed drivers: nothing real is switched, and the real database is never opened.
 *
 *   node dist/nlp/eval/run-eval.js --cases commands.json --home home.json --out results.json \
 *     --systems rules-0.1.86,rules,structured,rules+structured,chat \
 *     [--ollama http://127.0.0.1:11500] [--model qwen2.5:1.5b] [--only heard]
 *
 * A system's outcome is what it switched, and how: a case passes when that is what the label says
 * (see the test set's "about"). The test set and the home live in the private homehub-business repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Expect =
  | { kind: 'switch'; state: 'on' | 'off'; sets: string[][]; ask_ok?: boolean }
  | { kind: 'refuse' }
  | { kind: 'none' };
interface Case { id: string; source: string; lang: string; text: string; expect: Expect }
interface Switched { alias: string; state: boolean }
interface Outcome { switched: Switched[]; response: string; ms: number; by?: string; error?: string; asked?: string; askRight?: boolean; learned?: string | null }
interface HomeFile {
  devices: { alias: string; nicknames: string[]; room: string | null; driver_type: string | null; is_protected: number }[];
  scenes: { name: string; nicknames: string[] }[];
}

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

export function passes(expect: Expect, out: Outcome): boolean {
  const sw = out.switched;
  if (out.error) return false;
  if (expect.kind !== 'switch') return sw.length === 0;
  if (!sw.length) return !!expect.ask_ok && /\?|？/.test(out.response);
  const want = expect.state === 'on';
  if (sw.some((s) => s.state !== want)) return false;
  const got = [...new Set(sw.map((s) => s.alias))].sort().join('|');
  return expect.sets.some((set) => [...set].sort().join('|') === got);
}

async function main() {
  const casesFile = arg('cases'), homeFile = arg('home'), outFile = arg('out');
  if (!casesFile || !homeFile || !outFile) throw new Error('--cases, --home and --out are needed');
  const systems = (arg('systems', 'rules')!).split(',');
  const only = arg('only');
  const ollama = arg('ollama', 'http://127.0.0.1:11500')!;
  const model = arg('model', 'qwen2.5:1.5b')!;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homehub-eval-'));
  process.env.DB_PATH = path.join(tmp, 'db.sqlite');
  process.env.OLLAMA_URL = ollama;
  process.env.OLLAMA_MODEL = model;
  process.env.SCHEDULER_URL = 'http://127.0.0.1:1';

  const { getDb } = await import('../../db');
  const { getAllDrivers } = await import('../../drivers/registry');
  const commands = await import('../commands');
  const native = await import('../native-commands');
  const { answerStatusQuestion } = await import('../status');
  const { answerQuestion } = await import('../questions');
  const { answerNativeQuestion } = await import('../native-questions');
  const nlp = await import('../nlp.service');
  const understand = await import('../understand');
  const confirmMod = await import('../confirm');

  const home = JSON.parse(fs.readFileSync(homeFile, 'utf8')) as HomeFile;
  const db = getDb();
  const byIp = new Map<string, string>();
  const add = db.prepare('INSERT INTO devices (alias, ip, nicknames, room, driver_type, is_protected) VALUES (?, ?, ?, ?, ?, ?)');
  home.devices.forEach((d, i) => {
    const ip = `10.99.0.${i + 1}`;
    byIp.set(ip, d.alias);
    add.run(d.alias, ip, JSON.stringify(d.nicknames ?? []), d.room, d.driver_type ?? 'kasa', d.is_protected ? 1 : 0);
  });
  for (const s of home.scenes) db.prepare('INSERT INTO scenes (name, nicknames) VALUES (?, ?)').run(s.name, JSON.stringify(s.nicknames ?? []));
  /** Back to the home's own nicknames: what one system learned mustn't help the next. */
  const reseed = () => {
    const put = db.prepare('UPDATE devices SET nicknames = ? WHERE alias = ?');
    for (const d of home.devices) put.run(JSON.stringify(d.nicknames ?? []), d.alias);
  };

  let switched: Switched[] = [];
  for (const driver of getAllDrivers()) {
    driver.setPower = async (ip: string, state: boolean) => { switched.push({ alias: byIp.get(ip) ?? ip, state }); };
  }
  const { NOT_A_LIGHT } = await import('../find-device');
  // As "<room> lights" reads in HomeHub: not a camera, a garage door, a valve or a protected device.
  const light = (d: HomeFile['devices'][number]) =>
    d.driver_type !== 'wyze' && d.driver_type !== 'meross' && !d.is_protected && !NOT_A_LIGHT.test(d.alias);
  const names = { devices: home.devices.map((d) => ({ alias: d.alias, nicknames: d.nicknames ?? [], room: d.room, light: light(d) })), scenes: home.scenes };
  const isDoor = (alias: string) => home.devices.find((d) => d.alias === alias)?.driver_type === 'meross';

  const rules086 = async (t: string) => await commands.runPowerCommand(t) ?? answerStatusQuestion(t) ?? await answerQuestion(t);
  const rules = async (t: string) => await commands.runPowerCommand(t) ?? await native.runNativeCommand(t) ?? answerStatusQuestion(t) ?? await answerQuestion(t) ?? await answerNativeQuestion(t);

  /** What HomeHub would do with the form: switch the named devices (a garage door only closes). */
  const claudeModel = arg('claude-model', 'claude-haiku-5-5')!;
  const tokens = { input: 0, output: 0 };
  const askOllama = (t: string) => understand.understandWithOllama(t, names, { url: ollama, model });
  const askClaude = async (t: string) => {
    const r = await understand.understandWithClaude(t, names, { model: claudeModel });
    tokens.input += r.inputTokens ?? 0;
    tokens.output += r.outputTokens ?? 0;
    return r;
  };
  async function structured(t: string, ask: (t: string) => Promise<import('../understand').UnderstandResult> = askOllama): Promise<{ response: string; by: string; error?: string }> {
    const r = await ask(t);
    const u = r.understanding;
    if (!u) return { response: '', by: 'structured', error: r.error ?? 'no form' };
    const by = `structured:${u.action}:${u.lang}`;
    if ((u.action === 'on' || u.action === 'off' || u.action === 'close') && u.devices.length) {
      const state = u.action === 'on';
      // Opening is refused; "on" for a garage door means open, so it's refused too.
      const devices = u.devices.filter((a) => !(isDoor(a) && state));
      if (u.action === 'close' && devices.some((a) => !isDoor(a))) return { response: 'unclear', by };
      const result = await commands.runGroupCommand(
        db.prepare(`SELECT * FROM devices WHERE alias IN (${devices.map(() => '?').join(',') || "''"})`).all(...devices) as never,
        { name: devices.join(', '), state, ...(u.minutes && state ? { minutes: u.minutes } : {}) },
      );
      return { response: result.response, by };
    }
    if (u.action === 'unclear') return { response: 'Which one do you mean?', by };
    return { response: u.action, by };
  }

  /**
   * "Did you mean…?" (confirm.ts): the model only proposes, and a stand-in for the person answers:
   * yes when the proposal is what the label says, no otherwise. A yes switches and may teach a nickname.
   */
  let current: Case | null = null;
  async function withAsk(t: string, ask: (t: string) => Promise<import('../understand').UnderstandResult>, thenChat = false):
    Promise<{ response: string; by?: string; error?: string; asked?: string; askRight?: boolean; learned?: string | null }> {
    const r = await rules(t);
    if (r) return { response: r.response, by: 'rules' };
    const m = await ask(t);
    if (!m.understanding) return { response: '', by: 'model', error: m.error ?? 'no form' };
    const reading = confirmMod.propose(t, m.understanding);
    const by = `ask:${m.understanding.action}:${m.understanding.lang}`;
    // Chat as it would run: a question, or anything the form couldn't place, goes on to today's chat.
    if (!reading && thenChat) { const r = await nlp.processMessage(t, []); return { response: r.response, by: `${by}>chat` }; }
    if (!reading) return { response: 'Which one do you mean?', by };
    if (reading.kind === 'refuse') return { response: confirmMod.refusedText(reading), by };
    const asked = confirmMod.askText(reading.proposal);
    const e = current!.expect;
    const right = e.kind === 'switch' && e.sets.some((set) => confirmMod.sameProposal(reading.proposal, set, e.state === 'on'));
    if (!right) return { response: confirmMod.declined(reading.proposal), by, asked, askRight: false };
    const done = await confirmMod.confirm(reading.proposal);
    return { response: done.response, by, asked, askRight: true, learned: done.learned };
  }

  const run: Record<string, (t: string) => Promise<{ response: string; by?: string; error?: string; asked?: string; askRight?: boolean; learned?: string | null }>> = {
    'rules+structured+ask': (t) => withAsk(t, askOllama),
    'rules+claude+ask': (t) => withAsk(t, askClaude),
    'rules+structured+ask+chat': (t) => withAsk(t, askOllama, true),
    'rules-0.1.86': async (t) => ({ response: (await rules086(t))?.response ?? '', by: 'rules' }),
    rules: async (t) => ({ response: (await rules(t))?.response ?? '', by: 'rules' }),
    structured: (t) => structured(t),
    'rules+structured': async (t) => { const r = await rules(t); return r ? { response: r.response, by: 'rules' } : structured(t); },
    claude: (t) => structured(t, askClaude),
    'rules+claude': async (t) => { const r = await rules(t); return r ? { response: r.response, by: 'rules' } : structured(t, askClaude); },
    chat: async (t) => { const r = await nlp.processMessage(t, []); return { response: r.response, by: 'chat' }; },
  };

  const all = (JSON.parse(fs.readFileSync(casesFile, 'utf8')) as { cases: Case[] }).cases;
  const cases = only ? all.filter((c) => c.source === only || c.lang === only || c.id === only) : all;
  const report: Record<string, unknown> = { model, made: new Date().toISOString(), systems: {} };

  for (const system of systems) {
    const fn = run[system];
    if (!fn) throw new Error(`Unknown system ${system}`);
    const rows: (Case & Outcome & { pass: boolean })[] = [];
    reseed();
    for (const c of cases) {
      current = c;
      db.prepare('UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL').run();
      switched = [];
      const t0 = Date.now();
      let out: Outcome;
      try {
        const r = await fn(c.text);
        out = { switched: [...switched], response: r.response, ms: Date.now() - t0, by: r.by, error: r.error, asked: r.asked, askRight: r.askRight, learned: r.learned };
      } catch (err) {
        out = { switched: [...switched], response: '', ms: Date.now() - t0, error: (err as Error).message };
      }
      rows.push({ ...c, ...out, pass: passes(c.expect, out) });
      process.stderr.write(rows[rows.length - 1].pass ? '.' : 'x');
    }
    process.stderr.write('\n');
    const groups: Record<string, { pass: number; n: number }> = {};
    for (const r of rows) for (const g of ['all', r.source, `${r.source}/${r.lang}`]) {
      groups[g] ??= { pass: 0, n: 0 };
      groups[g].n++;
      if (r.pass) groups[g].pass++;
    }
    // Worse than not understanding: something was switched, and it wasn't what was asked.
    const wrong = rows.filter((r) => !r.pass && r.switched.length).length;
    const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
    const asking = system.includes('+ask') ? {
      rightAtOnce:  rows.filter((r) => r.pass && !r.asked).length,
      rightAsked:   rows.filter((r) => r.pass && r.askRight).length,
      askedWrong:   rows.filter((r) => r.asked && !r.askRight).length,
      learned:      [...new Set(rows.map((r) => r.learned).filter(Boolean))],
    } : undefined;
    // A week later: the same commands, with only the rules and what was learned.
    let afterwards: { pass: number; wrong: number } | undefined;
    if (asking) {
      let pass = 0, wrongLater = 0;
      for (const c of cases) {
        db.prepare('UPDATE devices SET override_state = NULL, override_until = NULL, timer_off_at = NULL').run();
        switched = [];
        const r = await rules(c.text);
        const out: Outcome = { switched: [...switched], response: r?.response ?? '', ms: 0 };
        if (passes(c.expect, out)) pass++;
        else if (out.switched.length) wrongLater++;
      }
      afterwards = { pass, wrong: wrongLater };
    }
    (report.systems as Record<string, unknown>)[system] = { groups, wrong, medianMs: ms[Math.floor(ms.length / 2)], asking, afterwards, rows };
    console.log(`${system.padEnd(18)} wrong ${wrong}  ${Object.entries(groups).map(([g, v]) => `${g} ${v.pass}/${v.n}`).join('  ')}  median ${ms[Math.floor(ms.length / 2)]} ms`);
    if (asking) console.log(`  right at once ${asking.rightAtOnce}, right after a yes ${asking.rightAsked}, asked wrongly ${asking.askedWrong}, phrases learned ${asking.learned.length}; afterwards rules alone ${afterwards!.pass}/${cases.length}, wrong ${afterwards!.wrong}`);
  }
  if (tokens.input) {
    report.claudeTokens = tokens;
    console.log(`Claude (${claudeModel}): ${tokens.input} input and ${tokens.output} output tokens`);
  }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => { console.error(err); process.exit(1); });
