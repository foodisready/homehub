import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';

export type ServerRole = 'active' | 'backup' | 'dev';

export interface RoleStatus {
  role: ServerRole;
  activeSince: string | null;
  /** Another computer answering to homehub.local: the active HomeHub, or a second active one. */
  other: { address: string; seenAt: string } | null;
}

/**
 * Whether this HomeHub acts on its own: automations paused by hand (for a
 * development copy), and this server's role when there's more than one
 * HomeHub (a backup or dev server doesn't run automations, voice or cameras).
 */
@Injectable({ providedIn: 'root' })
export class AutomationsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  /** Paused by hand with the switch in Settings → Preferences. */
  readonly paused = signal(false);
  readonly role = signal<RoleStatus | null>(null);
  /** A backup is read-only: its settings are copied from the active HomeHub. A development copy isn't. */
  readonly readOnly = computed(() => this.role()?.role === 'backup');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      if (this.auth.isLoggedIn()) {
        this.load();
        // Another HomeHub can appear on the network at any time.
        this.timer ??= setInterval(() => this.loadRole(), 60_000);
      } else {
        this.paused.set(false);
        this.role.set(null);
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
      }
    });
  }

  load(): void {
    this.http.get<{ paused: boolean; byHand?: boolean }>('/api/system/automations').subscribe({
      next: (r) => this.paused.set(r.byHand ?? r.paused),
      error: () => undefined,
    });
    this.loadRole();
  }

  loadRole(): void {
    this.http.get<RoleStatus>('/api/system/role').subscribe({
      next: (r) => this.role.set(r),
      error: () => undefined,
    });
  }

  /** Admin only. */
  setPaused(paused: boolean): Observable<{ paused: boolean; byHand?: boolean }> {
    return this.http.put<{ paused: boolean; byHand?: boolean }>('/api/system/automations', { paused }).pipe(
      tap((r) => this.paused.set(r.byHand ?? r.paused)),
    );
  }

  /** Admin only. */
  setRole(role: ServerRole): Observable<RoleStatus> {
    return this.http.put<RoleStatus>('/api/system/role', { role }).pipe(tap((r) => this.role.set(r)));
  }
}
