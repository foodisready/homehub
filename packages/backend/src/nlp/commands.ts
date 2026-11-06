import { applyPower, assistantMaySwitch, isProtectedDevice, type PowerDevice } from '../devices/power';
import { reply } from './replies';
import { findDeviceByName, findDeviceGroup, findScene, normalize, type NamedScene } from './find-device';
import { getDb } from '../db';
import type { ActionTaken } from './nlp.service';
import { currentActivity, withActivity } from '../activity/activity';
import { sendPushToAll } from '../push/push.service';
import { logger } from '../logger';

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

export function cleanUp(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[.!?,。！？，]+$/, '')
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

  // "Turn back on the cameras", "turn the cameras back on".
  const stateFirst = command.match(/^(?:turn|switch)\s+(?:back\s+)?(on|off)\s+(.+)$/);
  const stateLast  = command.match(/^(turn|switch|keep|leave)\s+(.+?)(?:\s+back)?\s+(on|off)$/);

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

/**
 * "Pause the cameras", "resume the front door camera", "unpause the cams".
 * Only cameras pause, so a name that isn't one is left for the model.
 */
export function parseCameraCommand(text: string): PowerCommand | null {
  const match = cleanUp(text).match(/^(pause|resume|unpause|un-pause)\s+(.+?)(?:\s+again)?$/);
  if (!match) return null;
  return { name: match[2], state: match[1] !== 'pause' };
}

/**
 * "The cameras", "all cameras", "every camera", "my cams": every camera,
 * unless a device or room has that very name.
 */
export function findCameras(name: string): PowerDevice[] {
  const wanted = normalize(name);
  const match = wanted.match(/^(?:(all|every)\s+(?:of\s+)?(?:the\s+|my\s+)?)?(?:the\s+|my\s+)?(cameras|cams|camera|cam)$/);
  if (!match) return [];
  const plural = match[2].endsWith('s');
  if (!plural && !match[1]) return [];   // "the camera" may mean one of several: findDeviceByName decides
  const devices = getDb().prepare('SELECT * FROM devices').all() as (PowerDevice & { room?: string | null; driver_type?: string })[];
  if (devices.some((d) => normalize(d.alias) === wanted || (typeof d.room === 'string' && normalize(d.room) === wanted))) return [];
  return devices.filter(isCamera);
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

const leftAlone = (names: string[]) =>
  names.length > 1 ? `${joinNames(names)} are protected, so I left them alone.` : `${names[0]} is protected, so I left it alone.`;

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
  // Everything switched: the chosen reply. Anything partial keeps the plain account of what happened.
  if (switched.length && !failed.length && !protectedNames.length) {
    const device = joinNames(switched);
    const plain = allowed.some((d) => isProtectedDevice(d));
    if (state && !minutes && allowed.every(isCamera)) return { response: `Resumed ${device}.`, actions };
    const response = minutes
      ? reply('timer', { device, minutes: formatDuration(minutes) }, { plain })
      : reply(state ? 'on' : 'off', { device }, { plain });
    return { response, actions };
  }
  const response = [
    switched.length ? `Turned ${action} ${joinNames(switched)}${duration}.` : '',
    failed.length ? `I couldn't reach ${joinNames(failed)}.` : '',
    protectedNames.length ? leftAlone(protectedNames) : '',
  ].filter(Boolean).join(' ');
  return { response, actions };
}

type SceneAction = PowerDevice & { scene_state: number };

export const isCamera = (device: { driver_type?: string | null }) => device.driver_type === 'wyze';

/** Said when voice or Chat is asked to pause a camera. It doesn't mention scenes, so it gives nothing away. */
export const CAMERA_PAUSE_REFUSED = "For safety, I can't pause cameras that way.";

/**
 * Whether a scene run by voice or Chat may switch this device. Cameras can
 * always be resumed; pausing one needs a scene an admin has allowed to, since
 * anyone who says the wake word could otherwise turn the cameras off.
 */
function sceneMaySwitch(device: SceneAction, mayPause: boolean): boolean {
  const on = device.scene_state === 1;
  if (assistantMaySwitch(device, on)) return true;
  return mayPause && !on && isCamera(device) && device.is_protected !== 1;
}

