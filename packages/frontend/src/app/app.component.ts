import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { AppNavComponent } from './core/nav/app-nav.component';
import { AuthService } from './core/auth/auth.service';
import { AutomationsService } from './core/services/automations.service';
import { AppUpdateService } from './core/services/app-update.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, AppNavComponent],
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
  `],
  template: `
    <app-nav />
    @if (auth.isLoggedIn() && automations.role(); as r) {
      @if (r.role !== 'active') {
        <div class="paused standby" role="status">
          <span>
            <strong>This HomeHub is a {{ r.role === 'dev' ? 'development' : 'backup' }} server.</strong>
            Schedules, motion lights, timers, water shutoff, voice and cameras run on the active HomeHub{{ r.other ? ', at ' + r.other.address : '' }}.
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
    <div [class.tab-space]="auth.isLoggedIn()">
      <router-outlet />
    </div>
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
  readonly automations = inject(AutomationsService);
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly resuming = signal(false);

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
