import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { SocketService } from '../../core/socket/socket.service';

export type ThermostatMode = 'off' | 'heat' | 'cool' | 'auto';

export interface Ranges {
  comfort: { low: number; high: number };
  allowed: { low: number; high: number };
}

/** GET /api/thermostats/:id. Every temperature is °C; `unit` is how the home shows them. */
export interface ThermostatView extends Ranges {
  id: number;
  alias: string;
  room: string | null;
  online: boolean;
  unit: 'F' | 'C';
  temperature: number | null;
  heat: number | null;
  cool: number | null;
  mode: ThermostatMode | 'other';
  modes: ThermostatMode[];
  running: 'heating' | 'cooling' | 'fan' | 'idle' | null;
  heatLimits: [number, number] | null;
  coolLimits: [number, number] | null;
  deadband: number;
}

/** °C to the home's unit: whole degrees in °F, halves in °C. */
export function shown(c: number, unit: 'F' | 'C'): number {
  return unit === 'F' ? Math.round(c * 9 / 5 + 32) : Math.round(c * 2) / 2;
}

/** The home's unit to °C. */
export function toC(v: number, unit: 'F' | 'C'): number {
  return unit === 'F' ? Math.round(((v - 32) * 5 / 9) * 1000) / 1000 : v;
}

/** One step of − or +: 1 °F or 0.5 °C. */
export const step = (unit: 'F' | 'C') => (unit === 'F' ? 1 : 0.5);

export const MODE_NAME: Record<ThermostatMode | 'other', string> = { off: 'Off', heat: 'Heat', cool: 'Cool', auto: 'Auto', other: 'Other' };

/** "71° · Heating to 72°": a thermostat in a line, for the device list. */
export function summary(t: ThermostatView): string {
  if (!t.online) return 'Not connected';
  const deg = (c: number | null) => (c === null ? '–' : `${shown(c, t.unit)}°`);
  const room = t.temperature === null ? '' : `${deg(t.temperature)} · `;
  const doing = t.running === 'heating' ? 'Heating' : t.running === 'cooling' ? 'Cooling' : null;
  switch (t.mode) {
    case 'off': return `${room}Off`;
    case 'heat': return `${room}${doing ?? 'Heat'} to ${deg(t.heat)}`;
    case 'cool': return `${room}${doing ?? 'Cool'} to ${deg(t.cool)}`;
    case 'auto': return `${room}${doing ? doing + ', ' : ''}keeping ${deg(t.heat)}–${deg(t.cool)}`;
    default: return `${room}Set on the thermostat`;
  }
}

/** Every thermostat's latest state, kept current by the server's thermostat:state events. */
@Injectable({ providedIn: 'root' })
export class ThermostatService {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SocketService);
  private readonly _views = signal<ReadonlyMap<number, ThermostatView>>(new Map());
  readonly views = this._views.asReadonly();
  private listening = false;

  private put(v: ThermostatView): void {
    this._views.update((m) => new Map(m).set(v.id, v));
  }

  /** Loads one, and starts listening for changes the first time. */
  watch(id: number): void {
    if (!this.listening) {
      this.listening = true;
      this.socket.onThermostatState((v) => this.put(v as ThermostatView));
      this.socket.onReconnect(() => { for (const known of this._views().keys()) this.load(known); });
    }
    if (!this._views().has(id)) this.load(id);
  }

  load(id: number): void {
    this.http.get<ThermostatView>(`/api/thermostats/${id}`).subscribe({ next: (v) => this.put(v), error: () => undefined });
  }

  /** Mode or targets, in °C. */
  change(id: number, patch: { mode?: ThermostatMode; heat?: number; cool?: number }): Observable<ThermostatView> {
    return this.http.patch<ThermostatView>(`/api/thermostats/${id}`, patch).pipe(tap((v) => this.put(v)));
  }

  saveRanges(id: number, ranges: Ranges): Observable<Ranges> {
    return this.http.put<Ranges>(`/api/thermostats/${id}/ranges`, ranges).pipe(tap(() => this.load(id)));
  }
}
