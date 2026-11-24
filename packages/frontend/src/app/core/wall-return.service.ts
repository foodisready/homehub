import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AppUpdateService } from './services/app-update.service';
import { isWallHome, wallGoHome } from './wall-home';

/** Left this long without a touch, a wall display goes back to its top. */
export const RETURN_AFTER_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 1000;

/**
 * A wall display finds its way home. Someone opens a room or the cameras and walks off: after two
 * minutes without a touch the screen is back on the wall display, at the top, with any room
 * closed. Not while a camera is playing, which someone may be watching, nor on the sign-in page.
 */
@Injectable({ providedIn: 'root' })
export class WallReturnService {
  private readonly router = inject(Router);
  private lastTouch = Date.now();
  /** Gone home since the last touch, or nothing touched yet: nothing to do. */
  private home = true;

  start(): void {
    const touched = () => { this.lastTouch = Date.now(); this.home = false; };
    for (const kind of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(kind, touched, { capture: true, passive: true });
    setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  check(now = Date.now()): void {
    if (this.home || !isWallHome() || document.visibilityState !== 'visible') return;
    if (now - this.lastTouch < RETURN_AFTER_MS || AppUpdateService.watching()) return;
    const path = location.pathname;
    if (path === '/login') return;
    this.home = true;
    if (path !== '/wall') { void this.router.navigateByUrl('/wall'); return; }
    wallGoHome.update((n) => n + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
