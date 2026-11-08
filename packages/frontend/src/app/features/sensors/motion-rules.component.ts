import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { SocketService } from '../../core/socket/socket.service';
import type { Device } from '../../shared/models/device.model';

interface MotionRule {
  id:              number;
  name:            string;
  deviceId:        number;
  deviceAlias:     string;
  offAfterMinutes: number;
  turnOnWithMotion: boolean;
  sensorIp:        string | null;
  sensorUsername:  string | null;
  hasSensorPassword: boolean;
  occupied:        boolean;
  lastMotionAt:    string | null;
  status:          { kind: string; offAt?: string };
  turnOnWhen:      'always' | 'dark' | 'sun' | 'hours';
  darkBelowLux:    number;
  sunOffsetMinutes: number;
  hoursFrom:       string;
  hoursTo:         string;
  lastLux:         number | null;
  lastLuxAt:       string | null;
  skipped:         { at: string; reason: string } | null;
  sunToday:        { darkFrom: string; darkUntil: string; located: boolean } | null;
  /** A Ring camera whose motion and doorbell presses also count as motion. */
  ringCameraId:    number | null;
  ringCameraName:  string | null;
}

interface RingCameraChoice { id: number; name: string; isDoorbell: boolean }

/** "Dark" and "dim" as a Shelly Motion's own light bands put them. */
const LUX_CHOICES = [
  { lux: 50, label: 'Very dark (below 50 lux)' },
  { lux: 100, label: 'Dark (below 100 lux)' },
  { lux: 300, label: 'Dim (below 300 lux)' },
  { lux: 500, label: 'Not bright (below 500 lux)' },
];
// A motion that didn't switch the light on is mentioned for this long.
const SKIPPED_SHOWN_MS = 60 * 60_000;

const REFRESH_MS = 5000;

interface FoundSensor { ip: string; name: string; model: string; needsLogin: boolean; usedBy: string | null }

