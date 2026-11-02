import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import type { Device } from '../../shared/models/device.model';
import {
  type ActivityEvent, type ActivitySource, causeText, clock, duration, eventTitle,
} from '../../shared/activity/activity-text';

const PAGE = 60;

/** Causes to filter by, grouped the way people think of them. */
const CAUSES: { value: ActivitySource | ''; label: string }[] = [
  { value: '', label: 'Any cause' },
  { value: 'app', label: 'Someone in the app' },
  { value: 'schedule', label: 'Schedules' },
  { value: 'scene', label: 'Scenes' },
  { value: 'timer', label: 'Timers' },
  { value: 'motion', label: 'Motion' },
  { value: 'chat', label: 'Chat' },
  { value: 'voice', label: 'Voice' },
  { value: 'assistant', label: 'AI assistant' },
  { value: 'outside', label: 'Outside HomeHub' },
];

/** Every device change and what caused it, newest first. */
@Component({
  selector: 'app-activity',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1rem; }
    .filters { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .filters select { flex: 1; min-width: 10rem; font-size: 0.88rem; padding: 0.45rem 0.6rem; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); }
    .day { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin: 1.25rem 0 0.4rem; }
    .list { padding: 0.25rem 1rem; }
    .item { display: flex; gap: 0.75rem; padding: 0.65rem 0; border-top: 1px solid var(--border); align-items: flex-start; }
    .item:first-child { border-top: none; }
    .dot { width: 9px; height: 9px; border-radius: 50%; margin-top: 0.45rem; flex-shrink: 0; background: var(--text-muted); }
    .dot.on { background: var(--green); }
    .dot.offline { background: var(--red); }
    .dot.door { background: #f59e0b; }
    .body { flex: 1; min-width: 0; }
    .title { font-size: 0.92rem; }
    .sub { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.1rem; }
    .time { font-size: 0.78rem; color: var(--text-muted); white-space: nowrap; margin-top: 0.15rem; }
    .muted { color: var(--text-muted); font-size: 0.88rem; }
    .more { text-align: center; margin-top: 0.85rem; }
    .btn-sm { padding: 0.35rem 0.8rem; font-size: 0.8rem; }
    .ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .settings { margin-top: 1.75rem; padding: 0.85rem 1rem; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .settings .label { flex: 1; min-width: 12rem; font-size: 0.9rem; }
    .settings .label small { display: block; color: var(--text-muted); font-size: 0.75rem; }
    .settings input { width: 5.5rem; text-align: right; font-size: 0.9rem; padding: 0.35rem 0.5rem; }
    .msg { font-size: 0.8rem; }
    .msg.ok { color: var(--green); }
    .msg.err { color: var(--red); }
  `],
  template: `
    <div class="page">
      <h1>Activity</h1>

      <div class="filters">
        <select [ngModel]="deviceId()" (ngModelChange)="setDevice($event)" aria-label="Device">
          <option [ngValue]="null">All devices</option>
          @for (d of devices(); track d.id) { <option [ngValue]="d.id">{{ d.alias }}</option> }
        </select>
        <select [ngModel]="source()" (ngModelChange)="setSource($event)" aria-label="Cause">
          @for (c of causes; track c.value) { <option [ngValue]="c.value">{{ c.label }}</option> }
        </select>
      </div>

      @if (loaded() && !events().length) {
        <p class="muted" style="margin-top:1rem">Nothing yet. Changes appear here as devices are switched.</p>
      }

      @for (day of days(); track day.label) {
        <div class="day">{{ day.label }}</div>
        <div class="card list">
          @for (e of day.items; track e.id) {
            <div class="item">
              <span class="dot" [class.on]="e.kind === 'power' && e.state && e.driverType !== 'meross'" [class.door]="e.kind === 'power' && e.state && e.driverType === 'meross'"
                    [class.offline]="e.kind === 'online' && !e.state"></span>
              <div class="body">
                <div class="title">{{ title(e) }}</div>
                <div class="sub">
                  @if (e.kind === 'power') { {{ cause(e) }} }
                  @if (e.onForSeconds !== null) { · {{ onFor(e) }} }
                  @if (e.room) { · {{ e.room }} }
                </div>
              </div>
              <span class="time">{{ time(e.at) }}</span>
            </div>
          }
        </div>
      }

      @if (hasMore()) {
        <div class="more"><button class="btn-sm ghost" type="button" (click)="loadMore()">Show older</button></div>
      }

      @if (isAdmin() && keepDays() !== null) {
        <div class="card settings">
          <span class="label">Keep activity for<small>Older entries are deleted automatically</small></span>
          <span style="white-space:nowrap"><input type="number" [min]="7" [max]="730" [value]="keepDays()" (change)="saveKeep(+$any($event.target).value)" aria-label="Days to keep activity" /> days</span>
          @if (settingsMsg()) { <span class="msg" [class.err]="settingsErr()" [class.ok]="!settingsErr()">{{ settingsMsg() }}</span> }
        </div>
      }
    </div>
  `,
})
export class ActivityComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly socket = inject(SocketService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly causes = CAUSES;
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly devices = signal<Device[]>([]);
  readonly events = signal<ActivityEvent[]>([]);
  readonly loaded = signal(false);
  readonly hasMore = signal(false);
  readonly deviceId = signal<number | null>(null);
  readonly source = signal<ActivitySource | ''>('');
  readonly keepDays = signal<number | null>(null);
  readonly settingsMsg = signal('');
  readonly settingsErr = signal(false);

  readonly days = computed(() => {
    const groups: { label: string; items: ActivityEvent[] }[] = [];
    for (const e of this.events()) {
      const label = this.dayLabel(e.at);
      const last = groups[groups.length - 1];
      if (last?.label === label) last.items.push(e); else groups.push({ label, items: [e] });
    }
    return groups;
  });

  private stopState?: () => void;
  private reloadTimer?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const id = Number(q.get('deviceId'));
    if (Number.isInteger(id) && id > 0) this.deviceId.set(id);
    this.http.get<Device[]>('/api/devices').subscribe((d) => this.devices.set([...d].sort((a, b) => a.alias.localeCompare(b.alias))));
    if (this.isAdmin()) this.http.get<{ keepDays: number }>('/api/activity/settings').subscribe((s) => this.keepDays.set(s.keepDays));
    this.load();
    // A switch anywhere shows up here a moment later.
    this.stopState = this.socket.onDeviceState(() => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => this.load(), 800);
    });
  }

  ngOnDestroy(): void {
    this.stopState?.();
    clearTimeout(this.reloadTimer);
  }

  private query(before?: number): string {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (this.deviceId() !== null) p.set('deviceId', String(this.deviceId()));
    if (this.source()) p.set('source', this.source());
    if (before !== undefined) p.set('before', String(before));
    return p.toString();
  }

  private load(): void {
    this.http.get<ActivityEvent[]>(`/api/activity?${this.query()}`).subscribe((list) => {
      this.events.set(list);
      this.hasMore.set(list.length === PAGE);
      this.loaded.set(true);
    });
  }

  loadMore(): void {
    const list = this.events();
    if (!list.length) return;
    this.http.get<ActivityEvent[]>(`/api/activity?${this.query(list[list.length - 1].id)}`).subscribe((more) => {
      this.events.update((l) => [...l, ...more]);
      this.hasMore.set(more.length === PAGE);
    });
  }

  setDevice(id: number | null): void {
    this.deviceId.set(id);
    this.router.navigate([], { queryParams: { deviceId: id }, replaceUrl: true });
    this.load();
  }

  setSource(source: ActivitySource | ''): void {
    this.source.set(source);
    this.load();
  }

  saveKeep(days: number): void {
    this.http.put<{ keepDays: number }>('/api/activity/settings', { keepDays: days }).subscribe({
      next: (s) => { this.keepDays.set(s.keepDays); this.settingsMsg.set('Saved'); this.settingsErr.set(false); },
      error: (err: HttpErrorResponse) => { this.settingsMsg.set(err.error?.error ?? 'Could not save'); this.settingsErr.set(true); },
    });
  }

  title = eventTitle;
  cause = causeText;
  time = clock;

  onFor(e: ActivityEvent): string {
    const word = e.driverType === 'meross' ? 'was open' : e.driverType === 'wyze' ? 'had been watching' : 'was on';
    return `${word} for ${duration(e.onForSeconds ?? 0)}`;
  }

  private dayLabel(iso: string): string {
    const d = new Date(iso), today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }
}
