import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, inject, input, output, signal, viewChild } from '@angular/core';
import Hls from 'hls.js';
import { AuthService } from '../../core/auth/auth.service';

/**
 * Live video from one camera, in a full-screen dialog. The stream is HLS,
 * relayed by HomeHub from the camera bridge, so it works over HomeHub's own
 * address and sign-in.
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
    .video-wrap { position: relative; background: #000; border-radius: 10px; overflow: hidden; aspect-ratio: 16 / 9; }
    video { width: 100%; height: 100%; display: block; background: #000; }
    .status {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: #cbd5e1; font-size: 0.9rem; text-align: center; padding: 1rem; pointer-events: none;
    }
  `],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="frame" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'Live view, ' + name()">
        <div class="bar">
          <span><span class="title">{{ name() }}</span>@if (playing()) {<span class="live">LIVE</span>}</span>
          <button class="close" type="button" (click)="closed.emit()">Close</button>
        </div>
        <div class="video-wrap">
          <video #video playsinline muted autoplay controls></video>
          @if (!playing()) { <div class="status">{{ status() }}</div> }
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
  readonly playing = signal(false);
  readonly status = signal('Connecting…');
  private hls?: Hls;
  private retries = 0;

  ngAfterViewInit(): void {
    const el = this.video().nativeElement;
    const src = `/api/cameras/${this.deviceId()}/hls/index.m3u8`;
    el.addEventListener('playing', () => this.playing.set(true));
    el.addEventListener('waiting', () => this.playing.set(false));

    if (!Hls.isSupported()) {
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
      this.status.set(code === 404 ? 'No live video from this camera. It may be paused or offline.' : 'Live video stopped. Close and try again.');
      this.playing.set(false);
    });
    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.retries = 0;
      el.play().catch(() => this.status.set('Tap play to start.'));
    });
    this.hls.loadSource(src);
    this.hls.attachMedia(el);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closed.emit();
  }

  ngOnDestroy(): void {
    this.hls?.destroy();
  }
}