@Component({
  selector: 'app-motion-rules',
  standalone: true,
  imports: [DatePipe, FormsModule],
  styles: [`
    .title { font-size: 1.1rem; font-weight: 700; margin: 2rem 0 0.25rem; }
    .sub { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.75rem; }
    .rule, .form {
      display: flex; flex-direction: column; gap: 0.6rem;
      padding: 1rem; margin-bottom: 0.75rem;
      border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
    }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
    .head input.name { flex: 1 1 12rem; min-width: 0; width: auto; font-weight: 600; }
    .meta { color: var(--text-muted); font-size: 0.82rem; }
    .fields { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    .fields input, .fields select { flex: 1 1 10rem; min-width: 0; width: auto; }
    .fields input.minutes { flex: 0 1 6rem; }
    .fields input.time { flex: 0 1 8rem; }
    .when { display: flex; flex-direction: column; gap: 0.45rem; margin-left: 1.6rem; }
    select {
      font-family: inherit; font-size: 1rem; background: var(--bg); color: var(--text);
      border: 1px solid var(--border); border-radius: var(--radius); padding: 0.6rem 0.9rem;
    }
    .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
    .check input { width: auto; }
    .countdown { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
    .ok { color: #4ade80; font-size: 0.85rem; }
    .err { color: #f87171; font-size: 0.85rem; }
    .found { list-style: none; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .found li + li { border-top: 1px solid var(--border); }
    .found button { display: flex; flex-direction: column; gap: 0.15rem; width: 100%; text-align: left; background: transparent;
      color: var(--text); border-radius: 0; padding: 0.55rem 0.75rem; font-size: 0.88rem; }
    .found button:hover, .found button.picked { background: rgba(59,130,246,0.15); }
    .found .used { color: var(--text-muted); font-size: 0.78rem; white-space: nowrap; }
    .btn-remove { background: transparent; border: 1px solid var(--border); color: var(--text-muted); padding: 0.3rem 0.7rem; font-size: 0.8rem; }
  `],
  template: `
    <h2 class="title">Motion lights</h2>
    <p class="sub">Turns a light off when a room has had no motion for a while, and can turn it on when motion starts.</p>

    @for (rule of rules(); track rule.id) {
      <div class="rule">
        <div class="head">
          <input class="name" [ngModel]="rule.name" aria-label="Rule name" autocomplete="off"
                 (change)="save(rule, { name: value($event) })" />
          <button class="btn-remove" (click)="remove(rule)">Remove</button>
        </div>
        <div class="meta">
          @switch (rule.status.kind) {
            @case ('waiting') { Waiting for the sensor's first report, so this rule isn't active yet }
            @case ('occupied') { Motion detected. The light stays on. }
            @case ('counting') { <span class="countdown">Turns off in {{ countdown(rule) }}</span> }
            @case ('off_cooldown') { Light is off. The sensor needs about a minute without motion before motion can turn it on again. }
            @case ('held') { The light is on a keep-on timer, so this rule won't turn it off yet. }
            @case ('offline') { The light is offline. }
            @default { Light is off. Last motion {{ rule.lastMotionAt | date:'short' }} }
          }
          @if (skippedNote(rule); as note) { <div>{{ note }}</div> }
        </div>
        <div class="fields">
          <select [ngModel]="rule.deviceId" aria-label="Light" (ngModelChange)="save(rule, { deviceId: $event })">
            @for (device of lights(); track device.id) {
              <option [ngValue]="device.id">{{ device.alias }}</option>
            }
          </select>
          @if (deviceFor(rule); as device) {
            <span class="meta">{{ !device.online ? 'Offline' : device.state ? 'On' : 'Off' }}</span>
            <button class="btn-remove" [disabled]="switching() === device.id" (click)="switchLight(rule, device, !device.state)">
              {{ device.state ? 'Turn off' : 'Turn on' }}
            </button>
          }
        </div>
        <div class="fields">
          <label class="meta" [for]="'minutes-' + rule.id">Turn off after (minutes)</label>
          <input class="minutes" type="number" min="1" max="1440" [id]="'minutes-' + rule.id"
                 [ngModel]="rule.offAfterMinutes" (change)="save(rule, { offAfterMinutes: toNumber($event) })" />
        </div>
        <label class="check">
          <input type="checkbox" [checked]="rule.turnOnWithMotion" (change)="save(rule, { turnOnWithMotion: checked($event) })" />
          Turn on when motion starts
        </label>
        @if (rule.turnOnWithMotion) {
          <div class="when">
            <div class="fields">
              <label class="meta" [for]="'when-' + rule.id">Only</label>
              <select [id]="'when-' + rule.id" [ngModel]="rule.turnOnWhen" (ngModelChange)="save(rule, { turnOnWhen: $event })">
                <option value="always">Any time</option>
                <option value="dark" [disabled]="!rule.sensorIp">When the room is dark{{ rule.sensorIp ? '' : ' (connect the sensor first)' }}</option>
                <option value="sun">Between sunset and sunrise</option>
                <option value="hours">Between set hours</option>
              </select>
            </div>
            @switch (rule.turnOnWhen) {
              @case ('dark') {
                <div class="fields">
                  <label class="meta" [for]="'lux-' + rule.id">Dark means</label>
                  <select [id]="'lux-' + rule.id" [ngModel]="rule.darkBelowLux" (ngModelChange)="save(rule, { darkBelowLux: $event })">
                    @for (c of luxChoices(rule); track c.lux) { <option [ngValue]="c.lux">{{ c.label }}</option> }
                  </select>
                </div>
                <span class="meta">
                  The sensor measures the light each time it sees motion.
                  @if (rule.lastLux !== null) { Last reading: <strong>{{ rule.lastLux }} lux</strong> at {{ rule.lastLuxAt | date:'shortTime' }}. }
                  @else { Its first reading shows here after the next motion. }
                  If the light can't be read, the light turns on anyway.
                </span>
              }
              @case ('sun') {
                <div class="fields">
                  <label class="meta" [for]="'offset-' + rule.id">Start before sunset and end after sunrise by (minutes)</label>
                  <input class="minutes" type="number" min="0" max="180" [id]="'offset-' + rule.id"
                         [ngModel]="rule.sunOffsetMinutes" (change)="save(rule, { sunOffsetMinutes: toNumber($event) })" />
                </div>
                @if (rule.sunToday; as sun) {
                  <span class="meta">Today: from {{ sun.darkFrom | date:'shortTime' }} until {{ sun.darkUntil | date:'shortTime' }}.
                    @if (!sun.located) { <span class="err">These are for an example location: set your home's location in Settings → Home.</span> }
                  </span>
                } @else {
                  <span class="meta">There's no sunset here today, so motion turns the light on any time.</span>
                }
              }
              @case ('hours') {
                <div class="fields">
                  <label class="meta" [for]="'from-' + rule.id">From</label>
                  <input class="time" type="time" [id]="'from-' + rule.id" [ngModel]="rule.hoursFrom" (change)="save(rule, { hoursFrom: value($event) })" />
                  <label class="meta" [for]="'to-' + rule.id">until</label>
                  <input class="time" type="time" [id]="'to-' + rule.id" [ngModel]="rule.hoursTo" (change)="save(rule, { hoursTo: value($event) })" />
                </div>
                <span class="meta">A range like 17:00 until 08:00 runs overnight.</span>
              }
            }
            <span class="meta">Only stops motion turning the light on. Turning it off after no motion, the switch, the app and voice work as usual.</span>
          </div>
        }
        @if (connecting() === rule.id) {
          <div class="fields">
            <button class="btn-remove" type="button" (click)="findSensors()" [disabled]="searching()">
              {{ searching() ? 'Searching…' : 'Find sensors' }}
            </button>
            @if (searching()) { <span class="meta">Press each sensor's button to wake it. This takes a few seconds.</span> }
          </div>
          @if (searched() && !searching()) {
            @if (found().length) {
              <ul class="found" aria-label="Motion sensors found">
                @for (f of found(); track f.ip) {
                  <li><button type="button" [class.picked]="sensorIp === f.ip" (click)="pick(f)">
                    <span>{{ f.name }} <span class="meta">· {{ f.ip }}</span></span>
                    @if (f.usedBy === rule.name) { <span class="used">This rule's sensor</span> }
                    @else if (f.usedBy) { <span class="used">Used by {{ f.usedBy }}: picking it moves it here</span> }
                  </button></li>
                }
              </ul>
            } @else {
              <span class="meta">No motion sensors answered. Press the sensor's button to wake it, then search again, or enter its address below.</span>
            }
          }
          <div class="fields">
            <input [(ngModel)]="sensorIp" placeholder="Sensor IP address" autocomplete="off" />
            <input [(ngModel)]="username" placeholder="Sensor username" autocomplete="off" />
            <input [(ngModel)]="password" type="password" autocomplete="new-password"
                   [placeholder]="rule.hasSensorPassword ? 'Password saved' : 'Sensor password'" />
            <button class="btn-primary" [disabled]="!sensorIp.trim() || busy()" (click)="connect(rule)">
              {{ busy() ? 'Connecting…' : 'Connect' }}
            </button>
          </div>
          <span class="meta">Press the sensor's button first to wake it. HomeHub saves this login, so you won't need to enter it again.</span>
        } @else {
          <div><button class="btn-remove" (click)="startConnect(rule)">Connect sensor</button></div>
        }
        @if (ringCameras().length || rule.ringCameraId !== null) {
          <div class="fields">
            <label class="meta" [for]="'ring-' + rule.id">Ring camera</label>
            <select [id]="'ring-' + rule.id" [ngModel]="rule.ringCameraId" (ngModelChange)="save(rule, { ringCameraId: $event })">
              <option [ngValue]="null">None</option>
              @for (c of ringCameras(); track c.id) { <option [ngValue]="c.id">{{ c.name }}</option> }
            </select>
          </div>
          @if (rule.ringCameraId !== null) {
            <span class="meta">Motion it sees{{ ringIsDoorbell(rule) ? ', and the doorbell ringing,' : '' }} counts as motion for this light, a few seconds after it happens.</span>
          }
        }
        @if (messageFor() === rule.id && message()) {
          <span [class]="failed() ? 'err' : 'ok'">{{ message() }}</span>
        }
      </div>
    }

    <div class="form">
      <div class="fields">
        <input [(ngModel)]="newName" placeholder="Name, such as Kitchen" autocomplete="off" />
        <select [(ngModel)]="newDeviceId">
          <option [ngValue]="null">Choose a light</option>
          @for (device of lights(); track device.id) {
            <option [ngValue]="device.id">{{ device.alias }}</option>
          }
        </select>
        <input class="minutes" type="number" min="1" max="1440" [(ngModel)]="newMinutes" aria-label="Minutes without motion" />
        <button class="btn-primary" [disabled]="!newName.trim() || !newDeviceId" (click)="create()">Add</button>
      </div>
      <label class="check">
        <input type="checkbox" [(ngModel)]="newTurnOn" />
        Turn on when motion starts
      </label>
      @if (createError()) { <span class="err">{{ createError() }}</span> }
    </div>
  `,
})
export class MotionRulesComponent implements OnInit, OnDestroy {
  private http   = inject(HttpClient);
  private socket = inject(SocketService);
  private stopWatching?: () => void;
  private timers: ReturnType<typeof setInterval>[] = [];
  private now = signal(Date.now());

