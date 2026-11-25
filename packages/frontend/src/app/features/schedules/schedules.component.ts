import { Component, DestroyRef, OnDestroy, OnInit, signal, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SettingsTilesComponent, type SettingsTile } from '../settings/settings-tiles.component';
import { ThermostatScheduleComponent } from '../../shared/thermostat/thermostat-schedule.component';
import { AutomationsService } from '../../core/services/automations.service';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { Device } from '../../shared/models/device.model';
import { SOLAR_EVENTS, cronProblem, daysTimeCron, describeCron, describeDuration, describeTiming, readDaysTime, timingOrder } from './schedule-text';
import { isVacuum } from '../../shared/vacuum';

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
  /** On a Turn ON schedule: turns the device off again this many minutes later. */
  stayOnMinutes?: number | null;
  /** A robot vacuum's Clean schedule: its rooms' keys, and their names now (null: forgotten). Null: the whole house. */
  rooms?: string[] | null;
  roomNames?: (string | null)[] | null;
  state: boolean;
  enabled: boolean;
  /** Set when the scheduler can't read it, so it never runs. */
  problem?: string | null;
  /** When it runs next (ISO), within two days; null otherwise. */
  next?: string | null;
}

interface ScheduleGroup {
  deviceId: number;
  deviceAlias: string;
  schedules: Schedule[];
}

/** One line of "Coming up": what happens at one time. */
interface Coming { key: string; at: number; time: string; day: string; names: string; state: boolean; verb: string; why: string }

