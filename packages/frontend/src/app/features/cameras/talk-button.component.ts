import { Component, OnDestroy, effect, input, output, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

/**
 * Where the microphone goes: a camera's speaker. `open` starts sending the track and
 * resolves once the camera can hear it; `close` stops and lets go of the connection.
 */
export interface TalkTarget {
  open(mic: MediaStreamTrack): Promise<void>;
  close(): void;
}

/** After this long without talking, the microphone and connection are let go, so the phone stops showing it in use. */
const IDLE_MS = 60_000;

/** What went wrong, in words for the person holding the button. */
export function talkError(err: unknown): string {
  if (err instanceof HttpErrorResponse) return err.error?.error ?? 'The camera didn\'t start talking. Try again.';
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow the microphone for HomeHub in this browser\'s settings, then try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'This device has no microphone.';
  if (name === 'NotReadableError') return 'Another app is using the microphone.';
  return (err as Error | null)?.message || 'The camera didn\'t start talking. Try again.';
}

/**
 * Hold to talk: while it's held, the microphone is heard at the camera. The first press
 * asks for the microphone and connects, which takes a moment; later presses are instant.
 * `talking` tells the live view to mute the camera's sound meanwhile, as a walkie-talkie
 * does, so the camera doesn't hear itself back.
 */
@Component({
  selector: 'app-talk-button',
  standalone: true,
  styles: [`
    :host { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; margin-top: 0.6rem; }
    button {
      min-width: 12rem; min-height: 3rem; padding: 0.6rem 1.4rem; border-radius: 999px;
      font-size: 1.05rem; font-weight: 700; color: #fff;
      background: rgba(255, 255, 255, 0.14); border: 1px solid rgba(255, 255, 255, 0.3);
      touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    }
    button.on { background: var(--red); border-color: var(--red); }
    button.wait { opacity: 0.8; }
    .msg { color: #fca5a5; font-size: 0.8rem; text-align: center; max-width: 32rem; line-height: 1.4; }
  `],
  template: `
    <button type="button" [class.on]="state() === 'talking'" [class.wait]="state() === 'connecting'"
            (pointerdown)="press($event)" (pointerup)="release()" (pointercancel)="release()" (lostpointercapture)="release()"
            (keydown.space)="key($event, true)" (keyup.space)="key($event, false)"
            (keydown.enter)="key($event, true)" (keyup.enter)="key($event, false)"
            (contextmenu)="$event.preventDefault()" [attr.aria-pressed]="state() === 'talking'">
      {{ state() === 'talking' ? '🎙 Talking… let go to listen' : state() === 'connecting' ? 'Connecting…' : '🎙 Hold to talk' }}
    </button>
    @if (error()) { <span class="msg" role="alert">{{ error() }}</span> }
  `,
})
export class TalkButtonComponent implements OnDestroy {
  readonly target = input.required<TalkTarget>();
  readonly talking = output<boolean>();

  readonly state = signal<'idle' | 'connecting' | 'talking'>('idle');
  readonly error = signal<string | null>(null);

  private mic: MediaStream | null = null;
  private opened: Promise<void> | null = null;
  private held = false;
  private idle?: ReturnType<typeof setTimeout>;

  constructor() {
    // A new live session, such as after Try again, starts afresh.
    let last: TalkTarget | null = null;
    effect(() => {
      const t = this.target();
      if (last && last !== t) untracked(() => this.hangUp(last!));
      last = t;
    });
  }

  ngOnDestroy(): void {
    this.hangUp(this.target());
  }

  press(e: PointerEvent): void {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    void this.start();
  }

  key(e: Event, down: boolean): void {
    e.preventDefault();
    if ((e as KeyboardEvent).repeat) return;
    if (down) void this.start(); else this.release();
  }

  async start(): Promise<void> {
    if (this.held) return;
    this.held = true;
    clearTimeout(this.idle);
    this.error.set(null);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.held = false;
      this.error.set('Talking needs HomeHub\'s https:// address, such as the Tailscale one: browsers only allow the microphone there.');
      return;
    }
    const target = this.target();
    if (!this.opened) {
      this.state.set('connecting');
      this.opened = (async () => {
        this.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        this.setMic(false);
        await target.open(this.mic.getAudioTracks()[0]);
      })();
      this.opened.catch(() => undefined);
    }
    try {
      await this.opened;
    } catch (err) {
      this.error.set(talkError(err));
      this.hangUp(target);
      this.held = false;
      return;
    }
    if (target !== this.target()) return;
    if (!this.held) { this.state.set('idle'); this.waitIdle(); return; }
    this.setMic(true);
    this.state.set('talking');
    this.talking.emit(true);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.state() === 'connecting') return; // start() finishes connecting, then goes idle
    this.setMic(false);
    if (this.state() === 'talking') this.talking.emit(false);
    this.state.set('idle');
    this.waitIdle();
  }

  private setMic(on: boolean): void {
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = on;
  }

  private waitIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.hangUp(this.target()), IDLE_MS);
  }

  /** Lets go of the microphone and the connection. */
  private hangUp(target: TalkTarget): void {
    clearTimeout(this.idle);
    const wasTalking = this.state() === 'talking';
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.opened = null;
    this.held = false;
    target.close();
    this.state.set('idle');
    if (wasTalking) this.talking.emit(false);
  }
}

/** Waits briefly for the browser to gather its addresses, since the offer is sent whole. */
export function gathered(pc: RTCPeerConnection, ms = 2_000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ms);
  });
}

/** Resolves when the connection is up, or rejects when it fails or takes too long. */
export function connected(pc: RTCPeerConnection, ms = 10_000): Promise<void> {
  if (pc.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('The camera didn\'t connect for talking. Try again.')); }, ms);
    const check = () => {
      if (pc.connectionState === 'connected') { cleanup(); resolve(); }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanup();
        reject(new Error('The connection to the camera failed. Try again.'));
      }
    };
    const cleanup = () => { clearTimeout(timer); pc.removeEventListener('connectionstatechange', check); };
    pc.addEventListener('connectionstatechange', check);
  });
}

/**
 * Talking through a camera behind one of HomeHub's go2rtcs (Wyze and IP cameras): its own
 * connection, carrying only sound. `post` sends the offer to the camera's talk
 * endpoint, such as /api/cameras/12/talk, and returns the answer.
 */
export function go2rtcTalk(post: (offer: string) => Promise<string>): TalkTarget {
  let pc: RTCPeerConnection | null = null;
  return {
    async open(mic) {
      pc?.close();
      const conn = new RTCPeerConnection();
      pc = conn;
      // Receiving the camera's sound too is what makes go2rtc treat this as a viewer; it isn't played.
      conn.addTransceiver('audio', { direction: 'recvonly' });
      conn.addTransceiver(mic, { direction: 'sendonly' });
      await conn.setLocalDescription(await conn.createOffer());
      await gathered(conn);
      const answer = await post(conn.localDescription!.sdp);
      if (pc !== conn) throw new Error('Stopped');
      await conn.setRemoteDescription({ type: 'answer', sdp: answer });
      await connected(conn);
    },
    close() {
      pc?.close();
      pc = null;
    },
  };
}