/** Tells everyone's phone that cameras were paused, and by what, so a stranger using the phrase is noticed. */
function notifyCamerasPaused(sceneName: string, cameras: string[]): void {
  if (!cameras.length) return;
  const source = currentActivity().source;
  const by = source === 'voice' ? 'by voice' : source === 'chat' ? 'from Chat' : '';
  const body = `${sceneName}${by ? ` (${by})` : ''} paused ${joinNames(cameras)}.`;
  try {
    sendPushToAll(cameras.length === 1 ? 'Camera paused' : 'Cameras paused', body, { url: '/cameras' });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Could not send the cameras-paused notification');
  }
}

/** Runs a scene for Chat or voice, which must leave protected devices alone. */
async function runScene(scene: NamedScene): Promise<{ response: string; actions: ActionTaken[] }> {
  const devices = getDb().prepare(`
    SELECT d.*, sa.state AS scene_state
    FROM scene_actions sa JOIN devices d ON d.id = sa.device_id
    WHERE sa.scene_id = ?
  `).all(scene.id) as SceneAction[];
  if (!devices.length) return { response: `${scene.name} has no devices in it.`, actions: [] };

  const mayPause = (getDb().prepare('SELECT voice_may_pause FROM scenes WHERE id = ?')
    .get(scene.id) as { voice_may_pause: number } | undefined)?.voice_may_pause === 1;
  const allowed = devices.filter((d) => sceneMaySwitch(d, mayPause));
  const protectedNames = devices.filter((d) => !sceneMaySwitch(d, mayPause)).map((d) => d.alias);

  const results = await withActivity({ source: 'scene', detail: scene.name }, () =>
    Promise.allSettled(allowed.map((d) => applyPower(d, d.scene_state === 1))));
  const actions: ActionTaken[] = results.map((result, i) => {
    const args = { alias: allowed[i].alias, state: allowed[i].scene_state === 1 ? 'on' : 'off' };
    return result.status === 'fulfilled'
      ? { tool: 'set_power_state', args, result: { success: true, ...args } }
      : { tool: 'set_power_state', args, result: { error: String(result.reason?.message ?? result.reason) } };
  });

  const failed = allowed.filter((_, i) => results[i].status === 'rejected').map((d) => d.alias);
  notifyCamerasPaused(scene.name, allowed.filter((d, i) =>
    isCamera(d) && d.scene_state !== 1 && results[i].status === 'fulfilled').map((d) => d.alias));
  if (!failed.length && !protectedNames.length) return { response: reply('scene', { scene: scene.name }), actions };
  const ran = `Ran part of ${scene.name}.`;
  const response = [
    ran,
    failed.length ? `I couldn't reach ${joinNames(failed)}.` : '',
    protectedNames.length ? leftAlone(protectedNames) : '',
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

  const cameraCommand = parseCameraCommand(text);
  const command = cameraCommand ?? parsePowerCommand(text);
  if (!command) return null;

  const cameras = findCameras(command.name);
  let group = cameras.length ? cameras : findDeviceGroup(command.name) as unknown as PowerDevice[];
  // "Pause the kitchen" pauses the kitchen's cameras, and nothing else.
  if (cameraCommand) group = group.filter(isCamera);
  if (group.length) {
    if (!command.state && group.every(isCamera)) return { response: CAMERA_PAUSE_REFUSED, actions: [] };
    return runGroupCommand(group, command);
  }

  const match = findDeviceByName(command.name);
  if ('error' in match) {
    if (cameraCommand) return null;
    if (!match.candidates) {
      // "Turn on movie time" means the scene if no device has that name.
      const scene = command.state && !command.minutes ? findScene(command.name) : null;
      return scene ? runScene(scene) : null;
    }
    return { response: `Which one do you mean: ${match.candidates.join(', ')}?`, actions: [] };
  }

  const device = match.device as unknown as PowerDevice;
  if (cameraCommand && !isCamera(device)) return null;
  if (!command.state && isCamera(device)) return { response: CAMERA_PAUSE_REFUSED, actions: [] };
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

  const plain = isProtectedDevice(device);
  if (state && !minutes && isCamera(device)) return { response: `Resumed ${device.alias}.`, actions: [{ tool: 'set_power_state', args, result: { success: true, ...args } }] };
  return {
    response: minutes
      ? reply('timer', { device: device.alias, minutes: formatDuration(minutes) }, { plain })
      : reply(state ? 'on' : 'off', { device: device.alias }, { plain }),
    actions:  [{ tool: 'set_power_state', args, result: { success: true, ...args } }],
  };
}
