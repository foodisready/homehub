import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface SystemVersion {
  running:         string;
  latest:          string | null;
  updateAvailable: boolean;
  updaterAvailable: boolean;
  /** The updater service can switch to any release, so going back is possible. */
  canSwitch?: boolean;
  /** The release that ran before this one. */
  previous?: string | null;
}

export interface SwitchStatus {
  busy: boolean;
  current: string;
  last: { version: string; from?: string; ok: boolean; step: string; finished?: string } | null;
}

export interface HealthItem {
  id: string;
  group: 'HomeHub' | 'Devices' | 'Voice' | 'Data' | 'Computer' | 'Settings';
  label: string;
  level: 'ok' | 'warn' | 'error' | 'info';
  detail: string;
  link?: string;
  action?: 'restart-voice-bridge';
}

export interface HealthReport {
  status: 'ok' | 'attention' | 'problem';
  checkedAt: string;
  version: string;
  items: HealthItem[];
}

export interface SystemUpdateResult {
  started: true;
  message: string;
}

@Injectable({ providedIn: 'root' })
export class SystemService {
  private http = inject(HttpClient);

  version(): Observable<SystemVersion> {
    return this.http.get<SystemVersion>('/api/system/version');
  }

  restartVoiceBridge(): Observable<{ asked: boolean }> {
    return this.http.post<{ asked: boolean }>('/api/system/voice-bridge/restart', {});
  }

  health(): Observable<HealthReport> {
    return this.http.get<HealthReport>('/api/system/health');
  }

  switchTo(version: string): Observable<SystemUpdateResult> {
    return this.http.post<SystemUpdateResult>('/api/system/switch', { version });
  }

  switchStatus(): Observable<SwitchStatus | null> {
    return this.http.get<SwitchStatus | null>('/api/system/switch-status');
  }

  update(): Observable<SystemUpdateResult> {
    return this.http.post<SystemUpdateResult>('/api/system/update', {});
  }
}
