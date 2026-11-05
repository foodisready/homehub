import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, inject, input, output, signal, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import Hls from 'hls.js';
import { AuthService } from '../../core/auth/auth.service';

const MAX_ZOOM = 5;
const DOUBLE_TAP_MS = 300;
/** While an arrow is held, how often HomeHub hears that it still is. Its safety stop waits 1.5 s. */
const TURN_REPEAT_MS = 500;
/** A tap turns the camera this long: a small nudge. */
const MIN_TURN_MS = 250;

type Turn = 'left' | 'right' | 'up' | 'down';
const ARROW_KEYS: Record<string, Turn> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

/**
 * Live video from one camera, in a full-screen dialog. The stream is HLS,
 * relayed by HomeHub from the camera bridge, so it works over HomeHub's own
 * address and sign-in.
 *
 * Zoom is digital, as in the Wyze app: pinch or double-tap on a phone,
 * scroll, double-click or + and − on a computer, and drag to look around
 * while zoomed. The browser's own video controls are replaced by HomeHub's,
 * since they would be magnified along with the picture.
 *
 * Pan cameras also get arrows to turn the camera itself: hold one (or an
 * arrow key) to keep turning, let go to stop; a tap is a small nudge.
 */
@Component({
  selector: 'app-live-view',
  standalone: true,
  imports: [NgTemplateOutlet],
  styles: [`
    .backdrop {
      position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.88);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: max(1rem, env(safe-area-inset-top, 0px)) 1rem max(1rem, env(safe-area-inset-bottom, 0px));
    }
    /* Wide enough to fill the screen, but never taller than it: a phone turned sideways is short. */
    .frame { width: min(100%, 1100px, calc((100dvh - 6rem) * 16 / 9)); }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.6rem; color: #fff; }
    .title { font-weight: 700; }
    .live { font-size: 0.72rem; font-weight: 700; color: #fff; background: var(--red); border-radius: 4px; padding: 0.05rem 0.4rem; margin-left: 0.5rem; }
    .close { background: rgba(255, 255, 255, 0.12); color: #fff; padding: 0.4rem 0.9rem; }
    .video-wrap {
      position: relative; background: #000; border-radius: 10px; overflow: hidden; aspect-ratio: 16 / 9;
      touch-action: none; user-select: none; -webkit-user-select: none;
    }
    .video-wrap.zoomed { cursor: grab; }
    .video-wrap.dragging { cursor: grabbing; }
    .video-wrap:fullscreen { aspect-ratio: auto; width: 100vw; height: 100vh; border-radius: 0; }
    .stage { width: 100%; height: 100%; transform-origin: 0 0; will-change: transform; }
    video { width: 100%; height: 100%; display: block; background: #000; object-fit: contain; pointer-events: none; }
    .status {
      position: absolute; inset: 0; display: flex; flex-direction: column; gap: 0.6rem; align-items: center; justify-content: center;
      color: #cbd5e1; font-size: 0.9rem; text-align: center; padding: 1rem; pointer-events: none;
    }
    .status button { pointer-events: auto; }
    .controls {
      position: absolute; right: 0.5rem; bottom: 0.5rem; display: flex; gap: 0.35rem; align-items: center;
    }
    .controls button {
      min-width: 2.25rem; height: 2.25rem; padding: 0 0.6rem; border-radius: 999px; font-size: 0.95rem; font-weight: 700;
      background: rgba(15, 23, 42, 0.72); color: #fff; border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .controls button:disabled { opacity: 0.4; }
    .pad {
      position: absolute; left: 0.5rem; bottom: 0.5rem; display: grid; gap: 0.2rem;
      grid-template-columns: repeat(3, 2.5rem); grid-template-rows: repeat(3, 2.5rem);
      grid-template-areas: ". up ." "left . right" ". down .";
    }
    .pad button {
      width: 2.5rem; height: 2.5rem; padding: 0; border-radius: 999px; font-size: 1rem; line-height: 1;
      background: rgba(15, 23, 42, 0.72); color: #fff; border: 1px solid rgba(255, 255, 255, 0.25);
      touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    }
    .pad button.on { background: var(--accent, #3b82f6); border-color: transparent; }
    /* A phone held upright: the arrows go under the picture, where there's room, and are bigger. */
    .pad.below { display: none; position: static; margin: 0.9rem auto 0; width: max-content;
      grid-template-columns: repeat(3, 3.25rem); grid-template-rows: repeat(3, 3.25rem); gap: 0.35rem; }
    .pad.below button { width: 3.25rem; height: 3.25rem; font-size: 1.2rem; background: rgba(255, 255, 255, 0.12); }
    @media (max-width: 700px) and (orientation: portrait) {
      .pad.below { display: grid; }
      .video-wrap:not(:fullscreen) .pad.over { display: none; }
    }
    .turn-error {
      position: absolute; left: 0.5rem; right: 0.5rem; top: 0.5rem; text-align: center; pointer-events: none;
      color: #fff; font-size: 0.8rem; background: rgba(127, 29, 29, 0.85); border-radius: 6px; padding: 0.3rem 0.5rem;
    }
    .level { font-size: 0.75rem; color: #fff; background: rgba(15, 23, 42, 0.72); border-radius: 999px; padding: 0.2rem 0.55rem; }
  `],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="frame" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'Live view, ' + name()">
        <div class="bar">
          <span><span class="title">{{ name() }}</span>@if (playing()) {<span class="live">LIVE</span>}</span>
          <button class="close" type="button" (click)="closed.emit()">Close</button>
        </div>
        <div #wrap class="video-wrap" [class.zoomed]="zoom() > 1" [class.dragging]="dragging()"
             (pointerdown)="onPointerDown($event)" (pointermove)="onPointerMove($event)"
             (pointerup)="onPointerUp($event)" (pointercancel)="onPointerUp($event)"
             (dblclick)="onDoubleClick($event)">
          <div class="stage" [style.transform]="transform()">
            <video #video playsinline muted autoplay></video>
          </div>
          @if (!playing()) {
            <div class="status">
              <span>{{ status() }}</span>
              @if (needsTap()) { <button class="close" type="button" (pointerdown)="$event.stopPropagation()" (click)="play()">Play</button> }
            </div>
          }
          @if (canPan()) {
            <div class="pad over" role="group" aria-label="Turn the camera" (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()">
              <ng-container [ngTemplateOutlet]="arrows" />
            </div>
          }
          @if (turnError()) { <div class="turn-error" role="alert">{{ turnError() }}</div> }
          <div class="controls" (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()">
            @if (zoom() > 1) { <span class="level">{{ zoom().toFixed(1) }}×</span> }
            <button type="button" (click)="zoomBy(1 / 1.5)" [disabled]="zoom() <= 1" aria-label="Zoom out">−</button>
            <button type="button" (click)="zoomBy(1.5)" [disabled]="zoom() >= maxZoom" aria-label="Zoom in">+</button>
            @if (zoom() > 1) { <button type="button" (click)="resetZoom()" aria-label="Reset zoom">1×</button> }
            <button type="button" (click)="toggleSound()" [attr.aria-label]="muted() ? 'Turn sound on' : 'Turn sound off'">{{ muted() ? '🔇' : '🔊' }}</button>
            <button type="button" (click)="toggleFullscreen()" aria-label="Full screen">⛶</button>
          </div>
        </div>
        @if (canPan()) {
          <div class="pad below" role="group" aria-label="Turn the camera">
            <ng-container [ngTemplateOutlet]="arrows" />
          </div>
        }
      </div>
    </div>
    <ng-template #arrows>
      @for (t of turns; track t.action) {
        <button type="button" [style.grid-area]="t.action" [class.on]="turning() === t.action" [attr.aria-label]="t.label"
                (pointerdown)="startTurn(t.action, $event)" (pointerup)="endTurn()" (pointercancel)="endTurn()"
                (lostpointercapture)="endTurn()" (contextmenu)="$event.preventDefault()"
                (keydown.enter)="nudge(t.action)" (keydown.space)="$event.preventDefault(); nudge(t.action)">{{ t.symbol }}</button>
      }
    </ng-template>
  `,
})
export class LiveViewComponent implements AfterViewInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  readonly deviceId = input.required<number>();
  readonly name = input('');
  /** A Pan camera, which HomeHub can turn. */
  readonly canPan = input(false);
  readonly closed = output<void>();

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly wrap = viewChild.required<ElementRef<HTMLDivElement>>('wrap');
  readonly playing = signal(false);
  readonly status = signal('Connecting…');
  readonly needsTap = signal(false);
  readonly muted = signal(true);
  readonly maxZoom = MAX_ZOOM;

  // Zoom: the picture is scaled by `zoom` and moved by (x, y) pixels, from its top-left corner.
  readonly zoom = signal(1);
  private x = 0;
  private y = 0;
  readonly transform = signal('none');
  readonly dragging = signal(false);
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { distance: number; midX: number; midY: number } | null = null;
  private lastTap: { at: number; x: number; y: number } | null = null;
  private moved = false;
  /** Touch screens also fire dblclick after a double tap, which is already handled. */
  private lastPointerType = 'mouse';

  // Turning a Pan camera.
  readonly turns: { action: Turn; symbol: string; label: string }[] = [
    { action: 'up', symbol: '▲', label: 'Turn up' }, { action: 'left', symbol: '◀', label: 'Turn left' },
    { action: 'right', symbol: '▶', label: 'Turn right' }, { action: 'down', symbol: '▼', label: 'Turn down' },
  ];
  readonly turning = signal<Turn | null>(null);
  readonly turnError = signal<string | null>(null);
  private turnStartedAt = 0;
  private turnRepeat?: ReturnType<typeof setInterval>;
  private pendingStop?: ReturnType<typeof setTimeout>;
  /** Commands go one after another, so a stop can't overtake the move before it. */
  private sending: Promise<void> = Promise.resolve();
  private inFlight = 0;
  private turnErrorTimer?: ReturnType<typeof setTimeout>;
  private readonly onBlur = () => this.endTurn(true);
  private readonly onHidden = () => { if (document.hidden) this.endTurn(true); };

  private hls?: Hls;
  private retries = 0;
  private readonly onWheel = (e: WheelEvent) => this.wheel(e);
  private readonly onFullscreen = () => this.resetZoom();

  ngAfterViewInit(): void {
    const el = this.video().nativeElement;
    // The template's `muted` attribute doesn't mute a video Angular creates; browsers only autoplay muted video.
    el.muted = true;
    const src = `/api/cameras/${this.deviceId()}/hls/index.m3u8`;
    el.addEventListener('playing', () => { this.playing.set(true); this.needsTap.set(false); });
    el.addEventListener('waiting', () => this.playing.set(false));
    // Not passive, so scrolling over the video zooms it instead of scrolling the page.
    this.wrap().nativeElement.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('fullscreenchange', this.onFullscreen);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onHidden);

    if (!Hls.isSupported()) {
      // Safari on iPhone plays HLS itself, without hls.js, but can't send the sign-in token.
      this.status.set('This browser can\'t play live video. Try Chrome, Safari or Firefox.');
      return;
    }
    this.hls = new Hls({
      lowLatencyMode: true,
      backBufferLength: 10,
      xhrSetup: (xhr) => {
        const token = this.auth.accessToken();
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      },
    });
    this.hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      const code = (data.response as { code?: number } | undefined)?.code;
      if (code === 401 && this.retries++ < 2) {
        // The sign-in token expired while watching: get a new one and carry on.
        this.auth.refresh().subscribe({ next: () => this.hls?.startLoad(), error: () => this.status.set('Sign in again to watch.') });
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && this.retries++ < 5) {
        this.status.set('Reconnecting…');
        setTimeout(() => this.hls?.startLoad(), 2000);
        return;
      }
      this.status.set(code === 404 ? 'No live video from this camera. It may be off, on another network, or still connecting.' : 'Live video stopped. Close and try again.');
      this.playing.set(false);
    });
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.retries = 0;
      this.play();
    });
    this.hls.loadSource(src);
    this.hls.attachMedia(el);
  }

  play(): void {
    this.video().nativeElement.play().then(() => this.needsTap.set(false)).catch(() => {
      this.status.set('Tap Play to start.');
      this.needsTap.set(true);
    });
  }

  toggleSound(): void {
    const el = this.video().nativeElement;
    el.muted = !el.muted;
    this.muted.set(el.muted);
    if (el.paused) this.play();
  }

  toggleFullscreen(): void {
    const wrap = this.wrap().nativeElement;
    const video = this.video().nativeElement as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => undefined); return; }
    if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
    else video.webkitEnterFullscreen?.();   // iPhone: only the video itself can go full screen
  }

  // ── Turning ───────────────────────────────────────────────────

  private send(action: Turn | 'stop'): Promise<void> {
    this.inFlight++;
    const run = async () => {
      try {
        await firstValueFrom(this.http.post(`/api/cameras/${this.deviceId()}/ptz`, { action }));
      } catch (err) {
        const e = err as HttpErrorResponse;
        if (action !== 'stop') this.endTurn(true, false);
        this.showTurnError(e.error?.error ?? 'The camera didn\'t turn.');
      } finally {
        this.inFlight--;
      }
    };
    this.sending = this.sending.then(run, run);
    return this.sending;
  }

  private showTurnError(msg: string): void {
    this.turnError.set(msg);
    clearTimeout(this.turnErrorTimer);
    this.turnErrorTimer = setTimeout(() => this.turnError.set(null), 5000);
  }

  /** Starts turning, until endTurn. */
  startTurn(action: Turn, e?: PointerEvent): void {
    if (e) {
      e.preventDefault();
      (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId);
    }
    clearTimeout(this.pendingStop);
    this.pendingStop = undefined;
    if (this.turning() === action) return;
    clearInterval(this.turnRepeat);
    this.turning.set(action);
    this.turnStartedAt = Date.now();
    this.turnError.set(null);
    this.send(action);
    // Still held: a repeat, unless the last one hasn't been answered yet.
    this.turnRepeat = setInterval(() => { if (this.inFlight === 0) this.send(action); }, TURN_REPEAT_MS);
  }

  /** Stops turning: at once, or after a tap's worth of turning. */
  endTurn(now = false, sendStop = true): void {
    if (!this.turning()) return;
    clearInterval(this.turnRepeat);
    this.turning.set(null);
    if (!sendStop) return;
    const wait = now ? 0 : Math.max(0, MIN_TURN_MS - (Date.now() - this.turnStartedAt));
    clearTimeout(this.pendingStop);
    if (wait === 0) { this.send('stop'); return; }
    this.pendingStop = setTimeout(() => { this.pendingStop = undefined; this.send('stop'); }, wait);
  }

  /** A keyboard press of an on-screen arrow: a small nudge. */
  nudge(action: Turn): void {
    this.startTurn(action);
    this.endTurn();
  }

  // ── Zoom ──────────────────────────────────────────────────────

  /** Zooms to `scale`, keeping the point (px, py) of the frame where it is. */
  private zoomTo(scale: number, px: number, py: number): void {
    const next = Math.min(MAX_ZOOM, Math.max(1, scale));
    const s = this.zoom();
    // The picture point under (px, py) stays under it.
    this.x = px - ((px - this.x) / s) * next;
    this.y = py - ((py - this.y) / s) * next;
    this.zoom.set(next);
    this.apply();
  }

  /** Keeps the picture covering the frame, then shows it. */
  private apply(): void {
    const { width, height } = this.wrap().nativeElement.getBoundingClientRect();
    const s = this.zoom();
    this.x = Math.min(0, Math.max(width * (1 - s), this.x));
    this.y = Math.min(0, Math.max(height * (1 - s), this.y));
    if (s === 1) { this.x = 0; this.y = 0; }
    this.transform.set(s === 1 ? 'none' : `translate(${this.x}px, ${this.y}px) scale(${s})`);
  }

  zoomBy(factor: number): void {
    const { width, height } = this.wrap().nativeElement.getBoundingClientRect();
    this.zoomTo(this.zoom() * factor, width / 2, height / 2);
  }

  resetZoom(): void {
    this.zoom.set(1);
    this.apply();
  }

  private point(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.wrap().nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.point(e);
    // A trackpad pinch arrives as a wheel with ctrlKey and small steps.
    const step = e.ctrlKey ? 0.01 : 0.0015;
    this.zoomTo(this.zoom() * Math.exp(-e.deltaY * step), p.x, p.y);
  }

  onPointerDown(e: PointerEvent): void {
    this.lastPointerType = e.pointerType;
    this.wrap().nativeElement.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.point(e));
    this.moved = false;
    if (this.pointers.size === 2) this.pinch = this.pinchOf();
    this.dragging.set(this.zoom() > 1 && this.pointers.size === 1);
  }

  onPointerMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const now = this.point(e);
    this.pointers.set(e.pointerId, now);
    if (Math.hypot(now.x - prev.x, now.y - prev.y) > 2) this.moved = true;
    if (this.pointers.size === 2 && this.pinch) {
      const next = this.pinchOf();
      // Follow the fingers: move with their midpoint, and zoom by how far apart they've gone.
      this.x += next.midX - this.pinch.midX;
      this.y += next.midY - this.pinch.midY;
      this.zoomTo(this.zoom() * (next.distance / this.pinch.distance), next.midX, next.midY);
      this.pinch = next;
    } else if (this.pointers.size === 1 && this.zoom() > 1) {
      this.x += now.x - prev.x;
      this.y += now.y - prev.y;
      this.apply();
    }
  }

  onPointerUp(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    this.dragging.set(false);
    // A double tap on a touch screen; a mouse gets dblclick instead.
    if (e.pointerType !== 'mouse' && p && !this.moved && this.pointers.size === 0) {
      const t = Date.now();
      if (this.lastTap && t - this.lastTap.at < DOUBLE_TAP_MS && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
        this.lastTap = null;
        this.toggleZoomAt(p.x, p.y);
      } else {
        this.lastTap = { at: t, x: p.x, y: p.y };
      }
    }
  }

  onDoubleClick(e: MouseEvent): void {
    if (this.lastPointerType !== 'mouse') return;
    const p = this.point(e);
    this.toggleZoomAt(p.x, p.y);
  }

  private toggleZoomAt(x: number, y: number): void {
    if (this.zoom() > 1) this.resetZoom();
    else this.zoomTo(2.5, x, y);
  }

  private pinchOf(): { distance: number; midX: number; midY: number } {
    const [a, b] = [...this.pointers.values()];
    return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    const turn = this.canPan() ? ARROW_KEYS[e.key] : undefined;
    if (turn) {
      e.preventDefault();
      if (!e.repeat) this.startTurn(turn);
      return;
    }
    if (e.key === 'Escape') this.closed.emit();
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.5);
    else if (e.key === '-' || e.key === '_') this.zoomBy(1 / 1.5);
    else if (e.key === '0') this.resetZoom();
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp(e: KeyboardEvent): void {
    const turn = this.canPan() ? ARROW_KEYS[e.key] : undefined;
    if (turn && this.turning() === turn) this.endTurn();
  }

  ngOnDestroy(): void {
    if (this.pendingStop) { clearTimeout(this.pendingStop); this.send('stop'); }
    this.endTurn(true);
    clearTimeout(this.turnErrorTimer);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onHidden);
    this.wrap().nativeElement.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.hls?.destroy();
  }
}
