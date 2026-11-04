import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { CamerasStateService } from '../services/cameras-state.service';
import { AuthService } from '../auth/auth.service';
import { SocketService } from '../socket/socket.service';
import { PhoneQrComponent } from '../../features/dashboard/phone-qr.component';

interface NavItem {
  path: string;
  label: string;
  icon: string;          // SVG path data, 24×24, stroked
  adminOnly?: boolean;
}

const ICONS = {
  home:     'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  scenes:   'M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9zM5 15l.7 1.6L7.3 17.3 5.7 18 5 19.6 4.3 18 2.7 17.3l1.6-.7z',
  chat:     'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  schedule: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  more:     'M5 12h.01M12 12h.01M19 12h.01',
  sensors:  'M12 12h.01M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
  energy:   'M13 2 4 14h7l-1 8 9-12h-7z',
  alerts:   'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0',
  firmware: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  qr:       'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  activity: 'M4 6h16M4 12h10M4 18h7M19 15v4l2.5 1.5',
  camera:   'M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  health:   'M3 12h4l2-5 4 10 2-5h6',
  signOut:  'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
};

/** Shown as tabs on phones, and first in the top bar on wider screens. */
const MAIN: NavItem[] = [
  { path: '/dashboard', label: 'Home',      icon: ICONS.home },
  { path: '/scenes',    label: 'Scenes',    icon: ICONS.scenes },
  { path: '/chat',      label: 'Chat',      icon: ICONS.chat },
  { path: '/schedules', label: 'Schedules', icon: ICONS.schedule },
];

/** Under More on phones. */
const MORE: NavItem[] = [
  { path: '/activity',      label: 'Activity', icon: ICONS.activity },
  { path: '/cameras',       label: 'Cameras',  icon: ICONS.camera },
  { path: '/sensors',       label: 'Sensors',  icon: ICONS.sensors },
  { path: '/energy',        label: 'Energy',   icon: ICONS.energy },
  { path: '/notifications', label: 'Alerts',   icon: ICONS.alerts },
  { path: '/firmware',      label: 'Firmware', icon: ICONS.firmware, adminOnly: true },
  { path: '/health',        label: 'Health',   icon: ICONS.health },
  { path: '/settings',      label: 'Settings', icon: ICONS.settings },
];

/**
 * App-wide navigation. Phones get a bottom tab bar, where thumbs reach, with
 * the less used pages under More. Wider screens get one top bar with an
 * account menu. Hidden on the sign-in page.
 */
