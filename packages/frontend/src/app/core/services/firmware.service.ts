import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { FirmwareRelease } from '../../shared/models/sensor.model';

export interface OtaDispatchResult {
  ok:           true;
  dispatchedTo: string;
  firmwareUrl:  string;
  version:      string;
}

@Injectable({ providedIn: 'root' })
export class FirmwareService {
  private http = inject(HttpClient);

  list(target?: string): Observable<FirmwareRelease[]> {
    let params = new HttpParams();
    if (target) params = params.set('target', target);
    return this.http.get<FirmwareRelease[]>('/api/firmware', { params });
  }

  upload(file: File, version: string, target = 'auraflow-mainline', notes?: string): Observable<FirmwareRelease> {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('version', version);
    fd.append('target', target);
    if (notes) fd.append('notes', notes);
    return this.http.post<FirmwareRelease>('/api/firmware', fd);
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(`/api/firmware/${id}`);
  }

  dispatchOta(sensorId: number, releaseId: number): Observable<OtaDispatchResult> {
    return this.http.post<OtaDispatchResult>(`/api/sensors/${sensorId}/ota`, { releaseId });
  }
}
