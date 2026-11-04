import { Component, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { Device } from '../../shared/models/device.model';
import { SOLAR_EVENTS, cronProblem, describeCron, describeTiming, timingOrder } from './schedule-text';

interface Schedule {
  id: number;
  deviceId: number;
  deviceAlias: string;
  label: string;
  triggerType: 'cron' | 'solar' | 'auto_off';
  cronExpression: string | null;
  solarEvent: string | null;
  solarOffsetMinutes: number;
  durationMinutes: number | null;
  state: boolean;
  enabled: boolean;
  /** Set when the scheduler can't read it, so it never runs. */
  problem?: string | null;
}

interface ScheduleGroup {
  deviceId: number;
  deviceAlias: string;
  schedules: Schedule[];
}

const COLLAPSED_KEY = 'homehub.schedules.collapsed';

function loadCollapsed(): Set<number> {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'number') : []);
  } catch {
    return new Set();
  }
}

const CRON_PRESETS = [
  { label: 'Every day at midnight',  value: '0 0 * * *' },
  { label: 'Every day at 6 AM',      value: '0 6 * * *' },
  { label: 'Every day at 9 PM',      value: '0 21 * * *' },
  { label: 'Every weekday at 8 AM',  value: '0 8 * * 1-5' },
  { label: 'Custom…',                value: '' }];

