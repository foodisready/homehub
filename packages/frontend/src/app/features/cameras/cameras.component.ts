import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { CamerasStateService } from '../../core/services/cameras-state.service';
import { AuthImgComponent } from './auth-img.component';
import { LiveViewComponent } from './live-view.component';

type BridgeState =
  | { state: 'not-configured' } | { state: 'off' } | { state: 'unreachable'; detail: string } | { state: 'signed-out' }
  | { state: 'starting' } | { state: 'sign-in-failed'; detail: string }
  | { state: 'unauthorized' } | { state: 'ready'; cameras: number };

interface Snapshot { id: number; deviceId: number | null; camera: string; cameraName: string; trigger: 'motion' | 'manual'; sizeBytes: number; takenAt: string }
interface Camera {
  deviceId: number; name: string; room: string | null; cam: string; model: string | null;
  /** A Pan camera, which live view can turn. */
  canPan: boolean;
  watching: boolean | null; online: boolean | null; streaming: boolean;
  /** Whether pictures actually arrive from the camera. */
  picture: 'ok' | 'failing' | 'unknown'; lastPictureAt: string | null; noPictureSince: string | null; noPictureHint: string | null;
  lastMotionAt: string | null; latestSnapshot: Snapshot | null;
}
interface AccountCamera { cam: string; name: string; model: string | null; ip: string | null; mac: string | null; streaming: boolean; added: boolean }
interface Settings { enabled: boolean; motionSnapshots: boolean; notify: boolean; keepDays: number; cooldownSeconds: number }

const PAGE = 48;

