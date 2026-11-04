import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin, of, catchError, map } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import type { Device } from '../../shared/models/device.model';
import { InviteQrComponent } from './invite-qr.component';
import { MatterPairComponent } from '../settings/matter-pair.component';
import { COMMON_ROOMS, guessRoom, looksLikeLight, looksOutdoor, needsBetterName } from './suggest';

type Step = 'home' | 'devices' | 'rooms' | 'starters' | 'family' | 'done';

interface Place { name: string; region: string; country: string; latitude: number; longitude: number; timezone: string; label: string }
interface HomeSettings {
  latitude: number | null; longitude: number | null; timezone: string; located: boolean;
  source: { location: string; timezone: string };
  today?: { sunrise: string | null; sunset: string | null } | null;
}
interface Found {
  ip: string; alias: string; model: string; hasEmeter: boolean; driverType: string;
  driverConfig?: Record<string, unknown>; mac?: string; needsLogin?: boolean; moved?: unknown;
  // in this page
  name: string; chosen: boolean;
}
interface NameRow { device: Device; name: string; room: string }
interface StarterChoice { on: boolean; ids: Set<number> }

const STEPS: { id: Step; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'devices', label: 'Devices' },
  { id: 'rooms', label: 'Rooms' },
  { id: 'starters', label: 'Automations' },
  { id: 'family', label: 'Family' },
];

const BRAND: Record<string, string> = { kasa: 'TP-Link Kasa', shelly: 'Shelly', tuya: 'Tuya / Smart Life', meross: 'Meross', wyze: 'Wyze' };

/**
 * First-run setup. After creating the admin account, a new HomeHub walks
 * through where the home is, finding and naming devices, a few starter
 * automations, and inviting the family. Every step can be skipped, and
 * setup can be left and resumed from the dashboard.
 */
