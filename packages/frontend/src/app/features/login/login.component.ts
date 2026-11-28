import { Component, OnInit, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .login-page {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .login-card {
      width: 100%;
      max-width: 380px;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-bottom: 1.75rem;
    }
    .field { margin-bottom: 1rem; }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-muted);
      margin-bottom: 0.35rem;
    }
    .hint { font-size: 0.75rem; color: var(--text-muted); margin: 0.3rem 0 0; }
    /* The eye: shows what's typed, so a password typed on a tablet's keyboard can be checked. */
    .pw { position: relative; }
    .pw input { width: 100%; padding-right: 2.8rem; }
    .eye { position: absolute; right: 0.25rem; top: 50%; transform: translateY(-50%); width: 2.4rem; height: 2.4rem;
      display: grid; place-items: center; padding: 0; background: none; border: 0; color: var(--text-muted); }
    .eye svg { width: 1.2rem; height: 1.2rem; }
    .submit-btn {
      width: 100%;
      padding: 0.7rem;
      margin-top: 0.5rem;
      font-size: 1rem;
    }
  `],
  template: `
    <div class="login-page">
      <div class="card login-card">
        <h1>HomeHub</h1>
        @if (setupMode()) {
          <p class="subtitle">Welcome! Create the admin account you'll use to manage your home.</p>

          <form (ngSubmit)="onSetup()">
            <div class="field">
              <label for="new-username">Username</label>
              <input id="new-username" type="text" [(ngModel)]="username" name="username"
                     autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" [disabled]="loading()" required />
            </div>
            <div class="field">
              <label for="new-password">Password</label>
              <div class="pw">
              <input id="new-password" [type]="showPassword() ? 'text' : 'password'" [(ngModel)]="password" name="password"
                     autocomplete="new-password" autocapitalize="off" spellcheck="false" [disabled]="loading()" required />
              <button type="button" class="eye" (click)="showPassword.set(!showPassword())" [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'" [attr.aria-pressed]="showPassword()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  @if (showPassword()) { <path d="M2 12s3.6-7 10-7c2 0 3.8.7 5.3 1.7M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.3-1.7" /><path d="M3 3l18 18" /> }
                  @else { <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /> }
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
              </div>
              <p class="hint">At least 8 characters.</p>
            </div>
            <div class="field">
              <label for="confirm-password">Confirm password</label>
              <input id="confirm-password" [type]="showPassword() ? 'text' : 'password'" [(ngModel)]="confirm" name="confirm"
                     autocomplete="new-password" autocapitalize="off" spellcheck="false" [disabled]="loading()" required />
            </div>

            @if (error()) {
              <p class="error-msg">{{ error() }}</p>
            }

            <button type="submit" class="btn-primary submit-btn" [disabled]="loading()">
              {{ loading() ? 'Creating…' : 'Create account' }}
            </button>
          </form>
        } @else {
          <p class="subtitle">Sign in to manage your home</p>

          <form (ngSubmit)="onSubmit()">
            <div class="field">
              <label for="username">Username</label>
              <input
                id="username"
                type="text"
                [(ngModel)]="username"
                name="username"
                autocomplete="username"
                autocapitalize="off"
                spellcheck="false"
                [disabled]="loading()"
                required
              />
            </div>

            <div class="field">
              <label for="password">Password</label>
              <div class="pw">
              <input
                id="password"
                [type]="showPassword() ? 'text' : 'password'"
                [(ngModel)]="password"
                name="password"
                autocomplete="current-password"
                autocapitalize="off"
                spellcheck="false"
                [disabled]="loading()"
                required
              />
              <button type="button" class="eye" (click)="showPassword.set(!showPassword())" [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'" [attr.aria-pressed]="showPassword()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  @if (showPassword()) { <path d="M2 12s3.6-7 10-7c2 0 3.8.7 5.3 1.7M22 12s-3.6 7-10 7c-2 0-3.8-.7-5.3-1.7" /><path d="M3 3l18 18" /> }
                  @else { <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /> }
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
              </div>
            </div>

            @if (error()) {
              <p class="error-msg">{{ error() }}</p>
            }

            <button type="submit" class="btn-primary submit-btn" [disabled]="loading()">
              {{ loading() ? 'Signing in…' : 'Sign in' }}
            </button>
          </form>
        }
      </div>
    </div>
  `,
})
export class LoginComponent implements OnInit {
  username = '';
  password = '';
  confirm  = '';
  loading  = signal(false);
  /** The eye beside the password: shows what's typed. */
  readonly showPassword = signal(false);
  error    = signal('');
  /** A new HomeHub with no users yet: create the first admin instead of signing in. */
  setupMode = signal(false);

  constructor(
    private auth:   AuthService,
    private socket: SocketService,
    private router: Router,
    private route:  ActivatedRoute,
  ) {}

  /**
   * Where to go once signed in: the page that asked for it (?next=/wall from the sign-in guard), so a
   * wall tablet's shortcut comes back to the wall display. Only HomeHub's own pages; Home otherwise.
   */
  private next(): string {
    const n = this.route.snapshot.queryParamMap.get('next') ?? '';
    return /^\/(?![\/\\])/.test(n) && !n.startsWith('/login') ? n : '/dashboard';
  }

  ngOnInit(): void {
    this.auth.setupNeeded().subscribe({
      next: (needed) => {
        this.setupMode.set(needed);
        if (needed && !this.username) this.username = 'admin';
      },
      error: () => undefined,   // older backend, or offline: show sign-in
    });
  }

  onSubmit(): void {
    if (!this.username || !this.password) return;

    this.loading.set(true);
    this.error.set('');

    this.auth.login(this.username, this.password).subscribe({
      next: () => {
        this.socket.connect();
        void this.router.navigateByUrl(this.next());
      },
      error: (err: HttpErrorResponse) => {
        this.error.set(err.status === 429 ? err.error.error : 'Invalid username or password.');
        this.loading.set(false);
      },
    });
  }

  onSetup(): void {
    this.error.set('');
    if (!this.username.trim()) { this.error.set('Enter a username.'); return; }
    if (this.password.length < 8) { this.error.set('Use a password of at least 8 characters.'); return; }
    if (this.password !== this.confirm) { this.error.set("The passwords don't match."); return; }

    this.loading.set(true);
    this.auth.setup(this.username.trim(), this.password).subscribe({
      next: () => {
        this.socket.connect();
        // Next stop: the guided setup.
        this.router.navigate(['/welcome']);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        if (err.status === 409) {
          // Someone else finished setup first.
          this.setupMode.set(false);
          this.password = this.confirm = '';
          this.error.set('HomeHub is already set up. Sign in instead.');
          return;
        }
        this.error.set(err.error?.error ?? 'Could not create the account.');
      },
    });
  }
}
