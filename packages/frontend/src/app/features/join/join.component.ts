import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SocketService } from '../../core/socket/socket.service';

type Phone = 'ios' | 'android' | 'other';

/**
 * Where a family invite's QR code leads: /join#<code>. The person picks a
 * name and password, is signed in, and is shown how to put HomeHub on their
 * home screen.
 */
@Component({
  selector: 'app-join',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .page { display:flex; align-items:center; justify-content:center; min-height:100vh; padding:1rem; }
    .card { width:100%; max-width:400px; }
    h1 { font-size:1.6rem; margin-bottom:0.3rem; }
    .lead { color:var(--text-muted); font-size:0.92rem; margin-bottom:1.4rem; line-height:1.5; }
    .field { margin-bottom:1rem; }
    label { display:block; font-size:0.85rem; color:var(--text-muted); margin-bottom:0.35rem; }
    .hint { font-size:0.75rem; color:var(--text-muted); margin-top:0.3rem; }
    .submit { width:100%; padding:0.75rem; font-size:1rem; margin-top:0.4rem; }
    ol { margin:0.5rem 0 1.25rem 1.2rem; line-height:1.7; font-size:0.95rem; }
    .icon { display:inline-block; border:1px solid var(--border); border-radius:6px; padding:0 0.35rem; font-size:0.85rem; }
    .note { font-size:0.82rem; color:var(--text-muted); margin-bottom:1rem; }
  `],
  template: `
    <div class="page">
      <div class="card">
        @switch (stage()) {
          @case ('checking') { <p>Checking your invite…</p> }
          @case ('invalid') {
            <h1>HomeHub</h1>
            <p class="lead">{{ error() }}</p>
            <p class="note">Ask whoever set up HomeHub to show you a new invite code.</p>
          }
          @case ('form') {
            <h1>Welcome home</h1>
            <p class="lead">You've been invited to HomeHub. Choose a name and password, and you're in.</p>
            @if (auth.user(); as u) { <p class="note">You're signed in as {{ u.name }} on this device. Joining signs you in as your new name instead.</p> }
            <form (ngSubmit)="join()">
              <div class="field">
                <label for="j-name">Your name</label>
                <input id="j-name" name="name" [(ngModel)]="name" autocomplete="username" maxlength="32" required [disabled]="busy()" />
              </div>
              <div class="field">
                <label for="j-pass">Password</label>
                <input id="j-pass" name="password" type="password" [(ngModel)]="password" autocomplete="new-password" required [disabled]="busy()" />
                <p class="hint">At least 8 characters.</p>
              </div>
              <div class="field">
                <label for="j-confirm">Password again</label>
                <input id="j-confirm" name="confirm" type="password" [(ngModel)]="confirm" autocomplete="new-password" required [disabled]="busy()" />
              </div>
              @if (error()) { <p class="error-msg">{{ error() }}</p> }
              <button class="btn-primary submit" type="submit" [disabled]="busy()">{{ busy() ? 'Joining…' : 'Join' }}</button>
            </form>
          }
          @case ('joined') {
            <h1>You're in, {{ name.trim() }}!</h1>
            <p class="lead">One more thing: put HomeHub on your home screen, so it opens like an app.</p>
            @if (phone === 'ios') {
              <ol>
                <li>Tap the Share button <span class="icon">⬆︎</span> at the bottom of Safari.</li>
                <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
                <li>Tap <b>Add</b>.</li>
              </ol>
            } @else if (phone === 'android') {
              <ol>
                <li>Tap the menu <span class="icon">⋮</span> at the top right of Chrome.</li>
                <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li>
                <li>Tap <b>Install</b> or <b>Add</b>.</li>
              </ol>
            } @else {
              <p class="note">On a phone, open this page in Safari (iPhone) or Chrome (Android) and use <b>Add to Home Screen</b>.</p>
            }
            <button class="btn-primary submit" type="button" (click)="open()">Open HomeHub</button>
          }
        }
      </div>
    </div>
  `,
})
export class JoinComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly socket = inject(SocketService);
  readonly auth = inject(AuthService);

  readonly stage = signal<'checking' | 'invalid' | 'form' | 'joined'>('checking');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly phone: Phone = /iphone|ipad|ipod/i.test(navigator.userAgent) ? 'ios' : /android/i.test(navigator.userAgent) ? 'android' : 'other';

  name = '';
  password = '';
  confirm = '';
  private code = '';

  ngOnInit(): void {
    this.code = decodeURIComponent(window.location.hash.replace(/^#/, ''));
    if (!this.code) { this.fail('This invite link is missing its code.'); return; }
    this.http.post('/api/auth/invite', { code: this.code }).subscribe({
      next: () => this.stage.set('form'),
      error: (err: HttpErrorResponse) => this.fail(err.error?.error ?? 'This invite link isn’t valid.'),
    });
  }

  private fail(message: string): void {
    this.error.set(message);
    this.stage.set('invalid');
  }

  join(): void {
    this.error.set('');
    if (!this.name.trim()) { this.error.set('Enter your name.'); return; }
    if (this.password.length < 8) { this.error.set('Use a password of at least 8 characters.'); return; }
    if (this.password !== this.confirm) { this.error.set('The passwords don’t match.'); return; }
    this.busy.set(true);
    this.auth.join(this.code, this.name.trim(), this.password).subscribe({
      next: () => {
        this.busy.set(false);
        this.socket.connect();
        // Don't leave the code in the address bar or history.
        history.replaceState(null, '', '/join');
        this.stage.set('joined');
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        if (err.status === 410 || err.status === 404) { this.fail(err.error?.error ?? 'This invite no longer works.'); return; }
        this.error.set(err.error?.error ?? 'Could not join. Try again.');
      },
    });
  }

  open(): void {
    this.router.navigate(['/dashboard']);
  }
}
