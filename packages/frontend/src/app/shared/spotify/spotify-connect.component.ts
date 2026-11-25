import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

export interface SpotifyStatus { setUp: boolean; connected: boolean; name: string | null; clientId?: string }

/**
 * Settings → Spotify: an administrator sets up the household's Spotify app once (its Client ID),
 * and each person connects their own Spotify account, to search and play from it on the Sonos.
 */
@Component({
  selector: 'app-spotify-connect',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.75rem; }
    p, li { margin: 0; font-size: 0.85rem; line-height: 1.45; }
    ol { margin: 0; padding-left: 1.2rem; display: flex; flex-direction: column; gap: 0.45rem; }
    .muted { color: var(--text-muted); font-size: 0.8rem; }
    .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .row input { flex: 1 1 14rem; min-width: 0; font-family: ui-monospace, monospace; font-size: 0.82rem; }
    code { font-size: 0.8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0.1rem 0.35rem; overflow-wrap: anywhere; }
    .linkish { background: none; border: 0; padding: 0; color: var(--accent); font-size: inherit; text-decoration: underline; }
    .err { color: var(--red); font-size: 0.82rem; }
    .ok { color: #4ade80; font-size: 0.82rem; }
    h4 { margin: 0.3rem 0 0; font-size: 0.85rem; }
  `],
  template: `
    @if (status(); as s) {
      @if (s.connected) {
        <p>Connected as <b>{{ s.name }}</b>. Search Spotify and your playlists, liked songs and albums under <b>Choose music</b> on a speaker.</p>
        <div class="row"><button type="button" class="linkish" [disabled]="busy()" (click)="disconnect()">Disconnect Spotify</button></div>
      } @else if (s.setUp) {
        <p>Connect your Spotify account to search Spotify and play your playlists, liked songs and albums on the speakers. Each person connects their own.</p>
        @if (https) {
          <div class="row"><button type="button" class="btn-primary" [disabled]="busy()" (click)="connect()">Connect Spotify</button></div>
        } @else {
          <p class="muted">Spotify only signs in on a secure address. Open HomeHub from its address starting with https:// (the Tailscale one), then connect here.</p>
        }
      } @else {
        <p>Spotify isn’t set up on this HomeHub yet.{{ s.clientId === undefined ? ' An administrator sets it up here.' : '' }}</p>
      }

      @if (s.clientId !== undefined) {
        <h4>Set up (administrators)</h4>
        @if (!s.clientId) {
          <ol>
            <li>Sign in at <b>developer.spotify.com/dashboard</b> with the household’s Spotify account. It needs Spotify Premium.</li>
            <li>Select <b>Create app</b>. Give it any name, such as “HomeHub”, and tick <b>Web API</b>. Accepting Spotify’s developer terms is up to you.</li>
            <li>As its <b>Redirect URI</b>, add exactly:
              @if (redirect) { <code>{{ redirect }}</code> <button type="button" class="linkish" (click)="copy(redirect)">Copy</button> }
              @else { the address shown here once you open HomeHub from its https:// address. }
            </li>
            <li>In the app’s <b>User Management</b>, add each person who will connect, by the email of their Spotify account (up to 5).</li>
            <li>Copy the app’s <b>Client ID</b> into the box below and save.</li>
          </ol>
        } @else {
          <p class="muted">The Redirect URI registered in the Spotify app must be exactly <code>{{ redirect ?? '(open HomeHub from its https:// address to see it)' }}</code>. Add each person in the app’s User Management on developer.spotify.com (up to 5).</p>
        }
        <div class="row">
          <input type="text" [(ngModel)]="clientDraft" placeholder="Client ID (32 letters and numbers)" aria-label="Spotify Client ID" autocomplete="off" spellcheck="false" />
          <button type="button" [disabled]="busy() || clientDraft.trim() === s.clientId" (click)="saveClient()">Save</button>
        </div>
      }
    } @else {
      <p class="muted">Checking…</p>
    }
    @if (err()) { <p class="err" role="alert">{{ err() }}</p> }
    @if (msg()) { <p class="ok" role="status">{{ msg() }}</p> }
  `,
})
export class SpotifyConnectComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly status = signal<SpotifyStatus | null>(null);
  readonly busy = signal(false);
  readonly err = signal('');
  readonly msg = signal('');
  readonly https = location.protocol === 'https:' || location.hostname === '127.0.0.1';
  readonly redirect = this.https ? `${location.origin}/spotify-callback` : null;
  clientDraft = '';

  ngOnInit(): void { this.load(); }

  private load(): void {
    this.http.get<SpotifyStatus>('/api/spotify').subscribe({
      next: (s) => { this.status.set(s); this.clientDraft = s.clientId ?? ''; },
      error: () => this.err.set('Couldn’t check Spotify. Try again.'),
    });
  }

  connect(): void {
    this.busy.set(true); this.err.set('');
    this.http.post<{ url: string }>('/api/spotify/sign-in', { origin: location.origin }).subscribe({
      next: ({ url }) => { location.href = url; },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.err.set(e.error?.error ?? 'Couldn’t start the Spotify sign-in.'); },
    });
  }

  disconnect(): void {
    this.busy.set(true); this.err.set(''); this.msg.set('');
    this.http.delete<SpotifyStatus>('/api/spotify').subscribe({
      next: () => { this.busy.set(false); this.msg.set('Spotify disconnected.'); this.load(); },
      error: () => { this.busy.set(false); this.err.set('Couldn’t disconnect. Try again.'); },
    });
  }

  saveClient(): void {
    this.busy.set(true); this.err.set(''); this.msg.set('');
    this.http.put<SpotifyStatus>('/api/spotify/client', { clientId: this.clientDraft.trim() }).subscribe({
      next: (s) => { this.busy.set(false); this.status.set(s); this.msg.set(s.setUp ? 'Saved. Now connect your Spotify account.' : 'Removed.'); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.err.set(e.error?.error ?? 'Couldn’t save.'); },
    });
  }

  copy(text: string): void {
    navigator.clipboard?.writeText(text).then(() => this.msg.set('Copied.'), () => undefined);
  }
}
