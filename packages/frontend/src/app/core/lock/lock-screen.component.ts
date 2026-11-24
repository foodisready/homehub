import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';
import { LockService } from './lock.service';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

/**
 * The lock screen, over everything while the screen is locked: a dim clock that moves a little each
 * minute (no burn-in), and on a tap, a number pad for the PIN. "Forgot the PIN?" signs out, so the
 * account's password is the way back in.
 */
@Component({
  selector: 'app-lock-screen',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .lock { position: fixed; inset: 0; z-index: 500; background: #020409; color: #cbd5e1; display: grid; place-items: center; touch-action: manipulation; user-select: none; }
    .face { position: absolute; transform: translate(-50%, -50%); text-align: center; transition: left 2s, top 2s; opacity: 0.6; cursor: pointer; }
    .face b { display: block; font-size: clamp(4rem, 12vw, 8rem); font-weight: 600; line-height: 1; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
    .face span { display: block; margin-top: 0.8rem; font-size: 1rem; color: #64748b; }
    .pad { text-align: center; width: min(20rem, 88vw); animation: hh-fade .15s ease-out; }
    .pad h2 { margin: 0 0 1rem; font-size: 1.15rem; font-weight: 600; }
    .dots { display: flex; justify-content: center; gap: 0.8rem; height: 1rem; margin-bottom: 1rem; }
    .dots i { width: 0.85rem; height: 0.85rem; border-radius: 50%; border: 2px solid #64748b; }
    .dots i.on { background: #e2e8f0; border-color: #e2e8f0; }
    .msg { min-height: 2.6rem; font-size: 0.9rem; color: #fca5a5; margin: 0 0 0.6rem; line-height: 1.4; }
    .keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.8rem; }
    .keys button { height: 4.2rem; border-radius: 50%; aspect-ratio: 1; justify-self: center; border: 1px solid #1e293b; background: #0f172a; color: #f1f5f9; font-size: 1.6rem; font-weight: 500; padding: 0; }
    .keys button:active:not(:disabled) { background: #1e293b; }
    .keys button:disabled { opacity: 0.35; }
    .keys .blank { visibility: hidden; }
    .forgot { margin-top: 1.2rem; background: none; border: none; color: #64748b; font-size: 0.85rem; text-decoration: underline; }
    @media (prefers-reduced-motion: reduce) { .face { transition: none; } }
  `],
  template: `
    @if (lock.locked()) {
      <div class="lock" role="dialog" aria-modal="true" aria-label="Locked" (click)="padOpen() || openPad()">
        @if (!padOpen()) {
          <div class="face" [style.left.%]="drift().x" [style.top.%]="drift().y" role="button" tabindex="0" aria-label="Unlock" (keydown.enter)="openPad()">
            <b>{{ clock() }}</b>
            <span>Locked · tap to unlock</span>
          </div>
        } @else {
          <div class="pad">
            <h2>{{ lock.asking() ? 'Enter the PIN to ' + lock.asking() : 'Enter the PIN' }}</h2>
            <div class="dots" aria-hidden="true">@for (d of slots(); track $index) { <i [class.on]="d"></i> }</div>
            <p class="msg" role="alert">{{ message() }}</p>
            <div class="keys">
              @for (k of keys; track $index) {
                @if (k === '') { <button type="button" class="blank" tabindex="-1" aria-hidden="true"></button> }
                @else { <button type="button" (click)="press(k)" [disabled]="busy() || waiting() > 0" [attr.aria-label]="k === '⌫' ? 'Delete' : k">{{ k }}</button> }
              }
            </div>
            @if (lock.asking()) { <button type="button" class="forgot" (click)="$event.stopPropagation(); cancel()">Cancel</button> }
            @else { <button type="button" class="forgot" (click)="forgot()">Forgot the PIN? Sign out</button> }
          </div>
        }
      </div>
    }
  `,
})
export class LockScreenComponent implements OnInit, OnDestroy {
  readonly lock = inject(LockService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly keys = KEYS;

  readonly now = signal(Date.now());
  readonly padOpen = signal(false);
  readonly entry = signal('');
  readonly message = signal('');
  readonly busy = signal(false);
  /** Seconds to wait after too many wrong tries. */
  readonly waiting = signal(0);
  private timer?: ReturnType<typeof setInterval>;
  private padTimer?: ReturnType<typeof setTimeout>;

  readonly clock = computed(() => new Date(this.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, ''));
  readonly slots = computed(() => Array.from({ length: this.lock.pinLength() }, (_, i) => i < this.entry().length));
  readonly drift = computed(() => {
    const a = ((Math.floor(this.now() / 60_000) % 12) / 12) * 2 * Math.PI;
    return { x: 50 + Math.cos(a) * 14, y: 45 + Math.sin(a) * 12 };
  });

  ngOnInit(): void {
    this.lock.start();
    this.timer = setInterval(() => {
      this.now.set(Date.now());
      if (this.waiting() > 0) {
        this.waiting.update((s) => Math.max(0, s - 1));
        if (this.waiting() === 0) this.message.set('');
        else this.message.set(`Too many wrong tries. Try again in ${this.waitText()}.`);
      }
    }, 1000);
  }

  ngOnDestroy(): void { clearInterval(this.timer); clearTimeout(this.padTimer); }

  private waitText(): string {
    const s = this.waiting();
    return s >= 60 ? `${Math.ceil(s / 60)} min` : `${s} s`;
  }

  /** The pad goes back to the clock after half a minute untouched; a PIN asked for something is let go. */
  private keepPad(): void {
    clearTimeout(this.padTimer);
    this.padTimer = setTimeout(() => {
      if (this.lock.asking()) { this.cancel(); return; }
      this.padOpen.set(false); this.entry.set(''); if (!this.waiting()) this.message.set('');
    }, 30_000);
  }

  /** Asked for the PIN to do something: straight to the pad. */
  private readonly padForAsk = effect(() => { if (this.lock.asking()) untracked(() => this.openPad()); });

  cancel(): void {
    clearTimeout(this.padTimer);
    this.entry.set(''); this.message.set(''); this.padOpen.set(false);
    this.lock.cancelAsk();
  }

  openPad(): void {
    this.padOpen.set(true);
    this.keepPad();
  }

  press(k: string): void {
    this.keepPad();
    if (k === '⌫') { this.entry.update((e) => e.slice(0, -1)); return; }
    if (this.entry().length >= this.lock.pinLength()) return;
    this.entry.update((e) => e + k);
    if (this.entry().length === this.lock.pinLength()) this.tryPin();
  }

  private tryPin(): void {
    const pin = this.entry();
    this.busy.set(true);
    this.lock.unlock(pin).subscribe({
      next: () => { this.busy.set(false); this.entry.set(''); this.message.set(''); this.padOpen.set(false); clearTimeout(this.padTimer); },
      error: (e) => {
        this.busy.set(false);
        const retry = Number(e?.error?.retryAfterSeconds) || 0;
        if (retry) { this.entry.set(''); this.waiting.set(retry); this.message.set(`Too many wrong tries. Try again in ${this.waitText()}.`); return; }
        this.entry.set('');
        this.message.set(e?.error?.error ?? 'That didn’t work. Try again.');
      },
    });
  }

  forgot(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }
}
