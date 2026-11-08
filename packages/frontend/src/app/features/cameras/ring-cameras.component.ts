import { Component, OnDestroy, OnInit, computed, inject, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { CamerasStateService } from '../../core/services/cameras-state.service';
import { AuthImgComponent } from './auth-img.component';

export interface RingSnapshot { id: number; deviceId: number | null; camera: string; cameraName: string; trigger: 'motion' | 'manual' | 'doorbell'; sizeBytes: number; takenAt: string }
export interface RingCamera {
  id: number; name: string; key: string; model: string | null; isDoorbell: boolean;
  offline: boolean | null; hasBattery: boolean; lastDingAt: string | null; lastMotionAt: string | null;
  encrypted: boolean; latestSnapshot: RingSnapshot | null;
}
type RingStatus =
  | { state: 'signed-out' | 'standby' | 'connecting' | 'ready' }
  | { state: 'expired' | 'error'; detail: string };
interface RingInfo { state: RingStatus['state']; detail?: string; cameras: RingCamera[]; notifyDoorbell: boolean }
interface AccountCamera { id: number; name: string; model: string; isDoorbell: boolean; hasBattery: boolean; offline: boolean; added: boolean }

/**
 * Ring doorbells and cameras on the Cameras page: sign in with the code Ring
 * sends, add cameras, and see the pictures saved when the doorbell rings or a
 * camera sees motion. There's no live view yet.
 */
@Component({
  selector: 'app-ring-cameras',
  standalone: true,
  imports: [FormsModule, AuthImgComponent],
  styles: [`
    h2 { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); margin: 1.75rem 0 0.75rem; }
    .card { padding: 1rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; line-height: 1.5; }
    .msg { font-size: 0.82rem; margin-top: 0.5rem; }
    .msg.err { color: var(--red); }
    .msg.ok { color: var(--green); }
    .btn-sm { padding: 0.35rem 0.8rem; font-size: 0.8rem; }
    .ghost { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
    .ghost:hover { color: var(--text); background: var(--surface); }
    .danger { background: var(--red); color: #fff; }
    .link { background:none; border:none; padding:0; color:var(--accent, #60a5fa); font:inherit; cursor:pointer; text-decoration:underline; }

    .form { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.75rem; }
    .form input { font-size: 0.85rem; padding: 0.45rem 0.7rem; min-width: 0; }
    .wide { grid-column: 1 / -1; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    @media (max-width: 520px) { .form { grid-template-columns: 1fr; } }
    .code { letter-spacing: 0.2em; font-variant-numeric: tabular-nums; }

    .add-list { margin-top: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; }
    .add-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
    .add-row:first-child { border-top: none; }
    .add-row .name { flex: 1; min-width: 10rem; }
    .add-row .sub { display: block; font-size: 0.75rem; color: var(--text-muted); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 0.85rem; }
    .cam { overflow: hidden; padding: 0; }
    .cam app-auth-img, .cam .no-pic { aspect-ratio: 16 / 9; }
    .cam app-auth-img { cursor: pointer; }
    .no-pic { display: flex; align-items: center; justify-content: center; background: #0b1220; color: var(--text-muted); font-size: 0.8rem; text-align: center; padding: 0.5rem; }
    .cam-body { padding: 0.7rem 0.85rem 0.85rem; }
    .cam-title { display: flex; align-items: center; gap: 0.5rem; }
    .cam-title strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { font-size: 0.7rem; font-weight: 700; padding: 0.12rem 0.55rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); white-space: nowrap; }
    .pill.offline { border-color: var(--red); color: #f87171; }
    .cam-sub { font-size: 0.75rem; color: var(--text-muted); margin: 0.2rem 0 0.6rem; }
    .hint { font-size: 0.78rem; color: #fbbf24; margin: -0.3rem 0 0.6rem; line-height: 1.45; }
    .cam-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .confirm { margin-top: 0.6rem; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.82rem; }
    .confirm span { flex: 1; min-width: 10rem; }

    .settings-row { display: flex; align-items: center; gap: 1rem; padding: 0.6rem 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
    .settings-row:first-child { border-top: none; }
    .settings-row .label { flex: 1; min-width: 12rem; font-size: 0.9rem; }
    .settings-row .label small { display: block; color: var(--text-muted); font-size: 0.75rem; }
    .settings-row input[type=checkbox] { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); flex: none; }
  `],
  template: `
    @if (info(); as r) {
      @if (r.state !== 'signed-out' || isAdmin()) {
        <h2>Ring</h2>
      }

      @if (needsSignIn(r.state) && isAdmin()) {
        <div class="card" style="margin-bottom:1rem">
          @if (r.state === 'expired') {
            <strong>Sign in to Ring again</strong>
            <p class="msg err">{{ r.detail }}</p>
          } @else if (!formOpen() && !codeSentTo()) {
            <strong>Ring doorbell or cameras?</strong>
            <p class="muted" style="margin-top:0.4rem">
              Sign in to Ring and HomeHub saves a picture when someone rings the doorbell, notifies your phone,
              and can turn on a light when a Ring camera sees motion.
            </p>
            <button class="btn-sm btn-primary" type="button" style="margin-top:0.6rem" (click)="formOpen.set(true)">Sign in to Ring</button>
          }

          @if (codeSentTo(); as to) {
            <strong>Enter the code from Ring</strong>
            <p class="muted" style="margin-top:0.4rem">Enter the code {{ to }}. It may take a minute to arrive.</p>
            <div class="form">
              <input class="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8"
                     [(ngModel)]="code" placeholder="Code" aria-label="Code from Ring" (keyup.enter)="submitCode()" />
              <div class="wide">
                <button class="btn-sm btn-primary" type="button" (click)="submitCode()" [disabled]="busy() || code.replace(' ', '').length < 4">
                  {{ busy() ? 'Signing in…' : 'Sign in' }}
                </button>
                <button class="btn-sm ghost" type="button" (click)="startOver()" [disabled]="busy()">Start over</button>
              </div>
            </div>
          } @else if (formOpen() || r.state === 'expired') {
            @if (r.state !== 'expired') { <strong>Sign in to Ring</strong> }
            <p class="muted" style="margin-top:0.4rem">
              HomeHub keeps the sign-in Ring gives it, not your password, on this computer only.
              It appears in the Ring app as “HomeHub” under Control Center → Authorized Client Devices, where you can remove it.
            </p>
            <div class="form">
              <input type="email" [(ngModel)]="email" placeholder="Ring email" aria-label="Ring email" autocomplete="off" />
              <input type="password" [(ngModel)]="password" placeholder="Ring password" aria-label="Ring password" autocomplete="new-password" (keyup.enter)="signIn()" />
              <div class="wide">
                <button class="btn-sm btn-primary" type="button" (click)="signIn()" [disabled]="busy() || !email.trim() || !password">
                  {{ busy() ? 'Signing in…' : 'Sign in' }}
                </button>
                @if (r.state !== 'expired') {
                  <button class="btn-sm ghost" type="button" (click)="formOpen.set(false)" [disabled]="busy()">Cancel</button>
                }
              </div>
            </div>
          }
          @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
        </div>
      }

      @switch (r.state) {
        @case ('standby') {
          <div class="card" style="margin-bottom:1rem">
            <strong>Ring runs on the active HomeHub</strong>
            <p class="muted" style="margin-top:0.4rem">This HomeHub is a backup or development server, so it doesn't connect to Ring. It keeps your Ring sign-in for when it's made the active server.</p>
          </div>
        }
        @case ('connecting') { <p class="muted" style="margin-bottom:1rem">Connecting to Ring…</p> }
        @case ('error') {
          <div class="card" style="margin-bottom:1rem">
            <strong>HomeHub can't reach Ring right now</strong>
            <p class="muted" style="margin-top:0.4rem">It keeps trying. Doorbell presses won't arrive until it connects.</p>
            <p class="msg err">{{ r.detail }}</p>
          </div>
        }
      }

      @if (r.state === 'ready' && isAdmin() && notAdded().length) {
        <div class="card" style="margin-bottom:1rem">
          <strong>{{ notAdded().length === 1 ? 'A camera on your Ring account isn\\'t in HomeHub' : notAdded().length + ' cameras on your Ring account aren\\'t in HomeHub' }}</strong>
          <div class="add-list">
            @for (c of notAdded(); track c.id) {
              <div class="add-row">
                <span class="name">{{ c.name }}<span class="sub">{{ c.model }}{{ c.hasBattery ? ' · battery' : '' }}{{ c.offline ? ' · offline' : '' }}</span></span>
                <button class="btn-sm btn-primary" type="button" (click)="add(c)" [disabled]="busy()">Add</button>
              </div>
            }
          </div>
          @if (message() && !needsSignIn(r.state)) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
        </div>
      }

      @if (r.cameras.length) {
        <div class="grid">
          @for (c of r.cameras; track c.id) {
            <div class="card cam">
              @if (c.latestSnapshot; as s) {
                <app-auth-img [src]="'/api/cameras/snapshots/' + s.id + '/image'" [alt]="c.name" (click)="openSnapshot.emit(s)"
                              role="button" [attr.aria-label]="'Latest picture from ' + c.name" />
              } @else {
                <div class="no-pic">{{ c.encrypted ? 'End-to-end encryption is on, so Ring shares no pictures' : 'No picture yet' }}</div>
              }
              <div class="cam-body">
                <div class="cam-title">
                  <strong>{{ c.name }}</strong>
                  @if (c.offline) { <span class="pill offline">Offline</span> }
                  @else { <span class="pill">{{ c.isDoorbell ? 'Doorbell' : 'Camera' }}</span> }
                </div>
                <div class="cam-sub">
                  {{ c.model ?? 'Ring' }}
                  @if (c.lastDingAt) { · rang {{ ago(c.lastDingAt) }} }
                  @if (c.lastMotionAt) { · motion {{ ago(c.lastMotionAt) }} }
                  @if (c.latestSnapshot; as s) { · picture {{ ago(s.takenAt) }} }
                </div>
                @if (c.encrypted) {
                  <p class="hint">End-to-end encryption is on for this camera in the Ring app, so HomeHub gets no pictures. Doorbell notifications still work.</p>
                }
                <div class="cam-actions">
                  <button class="btn-sm ghost" type="button" (click)="snapshot(c)" [disabled]="r.state !== 'ready' || busyId() === c.id || c.encrypted">
                    {{ busyId() === c.id ? 'Saving…' : 'Snapshot' }}
                  </button>
                  @if (isAdmin()) {
                    <button class="btn-sm ghost" type="button" (click)="confirmRemove.set(c.id)" [disabled]="busyId() === c.id">Remove</button>
                  }
                </div>
                @if (confirmRemove() === c.id) {
                  <div class="confirm">
                    <span>Take {{ c.name }} out of HomeHub? It stays in your Ring account, and its snapshots stay here until they're old enough to delete.</span>
                    <button class="btn-sm danger" type="button" (click)="remove(c)">Remove</button>
                    <button class="btn-sm ghost" type="button" (click)="confirmRemove.set(null)">Cancel</button>
                  </div>
                }
              </div>
            </div>
          }
        </div>
        @if (cameraMsg()) { <p class="msg err">{{ cameraMsg() }}</p> }
      } @else if (r.state === 'ready' && !notAdded().length && isAdmin()) {
        <p class="muted">No cameras on your Ring account.</p>
      }

      @if (isAdmin() && r.state !== 'signed-out') {
        <div class="card" style="margin-top:0.85rem">
          <div class="settings-row">
            <span class="label">Notify my phone when the doorbell rings<small>With the picture, when Ring has one. Motion follows the camera settings below</small></span>
            <input type="checkbox" [checked]="r.notifyDoorbell" (change)="saveNotify($any($event.target).checked)" aria-label="Notify when the doorbell rings" />
          </div>
          <div class="settings-row">
            <span class="label">Ring account<small>Signing out deletes HomeHub's Ring sign-in. Added cameras stay listed for when you sign in again</small></span>
            @if (confirmSignOut()) {
              <button class="btn-sm danger" type="button" (click)="signOut()" [disabled]="busy()">Sign out</button>
              <button class="btn-sm ghost" type="button" (click)="confirmSignOut.set(false)">Cancel</button>
            } @else {
              <button class="btn-sm ghost" type="button" (click)="confirmSignOut.set(true)" [disabled]="busy()">Sign out of Ring</button>
            }
          </div>
          @if (settingsMsg()) { <p class="msg" [class.err]="settingsErr()" [class.ok]="!settingsErr()">{{ settingsMsg() }}</p> }
        </div>
      }
    }
  `,
})
export class RingCamerasComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly socket = inject(SocketService);
  private readonly cams = inject(CamerasStateService);

  /** A camera's latest picture was tapped. */
  readonly openSnapshot = output<RingSnapshot>();
  /** The Ring cameras in HomeHub, each time they're loaded, for the snapshot filter. */
  readonly camerasChange = output<RingCamera[]>();

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly info = signal<RingInfo | null>(null);
  readonly account = signal<AccountCamera[]>([]);
  readonly notAdded = computed(() => this.account().filter((c) => !c.added));
  readonly formOpen = signal(false);
  readonly codeSentTo = signal<string | null>(null);
  readonly busy = signal(false);
  readonly busyId = signal<number | null>(null);
  readonly confirmRemove = signal<number | null>(null);
  readonly confirmSignOut = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly cameraMsg = signal('');
  readonly settingsMsg = signal('');
  readonly settingsErr = signal(false);

  email = '';
  password = '';
  code = '';

  private timer?: ReturnType<typeof setInterval>;
  private stopSnapshots?: () => void;

  needsSignIn(state: RingStatus['state']): boolean {
    return state === 'signed-out' || state === 'expired';
  }

  ngOnInit(): void {
    this.load();
    // Fast while connecting, then now and then for "rang 2 min ago".
    let tick = 0;
    this.timer = setInterval(() => {
      if (document.hidden) return;
      tick++;
      if (this.info()?.state === 'connecting' || tick % 6 === 0) this.load();
    }, 5000);
    this.stopSnapshots = this.socket.onCameraSnapshot((ev) => { if (ev.deviceId === null) this.load(); });
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopSnapshots?.();
  }

  private load(): void {
    this.http.get<RingInfo>('/api/ring').subscribe({
      next: (r) => {
        const wasReady = this.info()?.state === 'ready';
        this.info.set(r);
        this.camerasChange.emit(r.cameras);
        if (r.state === 'ready' && this.isAdmin() && (!wasReady || !this.account().length)) this.loadAccount();
        if (r.state !== 'ready') this.account.set([]);
      },
      error: () => undefined,
    });
  }

  private loadAccount(): void {
    this.http.get<AccountCamera[]>('/api/ring/account').subscribe({ next: (a) => this.account.set(a), error: () => undefined });
  }

  signIn(): void {
    if (this.busy() || !this.email.trim() || !this.password) return;
    this.busy.set(true);
    this.show('');
    this.http.post<{ signedIn: boolean; codeSentTo?: string }>('/api/ring/login', { email: this.email.trim(), password: this.password }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.password = '';
        if (r.signedIn) this.signedIn();
        else this.codeSentTo.set(r.codeSentTo ?? 'sent to your phone or email');
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Ring sign-in failed.', true); },
    });
  }

  submitCode(): void {
    const code = this.code.replace(/\s/g, '');
    if (this.busy() || code.length < 4) return;
    this.busy.set(true);
    this.show('');
    this.http.post<{ signedIn: boolean }>('/api/ring/login/code', { code }).subscribe({
      next: () => { this.busy.set(false); this.signedIn(); },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.show(err.error?.error ?? 'Ring sign-in failed.', true);
        // An expired sign-in needs the password again.
        if (/expired/i.test(err.error?.error ?? '')) this.startOver(true);
      },
    });
  }

  startOver(keepMessage = false): void {
    this.codeSentTo.set(null);
    this.code = '';
    this.formOpen.set(true);
    if (!keepMessage) this.show('');
  }

  private signedIn(): void {
    this.codeSentTo.set(null);
    this.formOpen.set(false);
    this.code = '';
    this.email = '';
    this.show('Signed in to Ring. Add your cameras below.');
    this.cams.load();   // Cameras stays in the menu even without the Wyze bridge
    this.load();
  }

  signOut(): void {
    this.busy.set(true);
    this.confirmSignOut.set(false);
    this.http.delete('/api/ring/login').subscribe({
      next: () => { this.busy.set(false); this.settingsMsg.set(''); this.cams.load(); this.load(); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.settingsMsg.set(err.error?.error ?? 'Could not sign out.'); this.settingsErr.set(true); },
    });
  }

  add(c: AccountCamera): void {
    this.busy.set(true);
    this.http.post('/api/ring/cameras', { id: c.id }).subscribe({
      next: () => {
        this.busy.set(false);
        this.account.update((list) => list.map((a) => (a.id === c.id ? { ...a, added: true } : a)));
        this.show(`Added ${c.name}.`);
        this.load();
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(`${c.name}: ${err.error?.error ?? 'could not add it'}`, true); },
    });
  }

  remove(c: RingCamera): void {
    this.confirmRemove.set(null);
    this.busyId.set(c.id);
    this.http.delete(`/api/ring/cameras/${c.id}`).subscribe({
      next: () => {
        this.busyId.set(null);
        this.account.update((list) => list.map((a) => (a.id === c.id ? { ...a, added: false } : a)));
        this.load();
      },
      error: (err: HttpErrorResponse) => { this.busyId.set(null); this.cameraMsg.set(err.error?.error ?? `Couldn't remove ${c.name}.`); },
    });
  }

  snapshot(c: RingCamera): void {
    this.busyId.set(c.id);
    this.cameraMsg.set('');
    this.http.post(`/api/ring/cameras/${c.id}/snapshots`, {}).subscribe({
      next: () => { this.busyId.set(null); this.load(); },
      error: (err: HttpErrorResponse) => { this.busyId.set(null); this.cameraMsg.set(err.error?.error ?? `No picture from ${c.name}.`); },
    });
  }

  saveNotify(on: boolean): void {
    this.http.put<{ notifyDoorbell: boolean }>('/api/ring/settings', { notifyDoorbell: on }).subscribe({
      next: (r) => {
        this.info.update((i) => (i ? { ...i, notifyDoorbell: r.notifyDoorbell } : i));
        this.settingsMsg.set('Saved');
        this.settingsErr.set(false);
      },
      error: (err: HttpErrorResponse) => { this.settingsMsg.set(err.error?.error ?? 'Could not save'); this.settingsErr.set(true); },
    });
  }

  ago(iso: string): string {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
