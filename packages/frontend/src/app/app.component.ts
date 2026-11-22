import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { AppNavComponent } from './core/nav/app-nav.component';
import { AuthService } from './core/auth/auth.service';
import { AutomationsService } from './core/services/automations.service';
import { AppUpdateService } from './core/services/app-update.service';
import { ReadOnlyNotice } from './core/services/read-only-notice.service';
import { AiWarmupService } from './core/services/ai-warmup.service';
import { LockScreenComponent } from './core/lock/lock-screen.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, AppNavComponent, LockScreenComponent],
  styles: [`
    /* Room for the phone tab bar, so it never covers the end of a page. */
    @media (max-width: 899px) {
      .tab-space { padding-bottom: calc(3.6rem + env(safe-area-inset-bottom, 0px)); }
    }
    .paused {
      display: flex; align-items: center; justify-content: center; gap: 0.4rem 0.75rem; flex-wrap: wrap;
      padding: 0.55rem 1rem; font-size: 0.85rem; text-align: center;
      background: #78350f; color: #fef3c7; border-bottom: 1px solid #b45309;
    }
    .paused button {
      background: #fef3c7; color: #78350f; border: none; border-radius: 6px;
      padding: 0.25rem 0.7rem; font-size: 0.8rem; font-weight: 600; cursor: pointer;
    }
    .paused button:disabled { opacity: 0.6; cursor: default; }
    .paused a { color: inherit; font-weight: 600; }
    .standby { background: #1e3a5f; color: #dbeafe; border-bottom-color: #2563eb; }
    .conflict { background: #7f1d1d; color: #fee2e2; border-bottom-color: #dc2626; }
    .warming { background: #1e3a5f; color: #dbeafe; border-bottom-color: #2563eb; }
    .warming .progress { font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0.85; }
    .ready { background: #14532d; color: #dcfce7; border-bottom-color: #16a34a; }
  `],
  template: `
    @if (!wall()) {
    <app-nav />
    @if (auth.isLoggedIn() && automations.role(); as r) {
      @if (r.role !== 'active') {
        <div class="paused standby" role="status">
          <span>
            <strong>This HomeHub is a {{ r.role === 'dev' ? 'development' : 'backup' }} server.</strong>
            Schedules, motion lights, timers, water shutoff, voice and cameras run on the active HomeHub{{ r.other ? ', at ' + r.other.address : '' }}.
            @if (r.role === 'backup') { It's read-only: make changes there, and they're copied here every hour. You can still switch devices on and off. }
          </span>
          @if (isAdmin()) { <a routerLink="/settings" [queryParams]="{ section: 'preferences' }">Change</a> }
        </div>
      } @else if (r.other) {
        <div class="paused conflict" role="alert">
          <span>
            <strong>Another HomeHub, at {{ r.other.address }}, is also acting as the active one.</strong>
            Both may be running your schedules. Set one of them to Backup in Settings → Preferences → This server.
          </span>
        </div>
      }
    }
    @if (auth.isLoggedIn() && automations.paused() && automations.role()?.role !== 'dev' && automations.role()?.role !== 'backup') {
      <div class="paused" role="status">
        <span><strong>Automations are paused on this HomeHub.</strong> Schedules, motion rules and timers won't run.</span>
        @if (isAdmin()) {
          <button type="button" (click)="resume()" [disabled]="resuming()">{{ resuming() ? 'Resuming…' : 'Resume' }}</button>
        }
      </div>
    }
    @if (auth.isLoggedIn()) {
      @if (warmup.voiceStarting()) {
        <div class="paused warming" role="status" aria-live="polite">
          <span>
            <strong>Voice is starting.</strong>
            Speakers will answer in about a minute. Everything else works now.
          </span>
          <span class="progress">{{ warmup.status()!.voice!.loading ? 'Loading speech' : 'Finding speakers' }} · {{ warmup.voiceElapsed() }}</span>
        </div>
      } @else if (warmup.voiceMissing()) {
        <div class="paused" role="alert">
          <span>
            <strong>No speaker has reconnected.</strong>
            Voice commands won't be heard until one does. Check that the speaker is on and connected to Wi-Fi.
            @if (isAdmin()) { <a routerLink="/health">Health</a> shows which one and why. }
          </span>
          <button type="button" (click)="warmup.dismissVoiceMissing()">OK</button>
        </div>
      } @else if (warmup.voiceJustReady()) {
        <div class="paused ready" role="status" aria-live="polite">
          <span><strong>Voice is ready.</strong> Speakers are listening again.</span>
        </div>
      } @else if (warmup.loading()) {
        <div class="paused warming" role="status" aria-live="polite">
          <span>
            <strong>HomeHub is getting its AI ready.</strong>
            Lights, scenes, schedules and voice work now. Chat replies may be slow until it's done, usually a few minutes.
          </span>
          <span class="progress">Step {{ warmup.status()!.step }} of {{ warmup.status()!.steps }} · {{ warmup.elapsed() }}</span>
        </div>
      } @else if (warmup.justReady()) {
        <div class="paused ready" role="status" aria-live="polite">
          <span><strong>HomeHub's AI is ready.</strong> Chat is back to full speed.</span>
        </div>
      } @else if (warmup.failed()) {
        <div class="paused conflict" role="alert">
          <span>
            <strong>HomeHub's AI didn't start.</strong>
            Lights, scenes, schedules and voice still work, but Chat may not answer.
            @if (isAdmin()) { <a routerLink="/health">Health</a> has details. }
          </span>
          <button type="button" (click)="warmup.dismissFailure()">OK</button>
        </div>
      }
    }
    @if (notice.message()) {
      <div class="paused standby" role="alert">
        <span>{{ notice.message() }}</span>
        <button type="button" (click)="notice.message.set('')">OK</button>
      </div>
    }
    }
    <!-- The wall display has the screen to itself: no menus or banners. -->
    <div [class.tab-space]="auth.isLoggedIn() && !wall()">
      <router-outlet />
    </div>
    <!-- Over everything while a shared screen is locked (Wall display → ⋯ → Lock with a PIN). -->
    <app-lock-screen />
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
  readonly automations = inject(AutomationsService);
  readonly notice = inject(ReadOnlyNotice);
  readonly warmup = inject(AiWarmupService);
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly resuming = signal(false);
  private readonly router = inject(Router);
  readonly wall = toSignal(this.router.events.pipe(
    filter((e): e is NavigationEnd => e instanceof NavigationEnd),
    map((e) => e.urlAfterRedirects.split('?')[0] === '/wall'),
  ), { initialValue: location.pathname === '/wall' });

  constructor() {
    inject(AppUpdateService).start();
  }

  resume(): void {
    this.resuming.set(true);
    this.automations.setPaused(false).subscribe({
      next: () => this.resuming.set(false),
      error: () => this.resuming.set(false),
    });
  }
}
