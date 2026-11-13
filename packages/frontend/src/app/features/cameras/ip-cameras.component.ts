import { Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { CamerasStateService } from '../../core/services/cameras-state.service';
import { AuthImgComponent } from './auth-img.component';
import { LiveViewComponent } from './live-view.component';
import { NO_FILTER, brandShown, cameraMatches, type CameraFilter } from './camera-filter';
import { SecretInputDirective } from '../../shared/secret-input/secret-input.directive';

export interface IpSnapshot { id: number; deviceId: number | null; camera: string; cameraName: string; trigger: 'motion' | 'manual' | 'doorbell'; sizeBytes: number; takenAt: string }
type MotionState = 'off' | 'unsupported' | 'standby' | 'connecting' | 'watching' | 'error';
/** What a search can find an IP camera by. */
export const ipWords = (c: IpCamera): (string | null)[] =>
  [c.name, c.maker, c.model, c.host, c.onvif ? 'onvif' : 'rtsp'];

export interface IpCamera {
  id: number; name: string; key: string; host: string; maker: string | null; model: string | null;
  onvif: boolean; canPan: boolean; username: string; hasPassword: boolean;
  quality: 'main' | 'sub'; hasSubStream: boolean; motion: boolean;
  motionState: MotionState; motionDetail: string | null; lastMotionAt: string | null; latestSnapshot: IpSnapshot | null;
}
interface Found { host: string; port: number; name: string | null; model: string | null; added: boolean }
interface IpInfo { relay: { state: 'ready' } | { state: 'unreachable'; detail: string } | null; cameras: IpCamera[] }

/**
 * IP cameras on the Cameras page: Reolink, Amcrest and other cameras that
 * HomeHub reaches directly on the home network, with no cloud. Add one by
 * its address and the login set on the camera, watch it live, turn it, and
 * see the pictures saved when it sees motion.
 */
@Component({
  selector: 'app-ip-cameras',
  standalone: true,
  imports: [SecretInputDirective, FormsModule, AuthImgComponent, LiveViewComponent],
  styleUrls: ['./camera-layout.css'],
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
    .link { background: none; border: none; padding: 0; color: var(--accent, #60a5fa); font: inherit; font-size: 0.8rem; cursor: pointer; text-decoration: underline; }

    .form { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin-top: 0.75rem; }
    .form input, .form select { font-size: 0.85rem; padding: 0.45rem 0.7rem; min-width: 0; }
    .form label.check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
    .form label.check input { width: 1.15rem; height: 1.15rem; flex: none; padding: 0; margin: 0; accent-color: var(--accent); }
    .wide { grid-column: 1 / -1; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .field-note { grid-column: 1 / -1; font-size: 0.75rem; color: var(--text-muted); margin: -0.2rem 0 0.2rem; line-height: 1.4; }
    @media (max-width: 520px) { .form { grid-template-columns: 1fr; } }

    .found { margin-top: 0.6rem; display: flex; flex-direction: column; }
    .found-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.45rem 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
    .found-row:first-child { border-top: none; }
    .found-row .name { flex: 1; min-width: 10rem; font-size: 0.88rem; }
    .found-row .sub { display: block; font-size: 0.75rem; color: var(--text-muted); }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 0.85rem; }
    .cam { overflow: hidden; padding: 0; }
    .cam app-auth-img { aspect-ratio: 16 / 9; cursor: pointer; }
    .cam-body { padding: 0.7rem 0.85rem 0.85rem; }
    .cam-title { display: flex; align-items: center; gap: 0.5rem; }
    .cam-title strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { font-size: 0.7rem; font-weight: 700; padding: 0.12rem 0.55rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); white-space: nowrap; }
    .pill.watching { border-color: var(--green); color: #4ade80; }
    .pill.error { border-color: #f59e0b; color: #fbbf24; }
    .cam-sub { font-size: 0.75rem; color: var(--text-muted); margin: 0.2rem 0 0.6rem; }
    .hint { font-size: 0.78rem; color: #fbbf24; margin: -0.3rem 0 0.6rem; line-height: 1.45; }
    .cam-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }
    .confirm { margin-top: 0.6rem; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: 0.82rem; }
    .confirm span { flex: 1; min-width: 10rem; }

    /* The cards join the Cameras page's grid (camera-layout.css). */
    :host { display: contents; }
  `],
  template: `
    @if (info(); as r) {
      @if (view() === 'cameras' && brandShown(filter(), 'ip')) {
        <!-- On the Cameras tab: what needs attention, and the cameras themselves. -->
        @if (r.relay?.state === 'unreachable') {
          <div class="note"><span>Live video from IP cameras needs the camera relay. {{ $any(r.relay).detail }}</span></div>
        }
        @for (c of shown(); track c.id) {
          <div class="card cam">
            <app-auth-img [src]="'/api/ip-cameras/' + c.id + '/live.jpg'" [refreshSeconds]="20" [alt]="c.name"
                          failedText="No picture right now" (click)="live.set(c)" role="button" [attr.aria-label]="'Watch ' + c.name + ' live'" />
            <div class="cam-body">
              <div class="cam-title">
                <strong>{{ c.name }}</strong>
                <span class="pill" [class.watching]="c.motionState === 'watching'" [class.error]="c.motionState === 'error'">{{ motionLabel(c) }}</span>
              </div>
              <div class="cam-sub">
                {{ c.maker ? c.maker + ' ' : '' }}{{ c.model ?? (c.onvif ? 'ONVIF camera' : 'RTSP camera') }} · {{ c.host }}
                @if (c.lastMotionAt) { · motion {{ ago(c.lastMotionAt) }} }
              </div>
              @if (c.motionState === 'error') {
                <p class="hint">HomeHub can't get motion from this camera and keeps trying: {{ c.motionDetail }}. If it has no motion detection, or it's off in the camera's app, turn motion off under Edit.</p>
              }
              <div class="cam-actions">
                <button class="btn-sm btn-primary" type="button" (click)="live.set(c)">Live</button>
                <button class="btn-sm ghost" type="button" (click)="snapshot(c)" [disabled]="busyId() === c.id">{{ busyId() === c.id ? 'Saving…' : 'Snapshot' }}</button>
                @if (isAdmin()) {
                  <button class="btn-sm ghost" type="button" (click)="startEdit(c)" [disabled]="busyId() === c.id">Edit</button>
                  <button class="btn-sm ghost" type="button" (click)="confirmRemove.set(c.id)" [disabled]="busyId() === c.id">Remove</button>
                }
              </div>
              @if (editing() === c.id) {
                <div class="form">
                  <input type="text" [(ngModel)]="editName" placeholder="Name" aria-label="Name" maxlength="80" style="grid-column:1/-1" />
                  <input type="text" [(ngModel)]="editUser" placeholder="Camera username" aria-label="Camera username" autocomplete="off" />
                  <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore [(ngModel)]="editPass" placeholder="New password (blank keeps it)" aria-label="Camera password" />
                  @if (c.hasSubStream) {
                    <select [(ngModel)]="editQuality" aria-label="Live video quality" style="grid-column:1/-1">
                      <option value="main">Live video: full quality</option>
                      <option value="sub">Live video: smaller, for slow Wi-Fi or phones that can't play the full stream</option>
                    </select>
                  }
                  @if (c.onvif) {
                    <label class="check" style="grid-column:1/-1"><input type="checkbox" [(ngModel)]="editMotion" /> Save a picture when it sees motion</label>
                  }
                  <div class="wide">
                    <button class="btn-sm btn-primary" type="button" (click)="saveEdit(c)" [disabled]="busyId() === c.id || !editName.trim()">{{ busyId() === c.id ? 'Saving…' : 'Save' }}</button>
                    <button class="btn-sm ghost" type="button" (click)="editing.set(null)" [disabled]="busyId() === c.id">Cancel</button>
                  </div>
                </div>
              }
              @if (confirmRemove() === c.id) {
                <div class="confirm">
                  <span>Take {{ c.name }} out of HomeHub? The camera isn't changed, and its snapshots stay here until they're old enough to delete.</span>
                  <button class="btn-sm danger" type="button" (click)="remove(c)">Remove</button>
                  <button class="btn-sm ghost" type="button" (click)="confirmRemove.set(null)">Cancel</button>
                </div>
              }
            </div>
          </div>
        }
        @if (cameraMsg()) { <p class="msg err span">{{ cameraMsg() }}</p> }
      } @else if (view() === 'setup' && isAdmin()) {
        <!-- On the Setup tab: adding IP cameras. -->
        <section class="card source">
          <div class="source-head">
            <strong>IP cameras</strong>
            <span class="pill" [class.ok]="r.cameras.length > 0">{{ r.cameras.length ? (r.cameras.length === 1 ? '1 camera' : r.cameras.length + ' cameras') : 'Not set up' }}</span>
          </div>
          @if (r.relay?.state === 'unreachable') { <p class="msg err">{{ $any(r.relay).detail }}</p> }
          @if (!formOpen()) {
            <p class="muted">
              Reolink, Amcrest or another IP camera? HomeHub talks to it directly on your home network, with no cloud or subscription:
              live video, pictures when it sees motion, and turning, if it turns.
            </p>
            <button class="btn-sm btn-primary" type="button" style="margin-top:0.6rem" (click)="openForm()">{{ r.cameras.length ? 'Add another IP camera' : 'Add an IP camera' }}</button>
            @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
          } @else {
            <p class="muted" style="margin-top:0.4rem">
              Use the username and password set on the camera itself, not a cloud account. The camera needs ONVIF on
              (in Reolink: Settings → Network → Advanced → Server Settings), and to be on the same Wi-Fi as HomeHub.
            </p>
            <div class="wide" style="margin-top:0.6rem">
              <button class="btn-sm ghost" type="button" (click)="search()" [disabled]="searching() || busy()">{{ searching() ? 'Searching…' : 'Search the network' }}</button>
              @if (searched() && !found().length) { <span class="muted">None answered. Enter the camera's address below.</span> }
            </div>
            @if (found().length) {
              <div class="found">
                @for (f of found(); track f.host) {
                  <div class="found-row">
                    <span class="name">{{ f.model ?? f.name ?? 'Camera' }}<span class="sub">{{ f.host }}{{ f.name && f.model ? ' · ' + f.name : '' }}</span></span>
                    @if (f.added) { <span class="muted">Added</span> }
                    @else { <button class="btn-sm ghost" type="button" (click)="pick(f)">Use</button> }
                  </div>
                }
              </div>
            }
            <div class="form">
              @if (!byRtsp()) {
                <input type="text" [(ngModel)]="host" placeholder="Address, such as 192.0.2.20" aria-label="Camera address" autocomplete="off" />
                <input type="text" [(ngModel)]="name" placeholder="Name (optional)" aria-label="Camera name" maxlength="80" />
              } @else {
                <input type="text" [(ngModel)]="rtspUrl" placeholder="rtsp://192.0.2.20:554/stream" aria-label="RTSP address" autocomplete="off" style="grid-column:1/-1" />
                <p class="field-note">Live video and pictures; motion needs ONVIF. The camera's manual or app gives this address.</p>
                <input type="text" [(ngModel)]="name" placeholder="Name (optional)" aria-label="Camera name" maxlength="80" />
                <span></span>
              }
              <input type="text" [(ngModel)]="username" placeholder="Camera username" aria-label="Camera username" autocomplete="off" />
              <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore [(ngModel)]="password" placeholder="Camera password" aria-label="Camera password" (keyup.enter)="add()" />
              <div class="wide">
                <button class="btn-sm btn-primary" type="button" (click)="add()" [disabled]="busy() || (byRtsp() ? !rtspUrl.trim() : !host.trim())">
                  {{ busy() ? 'Connecting…' : 'Add camera' }}
                </button>
                <button class="btn-sm ghost" type="button" (click)="closeForm()" [disabled]="busy()">Cancel</button>
                <button class="link" type="button" (click)="byRtsp.set(!byRtsp())" [disabled]="busy()">
                  {{ byRtsp() ? 'Add by address and login instead' : 'No ONVIF? Add by RTSP address' }}
                </button>
              </div>
            </div>
            @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
          }
        </section>
      }
    }

    @if (live(); as c) {
      <app-live-view [apiBase]="'/api/ip-cameras/' + c.id" [name]="c.name" [canPan]="c.canPan" (closed)="live.set(null)" />
    }
  `,
})
export class IpCamerasComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly socket = inject(SocketService);
  private readonly cams = inject(CamerasStateService);

  /** The IP cameras in HomeHub, each time they're loaded, for the snapshot filter. */
  readonly camerasChange = output<IpCamera[]>();
  /** Which part to show: the cameras (Cameras tab), adding them (Setup tab), or nothing (Snapshots tab). */
  readonly view = input<'cameras' | 'setup' | 'none'>('cameras');
  /** The search and brand chosen on the Cameras tab. */
  readonly filter = input<CameraFilter>(NO_FILTER);
  readonly brandShown = brandShown;

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly info = signal<IpInfo | null>(null);
  /** The cameras the filter keeps, on the Cameras tab. */
  readonly shown = computed(() => (this.info()?.cameras ?? []).filter((c) => cameraMatches(this.filter(), 'ip', ipWords(c))));
  readonly formOpen = signal(false);
  readonly byRtsp = signal(false);
  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly found = signal<Found[]>([]);
  readonly busy = signal(false);
  readonly busyId = signal<number | null>(null);
  readonly editing = signal<number | null>(null);
  readonly confirmRemove = signal<number | null>(null);
  readonly live = signal<IpCamera | null>(null);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly cameraMsg = signal('');

  host = '';
  port: number | null = null;
  name = '';
  username = '';
  password = '';
  rtspUrl = '';
  editName = '';
  editUser = '';
  editPass = '';
  editQuality: 'main' | 'sub' = 'main';
  editMotion = true;

  private timer?: ReturnType<typeof setInterval>;
  private stopSnapshots?: () => void;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => { if (!document.hidden) this.load(); }, 30_000);
    this.stopSnapshots = this.socket.onCameraSnapshot((ev) => { if (ev.deviceId === null) this.load(); });
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.stopSnapshots?.();
  }

  private load(): void {
    this.http.get<IpInfo>('/api/ip-cameras').subscribe({
      next: (r) => { this.info.set(r); this.camerasChange.emit(r.cameras); },
      error: () => undefined,
    });
  }

  motionLabel(c: IpCamera): string {
    return ({
      watching: 'Watching', connecting: 'Connecting', error: 'Motion problem', off: 'Motion off',
      unsupported: 'No motion', standby: 'Standby',
    } as Record<MotionState, string>)[c.motionState];
  }

  openForm(): void {
    this.formOpen.set(true);
    this.show('');
  }

  closeForm(): void {
    this.formOpen.set(false);
    this.show('');
    this.found.set([]);
    this.searched.set(false);
    this.byRtsp.set(false);
    this.host = this.name = this.username = this.password = this.rtspUrl = '';
    this.port = null;
    this.show('');
  }

  search(): void {
    this.searching.set(true);
    this.http.post<Found[]>('/api/ip-cameras/discover', {}).subscribe({
      next: (list) => { this.searching.set(false); this.searched.set(true); this.found.set(list); },
      error: (err: HttpErrorResponse) => { this.searching.set(false); this.show(err.error?.error ?? 'The search didn\'t finish.', true); },
    });
  }

  pick(f: Found): void {
    this.byRtsp.set(false);
    this.host = f.host;
    this.port = f.port;
    if (!this.name && f.model) this.name = f.model;
  }

  add(): void {
    if (this.busy()) return;
    const body = this.byRtsp()
      ? { rtspUrl: this.rtspUrl.trim(), username: this.username.trim(), password: this.password, name: this.name.trim() || undefined }
      : { host: this.host.trim(), port: this.port ?? undefined, username: this.username.trim(), password: this.password, name: this.name.trim() || undefined };
    if (this.byRtsp() ? !body.rtspUrl : !(body as { host: string }).host) return;
    this.busy.set(true);
    this.show(this.byRtsp() ? '' : 'Connecting to the camera…');
    this.http.post<IpCamera>('/api/ip-cameras', body).subscribe({
      next: (cam) => {
        this.busy.set(false);
        this.closeForm();
        this.show(`Added ${cam.name}. It's on the Cameras tab.`);
        this.cameraMsg.set('');
        this.cams.load();   // Cameras stays in the menu even without the Wyze bridge
        this.load();
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Could not add the camera.', true); },
    });
  }

  startEdit(c: IpCamera): void {
    this.confirmRemove.set(null);
    this.editing.set(c.id);
    this.editName = c.name;
    this.editUser = c.username;
    this.editPass = '';
    this.editQuality = c.quality;
    this.editMotion = c.motion;
  }

  saveEdit(c: IpCamera): void {
    this.busyId.set(c.id);
    this.cameraMsg.set('');
    const body: Record<string, unknown> = { name: this.editName.trim(), username: this.editUser.trim() };
    if (this.editPass) body['password'] = this.editPass;
    if (c.hasSubStream) body['quality'] = this.editQuality;
    if (c.onvif) body['motion'] = this.editMotion;
    this.http.patch<IpCamera>(`/api/ip-cameras/${c.id}`, body).subscribe({
      next: () => { this.busyId.set(null); this.editing.set(null); this.load(); },
      error: (err: HttpErrorResponse) => { this.busyId.set(null); this.cameraMsg.set(err.error?.error ?? `Couldn't save ${c.name}.`); },
    });
  }

  remove(c: IpCamera): void {
    this.confirmRemove.set(null);
    this.busyId.set(c.id);
    this.http.delete(`/api/ip-cameras/${c.id}`).subscribe({
      next: () => { this.busyId.set(null); this.cams.load(); this.load(); },
      error: (err: HttpErrorResponse) => { this.busyId.set(null); this.cameraMsg.set(err.error?.error ?? `Couldn't remove ${c.name}.`); },
    });
  }

  snapshot(c: IpCamera): void {
    this.busyId.set(c.id);
    this.cameraMsg.set('');
    this.http.post(`/api/ip-cameras/${c.id}/snapshots`, {}).subscribe({
      next: () => { this.busyId.set(null); this.load(); },
      error: (err: HttpErrorResponse) => { this.busyId.set(null); this.cameraMsg.set(err.error?.error ?? `No picture from ${c.name}.`); },
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
