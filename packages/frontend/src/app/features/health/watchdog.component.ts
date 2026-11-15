import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import type { Observable } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';

interface WatchdogStatus { url: string | null; lastAt: string | null; lastOk: boolean | null; lastError: string | null; failingSince: string | null }

/**
 * Setting up an outside watchdog: a free service that expects HomeHub to check in every few
 * minutes and emails the family when it stops, because a HomeHub that's down can't say so itself.
 */
@Component({
  selector: 'app-watchdog',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .back { color: var(--text-muted); font-size: 0.9rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin: 0.6rem 0 0.3rem; }
    .lead { color: var(--text-muted); margin: 0 0 1.2rem; max-width: 44rem; line-height: 1.5; }
    .card { padding: 1.1rem 1.25rem; max-width: 44rem; }
    .card + .card { margin-top: 1rem; }
    h2 { font-size: 1rem; margin: 0 0 0.6rem; }
    ol { margin: 0; padding-left: 1.2rem; line-height: 1.7; font-size: 0.92rem; }
    ol a { color: var(--accent); }
    code { font-size: 0.85em; background: var(--bg); padding: 0.05rem 0.3rem; border-radius: 4px; }
    label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.35rem; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .row input { flex: 1 1 18rem; min-width: 0; }
    .acts { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.8rem; align-items: center; }
    .status { margin-top: 0.9rem; font-size: 0.9rem; display: flex; gap: 0.5rem; align-items: flex-start; }
    .dot { flex: none; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-top: 0.4rem; background: var(--border); }
    .dot.ok { background: var(--green); }
    .dot.bad { background: var(--red); }
    .err { color: var(--red); font-size: 0.85rem; margin-top: 0.5rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; line-height: 1.5; }
    .acts button { min-height: 38px; padding: 0 1rem; }
  `],
  template: `
    <div class="page">
      <a class="back" routerLink="/health">‹ Health</a>
      <h1>Outside watchdog</h1>
      <p class="lead">If HomeHub stops (the power goes off, the computer crashes, or the Wi-Fi drops), it can’t tell anyone, and a missed check-in would go unnoticed. A watchdog is a free service outside the house: HomeHub checks in with it every 5 minutes, and it emails you when the check-ins stop. Only the check-in leaves the house, never any of your data.</p>

      @if (!admin()) {
        <p class="muted">An admin can set this up.</p>
      } @else {
        <div class="card">
          <h2>Set it up with healthchecks.io (free)</h2>
          <ol>
            <li>Sign up at <a href="https://healthchecks.io" target="_blank" rel="noopener">healthchecks.io</a>.</li>
            <li>Add a check named HomeHub. Set <b>Period</b> to 5 minutes and <b>Grace</b> to 10 minutes.</li>
            <li>Under <b>Integrations</b>, add the email address of each family member who should hear about it.</li>
            <li>Copy the check’s ping URL (it starts with <code>https://hc-ping.com/</code>) and paste it below.</li>
          </ol>
          <p class="muted" style="margin-top:0.6rem">Any service that takes a heartbeat URL works too, such as Uptime Kuma or Better Stack.</p>
        </div>

        <div class="card">
          <label for="wd-url">Ping URL</label>
          <div class="row">
            <input id="wd-url" type="url" [(ngModel)]="url" name="url" placeholder="https://hc-ping.com/…" autocomplete="off" spellcheck="false" />
          </div>
          <div class="acts">
            <button type="button" class="btn-primary btn-sm" (click)="save()" [disabled]="busy() || !url.trim() || url.trim() === status()?.url">Save and check in</button>
            @if (status()?.url) {
              <button type="button" class="btn-ghost btn-sm" (click)="test()" [disabled]="busy()">Check in now</button>
              <button type="button" class="btn-ghost btn-sm" (click)="remove()" [disabled]="busy()">Remove</button>
            }
          </div>
          @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
          @if (status(); as s) {
            @if (s.url) {
              <div class="status" aria-live="polite">
                <span class="dot" [class.ok]="s.lastOk === true" [class.bad]="s.lastOk === false"></span>
                <span>{{ statusText() }}</span>
              </div>
            }
          }
        </div>
      }
    </div>
  `,
})
export class WatchdogComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  readonly admin = computed(() => this.auth.user()?.role === 'admin');
  readonly status = signal<WatchdogStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  url = '';

  readonly statusText = computed(() => {
    const s = this.status();
    if (!s?.url) return '';
    if (s.lastOk === null) return 'Saved. HomeHub checks in every 5 minutes.';
    const when = s.lastAt ? new Date(s.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return s.lastOk
      ? `Checked in at ${when}. If HomeHub stops, the watchdog emails you within about 15 minutes.`
      : `The last check-in, at ${when}, didn’t work: ${s.lastError}.`;
  });

  ngOnInit(): void {
    if (!this.admin()) return;
    this.http.get<WatchdogStatus>('/api/system/watchdog').subscribe({
      next: (s) => { this.status.set(s); this.url = s.url ?? ''; },
      error: () => this.error.set('The watchdog setting couldn’t be loaded.'),
    });
  }

  save(): void { this.send(this.http.put<WatchdogStatus>('/api/system/watchdog', { url: this.url.trim() })); }
  test(): void { this.send(this.http.post<WatchdogStatus>('/api/system/watchdog/test', {})); }
  remove(): void {
    this.url = '';
    this.send(this.http.put<WatchdogStatus>('/api/system/watchdog', { url: null }));
  }

  private send(req: Observable<WatchdogStatus>): void {
    this.busy.set(true);
    this.error.set('');
    req.subscribe({
      next: (s) => { this.status.set(s); this.url = s.url ?? ''; this.busy.set(false); },
      error: (e: HttpErrorResponse) => { this.error.set(e.error?.error ?? 'That didn’t work. Try again.'); this.busy.set(false); },
    });
  }
}
