import { Component, signal } from '@angular/core';
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
      </div>
    </div>
  `,
})
export class LoginComponent {
  username = '';
  password = '';
  loading  = signal(false);
  error    = signal('');

  constructor(
    private auth:   AuthService,
    private socket: SocketService,
    private router: Router,
  ) {}

  onSubmit(): void {
    if (!this.username || !this.password) return;

    this.loading.set(true);
    this.error.set('');

    this.auth.login(this.username, this.password).subscribe({
      next: () => {
        this.socket.connect();
        this.router.navigate(['/dashboard']);
      },
      error: () => {
        this.error.set('Invalid username or password.');
        this.loading.set(false);
      },
    });
  }
}
