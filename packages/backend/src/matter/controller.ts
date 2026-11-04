import path from 'path';
import { Environment, Logger, LogLevel, StorageService, version as matterVersion } from '@matter/main';
import { ManualPairingCodeCodec, QrPairingCodeCodec, NodeId } from '@matter/main/types';
import { OnOff, GeneralCommissioning, BridgedDeviceBasicInformation, BasicInformation } from '@matter/main/clusters';
import { CommissioningController } from '@project-chip/matter.js';
import { NodeStates } from '@project-chip/matter.js/device';
import type { PairedNode, Endpoint } from '@project-chip/matter.js/device';
import { SqliteStorageDriver } from './storage';
import { logger } from '../logger';
import { getDb } from '../db';
import { backupBefore } from '../db/backup';

/**
 * HomeHub as a Matter controller. Matter devices join by pairing code: the
 * device is first set up in another Matter app (Google Home, Apple Home,
 * Alexa, SmartThings), which then shares it with HomeHub. Everything after
 * that is local: commands go straight to the device, and the device reports
 * changes back as they happen.
 *
 * The controller starts only when it's needed, so homes without Matter
 * devices don't run it.
 */

export interface MatterEndpoint {
  nodeId: string;
  endpoint: number;
  /** The device's own name, if it has one, else its product name. */
  name: string;
  vendor: string;
  product: string;
}

export class MatterError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Listener = (nodeId: string, endpoint: number, on: boolean) => void;

let controller: CommissioningController | null = null;
let starting: Promise<CommissioningController> | null = null;
let pairing = false;
const listeners = new Set<Listener>();
const nodes = new Map<string, PairedNode>();
/** Nodes whose connection is starting, so two callers share it. */
const connecting = new Map<string, Promise<PairedNode>>();

