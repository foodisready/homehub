import { Component, OnInit, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
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
                     autocomplete="username" maxlength="32" [disabled]="loading()" required />
            </div>
            <div class="field">
              <label for="new-password">Password</label>
              <input id="new-password" type="password" [(ngModel)]="password" name="password"
                     autocomplete="new-password" [disabled]="loading()" required />
              <p class="hint">At least 8 characters.</p>
            </div>
            <div class="field">
              <label for="confirm-password">Confirm password</label>
              <input id="confirm-password" type="password" [(ngModel)]="confirm" name="confirm"
                     autocomplete="new-password" [disabled]="loading()" required />
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
                [disabled]="loading()"
                required
              />
            </div>

            <div class="field">
              <label for="password">Password</label>
              <input
                id="password"
                type="password"
                [(ngModel)]="password"
                name="password"
                autocomplete="current-password"
                [disabled]="loading()"
                required
              />
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
  error    = signal('');
  /** A new HomeHub with no users yet: create the first admin instead of signing in. */
  setupMode = signal(false);

  constructor(
    private auth:   AuthService,
    private socket: SocketService,
    private router: Router,
  ) {}

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
        this.router.navigate(['/dashboard']);
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
