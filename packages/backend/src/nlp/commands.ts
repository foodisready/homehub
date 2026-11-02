import { applyPower, assistantMaySwitch, type PowerDevice } from '../devices/power';
import { findDeviceByName, findDeviceGroup, findScene, type NamedScene } from './find-device';
import { getDb } from '../db';
import type { ActionTaken } from './nlp.service';
import { withActivity } from '../activity/activity';

export interface PowerCommand {
  name:     string;
  state:    boolean;
  minutes?: number;
}

const MAX_MINUTES = 24 * 60;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90,
};

const NUMBER = `\\d+(?:\\.\\d+)?|forty five|${Object.keys(NUMBER_WORDS).join('|')}`;

const DURATION = new RegExp(
  `^(${NUMBER})(\\s+and\\s+a\\s+half)?\\s*(hours?|hrs?|h|minutes?|mins?|m)` +
  `(?:\\s+and\\s+a\\s+half|\\s+and\\s+(${NUMBER})\\s*(?:minutes?|mins?|m))?$`
);

const toNumber = (text: string) => NUMBER_WORDS[text] ?? Number(text);

export function parseDuration(text: string): number | null {
  if (/^half\s+(an\s+)?hour$/.test(text)) return 30;

  const match = text.match(DURATION);
  if (!match) return null;

  const [whole, amount, leadingHalf, unit, extraMinutes] = match;
  const half = leadingHalf || whole.endsWith('half') ? 0.5 : 0;
  const minutesPerUnit = unit.startsWith('h') ? 60 : 1;
  return (toNumber(amount) + half) * minutesPerUnit + (extraMinutes ? toNumber(extraMinutes) : 0);
}

function cleanUp(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.!?,]+$/, '')
    .replace(/^(?:(?:hey\s+)?homehub[,\s]+)?(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?)?/, '')
    .replace(/\s+please$/, '')
    .trim();
}

/**
 * Read a simple on or off command. Anything else returns null and goes to the
 * chat model, so this only accepts wording whose meaning is certain.
 */
export function parsePowerCommand(text: string): PowerCommand | null {
  const match = cleanUp(text).match(
    /^(.+?)(?:,?\s+(?:and\s+)?(?:(?:leave|keep)\s+(?:it|them)\s+on\s+)?for\s+(.+))?$/
  );
  if (!match) return null;
  const [, command, duration] = match;

  let minutes: number | undefined;
  if (duration !== undefined) {
    const parsed = parseDuration(duration);
    if (!parsed || parsed > MAX_MINUTES) return null;
    minutes = parsed;
  }

  const stateFirst = command.match(/^(?:turn|switch)\s+(on|off)\s+(.+)$/);
  const stateLast  = command.match(/^(turn|switch|keep|leave)\s+(.+?)\s+(on|off)$/);

  let name: string;
  let state: boolean;
  if (stateFirst) {
    state = stateFirst[1] === 'on';
    name  = stateFirst[2];
  } else if (stateLast) {
    state = stateLast[3] === 'on';
    name  = stateLast[2];
    const holds = stateLast[1] === 'keep' || stateLast[1] === 'leave';
    if (holds && (!state || !minutes)) return null;
  } else {
    return null;
  }

  // Timers only turn devices off, so "off for an hour" isn't something this can do.
  if (!state && minutes) return null;

  return minutes ? { name, state, minutes } : { name, state };
}

export function formatDuration(minutes: number): string {
  const unit = (count: number, name: string) => `${count} ${name}${count === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest  = minutes - hours * 60;
  if (!hours) return unit(rest, 'minute');
  return rest ? `${unit(hours, 'hour')} ${unit(rest, 'minute')}` : unit(hours, 'hour');
}

const joinNames = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Switches every device sharing a nickname. A protected device is left alone. */
async function runGroupCommand(
  devices: PowerDevice[],
  { state, minutes }: PowerCommand,
): Promise<{ response: string; actions: ActionTaken[] }> {
  const allowed   = devices.filter((d) => assistantMaySwitch(d, state));
  const protectedNames = devices.filter((d) => !assistantMaySwitch(d, state)).map((d) => d.alias);
  const action = state ? 'on' : 'off';

  const results = await Promise.allSettled(allowed.map((d) => applyPower(d, state, minutes)));
  const actions: ActionTaken[] = results.map((result, i) => {
    const args = { alias: allowed[i].alias, state: action, ...(minutes ? { minutes } : {}) };
    return result.status === 'fulfilled'
      ? { tool: 'set_power_state', args, result: { success: true, ...args } }
      : { tool: 'set_power_state', args, result: { error: String(result.reason?.message ?? result.reason) } };
  });

  const switched = allowed.filter((_, i) => results[i].status === 'fulfilled').map((d) => d.alias);
  const failed   = allowed.filter((_, i) => results[i].status === 'rejected').map((d) => d.alias);
  const duration = minutes ? ` for ${formatDuration(minutes)}` : '';
  const response = [
    switched.length ? `Turned ${action} ${joinNames(switched)}${duration}.` : '',
    failed.length ? `I couldn't reach ${joinNames(failed)}.` : '',
    protectedNames.length ? `${joinNames(protectedNames)} is protected, so I left it alone.` : '',
  ].filter(Boolean).join(' ');
  return { response, actions };
}

