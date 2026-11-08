import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';
import { CamerasStateService } from '../../core/services/cameras-state.service';
import { AuthImgComponent } from './auth-img.component';
import { LiveViewComponent } from './live-view.component';
import { RingCamerasComponent, type RingCamera } from './ring-cameras.component';
import { IpCamerasComponent, type IpCamera } from './ip-cameras.component';
import { SnapshotSwiperComponent } from './snapshot-swiper.component';
import { MAX_SHARE, canShareFiles, shareOrSave, snapshotFileName } from './snapshot-share';

type BridgeState =
  | { state: 'not-configured' } | { state: 'off' } | { state: 'unreachable'; detail: string } | { state: 'signed-out' }
  | { state: 'starting' } | { state: 'sign-in-failed'; detail: string }
  | { state: 'unauthorized' } | { state: 'standby' } | { state: 'ready'; cameras: number };

interface Snapshot { id: number; deviceId: number | null; camera: string; cameraName: string; trigger: 'motion' | 'manual' | 'doorbell'; sizeBytes: number; takenAt: string }
interface Camera {
  deviceId: number; name: string; room: string | null; cam: string; model: string | null;
  /** A Pan camera, which live view can turn. */
  canPan: boolean;
  watching: boolean | null; online: boolean | null; streaming: boolean;
  /** Whether pictures actually arrive from the camera. */
  picture: 'ok' | 'failing' | 'unknown'; lastPictureAt: string | null; noPictureSince: string | null; noPictureHint: string | null;
  /** On a different network from HomeHub, so its video can't reach HomeHub. */
  otherNetwork?: boolean;
  lastMotionAt: string | null; latestSnapshot: Snapshot | null;
}
interface AccountCamera { cam: string; name: string; model: string | null; ip: string | null; mac: string | null; streaming: boolean; added: boolean }
interface Settings { enabled: boolean; motionSnapshots: boolean; notify: boolean; keepDays: number; cooldownSeconds: number }

const PAGE = 48;
type Tab = 'cameras' | 'snapshots' | 'setup';
const TABS: Tab[] = ['cameras', 'snapshots', 'setup'];
/** The newest snapshot this browser has seen on the Snapshots tab. */
const SEEN_KEY = 'homehub.cameras.seenSnapshot';

/**
 * The Cameras page, in three tabs:
 *  - Cameras: every camera, Wyze, Ring and IP, in one grid, with notes above
 *    when something needs attention.
 *  - Snapshots: the saved pictures, by day.
 *  - Setup (admin): each kind's account and adding cameras, then the motion
 *    and snapshot settings shared by all.
 * Wyze is handled here; Ring and IP cameras have their own components, told
 * which tab is showing.
 */
