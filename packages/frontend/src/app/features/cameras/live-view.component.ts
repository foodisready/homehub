import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, inject, input, output, signal, viewChild } from '@angular/core';
import Hls from 'hls.js';
import { AuthService } from '../../core/auth/auth.service';

const MAX_ZOOM = 5;
const DOUBLE_TAP_MS = 300;

/**
 * Live video from one camera, in a full-screen dialog. The stream is HLS,
 * relayed by HomeHub from the camera bridge, so it works over HomeHub's own
 * address and sign-in.
 *
 * Zoom is digital, as in the Wyze app: pinch or double-tap on a phone,
 * scroll, double-click or + and − on a computer, and drag to look around
 * while zoomed. The browser's own video controls are replaced by HomeHub's,
 * since they would be magnified along with the picture.
 */
@Component({
  selector: 'app-live-view',
  standalone: true,
  styles: [`
    .backdrop {
      position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.88);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: max(1rem, env(safe-area-inset-top, 0px)) 1rem max(1rem, env(safe-area-inset-bottom, 0px));
    }
    .frame { width: min(100%, 1100px); }
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
          <div class="controls" (pointerdown)="$event.stopPropagation()" (dblclick)="$event.stopPropagation()">
            @if (zoom() > 1) { <span class="level">{{ zoom().toFixed(1) }}×</span> }
            <button type="button" (click)="zoomBy(1 / 1.5)" [disabled]="zoom() <= 1" aria-label="Zoom out">−</button>
            <button type="button" (click)="zoomBy(1.5)" [disabled]="zoom() >= maxZoom" aria-label="Zoom in">+</button>
            @if (zoom() > 1) { <button type="button" (click)="resetZoom()" aria-label="Reset zoom">1×</button> }
            <button type="button" (click)="toggleSound()" [attr.aria-label]="muted() ? 'Turn sound on' : 'Turn sound off'">{{ muted() ? '🔇' : '🔊' }}</button>
            <button type="button" (click)="toggleFullscreen()" aria-label="Full screen">⛶</button>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class LiveViewComponent implements AfterViewInit, OnDestroy {
  private readonly auth = inject(AuthService);

  readonly deviceId = input.required<number>();
  readonly name = input('');
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
    if (e.key === 'Escape') this.closed.emit();
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.5);
    else if (e.key === '-' || e.key === '_') this.zoomBy(1 / 1.5);
    else if (e.key === '0') this.resetZoom();
  }

  ngOnDestroy(): void {
    this.wrap().nativeElement.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.hls?.destroy();
  }
}
