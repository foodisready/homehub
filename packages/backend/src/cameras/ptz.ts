import { logger } from '../logger';
import { BridgeError, go2rtcUrl, type BridgeCamera } from './bridge';

/**
 * Pan and tilt for Wyze Pan cameras, through HomeHub's go2rtc build
 * (packages/wyze-bridge), which adds api/wyze/ptz.
 *
 * A move starts the lens turning, and a Pan v3 keeps turning until it is
 * told to stop or reaches the end of its range. Live view sends the move
 * while an arrow is held, repeats it to say the arrow is still held, and
 * sends stop when it's let go. If the repeats stop arriving, because the
 * page closed or the network dropped, HomeHub stops the camera itself.
 */

export type PtzAction = 'left' | 'right' | 'up' | 'down' | 'stop';
export const PTZ_ACTIONS: readonly PtzAction[] = ['left', 'right', 'up', 'down', 'stop'];

/** Wyze's model codes for cameras that pan and tilt. */
const PAN_MODELS = new Set(['WYZECP1_JEF', 'HL_PAN2', 'HL_PAN3', 'HL_PANP']);

export function canPan(cam: Pick<BridgeCamera, 'model' | 'modelName'> | undefined | null): boolean {
  if (!cam) return false;
  if (cam.model && PAN_MODELS.has(cam.model.toUpperCase())) return true;
  return /\bpan\b/i.test(cam.modelName ?? '');
}

/** How long a move lasts without hearing that the arrow is still held. */
const holdMs = () => Number(process.env.WYZE_PTZ_HOLD_MS) || 1500;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** Tests replace fetch. */
export function setPtzFetch(f: Fetch | null): void { fetchImpl = f ?? ((...args) => fetch(...args)); }

interface Moving { action: PtzAction; timer: NodeJS.Timeout }
const moving = new Map<string, Moving>();

async function send(cam: string, action: PtzAction): Promise<void> {
  const url = `${go2rtcUrl()}/api/wyze/ptz?src=${encodeURIComponent(cam)}&action=${action}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new BridgeError(`The camera bridge isn't answering (${(err as Error).message})`, 502);
  }
  if (res.ok) return;
  const body = (await res.text().catch(() => '')).trim();
  if (res.status === 404 && !/no such wyze stream/i.test(body)) {
    // An older bridge image, without HomeHub's go2rtc.
    throw new BridgeError('This camera bridge can\'t turn cameras yet. Update HomeHub.', 501);
  }
  if (res.status === 404) throw new BridgeError('The camera bridge doesn\'t have this camera', 404);
  throw new BridgeError(`The camera didn't turn: ${body || `HTTP ${res.status}`}`, 502);
}

function clearHold(cam: string): void {
  const m = moving.get(cam);
  if (m) clearTimeout(m.timer);
  moving.delete(cam);
}

/**
 * Start turning, keep turning (the same action again), or stop. A repeat of
 * the move already under way only extends it; the camera is already turning.
 */
export async function ptz(cam: string, action: PtzAction): Promise<void> {
  const current = moving.get(cam);
  if (action === 'stop') {
    clearHold(cam);
    await send(cam, 'stop');
    return;
  }
  if (current?.action === action) {
    current.timer.refresh();
    return;
  }
  clearHold(cam);
  await send(cam, action);
  const timer = setTimeout(() => {
    if (moving.get(cam)?.timer !== timer) return;
    moving.delete(cam);
    send(cam, 'stop').catch((err) => logger.warn({ cam, reason: (err as Error).message }, 'Couldn\'t stop a camera that was left turning'));
  }, holdMs());
  timer.unref();
  moving.set(cam, { action, timer });
}

/** Whether this move is already under way, so a repeat needn't check the camera again. */
export function isMoving(cam: string, action: PtzAction): boolean {
  return moving.get(cam)?.action === action;
}

/** For tests. */
export function resetPtz(): void {
  for (const cam of [...moving.keys()]) clearHold(cam);
}
