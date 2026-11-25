import { Injectable, effect, inject, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { AppUpdateService } from './services/app-update.service';
import { LockService } from './lock/lock.service';
import { isWallHome, wallGoHome } from './wall-home';

/** Left this long without a touch, a wall display goes back to its top. */
export const RETURN_AFTER_MS = 2 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 1000;

/**
 * A wall display finds its way home. Someone opens a room or the cameras and walks off: after two
 * minutes without a touch the screen is back on the wall display, at the top, with any room
 * closed. Not while a camera is playing, which someone may be watching, nor on the sign-in page.
 *
 * Locking ends a visit too: the screen goes home under the lock, so the PIN opens the wall display,
 * not the page the last person left. And a tablet whose screen went off part way through a visit
 * (only the wall display keeps it on) goes home the moment it wakes, before the first tap.
 */
@Injectable({ providedIn: 'root' })
export class WallReturnService {
  private readonly router = inject(Router);
  private readonly lock = inject(LockService);
  private lastTouch = Date.now();
  /** Gone home since the last touch, or nothing touched yet: nothing to do. */
  private home = true;

  constructor() {
    // Locked, but not just asked for the PIN to do something (such as leaving the wall display).
    effect(() => {
      if (this.lock.locked() && this.lock.asking() === null) untracked(() => this.goHome());
    });
  }

  start(): void {
    // Opened or reloaded away from the wall display (an update, a notification, Android bringing a
    // discarded tab back): that's a visit too, from now.
    if (isWallHome() && location.pathname !== '/wall') this.home = false;
    const touched = () => {
      // A touch on the lock screen isn't a visit going on: it's someone coming to unlock.
      if (this.lock.locked()) return;
      this.lastTouch = Date.now(); this.home = false;
    };
    for (const kind of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(kind, touched, { capture: true, passive: true });
    setInterval(() => this.check(), CHECK_EVERY_MS);
    // The checks wait while the page is hidden; on waking, check at once, before anyone touches it.
    document.addEventListener('visibilitychange', () => this.check());
  }

  check(now = Date.now()): void {
    if (this.home || !isWallHome() || document.visibilityState !== 'visible') return;
    if (now - this.lastTouch < RETURN_AFTER_MS || AppUpdateService.watching()) return;
    this.goHome();
  }

  /** To the top of the wall display, from wherever this wall tablet is (bar the sign-in page). */
  private goHome(): void {
    if (!isWallHome()) return;
    const path = location.pathname;
    if (path === '/login') return;
    this.home = true;
    if (path !== '/wall') { void this.router.navigateByUrl('/wall'); return; }
    wallGoHome.update((n) => n + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