  readonly rules   = signal<MotionRule[]>([]);
  private devices  = signal<Device[]>([]);
  /** Ring cameras added on the Cameras page, which a rule can use as its sensor. */
  readonly ringCameras = signal<RingCameraChoice[]>([]);
  readonly lights  = computed(() =>
    this.devices().filter((d) => !d.isProtected).sort((a, b) => a.alias.localeCompare(b.alias)));

  newName = '';
  newDeviceId: number | null = null;
  newMinutes = 10;
  newTurnOn = true;
  readonly createError = signal('');

  sensorIp = '';
  username = '';
  password = '';
  readonly connecting = signal<number | null>(null);
  readonly busy       = signal(false);
  readonly message    = signal('');
  readonly messageFor = signal<number | null>(null);
  readonly failed     = signal(false);
  readonly switching  = signal<number | null>(null);
  readonly searching  = signal(false);
  readonly searched   = signal(false);
  readonly found      = signal<FoundSensor[]>([]);

  ngOnInit(): void {
    this.load();
    this.loadDevices();
    this.http.get<{ cameras: RingCameraChoice[] }>('/api/ring').subscribe({ next: (r) => this.ringCameras.set(r.cameras), error: () => undefined });
    // Sensor reports arrive at the backend, so check back for a new status.
    this.timers = [
      setInterval(() => this.now.set(Date.now()), 1000),
      setInterval(() => this.load(), REFRESH_MS),
    ];
    // A light switched by motion should show here, along with the rule's new status.
    this.stopWatching = this.socket.onDeviceState((event) => {
      this.devices.update((list) => list.map((d) => d.id === event.id ? { ...d, state: event.state } : d));
      this.load();
    });
  }