type SceneAction = PowerDevice & { scene_state: number };

/** Runs a scene for Chat or voice, which must leave protected devices alone. */
async function runScene(scene: NamedScene): Promise<{ response: string; actions: ActionTaken[] }> {
  const devices = getDb().prepare(`
    SELECT d.*, sa.state AS scene_state
    FROM scene_actions sa JOIN devices d ON d.id = sa.device_id
    WHERE sa.scene_id = ?
  `).all(scene.id) as SceneAction[];
  if (!devices.length) return { response: `${scene.name} has no devices in it.`, actions: [] };

  const allowed = devices.filter((d) => assistantMaySwitch(d, d.scene_state === 1));
  const protectedNames = devices.filter((d) => !assistantMaySwitch(d, d.scene_state === 1)).map((d) => d.alias);

  const results = await withActivity({ source: 'scene', detail: scene.name }, () =>
    Promise.allSettled(allowed.map((d) => applyPower(d, d.scene_state === 1))));
  const actions: ActionTaken[] = results.map((result, i) => {
    const args = { alias: allowed[i].alias, state: allowed[i].scene_state === 1 ? 'on' : 'off' };
    return result.status === 'fulfilled'
      ? { tool: 'set_power_state', args, result: { success: true, ...args } }
      : { tool: 'set_power_state', args, result: { error: String(result.reason?.message ?? result.reason) } };
  });

  const failed = allowed.filter((_, i) => results[i].status === 'rejected').map((d) => d.alias);
  const ran = failed.length || protectedNames.length ? `Ran part of ${scene.name}.` : `Ran ${scene.name}.`;
  const response = [
    ran,
    failed.length ? `I couldn't reach ${joinNames(failed)}.` : '',
    protectedNames.length ? `${joinNames(protectedNames)} is protected, so I left it alone.` : '',
  ].filter(Boolean).join(' ');
  return { response, actions };
}

/** Reads "run goodnight", "activate the movie scene" or just "goodnight". */
function sceneFromText(text: string): NamedScene | null {
  const match = cleanUp(text).match(
    /^(?:(?:run|start|activate|trigger|set)\s+)?(?:the\s+)?(?:scene\s+)?(.+?)(?:\s+scene)?$/
  );
  return match ? findScene(match[1]) : null;
}

/** Answer a simple command without the chat model. Returns null if the model should handle it. */
export async function runPowerCommand(
  text: string,
): Promise<{ response: string; actions: ActionTaken[] } | null> {
  const namedScene = sceneFromText(text);
  if (namedScene) return runScene(namedScene);

  const command = parsePowerCommand(text);
  if (!command) return null;

  const group = findDeviceGroup(command.name);
  if (group.length) return runGroupCommand(group as unknown as PowerDevice[], command);

  const match = findDeviceByName(command.name);
  if ('error' in match) {
    if (!match.candidates) {
      // "Turn on movie time" means the scene if no device has that name.
      const scene = command.state && !command.minutes ? findScene(command.name) : null;
      return scene ? runScene(scene) : null;
    }
    return { response: `Which one do you mean: ${match.candidates.join(', ')}?`, actions: [] };
  }

  const device = match.device as unknown as PowerDevice;
  if (!assistantMaySwitch(device, command.state)) {
    return {
      response: `${device.alias} is protected, so Chat won't switch it. Use its tile on the dashboard.`,
      actions:  [],
    };
  }

  const { state, minutes } = command;
  const args = { alias: device.alias, state: state ? 'on' : 'off', ...(minutes ? { minutes } : {}) };

  try {
    await applyPower(device, state, minutes);
  } catch (err: any) {
    return {
      response: `I couldn't reach ${device.alias}.`,
      actions:  [{ tool: 'set_power_state', args, result: { error: err.message } }],
    };
  }

  const duration = minutes ? ` for ${formatDuration(minutes)}` : '';
  return {
    response: `Turned ${state ? 'on' : 'off'} ${device.alias}${duration}.`,
    actions:  [{ tool: 'set_power_state', args, result: { success: true, ...args } }],
  };
}