@Component({
  selector: 'app-cameras',
  standalone: true,
  imports: [FormsModule, AuthImgComponent, LiveViewComponent, RingCamerasComponent, IpCamerasComponent, SnapshotSwiperComponent],
  styleUrls: ['./camera-layout.css', './snapshot-viewer.css'],
  styles: [`
    h1 { font-size: 1.4rem; font-weight: 700; margin-bottom: 1rem; }
    .card { padding: 1rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; line-height: 1.5; }
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
    .pill.watching, .pill.ok { border-color: var(--green); color: #4ade80; }
    .pill.paused { border-color: #f59e0b; color: #fbbf24; }
    .pill.offline { border-color: var(--red); color: #f87171; }
    .pill.nopicture, .pill.othernet, .pill.warn { border-color: #f59e0b; color: #fbbf24; }
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
    .select-bar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin: -0.25rem 0 0.5rem; min-height: 2rem; }
    .select-bar .count { flex: 1; font-size: 0.85rem; color: var(--text-muted); }
    .shot.selected { outline: 3px solid var(--accent); outline-offset: -3px; }
    .shot .tick {
      position: absolute; top: 0.35rem; right: 0.35rem; width: 1.5rem; height: 1.5rem; border-radius: 999px;
      border: 2px solid #fff; background: rgba(0, 0, 0, 0.35); color: #fff; font-size: 0.85rem; font-weight: 700;
      display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }
    .shot.selected .tick { background: var(--accent); border-color: var(--accent); }
    .share-msg { font-size: 0.82rem; color: var(--text-muted); margin: 0 0 0.6rem; }


    .settings-row { display: flex; align-items: center; gap: 1rem; padding: 0.6rem 0; border-top: 1px solid var(--border); flex-wrap: wrap; }
    .settings-row:first-child { border-top: none; }
    .settings-row .label { flex: 1; min-width: 12rem; font-size: 0.9rem; }
    .settings-row .label small { display: block; color: var(--text-muted); font-size: 0.75rem; }
    .settings-row input[type=number] { width: 5.5rem; text-align: right; font-size: 0.9rem; padding: 0.35rem 0.5rem; }
    .settings-row input[type=checkbox] { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }

    .tabs { display: flex; gap: 0.25rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; overflow-x: auto; }
    .tab {
      background: none; border: none; border-bottom: 2px solid transparent; border-radius: 0; margin-bottom: -1px;
      padding: 0.55rem 0.9rem; color: var(--text-muted); font-size: 0.92rem; font-weight: 600; white-space: nowrap;
      display: inline-flex; align-items: center; gap: 0.4rem;
    }
    .tab:hover { color: var(--text); background: none; }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .tab .count { font-size: 0.7rem; font-weight: 700; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); }
    .tab .count.new { background: var(--accent); border-color: var(--accent); color: #fff; }

    .empty { padding: 2rem 1rem; text-align: center; border: 1px dashed var(--border); border-radius: var(--radius); }
    .empty .muted { margin: 0.4rem 0 0.8rem; }

    .stack { display: flex; flex-direction: column; gap: 0.85rem; }
  `],
  template: `
    <div class="page">
      <h1>Cameras</h1>

      @if (bridge(); as b) {
        @if (b.state === 'off') {
          <div class="card">
            <strong>Cameras are off</strong>
            <p class="muted" style="margin-top:0.4rem">They're hidden from the menu, and HomeHub isn't watching for motion.</p>
            @if (isAdmin()) {
              <button class="btn-sm btn-primary" type="button" style="margin-top:0.6rem" (click)="turnOn()" [disabled]="busy()">Turn on cameras</button>
            } @else {
              <p class="muted">An administrator can turn them on in Settings → Integrations.</p>
            }
            @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
          </div>
        } @else {
          <div class="tabs" role="tablist" aria-label="Cameras">
            <button class="tab" type="button" role="tab" [class.active]="tab() === 'cameras'" [attr.aria-selected]="tab() === 'cameras'" (click)="setTab('cameras')">
              Cameras @if (total()) { <span class="count">{{ total() }}</span> }
            </button>
            <button class="tab" type="button" role="tab" [class.active]="tab() === 'snapshots'" [attr.aria-selected]="tab() === 'snapshots'" (click)="setTab('snapshots')">
              Snapshots @if (newShots(); as n) { <span class="count new">{{ n }} new</span> }
            </button>
            @if (isAdmin()) {
              <button class="tab" type="button" role="tab" [class.active]="tab() === 'setup'" [attr.aria-selected]="tab() === 'setup'" (click)="setTab('setup')">Setup</button>
            }
          </div>

          <!-- Every camera, Wyze, Ring and IP, in one grid; on Setup, each kind's account and adding. -->
          <div [class]="tab() === 'setup' ? 'stack' : 'grid'">
            @if (tab() === 'cameras') {
              @switch (b.state) {
                @case ('standby') {
                  <div class="note info"><span>This HomeHub is a backup or development server, so it leaves Wyze cameras and Ring to the active one.</span></div>
                }
                @case ('starting') {
                  <div class="note info"><span>Signing in to Wyze. The camera bridge takes up to a minute to start.</span></div>
                }
                @case ('unreachable') {
                  @if (cameras().length) { <div class="note"><span>HomeHub can't reach the Wyze camera bridge. It can take a minute to start.</span></div> }
                }
                @case ('unauthorized') {
                  @if (cameras().length) {
                    <div class="note"><span>The Wyze camera bridge rejected HomeHub's key.</span>
                      @if (isAdmin()) { <button class="btn-sm ghost" type="button" (click)="setTab('setup')">Fix</button> }
                    </div>
                  }
                }
                @case ('sign-in-failed') {
                  <div class="note"><span>Wyze sign-in didn't work, so Wyze cameras aren't connected.</span>
                    @if (isAdmin()) { <button class="btn-sm ghost" type="button" (click)="setTab('setup')">Sign in</button> }
                  </div>
                }
              }
              @if (bridgeError()) { <div class="note"><span>{{ bridgeError() }}</span></div> }
              @if (b.state === 'ready' && isAdmin() && notAdded().length) {
                <div class="note info">
                  <span>{{ notAdded().length === 1 ? 'A camera on your Wyze account isn\\'t in HomeHub.' : notAdded().length + ' cameras on your Wyze account aren\\'t in HomeHub.' }}</span>
                  <button class="btn-sm ghost" type="button" (click)="setTab('setup')">Add</button>
                </div>
              }

              @for (c of cameras(); track c.deviceId) {
                <div class="card cam">
                  <app-auth-img [src]="'/api/cameras/' + c.deviceId + '/live.jpg?cached=1'" (result)="thumbResult(c, $event)" [refreshSeconds]="c.watching === false ? 0 : 20"
                                [alt]="c.name" [failedText]="c.watching === false ? 'Paused' : c.otherNetwork ? 'On another network' : c.streaming ? 'No picture right now' : 'Not connected to this camera yet'"
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
                    @if (statusOf(c) === 'othernet') {
                      <p class="hint">{{ c.noPictureHint }}</p>
                    } @else if (statusOf(c) === 'nopicture') {
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
              @if (cameraMsg()) { <p class="msg err span">{{ cameraMsg() }}</p> }
              @if (loaded() && !total()) {
                <div class="empty span">
                  <strong>No cameras yet</strong>
                  @if (isAdmin()) {
                    <p class="muted">Add Wyze, Ring, Reolink, Amcrest and other cameras on the Setup tab.</p>
                    <button class="btn-sm btn-primary" type="button" (click)="setTab('setup')">Set up cameras</button>
                  } @else {
                    <p class="muted">An administrator can add cameras.</p>
                  }
                </div>
              }
            } @else if (tab() === 'setup') {
              <section class="card source">
                <div class="source-head">
                  <strong>Wyze</strong>
                  <span class="pill" [class.ok]="b.state === 'ready'" [class.warn]="b.state === 'sign-in-failed' || b.state === 'unreachable' || b.state === 'unauthorized'">{{ wyzeLabel(b.state) }}</span>
                </div>
                @switch (b.state) {
                  @case ('not-configured') {
                    <p class="muted">
                      Wyze cameras need the camera bridge, which is left out of this HomeHub. To add it, remove
                      <code>HOMEHUB_CAMERA_BRIDGE=0</code> from HomeHub's <code>.env</code>, then run this in the <code>homehub</code> folder:
                    </p>
                    <pre class="cmd">docker compose -f docker-compose.yml up -d</pre>
                  }
                  @case ('unreachable') {
                    <p class="muted">HomeHub can't reach the camera bridge. Check that the <code>wyze-bridge</code> service is running. It can take a minute to start.</p>
                  }
                  @case ('unauthorized') {
                    <p class="muted">The camera bridge rejected HomeHub's key. HomeHub and the bridge normally share a key HomeHub makes itself. If you set <code>WYZE_BRIDGE_API_KEY</code> in <code>.env</code>, remove it or make sure both use the same value, then run <code>docker compose -f docker-compose.yml up -d</code>.</p>
                  }
                  @case ('starting') {
                    <p class="muted">The camera bridge is starting with your Wyze account. This takes up to a minute.</p>
                  }
                  @case ('sign-in-failed') {
                    <p class="msg err">{{ $any(b).detail }}</p>
                  }
                  @case ('standby') {
                    <p class="muted">
                      This HomeHub is a backup or development server, so its camera bridge waits and leaves the cameras to the active one.
                      It keeps your Wyze sign-in, and starts the cameras if it's made the active server in Settings → Preferences.
                    </p>
                  }
                  @case ('signed-out') {
                    @if (!wyzeFormOpen()) {
                      <p class="muted">Wyze cameras? Sign in and HomeHub shows them live, saves pictures when they see motion, and can pause them.</p>
                      <button class="btn-sm btn-primary" type="button" style="margin-top:0.6rem" (click)="wyzeFormOpen.set(true)">Sign in to Wyze</button>
                    }
                  }
                }
                @if (b.state === 'sign-in-failed' || (b.state === 'signed-out' && wyzeFormOpen())) {
                  <p class="muted">
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
                      @if (b.state === 'signed-out') {
                        <button class="btn-sm ghost" type="button" (click)="wyzeFormOpen.set(false)" [disabled]="busy()">Cancel</button>
                      }
                    </div>
                  </div>
                }
                @if (b.state === 'ready') {
                  @if (notAdded().length) {
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
                  } @else if (!cameras().length) {
                    <p class="muted">No cameras on your Wyze account.</p>
                  }
                  <div class="settings">
                    <div class="settings-row">
                      <span class="label">Wyze account<small>Signing out deletes your Wyze sign-in from HomeHub and stops the camera bridge</small></span>
                      @if (confirmSignOut()) {
                        <button class="btn-sm danger" type="button" (click)="signOut()" [disabled]="busy()">Sign out</button>
                        <button class="btn-sm ghost" type="button" (click)="confirmSignOut.set(false)">Cancel</button>
                      } @else {
                        <button class="btn-sm ghost" type="button" (click)="confirmSignOut.set(true)" [disabled]="busy()">Sign out of Wyze</button>
                      }
                    </div>
                  </div>
                }
                @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }
              </section>
            }

            <app-ring-cameras [view]="childView()" (openSetup)="setTab('setup')"
                              (openSnapshot)="openShot($any($event))" (camerasChange)="ringCams.set($event); ringLoaded.set(true)" />
            <app-ip-cameras [view]="childView()" (camerasChange)="ipCams.set($event); ipLoaded.set(true)" />

            @if (tab() === 'setup' && settings(); as st) {
              <section class="card source">
                <div class="source-head"><strong>Motion and snapshots</strong></div>
                <p class="muted">For every camera.</p>
                <div class="settings">
                  <div class="settings-row">
                    <span class="label">Save a snapshot on motion<small>When a camera reports motion. Wyze takes up to half a minute; Ring and IP cameras a few seconds</small></span>
                    <input type="checkbox" [checked]="st.motionSnapshots" (change)="saveSettings({ motionSnapshots: $any($event.target).checked })" aria-label="Save a snapshot on motion" />
                  </div>
                  <div class="settings-row">
                    <span class="label">Notify my phone<small>Sends a notification with each motion snapshot</small></span>
                    <input type="checkbox" [checked]="st.notify" (change)="saveSettings({ notify: $any($event.target).checked })" aria-label="Notify on motion" />
                  </div>
                  <div class="settings-row">
                    <span class="label">Wait between snapshots<small>From the same camera, so one visit doesn't fill the folder</small></span>
                    <span><input type="number" min="5" max="3600" [value]="st.cooldownSeconds" (change)="saveSettings({ cooldownSeconds: +$any($event.target).value })" aria-label="Seconds between snapshots" /> sec</span>
                  </div>
                  <div class="settings-row">
                    <span class="label">Keep snapshots for<small>Older ones are deleted automatically</small></span>
                    <span><input type="number" min="1" max="365" [value]="st.keepDays" (change)="saveSettings({ keepDays: +$any($event.target).value })" aria-label="Days to keep snapshots" /> days</span>
                  </div>
                  <div class="settings-row">
                    <span class="label">Cameras in HomeHub<small>Turn off to hide Cameras from the menu and stop watching for motion and doorbell presses</small></span>
                    <button class="btn-sm ghost" type="button" (click)="turnOff()" [disabled]="busy()">Turn off</button>
                  </div>
                </div>
                @if (settingsMsg()) { <p class="msg" [class.err]="settingsErr()" [class.ok]="!settingsErr()">{{ settingsMsg() }}</p> }
              </section>
            }
          </div>

          @if (tab() === 'snapshots') {
            @if (total() > 1) {
              <div class="chips" role="group" aria-label="Filter snapshots by camera">
                <button class="chip" type="button" [class.active]="filterId() === null && filterCamera() === null" (click)="setFilter(null)">All</button>
                @for (c of cameras(); track c.deviceId) {
                  <button class="chip" type="button" [class.active]="filterId() === c.deviceId" (click)="setFilter(c.deviceId)">{{ c.name }}</button>
                }
                @for (c of ringCams(); track c.id) {
                  <button class="chip" type="button" [class.active]="filterCamera() === c.key" (click)="setCameraFilter(c.key)">{{ c.label }}</button>
                }
                @for (c of ipCams(); track c.id) {
                  <button class="chip" type="button" [class.active]="filterCamera() === c.key" (click)="setCameraFilter(c.key)">{{ c.name }}</button>
                }
              </div>
            }
            @if (snapshots().length) {
              <div class="select-bar">
                @if (selecting()) {
                  <span class="count" aria-live="polite">{{ selected().size ? selected().size + ' selected' : 'Tap pictures to select them' }}</span>
                  <button class="btn-sm" type="button" (click)="shareSelected()" [disabled]="!selectedReady()">{{ shareWord }}</button>
                  <button class="btn-sm ghost" type="button" (click)="stopSelecting()">Cancel</button>
                } @else {
                  <span class="count"></span>
                  <button class="btn-sm ghost" type="button" (click)="selecting.set(true)">Select</button>
                }
              </div>
              @if (shareMsg() && !shot()) { <p class="share-msg" role="status">{{ shareMsg() }}</p> }
            } @else {
              <p class="muted">No snapshots yet. When a camera sees motion or the doorbell rings, a picture is saved here. Press Snapshot on a camera to save one yourself.</p>
            }
            @for (day of days(); track day.label) {
              <div class="day">{{ day.label }}</div>
              <div class="shots">
                @for (s of day.items; track s.id) {
                  <button class="shot" type="button" (click)="selecting() ? toggleSelect(s) : openShot(s)"
                          [class.selected]="selected().has(s.id)" [attr.aria-pressed]="selecting() ? selected().has(s.id) : null"
                          [attr.aria-label]="s.cameraName + ', ' + time(s.takenAt)">
                    <app-auth-img [src]="'/api/cameras/snapshots/' + s.id + '/image'" [alt]="s.cameraName" />
                    @if (selecting()) { <span class="tick" aria-hidden="true">{{ selected().has(s.id) ? '✓' : '' }}</span> }
                    <span class="shot-meta"><span>{{ s.cameraName }}</span><span>{{ time(s.takenAt) }}{{ triggerText(s) }}</span></span>
                  </button>
                }
              </div>
            }
            @if (hasMore()) {
              <div class="more"><button class="btn-sm ghost" type="button" (click)="loadMore()">Show older</button></div>
            }
          }
        }
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>

    @if (live(); as c) {
      <app-live-view [deviceId]="c.deviceId" [name]="c.name" [canPan]="c.canPan" [problem]="c.otherNetwork ? c.noPictureHint : null" (closed)="live.set(null)" />
    }

    @if (shot(); as s) {
      <div class="lightbox" (click)="closeShot()">
        <div class="lightbox-frame" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'Snapshot from ' + s.cameraName">
          <div class="lightbox-bar">
            <span><strong>{{ s.cameraName }}</strong> · {{ dateTime(s.takenAt) }}{{ triggerText(s) }}</span>
            <span class="lightbox-nav">
              <button class="btn-sm ghost" type="button" (click)="step(-1)" [disabled]="!canStep(-1)" aria-label="Newer">‹</button>
              <button class="btn-sm ghost" type="button" (click)="step(1)" [disabled]="!canStep(1)" aria-label="Older">›</button>
              <button class="btn-sm ghost" type="button" (click)="shareOne(s)" [disabled]="!ready()[s.id]">{{ shareWord }}</button>
              @if (isAdmin()) { <button class="btn-sm ghost" type="button" (click)="deleteShot(s)">Delete</button> }
              <button class="btn-sm ghost" type="button" (click)="closeShot()">Close</button>
            </span>
          </div>
          <!-- Swipe left for an older picture, right for a newer one. -->
          <app-snapshot-swiper [current]="urlOf(s)" [prev]="urlOf(neighbor(-1))" [next]="urlOf(neighbor(1))"
                               [canPrev]="canStep(-1)" [canNext]="canStep(1)" [alt]="s.cameraName" (step)="step($event)" />
          @if (position(); as pos) { <p class="swipe-hint">{{ pos }}</p> }
          @if (shareMsg()) { <p class="share-msg" role="status">{{ shareMsg() }}</p> }
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
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly requestedTab = signal<Tab>('cameras');
  /** The tab showing. Setup is for admins only. */
  readonly tab = computed<Tab>(() => (this.requestedTab() === 'setup' && !this.isAdmin() ? 'cameras' : this.requestedTab()));
  /** What the Ring and IP camera components show: they stay loaded on Snapshots, for its camera filter. */
  readonly childView = computed(() => (this.tab() === 'snapshots' ? 'none' : this.tab()) as 'cameras' | 'setup' | 'none');
  readonly wyzeFormOpen = signal(false);
  readonly total = computed(() => this.cameras().length + this.ringCams().length + this.ipCams().length);
  private readonly wyzeLoaded = signal(false);
  readonly ringLoaded = signal(false);
  readonly ipLoaded = signal(false);
  /** Every kind of camera has loaded, so "No cameras yet" is true. */
  readonly loaded = computed(() => this.wyzeLoaded() && this.ringLoaded() && this.ipLoaded());
  private readonly seenId = signal<number | null>(null);
  /** Snapshots saved since this browser last looked at the Snapshots tab. */
  readonly newShots = computed(() => {
    const seen = this.seenId();
    if (seen === null || this.tab() === 'snapshots' || this.filterId() !== null || this.filterCamera() !== null) return '';
    const n = this.snapshots().filter((s) => s.id > seen).length;
    return n === 0 ? '' : n >= PAGE ? `${PAGE}+` : String(n);
  });

  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly bridge = signal<BridgeState | null>(null);
  readonly cameras = signal<Camera[]>([]);
  readonly bridgeError = signal<string | null>(null);
  readonly account = signal<AccountCamera[]>([]);
  readonly notAdded = computed(() => this.account().filter((c) => !c.added));
  readonly snapshots = signal<Snapshot[]>([]);
  readonly hasMore = signal(false);
  readonly filterId = signal<number | null>(null);
  /** A filter by camera key, for Ring and IP cameras, which aren't devices. */
  readonly filterCamera = signal<string | null>(null);
  readonly ringCams = signal<RingCamera[]>([]);
  readonly ipCams = signal<IpCamera[]>([]);
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

  setTab(tab: Tab): void {
    this.requestedTab.set(tab);
    this.confirmPause.set(null);
    if (tab !== 'snapshots') this.stopSelecting();
    this.markSeen();
    // In the address, so Back and a reload keep the tab.
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: tab === 'cameras' ? null : tab }, replaceUrl: true });
  }

  wyzeLabel(state: BridgeState['state']): string {
    switch (state) {
      case 'ready': return this.cameras().length === 1 ? 'Signed in · 1 camera' : `Signed in · ${this.cameras().length} cameras`;
      case 'signed-out': return 'Not set up';
      case 'sign-in-failed': return 'Sign-in failed';
      case 'starting': return 'Signing in…';
      case 'unreachable': return 'Bridge not running';
      case 'unauthorized': return 'Bridge key mismatch';
      case 'not-configured': return 'Not installed';
      case 'standby': return 'Standby';
      default: return '';
    }
  }

  /** On the Snapshots tab, everything loaded counts as seen. */
  private markSeen(): void {
    if (this.tab() !== 'snapshots' || this.filterId() !== null || this.filterCamera() !== null) return;
    const newest = this.snapshots()[0]?.id;
    if (newest === undefined || (this.seenId() ?? 0) >= newest) return;
    this.seenId.set(newest);
    try { localStorage.setItem(SEEN_KEY, String(newest)); } catch { /* private window: forgets next time */ }
  }

  ngOnInit(): void {
    const asked = this.route.snapshot.queryParamMap.get('tab') as Tab | null;
    if (asked && TABS.includes(asked)) this.requestedTab.set(asked);
    try {
      const seen = Number(localStorage.getItem(SEEN_KEY));
      if (seen > 0) this.seenId.set(seen);
    } catch { /* no storage: nothing counts as new until the first look */ }
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
    for (const url of Object.values(this.shotUrls())) URL.revokeObjectURL(url);
    if (this.timer) clearInterval(this.timer);
    this.stopSnapshots?.();
    this.stopState?.();
  }

  private refresh(): void {
    this.http.get<BridgeState>('/api/cameras/bridge').subscribe({
      next: (b) => {
        this.bridge.set(b);
        if (this.isAdmin()) {
          // Ring cameras use these settings too, with or without the Wyze bridge.
          this.http.get<Settings>('/api/cameras/settings').subscribe((s) => this.settings.set(s));
          if (b.state === 'ready') {
            this.http.get<AccountCamera[]>('/api/cameras/bridge/cameras').subscribe({ next: (a) => this.account.set(a), error: () => undefined });
          }
        }
      },
      error: () => this.bridge.set({ state: 'unreachable', detail: '' }),
    });
    this.loadCameras();
  }

  private loadCameras(): void {
    this.http.get<{ bridgeError: string | null; cameras: Camera[] }>('/api/cameras').subscribe({
      next: (r) => { this.cameras.set(r.cameras); this.bridgeError.set(r.cameras.length ? r.bridgeError : null); this.wyzeLoaded.set(true); },
      error: () => this.wyzeLoaded.set(true),
    });
  }

  /** The snapshot filter, as query parameters. */
  private filterQuery(): string {
    const id = this.filterId();
    const cam = this.filterCamera();
    return id !== null ? `&deviceId=${id}` : cam !== null ? `&camera=${encodeURIComponent(cam)}` : '';
  }

  private loadSnapshots(): void {
    const q = `limit=${PAGE}${this.filterQuery()}`;
    this.http.get<Snapshot[]>(`/api/cameras/snapshots?${q}`).subscribe((list) => {
      this.snapshots.set(list);
      this.hasMore.set(list.length === PAGE);
      // The first time, what's already here isn't news.
      if (this.seenId() === null && !this.filterQuery()) this.seenId.set(list[0]?.id ?? 0);
      this.markSeen();
    });
  }

  private loadingMore = false;

  loadMore(then?: () => void): void {
    const list = this.snapshots();
    if (!list.length || this.loadingMore) return;
    this.loadingMore = true;
    const q = `limit=${PAGE}&before=${list[list.length - 1].id}${this.filterQuery()}`;
    this.http.get<Snapshot[]>(`/api/cameras/snapshots?${q}`).subscribe({
      next: (more) => {
        this.loadingMore = false;
        this.snapshots.update((l) => [...l, ...more]);
        this.hasMore.set(more.length === PAGE);
        then?.();
      },
      error: () => { this.loadingMore = false; },
    });
  }

  setFilter(id: number | null): void {
    this.filterId.set(id);
    this.filterCamera.set(null);
    this.stopSelecting();
    this.loadSnapshots();
  }

  setCameraFilter(key: string): void {
    this.filterId.set(null);
    this.filterCamera.set(key);
    this.stopSelecting();
    this.loadSnapshots();
  }

  triggerText(s: Snapshot): string {
    return s.trigger === 'motion' ? ' · motion' : s.trigger === 'doorbell' ? ' · doorbell' : '';
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
        this.show('Signed in.');
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

  openShot(s: Snapshot): void {
    this.shareMsg.set('');
    this.showShot(s);
  }

  closeShot(): void {
    this.shot.set(null);
    this.shareMsg.set('');
  }

  /** Shows a snapshot, and loads the ones either side so a swipe shows them at once. */
  private showShot(s: Snapshot | null): void {
    this.shot.set(s);
    if (!s) return;
    this.prepare(s);
    // Two each way, so quick swipes don't wait.
    const list = this.snapshots();
    const i = list.findIndex((x) => x.id === s.id);
    if (i < 0) return;
    for (const j of [i - 1, i + 1, i - 2, i + 2]) if (list[j]) this.prepare(list[j]);
  }

  /** A loaded picture's URL, for the viewer. */
  urlOf(s: Snapshot | null): string | null {
    return s ? this.shotUrls()[s.id] ?? null : null;
  }

  /** On a computer: ← and → move between pictures, Esc closes. */
  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (!this.shot() || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); this.step(1); }
    else if (e.key === 'Escape') this.closeShot();
  }

  /** "3 of 48", or "3 of 48+" while older ones are still to load. */
  readonly position = computed(() => {
    const s = this.shot();
    const list = this.snapshots();
    const i = s ? list.findIndex((x) => x.id === s.id) : -1;
    return i < 0 || list.length < 2 ? '' : `${i + 1} of ${list.length}${this.hasMore() ? '+' : ''}`;
  });

  // ── Sharing ───────────────────────────────────────────────────

  /** "Share" where the phone can share pictures; "Save" where it can only download them. */
  readonly shareWord = canShareFiles() ? 'Share' : 'Save';
  readonly selecting = signal(false);
  readonly selected = signal<Set<number>>(new Set());
  readonly shareMsg = signal('');
  /** Pictures loaded and ready to share, by snapshot id. */
  readonly ready = signal<Record<number, File>>({});
  private readonly loading = new Set<number>();
  /** The loaded pictures, to show in the viewer without loading them again. */
  readonly shotUrls = signal<Record<number, string>>({});
  readonly selectedReady = computed(() => {
    const ids = [...this.selected()];
    return ids.length > 0 && ids.every((id) => !!this.ready()[id]);
  });

  /** Loads a picture ahead of a tap on Share: browsers share only straight from the tap. */
  private prepare(s: Snapshot): void {
    if (this.ready()[s.id] || this.loading.has(s.id)) return;
    this.loading.add(s.id);
    this.http.get(`/api/cameras/snapshots/${s.id}/image`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        this.loading.delete(s.id);
        const file = new File([blob], snapshotFileName(s.cameraName, s.takenAt), { type: 'image/jpeg', lastModified: Date.parse(s.takenAt) });
        this.ready.update((m) => ({ ...m, [s.id]: file }));
        this.shotUrls.update((m) => ({ ...m, [s.id]: URL.createObjectURL(file) }));
      },
      error: () => { this.loading.delete(s.id); this.shareMsg.set('That picture couldn\'t be loaded.'); },
    });
  }

  toggleSelect(s: Snapshot): void {
    const next = new Set(this.selected());
    if (next.has(s.id)) next.delete(s.id);
    else if (next.size >= MAX_SHARE) { this.shareMsg.set(`Up to ${MAX_SHARE} pictures at a time.`); return; }
    else { next.add(s.id); this.prepare(s); }
    this.shareMsg.set('');
    this.selected.set(next);
  }

  stopSelecting(): void {
    this.selecting.set(false);
    this.selected.set(new Set());
    this.shareMsg.set('');
  }

  shareOne(s: Snapshot): void {
    const file = this.ready()[s.id];
    if (file) this.share([file], `${s.cameraName}, ${this.dateTime(s.takenAt)}`);
  }

  shareSelected(): void {
    const seen = new Map<string, number>();
    const files = [...this.selected()].map((id) => this.ready()[id]).filter((f): f is File => !!f).map((f) => {
      // Two pictures from one camera in the same second would share a name: number the repeats.
      const n = (seen.get(f.name) ?? 0) + 1;
      seen.set(f.name, n);
      return n === 1 ? f : new File([f], f.name.replace(/\.jpg$/, `-${n}.jpg`), { type: f.type, lastModified: f.lastModified });
    });
    if (files.length) this.share(files, files.length === 1 ? 'HomeHub snapshot' : `${files.length} HomeHub snapshots`, () => this.stopSelecting());
  }

  private share(files: File[], title: string, done?: () => void): void {
    this.shareMsg.set('');
    shareOrSave(files, title).then((result) => {
      if (result === 'cancelled') return;
      done?.();
      if (result === 'saved') {
        const n = files.length === 1 ? 'The picture was' : `The ${files.length} pictures were`;
        this.shareMsg.set(window.isSecureContext
          ? `${n} saved. This browser can't share pictures.`
          : `${n} saved. To share instead, open HomeHub at its secure (https) address, such as the one you use away from home.`);
      }
    }).catch(() => this.shareMsg.set('Sharing didn\'t work. Try again, or save the picture instead.'));
  }

  neighbor(dir: -1 | 1): Snapshot | null {
    const list = this.snapshots();
    const i = list.findIndex((s) => s.id === this.shot()?.id);
    return i < 0 ? null : list[i + dir] ?? null;
  }

  /** Whether there's a picture that way: older ones may still be on the server. */
  canStep(dir: -1 | 1): boolean {
    if (this.neighbor(dir)) return true;
    return dir === 1 && this.hasMore() && this.snapshots().some((x) => x.id === this.shot()?.id);
  }

  step(dir: -1 | 1): void {
    const next = this.neighbor(dir);
    if (next) { this.shareMsg.set(''); this.showShot(next); return; }
    // Past the oldest loaded picture: load older ones, then move on.
    if (dir === 1 && this.canStep(1) && !this.loadingMore) this.loadMore(() => { if (this.neighbor(1)) this.step(1); });
  }

  deleteShot(s: Snapshot): void {
    const next = this.neighbor(1) ?? this.neighbor(-1);
    this.http.delete(`/api/cameras/snapshots/${s.id}`).subscribe(() => {
      this.snapshots.update((l) => l.filter((x) => x.id !== s.id));
      this.showShot(next);
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
    // Pictures may come through anyway one day, as when the routers change: then it's watching.
    if (c.otherNetwork && c.picture !== 'ok' && this.thumbOk()[c.deviceId] !== true) return 'othernet';
    if (c.picture === 'failing') return 'nopicture';
    if (c.watching && (c.picture === 'ok' || this.thumbOk()[c.deviceId] === true)) return 'watching';
    return '';
  }

  statusLabel(c: Camera): string {
    return ({ offline: 'Offline', paused: 'Paused', watching: 'Watching', nopicture: 'No picture', othernet: 'Other network' } as Record<string, string>)[this.statusOf(c)] ?? 'Checking…';
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
