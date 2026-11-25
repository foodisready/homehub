import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { SonosArtComponent } from './sonos-art.component';

interface Item { uri: string; kind: 'track' | 'album' | 'playlist'; title: string; note: string | null; art: string | null }
interface Results { tracks: Item[]; albums: Item[]; playlists: Item[] }
interface Page { items: Item[]; total: number; offset: number }
type Shelf = 'playlists' | 'liked' | 'albums';

const SHELVES: { key: Shelf; label: string }[] = [
  { key: 'playlists', label: 'Your playlists' },
  { key: 'liked', label: 'Liked songs' },
  { key: 'albums', label: 'Saved albums' },
];

/**
 * Spotify in Choose music, for someone who connected their Spotify: search (songs, albums,
 * playlists), and their playlists, liked songs and saved albums. Choosing one asks the picker to
 * play its Spotify address on the speaker.
 */
@Component({
  selector: 'app-spotify-browse',
  standalone: true,
  imports: [FormsModule, RouterLink, SonosArtComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
    h4 { margin: 0.5rem 0 0.1rem; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
    h5 { margin: 0.35rem 0 0; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); }
    .search { display: flex; gap: 0.4rem; }
    .search input { flex: 1; min-width: 0; font-size: 0.88rem; }
    .search button { font-size: 0.85rem; padding: 0.45rem 0.9rem; }
    .shelf { display: flex; gap: 0.6rem; overflow-x: auto; scroll-snap-type: x proximity; padding: 0.15rem 0 0.4rem; overscroll-behavior-x: contain; }
    .tile { flex: none; width: 6.4rem; scroll-snap-align: start; display: flex; flex-direction: column; gap: 0.3rem; padding: 0; text-align: left; background: none; border: 0; color: var(--text); }
    .tile app-sonos-art { width: 6.4rem; height: 6.4rem; border-radius: 8px; }
    .tile b { font-size: 0.8rem; font-weight: 500; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .tile small { font-size: 0.7rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .more { flex: none; align-self: center; font-size: 0.78rem; padding: 0.4rem 0.7rem; background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); border-radius: var(--radius); }
    .tabs { display: flex; gap: 0.35rem; flex-wrap: wrap; }
    .tabs button { font-size: 0.8rem; padding: 0.35rem 0.7rem; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); }
    .tabs button[aria-pressed="true"] { border-color: #1ed760; color: #b9f6cf; }
    button:disabled { opacity: 0.5; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; }
    .err { color: #fbbf24; }
  `],
  template: `
    <h4>Spotify</h4>
    @if (connected() === false) {
      <p class="note">To search Spotify and play your playlists here, <a routerLink="/settings" [queryParams]="{ section: 'spotify' }">connect Spotify in Settings</a>.</p>
    } @else if (connected()) {
      <form class="search" role="search" (submit)="search($event)">
        <input type="search" name="q" [(ngModel)]="query" placeholder="Search Spotify" aria-label="Search Spotify" autocomplete="off" enterkeyhint="search" />
        <button type="submit" [disabled]="searching() || !query.trim()">Search</button>
      </form>
      @if (results(); as r) {
        @if (!r.tracks.length && !r.albums.length && !r.playlists.length) { <p class="note">Nothing found on Spotify.</p> }
        @if (r.tracks.length) { <h5>Songs</h5> <div class="shelf" role="list" aria-label="Songs">@for (i of r.tracks; track i.uri) { <ng-container *ngTemplateOutlet="tile; context: { $implicit: i }" /> }</div> }
        @if (r.albums.length) { <h5>Albums</h5> <div class="shelf" role="list" aria-label="Albums">@for (i of r.albums; track i.uri) { <ng-container *ngTemplateOutlet="tile; context: { $implicit: i }" /> }</div> }
        @if (r.playlists.length) { <h5>Playlists</h5> <div class="shelf" role="list" aria-label="Playlists">@for (i of r.playlists; track i.uri) { <ng-container *ngTemplateOutlet="tile; context: { $implicit: i }" /> }</div> }
      }
      <div class="tabs" role="group" aria-label="Your Spotify">
        @for (s of shelves; track s.key) { <button type="button" [attr.aria-pressed]="shelf() === s.key" (click)="openShelf(s.key)">{{ s.label }}</button> }
      </div>
      @if (shelf(); as key) {
        @if (page(); as p) {
          @if (!p.items.length) { <p class="note">Nothing here yet.</p> }
          <div class="shelf" role="list" [attr.aria-label]="label(key)">
            @for (i of p.items; track i.uri) { <ng-container *ngTemplateOutlet="tile; context: { $implicit: i }" /> }
            @if (p.offset + 50 < p.total) { <button class="more" type="button" (click)="loadShelf(key, p.offset + 50)">Next 50 ›</button> }
          </div>
          @if (p.offset > 0) { <button class="more" type="button" (click)="loadShelf(key, p.offset - 50)">‹ Previous 50</button> }
        } @else { <p class="note">Reading your Spotify…</p> }
      }
    }
    @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }

    <ng-template #tile let-i>
      <button class="tile" type="button" role="listitem" [disabled]="busy()" (click)="play.emit(i.uri)" [attr.aria-label]="i.title + (i.note ? ', ' + i.note : '')">
        <app-sonos-art [deviceId]="deviceId()" [art]="i.art" />
        <b>{{ i.title }}</b><small>{{ i.note ?? '' }}</small>
      </button>
    </ng-template>
  `,
})
export class SpotifyBrowseComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly deviceId = input.required<number>();
  /** The picker is starting something: tiles wait. */
  readonly busy = input(false);
  /** A Spotify address to play. */
  readonly play = output<string>();

  readonly connected = signal<boolean | null>(null);
  readonly results = signal<Results | null>(null);
  readonly searching = signal(false);
  readonly shelf = signal<Shelf | null>(null);
  readonly page = signal<Page | null>(null);
  readonly error = signal('');
  readonly shelves = SHELVES;
  query = '';

  ngOnInit(): void {
    this.http.get<{ connected: boolean }>('/api/spotify').subscribe({
      next: (s) => this.connected.set(s.connected),
      error: () => this.connected.set(false),
    });
  }

  label(key: Shelf): string { return SHELVES.find((s) => s.key === key)!.label; }

  search(e: Event): void {
    e.preventDefault();
    const q = this.query.trim();
    if (!q) return;
    this.searching.set(true); this.error.set('');
    this.http.get<Results>('/api/spotify/search', { params: { q } }).subscribe({
      next: (r) => { this.searching.set(false); this.results.set(r); },
      error: (err: HttpErrorResponse) => { this.searching.set(false); this.fail(err); },
    });
  }

  openShelf(key: Shelf): void {
    if (this.shelf() === key) { this.shelf.set(null); return; }
    this.shelf.set(key);
    this.loadShelf(key, 0);
  }

  loadShelf(key: Shelf, offset: number): void {
    this.page.set(null); this.error.set('');
    this.http.get<Page>(`/api/spotify/library/${key}`, { params: { offset } }).subscribe({
      next: (p) => { if (this.shelf() === key) this.page.set(p); },
      error: (err: HttpErrorResponse) => this.fail(err),
    });
  }

  private fail(err: HttpErrorResponse): void {
    if (err.error?.code === 'NOT_CONNECTED') this.connected.set(false);
    this.error.set(err.error?.error ?? 'Spotify didn’t answer. Try again.');
  }
}
