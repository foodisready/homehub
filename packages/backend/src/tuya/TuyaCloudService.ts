import * as crypto from 'crypto';
import { logger } from '../logger';

export interface TuyaCloudDevice {
  deviceId:    string;
  localKey:    string;
  name:        string;
  productName: string;
  ip?:         string;
  online:      boolean;
}

export interface TuyaCloudCredentials {
  accessId:     string;
  accessSecret: string;
  region:       'us' | 'eu' | 'cn' | 'in';
}

const REGION_HOST: Record<string, string> = {
  us: 'openapi.tuyaus.com',
  eu: 'openapi.tuyaeu.com',
  cn: 'openapi.tuyacn.com',
  in: 'openapi.tuyain.com',
};

const EMPTY_BODY_HASH = crypto.createHash('sha256').update('').digest('hex');

function buildSign(
  accessId:     string,
  accessSecret: string,
  t:            string,
  accessToken:  string,
  method:       string,
  pathAndQuery: string,
  body = '',
): string {
  const contentHash  = body ? crypto.createHash('sha256').update(body).digest('hex') : EMPTY_BODY_HASH;
  const stringToSign = [method.toUpperCase(), contentHash, '', pathAndQuery].join('\n');
  const message      = accessId + accessToken + t + stringToSign;
  return crypto.createHmac('sha256', accessSecret).update(message).digest('hex').toUpperCase();
}

async function tuyaRequest(
  host:         string,
  method:       string,
  pathAndQuery: string,
  accessId:     string,
  accessSecret: string,
  accessToken = '',
  body?: Record<string, unknown>,
): Promise<any> {
  const t       = Date.now().toString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const sign    = buildSign(accessId, accessSecret, t, accessToken, method, pathAndQuery, bodyStr);

  const headers: Record<string, string> = {
    'client_id':   accessId,
    'sign':        sign,
    'sign_method': 'HMAC-SHA256',
    't':           t,
    'lang':        'en',
  };
  if (accessToken) headers['access_token'] = accessToken;
  if (bodyStr)     headers['Content-Type'] = 'application/json';

  const url = `https://${host}${pathAndQuery}`;
  logger.debug({ method, url }, 'Tuya API request');

  const res = await fetch(url, {
    method,
    headers,
    body:   bodyStr || undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Tuya API HTTP ${res.status} for ${pathAndQuery}`);
  const json = await res.json() as any;
  if (!json.success) throw new Error(`Tuya API error ${json.code}: ${json.msg}`);
  return json.result;
}

async function getAccessToken(host: string, accessId: string, accessSecret: string): Promise<string> {
  const result = await tuyaRequest(host, 'GET', '/v1.0/token?grant_type=1', accessId, accessSecret);
  return result.access_token as string;
}

function mapDevice(d: any): TuyaCloudDevice {
  return {
    deviceId:    d.id ?? d.device_id ?? '',
    localKey:    d.local_key ?? d.localKey ?? '',
    name:        d.name ?? d.custom_name ?? '',
    productName: d.product_name ?? d.category ?? 'Tuya Device',
    ip:          d.ip ?? undefined,
    online:      d.online ?? false,
  };
}

/** Strategy 1: cloud project device listing (v2) — works after linking app account */
async function fetchViaCloudProject(
  host: string, accessId: string, accessSecret: string, token: string,
): Promise<TuyaCloudDevice[]> {
  const devices: TuyaCloudDevice[] = [];
  let page = 1;
  const pageSize = 20; // Tuya limits this endpoint to 20 per page
  while (true) {
    const result = await tuyaRequest(
      host, 'GET', `/v2.0/cloud/thing/device?page_no=${page}&page_size=${pageSize}`,
      accessId, accessSecret, token,
    );
    const list: any[] = result?.list ?? (Array.isArray(result) ? result : []);
    if (!Array.isArray(list) || list.length === 0) break;
    devices.push(...list.map(mapDevice));
    if (list.length < pageSize) break;
    page++;
  }
  return devices;
}

/** Strategy 2: linked app account user devices */
async function fetchViaLinkedUser(
  host: string, accessId: string, accessSecret: string, token: string,
): Promise<TuyaCloudDevice[]> {
  // Get linked accounts (page_size=20 is safe)
  const accounts = await tuyaRequest(
    host, 'GET', '/v2.0/cloud/thing/device/user?page_no=1&page_size=20',
    accessId, accessSecret, token,
  );
  const users: any[] = accounts?.list ?? (Array.isArray(accounts) ? accounts : []);
  if (!users.length) return [];

  const devices: TuyaCloudDevice[] = [];
  for (const u of users) {
    const uid = u.uid ?? u.user_id ?? u.userId;
    if (!uid) continue;
    try {
      const res = await tuyaRequest(
        host, 'GET', `/v1.0/users/${uid}/devices`,
        accessId, accessSecret, token,
      );
      const list: any[] = Array.isArray(res) ? res : (res?.list ?? []);
      devices.push(...list.map(mapDevice));
    } catch (err: any) {
      logger.warn({ uid, err: err.message }, 'Tuya: could not fetch devices for linked user');
    }
  }
  return devices;
}

/** Fetch all devices, trying multiple API strategies in order. */
export async function fetchTuyaCloudDevices(creds: TuyaCloudCredentials): Promise<TuyaCloudDevice[]> {
  const host = REGION_HOST[creds.region] ?? REGION_HOST['us'];
  logger.info({ region: creds.region, host }, 'Fetching Tuya cloud devices');

  const token = await getAccessToken(host, creds.accessId, creds.accessSecret);

  const strategies = [
    { name: 'cloud-project', fn: () => fetchViaCloudProject(host, creds.accessId, creds.accessSecret, token) },
    { name: 'linked-user',   fn: () => fetchViaLinkedUser(host, creds.accessId, creds.accessSecret, token) },
  ];

  const errors: string[] = [];
  for (const { name, fn } of strategies) {
    try {
      const devices = await fn();
      if (devices.length > 0) {
        logger.info({ strategy: name, count: devices.length }, 'Tuya cloud devices fetched');
        return devices;
      }
      logger.debug({ strategy: name }, 'Tuya strategy returned 0 devices, trying next');
    } catch (err: any) {
      logger.warn({ strategy: name, err: err.message }, 'Tuya strategy failed, trying next');
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (errors.length === strategies.length) {
    throw new Error(`All Tuya API strategies failed:\n${errors.join('\n')}`);
  }

  return [];
}
