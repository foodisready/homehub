import { Component, OnInit, inject, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { SecretInputDirective } from '../../shared/secret-input/secret-input.directive';

interface HoneywellStatus { email: string | null; signedIn: boolean; rejected: boolean; message: string | null }
interface AccountThermostat { deviceId: number; name: string; location: string; deviceIdInHomeHub: number | null; alias: string | null }
interface SignInResult extends HoneywellStatus { added: { id: number; alias: string }[]; thermostats: AccountThermostat[]; listError?: string }

/**
 * Settings → Integrations → Honeywell. Signs in to Total Connect Comfort, the service a
 * RedLINK Internet Gateway connects Honeywell thermostats to, and adds the thermostats.
 */
@Component({
  selector: 'app-honeywell-login',
  standalone: true,
  imports: [SecretInputDirective, FormsModule],
  styles: [`
    .head { display:flex; align-items:center; gap:1rem; padding:0.65rem 0; cursor:pointer; background:none; border:none;
            width:100%; text-align:left; color:var(--text); font:inherit; }
    .label { flex:1; font-size:0.9rem; }
    .sub { font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem; }
    .ok-badge { font-size:0.72rem; color:#4ade80; white-space:nowrap; }
    .warn-badge { font-size:0.72rem; color:#fbbf24; white-space:nowrap; }
    .chev { color:var(--text-muted); font-size:0.85rem; }
    .form { display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; margin-top:0.25rem; }
    .form input { font-size:0.85rem; padding:0.4rem 0.7rem; min-width:0; }
    .wide { grid-column:1 / -1; }
    .bar { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .note { font-size:0.75rem; color:var(--text-muted); line-height:1.4; margin:0; }
    .note.warn { color:#fbbf24; }
    .msg { font-size:0.82rem; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); }
    .list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:0.35rem; }
    .list li { display:flex; align-items:center; gap:0.6rem; font-size:0.85rem; }
    .list .name { flex:1; min-width:0; overflow-wrap:anywhere; }
    .list .meta { color:var(--text-muted); font-size:0.75rem; }
    @media (max-width: 480px) { .form { grid-template-columns:1fr; } }
  `],
  template: `
    <button type="button" class="head" (click)="toggle()" [attr.aria-expanded]="expanded()">
      <div class="label">
        Honeywell
        <div class="sub">For Honeywell thermostats with a RedLINK Internet Gateway. Sign in with your Total Connect Comfort account.</div>
      </div>
      @if (status()?.rejected) { <span class="warn-badge">● Sign in again</span> }
      @else if (status()?.signedIn) { <span class="ok-badge">● Signed in</span> }
      <span class="chev">{{ expanded() ? '▲' : '▼' }}</span>
    </button>
    @if (expanded()) {
      <div class="form">
        @if (status()?.rejected) {
          <p class="note warn wide">Total Connect Comfort stopped accepting the saved password{{ status()?.message ? ' (' + status()?.message + ')' : '' }}. Sign in again to bring the thermostats back.</p>
        }
        <input type="email" [(ngModel)]="email" placeholder="Total Connect Comfort email" autocomplete="off" aria-label="Total Connect Comfort email" />
        <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore
               [(ngModel)]="password" placeholder="Password" aria-label="Total Connect Comfort password" (keydown.enter)="save()" />
        <div class="bar wide">
          <button class="btn-sm btn-primary" (click)="save()" [disabled]="saving() || !email.trim() || !password">
            {{ saving() ? 'Signing in… Honeywell can take a minute' : 'Sign in' }}
          </button>
          @if (status()?.signedIn) {
            <button class="btn-sm btn-ghost" (click)="signOut()" [disabled]="saving()">Forget</button>
          }
          @if (message()) { <span class="msg" [class.ok]="!isError()" [class.err]="isError()" role="status">{{ message() }}</span> }
        </div>
        @if (thermostats().length) {
          <ul class="list wide" aria-label="Thermostats on the account">
            @for (t of thermostats(); track t.deviceId) {
              <li>
                <span class="name">{{ t.name }} @if (t.location) { <span class="meta">· {{ t.location }}</span> }</span>
                @if (t.deviceIdInHomeHub !== null) { <span class="meta">In HomeHub as {{ t.alias }}</span> }
                @else { <button class="btn-sm btn-ghost" (click)="add(t)" [disabled]="adding() === t.deviceId">{{ adding() === t.deviceId ? 'Adding…' : 'Add' }}</button> }
              </li>
            }
          </ul>
        }
        <p class="note wide">
          Total Connect Comfort asks for the password each time it signs in, so HomeHub keeps it on this HomeHub
          and never shows it again. HomeHub reads each thermostat once a minute, as often as Honeywell allows.
          A change from HomeHub reaches the thermostat within about a minute.
        </p>
      </div>
    }
  `,
})
export class HoneywellLoginComponent implements OnInit {
  private readonly http = inject(HttpClient);

  /** Fired when thermostats were added or the account forgotten, so the page reloads its devices. */
  readonly devicesChanged = output<void>();

  readonly expanded = signal(false);
  readonly status = signal<HoneywellStatus | null>(null);
  readonly thermostats = signal<AccountThermostat[]>([]);
  readonly saving = signal(false);
  readonly adding = signal<number | null>(null);
  readonly message = signal('');
  readonly isError = signal(false);

  email = '';
  password = '';

  ngOnInit(): void {
    this.http.get<HoneywellStatus>('/api/honeywell/login').subscribe((s) => {
      this.status.set(s);
      this.email = s.email ?? '';
      if (s.rejected) this.expanded.set(true);
    });
  }

  toggle(): void {
    this.expanded.set(!this.expanded());
    if (this.expanded() && this.status()?.signedIn && !this.status()?.rejected && !this.thermostats().length) this.loadThermostats();
  }

  private loadThermostats(): void {
    this.http.get<AccountThermostat[]>('/api/honeywell/thermostats').subscribe({
      next: (list) => this.thermostats.set(list),
      error: (err: HttpErrorResponse) => this.show(err.error?.error ?? 'Couldn’t read the thermostats on the account.', true),
    });
  }

  save(): void {
    if (!this.email.trim() || !this.password) return;
    this.saving.set(true);
    this.message.set('');
    this.http.put<SignInResult>('/api/honeywell/login', { email: this.email.trim(), password: this.password }).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.password = '';
        this.status.set(r);
        this.thermostats.set(r.thermostats);
        const n = r.added.length;
        this.show(r.listError
          ? 'Signed in. Honeywell is slow to list the thermostats right now, so HomeHub will add them within a few minutes.'
          : !r.thermostats.length
          ? 'Signed in, but the account has no thermostats yet. Pair them with the gateway, then sign in again.'
          : n ? `Signed in. Added ${r.added.map((d) => d.alias).join(', ')}; their readings appear within a minute.` : 'Signed in.');
        if (n) this.devicesChanged.emit();
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.show(err.error?.error ?? 'Couldn’t sign in to Total Connect Comfort.', true);
      },
    });
  }

  add(t: AccountThermostat): void {
    this.adding.set(t.deviceId);
    this.http.post<{ added: { id: number; alias: string }[]; thermostats: AccountThermostat[] }>(`/api/honeywell/thermostats/${t.deviceId}`, {}).subscribe({
      next: (r) => {
        this.adding.set(null);
        this.thermostats.set(r.thermostats);
        this.show(r.added.length ? `Added ${r.added[0].alias}.` : 'Already in HomeHub.');
        this.devicesChanged.emit();
      },
      error: (err: HttpErrorResponse) => { this.adding.set(null); this.show(err.error?.error ?? 'Couldn’t add it.', true); },
    });
  }

  signOut(): void {
    this.http.delete('/api/honeywell/login').subscribe(() => {
      this.status.set({ email: null, signedIn: false, rejected: false, message: null });
      this.thermostats.set([]);
      this.show('Forgotten. The thermostats stay in HomeHub but show as not connected until you sign in again.');
      this.devicesChanged.emit();
    });
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