/** Told whenever a Matter device reports being switched, by anything. */
export function onMatterSwitch(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function dataDir(): string {
  const db = process.env.DB_PATH || path.join(process.cwd(), 'data', 'db.sqlite');
  return path.join(path.dirname(db), 'matter');
}

/** Starts the controller, once. */
export function startController(): Promise<CommissioningController> {
  if (controller) return Promise.resolve(controller);
  starting ??= (async () => {
    // MATTER_LOG_LEVEL=info (or debug) shows matter.js's own detail when chasing a problem.
    Logger.level = ({ debug: LogLevel.DEBUG, info: LogLevel.INFO, error: LogLevel.ERROR } as Record<string, LogLevel>)[process.env.MATTER_LOG_LEVEL ?? ''] ?? LogLevel.WARN;
    guardUpgrade();
    const env = Environment.default;
    // HomeHub handles SIGTERM itself (Docker's stop): matter.js would otherwise take
    // the signal and keep the process alive, so every update waited to be killed.
    env.vars.set('runtime.signals', false);
    // Everything that matters lives in SQLite; this folder is only for anything that isn't key-value.
    env.vars.set('storage.path', dataDir());
    const storage = env.get(StorageService);
    storage.registerDriver({
      id: SqliteStorageDriver.id,
      create: (namespace) => {
        const name = typeof namespace === 'string' ? namespace : namespace.namespace;
        const driver = new SqliteStorageDriver(name);
        driver.initialize();
        return driver;
      },
    });
    storage.configuredDriver = SqliteStorageDriver.id;

    const c = new CommissioningController({
      environment: { environment: env, id: 'homehub' },
      autoConnect: false,
      // What other Matter apps show for HomeHub, e.g. in Google Home's "Linked Matter apps".
      adminFabricLabel: 'HomeHub',
      basicInformation: { vendorName: 'HomeHub', productName: 'HomeHub', nodeLabel: 'HomeHub' },
    });
    await c.start();
    controller = c;
    logger.info({ paired: c.getCommissionedNodes().length }, 'Matter controller started');
    return c;
  })().catch((err) => { starting = null; throw err; });
  return starting;
}

export const matterRunning = (): boolean => controller !== null;

/**
 * A new matter.js may rewrite its stored data the first time it starts. If
 * the version changed since pairing data was last used, back up first, so a
 * bad upgrade can be undone by restoring that backup.
 */
function guardUpgrade(): void {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'matter_js_version'").get() as { value: string } | undefined;
  const hasData = !!db.prepare('SELECT 1 FROM matter_storage LIMIT 1').get();
  if (hasData && row?.value !== matterVersion) {
    backupBefore(`matter.js-${row?.value ?? 'unknown'}-to-${matterVersion}`);
    logger.info({ from: row?.value ?? null, to: matterVersion }, 'matter.js version changed; backed up before starting');
  }
  db.prepare(`INSERT INTO settings (key, value) VALUES ('matter_js_version', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(matterVersion);
}

/** Connects to a paired device and keeps a live subscription to it. */
export async function connectNode(nodeId: string): Promise<PairedNode> {
  const known = nodes.get(nodeId);
  if (known) return known;
  const pending = connecting.get(nodeId);
  if (pending) return pending;

  const promise = (async () => {
    const c = await startController();
    const node = await c.getNode(NodeId(BigInt(nodeId)));
    node.connect({
      attributeChangedCallback: (_n, data) => {
        if (data.path.clusterId === OnOff.Cluster.id && data.path.attributeName === 'onOff') {
          for (const l of listeners) l(nodeId, Number(data.path.endpointId), data.value === true);
        }
      },
    });
    nodes.set(nodeId, node);
    node.events.stateChanged.on((state: NodeStates) => logger.info({ nodeId, state: NodeStates[state] }, 'Matter device connection'));
    if (!node.initialized) await node.events.initialized;
    return node;
  })().finally(() => connecting.delete(nodeId));
  connecting.set(nodeId, promise);
  return promise;
}

/** Each part of a device that can be switched on and off: a plug, a light, each outlet of a strip, each device behind a bridge. */
async function switchableEndpoints(node: PairedNode): Promise<MatterEndpoint[]> {
  const info = node.basicInformation;
  const base = { nodeId: String(node.nodeId), vendor: info?.vendorName ?? '', product: info?.productName ?? '' };
  const deviceName = (info?.nodeLabel || info?.productLabel || info?.productName || 'Matter device').trim();

  const found: MatterEndpoint[] = [];
  const walk = async (ep: Endpoint) => {
    if (ep.getClusterClient(OnOff.Cluster) && ep.number !== undefined) {
      // A device behind a bridge has its own name.
      const bridged = ep.getClusterClient(BridgedDeviceBasicInformation.Cluster);
      const own = bridged ? await bridged.getNodeLabelAttribute(false).catch(() => undefined) : undefined;
      found.push({ ...base, endpoint: Number(ep.number), name: (own || deviceName).trim() });
    }
    for (const child of ep.getChildEndpoints()) await walk(child);
  };
  for (const ep of node.getDevices()) await walk(ep);

  // A strip's outlets share a name: number them.
  if (found.length > 1) {
    const counts = new Map<string, number>();
    for (const f of found) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    const seen = new Map<string, number>();
    for (const f of found) {
      if ((counts.get(f.name) ?? 0) > 1) {
        const n = (seen.get(f.name) ?? 0) + 1;
        seen.set(f.name, n);
        f.name = `${f.name} ${n}`;
      }
    }
  }
  return found;
}

/** "3497-011-2332", "MT:Y.K90…" or digits with spaces: the pairing info in it. */
export function parsePairingCode(input: string): { passcode: number; shortDiscriminator?: number; longDiscriminator?: number } {
  const text = input.trim();
  if (/^MT:/i.test(text)) {
    try {
      const [first] = QrPairingCodeCodec.decode(text.toUpperCase());
      return { passcode: first.passcode, longDiscriminator: first.discriminator };
    } catch {
      throw new MatterError('That QR code text isn’t a Matter code.');
    }
  }
  const digits = text.replace(/[\s-]/g, '');
  if (!/^(\d{11}|\d{21})$/.test(digits)) {
    throw new MatterError('A Matter pairing code has 11 digits, like 3497-011-2332.');
  }
  try {
    const { passcode, shortDiscriminator } = ManualPairingCodeCodec.decode(digits);
    return { passcode, shortDiscriminator };
  } catch {
    throw new MatterError('That code doesn’t check out. Check the digits and try again.');
  }
}

/**
 * Pairs a device from its code and returns its switchable parts. The device
 * must already be on the network and expecting a new controller: shared
 * from another Matter app in the last few minutes.
 */
export async function pairDevice(code: string): Promise<MatterEndpoint[]> {
  const parsed = parsePairingCode(code);
  if (pairing) throw new MatterError('Another Matter device is being added. Wait for it to finish.', 409);
  pairing = true;
  try {
    const c = await startController();
    const identifierData = parsed.longDiscriminator !== undefined
      ? { longDiscriminator: parsed.longDiscriminator }
      : { shortDiscriminator: parsed.shortDiscriminator! };
    let nodeId: NodeId;
    try {
      nodeId = await c.commissionNode({
        // Typed through a matter.js-internal import that "node" resolution can't follow.
        commissioning: {
          regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
          regulatoryCountryCode: 'XX',
        } as Record<string, unknown>,
        discovery: { identifierData, discoveryCapabilities: { onIpNetwork: true } },
        passcode: parsed.passcode,
      });
    } catch (err) {
      const text = String((err as Error)?.message ?? err);
      logger.warn({ err: text }, 'Matter pairing failed');
      if (/discover/i.test(text)) {
        throw new MatterError('HomeHub couldn’t find a device waiting to be added with that code. Share it again from the other app, then enter the new code within a few minutes.', 404);
      }
      if (/passcode|PASE|pake|verif/i.test(text)) throw new MatterError('The device didn’t accept that code. Check the digits, or share it again for a new code.');
      throw new MatterError(`The device couldn’t be added: ${text}`, 502);
    }
    logger.info({ nodeId: String(nodeId) }, 'Matter device paired');
    const node = await connectNode(String(nodeId));
    const endpoints = await switchableEndpoints(node);
    if (!endpoints.length) {
      // Nothing HomeHub can switch (a sensor, say): don't keep it.
      await removeNode(String(nodeId)).catch(() => undefined);
      throw new MatterError('That device was added, but it has nothing HomeHub can switch on and off yet, so it was removed again.', 422);
    }
    return endpoints;
  } finally {
    pairing = false;
  }
}

/**
 * Waits for a device's connection, which can lag behind its saved details:
 * right after HomeHub starts, or while the device's Wi-Fi reconnects.
 */
async function waitConnected(node: PairedNode, ms: number): Promise<boolean> {
  if (node.isConnected) return true;
  return new Promise((resolve) => {
    const done = (ok: boolean) => { clearTimeout(timer); node.events.stateChanged.off(listen); resolve(ok); };
    const listen = (state: NodeStates) => { if (state === NodeStates.Connected) done(true); };
    const timer = setTimeout(() => done(node.isConnected), ms);
    node.events.stateChanged.on(listen);
  });
}

async function onOffClient(nodeId: string, endpoint: number, waitMs: number) {
  const node = await connectNode(nodeId);
  if (!(await waitConnected(node, waitMs))) throw new MatterError('The device isn’t connected.', 503);
  const ep = findEndpoint(node, endpoint);
  const client = ep?.getClusterClient(OnOff.Complete);
  if (!client) throw new MatterError(`Part ${endpoint} of that device can’t be switched.`, 404);
  return client;
}

function findEndpoint(node: PairedNode, number: number): Endpoint | undefined {
  const walk = (eps: Endpoint[]): Endpoint | undefined => {
    for (const ep of eps) {
      if (Number(ep.number) === number) return ep;
      const inner = walk(ep.getChildEndpoints());
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(node.getDevices());
}

export async function setOnOff(nodeId: string, endpoint: number, on: boolean): Promise<void> {
  const client = await onOffClient(nodeId, endpoint, 10_000);
  if (on) await client.on(); else await client.off();
}

/** The last state the device reported. The live subscription keeps it current. */
export async function getOnOff(nodeId: string, endpoint: number): Promise<boolean> {
  const client = await onOffClient(nodeId, endpoint, 3_000);
  return (await client.getOnOffAttribute(false)) === true;
}

/** Unpairs a device: it forgets HomeHub, and HomeHub forgets it. Other apps keep it. */
export async function removeNode(nodeId: string): Promise<void> {
  const c = await startController();
  // Unpairing tells the device to forget HomeHub, which needs a connection.
  const node = await connectNode(nodeId).catch(() => null);
  if (node) await waitConnected(node, 15_000);
  nodes.delete(nodeId);
  await c.removeNode(NodeId(BigInt(nodeId)), true);
  logger.info({ nodeId }, 'Matter device removed');
}

/** Product and vendor, for Settings. */
export function nodeInfo(nodeId: string): { vendor: string; product: string } | null {
  const info = nodes.get(nodeId)?.basicInformation as BasicInformation.Attributes | undefined;
  return info ? { vendor: info.vendorName, product: info.productName } : null;
}

export async function stopController(): Promise<void> {
  const c = controller;
  controller = null;
  starting = null;
  nodes.clear();
  connecting.clear();
  await c?.close();
  // Stop matter.js's network services too (mDNS), so the process can exit.
  await Environment.default.runtime.close?.();
}
