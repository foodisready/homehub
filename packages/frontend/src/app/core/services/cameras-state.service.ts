import { Injectable, effect, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';

export interface CameraToggle { enabled: boolean; bridgeInstalled: boolean; ringSignedIn?: boolean }

/**
 * Whether cameras are on in HomeHub, for the menu and Settings. Cameras show
 * unless an admin turned them off in Settings, or .env leaves the camera
 * bridge out (HOMEHUB_CAMERA_BRIDGE=0) and nobody has signed in to Ring.
 */
@Injectable({ providedIn: 'root' })
export class CamerasStateService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  readonly state = signal<CameraToggle>({ enabled: true, bridgeInstalled: true, ringSignedIn: false });

  constructor() {
    effect(() => { if (this.auth.isLoggedIn()) this.load(); });
  }

  /** Shown in the menu. */
  visible(): boolean {
    const s = this.state();
    return s.enabled && (s.bridgeInstalled || !!s.ringSignedIn);
  }

  load(): void {
    this.http.get<CameraToggle>('/api/cameras/settings').subscribe({
      next: (s) => this.state.set({ enabled: s.enabled, bridgeInstalled: s.bridgeInstalled, ringSignedIn: s.ringSignedIn }),
      error: () => undefined,   // keep showing Cameras if the check fails
    });
  }

  /** Turn cameras on or off in HomeHub. Admin only. */
  setEnabled(enabled: boolean): Observable<CameraToggle> {
    return this.http.put<CameraToggle>('/api/cameras/settings', { enabled }).pipe(
      tap((s) => this.state.set({ enabled: s.enabled, bridgeInstalled: s.bridgeInstalled, ringSignedIn: s.ringSignedIn })),
    );
  }
}
