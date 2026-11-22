import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';

const SETTINGS_KEY = 'homehub.lock';
const LOCKED_KEY = 'homehub.lock.locked';

export interface LockSettings { auto: boolean; idleMinutes: number }

function loadSettings(): LockSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (v && typeof v.auto === 'boolean' && Number.isFinite(v.idleMinutes)) return { auto: v.auto, idleMinutes: v.idleMinutes };
  } catch { /* the default */ }
  return { auto: false, idleMinutes: 5 };
}
const store = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* this visit only */ }
};

/**
 * Locking a shared screen, such as the wall tablet: by hand, or after some minutes without a
 * touch; a PIN opens it again. The PIN is the login's, checked by HomeHub (/api/lock); whether
 * this screen locks itself, and after how long, is this browser's own choice. Locked stays locked
 * through a reload. Signing out (the lock screen's way out for a forgotten PIN) unlocks.
 */
@Injectable({ providedIn: 'root' })
export class LockService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  /** The login has a PIN. Null until known. */
  readonly pinSet = signal<boolean | null>(null);
  /** How many digits it has, so the pad knows when it's complete. */
  readonly pinLength = signal(4);
  readonly settings = signal(loadSettings());
  private readonly _locked = signal(this.readLocked());
  readonly locked = computed(() => this._locked() && this.auth.isLoggedIn() && this.pinSet() !== false);

  private lastTouch = Date.now();
  private started = false;

  constructor() {
    // Each sign-in: does this login have a PIN? Signing out unlocks.
    effect(() => {
      if (this.auth.isLoggedIn()) this.refresh();
      else { this.pinSet.set(null); this.setLocked(false); }
    });
  }

  private readLocked(): boolean {
    try { return localStorage.getItem(LOCKED_KEY) === '1'; } catch { return false; }
  }

  private setLocked(v: boolean): void {
    this._locked.set(v);
    store(LOCKED_KEY, v ? '1' : null);
  }

  refresh(): void {
    this.http.get<{ set: boolean; length: number | null }>('/api/lock').subscribe({ next: (r) => {
        this.pinSet.set(r.set);
        this.pinLength.set(r.length ?? 4);
        // No PIN: a lock left over from before means nothing, and mustn't come back with a new PIN.
        if (!r.set) this.setLocked(false);
      }, error: () => undefined });
  }

  /** Watches for touches, and locks after the idle time when this screen locks itself. Once per app. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const touched = () => { this.lastTouch = Date.now(); };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, touched, { passive: true, capture: true });
    setInterval(() => {
      const s = this.settings();
      if (!s.auto || !this.pinSet() || this._locked() || !this.auth.isLoggedIn()) return;
      if (Date.now() - this.lastTouch >= s.idleMinutes * 60_000) this.lockNow();
    }, 10_000);
  }

  lockNow(): void {
    if (this.pinSet()) this.setLocked(true);
  }

  unlock(pin: string): Observable<unknown> {
    return this.http.post('/api/lock/check', { pin }).pipe(tap(() => { this.lastTouch = Date.now(); this.setLocked(false); }));
  }

  saveSettings(s: LockSettings): void {
    this.settings.set(s);
    store(SETTINGS_KEY, JSON.stringify(s));
    this.lastTouch = Date.now();
  }

  setPin(pin: string, current?: string): Observable<unknown> {
    return this.http.put('/api/lock', { pin, current }).pipe(tap(() => {
      const first = !this.pinSet();
      this.pinSet.set(true);
      this.pinLength.set(pin.length);
      this.setLocked(false);
      // A new PIN on this screen: lock itself after 5 minutes, unless already chosen.
      if (first && !this.settings().auto) this.saveSettings({ auto: true, idleMinutes: this.settings().idleMinutes || 5 });
    }));
  }

  removePin(current: string): Observable<unknown> {
    return this.http.request('DELETE', '/api/lock', { body: { current } }).pipe(tap(() => { this.pinSet.set(false); this.setLocked(false); }));
  }
}
