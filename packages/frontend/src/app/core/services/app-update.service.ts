import { Injectable, inject } from '@angular/core';
import { NavigationError, NavigationStart, Router } from '@angular/router';

/** Errors browsers give when a lazily loaded page's file is gone. */
const MISSING_CHUNK = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|ChunkLoadError/i;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const RELOAD_KEY = 'homehub-chunk-reload';

/**
 * Keeps an open tab from running an old HomeHub after an update.
 *
 * Each release renames the app's files. A tab opened before the update still
 * has the old main file, so opening a page it hasn't loaded yet (Settings,
 * say) asks for a file that no longer exists and fails. This notices the new
 * release, by comparing the main file the server now names with the one this
 * tab loaded, and makes the next navigation a full page load. If a page's
 * file is missing anyway, it reloads that page once.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly router = inject(Router);
  private readonly loaded = AppUpdateService.mainFile(document.documentElement.outerHTML);
  private stale = false;
  private checking = false;

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
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
    window.addEventListener('online', () => this.check());
    setInterval(() => this.check(), CHECK_EVERY_MS);
    // A reload that worked: allow another one later.
    setTimeout(() => sessionStorage.removeItem(RELOAD_KEY), 10_000);
  }

  /** Asks the server which main file it serves now. */
  check(): void {
    if (!this.loaded || this.stale || this.checking) return;
    this.checking = true;
    fetch('/', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((html) => {
        const now = AppUpdateService.mainFile(html);
        if (now && now !== this.loaded) this.stale = true;
      })
      .catch(() => undefined)   // offline or restarting: try again later
      .finally(() => { this.checking = false; });
  }

  private reloadOnce(url: string): void {
    // Never loop: if the file is still missing straight after a reload, stay put.
    if (sessionStorage.getItem(RELOAD_KEY)) return;
    sessionStorage.setItem(RELOAD_KEY, '1');
    window.location.assign(url);
  }
}
