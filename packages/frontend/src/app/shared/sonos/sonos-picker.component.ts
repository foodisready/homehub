import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { type SonosChoice, type SonosLibrary, loadSonosLibrary } from './sonos-library';

/**
 * "Choose music" for a Sonos: the household's Sonos Favorites and Sonos playlists, and a Spotify
 * link to paste. Plays on the speaker's group. Used in a speaker's remote and on the Music page.
 */
@Component({
  selector: 'app-sonos-picker',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.5rem; }
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
    button:disabled { opacity: 0.5; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; }
    .note.err { color: #fbbf24; }
  `],
  template: `
    <button class="pick-toggle" type="button" [attr.aria-expanded]="open()" (click)="toggle()">{{ open() ? 'Close' : 'Choose music' }}</button>
    @if (open()) {
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
    @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
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
export class SonosPickerComponent {
  private readonly http = inject(HttpClient);
  readonly deviceId = input.required<number>();
  /** Something started: the speaker's remote, as the backend answered. */
  readonly started = output<unknown>();

  readonly open = signal(false);
  readonly library = signal<SonosLibrary | null>(null);
  readonly libraryError = signal('');
  readonly starting = signal<string | null>(null);
  readonly brokenArt = signal(new Set<string>());
  readonly busy = signal(false);
  readonly error = signal('');
  spotifyLink = '';

  toggle(): void {
    const open = !this.open();
    this.open.set(open);
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
    this.send({ choose: { id: c.id, title: c.title } }, () => undefined);
  }

  playSpotify(e: Event): void {
    e.preventDefault();
    const link = this.spotifyLink.trim();
    if (!link || this.busy()) return;
    this.send({ spotify: link }, () => { this.spotifyLink = ''; });
  }

  private send(body: Record<string, unknown>, done: () => void): void {
    this.busy.set(true);
    this.error.set('');
    this.http.post(`/api/sonos/${this.deviceId()}/remote`, body).subscribe({
      next: (remote) => { this.busy.set(false); this.starting.set(null); done(); this.open.set(false); this.started.emit(remote); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.starting.set(null);
        this.error.set(e.error?.error ?? 'The speaker didn’t do that. Try again.');
      },
    });
  }
}
