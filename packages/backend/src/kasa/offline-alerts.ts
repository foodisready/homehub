/**
 * When to tell admins a device has gone offline. Wi-Fi blips, a camera bridge reconnecting and
 * HomeHub's own restarts all make devices miss a poll or two, so a notification waits until a
 * device has been unreachable for a while, and comes at most once a day for each device.
 *
 * Only an outage HomeHub sees begin counts: a device already unreachable when HomeHub starts
 * (after an update, say) was most likely offline before it, and isn't news.
 */

export const OFFLINE_FOR_MS = 10 * 60_000;
export const ALERT_EVERY_MS = 24 * 3_600_000;

export class OfflineAlerts {
  private readonly since = new Map<number, number>();
  private readonly told = new Set<number>();
  private readonly lastAlert = new Map<number, number>();

  constructor(private readonly notify: (id: number, alias: string) => void) {}

  /** A poll that reached the device. */
  reached(id: number): void {
    this.since.delete(id);
    this.told.delete(id);
  }

  /** A poll that didn't. wasOnline: the last poll reached it (false or undefined after a start). */
  missed(id: number, alias: string, wasOnline: boolean | undefined, now = Date.now()): void {
    if (wasOnline) this.since.set(id, now);
    const since = this.since.get(id);
    if (since === undefined || this.told.has(id) || now - since < OFFLINE_FOR_MS) return;
    const last = this.lastAlert.get(id);
    this.told.add(id);
    if (last !== undefined && now - last < ALERT_EVERY_MS) return;
    this.lastAlert.set(id, now);
    this.notify(id, alias);
  }
}
