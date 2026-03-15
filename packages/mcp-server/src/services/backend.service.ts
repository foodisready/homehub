/**
 * backend.service.ts
 *
 * HTTP client for calling the HomeHub backend REST API.
 * Authenticates with admin credentials on first use and re-authenticates
 * automatically on 401 (token expiry).
 */

let token: string | null = null;

function baseUrl(): string {
  return process.env.BACKEND_URL ?? 'http://localhost:3000';
}

async function login(): Promise<void> {
  const res = await fetch(`${baseUrl()}/api/auth/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      username: process.env.ADMIN_USER     ?? 'admin',
      password: process.env.ADMIN_PASSWORD ?? '',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP backend login failed (${res.status}): ${text}`);
  }

  const data = await res.json() as { accessToken: string };
  token = data.accessToken;
}

export async function apiRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  if (!token) await login();

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Token expired — re-authenticate once and retry
  if (res.status === 401) {
    token = null;
    await login();
    return apiRequest<T>(method, path, body);
  }

  if (res.status === 204) return {} as T;

  const data = await res.json() as any;
  if (!res.ok) {
    throw new Error(data?.error ?? `Backend error ${res.status}`);
  }

  return data as T;
}
