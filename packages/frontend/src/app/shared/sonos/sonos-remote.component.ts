import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

export interface SonosRemote {
  playing: boolean;
  nowPlaying: { title: string | null; artist: string | null; album: string | null };
  volume: number;
  muted: boolean;
  groupedWith: string[];
}

/** One tap of − or +. Matches the backend. */
const STEP = 2;

/**
 * A Sonos speaker's remote, in its row on the dashboard: what's playing, play or pause, previous
 * and next, and its volume. Play and pause also follow the row's switch.
 */
@Component({
  selector: 'app-sonos-remote',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .r { display: flex; flex-direction: column; gap: 0.7rem; }
    .track { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
    .track b { font-size: 0.95rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track span { font-size: 0.8rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .transport { display: flex; align-items: center; gap: 0.6rem; }
    .round { width: 2.6rem; height: 2.6rem; padding: 0; font-size: 1rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; display: grid; place-items: center; }
    .round.main { width: 3rem; height: 3rem; background: var(--green); border-color: var(--green); color: #04140c; }
    .round svg { width: 1.1rem; height: 1.1rem; }
    .vol { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .vol .what { width: 3.6rem; font-size: 0.85rem; color: var(--text-muted); }
    .vol .value { min-width: 2.2rem; text-align: center; font-size: 1.3rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .step { width: 2.6rem; height: 2.6rem; padding: 0; font-size: 1.3rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; }
    .mute { font-size: 0.8rem; padding: 0.45rem 0.8rem; border-radius: var(--radius); background: var(--bg); border: 1px solid var(--border); color: var(--text); }
    .mute[aria-pressed="true"] { border-color: #fbbf24; color: #fbbf24; }
    button:disabled { opacity: 0.5; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; }
    .note.err { color: #fbbf24; }
  `],
  template: `
    <div class="r">
      @if (remote(); as s) {
        <div class="track" aria-live="polite">
          @if (s.nowPlaying.title) {
            <b>{{ s.nowPlaying.title }}</b>
            @if (subtitle(s); as sub) { <span>{{ sub }}</span> }
          } @else {
            <span>{{ s.playing ? 'Playing' : 'Nothing playing' }}</span>
          }
        </div>
        <div class="transport">
          <button class="round" type="button" [disabled]="busy()" (click)="press({ action: 'previous' })" aria-label="Previous">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
          </button>
          <button class="round main" type="button" [disabled]="busy()" (click)="press({ action: s.playing ? 'pause' : 'play' })" [attr.aria-label]="s.playing ? 'Pause' : 'Play'">
            @if (s.playing) { <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg> }
            @else { <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg> }
          </button>
          <button class="round" type="button" [disabled]="busy()" (click)="press({ action: 'next' })" aria-label="Next">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
          </button>
        </div>
        <div class="vol">
          <span class="what">Volume</span>
          <button class="step" type="button" [disabled]="busy()" (click)="press({ step: 'down' })" aria-label="Volume down">−</button>
          <span class="value">{{ s.volume }}</span>
          <button class="step" type="button" [disabled]="busy()" (click)="press({ step: 'up' })" aria-label="Volume up">+</button>
          <button class="mute" type="button" [attr.aria-pressed]="s.muted" [disabled]="busy()" (click)="press({ mute: !s.muted })">{{ s.muted ? 'Muted' : 'Mute' }}</button>
        </div>
        @if (s.groupedWith.length) { <p class="note">Playing together with {{ join(s.groupedWith) }}: play, pause and skip are for all of them. The volume is this speaker's.</p> }
      } @else if (!error()) {
        <p class="note">Checking the speaker…</p>
      }
      @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
    </div>
  `,
})
export class SonosRemoteComponent {
  private readonly http = inject(HttpClient);
  readonly deviceId = input.required<number>();
  /** The row's on/off (playing): the remote reloads when it changes. */
  readonly playing = input(false);

  readonly remote = signal<SonosRemote | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    effect(() => {
      this.playing();
      const id = this.deviceId();
      untracked(() => this.load(id));
    });
  }

  subtitle(s: SonosRemote): string {
    return [s.nowPlaying.artist, s.nowPlaying.album].filter(Boolean).join(' · ');
  }

  join(names: string[]): string {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }

  private load(id: number): void {
    this.http.get<SonosRemote>(`/api/sonos/${id}/remote`).subscribe({
      next: (r) => { this.remote.set(r); this.error.set(''); },
      error: (e: HttpErrorResponse) => this.error.set(e.error?.error ?? 'Couldn’t reach the speaker.'),
    });
  }

  press(body: Record<string, unknown>): void {
    this.busy.set(true);
    const r = this.remote();
    // − and + show at once; the speaker's answer then says where it really is.
    if (r && body['step']) this.remote.set({ ...r, volume: Math.max(0, Math.min(100, r.volume + (body['step'] === 'up' ? STEP : -STEP))) });
    this.http.post<SonosRemote>(`/api/sonos/${this.deviceId()}/remote`, body).subscribe({
      next: (next) => { this.busy.set(false); this.remote.set(next); this.error.set(''); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? 'The speaker didn’t do that. Try again.');
        this.load(this.deviceId());
      },
    });
  }
}
