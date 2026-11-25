import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { SonosArtComponent } from './sonos-art.component';

interface Song { n: number; title: string; artist: string | null; album: string | null; art: string | null }
interface QueuePage { total: number; start: number; songs: Song[]; current: number | null; shuffle: boolean; repeat: 'off' | 'all' | 'one' }

const REPEAT_NEXT = { off: 'all', all: 'one', one: 'off' } as const;
const REPEAT_WORD = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one song' } as const;

/**
 * A group's queue, like the Sonos app's list: each song's cover, title and artist, the one playing
 * marked; tap a song to play it. Shuffle and repeat. Read a page at a time, from the page playing.
 */
@Component({
  selector: 'app-sonos-queue',
  standalone: true,
  imports: [SonosArtComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
    .bar { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
    .bar button { font-size: 0.82rem; padding: 0.4rem 0.75rem; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); color: var(--text); display: inline-flex; align-items: center; gap: 0.35rem; }
    .bar button[aria-pressed="true"] { border-color: #c084fc; color: #e9d5ff; background: color-mix(in srgb, #c084fc 14%, var(--bg)); }
    .bar svg { width: 1rem; height: 1rem; }
    .list { display: flex; flex-direction: column; gap: 0.15rem; max-height: 26rem; overflow-y: auto; overscroll-behavior: contain; padding-right: 0.15rem; }
    .song { display: flex; align-items: center; gap: 0.65rem; width: 100%; padding: 0.35rem; text-align: left; background: none; border: 1px solid transparent; border-radius: var(--radius); color: var(--text); }
    .song.now { border-color: color-mix(in srgb, #c084fc 55%, transparent); background: color-mix(in srgb, #c084fc 10%, transparent); }
    .song app-sonos-art { width: 2.6rem; height: 2.6rem; }
    .song span { display: flex; flex-direction: column; min-width: 0; flex: 1; }
    .song b, .song small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .song b { font-size: 0.88rem; font-weight: 500; }
    .song.now b { color: #e9d5ff; }
    .song small { font-size: 0.75rem; color: var(--text-muted); }
    .song i { font-style: normal; font-size: 0.7rem; color: #d8b4fe; flex: none; }
    .page { align-self: center; font-size: 0.8rem; padding: 0.35rem 0.8rem; background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--radius); }
    button:disabled { opacity: 0.5; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; }
    .err { color: #fbbf24; }
  `],
  template: `
    @if (page(); as q) {
      <div class="bar">
        @if (q.total) {
          <button type="button" [attr.aria-expanded]="open()" (click)="toggle()">{{ open() ? 'Hide queue' : 'Queue · ' + q.total + (q.total === 1 ? ' song' : ' songs') }}</button>
        }
        <button type="button" [attr.aria-pressed]="q.shuffle" [disabled]="busy()" (click)="setMode({ shuffle: !q.shuffle })" aria-label="Shuffle">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>
          Shuffle
        </button>
        <button type="button" [attr.aria-pressed]="q.repeat !== 'off'" [disabled]="busy()" (click)="setMode({ repeat: next[q.repeat] })" [attr.aria-label]="word[q.repeat] + '. Tap to change.'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3" /></svg>
          {{ q.repeat === 'one' ? 'Repeat 1' : 'Repeat' }}
        </button>
      </div>
      @if (open() && q.total) {
        <div class="list" role="list" aria-label="Queue">
          @if (q.start > 1) { <button class="page" type="button" (click)="load(q.start - 1 - pageSize)">Earlier songs</button> }
          @for (s of q.songs; track s.n) {
            <button class="song" type="button" role="listitem" [class.now]="s.n === q.current" [attr.data-n]="s.n" [disabled]="busy()" (click)="playSong(s)"
                    [attr.aria-current]="s.n === q.current ? 'true' : null">
              <app-sonos-art [deviceId]="deviceId()" [art]="s.art" />
              <span><b>{{ s.title }}</b><small>{{ s.artist ?? s.album ?? '' }}</small></span>
              @if (s.n === q.current) { <i>Playing</i> } @else if (starting() === s.n) { <i>Starting…</i> }
            </button>
          }
          @if (q.start - 1 + q.songs.length < q.total) { <button class="page" type="button" (click)="load(q.start - 1 + pageSize)">Later songs</button> }
        </div>
        @if (q.current === null) { <p class="note">Not playing the queue now. Tap a song to play the queue from there.</p> }
      }
    }
    @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
  `,
})
export class SonosQueueComponent {
  private readonly http = inject(HttpClient);
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly deviceId = input.required<number>();
  /** What's playing, so the list follows a change of song. */
  readonly trackKey = input<string | null>(null);
  /** A song was started: the page may want to read the speakers again. */
  readonly changed = output<void>();

  readonly page = signal<QueuePage | null>(null);
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly starting = signal<number | null>(null);
  readonly error = signal('');
  readonly next = REPEAT_NEXT;
  readonly word = REPEAT_WORD;
  readonly pageSize = 50;
  /** The page asked for by hand, kept until the song changes. */
  private chosenStart: number | undefined;

  constructor() {
    effect(() => {
      this.trackKey();
      this.deviceId();
      untracked(() => { this.chosenStart = undefined; this.load(); });
    });
  }

  toggle(): void {
    const open = !this.open();
    this.open.set(open);
    if (open) { this.chosenStart = undefined; this.load(undefined, true); }
  }

  load(start?: number, scroll = false): void {
    if (start !== undefined) this.chosenStart = Math.max(0, start);
    const params: Record<string, string> = this.chosenStart !== undefined ? { start: String(this.chosenStart) } : {};
    this.http.get<QueuePage>(`/api/sonos/${this.deviceId()}/queue`, { params }).subscribe({
      next: (q) => {
        this.page.set(q);
        if (scroll && q.current) setTimeout(() => this.host.nativeElement.querySelector(`[data-n="${q.current}"]`)?.scrollIntoView({ block: 'center' }), 0);
      },
      error: () => undefined, // A speaker that doesn't answer: the card already says so.
    });
  }

  playSong(s: Song): void {
    this.starting.set(s.n);
    this.send({ track: s.n });
  }

  setMode(mode: { shuffle?: boolean; repeat?: 'off' | 'all' | 'one' }): void {
    const q = this.page();
    if (q) this.page.set({ ...q, ...mode });
    this.send(mode);
  }

  private send(body: Record<string, unknown>): void {
    this.busy.set(true);
    this.error.set('');
    this.http.post(`/api/sonos/${this.deviceId()}/remote`, body).subscribe({
      next: () => { this.busy.set(false); this.starting.set(null); this.load(); this.changed.emit(); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.starting.set(null);
        this.error.set(e.error?.error ?? 'The speaker didn’t do that. Try again.');
        this.load();
      },
    });
  }
}
