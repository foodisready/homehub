/**
 * backend.service.ts
 *
 * HTTP client for calling the HomeHub backend REST API.
 * Signs in with HomeHub's internal key (no admin password needed) and
 * re-authenticates automatically on 401 (token expiry).
 */

import { readSecret } from './secrets';

let token: string | null = null;

function baseUrl(): string {
  return process.env.BACKEND_URL ?? 'http://localhost:3000';
}

async function login(): Promise<void> {
  const res = await fetch(`${baseUrl()}/internal/service-token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Key': readSecret('INTERNAL_API_KEY') },
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
      // Lets HomeHub's Activity show changes as made by an AI assistant.
      'x-homehub-client': 'mcp',
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
