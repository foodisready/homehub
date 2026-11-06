/**
 * Answers "which devices are on?" and "is the kitchen light on?" from
 * HomeHub's own device states, instantly and exactly, so these questions
 * never depend on a small AI model reading a long list correctly.
 */
import { getDb } from '../db';
import { getCachedState } from '../kasa/device.cache';
import { isProtectedDevice, type PowerDevice } from '../devices/power';
import { cleanUp, isCamera } from './commands';
import { NOT_A_LIGHT, findDeviceByName, findDeviceGroup, type NamedDevice } from './find-device';
import type { ActionTaken } from './nlp.service';

const TIME = String.raw`(?:\s+(?:right\s+now|now|currently|at\s+the\s+moment))?`;
const STATE = String.raw`(?:still\s+|currently\s+)?(?:turned\s+|switched\s+|left\s+)?(on|off)`;
const KIND = String.raw`(devices?|lights?|lamps?|things|plugs?)`;

// "Which devices are on right now?", "what's on?", "is anything on?", "are any lights on?"
const LIST = new RegExp(String.raw`^(?:(?:which|what)\s+(?:${KIND}\s+)?(?:are|is)|what'?s|is\s+anything|are\s+any\s+${KIND})\s+${STATE}${TIME}$`);
// "Is the kitchen light on?", "are Brenden's lamps off?"
const ONE = new RegExp(String.raw`^(?:is|are)\s+(.+?)\s+${STATE}${TIME}$`);

type Row = NamedDevice & { driver_type?: string | null; is_protected?: number };

const join = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function stateOf(d: Row): 'on' | 'off' | 'offline' {
  const c = getCachedState(d.id);
  if (!c || !c.online) return 'offline';
  return c.state ? 'on' : 'off';
}

const isLight = (d: Row) => !NOT_A_LIGHT.test(d.alias) && !isProtectedDevice(d as unknown as PowerDevice);

const listed = (devices: Row[]): ActionTaken => ({
  tool: 'list_devices', args: {},
  result: devices.map((d) => ({ id: d.id, alias: d.alias, state: stateOf(d) === 'on', online: stateOf(d) !== 'offline' })),
});

/** The answer, or null when the text isn't a question about what's on. */
export function answerStatusQuestion(text: string): { response: string; actions: ActionTaken[] } | null {
  const said = cleanUp(text).replace(/\?+$/, '').trim();

  const list = LIST.exec(said);
  if (list) {
    const kind = list[1] ?? list[2] ?? 'devices';
    const lights = /^(?:lights?|lamps?)$/.test(kind);
    const wanted = list[3] as 'on' | 'off';
    // Cameras are on whenever they aren't paused, so listing them would bury the answer.
    const all = (getDb().prepare('SELECT * FROM devices ORDER BY alias COLLATE NOCASE').all() as Row[])
      .filter((d) => !isCamera(d) && (!lights || isLight(d)));
    const match = all.filter((d) => stateOf(d) === wanted).map((d) => d.alias);
    const offline = all.filter((d) => stateOf(d) === 'offline').map((d) => d.alias);
    const what = lights ? 'lights' : 'devices';
    let response = match.length
      ? `${wanted === 'on' ? 'On' : 'Off'} now: ${join(match)}.`
      : `No ${what} are ${wanted} right now.`;
    if (offline.length) response += ` Offline, so not known: ${join(offline)}.`;
    return { response, actions: [listed(all)] };
  }

  const one = ONE.exec(said);
  if (one) {
    const name = one[1];
    if (/^(?:anything|any\s+)/.test(name)) return null;
    const group = findDeviceGroup(name) as Row[];
    const match = group.length ? null : findDeviceByName(name);
    const devices: Row[] = group.length ? group : match && 'device' in match ? [match.device as Row] : [];
    if (!devices.length) return null;   // an unclear name: leave it to the model, which can ask
    if (devices.length === 1) {
      const d = devices[0];
      const s = stateOf(d);
      return { response: s === 'offline' ? `${d.alias} is offline, so its state isn't known.` : `${d.alias} is ${s}.`, actions: [listed(devices)] };
    }
    const by = (s: string) => devices.filter((d) => stateOf(d) === s).map((d) => d.alias);
    const parts = [['On', by('on')], ['Off', by('off')], ['Offline', by('offline')]]
      .filter(([, names]) => names.length).map(([label, names]) => `${label}: ${join(names as string[])}.`);
    return { response: parts.join(' '), actions: [listed(devices)] };
  }
  return null;
}
