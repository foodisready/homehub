/**
 * Sonos speakers, on the home network. Each answers UPnP on port 1400 with no login: SOAP requests
 * to play, pause, skip and set the volume, and an XML description of itself. Speakers can be
 * grouped in the Sonos app; a group plays as one, and only its coordinator takes play, pause and
 * skip, so those go to whichever speaker leads the group this speaker is in.
 */
import dgram from 'node:dgram';

export const SONOS_PORT = 1400;
const TIMEOUT_MS = 4000;

/** For tests: the port speakers answer on. */
let port = SONOS_PORT;
export function setPortForTests(p: number): void { port = p; }

export class SonosError extends Error {
  constructor(message: string, readonly code: 'UNREACHABLE' | 'NOTHING_TO_PLAY' | 'FAILED' | 'GONE' | 'NO_SPOTIFY', readonly upnpCode?: number) { super(message); }
}

const SERVICES = {
  AVTransport: { path: '/MediaRenderer/AVTransport/Control', urn: 'urn:schemas-upnp-org:service:AVTransport:1' },
  RenderingControl: { path: '/MediaRenderer/RenderingControl/Control', urn: 'urn:schemas-upnp-org:service:RenderingControl:1' },
  ZoneGroupTopology: { path: '/ZoneGroupTopology/Control', urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1' },
  ContentDirectory: { path: '/MediaServer/ContentDirectory/Control', urn: 'urn:schemas-upnp-org:service:ContentDirectory:1' },
} as const;
type Service = keyof typeof SERVICES;

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const decodeXml = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** The text of the first <tag>, decoded, or null. Namespaced tags ("dc:title") match by their full name. */
export function tagOf(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1]) : null;
}

/** Sends one SOAP action and answers with the response body. */
export async function soap(ip: string, service: Service, action: string, args: Record<string, string | number> = {}): Promise<string> {
  const { path, urn } = SERVICES[service];
  const body = Object.entries(args).map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`).join('');
  const envelope = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${urn}">${body}</u:${action}></s:Body></s:Envelope>`;
  let res: Response;
  try {
    res = await fetch(`http://${ip}:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${urn}#${action}"` },
      body: envelope,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new SonosError(`No answer from the speaker at ${ip}: ${(err as Error).message}`, 'UNREACHABLE');
  }
  const text = await res.text();
  if (!res.ok) {
    const code = Number(tagOf(text, 'errorCode'));
    // 701: "transition not available", which is what Play says with nothing queued to play.
    if (action === 'Play' && code === 701) throw new SonosError('Nothing to play', 'NOTHING_TO_PLAY', code);
    throw new SonosError(`The speaker refused ${action}${code ? ` (UPnP ${code})` : ''}`, 'FAILED', code || undefined);
  }
  return text;
}

// ── Itself ─────────────────────────────────────────────────────

export interface SpeakerInfo { ip: string; uuid: string; room: string; model: string; mac: string | null }

/** What the speaker says it is, from its description. Null if it isn't a Sonos. */
export async function describe(ip: string): Promise<SpeakerInfo | null> {
  let xml: string;
  try {
    const res = await fetch(`http://${ip}:${port}/xml/device_description.xml`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  }
  if (!/Sonos/i.test(tagOf(xml, 'manufacturer') ?? '')) return null;
  const uuid = (tagOf(xml, 'UDN') ?? '').replace(/^uuid:/, '');
  if (!uuid) return null;
  const mac = tagOf(xml, 'MACAddress');
  return {
    ip,
    uuid,
    room: tagOf(xml, 'roomName') ?? 'Sonos',
    model: `Sonos ${(tagOf(xml, 'modelName') ?? '').replace(/^Sonos\s*/i, '') || 'speaker'}`,
    mac: mac && /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i.test(mac) ? mac.toUpperCase() : null,
  };
}

// ── Groups ─────────────────────────────────────────────────────

export interface GroupMember { uuid: string; ip: string | null; room: string }
export interface Group { coordinator: string; members: GroupMember[] }

/** The groups, from the topology any speaker reports. Hidden parts of a pair or surround set are left out. */
export function parseGroups(response: string): Group[] {
  const state = decodeXml(tagOf(response, 'ZoneGroupState') ?? '');
  const groups: Group[] = [];
  for (const g of state.matchAll(/<ZoneGroup\s([^>]*)>([\s\S]*?)<\/ZoneGroup>/g)) {
    const coordinator = /Coordinator="([^"]+)"/.exec(g[1])?.[1] ?? '';
    const members: GroupMember[] = [];
    for (const m of g[2].matchAll(/<ZoneGroupMember\s([^>]*?)\/?>/g)) {
      const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(' ' + m[1])?.[1] ?? '';
      if (attr('Invisible') === '1') continue;
      const location = attr('Location');
      members.push({ uuid: attr('UUID'), ip: /^http:\/\/([^:/]+)/.exec(location)?.[1] ?? null, room: decodeXml(attr('ZoneName')) });
    }
    if (coordinator && members.length) groups.push({ coordinator, members });
  }
  return groups;
}

export async function groupOf(ip: string, uuid: string): Promise<Group | null> {
  const groups = parseGroups(await soap(ip, 'ZoneGroupTopology', 'GetZoneGroupState'));
  return groups.find((g) => g.members.some((m) => m.uuid === uuid)) ?? null;
}

