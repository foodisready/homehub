import { Component, ElementRef, NgZone, OnDestroy, afterNextRender, afterRenderEffect, inject, input, output, untracked, viewChild } from '@angular/core';

/** How long the slide to the next picture, or back, takes. */
const SLIDE_MS = 250;

/**
 * One snapshot, with the newer one to its left and the older one to its
 * right, ready to swipe between like a phone's photo viewer.
 *
 * The finger is followed outside Angular, by moving the strip of three
 * pictures directly on each animation frame: running change detection for
 * every touch movement makes the swipe stutter on a phone.
 */
@Component({
  selector: 'app-snapshot-swiper',
  standalone: true,
  styles: [`
    :host { display: block; position: relative; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: #0b1220; touch-action: pan-y pinch-zoom; user-select: none; -webkit-user-select: none; }
    .track { display: flex; width: 300%; height: 100%; transform: translate3d(-33.3333%, 0, 0); will-change: transform; }
    .slide { flex: 0 0 33.3333%; height: 100%; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 0.85rem; }
    img { display: block; width: 100%; height: 100%; object-fit: contain; -webkit-user-drag: none; pointer-events: none; }
  `],
  template: `
    <div class="track" #track>
      <div class="slide" aria-hidden="true">@if (prev(); as url) { <img [src]="url" alt="" /> } @else if (canPrev()) { Loading… }</div>
      <div class="slide">@if (current(); as url) { <img [src]="url" [alt]="alt()" /> } @else { Loading… }</div>
      <div class="slide" aria-hidden="true">@if (next(); as url) { <img [src]="url" alt="" /> } @else if (canNext()) { Loading… }</div>
    </div>
  `,
})
export class SnapshotSwiperComponent implements OnDestroy {
  private readonly zone = inject(NgZone);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');

  /** Picture URLs: the one showing, the newer one (left) and the older one (right). */
  readonly current = input<string | null>(null);
  readonly prev = input<string | null>(null);
  readonly next = input<string | null>(null);
  /** Whether there's a picture that way, loaded or not. */
  readonly canPrev = input(false);
  readonly canNext = input(false);
  readonly alt = input('');
  /** Swiped: -1 to the newer picture, 1 to the older one. */
  readonly step = output<-1 | 1>();

  private start: { x: number; y: number; t: number; width: number; horizontal: boolean | null } | null = null;
  private dx = 0;
  private frame = 0;
  /** Slid to a neighbour and waiting for it to become the current picture. */
  private sliding = false;
  private slideTimer?: ReturnType<typeof setTimeout>;
  private readonly cleanup: (() => void)[] = [];

  constructor() {
    afterNextRender(() => this.zone.runOutsideAngular(() => this.listen()));
    // Once the neighbour has become the current picture, centre the strip
    // again, without animating, in the same frame: no jump is seen.
    afterRenderEffect(() => {
      this.current();
      untracked(() => { if (this.sliding) this.centre(); });
    });
  }

  private listen(): void {
    const el = this.host.nativeElement;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, passive: boolean) => {
      el.addEventListener(type, fn as EventListener, { passive });
      this.cleanup.push(() => el.removeEventListener(type, fn as EventListener));
    };
    on('touchstart', (e) => this.onStart(e), true);
    // Not passive, so a sideways swipe can stop the page scrolling.
    on('touchmove', (e) => this.onMove(e), false);
    on('touchend', () => this.onEnd(), true);
    on('touchcancel', () => this.onEnd(true), true);
  }

  private onStart(e: TouchEvent): void {
    // Two fingers: pinch-zoom. Mid-slide: let it finish.
    if (e.touches.length !== 1 || this.sliding) { this.start = null; return; }
    const t = e.touches[0];
    this.start = { x: t.clientX, y: t.clientY, t: e.timeStamp, width: this.host.nativeElement.clientWidth, horizontal: null };
    this.dx = 0;
    this.track().nativeElement.style.transition = 'none';
  }

  private onMove(e: TouchEvent): void {
    const s = this.start;
    if (!s || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - s.x;
    const dy = e.touches[0].clientY - s.y;
    // Decide once, after a little movement, whether this is a sideways swipe.
    if (s.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) s.horizontal = Math.abs(dx) > Math.abs(dy);
    if (!s.horizontal) return;
    e.preventDefault();
    // Resist at either end, where there's no picture to move to.
    const open = dx < 0 ? this.canNext() : this.canPrev();
    this.dx = open ? dx : dx / 3;
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.place(this.dx, s.width); });
  }

  private onEnd(cancel = false): void {
    const s = this.start;
    this.start = null;
    if (!s || !s.horizontal) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const dx = this.dx;
    const dir: -1 | 1 = dx < 0 ? 1 : -1;
    const open = dir === 1 ? this.canNext() : this.canPrev();
    // Far enough, or a quick flick.
    const flick = Math.abs(dx) > 30 && Math.abs(dx) / Math.max(1, (performance.now() - s.t)) > 0.4;
    if (!cancel && open && (Math.abs(dx) > s.width * 0.2 || flick)) {
      this.sliding = true;
      this.animate(-dir * s.width, s.width);
      clearTimeout(this.slideTimer);
      this.slideTimer = setTimeout(() => {
        this.zone.run(() => this.step.emit(dir));
        // If the picture didn't change (an older page failed to load), come back.
        this.slideTimer = setTimeout(() => { if (this.sliding) this.centre(true); }, 3000);
      }, SLIDE_MS);
    } else {
      this.animate(0, s.width);
    }
  }

  /** Moves the strip `dx` px from centre. */
  private place(dx: number, width: number): void {
    this.track().nativeElement.style.transform = `translate3d(${-width + dx}px, 0, 0)`;
  }

  private animate(dx: number, width: number): void {
    const el = this.track().nativeElement;
    el.style.transition = `transform ${SLIDE_MS}ms ease-out`;
    this.place(dx, width);
  }

  /** Back to the middle picture: at once after a slide, or animated when it came to nothing. */
  private centre(animated = false): void {
    this.sliding = false;
    clearTimeout(this.slideTimer);
    const el = this.track().nativeElement;
    el.style.transition = animated ? `transform ${SLIDE_MS}ms ease-out` : 'none';
    el.style.transform = '';
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.slideTimer);
    for (const off of this.cleanup) off();
  }
}
