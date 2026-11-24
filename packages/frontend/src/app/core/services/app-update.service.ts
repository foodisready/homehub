import { Injectable, inject, signal } from '@angular/core';
import { NavigationError, NavigationStart, Router } from '@angular/router';

/** Errors browsers give when a lazily loaded page's file is gone. */
const MISSING_CHUNK = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|ChunkLoadError/i;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const RELOAD_KEY = 'homehub-chunk-reload';
/** How long nobody must have touched the screen before an open page reloads itself for an update. */
const UNTOUCHED_MS = 90 * 1000;
const IDLE_CHECK_MS = 15 * 1000;

/**
 * Keeps an open tab from running an old HomeHub after an update.
 *
 * Each release renames the app's files. A tab opened before the update still
 * has the old main file, so opening a page it hasn't loaded yet (Settings,
 * say) asks for a file that no longer exists and fails. This notices the new
 * release, by comparing the main file the server now names with the one this
 * tab loaded, and makes the next navigation a full page load. A tab that
 * comes back to the front (a phone picked up again) reloads straight away,
 * unless something is being edited. A page that stays on screen (a wall
 * tablet) reloads once nobody has touched it for a minute and a half. If a
 * page's file is missing anyway, it reloads that page once.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly router = inject(Router);
  private readonly loaded = AppUpdateService.mainFile(document.documentElement.outerHTML);
  private stale = false;
  /** This page is an older version than the server's: it reloads once nobody's using it. */
  readonly outdated = signal(false);
  private checking = false;
  private lastTouch = Date.now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  /** "main-ABC123.js" from a page's HTML, or null in a development build. */
  static mainFile(html: string): string | null {
    return /<script[^>]+src="\/?(main[-.][\w-]+\.js)"/.exec(html)?.[1] ?? null;
  }

  start(): void {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart && this.stale) {
        // Load the new release instead of navigating inside the old one.
        window.location.assign(event.url);
      }
      if (event instanceof NavigationError && MISSING_CHUNK.test(String(event.error?.message ?? event.error))) {
        this.reloadOnce(event.url);
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(true); });
    for (const kind of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(kind, () => { this.lastTouch = Date.now(); }, { capture: true, passive: true });
    }
    window.addEventListener('online', () => this.check());
    setInterval(() => this.check(), CHECK_EVERY_MS);
    // A reload that worked: allow another one later.
    setTimeout(() => sessionStorage.removeItem(RELOAD_KEY), 10_000);
  }

  /** Asks the server which main file it serves now. returning: the tab just came back to the front. */
  check(returning = false): void {
    if (!this.loaded || this.checking) return;
    if (this.stale) { if (returning) this.reloadIfIdle(); return; }
    this.checking = true;
    fetch('/', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((html) => {
        const now = AppUpdateService.mainFile(html);
        if (now && now !== this.loaded) {
          this.stale = true;
          this.outdated.set(true);
          if (returning) this.reloadIfIdle();
          this.reloadWhenUntouched();
        }
      })
      .catch(() => undefined)   // offline or restarting: try again later
      .finally(() => { this.checking = false; });
  }

  /** Nothing open to lose: no popup or dialog, and no box being typed in. */
  static idle(doc: Document = document): boolean {
    const active = doc.activeElement;
    const typing = !!active && active.matches('input, textarea, select, [contenteditable="true"]');
    return !typing && !doc.querySelector('.popup-overlay, [role="dialog"], [role="alertdialog"]');
  }

  /** A camera is playing, or something other than the whole page is full screen: someone may be watching. */
  static watching(doc: Document = document): boolean {
    const full = doc.fullscreenElement;
    if (full && full !== doc.documentElement) return true;
    return [...doc.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
  }

  private reloadIfIdle(): void {
    if (AppUpdateService.idle()) window.location.reload();
  }

  /** Once there's an update, reloads a page left on screen as soon as nobody is using it. */
  private reloadWhenUntouched(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;   // coming back to it reloads instead
      if (Date.now() - this.lastTouch < UNTOUCHED_MS) return;
      if (AppUpdateService.watching()) return;
      this.reloadIfIdle();
    }, IDLE_CHECK_MS);
  }

  private reloadOnce(url: string): void {
    // Never loop: if the file is still missing straight after a reload, stay put.
    if (sessionStorage.getItem(RELOAD_KEY)) return;
    sessionStorage.setItem(RELOAD_KEY, '1');
    window.location.assign(url);
  }
}
