import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

interface HomeSettings {
  located: boolean;
  source: { location: 'settings' | 'env' | 'none'; timezone: 'settings' | 'env' | 'default' };
}

/**
 * Tells an admin when HomeHub doesn't know the home's time zone or location.
 * Without them, clock-time schedules run on UTC and sunset ones on San
 * Francisco's sun, so "12:30 AM" fires hours off. Easy to miss after a move.
 */
@Component({
  selector: 'app-home-setup-notice',
  standalone: true,
  imports: [RouterLink],
  styles: [`
    .notice {
      border: 1px solid #b45309; background: rgba(180,83,9,0.1); border-radius: 8px;
      padding: 0.75rem 1rem; margin-bottom: 1.25rem; font-size: 0.88rem; line-height: 1.45;
      display: flex; align-items: center; justify-content: space-between; gap: 0.6rem 1rem; flex-wrap: wrap;
    }
    .notice strong { color: var(--text); }
    .notice a {
      font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px; text-decoration: none;
      background: var(--accent); color: #fff; white-space: nowrap;
    }
  `],
  template: `
    @if (message(); as text) {
      <div class="notice" role="status">
        <span><strong>Schedules may run at the wrong time.</strong> {{ text }}</span>
        <a routerLink="/settings" [queryParams]="{ section: 'home' }">Set it in Settings</a>
      </div>
    }
  `,
})
export class HomeSetupNoticeComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly home = signal<HomeSettings | null>(null);

  readonly message = computed(() => {
    const h = this.home();
    if (!h || this.auth.user()?.role !== 'admin') return '';
    const noZone = h.source.timezone === 'default';
    if (noZone && !h.located) return "HomeHub doesn't know your time zone or location, so it's using UTC and San Francisco's sunset.";
    if (noZone) return "HomeHub doesn't know your time zone, so clock times use UTC.";
    if (!h.located) return "HomeHub doesn't know your location, so sunrise and sunset use San Francisco's.";
    return '';
  });

  ngOnInit(): void {
    this.http.get<HomeSettings>('/api/home-settings').subscribe({ next: (h) => this.home.set(h), error: () => undefined });
  }
}