@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, PhoneQrComponent],
  styles: [`
    :host { display: contents; }
    svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex-shrink: 0; }

    /* ── Wide screens: top bar ─────────────────────────────── */
    .top {
      position: sticky; top: 0; z-index: 30;
      background: rgba(15, 23, 42, 0.92); backdrop-filter: blur(8px);
      border-bottom: 1px solid rgba(75, 98, 128, 0.5);
    }
    .top-inner {
      max-width: 1100px; margin: 0 auto; padding: 0.6rem 1rem;
      display: flex; align-items: center; gap: 1.25rem;
    }
    .brand { font-weight: 800; font-size: 1.15rem; color: var(--text); margin-right: 0.5rem; }
    .links { display: flex; gap: 0.15rem; flex: 1; min-width: 0; flex-wrap: wrap; }
    .links a {
      color: var(--text-muted); font-size: 0.88rem; padding: 0.4rem 0.65rem; border-radius: 8px;
    }
    .links a:hover { color: var(--text); background: var(--surface); }
    .links a.active { color: var(--text); background: var(--surface); font-weight: 600; }
    .top-actions { display: flex; align-items: center; gap: 0.5rem; position: relative; }
    .ghost {
      background: transparent; border: 1px solid var(--border); color: var(--text-muted);
      font-size: 0.8rem; padding: 0.35rem 0.8rem; display: inline-flex; align-items: center; gap: 0.35rem;
    }
    .ghost:hover { color: var(--text); background: var(--surface); }
    .ghost svg { width: 16px; height: 16px; }
    .menu {
      position: absolute; right: 0; top: calc(100% + 0.4rem); min-width: 13rem; z-index: 40;
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow); padding: 0.4rem;
    }
    .menu-who { padding: 0.5rem 0.6rem; font-size: 0.8rem; color: var(--text-muted); border-bottom: 1px solid var(--border); margin-bottom: 0.3rem; }
    .menu-who strong { display: block; color: var(--text); font-size: 0.9rem; }
    .menu button {
      width: 100%; display: flex; align-items: center; gap: 0.6rem; background: transparent;
      color: var(--text); padding: 0.55rem 0.6rem; border-radius: 8px; text-align: left;
    }
    .menu button:hover { background: var(--bg); }
    .menu button svg { width: 18px; height: 18px; }

    /* ── Phones: bottom tabs ───────────────────────────────── */
    .tabs {
      display: none;
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
      background: rgba(15, 23, 42, 0.96); backdrop-filter: blur(8px);
      border-top: 1px solid rgba(75, 98, 128, 0.6);
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .tabs-inner { display: grid; grid-template-columns: repeat(5, 1fr); max-width: 560px; margin: 0 auto; }
    .tab {
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.15rem;
      min-height: 3.6rem; padding: 0.35rem 0; color: var(--text-muted); font-size: 0.68rem; font-weight: 500;
      background: transparent; border-radius: 0;
    }
    .tab.active { color: var(--accent); }
    .tab.active svg { stroke-width: 2.2; }

    .sheet-backdrop { position: fixed; inset: 0; z-index: 40; background: rgba(0, 0, 0, 0.5); }
    .sheet {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 41;
      background: var(--surface); border-top: 1px solid var(--border);
      border-radius: 16px 16px 0 0; box-shadow: var(--shadow);
      padding: 0.5rem 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
      max-width: 560px; margin: 0 auto;
      animation: rise 0.18s ease-out;
    }
    @keyframes rise { from { transform: translateY(30%); opacity: 0; } to { transform: none; opacity: 1; } }
    .grabber { width: 2.5rem; height: 4px; border-radius: 999px; background: var(--border); margin: 0.2rem auto 0.6rem; }
    .sheet-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
    .sheet-item {
      display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
      padding: 0.8rem 0.25rem; border-radius: 12px; background: var(--bg); color: var(--text);
      font-size: 0.8rem; border: 1px solid transparent;
    }
    .sheet-item.active { border-color: var(--accent); color: var(--accent); }
    .sheet-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
      margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px solid var(--border);
      font-size: 0.82rem; color: var(--text-muted);
    }
    .sheet-foot strong { color: var(--text); }

    @media (max-width: 899px) {
      .top { display: none; }
      .tabs { display: block; }
    }
  `],
  template: `
    @if (visible()) {
      <!-- Wide screens -->
      <header class="top">
        <div class="top-inner">
          <a class="brand" routerLink="/dashboard">HomeHub</a>
          <nav class="links" aria-label="Main">
            @for (item of allItems(); track item.path) {
              <a [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{ item.label }}</a>
            }
          </nav>
          <div class="top-actions">
            <button class="ghost" type="button" (click)="showQr.set(true)" aria-label="Show QR code to open HomeHub on a phone">
              <svg viewBox="0 0 24 24"><path [attr.d]="icons.qr" /></svg> QR code
            </button>
            <button class="ghost" type="button" (click)="accountOpen.set(!accountOpen())" [attr.aria-expanded]="accountOpen()" aria-haspopup="menu">
              {{ auth.user()?.name }} ▾
            </button>
            @if (accountOpen()) {
              <div class="menu" role="menu">
                <div class="menu-who">Signed in as <strong>{{ auth.user()?.name }}</strong>{{ roleLabel() }}</div>
                <button type="button" role="menuitem" (click)="logout()">
                  <svg viewBox="0 0 24 24"><path [attr.d]="icons.signOut" /></svg> Sign out
                </button>
              </div>
            }
          </div>
        </div>
      </header>

      <!-- Phones -->
      <nav class="tabs" aria-label="Main">
        <div class="tabs-inner">
          @for (item of main; track item.path) {
            <a class="tab" [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="item.icon" /></svg>
              {{ item.label }}
            </a>
          }
          <button class="tab" type="button" [class.active]="moreOpen() || moreActive()" (click)="moreOpen.set(!moreOpen())"
                  [attr.aria-expanded]="moreOpen()" aria-haspopup="dialog">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.more" style="stroke-width:3.2" /></svg>
            More
          </button>
        </div>
      </nav>

      @if (moreOpen()) {
        <div class="sheet-backdrop" (click)="moreOpen.set(false)"></div>
        <div class="sheet" role="dialog" aria-label="More">
          <div class="grabber"></div>
          <div class="sheet-grid">
            @for (item of moreItems(); track item.path) {
              <a class="sheet-item" [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="item.icon" /></svg>
                {{ item.label }}
              </a>
            }
            <button class="sheet-item" type="button" (click)="moreOpen.set(false); showQr.set(true)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.qr" /></svg>
              QR code
            </button>
          </div>
          <div class="sheet-foot">
            <span>Signed in as <strong>{{ auth.user()?.name }}</strong>{{ roleLabel() }}</span>
            <button class="ghost" type="button" (click)="logout()">
              <svg viewBox="0 0 24 24"><path [attr.d]="icons.signOut" /></svg> Sign out
            </button>
          </div>
        </div>
      }

      @if (showQr()) {
        <app-phone-qr (closed)="showQr.set(false)" />
      }
    }
  `,
})
export class AppNavComponent {
  readonly auth = inject(AuthService);
  private readonly cams = inject(CamerasStateService);
  private readonly router = inject(Router);
  private readonly socket = inject(SocketService);

  readonly icons = ICONS;
  readonly main = MAIN;

  readonly moreOpen = signal(false);
  readonly accountOpen = signal(false);
  readonly showQr = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** Signed in and not on the sign-in page. */
  // Setup and joining are full-page flows of their own.
  readonly visible = computed(() => this.auth.isLoggedIn() && !/^\/(login|welcome|join)/.test(this.url()));

  private readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly moreItems = computed(() =>
    MORE.filter((i) => (!i.adminOnly || this.isAdmin()) && (i.path !== '/cameras' || this.cams.visible())));
  readonly allItems = computed(() => [...MAIN, ...this.moreItems()]);
  readonly roleLabel = computed(() => (this.isAdmin() ? ' · administrator' : ''));

  constructor() {
    // Close menus after moving to another page.
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => {
      this.moreOpen.set(false);
      this.accountOpen.set(false);
    });
  }

  /** Same check RouterLinkActive uses, so the highlight and aria-current always agree. */
  isActive(path: string): boolean {
    return this.router.isActive(path, { paths: 'subset', queryParams: 'ignored', fragment: 'ignored', matrixParams: 'ignored' });
  }

  /** The current page is one of those under More. */
  moreActive(): boolean {
    return this.moreItems().some((i) => this.isActive(i.path));
  }

  @HostListener('document:keydown.escape')
  closeMenus(): void {
    this.moreOpen.set(false);
    this.accountOpen.set(false);
  }

  /** Clicking anywhere else closes the account menu. */
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.accountOpen()) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.top-actions')) this.accountOpen.set(false);
  }

  logout(): void {
    this.moreOpen.set(false);
    this.accountOpen.set(false);
    this.auth.logout();
    this.socket.disconnect();
    this.router.navigate(['/login']);
  }
}
