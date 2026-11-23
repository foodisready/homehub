/**
 * Whether this device is a wall display: set when the wall display opens, cleared by "Leave wall
 * display". A home-screen shortcut opens HomeHub at "/", and on such a device "/" goes back to
 * the wall display instead of the Dashboard.
 */
const KEY = 'homehub.wall.home';

export function isWallHome(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setWallHome(on: boolean): void {
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* this visit only */ }
}
