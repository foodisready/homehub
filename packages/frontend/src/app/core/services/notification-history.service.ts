import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface DispatchRow {
  id:              number;
  eventId:         number;
  channel:         'push' | 'email' | 'sms' | 'voice';
  level:           1 | 2 | 3;
  sentAt:          string;
  ackedAt:         string | null;
  userId:          number | null;
  userName:        string | null;
  sensorId:        number | null;
  sensorKey:       string | null;
  sensorAlias:     string | null;
  eventStatus:     'active' | 'closed' | null;
  eventStart:      string | null;
  eventEnd:        string | null;
  eventAlertLevel: number;
}

export interface HistoryQuery {
  channel?:  'push' | 'email' | 'sms' | 'voice';
  level?:    1 | 2 | 3;
  since?:    string;
  sensorId?: number;
  limit?:    number;
}

@Injectable({ providedIn: 'root' })
export class NotificationHistoryService {
  private http = inject(HttpClient);

  list(q: HistoryQuery = {}): Observable<DispatchRow[]> {
    let params = new HttpParams();
    if (q.channel)              params = params.set('channel', q.channel);
    if (q.level !== undefined)  params = params.set('level',   String(q.level));
    if (q.since)                params = params.set('since',   q.since);
    if (q.sensorId !== undefined) params = params.set('sensorId', String(q.sensorId));
    if (q.limit !== undefined)  params = params.set('limit',   String(q.limit));
    return this.http.get<DispatchRow[]>('/api/notifications/history', { params });
  }
}