  ngOnDestroy(): void {
    this.stopWatching?.();
    this.timers.forEach(clearInterval);
  }

  /** Why motion just now didn't switch the light on, while the light is still off. */
  skippedNote(rule: MotionRule): string | null {
    const s = rule.skipped;
    if (!s || this.now() - Date.parse(s.at) > SKIPPED_SHOWN_MS || this.deviceFor(rule)?.state) return null;
    const at = new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Motion at ${at} didn't turn the light on: ${s.reason}.`;
  }

  /** The usual choices, plus the rule's own if it's something else. */
  luxChoices(rule: MotionRule): { lux: number; label: string }[] {
    return LUX_CHOICES.some((c) => c.lux === rule.darkBelowLux)
      ? LUX_CHOICES
      : [...LUX_CHOICES, { lux: rule.darkBelowLux, label: `Below ${rule.darkBelowLux} lux` }].sort((a, b) => a.lux - b.lux);
  }

  countdown(rule: MotionRule): string {
    const seconds = Math.max(0, Math.ceil((Date.parse(rule.status.offAt ?? '') - this.now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  private loadDevices(): void {
    this.http.get<Device[]>('/api/devices').subscribe((devices) => this.devices.set(devices));
  }

  ringIsDoorbell(rule: MotionRule): boolean {
    return this.ringCameras().find((c) => c.id === rule.ringCameraId)?.isDoorbell ?? false;
  }

  deviceFor(rule: MotionRule): Device | undefined {
    return this.devices().find((d) => d.id === rule.deviceId);
  }

  switchLight(rule: MotionRule, device: Device, on: boolean): void {
    this.switching.set(device.id);
    this.http.post(`/api/devices/${device.id}/${on ? 'on' : 'off'}`, {}).subscribe({
      next: () => {
        this.switching.set(null);
        this.devices.update((list) => list.map((d) => d.id === device.id ? { ...d, state: on } : d));
      },
      error: (err) => {
        this.switching.set(null);
        this.show(rule, err.error?.error ?? `Could not reach ${device.alias}.`, true);
        this.loadDevices();
      },
    });
  }

  private load(): void {
    this.http.get<MotionRule[]>('/api/motion').subscribe((rules) => this.rules.set(rules));
  }

  private show(rule: MotionRule, text: string, failed: boolean): void {
    this.messageFor.set(rule.id);
    this.message.set(text);
    this.failed.set(failed);
  }

  create(): void {
    this.createError.set('');
    this.http.post<MotionRule>('/api/motion', {
      name: this.newName.trim(), deviceId: this.newDeviceId,
      offAfterMinutes: Number(this.newMinutes), turnOnWithMotion: this.newTurnOn,
    }).subscribe({
      next: (created) => {
        this.newName = '';
        this.newDeviceId = null;
        this.newMinutes = 10;
        this.load();
        // Next step for a new rule: its sensor.
        if (created?.id) this.startConnect(created);
      },
      error: (err) => this.createError.set(err.error?.error ?? 'Could not add the rule.'),
    });
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  toNumber(event: Event): number {
    return Number(this.value(event));
  }

  checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  save(rule: MotionRule, changes: Partial<MotionRule>): void {
    this.http.patch(`/api/motion/${rule.id}`, changes).subscribe({
      next: () => { this.show(rule, 'Saved', false); this.load(); },
      error: (err) => {
        this.show(rule, err.error?.error ?? 'Could not save.', true);
        this.load();
      },
    });
  }

  remove(rule: MotionRule): void {
    this.http.delete(`/api/motion/${rule.id}`).subscribe(() => this.load());
  }

  startConnect(rule: MotionRule): void {
    this.connecting.set(rule.id);
    this.message.set('');
    this.sensorIp = rule.sensorIp ?? '';
    this.username = rule.sensorUsername ?? '';
    this.password = '';
    this.searched.set(false);
    this.found.set([]);
    // A first connection: look for sensors straight away.
    if (!rule.sensorIp) this.findSensors();
  }

  findSensors(): void {
    this.searching.set(true);
    this.http.post<FoundSensor[]>('/api/motion/discover', {}).subscribe({
      next: (list) => {
        this.searching.set(false);
        this.searched.set(true);
        this.found.set(list);
        // Only one, and it's free: choose it.
        const free = list.filter((f) => !f.usedBy);
        if (!this.sensorIp && list.length === 1 && free.length === 1) this.pick(free[0]);
      },
      error: () => { this.searching.set(false); this.searched.set(true); this.found.set([]); },
    });
  }

  pick(f: FoundSensor): void {
    this.sensorIp = f.ip;
    // Shelly's own default login name.
    if (!this.username && f.needsLogin) this.username = 'admin';
  }

  connect(rule: MotionRule): void {
    this.busy.set(true);
    this.http.post(`/api/motion/${rule.id}/connect`, {
      sensorIp: this.sensorIp.trim(), username: this.username.trim(), password: this.password,
    }).subscribe({
      next: () => {
        this.busy.set(false);
        this.password = '';
        this.connecting.set(null);
        this.load();
        this.show(rule, 'Sensor connected. Wave at it to activate this rule.', false);
      },
      error: (err) => {
        this.busy.set(false);
        this.show(rule, err.error?.error ?? 'Could not connect the sensor.', true);
      },
    });
  }
}
