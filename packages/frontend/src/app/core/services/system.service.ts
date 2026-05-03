import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface SystemVersion {
  running:         string;
  latest:          string | null;
  updateAvailable: boolean;
  updaterAvailable: boolean;
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

  update(): Observable<SystemUpdateResult> {
    return this.http.post<SystemUpdateResult>('/api/system/update', {});
  }
}