/** Wyze cameras: sign in to Wyze, watch live, pause and resume, take snapshots and look through them. */
@Component({
  selector: 'app-cameras',
  standalone: true,
  imports: [FormsModule, AuthImgComponent, LiveViewComponent],
  styles: [`
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1rem; }
    h2 { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin: 1.75rem 0 0.75rem; }
    .card { padding: 1rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; line-height: 1.5; }
    .link { background:none; border:none; padding:0; color:var(--accent, #60a5fa); font:inherit; cursor:pointer; text-decoration:underline; }
    .cmd {
      margin:0.6rem 0; padding:0.6rem 0.75rem; overflow-x:auto; white-space:pre;
      font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:0.8rem;
      background:var(--bg); border:1px solid var(--border); border-radius:var(--radius);
    }
    .msg { font-size: 0.82rem; margin-top: 0.5rem; }
    .msg.err { color: var(--red); }
    .msg.ok { color: var(--green); }
    .btn-sm { padding: 0.35rem 0.8rem; font-size: 0.8rem; }
    .ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .ghost:hover { color: var(--text); background: var(--surface); }
    .danger { background: var(--red); color: #fff; }

    .form { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.75rem; }
    .form input { font-size: 0.85rem; padding: 0.45rem 0.7rem; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    @media (max-width: 520px) { .form { grid-template-columns: 1fr; } }

    .add-list { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; }
    .add-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
    .add-row:first-child { border-top: none; }
    .add-row .name { flex: 1; min-width: 10rem; }
    .add-row .sub { display: block; font-size: 0.75rem; color: var(--text-muted); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 0.85rem; }
    .cam { overflow: hidden; padding: 0; }
    .cam app-auth-img { aspect-ratio: 16 / 9; cursor: pointer; }
    .cam-body { padding: 0.7rem 0.85rem 0.85rem; }
    .cam-title { display: flex; align-items: center; gap: 0.5rem; }
    .cam-title strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { font-size: 0.7rem; font-weight: 700; padding: 0.12rem 0.55rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); white-space: nowrap; }
    .pill.watching { border-color: var(--green); color: #4ade80; }
    .pill.paused { border-color: #f59e0b; color: #fbbf24; }
    .pill.offline { border-color: var(--red); color: #f87171; }
    .pill.nopicture { border-color: #f59e0b; color: #fbbf24; }
    .hint { font-size: 0.78rem; color: #fbbf24; margin: -0.3rem 0 0.6rem; line-height: 1.45; }
    .cam-sub { font-size: 0.75rem; color: var(--text-muted); margin: 0.2rem 0 0.6rem; }
    .cam-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .confirm { margin-top: 0.6rem; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.82rem; }
    .confirm span { flex: 1; min-width: 10rem; }

    .chips { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
    .chip { background: transparent; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); font-size: 0.8rem; padding: 0.3rem 0.8rem; }
    .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .day { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); margin: 1rem 0 0.4rem; }
    .shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(46%, 170px), 1fr)); gap: 0.5rem; }
    .shot { position: relative; padding: 0; background: none; border-radius: 8px; overflow: hidden; text-align: left; }
    .shot app-auth-img { aspect-ratio: 16 / 9; }
    .shot-meta {
      position: absolute; left: 0; right: 0; bottom: 0; padding: 0.9rem 0.45rem 0.3rem;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.75)); color: #fff; font-size: 0.7rem;
      display: flex; justify-content: space-between; gap: 0.3rem;
    }
    .more { margin-top: 0.85rem; text-align: center; }

    .lightbox { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.9); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 1rem; }
    .lightbox-frame { width: min(100%, 1100px); }
    .lightbox app-auth-img { aspect-ratio: 16 / 9; border-radius: 8px; }
    .lightbox-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; color: #fff; margin-bottom: 0.5rem; flex-wrap: wrap; font-size: 0.9rem; }
    .lightbox-nav { display: flex; gap: 0.4rem; }
    .lightbox button.ghost { color: #fff; border-color: rgba(255, 255, 255, 0.35); }

    .settings-row { display: flex; align-items: center; gap: 1rem; padding: 0.6rem 0; border-top: 1px solid var(--border); }
    .settings-row:first-child { border-top: none; }
    .settings-row .label { flex: 1; font-size: 0.9rem; }
    .settings-row .label small { display: block; color: var(--text-muted); font-size: 0.75rem; }
    .settings-row input[type=number] { width: 5.5rem; text-align: right; font-size: 0.9rem; padding: 0.35rem 0.5rem; }
    .settings-row input[type=checkbox] { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }
  `],
  template: `
    <div class="page">
      <h1>Cameras</h1>

      @if (bridge(); as b) {
        @if (b.state !== 'ready') {
          <div class="card">
            @switch (b.state) {
              @case ('off') {
                <strong>Cameras are off</strong>
                <p class="muted" style="margin-top:0.4rem">They're hidden from the menu, and HomeHub isn't watching for motion.</p>
                @if (isAdmin()) {
                  <button class="btn-sm btn-primary" type="button" style="margin-top:0.6rem" (click)="turnOn()" [disabled]="busy()">Turn on cameras</button>
                } @else {
                  <p class="muted">An administrator can turn them on in Settings → Integrations.</p>
                }
              }
              @case ('not-configured') {
                <strong>The camera bridge is left out of this HomeHub</strong>
                <p class="muted" style="margin-top:0.4rem">
                  HomeHub talks to Wyze cameras through the camera bridge. To add it, remove
                  <code>HOMEHUB_CAMERA_BRIDGE=0</code> from HomeHub's <code>.env</code>, then run this in the <code>homehub</code> folder:
                </p>
                <pre class="cmd">docker compose -f docker-compose.yml up -d</pre>
              }
              @case ('unreachable') {
                <strong>HomeHub can't reach the camera bridge</strong>
                <p class="muted" style="margin-top:0.4rem">Check that the <code>wyze-bridge</code> service is running. It can take a minute to start.</p>
              }
              @case ('unauthorized') {
                <strong>The camera bridge rejected HomeHub's key</strong>
                <p class="muted" style="margin-top:0.4rem">HomeHub and the bridge normally share a key HomeHub makes itself. If you set <code>WYZE_BRIDGE_API_KEY</code> in <code>.env</code>, remove it or make sure both use the same value, then run <code>docker compose -f docker-compose.yml up -d</code>.</p>
              }
              @case ('starting') {
                <strong>Signing in to Wyze…</strong>
                <p class="muted" style="margin-top:0.4rem">The camera bridge is starting with your Wyze account. This takes up to a minute.</p>
              }
              @case ('sign-in-failed') {
                <strong>Wyze sign-in didn't work</strong>
                <p class="msg err">{{ $any(b).detail }}</p>
              }
              @case ('signed-out') {
                <strong>Sign in to Wyze</strong>
              }
            }
            @if (b.state === 'signed-out' || b.state === 'sign-in-failed') {
                @if (isAdmin()) {
                  <p class="muted" style="margin-top:0.4rem">
                    Wyze needs your account and a free developer API key. Create the key at
                    <a href="https://developer-api-console.wyze.com/" target="_blank" rel="noopener">developer-api-console.wyze.com</a>.
                    HomeHub keeps these on this computer, for the camera bridge only, until you sign out.
                  </p>
                  <div class="form">
                    <input type="email" [(ngModel)]="email" placeholder="Wyze email" aria-label="Wyze email" autocomplete="off" />
                    <input type="password" [(ngModel)]="password" placeholder="Wyze password" aria-label="Wyze password" autocomplete="new-password" />
                    <input type="text" [(ngModel)]="keyId" placeholder="API key ID" aria-label="API key ID" autocomplete="off" />
                    <input type="password" [(ngModel)]="apiKey" placeholder="API key" aria-label="API key" autocomplete="new-password" />
                    <div class="wide">
                      <button class="btn-sm btn-primary" type="button" (click)="signIn()"
                              [disabled]="busy() || !email.trim() || !password || !keyId.trim() || !apiKey.trim()">
                        {{ busy() ? 'Signing in…' : 'Sign in' }}
                      </button>
                    </div>
                  </div>
                  <p class="muted" style="margin-top:0.75rem">
                    No Wyze cameras? <button class="link" type="button" (click)="turnOff()" [disabled]="busy()">Turn cameras off</button>
                    to hide this page from the menu. You can turn them back on in Settings → Integrations.
                  </p>
                } @else {
                  <p class="muted" style="margin-top:0.4rem">Ask an administrator to sign in to Wyze.</p>
                }
            }
            @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
          </div>
        }
      } @else {
        <p class="muted">Loading…</p>
      }

      @if (bridge()?.state === 'ready' && isAdmin() && notAdded().length) {
        <div class="card" style="margin-bottom:1rem">
          <strong>{{ notAdded().length === 1 ? 'A camera on your Wyze account isn\\'t in HomeHub' : notAdded().length + ' cameras on your Wyze account aren\\'t in HomeHub' }}</strong>
          <div class="add-list">
            @for (c of notAdded(); track c.cam) {
              <div class="add-row">
                <span class="name">{{ c.name }}<span class="sub">{{ c.model ?? 'Wyze camera' }}{{ c.ip ? ' · ' + c.ip : '' }}{{ c.streaming ? '' : ' · not connected yet' }}</span></span>
                <button class="btn-sm btn-primary" type="button" (click)="addCamera(c)" [disabled]="busy()">Add</button>
              </div>
            }
          </div>
          @if (notAdded().length > 1) {
            <button class="btn-sm ghost" type="button" style="margin-top:0.6rem" (click)="addAll()" [disabled]="busy()">Add all</button>
          }
          @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
        </div>
      }

      @if (cameras().length) {
        @if (bridgeError()) { <p class="msg err" style="margin-bottom:0.75rem">{{ bridgeError() }}</p> }
        <div class="grid">
          @for (c of cameras(); track c.deviceId) {
            <div class="card cam">
              <app-auth-img [src]="'/api/cameras/' + c.deviceId + '/live.jpg?cached=1'" (result)="thumbResult(c, $event)" [refreshSeconds]="c.watching === false ? 0 : 20"
                            [alt]="c.name" [failedText]="c.watching === false ? 'Paused' : c.streaming ? 'No picture right now' : 'Not connected to this camera yet'"
                            (click)="openLive(c)" role="button" [attr.aria-label]="'Watch ' + c.name + ' live'" />
              <div class="cam-body">
                <div class="cam-title">
                  <strong>{{ c.name }}</strong>
                  <span class="pill" [class]="'pill ' + statusOf(c)">{{ statusLabel(c) }}</span>
                </div>
                <div class="cam-sub">
                  {{ c.room ?? 'No room' }}{{ c.model ? ' · ' + c.model : '' }}
                  @if (c.lastMotionAt) { · motion {{ ago(c.lastMotionAt) }} }
                </div>
                @if (statusOf(c) === 'nopicture') {
                  <p class="hint">
                    {{ c.lastPictureAt ? 'Last picture ' + ago(c.lastPictureAt) + '.' : 'No picture yet.' }}
                    {{ c.noPictureHint }}
                  </p>
                }
                <div class="cam-actions">
                  <button class="btn-sm btn-primary" type="button" (click)="openLive(c)" [disabled]="c.watching === false">Live</button>
                  <button class="btn-sm ghost" type="button" (click)="takeSnapshot(c)" [disabled]="c.watching === false || busyId() === c.deviceId">
                    {{ busyId() === c.deviceId ? 'Saving…' : 'Snapshot' }}
                  </button>
                  @if (c.watching === false) {
                    <button class="btn-sm ghost" type="button" (click)="setWatching(c, true)" [disabled]="busyId() === c.deviceId">Resume</button>
                  } @else {
                    <button class="btn-sm ghost" type="button" (click)="confirmPause.set(c.deviceId)" [disabled]="busyId() === c.deviceId">Pause</button>
                  }
                </div>
                @if (confirmPause() === c.deviceId) {
                  <div class="confirm">
                    <span>Pause {{ c.name }}? It stops watching, recording and detecting motion until you resume it.</span>
                    <button class="btn-sm danger" type="button" (click)="setWatching(c, false)">Pause</button>
                    <button class="btn-sm ghost" type="button" (click)="confirmPause.set(null)">Cancel</button>
                  </div>
                }
              </div>
            </div>
          }
        </div>
        @if (cameraMsg()) { <p class="msg err">{{ cameraMsg() }}</p> }
      } @else if (bridge()?.state === 'ready' && !notAdded().length) {
        <p class="muted">No cameras yet. Cameras on your Wyze account appear here to add.</p>
      }

      @if (cameras().length || snapshots().length) {
        <h2>Snapshots</h2>
        <div class="chips" role="group" aria-label="Filter snapshots by camera">
          <button class="chip" type="button" [class.active]="filterId() === null" (click)="setFilter(null)">All</button>
          @for (c of cameras(); track c.deviceId) {
            <button class="chip" type="button" [class.active]="filterId() === c.deviceId" (click)="setFilter(c.deviceId)">{{ c.name }}</button>
          }
        </div>
        @if (!snapshots().length) {
          <p class="muted">No snapshots yet. When a camera sees motion, a picture is saved here. Press Snapshot on a camera to save one yourself.</p>
        }
        @for (day of days(); track day.label) {
          <div class="day">{{ day.label }}</div>
          <div class="shots">
            @for (s of day.items; track s.id) {
              <button class="shot" type="button" (click)="openShot(s)" [attr.aria-label]="s.cameraName + ', ' + time(s.takenAt)">
                <app-auth-img [src]="'/api/cameras/snapshots/' + s.id + '/image'" [alt]="s.cameraName" />
                <span class="shot-meta"><span>{{ s.cameraName }}</span><span>{{ time(s.takenAt) }}{{ s.trigger === 'motion' ? ' · motion' : '' }}</span></span>
              </button>
            }
          </div>
        }
        @if (hasMore()) {
          <div class="more"><button class="btn-sm ghost" type="button" (click)="loadMore()">Show older</button></div>
        }
      }

      @if (isAdmin() && bridge()?.state === 'ready' && settings(); as st) {
        <h2>Camera settings</h2>
        <div class="card">
          <div class="settings-row">
            <span class="label">Save a snapshot on motion<small>When Wyze reports motion from a camera, usually within half a minute</small></span>
            <input type="checkbox" [checked]="st.motionSnapshots" (change)="saveSettings({ motionSnapshots: $any($event.target).checked })" aria-label="Save a snapshot on motion" />
          </div>
          <div class="settings-row">
            <span class="label">Notify my phone<small>Sends a notification with each motion snapshot</small></span>
            <input type="checkbox" [checked]="st.notify" (change)="saveSettings({ notify: $any($event.target).checked })" aria-label="Notify on motion" />
          </div>
          <div class="settings-row">
            <span class="label">Wait between snapshots<small>From the same camera, so one visit doesn't fill the folder</small></span>
            <input type="number" min="5" max="3600" [value]="st.cooldownSeconds" (change)="saveSettings({ cooldownSeconds: +$any($event.target).value })" aria-label="Seconds between snapshots" /> sec
          </div>
          <div class="settings-row">
            <span class="label">Keep snapshots for<small>Older ones are deleted automatically</small></span>
            <input type="number" min="1" max="365" [value]="st.keepDays" (change)="saveSettings({ keepDays: +$any($event.target).value })" aria-label="Days to keep snapshots" /> days
          </div>
          <div class="settings-row">
            <span class="label">Wyze account<small>Signing out deletes your Wyze sign-in from HomeHub and stops the camera bridge</small></span>
            @if (confirmSignOut()) {
              <button class="btn-sm danger" type="button" (click)="signOut()" [disabled]="busy()">Sign out</button>
              <button class="btn-sm ghost" type="button" (click)="confirmSignOut.set(false)">Cancel</button>
            } @else {
              <button class="btn-sm ghost" type="button" (click)="confirmSignOut.set(true)" [disabled]="busy()">Sign out of Wyze</button>
            }
          </div>
          <div class="settings-row">
            <span class="label">Cameras in HomeHub<small>Turn off to hide Cameras from the menu and stop watching for motion</small></span>
            <button class="btn-sm ghost" type="button" (click)="turnOff()" [disabled]="busy()">Turn off</button>
          </div>
          @if (settingsMsg()) { <p class="msg" [class.err]="settingsErr()" [class.ok]="!settingsErr()">{{ settingsMsg() }}</p> }
        </div>
      }
    </div>

    @if (live(); as c) {
      <app-live-view [deviceId]="c.deviceId" [name]="c.name" [canPan]="c.canPan" (closed)="live.set(null)" />
    }

    @if (shot(); as s) {
      <div class="lightbox" (click)="shot.set(null)">
        <div class="lightbox-frame" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'Snapshot from ' + s.cameraName">
          <div class="lightbox-bar">
            <span><strong>{{ s.cameraName }}</strong> · {{ dateTime(s.takenAt) }}{{ s.trigger === 'motion' ? ' · motion' : '' }}</span>
            <span class="lightbox-nav">
              <button class="btn-sm ghost" type="button" (click)="step(-1)" [disabled]="!neighbor(-1)" aria-label="Newer">‹</button>
              <button class="btn-sm ghost" type="button" (click)="step(1)" [disabled]="!neighbor(1)" aria-label="Older">›</button>
              @if (isAdmin()) { <button class="btn-sm ghost" type="button" (click)="deleteShot(s)">Delete</button> }
              <button class="btn-sm ghost" type="button" (click)="shot.set(null)">Close</button>
            </span>
          </div>
          <app-auth-img [src]="'/api/cameras/snapshots/' + s.id + '/image'" [alt]="s.cameraName" />
        </div>
      </div>
    }
  `,
})
export class CamerasComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly socket = inject(SocketService);
  private readonly cams = inject(CamerasStateService);

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly bridge = signal<BridgeState | null>(null);
  readonly cameras = signal<Camera[]>([]);
  readonly bridgeError = signal<string | null>(null);
  readonly account = signal<AccountCamera[]>([]);
  readonly notAdded = computed(() => this.account().filter((c) => !c.added));
  readonly snapshots = signal<Snapshot[]>([]);
  readonly hasMore = signal(false);
  readonly filterId = signal<number | null>(null);
  readonly settings = signal<Settings | null>(null);

  readonly busy = signal(false);
  readonly busyId = signal<number | null>(null);
  readonly confirmSignOut = signal(false);
  readonly confirmPause = signal<number | null>(null);
  readonly live = signal<Camera | null>(null);
  readonly shot = signal<Snapshot | null>(null);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly cameraMsg = signal('');
  readonly settingsMsg = signal('');
  readonly settingsErr = signal(false);

  email = '';
  password = '';
  keyId = '';
  apiKey = '';

  readonly days = computed(() => {
    const groups: { label: string; items: Snapshot[] }[] = [];
    for (const s of this.snapshots()) {
      const label = this.dayLabel(s.takenAt);
      const last = groups[groups.length - 1];
      if (last?.label === label) last.items.push(s); else groups.push({ label, items: [s] });
    }
    return groups;
  });

  private timer?: ReturnType<typeof setInterval>;
  private stopSnapshots?: () => void;
  private stopState?: () => void;

  ngOnInit(): void {
    this.refresh();
    this.loadSnapshots();
    let tick = 0;
    this.timer = setInterval(() => {
      if (document.hidden) return;
      tick++;
      // While the bridge starts with a new sign-in, look often; otherwise refresh the cameras now and then.
      if (this.bridge()?.state === 'starting') this.refresh();
      else if (tick % 3 === 0) this.loadCameras();
    }, 5000);
    this.stopSnapshots = this.socket.onCameraSnapshot(() => this.loadSnapshots());
    this.stopState = this.socket.onDeviceState((ev) => {
      this.cameras.update((list) => list.map((c) => (c.deviceId === ev.id ? { ...c, watching: ev.state } : c)));
    });
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopSnapshots?.();
    this.stopState?.();
  }

  private refresh(): void {
    this.http.get<BridgeState>('/api/cameras/bridge').subscribe({
      next: (b) => {
        this.bridge.set(b);
        if (b.state === 'ready') {
          if (this.isAdmin()) {
            this.http.get<AccountCamera[]>('/api/cameras/bridge/cameras').subscribe({ next: (a) => this.account.set(a), error: () => undefined });
            this.http.get<Settings>('/api/cameras/settings').subscribe((s) => this.settings.set(s));
          }
        }
      },
      error: () => this.bridge.set({ state: 'unreachable', detail: '' }),
    });
    this.loadCameras();
  }

  private loadCameras(): void {
    this.http.get<{ bridgeError: string | null; cameras: Camera[] }>('/api/cameras').subscribe({
      next: (r) => { this.cameras.set(r.cameras); this.bridgeError.set(r.cameras.length ? r.bridgeError : null); },
      error: () => undefined,
    });
  }

  private loadSnapshots(): void {
    const id = this.filterId();
    const q = `limit=${PAGE}${id !== null ? `&deviceId=${id}` : ''}`;
    this.http.get<Snapshot[]>(`/api/cameras/snapshots?${q}`).subscribe((list) => {
      this.snapshots.set(list);
      this.hasMore.set(list.length === PAGE);
    });
  }

  loadMore(): void {
    const list = this.snapshots();
    if (!list.length) return;
    const id = this.filterId();
    const q = `limit=${PAGE}&before=${list[list.length - 1].id}${id !== null ? `&deviceId=${id}` : ''}`;
    this.http.get<Snapshot[]>(`/api/cameras/snapshots?${q}`).subscribe((more) => {
      this.snapshots.update((l) => [...l, ...more]);
      this.hasMore.set(more.length === PAGE);
    });
  }

  setFilter(id: number | null): void {
    this.filterId.set(id);
    this.loadSnapshots();
  }

  signIn(): void {
    this.busy.set(true);
    this.show('');
    this.show('Signing in. The camera bridge restarts with your account, which takes up to a minute.');
    this.http.post<BridgeState>('/api/cameras/bridge/login', { email: this.email.trim(), password: this.password, keyId: this.keyId.trim(), apiKey: this.apiKey.trim() }).subscribe({
      next: () => {
        this.busy.set(false);
        this.password = '';
        this.apiKey = '';
        this.show('Signed in. Your cameras are below.');
        this.refresh();
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Wyze sign-in failed.', true); },
    });
  }

  signOut(): void {
    this.busy.set(true);
    this.confirmSignOut.set(false);
    this.http.delete<BridgeState>('/api/cameras/bridge/login').subscribe({
      next: () => { this.busy.set(false); this.account.set([]); this.refresh(); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.settingsMsg.set(err.error?.error ?? 'Could not sign out.'); this.settingsErr.set(true); },
    });
  }

  turnOff(): void {
    this.busy.set(true);
    this.show('');
    this.cams.setEnabled(false).subscribe({
      next: () => { this.busy.set(false); this.refresh(); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Could not turn cameras off.', true); },
    });
  }

  turnOn(): void {
    this.busy.set(true);
    this.show('');
    this.cams.setEnabled(true).subscribe({
      next: () => { this.busy.set(false); this.refresh(); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Could not turn cameras on.', true); },
    });
  }

  addCamera(c: AccountCamera, after?: () => void): void {
    this.busy.set(true);
    this.http.post('/api/devices', {
      alias: c.name, ip: c.ip ?? `wyze:${c.cam}`, model: c.model ?? undefined, driverType: 'wyze',
      driverConfig: { cam: c.cam }, mac: c.mac ?? undefined,
    }).subscribe({
      next: () => {
        this.busy.set(false);
        this.account.update((list) => list.map((a) => (a.cam === c.cam ? { ...a, added: true } : a)));
        this.show(`Added ${c.name}. Give it a room in Settings → Devices.`);
        this.loadCameras();
        after?.();
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(`${c.name}: ${err.error?.error ?? 'could not add it'}`, true); },
    });
  }

  addAll(): void {
    const [first, ...rest] = this.notAdded();
    if (!first) return;
    this.addCamera(first, () => { if (rest.length) this.addAll(); });
  }

  setWatching(c: Camera, on: boolean): void {
    this.confirmPause.set(null);
    this.busyId.set(c.deviceId);
    this.cameraMsg.set('');
    this.http.post(`/api/devices/${c.deviceId}/${on ? 'on' : 'off'}`, {}).subscribe({
      next: () => {
        this.busyId.set(null);
        this.cameras.update((list) => list.map((x) => (x.deviceId === c.deviceId ? { ...x, watching: on } : x)));
      },
      error: (err: HttpErrorResponse) => {
        this.busyId.set(null);
        this.cameraMsg.set(err.error?.code === 'CAMERA_ERROR' ? err.error.error : `Couldn't ${on ? 'resume' : 'pause'} ${c.name}. Try again.`);
      },
    });
  }

  takeSnapshot(c: Camera): void {
    this.busyId.set(c.deviceId);
    this.cameraMsg.set('');
    this.http.post<Snapshot>(`/api/cameras/${c.deviceId}/snapshots`, {}).subscribe({
      next: () => { this.busyId.set(null); this.loadSnapshots(); },
      error: (err: HttpErrorResponse) => { this.busyId.set(null); this.cameraMsg.set(err.error?.error ?? `No picture from ${c.name}.`); },
    });
  }

  saveSettings(patch: Partial<Settings>): void {
    this.http.put<Settings>('/api/cameras/settings', patch).subscribe({
      next: (s) => { this.settings.set(s); this.settingsMsg.set('Saved'); this.settingsErr.set(false); },
      error: (err: HttpErrorResponse) => { this.settingsMsg.set(err.error?.error ?? 'Could not save'); this.settingsErr.set(true); },
    });
  }

  openLive(c: Camera): void {
    if (c.watching !== false) this.live.set(c);
  }

  openShot(s: Snapshot): void { this.shot.set(s); }

  neighbor(dir: -1 | 1): Snapshot | null {
    const list = this.snapshots();
    const i = list.findIndex((s) => s.id === this.shot()?.id);
    return i < 0 ? null : list[i + dir] ?? null;
  }

  step(dir: -1 | 1): void {
    const next = this.neighbor(dir);
    if (next) this.shot.set(next);
  }

  deleteShot(s: Snapshot): void {
    const next = this.neighbor(1) ?? this.neighbor(-1);
    this.http.delete(`/api/cameras/snapshots/${s.id}`).subscribe(() => {
      this.snapshots.update((l) => l.filter((x) => x.id !== s.id));
      this.shot.set(next);
    });
  }

  /** A picture this page just loaded: good news before HomeHub's next camera list says so. */
  private readonly thumbOk = signal<Record<number, boolean>>({});

  thumbResult(c: Camera, ok: boolean): void {
    if (this.thumbOk()[c.deviceId] !== ok) this.thumbOk.update((m) => ({ ...m, [c.deviceId]: ok }));
  }

  /** "Watching" only when pictures actually arrive; the bridge's own word for it can't be trusted. */
  statusOf(c: Camera): string {
    if (c.online === false) return 'offline';
    if (c.watching === false) return 'paused';
    if (c.picture === 'failing') return 'nopicture';
    if (c.watching && (c.picture === 'ok' || this.thumbOk()[c.deviceId] === true)) return 'watching';
    return '';
  }

  statusLabel(c: Camera): string {
    return ({ offline: 'Offline', paused: 'Paused', watching: 'Watching', nopicture: 'No picture' } as Record<string, string>)[this.statusOf(c)] ?? 'Checking…';
  }

  ago(iso: string): string {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  time(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  dateTime(iso: string): string {
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' });
  }

  private dayLabel(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