/** Lists names the way a person says them: "A, B and C". */
const joinNames = (n: string[]) => (n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`);

const CRON_PRESETS = [
  { label: 'Every day at midnight',  value: '0 0 * * *' },
  { label: 'Every day at 6 AM',      value: '0 6 * * *' },
  { label: 'Every day at 9 PM',      value: '0 21 * * *' },
  { label: 'Every weekday at 8 AM',  value: '0 8 * * 1-5' },
  { label: 'Custom…',                value: '' }];

/** The week as people read it, Monday first: cron's day number and a short name. */
const WEEK = [1, 2, 3, 4, 5, 6, 0].map((n) => ({ n, short: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n] }));

@Component({
  selector: 'app-schedules',
  standalone: true,
  imports: [FormsModule, ThermostatScheduleComponent, SettingsTilesComponent],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.5rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .btn-add {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      padding: 0.5rem 1.1rem;
    }
    .btn-add:hover { background: var(--accent-hover); }

    .group-add { background: transparent; border: 1px solid var(--border); color: var(--accent); padding: 0.3rem 0.8rem; font-size: 0.8rem; flex-shrink: 0; }
    .hh-pagebar h2 { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .paged { display: flex; flex-direction: column; gap: 0.6rem; animation: hh-slide .28s cubic-bezier(.2, .8, .2, 1); }
    .rule { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem 0.8rem; align-items: center; padding: 0.85rem 1rem; }
    .rule.paused .rule-main { opacity: 0.55; }
    .rule-main { min-width: 0; }
    .rule-acts { grid-column: 1 / -1; display: flex; gap: 1.1rem; border-top: 1px solid var(--border); padding-top: 0.5rem; }
    .link { background: none; border: none; padding: 0; color: var(--accent); font-size: 0.85rem; }
    .link.del { color: var(--text-muted); }
    .sw { width: 2.9rem; height: 1.7rem; border-radius: 999px; border: none; padding: 0; background: var(--border); position: relative; flex: none; transition: background .15s; }
    .sw span { position: absolute; top: 3px; left: 3px; width: calc(1.7rem - 6px); height: calc(1.7rem - 6px); border-radius: 50%; background: #fff; transition: transform .15s; }
    .sw[aria-checked="true"] { background: var(--green); }
    .sw[aria-checked="true"] span { transform: translateX(1.2rem); }
    .sw:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .coming { margin-bottom: 1.25rem; padding: 1rem 1.1rem; }
    .coming h2 { margin: 0 0 0.6rem; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .coming ol { list-style: none; margin: 0; padding: 0; }
    .coming li { display: grid; grid-template-columns: 4.6rem 1fr auto; gap: 0.7rem; align-items: center; padding: 0.5rem 0; border-top: 1px solid var(--border); }
    .coming li:first-child { border-top: none; padding-top: 0; }
    .coming .t { font-weight: 600; font-variant-numeric: tabular-nums; font-size: 0.9rem; }
    .coming .t small, .coming .what small { display: block; font-weight: 400; font-size: 0.74rem; color: var(--text-muted); }
    .coming .what { min-width: 0; overflow-wrap: anywhere; }
    .coming .what b { font-weight: 500; font-size: 0.9rem; }
    .coming li.first .t { color: var(--accent); font-size: 1.05rem; }
    .coming li.first .what b { font-weight: 700; }
    .coming .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--text-muted); opacity: .5; }
    .coming .dot.on { background: var(--green); opacity: 1; }
    .coming > .link { margin-top: 0.5rem; }
    .coming .schedule-problem { margin: 0.6rem 0 0; }
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

    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }

    /* Create form */
    .form-card h2 { font-size: 1.2rem; font-weight: 700; margin: 0 0 1.25rem; }
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
    .stay-row { display: grid; grid-template-columns: 1fr auto; gap: 0.5rem; }
    .field-help { font-size: 0.8rem; color: var(--text-muted); margin: 0.35rem 0 0; line-height: 1.4; }
    .stay-on { font-size: 0.85rem; font-weight: 500; color: var(--text-muted); margin-left: 0.35rem; }
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
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 999px; padding: 0.4rem 0.8rem; font-size: 0.85rem; min-height: 2.2rem; }
    .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip i { font-style: normal; font-size: 0.7rem; opacity: .8; margin-left: 0.3rem; }
    .day { min-width: 3rem; }
    #at-time { color-scheme: dark; }
    .field > .field-label { display: block; font-size: 0.82rem; font-weight: 500; color: var(--text-muted); }
  `],
  template: `
    <div class="page">
      @if (pageId(); as id) {
        <div class="hh-pagebar">
          <button type="button" class="hh-back" (click)="closePage()" aria-label="Back to Schedules">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <h2>{{ pageName() }}</h2>
          @if (canEdit() && !pageThermostat()) { <button type="button" class="group-add" (click)="openCreate(id)">+ Add</button> }
        </div>
        <div class="paged">
          @if (pageThermostat()) {
            <app-thermostat-schedule [deviceId]="id" [canEdit]="canEdit()" />
          } @else {
            @for (s of pageSchedules(); track s.id) {
              <div class="card rule" [class.paused]="!s.enabled">
                <div class="rule-main">
                  <div class="schedule-label">
                    {{ timing(s) }}
                    <span class="badge" [class.badge-on]="s.state" [class.badge-off]="!s.state">{{ actionWord(s).toUpperCase() }}</span>
                    @if (s.state && s.stayOnMinutes) { <span class="stay-on">for {{ duration(s.stayOnMinutes) }}</span> }
                  </div>
                  @if (s.label !== timing(s)) { <div class="schedule-meta">{{ s.label }}</div> }
                  @if (roomsText(s); as r) { <div class="schedule-meta">{{ r }}</div> }
                  @if (s.problem) { <div class="schedule-problem">Never runs: {{ s.problem }} Edit it to fix the time.</div> }
                  @else { <div class="schedule-meta">{{ !s.enabled ? 'Paused' : s.next ? 'Next: ' + when(s.next) : s.triggerType === 'auto_off' ? 'Whenever it’s switched on' : 'Not in the next two days' }}</div> }
                </div>
                @if (canEdit()) {
                  <button type="button" class="sw" role="switch" [attr.aria-checked]="s.enabled" [attr.aria-label]="(s.enabled ? 'Pause ' : 'Resume ') + timing(s)" (click)="toggleEnabled(s)"><span></span></button>
                  <div class="rule-acts">
                    <button type="button" class="link" (click)="openEdit(s)">Edit</button>
                    <button type="button" class="link del" (click)="deleting.set(s)">Delete</button>
                  </div>
                }
              </div>
            } @empty {
              <p class="empty">No schedules for {{ pageName() }} yet.</p>
            }
          }
        </div>
      } @else {
        <div class="topbar">
          <h1>Schedules</h1>
          @if (canEdit()) { <button class="btn-add" (click)="openCreate()">+ New schedule</button> }
        </div>

        @if (coming().length || problems().length) {
          <section class="card coming" aria-labelledby="coming-title">
            <h2 id="coming-title">Coming up</h2>
            <ol>
              @for (e of shownComing(); track e.key; let first = $first) {
                <li [class.first]="first">
                  <span class="t">{{ e.time }}@if (e.day) {<small>{{ e.day }}</small>}</span>
                  <span class="what">
                    <b>{{ e.names }} {{ e.verb }}</b>
                    <small>{{ e.why }}@if (first) { · {{ inText(e.at) }} }</small>
                  </span>
                  <span class="dot" [class.on]="e.state" aria-hidden="true"></span>
                </li>
              }
            </ol>
            @if (coming().length > comingShown) {
              <button type="button" class="link" (click)="allComing.set(!allComing())">{{ allComing() ? 'Show fewer' : 'Show all ' + coming().length }}</button>
            }
            @for (p of problems(); track p.id) {
              <p class="schedule-problem">{{ p.deviceAlias }}: a schedule never runs. <button type="button" class="link" (click)="openPage(p.deviceId)">Fix it</button></p>
            }
          </section>
        }

        @if (tiles().length) {
          <app-settings-tiles [tiles]="tiles()" [searchable]="tiles().length > 6" placeholder="Search schedules: a device or room…" (open)="openPage(+$event)" />
        } @else {
          <div class="empty">No schedules yet. Create one to switch a device at a time of day, or at sunset.</div>
        }
      }
    </div>

    @if (deleting(); as s) {
      <div class="hh-scrim" (click)="deleting.set(null)">
        <div class="hh-sheet" role="dialog" aria-modal="true" aria-labelledby="del-title" (click)="$event.stopPropagation()">
          <div class="hh-grab"></div>
          <h3 id="del-title">Delete this schedule?</h3>
          <p>{{ s.deviceAlias }}: {{ timing(s) }}, {{ actionWord(s).toLowerCase() }}. To stop it for a while instead, pause it with its switch.</p>
          <div class="hh-acts"><button type="button" (click)="deleting.set(null)">Cancel</button><button type="button" class="danger" (click)="deleteSchedule(s)">Delete</button></div>
        </div>
      </div>
    }

    <!-- Create / Edit form modal -->
    @if (showForm()) {
      <div class="hh-scrim" (click)="closeForm()">
        <div class="hh-sheet form-card" role="dialog" aria-modal="true" aria-labelledby="form-title" (click)="$event.stopPropagation()">
          <div class="hh-grab"></div>
          <h2 id="form-title">{{ editingId() ? 'Edit schedule' : 'New schedule' }}</h2>

          <div class="field">
            <label>Device</label>
            <select [(ngModel)]="form.deviceId" (ngModelChange)="deviceChanged()">
              <option value="">Select a device…</option>
              @for (d of devices(); track d.id) {
                <option [value]="d.id">{{ d.alias }}</option>
              }
            </select>
          </div>

          <div class="field">
            <label>Label (optional)</label>
            <input type="text" [(ngModel)]="form.label" [placeholder]="formVacuum() ? 'e.g. Vacuum the house' : 'e.g. Porch on at sunset'" />
          </div>

          <div class="row-2">
            <div class="field">
              <label>Trigger type</label>
              <select [(ngModel)]="form.triggerType">
                <option value="days">Days and time</option>
                <option value="solar">Solar event</option>
                <option value="cron">Cron (advanced)</option>
                @if (!formVacuum()) { <option value="auto_off">Auto-off timer</option> }
              </select>
            </div>
            @if (form.triggerType !== 'auto_off') {
              <div class="field">
                <label>Action</label>
                <select [(ngModel)]="form.state">
                  <option [ngValue]="true">{{ formVacuum() ? 'Clean' : formSpeaker() ? 'Play' : 'Turn ON' }}</option>
                  <option [ngValue]="false">{{ formVacuum() ? 'Send home' : formSpeaker() ? 'Pause' : 'Turn OFF' }}</option>
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

          @if (form.triggerType === 'days') {
            <div class="field">
              <span class="field-label" id="days-label">Days</span>
              <div class="chips" role="group" aria-labelledby="days-label" style="margin-top:0.3rem">
                @for (d of week; track d.n) {
                  <button type="button" class="chip day" [attr.aria-pressed]="form.days[d.n]" (click)="form.days[d.n] = !form.days[d.n]">{{ d.short }}</button>
                }
              </div>
            </div>
            <div class="field">
              <label for="at-time">Time</label>
              <input id="at-time" type="time" [(ngModel)]="form.time" required aria-describedby="days-check" />
              <p id="days-check" class="cron-check" [class.bad]="!!daysCheck().problem" [class.ok]="!daysCheck().problem">{{ daysCheck().problem ?? 'Runs: ' + daysCheck().words }}</p>
            </div>
          }

          @if (formVacuum() && form.state && form.triggerType !== 'auto_off') {
            <div class="field">
              <span class="field-label" id="rooms-label">Rooms</span>
              <div class="chips" role="group" aria-labelledby="rooms-label" style="margin-top:0.3rem">
                <button type="button" class="chip" [attr.aria-pressed]="!form.rooms.length" (click)="form.rooms = []">Whole house</button>
                @for (r of formRooms(); track r.key) {
                  <button type="button" class="chip" [attr.aria-pressed]="form.rooms.includes(r.key)" (click)="toggleRoom(r.key)">{{ r.name }}@if (form.rooms.length > 1 && form.rooms.includes(r.key)) {<i>{{ form.rooms.indexOf(r.key) + 1 }}</i>}</button>
                }
              </div>
              <p class="field-help">
                @if (!formRooms().length) { To pick rooms, name them first on the robot’s card. }
                @else if (form.rooms.length > 1) { Cleaned in the order picked. }
                @else { It stops by itself when it’s done. If it’s already out on a job then, it carries on with that one. }
              </p>
            </div>
          }

          @if (form.triggerType !== 'auto_off' && form.state && !formVacuum()) {
            <div class="field">
              <label for="stay-on">{{ formSpeaker() ? 'Pause after' : 'Turn off after' }} (optional)</label>
              <div class="stay-row">
                <input id="stay-on" type="number" min="1" [max]="form.stayOnUnit === 'h' ? 24 : 1440" step="any"
                       [(ngModel)]="form.stayOnValue" placeholder="Stays on" aria-describedby="stay-on-help" />
                <select [(ngModel)]="form.stayOnUnit" aria-label="Unit">
                  <option value="min">minutes</option>
                  <option value="h">hours</option>
                </select>
              </div>
              <p id="stay-on-help" class="field-help">
                @if (stayOnPreview(); as p) { Turns off {{ p }} after this schedule turns it on. }
                @else { Leave empty and it stays on until something turns it off. }
                Switching it yourself in the meantime cancels this.
              </p>
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
            <button class="btn-primary btn-save" [disabled]="saving() || (form.triggerType === 'cron' && !!cronCheck().problem) || (form.triggerType === 'days' && !!daysCheck().problem)" (click)="save()">
              {{ saving() ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class SchedulesComponent implements OnInit, OnDestroy {
  readonly solarEvents  = SOLAR_EVENTS;
  readonly cronPresets  = CRON_PRESETS;
  readonly week         = WEEK;

  private readonly _schedules = signal<Schedule[]>([]);
  private readonly _devices   = signal<Device[]>([]);

  readonly devices    = this._devices.asReadonly();
  /** Matter thermostats, each with its temperature schedule. */
  readonly thermostats = computed(() => this._devices().filter((d) => d.driverConfig?.['kind'] === 'thermostat'));
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
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

  private readonly automations = inject(AutomationsService);
  /** Admins edit, except on a backup HomeHub, which is copied from the active one. */
  readonly canEdit = computed(() => this.auth.user()?.role === 'admin' && !this.automations.readOnly());

  constructor(readonly auth: AuthService, private http: HttpClient) {}

  ngOnInit(): void {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      // ?device=<id>, or ?thermostat=<id> from a thermostat card's link.
      const id = Number(q.get('device') ?? q.get('thermostat')) || null;
      if (!id) this.openedHere = false;
      if (id !== this.pageId()) window.scrollTo({ top: 0 });
      this.pageId.set(id);
    });
    this.loadSchedules();
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
    this.http.get<{ timezone?: string }>('/api/home-settings').subscribe({ next: (h) => this.timeZone.set(h.timezone), error: () => undefined });
    // The clock moves on: "in 2 h" counts down, and once something has run, its next time is fetched.
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      if (this._schedules().some((s) => s.enabled && s.next && Date.parse(s.next) < Date.now())) this.loadSchedules();
    }, 30_000);
  }

  ngOnDestroy(): void { clearInterval(this.timer); }

  private loadSchedules(): void {
    this.http.get<Schedule[]>('/api/schedules').subscribe((s) => this._schedules.set(s));
  }

  // ── Pages ──────────────────────────────────────────────────────

  /** The open device's page, from the address; null shows the tiles. */
  readonly pageId = signal<number | null>(null);
  private openedHere = false;
  readonly pageThermostat = computed(() => this.thermostats().some((t) => t.id === this.pageId()));
  readonly pageName = computed(() => this._devices().find((d) => d.id === this.pageId())?.alias
    ?? this._schedules().find((s) => s.deviceId === this.pageId())?.deviceAlias ?? 'Schedules');
  readonly pageSchedules = computed(() => this.groups().find((g) => g.deviceId === this.pageId())?.schedules ?? []);

  openPage(deviceId: number): void {
    this.openedHere = true;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { device: deviceId } });
  }

  closePage(): void {
    if (this.openedHere) { this.openedHere = false; history.back(); return; }
    void this.router.navigate([], { relativeTo: this.route, queryParams: { device: null, thermostat: null }, replaceUrl: true });
  }

  // ── Times ──────────────────────────────────────────────────────

  private timer?: ReturnType<typeof setInterval>;
  readonly now = signal(Date.now());
  /** The home's time zone: times read the home's way, wherever the phone is. */
  readonly timeZone = signal<string | undefined>(undefined);

  private dayKey(ms: number): string {
    return new Date(ms).toLocaleDateString('en-CA', { timeZone: this.timeZone() });
  }
  /** "6:12 PM", or "Midnight" and "Noon". */
  clock(ms: number): string {
    const t = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: this.timeZone() });
    return /^12:00\s?AM$/i.test(t) ? 'Midnight' : /^12:00\s?PM$/i.test(t) ? 'Noon' : t.replace(':00', '');
  }
  /** "" for today, "Tomorrow", or the weekday. */
  dayWord(ms: number): string {
    const today = this.dayKey(this.now());
    const key = this.dayKey(ms);
    if (key === today) return '';
    // The coming midnight is tonight, not tomorrow.
    if (this.clock(ms) === 'Midnight' && this.dayKey(ms - 60_000) === today) return '';
    if (key === this.dayKey(this.now() + 86_400_000)) return 'Tomorrow';
    return new Date(ms).toLocaleDateString([], { weekday: 'long', timeZone: this.timeZone() });
  }
  /** "Today 6:12 PM", "Tomorrow 7 AM". */
  when(iso: string): string {
    const ms = Date.parse(iso);
    const day = this.dayWord(ms), time = this.clock(ms);
    if (time === 'Midnight') return day ? `${day} at midnight` : 'Tonight at midnight';
    return `${day || 'Today'} ${time}`;
  }
  /** "in 2 h 5 min". */
  inText(ms: number): string {
    const min = Math.max(1, Math.round((ms - this.now()) / 60_000));
    if (min < 60) return `in ${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return `in ${h} h${m ? ` ${m} min` : ''}`;
  }

  // ── Coming up ──────────────────────────────────────────────────

  readonly comingShown = 5;
  readonly allComing = signal(false);

  /**
   * The next day's runs in time order, with schedules at the same moment doing the same thing as
   * one line: "6:12 PM · hallway lamp and Living room lamps on". A Turn ON with "turn off after"
   * adds its off too.
   */
  readonly coming = computed<Coming[]>(() => {
    const until = this.now() + 24 * 3_600_000;
    const runs: Array<{ at: number; name: string; state: boolean; verb: string; why: string }> = [];
    for (const s of this._schedules()) {
      if (!s.enabled || !s.next || s.problem) continue;
      const at = Date.parse(s.next);
      const rooms = this.roomsText(s);
      if (at <= until) runs.push({ at, name: s.deviceAlias, state: s.state, verb: this.comingVerb(s), why: this.timing(s) + (rooms ? ` · ${rooms}` : '') });
      if (s.state && s.stayOnMinutes) {
        const off = at + s.stayOnMinutes * 60_000;
        if (off <= until) runs.push({ at: off, name: s.deviceAlias, state: false, verb: 'off', why: `${describeDuration(s.stayOnMinutes)} after it came on` });
      }
    }
    const lines = new Map<string, { at: number; names: string[]; state: boolean; verb: string; whys: string[] }>();
    for (const r of runs.sort((a, b) => a.at - b.at)) {
      const key = `${Math.floor(r.at / 60_000)}-${r.verb}`;
      const l = lines.get(key) ?? { at: r.at, names: [], state: r.state, verb: r.verb, whys: [] };
      if (!l.names.includes(r.name)) l.names.push(r.name);
      if (!l.whys.includes(r.why)) l.whys.push(r.why);
      lines.set(key, l);
    }
    return [...lines.entries()].map(([key, l]) => ({
      key, at: l.at, time: this.clock(l.at), day: this.dayWord(l.at),
      names: l.names.length > 3 ? `${l.names.slice(0, 2).join(', ')} and ${l.names.length - 2} more` : joinNames(l.names),
      state: l.state, verb: l.verb, why: l.whys.join(' · '),
    }));
  });
  readonly shownComing = computed(() => (this.allComing() ? this.coming() : this.coming().slice(0, this.comingShown)));
  /** Schedules the scheduler can't read: they never run. */
  readonly problems = computed(() => this._schedules().filter((s) => s.problem));

  // ── Tiles ──────────────────────────────────────────────────────

  /** A tile for each device with schedules, and each thermostat: what it does and when. */
  readonly tiles = computed<SettingsTile[]>(() => {
    const devices = new Map(this._devices().map((d) => [d.id, d]));
    const out: SettingsTile[] = this.groups().filter((g) => !this.thermostats().some((t) => t.id === g.deviceId)).map((g) => {
      const d = devices.get(g.deviceId);
      const on = g.schedules.filter((s) => s.enabled);
      const paused = g.schedules.length - on.length;
      const parts = on.slice(0, 2).map((s) => `${this.actionWord(s)} ${s.next && s.triggerType !== 'auto_off' ? this.clock(Date.parse(s.next)).replace('Midnight', 'midnight').replace('Noon', 'noon') : this.timing(s).replace(/^Every day at /, '')}`);
      if (on.length > 2) parts.push(`+${on.length - 2} more`);
      const status = !on.length ? `Paused · ${g.schedules.length} ${g.schedules.length === 1 ? 'schedule' : 'schedules'}`
        : parts.join(' · ') + (paused ? ` · ${paused} paused` : '');
      const kind = d?.power?.excluded;
      const look = g.schedules.some((s) => s.problem) ? 'problem' as const : false;
      if (d && isVacuum(d)) {
        return { key: String(g.deviceId), name: g.deviceAlias, group: 'Robot vacuum', status, look, icon: 'vacuum', hue: on.length ? '#7aa2ff' : '#8e9ab4',
          words: `vacuum robot clean ${d.room ?? ''} ${d.nicknames?.join(' ') ?? ''} ${g.schedules.map((s) => `${s.label} ${this.timing(s)} ${this.roomsText(s) ?? ''}`).join(' ')}` } satisfies SettingsTile;
      }
      if (d?.driverType === 'sonos') {
        return { key: String(g.deviceId), name: g.deviceAlias, group: 'Entertainment', status, look, icon: 'speaker', hue: on.length ? '#c084fc' : '#8e9ab4',
          words: `sonos speaker music ${d.room ?? ''} ${d.nicknames?.join(' ') ?? ''} ${g.schedules.map((s) => `${s.label} ${this.timing(s)}`).join(' ')}` } satisfies SettingsTile;
      }
      if (d?.driverType === 'lgtv') {
        return { key: String(g.deviceId), name: g.deviceAlias, group: 'Entertainment', status, look, icon: 'tv', hue: on.length ? '#c084fc' : '#8e9ab4',
          words: `tv television ${d.room ?? ''} ${d.nicknames?.join(' ') ?? ''} ${g.schedules.map((s) => `${s.label} ${this.timing(s)}`).join(' ')}` } satisfies SettingsTile;
      }
      return {
        key: String(g.deviceId), name: g.deviceAlias, group: kind === 'garage door' || kind === 'valve' ? 'Doors and water' : 'Lights and plugs', status, look,
        icon: kind === 'garage door' ? 'house' : kind === 'valve' ? 'drop' : 'devices',
        hue: kind === 'garage door' ? '#ff8a3d' : kind === 'valve' ? '#5ad1e6' : on.length ? '#3ddc97' : '#8e9ab4',
        words: `${d?.room ?? ''} ${d?.nicknames?.join(' ') ?? ''} ${g.schedules.map((s) => `${s.label} ${this.timing(s)}`).join(' ')}`,
      } satisfies SettingsTile;
    });
    // Lights and plugs first; by name within each. A room is found by searching for it.
    out.sort((a, b) => b.group.localeCompare(a.group) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const t of this.thermostats()) {
      out.unshift({ key: String(t.id), name: t.alias, group: 'Temperatures', icon: 'flame', hue: '#ff8a3d', status: 'Weekly temperatures', words: 'thermostat heat cool temperature' });
    }
    return out;
  });

  readonly deleting = signal<Schedule | null>(null);

  private blankForm() {
    return {
      deviceId:           '' as number | '',
      label:              '',
      triggerType:        'solar' as 'days' | 'solar' | 'cron' | 'auto_off',
      state:              true,
      solarEvent:         'sunset',
      solarOffsetMinutes: 0,
      cronExpression:     '',
      selectedPreset:     '',
      durationMinutes:    15,
      stayOnValue:        '' as number | '',
      stayOnUnit:         'min' as 'min' | 'h',
      /** "Days and time": which days, by cron's numbers (0 is Sunday), and when. */
      days:               [true, true, true, true, true, true, true],
      time:               '09:00',
      /** A robot vacuum's Clean: its rooms' keys in the order picked; none for the whole house. */
      rooms:              [] as string[],
    };
  }

  toggleCronHelp(e: Event): void {
    e.stopPropagation();
    this.showCronHelp.update((v) => !v);
  }

  openCreate(deviceId?: number): void {
    this.form = { ...this.blankForm(), deviceId: deviceId ?? '' };
    if (this.formVacuum()) this.form.triggerType = 'days';
    this.showForm.set(true);
  }

  openEdit(s: Schedule): void {
    this.editingId.set(s.id);
    const expr = s.cronExpression ?? '';
    const matchedPreset = CRON_PRESETS.find((p) => p.value !== '' && p.value === expr);
    // A time on some days opens as days and a time; anything else stays as its cron expression.
    const simple = s.triggerType === 'cron' ? readDaysTime(expr) : null;
    this.form = {
      deviceId:           s.deviceId,
      // An automatic label is left blank so it follows any change to the time.
      label:              s.label === this.timing(s) ? '' : s.label,
      triggerType:        simple ? 'days' : s.triggerType,
      state:              s.state,
      solarEvent:         s.solarEvent ?? 'sunset',
      solarOffsetMinutes: s.solarOffsetMinutes,
      cronExpression:     expr,
      selectedPreset:     matchedPreset ? matchedPreset.value : '',
      durationMinutes:    s.durationMinutes ?? 15,
      // Whole hours show as hours.
      stayOnValue:        s.stayOnMinutes ? (s.stayOnMinutes % 60 === 0 ? s.stayOnMinutes / 60 : s.stayOnMinutes) : '',
      stayOnUnit:         s.stayOnMinutes && s.stayOnMinutes % 60 === 0 ? 'h' : 'min',
      days:               simple?.days ?? this.blankForm().days,
      time:               simple?.time ?? '09:00',
      rooms:              [...(s.rooms ?? [])],
    };
    // A room forgotten since can't be picked, so it isn't kept.
    this.form.rooms = this.form.rooms.filter((k) => this.formRooms().some((r) => r.key === k));
    this.showForm.set(true);
  }

  // ── Robot vacuums ──────────────────────────────────────────────

  /** The device the form is for, when it's a robot vacuum. */
  formVacuum(): boolean {
    const d = this._devices().find((x) => x.id === Number(this.form.deviceId));
    return !!d && isVacuum(d);
  }

  /** The device the form is for, when it's a Sonos: Play and Pause rather than on and off. */
  formSpeaker(): boolean {
    return this._devices().find((x) => x.id === Number(this.form.deviceId))?.driverType === 'sonos';
  }

  private isSpeakerId(id: number): boolean {
    return this._devices().find((x) => x.id === id)?.driverType === 'sonos';
  }

  /** The robot's named rooms, to pick from; a room picked before and forgotten since isn't offered. */
  formRooms(): { key: string; name: string }[] {
    const d = this._devices().find((x) => x.id === Number(this.form.deviceId));
    return (d?.vacuumRooms ?? []).filter((r): r is { key: string; name: string; seenAt: string } => !!r.name)
      .map(({ key, name }) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  toggleRoom(key: string): void {
    this.form.rooms = this.form.rooms.includes(key) ? this.form.rooms.filter((k) => k !== key) : [...this.form.rooms, key];
  }

  /** A robot has no auto-off or "Turn off after"; other devices have no rooms. */
  deviceChanged(): void {
    if (this.formVacuum()) {
      if (this.form.triggerType === 'auto_off' || (!this.editingId() && this.form.triggerType === 'solar')) this.form.triggerType = 'days';
      this.form.stayOnValue = '';
    } else {
      this.form.rooms = [];
    }
  }

  private isVacuumId(id: number): boolean {
    const d = this._devices().find((x) => x.id === id);
    return !!d && isVacuum(d);
  }

  /** "On" and "Off", or for a robot vacuum "Clean" and "Home", and for a Sonos "Play" and "Pause". */
  actionWord(s: Schedule): string {
    if (this.isSpeakerId(s.deviceId)) return s.state ? 'Play' : 'Pause';
    return this.isVacuumId(s.deviceId) ? (s.state ? 'Clean' : 'Home') : (s.state ? 'On' : 'Off');
  }

  private comingVerb(s: Schedule): string {
    if (this.isSpeakerId(s.deviceId)) return s.state ? 'plays' : 'pauses';
    return this.isVacuumId(s.deviceId) ? (s.state ? 'cleans' : 'goes home') : (s.state ? 'on' : 'off');
  }

  /** A robot's Clean schedule's rooms: "Kitchen, then Living room", or "Whole house". */
  roomsText(s: Schedule): string | null {
    if (!s.state || s.triggerType === 'auto_off' || !this.isVacuumId(s.deviceId)) return null;
    if (!s.roomNames?.length) return 'Whole house';
    const names = s.roomNames.map((n) => n ?? 'a room it no longer knows');
    return names.length > 1 ? `${names.slice(0, -1).join(', ')}, then ${names.at(-1)}` : names[0];
  }

  /** What the days and time mean, or what's missing. */
  daysCheck(): { problem: string | null; words: string } {
    const cron = daysTimeCron(this.form.days, this.form.time);
    if (!this.form.days.some(Boolean)) return { problem: 'Pick at least one day.', words: '' };
    if (!cron) return { problem: 'Choose a time.', words: '' };
    return { problem: null, words: describeCron(cron) };
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

  duration(minutes: number): string {
    return describeDuration(minutes);
  }

  /** The form's "Turn off after" in minutes: null when empty, NaN when it isn't 1 minute to 24 hours. */
  private stayOnMinutes(): number | null {
    const v = this.form.stayOnValue;
    if (v === '' || v === null || v === undefined) return null;
    const minutes = Math.round(Number(v) * (this.form.stayOnUnit === 'h' ? 60 : 1));
    return Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : NaN;
  }

  stayOnPreview(): string | null {
    const m = this.stayOnMinutes();
    return m && !Number.isNaN(m) ? describeDuration(m) : null;
  }

  save(): void {
    const { deviceId, state, solarEvent, solarOffsetMinutes, durationMinutes } = this.form;
    if (!deviceId) { this.formError.set('Device is required.'); return; }
    // Days and a time are saved as the cron expression they make.
    if (this.form.triggerType === 'days' && this.daysCheck().problem) { this.formError.set(this.daysCheck().problem!); return; }
    const triggerType = this.form.triggerType === 'days' ? 'cron' : this.form.triggerType;
    const cronExpression = this.form.triggerType === 'days' ? daysTimeCron(this.form.days, this.form.time)! : this.form.cronExpression;
    const vacuum = this.formVacuum();
    if (triggerType === 'cron' && !cronExpression) { this.formError.set('Cron expression is required.'); return; }
    if (triggerType === 'auto_off' && (!durationMinutes || durationMinutes <= 0)) { this.formError.set('Duration must be greater than 0.'); return; }
    const stayOn = triggerType !== 'auto_off' && state && !vacuum ? this.stayOnMinutes() : null;
    if (stayOn !== null && Number.isNaN(stayOn)) { this.formError.set('Turn off after must be from 1 minute to 24 hours, or empty.'); return; }

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
      stayOnMinutes: stayOn,
      ...(vacuum && state && triggerType !== 'auto_off' ? { rooms: this.form.rooms } : {}),
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
        this.closeForm();
        this.loadSchedules(); // for its next run time
        // Show what was just saved, on its device's page.
        if (this.pageId() !== result.deviceId) this.openPage(result.deviceId);
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
      next: (updated) => { this._schedules.update((list) => list.map((x) => x.id === s.id ? { ...updated, next: x.next } : x)); this.loadSchedules(); },
    });
  }

  deleteSchedule(s: Schedule): void {
    this.deleting.set(null);
    this.http.delete(`/api/schedules/${s.id}`).subscribe({
      next: () => this._schedules.update((list) => list.filter((x) => x.id !== s.id)),
    });
  }
}
