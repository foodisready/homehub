import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { type SonosChoice, type SonosLibrary, loadSonosLibrary } from './sonos-library';

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
 * and next, its volume, and music to choose: Sonos Favorites, Sonos playlists, or a Spotify link.
 * Play and pause also follow the row's switch.
 */
@Component({
  selector: 'app-sonos-remote',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
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
    .pick-toggle { align-self: flex-start; font-size: 0.85rem; padding: 0.45rem 0.9rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius); }
    .pick { display: flex; flex-direction: column; gap: 0.35rem; }
    .pick h4 { margin: 0.4rem 0 0.1rem; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .choice { display: flex; align-items: center; gap: 0.65rem; width: 100%; padding: 0.4rem; text-align: left; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius); }
    .choice .art { width: 2.4rem; height: 2.4rem; flex: none; border-radius: 4px; object-fit: cover; background: var(--border); display: grid; place-items: center; color: var(--text-muted); }
    .choice .art svg { width: 1.1rem; height: 1.1rem; }
    .choice span { display: flex; flex-direction: column; min-width: 0; }
    .choice b, .choice small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .choice b { font-size: 0.88rem; font-weight: 500; }
    .choice small { font-size: 0.75rem; color: var(--text-muted); }
    .spotify { display: flex; gap: 0.4rem; margin-top: 0.3rem; }
    .spotify input { flex: 1; min-width: 0; font-size: 0.85rem; }
    .spotify button { font-size: 0.85rem; padding: 0.45rem 0.9rem; }
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
        @if (s.groupedWith.length) { <p class="note">Playing together with {{ join(s.groupedWith) }}: play, pause, skip and what to play are for all of them. The volume is this speaker's.</p> }
        <button class="pick-toggle" type="button" [attr.aria-expanded]="picking()" (click)="togglePick()">{{ picking() ? 'Close' : 'Choose music' }}</button>
        @if (picking()) {
          <div class="pick">
            @if (library(); as lib) {
              @if (lib.favorites.length) {
                <h4>Sonos Favorites</h4>
                @for (c of lib.favorites; track c.id) { <ng-container *ngTemplateOutlet="choiceTpl; context: { $implicit: c }" /> }
              }
              @if (lib.playlists.length) {
                <h4>Sonos playlists</h4>
                @for (c of lib.playlists; track c.id) { <ng-container *ngTemplateOutlet="choiceTpl; context: { $implicit: c }" /> }
              }
              @if (!lib.favorites.length && !lib.playlists.length) {
                <p class="note">No Sonos Favorites yet. Add songs, stations or playlists to My Sonos in the Sonos app, and they show up here.</p>
              } @else if (lib.shortcuts) {
                <p class="note">{{ lib.shortcuts === 1 ? 'One favorite opens' : lib.shortcuts + ' favorites open' }} a list in the Sonos app, so {{ lib.shortcuts === 1 ? 'it isn’t' : 'they aren’t' }} here.</p>
              }
            } @else if (!libraryError()) {
              <p class="note">Reading your Sonos Favorites…</p>
            }
            @if (libraryError()) { <p class="note err">{{ libraryError() }}</p> }
            <h4>Spotify</h4>
            <form class="spotify" (submit)="playSpotify($event)">
              <input type="url" inputmode="url" name="spotify" [(ngModel)]="spotifyLink" placeholder="Paste a Spotify link" aria-label="Spotify link" autocomplete="off" />
              <button type="submit" [disabled]="busy() || !spotifyLink.trim()">Play</button>
            </form>
            <p class="note">In Spotify, tap Share, then Copy link, on a song, album or playlist. A song, album or playlist replaces what’s queued.</p>
          </div>
        }
      } @else if (!error()) {
        <p class="note">Checking the speaker…</p>
      }
      @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
    </div>
    <ng-template #choiceTpl let-c>
      <button class="choice" type="button" [disabled]="busy()" (click)="choose(c)">
        @if (c.art && !brokenArt().has(c.id)) {
          <img class="art" [src]="c.art" alt="" loading="lazy" referrerpolicy="no-referrer" (error)="artFailed(c.id)" />
        } @else {
          <i class="art"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 18V5l11-2v13a3 3 0 1 1-2-2.83V7.3l-7 1.27V18a3 3 0 1 1-2-2.83z" /></svg></i>
        }
        <span><b>{{ c.title }}</b><small>{{ starting() === c.id ? 'Starting…' : c.note ?? (c.kind === 'playlist' ? 'Sonos playlist' : '') }}</small></span>
      </button>
    </ng-template>
  `,
})
export class SonosRemoteComponent {
  private readonly http = inject(HttpClient);
  readonly deviceId = input.required<number>();
  /** The row's on/off (playing): the remote reloads when it changes. */
  readonly playing = input(false);

  readonly remote = signal<SonosRemote | null>(null);
  readonly picking = signal(false);
  readonly library = signal<SonosLibrary | null>(null);
  readonly libraryError = signal('');
  /** The choice being started, to say so on it. */
  readonly starting = signal<string | null>(null);
  readonly brokenArt = signal(new Set<string>());
  spotifyLink = '';
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

  /** Reads the speaker. After a failed button, the failure's message stays up. */
  private load(id: number, keepError = false): void {
    this.http.get<SonosRemote>(`/api/sonos/${id}/remote`).subscribe({
      next: (r) => { this.remote.set(r); if (!keepError) this.error.set(''); },
      error: (e: HttpErrorResponse) => this.error.set(e.error?.error ?? 'Couldn’t reach the speaker.'),
    });
  }

  togglePick(): void {
    const open = !this.picking();
    this.picking.set(open);
    if (!open) return;
    // Read afresh each time: favorites change in the Sonos app.
    this.libraryError.set('');
    loadSonosLibrary(this.http, this.deviceId()).subscribe({
      next: (lib) => this.library.set(lib),
      error: (e: HttpErrorResponse) => this.libraryError.set(e.error?.error ?? 'Couldn’t read your Sonos Favorites. Try again.'),
    });
  }

  artFailed(id: string): void {
    this.brokenArt.update((s) => new Set(s).add(id));
  }

  choose(c: SonosChoice): void {
    this.starting.set(c.id);
    this.press({ choose: { id: c.id, title: c.title } }, () => this.picking.set(false));
  }

  playSpotify(e: Event): void {
    e.preventDefault();
    const link = this.spotifyLink.trim();
    if (!link || this.busy()) return;
    this.press({ spotify: link }, () => { this.spotifyLink = ''; this.picking.set(false); });
  }

  press(body: Record<string, unknown>, done?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    const r = this.remote();
    // − and + show at once; the speaker's answer then says where it really is.
    if (r && body['step']) this.remote.set({ ...r, volume: Math.max(0, Math.min(100, r.volume + (body['step'] === 'up' ? STEP : -STEP))) });
    this.http.post<SonosRemote>(`/api/sonos/${this.deviceId()}/remote`, body).subscribe({
      next: (next) => { this.busy.set(false); this.starting.set(null); this.remote.set(next); this.error.set(''); done?.(); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.starting.set(null);
        this.error.set(e.error?.error ?? 'The speaker didn’t do that. Try again.');
        this.load(this.deviceId(), true);
      },
    });
  }
}