@Component({
  selector: 'app-schedules',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.5rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .btn-add {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      padding: 0.5rem 1.1rem;
    }
    .btn-add:hover { background: var(--accent-hover); }

    /* Schedule list */
    .schedule-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .group-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .group-name { flex: 1; font-size: 1.05rem; font-weight: 700; min-width: 0; }
    .group-toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      background: transparent;
      border: none;
      color: var(--text);
      font: inherit;
      text-align: left;
      padding: 0.2rem 0;
    }
    .group-toggle:hover { color: var(--accent); }
    .group-chevron { color: var(--text-muted); transition: transform 0.15s; }
    .group-chevron.open { transform: rotate(90deg); }
    .group-alias { min-width: 0; overflow-wrap: anywhere; }
    .group-count {
      background: var(--bg);
      border-radius: 999px;
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.1rem 0.5rem;
    }
    .group-add {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--accent);
      padding: 0.3rem 0.8rem;
      font-size: 0.8rem;
      flex-shrink: 0;
    }
    .group-add:hover { background: var(--surface); }
    .schedule-row {
      display: flex;
      align-items: center;
      gap: 0.5rem 1rem;
      flex-wrap: wrap;
      margin-top: 0.75rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }
    .schedule-row.disabled .schedule-info { opacity: 0.55; }
    .schedule-info { flex: 1 1 14rem; min-width: 0; }
    .schedule-actions { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
    .schedule-label { font-weight: 600; overflow-wrap: anywhere; }
    .cron-check { font-size: 0.8rem; margin: 0.35rem 0 0; overflow-wrap: anywhere; }
    .cron-check.bad { color: var(--red); }
    .cron-check.ok { color: var(--text-muted); }
    .schedule-problem { font-size: 0.8rem; color: var(--red); margin-top: 0.2rem; overflow-wrap: anywhere; }
    .schedule-meta { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.2rem; overflow-wrap: anywhere; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.6rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-left: 0.4rem;
    }
    .badge-on  { background: #14532d; color: var(--green); }
    .badge-off { background: #1c1917; color: var(--text-muted); }

    .toggle-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 0.3rem 0.8rem;
      font-size: 0.8rem;
    }
    .toggle-btn.active { border-color: var(--green); color: var(--green); }
    .toggle-btn:hover { background: var(--surface); }

    .edit-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.3rem 0.5rem;
      font-size: 1rem;
    }
    .edit-btn:hover { color: var(--accent); }

    .delete-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.3rem 0.5rem;
      font-size: 1rem;
    }
    .delete-btn:hover { color: var(--red); }

    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }

    /* Create form */
    .form-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      padding: 1rem; z-index: 100;
    }
    .form-card { width: 100%; max-width: 480px; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; }
    .form-card h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 1.25rem; }
    .field { margin-bottom: 1rem; }
    label { display: block; font-size: 0.82rem; font-weight: 500; color: var(--text-muted); margin-bottom: 0.3rem; }
    select {
      width: 100%;
      font-family: inherit; font-size: 1rem;
      background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: var(--radius);
      padding: 0.6rem 0.9rem; outline: none;
    }
    select:focus { border-color: var(--accent); }
    .row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
    .form-actions { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
    .btn-cancel {
      flex: 1; background: transparent;
      border: 1px solid var(--border); color: var(--text-muted);
    }
    .btn-cancel:hover { background: var(--surface); }
    .btn-save { flex: 2; }

    .label-row { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.3rem; }
    .label-row .field-label { font-size: 0.82rem; font-weight: 500; color: var(--text-muted); }
    .help-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 50%;
      width: 1.3rem;
      height: 1.3rem;
      font-size: 0.7rem;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      line-height: 1;
      flex-shrink: 0;
    }
    .help-btn:hover { border-color: var(--accent); color: var(--accent); }

    .cron-help {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.6rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
      line-height: 1.6;
    }
    .cron-help code {
      font-family: monospace;
      color: var(--text);
      background: var(--bg);
      padding: 0.05rem 0.3rem;
      border-radius: 3px;
    }
    .cron-help table { border-collapse: collapse; width: 100%; margin: 0.3rem 0; }
    .cron-help th { color: var(--text); font-size: 0.7rem; text-align: left; padding: 0.1rem 0.4rem 0.1rem 0; }
    .cron-help td { padding: 0.1rem 0.4rem 0.1rem 0; }
  `],
  template: `
    <div class="page">

      <div class="topbar">
        <div style="display:flex; align-items:center; gap:1rem">
          <h1>Schedules</h1>
        </div>
        @if (auth.user()?.role === 'admin') {
          <button class="btn-add" (click)="openCreate()">+ New Schedule</button>
        }
      </div>

      <!-- List, grouped by device -->
      @if (groups().length === 0) {
        <div class="empty">No schedules yet. Create one to automate your plugs.</div>
      } @else {
        <div class="schedule-list">
          @for (group of groups(); track group.deviceId) {
            <section class="card">
              <div class="group-header">
                <h2 class="group-name">
                  <button
                    class="group-toggle"
                    [attr.aria-expanded]="!isCollapsed(group.deviceId)"
                    (click)="toggleGroup(group.deviceId)">
                    <span class="group-chevron" [class.open]="!isCollapsed(group.deviceId)">▸</span>
                    <span class="group-alias">{{ group.deviceAlias }}</span>
                    <span class="group-count">{{ group.schedules.length }}</span>
                  </button>
                </h2>
                @if (auth.user()?.role === 'admin') {
                  <button class="group-add" (click)="openCreate(group.deviceId)">+ Add</button>
                }
              </div>

              @for (s of visibleSchedules(group); track s.id) {
                <div class="schedule-row" [class.disabled]="!s.enabled">
                  <div class="schedule-info">
                    <div class="schedule-label">
                      {{ timing(s) }}
                      <span class="badge" [class.badge-on]="s.state" [class.badge-off]="!s.state">
                        {{ s.state ? 'ON' : 'OFF' }}
                      </span>
                    </div>
                    @if (s.label !== timing(s)) {
                      <div class="schedule-meta">{{ s.label }}</div>
                    }
                    @if (s.problem) {
                      <div class="schedule-problem">Never runs: {{ s.problem }} Edit it to fix the time.</div>
                    }
                  </div>

                  @if (auth.user()?.role === 'admin') {
                    <div class="schedule-actions">
                      <button
                        class="toggle-btn"
                        [class.active]="s.enabled"
                        (click)="toggleEnabled(s)">
                        {{ s.enabled ? 'Enabled' : 'Disabled' }}
                      </button>
                      <button class="edit-btn" title="Edit" (click)="openEdit(s)">✎</button>
                      <button class="delete-btn" title="Delete" (click)="deleteSchedule(s)">✕</button>
                    </div>
                  }
                </div>
              }
            </section>
          }
        </div>
      }
    </div>

    <!-- Create / Edit form modal -->
    @if (showForm()) {
      <div class="form-overlay" (click)="closeForm()">
        <div class="card form-card" (click)="$event.stopPropagation()">
          <h2>{{ editingId() ? 'Edit Schedule' : 'New Schedule' }}</h2>

          <div class="field">
            <label>Device</label>
            <select [(ngModel)]="form.deviceId">
              <option value="">Select a device…</option>
              @for (d of devices(); track d.id) {
                <option [value]="d.id">{{ d.alias }}</option>
              }
            </select>
          </div>

          <div class="field">
            <label>Label (optional)</label>
            <input type="text" [(ngModel)]="form.label" placeholder="e.g. Porch on at sunset" />
          </div>

          <div class="row-2">
            <div class="field">
              <label>Trigger type</label>
              <select [(ngModel)]="form.triggerType">
                <option value="solar">Solar event</option>
                <option value="cron">Cron (fixed time)</option>
                <option value="auto_off">Auto-off timer</option>
              </select>
            </div>
            @if (form.triggerType !== 'auto_off') {
              <div class="field">
                <label>Action</label>
                <select [(ngModel)]="form.state">
                  <option [ngValue]="true">Turn ON</option>
                  <option [ngValue]="false">Turn OFF</option>
                </select>
              </div>
            }
          </div>

          @if (form.triggerType === 'solar') {
            <div class="row-2">
              <div class="field">
                <label>Solar event</label>
                <select [(ngModel)]="form.solarEvent">
                  @for (e of solarEvents; track e.value) {
                    <option [value]="e.value">{{ e.label }}</option>
                  }
                </select>
              </div>
              <div class="field">
                <label>Offset (minutes)</label>
                <input type="number" [(ngModel)]="form.solarOffsetMinutes" placeholder="0" />
              </div>
            </div>
          }

          @if (form.triggerType === 'cron') {
            <div class="field">
              <label>Preset</label>
              <select [(ngModel)]="form.selectedPreset" (change)="applyPreset($event)">
                @for (p of cronPresets; track p.value) {
                  <option [value]="p.value">{{ p.label }}</option>
                }
              </select>
            </div>
            <div class="field">
              <div class="label-row">
                <span class="field-label">Cron expression</span>
                <button type="button" class="help-btn" (click)="toggleCronHelp($event)">?</button>
              </div>
              @if (showCronHelp()) {
                <div class="cron-help" style="margin-top:0.4rem">
                  <strong style="color:var(--text)">Format:</strong>
                  <code>min&nbsp;&nbsp;hour&nbsp;&nbsp;day&nbsp;&nbsp;month&nbsp;&nbsp;weekday</code><br>
                  <table>
                    <tr><th>Field</th><th>Range</th><th>Example</th></tr>
                    <tr><td>min</td><td>0–59</td><td><code>30</code> = at :30</td></tr>
                    <tr><td>hour</td><td>0–23</td><td><code>21</code> = 9 PM</td></tr>
                    <tr><td>day</td><td>1–31</td><td><code>*</code> = every day</td></tr>
                    <tr><td>month</td><td>1–12</td><td><code>*</code> = every month</td></tr>
                    <tr><td>weekday</td><td>0–6 (Sun=0)</td><td><code>1-5</code> = Mon–Fri</td></tr>
                  </table>
                  <div style="margin-top:0.3rem">
                    <code>0 21 * * *</code> — every day at 9 PM<br>
                    <code>0 8 * * 1-5</code> — weekdays at 8 AM<br>
                    <code>0 8,20 * * *</code> — 8 AM and 8 PM daily<br>
                    <code>30 0 * * *</code> — 12:30 AM daily (minute first)
                  </div>
                </div>
              }
              <input type="text" [(ngModel)]="form.cronExpression" placeholder="0 21 * * *" style="margin-top:0.3rem"
                     [attr.aria-invalid]="!!cronCheck().problem" aria-describedby="cron-check" />
              @if (cronCheck(); as c) {
                @if (c.problem) { <p id="cron-check" class="cron-check bad">{{ c.problem }}</p> }
                @else if (c.words) { <p id="cron-check" class="cron-check ok">Runs: {{ c.words }}</p> }
              }
            </div>
          }

          @if (form.triggerType === 'auto_off') {
            <div class="field">
              <label>Turn off after (minutes)</label>
              <input type="number" [(ngModel)]="form.durationMinutes" min="1" placeholder="15" />
            </div>
            <p style="font-size:0.8rem; color:var(--text-muted); margin: -0.5rem 0 1rem">
              Turns the device off automatically N minutes after it is switched on.
              Use the override button on the tile to keep it on longer when needed.
            </p>
          }

          @if (formError()) {
            <p class="error-msg">{{ formError() }}</p>
          }

          <div class="form-actions">
            <button class="btn-cancel" (click)="closeForm()">Cancel</button>
            <button class="btn-primary btn-save" [disabled]="saving() || (form.triggerType === 'cron' && !!cronCheck().problem)" (click)="save()">
              {{ saving() ? 'Saving…' : (editingId() ? 'Update Schedule' : 'Save Schedule') }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SchedulesComponent implements OnInit {
  readonly solarEvents  = SOLAR_EVENTS;
  readonly cronPresets  = CRON_PRESETS;

  private readonly _schedules = signal<Schedule[]>([]);
  private readonly _devices   = signal<Device[]>([]);
  private readonly _collapsed = signal(loadCollapsed());

  readonly devices    = this._devices.asReadonly();
  readonly groups     = computed<ScheduleGroup[]>(() => {
    const byDevice = new Map<number, ScheduleGroup>();
    for (const s of this._schedules()) {
      const group = byDevice.get(s.deviceId)
        ?? { deviceId: s.deviceId, deviceAlias: s.deviceAlias, schedules: [] };
      group.schedules.push(s);
      byDevice.set(s.deviceId, group);
    }
    const groups = [...byDevice.values()];
    groups.sort((a, b) => a.deviceAlias.localeCompare(b.deviceAlias));
    groups.forEach((g) => g.schedules.sort((a, b) => timingOrder(a) - timingOrder(b)));
    return groups;
  });
  readonly showForm      = signal(false);
  readonly saving        = signal(false);
  readonly formError     = signal('');
  readonly showCronHelp  = signal(false);
  readonly editingId     = signal<number | null>(null);

  form = this.blankForm();

  constructor(readonly auth: AuthService, private http: HttpClient) {}

  ngOnInit(): void {
    this.loadSchedules();
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
  }

  private loadSchedules(): void {
    this.http.get<Schedule[]>('/api/schedules').subscribe((s) => this._schedules.set(s));
  }

  private blankForm() {
    return {
      deviceId:           '' as number | '',
      label:              '',
      triggerType:        'solar' as 'solar' | 'cron' | 'auto_off',
      state:              true,
      solarEvent:         'sunset',
      solarOffsetMinutes: 0,
      cronExpression:     '',
      selectedPreset:     '',
      durationMinutes:    15,
    };
  }

  toggleCronHelp(e: Event): void {
    e.stopPropagation();
    this.showCronHelp.update((v) => !v);
  }

  isCollapsed(deviceId: number): boolean {
    return this._collapsed().has(deviceId);
  }

  visibleSchedules(group: ScheduleGroup): Schedule[] {
    return this.isCollapsed(group.deviceId) ? [] : group.schedules;
  }

  toggleGroup(deviceId: number): void {
    this.setCollapsed(deviceId, !this.isCollapsed(deviceId));
  }

  private setCollapsed(deviceId: number, collapsed: boolean): void {
    const next = new Set(this._collapsed());
    if (collapsed) next.add(deviceId); else next.delete(deviceId);
    this._collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Without storage, the choice just lasts until the page is reloaded.
    }
  }

  openCreate(deviceId?: number): void {
    this.form = { ...this.blankForm(), deviceId: deviceId ?? '' };
    this.showForm.set(true);
  }

  openEdit(s: Schedule): void {
    this.editingId.set(s.id);
    const expr = s.cronExpression ?? '';
    const matchedPreset = CRON_PRESETS.find((p) => p.value !== '' && p.value === expr);
    this.form = {
      deviceId:           s.deviceId,
      // An automatic label is left blank so it follows any change to the time.
      label:              s.label === this.timing(s) ? '' : s.label,
      triggerType:        s.triggerType,
      state:              s.state,
      solarEvent:         s.solarEvent ?? 'sunset',
      solarOffsetMinutes: s.solarOffsetMinutes,
      cronExpression:     expr,
      selectedPreset:     matchedPreset ? matchedPreset.value : '',
      durationMinutes:    s.durationMinutes ?? 15,
    };
    this.showForm.set(true);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form = this.blankForm();
    this.formError.set('');
    this.showCronHelp.set(false);
  }

  applyPreset(event: Event): void {
    const val = (event.target as HTMLSelectElement).value;
    this.form.selectedPreset = val;
    if (val !== '') this.form.cronExpression = val;
  }

  /** What the typed cron expression means, or what's wrong with it, while typing. */
  cronCheck(): { problem: string | null; words: string | null } {
    const expr = (this.form.cronExpression ?? '').trim();
    if (!expr) return { problem: null, words: null };
    const problem = cronProblem(expr);
    if (problem) return { problem, words: null };
    const words = describeCron(expr);
    return { problem: null, words: words === expr ? null : words };
  }

  timing(s: Schedule): string {
    return describeTiming(s);
  }

  save(): void {
    const { deviceId, triggerType, state, solarEvent, solarOffsetMinutes, cronExpression, durationMinutes } = this.form;
    if (!deviceId) { this.formError.set('Device is required.'); return; }
    if (triggerType === 'cron' && !cronExpression) { this.formError.set('Cron expression is required.'); return; }
    if (triggerType === 'auto_off' && (!durationMinutes || durationMinutes <= 0)) { this.formError.set('Duration must be greater than 0.'); return; }

    this.saving.set(true);
    this.formError.set('');

    const label = this.form.label.trim() || describeTiming({
      triggerType,
      cronExpression,
      solarEvent,
      solarOffsetMinutes: Number(solarOffsetMinutes),
      durationMinutes: Number(durationMinutes),
    });

    const payload = {
      deviceId: Number(deviceId), label, triggerType,
      state: triggerType === 'auto_off' ? false : state,
      ...(triggerType === 'solar'    ? { solarEvent, solarOffsetMinutes: Number(solarOffsetMinutes) } : {}),
      ...(triggerType === 'cron'     ? { cronExpression } : {}),
      ...(triggerType === 'auto_off' ? { durationMinutes: Number(durationMinutes) } : {}),
    };

    const id = this.editingId();
    const req$ = id
      ? this.http.put<Schedule>(`/api/schedules/${id}`, payload)
      : this.http.post<Schedule>('/api/schedules', payload);

    req$.subscribe({
      next: (result) => {
        if (id) {
          this._schedules.update((list) => list.map((x) => x.id === id ? result : x));
        } else {
          this._schedules.update((list) => [result, ...list]);
        }
        this.setCollapsed(result.deviceId, false); // Show what was just saved.
        this.closeForm();
        this.saving.set(false);
      },
      error: (err) => {
        this.formError.set(err.error?.error ?? 'Failed to save.');
        this.saving.set(false);
      },
    });
  }

  toggleEnabled(s: Schedule): void {
    this.http.patch<Schedule>(`/api/schedules/${s.id}/toggle`, { enabled: !s.enabled }).subscribe({
      next: (updated) => this._schedules.update((list) => list.map((x) => x.id === s.id ? updated : x)),
    });
  }

  deleteSchedule(s: Schedule): void {
    if (!confirm(`Delete "${s.label}"?`)) return;
    this.http.delete(`/api/schedules/${s.id}`).subscribe({
      next: () => this._schedules.update((list) => list.filter((x) => x.id !== s.id)),
    });
  }
}
