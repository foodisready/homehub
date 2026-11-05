import { Component, OnDestroy, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';

/**
 * An image from HomeHub's API. A plain <img src> can't send the sign-in
 * token, so this fetches the picture with it and shows it from memory.
 * `refreshSeconds` reloads it on a timer, keeping the old picture until the
 * new one arrives.
 */
@Component({
  selector: 'app-auth-img',
  standalone: true,
  styles: [`
    :host { display: block; position: relative; background: #0b1220; overflow: hidden; }
    img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .empty {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: var(--text-muted); font-size: 0.8rem; text-align: center; padding: 0.5rem;
    }
  `],
  template: `
    @if (url()) {
      <img [src]="url()" [alt]="alt()" (load)="loaded.set(true)" />
    }
    @if (!url() || failed()) {
      <div class="empty">{{ failed() ? (failedText() || 'No picture') : 'Loading…' }}</div>
    }
  `,
})
export class AuthImgComponent implements OnDestroy {
  private readonly http = inject(HttpClient);

  readonly src = input.required<string>();
  readonly alt = input('');
  readonly refreshSeconds = input(0);
  readonly failedText = input('');
  /** Whether each load brought a picture. */
  readonly result = output<boolean>();

  readonly url = signal<string | null>(null);
  readonly failed = signal(false);
  readonly loaded = signal(false);

  private sub?: Subscription;
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => {
      const src = this.src();
      const every = this.refreshSeconds();
      untracked(() => {
        this.load(src);
        if (this.timer) clearInterval(this.timer);
        if (every > 0) this.timer = setInterval(() => this.load(src), every * 1000);
      });
    });
  }

  private load(src: string): void {
    // Skip a refresh while the page is in the background.
    if (this.url() && typeof document !== 'undefined' && document.hidden) return;
    this.sub?.unsubscribe();
    this.sub = this.http.get(src, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const old = this.url();
        this.url.set(URL.createObjectURL(blob));
        this.failed.set(false);
        if (old) URL.revokeObjectURL(old);
        this.result.emit(true);
      },
      error: () => {
        // Keep the last good picture on a failed refresh.
        if (!this.url()) this.failed.set(true);
        this.result.emit(false);
      },
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    const url = this.url();
    if (url) URL.revokeObjectURL(url);
  }
}
