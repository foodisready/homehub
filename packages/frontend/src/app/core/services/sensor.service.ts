import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  Sensor, FlowEvent, FlowReading, ConsumptionBucket,
} from '../../shared/models/sensor.model';

@Injectable({ providedIn: 'root' })
export class SensorService {
  private http = inject(HttpClient);

  list(): Observable<Sensor[]> {
    return this.http.get<Sensor[]>('/api/sensors');
  }

  get(id: number): Observable<Sensor> {
    return this.http.get<Sensor>(`/api/sensors/${id}`);
  }

  updateConfig(id: number, config: Record<string, unknown>): Observable<Sensor> {
    return this.http.put<Sensor>(`/api/sensors/${id}/config`, config);
  }

  events(id: number, opts: { status?: 'active' | 'closed'; limit?: number } = {}): Observable<FlowEvent[]> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.limit)  params = params.set('limit',  String(opts.limit));
    return this.http.get<FlowEvent[]>(`/api/sensors/${id}/events`, { params });
  }

  readings(id: number, opts: { from?: string; to?: string; limit?: number } = {}): Observable<FlowReading[]> {
    let params = new HttpParams();
    if (opts.from)  params = params.set('from',  opts.from);
    if (opts.to)    params = params.set('to',    opts.to);
    if (opts.limit) params = params.set('limit', String(opts.limit));
    return this.http.get<FlowReading[]>(`/api/sensors/${id}/readings`, { params });
  }

  consumption(
    id: number,
    bucket: 'hour' | 'day' | 'month',
    opts: { from?: string; to?: string } = {},
  ): Observable<ConsumptionBucket[]> {
    let params = new HttpParams().set('bucket', bucket);
    if (opts.from) params = params.set('from', opts.from);
    if (opts.to)   params = params.set('to',   opts.to);
    return this.http.get<ConsumptionBucket[]>(`/api/sensors/${id}/consumption`, { params });
  }

  snooze(id: number, hours: number): Observable<{ snoozedUntil: string }> {
    return this.http.post<{ snoozedUntil: string }>(`/api/sensors/${id}/snooze?hours=${hours}`, {});
  }

  unsnooze(id: number): Observable<void> {
    return this.http.delete<void>(`/api/sensors/${id}/snooze`);
  }

  ackEvent(sensorId: number, eventId: number, reason?: string): Observable<{ acked: boolean }> {
    return this.http.post<{ acked: boolean }>(
      `/api/sensors/${sensorId}/events/${eventId}/ack`,
      { reason },
    );
  }
}
