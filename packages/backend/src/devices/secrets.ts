/**
 * Passwords and keys inside a device's driver_config (a Shelly login, a Tuya
 * local key). They're never sent to the browser: the API lists which are
 * saved instead, and an edit that leaves one out keeps the saved value.
 */

const SECRET_FIELD = /pass|secret|token|^key$|localkey/i;

type Config = Record<string, unknown>;

const isObject = (v: unknown): v is Config => !!v && typeof v === 'object' && !Array.isArray(v);

/** The config without secrets, and the dotted paths of the ones that are saved, e.g. ["auth.pass"]. */
export function withoutSecrets(config: Config | null): { config: Config | null; savedSecrets: string[] } {
  if (!config) return { config: null, savedSecrets: [] };
  const savedSecrets: string[] = [];
  const strip = (obj: Config, prefix: string): Config =>
    Object.fromEntries(Object.entries(obj).flatMap(([k, v]): [string, unknown][] => {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && SECRET_FIELD.test(k)) {
        if (v) savedSecrets.push(path);
        return [];
      }
      return [[k, isObject(v) ? strip(v, path) : v]];
    }));
  return { config: strip(config, ''), savedSecrets };
}

/**
 * Fills secrets an edit left out from the saved config. A secret is kept only
 * while the object holding it is still there, so removing `auth` still
 * removes the login.
 */
export function keepSecrets(incoming: Config | null, saved: Config | null): Config | null {
  if (!incoming || !saved) return incoming;
  const merge = (next: Config, old: Config): Config => {
    const out: Config = { ...next };
    for (const [k, v] of Object.entries(old)) {
      if (typeof v === 'string' && SECRET_FIELD.test(k) && (out[k] === undefined || out[k] === '')) out[k] = v;
      else if (isObject(v) && isObject(out[k])) out[k] = merge(out[k] as Config, v);
    }
    return out;
  };
  return merge(incoming, saved);
}
