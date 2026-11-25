import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

/**
 * Where Spotify sends someone back after they sign in (/spotify-callback): HomeHub finishes the
 * sign-in, then goes on to Music.
 */
@Component({
  selector: 'app-spotify-callback',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" style="max-width:32rem">
      <h1 style="font-size:1.3rem">Spotify</h1>
      @if (error()) {
        <p role="alert" style="color:var(--red)">{{ error() }}</p>
        <p><a routerLink="/settings">Back to Settings</a></p>
      } @else if (name()) {
        <p role="status">Connected as <b>{{ name() }}</b>. Opening Music…</p>
      } @else {
        <p>Finishing the Spotify sign-in…</p>
      }
    </div>
  `,
})
export class SpotifyCallbackComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly error = signal('');
  readonly name = signal('');

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const code = q.get('code');
    const state = q.get('state');
    if (q.get('error')) { this.error.set(q.get('error') === 'access_denied' ? 'Spotify wasn’t connected: the sign-in was cancelled.' : 'Spotify didn’t sign in. Try Connect Spotify again.'); return; }
    if (!code || !state) { this.error.set('This page is for finishing a Spotify sign-in.'); return; }
    this.http.post<{ name: string }>('/api/spotify/callback', { code, state }).subscribe({
      next: (r) => {
        this.name.set(r.name);
        // Keep the code out of the history, then go on.
        setTimeout(() => void this.router.navigate(['/music'], { replaceUrl: true }), 1200);
      },
      error: (e: HttpErrorResponse) => this.error.set(e.error?.error ?? 'Spotify didn’t sign in. Try Connect Spotify again.'),
    });
  }
}
