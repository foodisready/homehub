import { Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';

/**
 * Whether automations are paused on this HomeHub: schedules, motion rules,
 * timers, camera motion snapshots and automatic water shutoff. Meant for a
 * development copy running against the same devices as the real HomeHub.
 */
@Injectable({ providedIn: 'root' })
export class AutomationsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  readonly paused = signal(false);

  constructor() {
    effect(() => { if (this.auth.isLoggedIn()) this.load(); else this.paused.set(false); });
  }

  load(): void {
    this.http.get<{ paused: boolean }>('/api/system/automations').subscribe({
      next: (r) => this.paused.set(r.paused),
      error: () => undefined,
    });
  }

  /** Admin only. */
  setPaused(paused: boolean): Observable<{ paused: boolean }> {
    return this.http.put<{ paused: boolean }>('/api/system/automations', { paused }).pipe(
      tap((r) => this.paused.set(r.paused)),
    );
  }
}