/** Where play, pause and skip go: the group's coordinator, or the speaker itself when it leads or is alone. */
export async function leaderOf(ip: string, uuid: string): Promise<string> {
  try {
    const group = await groupOf(ip, uuid);
    const leader = group?.members.find((m) => m.uuid === group.coordinator);
    return leader?.ip ?? ip;
  } catch (err) {
    if (err instanceof SonosError && err.code === 'UNREACHABLE') throw err;
    return ip;
  }
}

// ── Playing ────────────────────────────────────────────────────

/** PLAYING, PAUSED_PLAYBACK, STOPPED or TRANSITIONING. */
export async function transportState(ip: string): Promise<string> {
  return tagOf(await soap(ip, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }), 'CurrentTransportState') ?? 'STOPPED';
}

export const isPlaying = (state: string) => state === 'PLAYING' || state === 'TRANSITIONING';

export interface NowPlaying { title: string | null; artist: string | null; album: string | null }

/** What's playing, from the track's metadata: a song's title and artist, or a station's name and what it's on now. */
export function parseNowPlaying(positionInfo: string, mediaInfo?: string): NowPlaying {
  const meta = decodeXml(tagOf(positionInfo, 'TrackMetaData') ?? '');
  const clean = (s: string | null) => (s && s !== 'NOT_IMPLEMENTED' && !/^x-(sonos|rincon)/.test(s) ? s.trim() || null : null);
  let title = clean(tagOf(meta, 'dc:title'));
  let artist = clean(tagOf(meta, 'dc:creator'));
  const album = clean(tagOf(meta, 'upnp:album'));
  // A radio station: the song is in streamContent ("Artist - Title"), the station in the media's title.
  const stream = clean(tagOf(meta, 'r:streamContent'));
  if (stream) {
    const station = mediaInfo ? clean(tagOf(decodeXml(tagOf(mediaInfo, 'CurrentURIMetaData') ?? ''), 'dc:title')) : null;
    const parts = stream.split(' - ');
    if (parts.length >= 2) { artist = parts[0]; title = parts.slice(1).join(' - '); } else { title = stream; artist = station; }
    if (!artist && station) artist = station;
  }
  return { title, artist, album };
}

export async function nowPlaying(ip: string): Promise<NowPlaying> {
  const [position, media] = await Promise.all([
    soap(ip, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
    soap(ip, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 }).catch(() => ''),
  ]);
  return parseNowPlaying(position, media);
}

export async function play(leaderIp: string): Promise<void> { await soap(leaderIp, 'AVTransport', 'Play', { InstanceID: 0, Speed: 1 }); }

export async function pause(leaderIp: string): Promise<void> {
  try {
    await soap(leaderIp, 'AVTransport', 'Pause', { InstanceID: 0 });
  } catch (err) {
    // A radio stream can't pause, only stop.
    if (err instanceof SonosError && err.code === 'FAILED') { await soap(leaderIp, 'AVTransport', 'Stop', { InstanceID: 0 }); return; }
    throw err;
  }
}

export async function skip(leaderIp: string, next: boolean): Promise<void> {
  await soap(leaderIp, 'AVTransport', next ? 'Next' : 'Previous', { InstanceID: 0 });
}

// ── Volume ─────────────────────────────────────────────────────

export async function volumeOf(ip: string): Promise<{ volume: number; muted: boolean }> {
  const [v, m] = await Promise.all([
    soap(ip, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' }),
    soap(ip, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' }),
  ]);
  return { volume: Number(tagOf(v, 'CurrentVolume') ?? 0), muted: tagOf(m, 'CurrentMute') === '1' };
}

export async function setVolume(ip: string, level: number): Promise<void> {
  await soap(ip, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: level });
}

export async function stepVolume(ip: string, by: number): Promise<void> {
  await soap(ip, 'RenderingControl', 'SetRelativeVolume', { InstanceID: 0, Channel: 'Master', Adjustment: by });
}

export async function setMute(ip: string, on: boolean): Promise<void> {
  await soap(ip, 'RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: on ? 1 : 0 });
}

// ── Finding speakers ───────────────────────────────────────────

/** Asks for Sonos speakers on the network; each that answers is described. Hidden pair and surround parts answer too, and are left out. */
export function searchSpeakers(waitMs = 3000): Promise<SpeakerInfo[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const ips = new Set<string>();
    socket.on('message', (msg, rinfo) => { if (/Sonos/i.test(msg.toString())) ips.add(rinfo.address); });
    socket.on('error', () => undefined);
    socket.bind(0, () => {
      const query = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n');
      for (let i = 0; i < 2; i++) socket.send(query, 1900, '239.255.255.250', () => undefined);
    });
    setTimeout(async () => {
      try { socket.close(); } catch { /* closed */ }
      const found = (await Promise.all([...ips].map(describe))).filter((s): s is SpeakerInfo => !!s);
      // Leave out what the topology hides (the second speaker of a pair, surrounds, a Sub).
      let visible = found;
      if (found.length) {
        try {
          const shown = new Set(parseGroups(await soap(found[0].ip, 'ZoneGroupTopology', 'GetZoneGroupState')).flatMap((g) => g.members.map((m) => m.uuid)));
          if (shown.size) visible = found.filter((s) => shown.has(s.uuid));
        } catch { /* keep them all */ }
      }
      resolve(visible);
    }, waitMs);
  });
}
