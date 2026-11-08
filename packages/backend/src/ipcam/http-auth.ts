import crypto from 'node:crypto';

/**
 * GET with a camera's login: cameras answer 401 and say whether they want
 * Basic or Digest (Amcrest, Dahua and Hikvision want Digest), and the
 * request is sent again with it.
 */

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...args) => fetch(...args);
/** For tests. */
export function setCameraFetchForTests(f: Fetch | null): void { fetchImpl = f ?? ((...args) => fetch(...args)); }

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

/** The fields of a WWW-Authenticate: Digest header. */
export function parseChallenge(header: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const m of header.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) {
    fields[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return fields;
}

/** The Authorization header answering a Digest challenge (RFC 7616, MD5, qop=auth). */
export function digestHeader(challenge: Record<string, string>, method: string, uri: string, username: string, password: string, cnonce = crypto.randomBytes(8).toString('hex')): string {
  const { realm = '', nonce = '', opaque, algorithm } = challenge;
  const qop = (challenge.qop ?? '').split(',').map((q) => q.trim()).includes('auth') ? 'auth' : null;
  const sess = /-sess$/i.test(algorithm ?? '');
  let ha1 = md5(`${username}:${realm}:${password}`);
  if (sess) ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = '00000001';
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`,
    ...(algorithm ? [`algorithm=${algorithm}`] : []),
    ...(opaque !== undefined ? [`opaque="${opaque}"`] : []),
    ...(qop ? [`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`] : []),
  ];
  return `Digest ${parts.join(', ')}`;
}

export async function fetchWithLogin(url: string, username: string, password: string, timeoutMs = 10_000): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const first = await fetchImpl(url, { signal, redirect: 'manual' });
  if (first.status !== 401 || !username) return first;
  const challenge = first.headers.get('www-authenticate') ?? '';
  await first.arrayBuffer().catch(() => undefined);
  const u = new URL(url);
  const authorization = /^Digest/i.test(challenge)
    ? digestHeader(parseChallenge(challenge), 'GET', u.pathname + u.search, username, password)
    : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  return fetchImpl(url, { signal, redirect: 'manual', headers: { Authorization: authorization } });
}
