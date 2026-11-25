import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { type SonosChoice, type SonosLibrary, loadSonosLibrary } from './sonos-library';
import { SonosArtComponent } from './sonos-art.component';

/** Something that played recently, to play again. */
export interface RecentItem { key: string; kind: string; title: string; note: string | null; art: string | null }

/**
 * "Choose music" for a Sonos: the household's Sonos Favorites and Sonos playlists, and a Spotify
 * link to paste. Plays on the speaker's group. Used in a speaker's remote and on the Music page.
 */
@Component({
  selector: 'app-sonos-picker',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, SonosArtComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.5rem; min-width: 0; }
    .pick-toggle { align-self: flex-start; font-size: 0.85rem; padding: 0.45rem 0.9rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: var(--radius); }
    .pick { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
    .pick h4 { margin: 0.5rem 0 0.1rem; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .shelf { display: flex; gap: 0.6rem; overflow-x: auto; scroll-snap-type: x proximity; padding: 0.15rem 0 0.4rem; overscroll-behavior-x: contain; }
    .tile { flex: none; width: 6.4rem; scroll-snap-align: start; display: flex; flex-direction: column; gap: 0.3rem; padding: 0; text-align: left; background: none; border: 0; color: var(--text); }
    .tile app-sonos-art { width: 6.4rem; height: 6.4rem; border-radius: 8px; }
    .tile b { font-size: 0.8rem; font-weight: 500; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .tile small { font-size: 0.7rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tile:disabled { opacity: 0.5; }
    .spotify { display: flex; gap: 0.4rem; margin-top: 0.1rem; }
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
        @if (recent().length) {
          <h4 id="pick-recent">Recently played</h4>
          <div class="shelf" role="list" aria-labelledby="pick-recent">
            @for (r of recent(); track r.key) {
              <button class="tile" type="button" role="listitem" [disabled]="busy()" (click)="playRecent(r)">
                <app-sonos-art [deviceId]="deviceId()" [art]="r.art" />
                <b>{{ r.title }}</b><small>{{ starting() === r.key ? 'Starting…' : r.note ?? '' }}</small>
              </button>
            }
          </div>
        }
        @if (library(); as lib) {
          @if (lib.favorites.length) {
            <h4 id="pick-fav">Sonos Favorites</h4>
            <div class="shelf" role="list" aria-labelledby="pick-fav">
              @for (c of lib.favorites; track c.id) { <ng-container *ngTemplateOutlet="choiceTpl; context: { $implicit: c }" /> }
            </div>
          }
          @if (lib.playlists.length) {
            <h4 id="pick-lists">Sonos playlists</h4>
            <div class="shelf" role="list" aria-labelledby="pick-lists">
              @for (c of lib.playlists; track c.id) { <ng-container *ngTemplateOutlet="choiceTpl; context: { $implicit: c }" /> }
            </div>
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
      <button class="tile" type="button" role="listitem" [disabled]="busy()" (click)="choose(c)">
        <app-sonos-art [deviceId]="deviceId()" [art]="c.art" />
        <b>{{ c.title }}</b><small>{{ starting() === c.id ? 'Starting…' : c.note ?? (c.kind === 'playlist' ? 'Sonos playlist' : '') }}</small>
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
  readonly recent = signal<RecentItem[]>([]);
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
    this.http.get<RecentItem[]>('/api/sonos/recent').subscribe({ next: (r) => this.recent.set(r), error: () => this.recent.set([]) });
  }

  playRecent(r: RecentItem): void {
    this.starting.set(r.key);
    this.send({ recent: r.key }, () => undefined);
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
