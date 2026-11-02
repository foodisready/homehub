import { Component, OnInit, inject, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface MerossLogin { email: string | null; signedIn: boolean; hasNames?: boolean; rejectedBy?: string[] }

/** Settings → Integrations → Meross. Signs in once to get the account key that Meross devices check. */
@Component({
  selector: 'app-meross-login',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .head { display:flex; align-items:center; gap:1rem; padding:0.65rem 0; cursor:pointer; background:none; border:none;
            width:100%; text-align:left; color:var(--text); font:inherit; }
    .label { flex:1; font-size:0.9rem; }
    .sub { font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem; }
    .ok-badge { font-size:0.72rem; color:#4ade80; }
    .chev { color:var(--text-muted); font-size:0.85rem; }
    .form { display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; margin-top:0.25rem; }
    .form input { font-size:0.85rem; padding:0.4rem 0.7rem; min-width:0; }
    .wide { grid-column:1 / -1; }
    .bar { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .note { font-size:0.75rem; color:var(--text-muted); line-height:1.4; }
    .msg { font-size:0.82rem; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); }
    @media (max-width: 480px) { .form { grid-template-columns:1fr; } }
  `],
  template: `
    <button type="button" class="head" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()">
      <div class="label">
        Meross
        <div class="sub">For Meross garage door openers. Sign in once with your Meross app account.</div>
      </div>
      @if (signedIn()) { <span class="ok-badge">● Signed in</span> }
      <span class="chev">{{ expanded() ? '▲' : '▼' }}</span>
    </button>
    @if (expanded()) {
      <div class="form">
        <input type="email" [(ngModel)]="email" placeholder="Meross email" autocomplete="off" aria-label="Meross email" />
        <input type="password" [(ngModel)]="password" placeholder="Meross password" autocomplete="new-password"
               aria-label="Meross password" (keydown.enter)="save()" />
        @if (needsCode()) {
          <input class="wide" type="text" inputmode="numeric" [(ngModel)]="code" placeholder="Verification code from Meross"
                 autocomplete="one-time-code" aria-label="Verification code" (keydown.enter)="save()" />
        }
        <div class="bar wide">
          <button class="btn-sm btn-primary" (click)="save()" [disabled]="saving() || !email.trim() || !password">
            {{ saving() ? 'Signing in…' : 'Sign in' }}
          </button>
          @if (signedIn()) {
            <button class="btn-sm btn-ghost" (click)="signOut()" [disabled]="saving()">Forget</button>
          }
          @if (message()) { <span class="msg" [class.ok]="!isError()" [class.err]="isError()">{{ message() }}</span> }
        </div>
        <p class="note wide">
          HomeHub keeps only the key Meross gives back, not your password. Devices then work without the internet.
          HomeHub also uses the sign-in to show the names you gave devices in the Meross app.
        </p>
        @if (noNames()) {
          <p class="note wide">Sign in again to use the names from the Meross app, and to spot openers HomeHub can't reach.</p>
        }
      </div>
    }
  `,
})
export class MerossLoginComponent implements OnInit {
  private readonly http = inject(HttpClient);

  /** Fired after a successful sign-in, so the page can probe again. */
  readonly signedInChange = output<boolean>();

  readonly expanded = signal(false);
  readonly signedIn = signal(false);
  readonly saving = signal(false);
  readonly needsCode = signal(false);
  /** Signed in before HomeHub read device names, so names from the Meross app aren't available. */
  readonly noNames = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);

  email = '';
  password = '';
  code = '';

  ngOnInit(): void {
    this.http.get<MerossLogin>('/api/meross/login').subscribe((login) => {
      this.signedIn.set(login.signedIn);
      this.noNames.set(login.signedIn && login.hasNames === false);
      this.email = login.email ?? '';
    });
  }

  /** Opens the card, e.g. when a Meross device was found but HomeHub isn't signed in yet. */
  open(): void {
    this.expanded.set(true);
  }

  save(): void {
    if (!this.email.trim() || !this.password) return;
    this.saving.set(true);
    this.message.set('');
    this.http.put<MerossLogin>('/api/meross/login', { email: this.email.trim(), password: this.password, code: this.code }).subscribe({
      next: (login) => {
        this.saving.set(false);
        this.password = '';
        this.code = '';
        this.needsCode.set(false);
        this.signedIn.set(true);
        this.noNames.set(login.hasNames === false);
        const rejected = login.rejectedBy ?? [];
        this.show(rejected.length
          ? `Signed in, but ${rejected.join(', ')} didn't accept this account. Check it's the account the opener was set up with.`
          : 'Signed in', rejected.length > 0);
        this.signedInChange.emit(true);
      },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        if (err.error?.code === 'MEROSS_CODE_REQUIRED') this.needsCode.set(true);
        this.show(err.error?.error ?? 'Could not sign in to Meross.', true);
      },
    });
  }

  signOut(): void {
    this.http.delete('/api/meross/login').subscribe(() => {
      this.signedIn.set(false);
      this.noNames.set(false);
      this.show('Forgotten. Meross devices stop working until you sign in again.');
      this.signedInChange.emit(false);
    });
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