@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [FormsModule, InviteQrComponent, MatterPairComponent],
  styles: [`
    .wrap { max-width: 680px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
    .top { display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; gap:1rem; }
    .brand { font-weight:700; font-size:1.1rem; }
    .later { background:none; color:var(--text-muted); font-size:0.82rem; padding:0.25rem 0; text-decoration:underline; }
    .steps { display:flex; gap:0.35rem; margin-bottom:1.5rem; list-style:none; }
    .steps li { flex:1; text-align:center; font-size:0.72rem; color:var(--text-muted); }
    .steps li::before { content:''; display:block; height:4px; border-radius:2px; background:var(--border); margin-bottom:0.35rem; }
    .steps li.done::before, .steps li.now::before { background:var(--accent); }
    .steps li.now { color:var(--text); font-weight:600; }
    h1 { font-size:1.5rem; line-height:1.25; margin-bottom:0.4rem; }
    .lead { color:var(--text-muted); margin-bottom:1.25rem; line-height:1.5; }
    .card { padding:1.25rem; margin-bottom:1rem; }
    label.f { display:block; font-size:0.85rem; color:var(--text-muted); margin:0 0 0.35rem; }
    .results { list-style:none; border:1px solid var(--border); border-radius:var(--radius); margin-top:0.4rem; overflow:hidden; }
    .results button { display:block; width:100%; text-align:left; background:var(--surface); color:var(--text); border-radius:0; padding:0.6rem 0.9rem; border-bottom:1px solid var(--border); }
    .results li:last-child button { border-bottom:none; }
    .results button:hover, .results button:focus-visible { background:rgba(59,130,246,0.15); }
    .picked { display:flex; align-items:center; justify-content:space-between; gap:0.75rem; flex-wrap:wrap; }
    .picked b { font-size:1.05rem; }
    .muted { color:var(--text-muted); font-size:0.85rem; line-height:1.45; }
    .ok { color:var(--green); }
    .err { color:var(--red); font-size:0.88rem; margin-top:0.5rem; }
    .actions { display:flex; justify-content:space-between; align-items:center; gap:0.75rem; margin-top:1.5rem; flex-wrap:wrap; }
    .actions .right { display:flex; gap:0.6rem; margin-left:auto; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text); }
    .btn-sm { padding:0.35rem 0.8rem; font-size:0.8rem; }
    .big { padding:0.7rem 1.4rem; font-size:1rem; }
    select { background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:var(--radius); padding:0.5rem 0.7rem; font-size:0.95rem; font-family:inherit; }
    .scan { text-align:center; padding:2rem 1rem; }
    .spinner { width:42px; height:42px; border:4px solid var(--border); border-top-color:var(--accent); border-radius:50%; margin:0 auto 1rem; animation:spin 0.9s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration:3s; } }
    .group-title { font-size:0.8rem; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-muted); margin:1rem 0 0.4rem; }
    .dev { display:flex; align-items:center; gap:0.75rem; padding:0.6rem 0.2rem; border-bottom:1px solid var(--border); }
    .dev:last-child { border-bottom:none; }
    .dev input[type=checkbox] { width:1.15rem; height:1.15rem; flex-shrink:0; accent-color:var(--accent); }
    .dev .name { flex:1; min-width:0; }
    .dev .name input { padding:0.4rem 0.6rem; font-size:0.92rem; }
    .dev .meta { font-size:0.75rem; color:var(--text-muted); }
    .room-row { display:grid; grid-template-columns: 1fr 11rem; gap:0.5rem; align-items:center; padding:0.5rem 0; border-bottom:1px solid var(--border); }
    .room-row:last-child { border-bottom:none; }
    .room-row input { padding:0.45rem 0.6rem; font-size:0.92rem; }
    @media (max-width: 520px) { .room-row { grid-template-columns: 1fr; } }
    .hint { font-size:0.75rem; color:#f59e0b; margin-top:0.2rem; }
    .starter { border:1px solid var(--border); border-radius:var(--radius); padding:1rem; margin-bottom:0.75rem; background:var(--surface); }
    .starter.on { border-color:var(--accent); }
    .starter-head { display:flex; gap:0.75rem; align-items:flex-start; cursor:pointer; }
    .starter-head input { width:1.2rem; height:1.2rem; margin-top:0.2rem; accent-color:var(--accent); flex-shrink:0; }
    .starter-head b { display:block; }
    .chips { display:flex; flex-wrap:wrap; gap:0.4rem; margin:0.75rem 0 0 2rem; }
    .chip { background:var(--bg); border:1px solid var(--border); color:var(--text-muted); border-radius:999px; padding:0.3rem 0.75rem; font-size:0.82rem; }
    .chip.sel { background:rgba(59,130,246,0.25); border-color:var(--accent); color:var(--text); }
    .chip.sel::before { content:'✓ '; }
    .offtime { margin:0.75rem 0 0 2rem; display:flex; align-items:center; gap:0.5rem; font-size:0.88rem; flex-wrap:wrap; }
    .done-hero { text-align:center; padding:1rem 0 0.5rem; }
    .done-hero .big-emoji { font-size:3rem; line-height:1; margin-bottom:0.5rem; }
    .summary { list-style:none; }
    .summary li { padding:0.45rem 0; border-bottom:1px solid var(--border); display:flex; gap:0.6rem; }
    .summary li:last-child { border-bottom:none; }
    .tips { list-style:none; display:grid; gap:0.6rem; }
    .tips li { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:0.75rem 0.9rem; font-size:0.9rem; line-height:1.45; }
    .tips q { font-style:italic; }
    .tz-row { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.75rem; }
  `],
  template: `
    <div class="wrap">
      <div class="top">
        <span class="brand">HomeHub</span>
        @if (step() !== 'done') {
          <button class="later" type="button" (click)="finishLater()">Finish later</button>
        }
      </div>

      @if (step() !== 'done') {
        <ol class="steps" aria-label="Setup progress">
          @for (s of steps; track s.id; let i = $index) {
            <li [class.done]="i < stepIndex()" [class.now]="i === stepIndex()" [attr.aria-current]="i === stepIndex() ? 'step' : null">{{ s.label }}</li>
          }
        </ol>
      }

      <!-- ── 1. Home ───────────────────────────────────────── -->
      @if (step() === 'home') {
        <h1>Where's your home?</h1>
        <p class="lead">So lights can follow your sunset, and times show in your time zone. HomeHub looks up towns on itself: nothing is sent anywhere.</p>

        <div class="card">
          @if (place(); as p) {
            <div class="picked">
              <div><b>{{ p.label }}</b>
                @if (guessed()) { <div class="muted">A guess from your time zone. Close enough? If not, search for your town.</div> }
              </div>
              <button class="btn-sm btn-ghost" type="button" (click)="changePlace()">Change</button>
            </div>
          }
          @if (!place() || searching()) {
            <label class="f" for="town">Your town or city</label>
            <input id="town" type="search" [(ngModel)]="query" (ngModelChange)="search($event)" placeholder="e.g. Springfield, IL"
                   autocomplete="off" (keydown.enter)="pickFirst()" />
            @if (results().length) {
              <ul class="results" role="listbox">
                @for (r of results(); track r.label + r.latitude) {
                  <li><button type="button" role="option" (click)="pick(r)">{{ r.label }}</button></li>
                }
              </ul>
            } @else if (query.trim().length >= 2 && !searchBusy()) {
              <p class="muted" style="margin-top:0.5rem">No match. Try a bigger town nearby: sunset there is within a minute or two of yours.</p>
            }
          }

          <div class="tz-row">
            <span class="muted">Time zone:</span>
            @if (editZone()) {
              <select [(ngModel)]="timezone" aria-label="Time zone">
                @for (tz of zones; track tz) { <option [value]="tz">{{ tz }}</option> }
              </select>
            } @else {
              <b>{{ timezone }}</b>
              <button class="btn-sm btn-ghost" type="button" (click)="editZone.set(true)">Change</button>
            }
          </div>
          @if (sunset()) { <p class="muted ok" style="margin-top:0.6rem">✓ Sunset today is at {{ sunset() }}.</p> }
        </div>
        @if (error()) { <p class="err">{{ error() }}</p> }
        <div class="actions">
          <button class="btn-ghost" type="button" (click)="go('devices')">Skip</button>
          <div class="right">
            <button class="btn-primary big" type="button" (click)="saveHome()" [disabled]="busy() || !place()">Next</button>
          </div>
        </div>
      }

      <!-- ── 2. Devices ────────────────────────────────────── -->
      @if (step() === 'devices') {
        <h1>Let's find your devices</h1>
        <p class="lead">HomeHub searches your network for smart plugs, switches and lights. Set each device up in its own app first, on the same Wi-Fi as HomeHub.</p>

        @if (scanning()) {
          <div class="card scan" role="status">
            <div class="spinner" aria-hidden="true"></div>
            <b>Searching your network…</b>
            <p class="muted">This takes up to a minute.</p>
          </div>
        } @else if (scanned()) {
          <div class="card">
            @if (ready().length) {
              <div class="group-title">Ready to add</div>
              @for (d of ready(); track d.ip) {
                <div class="dev">
                  <input type="checkbox" [(ngModel)]="d.chosen" [attr.aria-label]="'Add ' + (d.name || d.ip)" (ngModelChange)="touch()" />
                  <div class="name">
                    <input [(ngModel)]="d.name" [attr.aria-label]="'Name for ' + d.ip" placeholder="Give it a name" (ngModelChange)="touch()" />
                    <div class="meta">{{ brand(d.driverType) }}{{ d.model && d.model !== d.ip ? ' · ' + d.model : '' }}</div>
                  </div>
                </div>
              }
            }
            @if (needsSetup().length) {
              <div class="group-title">Found, but needs a sign-in</div>
              @for (d of needsSetup(); track d.ip) {
                <div class="dev">
                  <div class="name">{{ d.name || d.ip }}
                    <div class="meta">{{ brand(d.driverType) }} · Connect it later in Settings → Devices</div>
                  </div>
                </div>
              }
            }
            @if (!ready().length && !needsSetup().length) {
              <p><b>No new devices found.</b></p>
              <p class="muted" style="margin-top:0.4rem">
                @if (existing().length) { You already have {{ existing().length }} device{{ existing().length === 1 ? '' : 's' }} in HomeHub. }
                Check that devices are plugged in and set up in their own app, on the same Wi-Fi network. Then search again.
              </p>
            }
            <p style="margin-top:1rem"><button class="btn-sm btn-ghost" type="button" (click)="scan()">Search again</button></p>
          </div>
        }
        @if (!scanning()) {
          <div class="card">
            <button class="later" type="button" style="text-decoration:none;color:var(--text)" (click)="showMatter.set(!showMatter())" [attr.aria-expanded]="showMatter()">
              {{ showMatter() ? '▾' : '▸' }} <b>Have Matter devices?</b> <span class="muted">Add them with a pairing code.</span>
            </button>
            @if (showMatter()) { <div style="margin-top:0.75rem"><app-matter-pair (added)="matterAdded($event)" /></div> }
          </div>
        }
        @if (message()) { <p class="muted ok">{{ message() }}</p> }
        @if (error()) { <p class="err">{{ error() }}</p> }
        <div class="actions">
          <button class="btn-ghost" type="button" (click)="go('home')">Back</button>
          <div class="right">
            @if (chosenCount()) {
              <button class="btn-primary big" type="button" (click)="addChosen()" [disabled]="busy()">
                {{ busy() ? 'Adding…' : 'Add ' + chosenCount() + ' device' + (chosenCount() === 1 ? '' : 's') }}
              </button>
            } @else {
              <button class="btn-primary big" type="button" (click)="go('rooms')" [disabled]="scanning()">Next</button>
            }
          </div>
        </div>
      }

      <!-- ── 3. Rooms ──────────────────────────────────────── -->
      @if (step() === 'rooms') {
        <h1>Name them and pick rooms</h1>
        <p class="lead">Use names you'd say out loud: they're what you'll use with voice and Chat, like <q>turn off the kitchen lights</q>. Rooms group the dashboard.</p>
        @if (rows().length) {
          <div class="card">
            <datalist id="rooms">@for (r of roomChoices(); track r) { <option [value]="r"></option> }</datalist>
            @for (r of rows(); track r.device.id) {
              <div class="room-row">
                <div>
                  <input [(ngModel)]="r.name" [attr.aria-label]="'Name of ' + r.device.alias" />
                  @if (badName(r.name)) { <div class="hint">Try a name you'd say, like "Desk lamp".</div> }
                </div>
                <input [(ngModel)]="r.room" list="rooms" placeholder="Room" [attr.aria-label]="'Room for ' + r.device.alias" />
              </div>
            }
          </div>
        } @else {
          <div class="card"><p class="muted">No devices yet. You can add them later in Settings → Devices.</p></div>
        }
        @if (error()) { <p class="err">{{ error() }}</p> }
        <div class="actions">
          <button class="btn-ghost" type="button" (click)="go('devices')">Back</button>
          <div class="right">
            <button class="btn-primary big" type="button" (click)="saveRooms()" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Next' }}</button>
          </div>
        </div>
      }

      <!-- ── 4. Starter automations ────────────────────────── -->
      @if (step() === 'starters') {
        <h1>A few things to start with</h1>
        <p class="lead">Pick any you'd like. You can change or remove them later under Schedules and Scenes.</p>
        @if (createdSummary()) { <p class="muted ok" style="margin-bottom:1rem">✓ Already set up: {{ createdSummary() }}.</p> }
        @if (!switchable().length) {
          <div class="card"><p class="muted">Add a light or plug first, and these will be ready for you.</p></div>
        } @else {
          @for (s of starterDefs; track s.id) {
            <div class="starter" [class.on]="choice(s.id).on">
              <label class="starter-head">
                <input type="checkbox" [checked]="choice(s.id).on" (change)="toggleStarter(s.id)" />
                <span><b>{{ s.title }}</b><span class="muted">{{ s.description }}</span></span>
              </label>
              @if (choice(s.id).on) {
                <div class="chips" role="group" [attr.aria-label]="'Devices for ' + s.title">
                  @for (d of switchable(); track d.id) {
                    <button type="button" class="chip" [class.sel]="choice(s.id).ids.has(d.id)" [attr.aria-pressed]="choice(s.id).ids.has(d.id)"
                            (click)="toggleDevice(s.id, d.id)">{{ d.alias }}</button>
                  }
                </div>
                @if (s.id === 'evening') {
                  <div class="offtime">
                    <label for="offtime">Off at</label>
                    <select id="offtime" [(ngModel)]="offTime">
                      <option value="21:00">9:00 PM</option><option value="22:00">10:00 PM</option>
                      <option value="22:30">10:30 PM</option><option value="23:00">11:00 PM</option>
                      <option value="23:30">11:30 PM</option><option value="00:00">Midnight</option>
                      <option value="00:30">12:30 AM</option>
                    </select>
                  </div>
                }
                @if (s.id !== 'goodnight' && !located()) {
                  <p class="hint" style="margin-left:2rem">Sunset needs your home's location. Go back to Home to add it, or it uses a default.</p>
                }
              }
            </div>
          }
        }
        @if (error()) { <p class="err">{{ error() }}</p> }
        <div class="actions">
          <button class="btn-ghost" type="button" (click)="go('rooms')">Back</button>
          <div class="right">
            <button class="btn-ghost" type="button" (click)="go('family')">Skip</button>
            <button class="btn-primary big" type="button" (click)="saveStarters()" [disabled]="busy() || !starterCount()">
              {{ busy() ? 'Setting up…' : starterCount() === 1 ? 'Set this up' : 'Set these up' }}
            </button>
          </div>
        </div>
      }

      <!-- ── 5. Family ─────────────────────────────────────── -->
      @if (step() === 'family') {
        <h1>Bring your family along</h1>
        <p class="lead">Show this code to anyone in your home. They scan it, choose a name and password, and they're in. No typing passwords for them.</p>
        <div class="card"><app-invite-qr /></div>
        <div class="actions">
          <button class="btn-ghost" type="button" (click)="go('starters')">Back</button>
          <div class="right">
            <button class="btn-primary big" type="button" (click)="go('done')">Next</button>
          </div>
        </div>
      }

      <!-- ── Done ──────────────────────────────────────────── -->
      @if (step() === 'done') {
        <div class="done-hero">
          <div class="big-emoji" aria-hidden="true">🎉</div>
          <h1>You're all set</h1>
          <p class="lead">HomeHub is ready. Here's what's set up:</p>
        </div>
        <div class="card">
          <ul class="summary">
            <li><span aria-hidden="true">📍</span> {{ located() ? 'Home location and time zone (' + timezone + ')' : 'Time zone: ' + timezone + '. Add your location in Settings → Home for sunset times.' }}</li>
            <li><span aria-hidden="true">💡</span> {{ existing().length }} device{{ existing().length === 1 ? '' : 's' }}</li>
            @if (automations()) { <li><span aria-hidden="true">⏰</span> {{ automations() }}</li> }
          </ul>
        </div>
        <h2 style="font-size:1.05rem;margin:1.25rem 0 0.6rem">Try these</h2>
        <ul class="tips">
          <li>💬 In <b>Chat</b>, type <q>turn off {{ exampleName() }}</q> or <q>turn on {{ exampleName() }} for 20 minutes</q>.</li>
          <li>📱 On your phone, add HomeHub to your home screen. It opens like an app.</li>
          <li>⚙️ Everything here can be changed in <b>Settings</b>, and you can run this setup again from there.</li>
        </ul>
        <div class="actions">
          <div class="right"><button class="btn-primary big" type="button" (click)="finish()">Go to my home</button></div>
        </div>
      }
    </div>
  `,
})
export class WelcomeComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  readonly steps = STEPS;
  readonly step = signal<Step>('home');
  readonly stepIndex = computed(() => STEPS.findIndex((s) => s.id === this.step()));
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');

  // ── Home ──
  readonly browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly zones = WelcomeComponent.allZones(this.browserZone);
  timezone = this.browserZone || 'UTC';
  query = '';
  readonly place = signal<Place | null>(null);
  readonly guessed = signal(false);
  readonly searching = signal(false);
  readonly searchBusy = signal(false);
  readonly results = signal<Place[]>([]);
  readonly editZone = signal(false);
  readonly located = signal(false);
  readonly sunset = signal('');
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private searchSeq = 0;

  // ── Devices ──
  readonly scanning = signal(false);
  readonly scanned = signal(false);
  readonly found = signal<Found[]>([]);
  readonly existing = signal<Device[]>([]);
  private readonly version = signal(0);   // bumps when a checkbox or name in found() changes
  readonly ready = computed(() => { this.version(); return this.found().filter((d) => this.isReady(d)); });
  readonly needsSetup = computed(() => this.found().filter((d) => !this.isReady(d)));
  readonly chosenCount = computed(() => { this.version(); return this.ready().filter((d) => d.chosen).length; });

  // ── Rooms ──
  readonly rows = signal<NameRow[]>([]);
  readonly roomChoices = computed(() => [...new Set([...this.existing().map((d) => d.room).filter((r): r is string => !!r), ...COMMON_ROOMS])]);

  // ── Starters ──
  readonly starterDefs = [
    { id: 'evening', title: 'Evening lights', description: 'Lights come on at sunset and go off at bedtime.' },
    { id: 'outdoor', title: 'Outdoor lights at night', description: 'On at sunset, off at sunrise.' },
    { id: 'goodnight', title: 'A "Goodnight" scene', description: 'One tap, or say "Goodnight", to turn everything chosen off.' },
  ] as const;
  readonly choices = signal<Record<string, StarterChoice>>({});
  offTime = '23:00';
  readonly switchable = computed(() => this.existing().filter((d) => !d.isProtected));
  readonly starterCount = computed(() => Object.values(this.choices()).filter((c) => c.on && c.ids.size).length);
  readonly createdSummary = signal('');
  readonly automations = signal('');

  readonly exampleName = computed(() => {
    const d = this.existing().find((x) => !x.isProtected);
    return d ? d.alias.toLowerCase().replace(/^(the )?/, 'the ') : 'the kitchen lights';
  });

  private static allZones(extra: string): string[] {
    let zones: string[] = [];
    try { zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { /* older browser */ }
    return [...new Set(['UTC', extra, ...zones].filter(Boolean))].sort();
  }

  ngOnInit(): void {
    if (this.auth.user()?.role !== 'admin') { this.router.navigate(['/dashboard']); return; }
    this.http.get<{ step: Step; finished: boolean }>('/api/setup').subscribe({
      next: (s) => this.enter(s.finished ? 'home' : s.step),
      error: () => this.enter('home'),
    });
    this.http.get<HomeSettings>('/api/home-settings').subscribe({
      next: (h) => this.fillHome(h),
      error: () => undefined,
    });
  }

  // ── Navigation ─────────────────────────────────────────────

  go(step: Step): void {
    this.error.set('');
    this.message.set('');
    this.http.put('/api/setup', { step }).subscribe({ error: () => undefined });
    this.enter(step);
    window.scrollTo({ top: 0 });
  }

  private enter(step: Step): void {
    this.step.set(step);
    if (step === 'devices') {
      this.loadDevices();
      if (!this.scanned() && !this.scanning()) this.scan();
    }
    if (step === 'rooms') this.loadDevices(() => this.fillRows());
    if (step === 'starters') this.loadDevices(() => this.fillStarters());
    if (step === 'done') {
      this.loadDevices();
      forkJoin({
        schedules: this.http.get<unknown[]>('/api/schedules').pipe(catchError(() => of([]))),
        scenes: this.http.get<unknown[]>('/api/scenes').pipe(catchError(() => of([]))),
      }).subscribe(({ schedules, scenes }) => {
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
        this.automations.set([schedules.length ? plural(schedules.length, 'schedule') : '', scenes.length ? plural(scenes.length, 'scene') : '']
          .filter(Boolean).join(' and '));
      });
    }
  }

  finishLater(): void {
    this.router.navigate(['/dashboard']);
  }

  finish(): void {
    this.http.put('/api/setup', { finished: true, step: 'done' }).subscribe({
      next: () => this.router.navigate(['/dashboard']),
      error: () => this.router.navigate(['/dashboard']),
    });
  }

  private loadDevices(then?: () => void): void {
    this.http.get<Device[]>('/api/devices').subscribe({
      next: (list) => { this.existing.set(list); then?.(); },
      error: () => then?.(),
    });
  }

  // ── Home ───────────────────────────────────────────────────

  private fillHome(h: HomeSettings): void {
    this.located.set(h.located);
    if (h.source.timezone !== 'default') this.timezone = h.timezone;
    if (!this.zones.includes(this.timezone)) this.zones.push(this.timezone);
    this.showSunset(h);
    if (h.located && h.latitude !== null && h.longitude !== null) {
      this.place.set({ name: '', region: '', country: '', latitude: h.latitude, longitude: h.longitude, timezone: h.timezone,
        label: `Saved location (${h.latitude.toFixed(2)}, ${h.longitude.toFixed(2)})` });
      return;
    }
    // Nothing saved yet: start from the biggest town in this browser's time zone.
    this.http.get<Place | null>('/api/setup/places/guess', { params: { tz: this.browserZone } }).subscribe({
      next: (p) => { if (p && !this.place()) { this.place.set(p); this.guessed.set(true); } },
      error: () => undefined,
    });
  }

  search(text: string): void {
    clearTimeout(this.searchTimer);
    const q = text.trim();
    if (q.length < 2) { this.results.set([]); return; }
    this.searchBusy.set(true);
    const seq = ++this.searchSeq;
    this.searchTimer = setTimeout(() => {
      this.http.get<Place[]>('/api/setup/places', { params: { q, tz: this.browserZone } }).subscribe({
        next: (list) => { if (seq === this.searchSeq) { this.results.set(list); this.searchBusy.set(false); } },
        error: () => this.searchBusy.set(false),
      });
    }, 200);
  }

  pick(p: Place): void {
    this.place.set(p);
    this.guessed.set(false);
    this.searching.set(false);
    this.results.set([]);
    this.query = '';
    // The town's own time zone beats the browser's: setup may be done from anywhere.
    this.timezone = p.timezone;
    if (!this.zones.includes(p.timezone)) this.zones.push(p.timezone);
    this.sunset.set('');
  }

  pickFirst(): void {
    const first = this.results()[0];
    if (first) this.pick(first);
  }

  changePlace(): void {
    this.searching.set(true);
    setTimeout(() => document.getElementById('town')?.focus());
  }

  saveHome(): void {
    const p = this.place();
    if (!p) return;
    this.busy.set(true);
    this.error.set('');
    this.http.put<HomeSettings>('/api/home-settings', { timezone: this.timezone, latitude: p.latitude, longitude: p.longitude }).subscribe({
      next: (h) => { this.busy.set(false); this.located.set(h.located); this.showSunset(h); this.go('devices'); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.error.set(err.error?.error ?? 'Could not save your home.'); },
    });
  }

  private showSunset(h: HomeSettings): void {
    const iso = h.today?.sunset;
    this.sunset.set(iso ? new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: h.timezone }).format(new Date(iso)) : '');
  }

  // ── Devices ────────────────────────────────────────────────

  scan(): void {
    this.scanning.set(true);
    this.error.set('');
    this.message.set('');
    forkJoin({
      found: this.http.post<Omit<Found, 'name' | 'chosen'>[]>('/api/devices/discover', {}),
      devices: this.http.get<Device[]>('/api/devices').pipe(catchError(() => of([] as Device[]))),
    }).subscribe({
      next: ({ found, devices }) => {
        this.existing.set(devices);
        const known = new Set(devices.map((d) => d.ip));
        this.found.set(found
          .filter((f) => !f.moved && !known.has(f.ip))
          .map((f) => {
            const name = f.alias && f.alias !== f.ip ? f.alias : '';
            return { ...f, name, chosen: true };
          }));
        this.scanning.set(false);
        this.scanned.set(true);
      },
      error: () => { this.scanning.set(false); this.scanned.set(true); this.error.set('The search didn’t finish. Try again.'); },
    });
  }

  /** Added straight away: everything except devices that need a sign-in or key first. */
  private isReady(d: Found): boolean {
    if (d.needsLogin) return false;
    if (d.driverType === 'tuya' && !d.driverConfig?.['key']) return false;
    return true;
  }

  touch(): void { this.version.update((v) => v + 1); }

  readonly showMatter = signal(false);

  matterAdded(devices: { alias: string }[]): void {
    this.loadDevices();
    this.message.set(`Added ${devices.map((d) => d.alias).join(', ')}. You can name ${devices.length === 1 ? 'it' : 'them'} on the next step.`);
  }

  brand(type: string): string { return BRAND[type] ?? type; }

  addChosen(): void {
    const chosen = this.ready().filter((d) => d.chosen);
    if (!chosen.length) return;
    this.busy.set(true);
    this.error.set('');
    const usedNames = new Set(this.existing().map((d) => d.alias.toLowerCase()));
    const calls = chosen.map((d, i) => {
      let alias = (d.name || `${this.brand(d.driverType)} ${d.model || 'device'}`).trim();
      // Names must be unique: "Plug", "Plug 2"…
      for (let n = 2; usedNames.has(alias.toLowerCase()); n++) alias = `${(d.name || 'Device').trim()} ${n}`;
      usedNames.add(alias.toLowerCase());
      return this.http.post<Device>('/api/devices', {
        alias, ip: d.ip, model: d.model ?? null, hasEmeter: d.hasEmeter ?? false,
        driverType: d.driverType, driverConfig: d.driverConfig, mac: d.mac, room: guessRoom(alias),
      }).pipe(map((dev) => ({ ok: true as const, dev, i })), catchError(() => of({ ok: false as const, i })));
    });
    forkJoin(calls).subscribe((results) => {
      this.busy.set(false);
      const added = results.filter((r) => r.ok).length;
      const failed = results.length - added;
      const addedIps = new Set(results.filter((r) => r.ok).map((r) => chosen[r.i].ip));
      this.found.update((list) => list.filter((d) => !addedIps.has(d.ip)));
      if (failed) {
        this.error.set(`${failed} device${failed === 1 ? '' : 's'} couldn't be added. You can try again, or skip ${failed === 1 ? 'it' : 'them'} for now.`);
        this.loadDevices();
        return;
      }
      this.go('rooms');
    });
  }

  // ── Rooms ──────────────────────────────────────────────────

  private fillRows(): void {
    this.rows.set(this.existing().map((device) => ({
      device, name: device.alias, room: device.room ?? guessRoom(device.alias) ?? '',
    })));
  }

  badName(name: string): boolean { return needsBetterName(name); }

  saveRooms(): void {
    const changes = this.rows().filter((r) => r.name.trim() !== r.device.alias || (r.room.trim() || null) !== r.device.room);
    if (changes.some((r) => !r.name.trim())) { this.error.set('Every device needs a name.'); return; }
    const names = this.rows().map((r) => r.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) { this.error.set('Two devices have the same name. Give each its own.'); return; }
    if (!changes.length) { this.go('starters'); return; }
    this.busy.set(true);
    this.error.set('');
    forkJoin(changes.map((r) => this.http.patch<Device>(`/api/devices/${r.device.id}`, { alias: r.name.trim(), room: r.room.trim() || null })
      .pipe(catchError((err: HttpErrorResponse) => of({ error: `${r.name}: ${err.error?.error ?? 'could not be saved'}` })))))
      .subscribe((results) => {
        this.busy.set(false);
        const problem = results.find((r): r is { error: string } => 'error' in r);
        if (problem) { this.error.set(problem.error); this.loadDevices(() => this.fillRows()); return; }
        this.go('starters');
      });
  }

  // ── Starters ───────────────────────────────────────────────

  choice(id: string): StarterChoice { return this.choices()[id] ?? { on: false, ids: new Set() }; }

  /** Suggested devices: lights inside for the evening, outdoor lights for the night, all lights for Goodnight. */
  private fillStarters(): void {
    if (Object.keys(this.choices()).length) return;
    const lights = this.switchable().filter((d) => looksLikeLight(d.alias));
    const outdoor = this.switchable().filter((d) => looksOutdoor(d.alias, d.room));
    const indoor = lights.filter((d) => !outdoor.includes(d));
    this.choices.set({
      evening: { on: indoor.length > 0, ids: new Set(indoor.map((d) => d.id)) },
      outdoor: { on: outdoor.length > 0, ids: new Set(outdoor.map((d) => d.id)) },
      goodnight: { on: indoor.length > 0, ids: new Set(indoor.map((d) => d.id)) },
    });
  }

  toggleStarter(id: string): void {
    this.choices.update((all) => {
      const c = all[id] ?? { on: false, ids: new Set<number>() };
      return { ...all, [id]: { on: !c.on, ids: c.ids } };
    });
  }

  toggleDevice(id: string, deviceId: number): void {
    this.choices.update((all) => {
      const c = all[id];
      const ids = new Set(c.ids);
      if (ids.has(deviceId)) ids.delete(deviceId); else ids.add(deviceId);
      return { ...all, [id]: { on: c.on, ids } };
    });
  }

  saveStarters(): void {
    const starters = Object.entries(this.choices())
      .filter(([, c]) => c.on && c.ids.size)
      .map(([id, c]) => ({ id, deviceIds: [...c.ids], ...(id === 'evening' ? { offTime: this.offTime } : {}) }));
    if (!starters.length) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post<{ schedules: number; scenes: string[] }>('/api/setup/starters', { starters }).subscribe({
      next: (r) => {
        this.busy.set(false);
        const parts = [
          r.schedules ? `${r.schedules} schedule${r.schedules === 1 ? '' : 's'}` : '',
          r.scenes.length ? `the ${r.scenes.join(' and ')} scene` : '',
        ].filter(Boolean);
        this.createdSummary.set(parts.join(' and '));
        this.choices.set({});
        this.go('family');
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.error.set(err.error?.error ?? 'Could not set these up.'); },
    });
  }
}
