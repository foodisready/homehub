import { Component, ElementRef, OnDestroy, OnInit, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';

interface LiveStart { sessionId: string; answer: string; maxSeconds: number }

/** Give up on connecting after this long. */
const CONNECT_TIMEOUT_MS = 20_000;
/** Wait at most this long for the browser to gather its network addresses before sending the offer. */
const GATHER_MS = 2_500;

/**
 * Live video from a Ring camera. HomeHub only passes the browser's WebRTC
 * offer to Ring and Ring's answer back: the video then goes straight from
 * Ring to this browser, not through HomeHub. Ring ends it after a few
 * minutes, as the Ring app does, and so does closing this.
 */
@Component({
  selector: 'app-ring-live',
  standalone: true,
  styles: [`
    .backdrop {
      position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.88);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: max(1rem, env(safe-area-inset-top, 0px)) 1rem max(1rem, env(safe-area-inset-bottom, 0px));
    }
    .frame { width: min(100%, 1100px, calc((100dvh - 6rem) * 16 / 9)); }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.6rem; color: #fff; }
    .title { font-weight: 700; }
    .live { font-size: 0.72rem; font-weight: 700; color: #fff; background: var(--red); border-radius: 4px; padding: 0.05rem 0.4rem; margin-left: 0.5rem; }
    .left { font-size: 0.75rem; color: #cbd5e1; margin-left: 0.5rem; font-variant-numeric: tabular-nums; }
    .close { background: rgba(255, 255, 255, 0.12); color: #fff; padding: 0.4rem 0.9rem; }
    .video-wrap { position: relative; background: #000; border-radius: 10px; overflow: hidden; aspect-ratio: 16 / 9; }
    .video-wrap:fullscreen { aspect-ratio: auto; width: 100vw; height: 100vh; border-radius: 0; }
    video { width: 100%; height: 100%; display: block; background: #000; object-fit: contain; }
    .status {
      position: absolute; inset: 0; display: flex; flex-direction: column; gap: 0.6rem; align-items: center; justify-content: center;
      color: #cbd5e1; font-size: 0.9rem; text-align: center; padding: 1rem; line-height: 1.5;
    }
    .status.err { color: #fca5a5; }
    .controls { position: absolute; right: 0.5rem; bottom: 0.5rem; display: flex; gap: 0.35rem; }
    .controls button {
      min-width: 2.25rem; height: 2.25rem; padding: 0 0.6rem; border-radius: 999px; font-size: 0.95rem; font-weight: 700;
      background: rgba(15, 23, 42, 0.72); color: #fff; border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .note { color: #94a3b8; font-size: 0.78rem; margin-top: 0.5rem; text-align: center; }
  `],
  template: `
    <div class="backdrop" (click)="close()">
      <div class="frame" (click)="$event.stopPropagation()" role="dialog" [attr.aria-label]="'Live view, ' + name()">
        <div class="bar">
          <span>
            <span class="title">{{ name() }}</span>
            @if (state() === 'live') { <span class="live">LIVE</span><span class="left">{{ left() }}</span> }
          </span>
          <button class="close" type="button" (click)="close()">Close</button>
        </div>
        <div #wrap class="video-wrap">
          <video #video playsinline autoplay [muted]="muted()"></video>
          @if (state() !== 'live') {
            <div class="status" [class.err]="state() === 'failed'" role="status">
              <span>{{ message() }}</span>
              @if (state() === 'failed' || state() === 'ended') { <button class="close" type="button" (click)="start()">Try again</button> }
            </div>
          }
          @if (state() === 'live') {
            <div class="controls">
              <button type="button" (click)="muted.set(!muted())" [attr.aria-label]="muted() ? 'Turn sound on' : 'Turn sound off'">{{ muted() ? '🔇' : '🔊' }}</button>
              <button type="button" (click)="fullscreen()" aria-label="Full screen">⛶</button>
            </div>
          }
        </div>
        <p class="note">Video comes straight from Ring, a few seconds behind, and stops after {{ maxMinutes() }} minutes.</p>
      </div>
    </div>
  `,
})
export class RingLiveComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);

  readonly cameraId = input.required<number>();
  readonly name = input.required<string>();
  readonly closed = output<void>();

  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private readonly wrap = viewChild.required<ElementRef<HTMLElement>>('wrap');

  readonly state = signal<'connecting' | 'live' | 'failed' | 'ended'>('connecting');
  readonly message = signal('Connecting to Ring…');
  readonly muted = signal(true);
  private readonly maxSeconds = signal(600);
  private readonly endsAt = signal(0);
  private readonly now = signal(Date.now());
  readonly maxMinutes = computed(() => Math.round(this.maxSeconds() / 60));
  readonly left = computed(() => {
    const s = Math.max(0, Math.ceil((this.endsAt() - this.now()) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tick?: ReturnType<typeof setInterval>;
  private attempt = 0;
  private readonly onPageHide = () => this.stop(true);

  ngOnInit(): void {
    window.addEventListener('pagehide', this.onPageHide);
    this.tick = setInterval(() => {
      this.now.set(Date.now());
      if (this.state() === 'live' && this.endsAt() && Date.now() >= this.endsAt()) this.finish('ended', 'Live view ended. Ring stops it after a few minutes.');
    }, 1000);
    void this.start();
  }

  ngOnDestroy(): void {
    window.removeEventListener('pagehide', this.onPageHide);
    clearInterval(this.tick);
    this.stop(true);
  }

  close(): void {
    this.stop(false);
    this.closed.emit();
  }

  async start(): Promise<void> {
    this.stop(false);
    const attempt = ++this.attempt;
    this.state.set('connecting');
    this.message.set('Connecting to Ring…');
    if (typeof RTCPeerConnection === 'undefined') {
      this.finish('failed', 'This browser can\'t show Ring live video.');
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (e) => {
      const v = this.video().nativeElement;
      if (v.srcObject !== e.streams[0]) v.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void v.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (attempt !== this.attempt) return;
      if (pc.connectionState === 'connected') {
        this.clearTimers();
        this.state.set('live');
      } else if (pc.connectionState === 'failed') {
        this.finish('failed', 'The video connection to Ring failed. Check this phone\'s internet connection, then try again.');
      } else if (pc.connectionState === 'disconnected' && this.state() === 'live') {
        this.finish('ended', 'Ring stopped sending video.');
      }
    };
    this.timers.push(setTimeout(() => {
      if (attempt === this.attempt && this.state() === 'connecting') this.finish('failed', 'Ring didn\'t start sending video. Try again in a moment.');
    }, CONNECT_TIMEOUT_MS));

    try {
      await pc.setLocalDescription(await pc.createOffer());
      await this.gathered(pc);
      if (attempt !== this.attempt) return;
      const res = await firstValueFrom(this.http.post<LiveStart>(`/api/ring/cameras/${this.cameraId()}/live`, { offer: pc.localDescription!.sdp }));
      if (attempt !== this.attempt) { this.endSession(res.sessionId, false); return; }
      this.sessionId = res.sessionId;
      this.maxSeconds.set(res.maxSeconds);
      this.endsAt.set(Date.now() + res.maxSeconds * 1000);
      await pc.setRemoteDescription({ type: 'answer', sdp: res.answer });
    } catch (err) {
      if (attempt !== this.attempt) return;
      const text = err instanceof HttpErrorResponse ? err.error?.error : null;
      this.finish('failed', text ?? 'Live video didn\'t start. Try again in a moment.');
    }
  }

  /** Ring needs the browser's addresses in the offer itself, so wait for them, briefly. */
  private gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (pc.iceGatheringState === 'complete') done(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(done, GATHER_MS);
    });
  }

  private finish(state: 'failed' | 'ended', message: string): void {
    this.stop(false);
    this.state.set(state);
    this.message.set(message);
  }

  /** Closes the connection and tells HomeHub to end Ring's session. */
  private stop(leaving: boolean): void {
    this.clearTimers();
    this.attempt++;
    this.pc?.close();
    this.pc = null;
    const v = this.video()?.nativeElement;
    if (v) v.srcObject = null;
    if (this.sessionId) this.endSession(this.sessionId, leaving);
    this.sessionId = null;
  }

  private endSession(id: string, leaving: boolean): void {
    if (leaving) {
      // The page is going away: keepalive lets the request finish anyway.
      const token = this.auth.accessToken();
      void fetch(`/api/ring/live/${id}`, { method: 'DELETE', keepalive: true, headers: token ? { Authorization: `Bearer ${token}` } : {} }).catch(() => undefined);
    } else {
      this.http.delete(`/api/ring/live/${id}`).subscribe({ error: () => undefined });
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  fullscreen(): void {
    const el = this.wrap().nativeElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => undefined);
  }
}
