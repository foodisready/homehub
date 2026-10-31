/**
 * Limits password guessing on POST /api/auth/login.
 *
 * Two fixed 15-minute windows apply: one per username and client address, and
 * a wider one per client address that catches guessing across usernames.
 * Counts live in memory, so a restart clears them.
 *
 * Client addresses come from the socket, not X-Forwarded-For. The backend's
 * port is reachable directly, so that header could be forged to dodge the
 * limit. Behind a proxy all clients therefore share one address, which only
 * makes the limit stricter.
 */

const WINDOW_MS          = 15 * 60 * 1000;
const MAX_PER_ACCOUNT    = 5;
const MAX_PER_ADDRESS    = 20;
const MAX_USERNAME_CHARS = 64;   // bounds key size; real names are far shorter
const SWEEP_THRESHOLD    = 1000;

interface Bucket {
  count:   number;
  resetAt: number;
}

export type LoginAttempt =
  | { allowed: true; succeeded: () => void }
  | { allowed: false; retryAfterSeconds: number };

const buckets = new Map<string, Bucket>();

function currentBucket(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) return existing;

  const fresh = { count: 0, resetAt: now + WINDOW_MS };
  buckets.set(key, fresh);
  return fresh;
}

function sweepExpired(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function blockedUntil(resetAt: number, now: number): LoginAttempt {
  return { allowed: false, retryAfterSeconds: Math.ceil((resetAt - now) / 1000) };
}

/**
 * Call before checking the password. Every allowed attempt counts straight
 * away, so a parallel burst can't slip through while bcrypt is running. Call
 * succeeded() on a correct password to take the attempt back.
 */
export function startLoginAttempt(address: string, username: string): LoginAttempt {
  const now = Date.now();
  sweepExpired(now);

  // Checked first so a blocked address can't grow the map with new usernames.
  const perAddress = currentBucket(`address:${address}`, now);
  if (perAddress.count >= MAX_PER_ADDRESS) return blockedUntil(perAddress.resetAt, now);

  const perAccount = currentBucket(`account:${address}:${username.slice(0, MAX_USERNAME_CHARS)}`, now);
  if (perAccount.count >= MAX_PER_ACCOUNT) return blockedUntil(perAccount.resetAt, now);

  perAccount.count++;
  perAddress.count++;
  return {
    allowed: true,
    succeeded: () => {
      perAccount.count--;
      perAddress.count--;
    },
  };
}

/** Forget all counts. Tests use this to start clean. */
export function resetLoginLimiter(): void {
  buckets.clear();
}
