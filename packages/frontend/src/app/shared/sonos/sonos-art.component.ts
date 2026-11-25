import { ChangeDetectionStrategy, Component, OnDestroy, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';

/** Covers already fetched through HomeHub, by their address: reused as the page re-reads the speakers. */
const fetched = new Map<string, string>();
const MAX_KEPT = 80;

/**
 * A Sonos cover: a web image shown directly, or a picture kept on the speaker, fetched through
 * HomeHub (/api/sonos/:id/art) since a plain <img> can't send the sign-in. A music note without one.
 */
@Component({
  selector: 'app-sonos-art',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: grid; place-items: center; overflow: hidden; border-radius: 6px; background: var(--border); color: var(--text-muted); flex: none; }
    img { width: 100%; height: 100%; object-fit: cover; display: block; }
    svg { width: 45%; height: 45%; }
  `],
  template: `
    @if (url(); as u) {
      <img [src]="u" alt="" loading="lazy" referrerpolicy="no-referrer" (error)="url.set(null)" />
    } @else {
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 18V5l11-2v13a3 3 0 1 1-2-2.83V7.3l-7 1.27V18a3 3 0 1 1-2-2.83z" /></svg>
    }
  `,
})
export class SonosArtComponent implements OnDestroy {
  private readonly http = inject(HttpClient);
  readonly deviceId = input.required<number>();
  readonly art = input<string | null | undefined>(null);
  readonly url = signal<string | null>(null);
  private sub?: Subscription;

  constructor() {
    effect(() => {
      const art = this.art();
      const id = this.deviceId();
      untracked(() => this.show(art ?? null, id));
    });
  }

  private show(art: string | null, id: number): void {
    this.sub?.unsubscribe();
    if (!art) { this.url.set(null); return; }
    if (/^https:\/\//i.test(art)) { this.url.set(art); return; }
    if (!art.startsWith('/')) { this.url.set(null); return; }
    const have = fetched.get(art);
    if (have) { this.url.set(have); return; }
    this.url.set(null);
    this.sub = this.http.get(`/api/sonos/${id}/art`, { params: { u: art }, responseType: 'blob' }).subscribe({
      next: (blob) => {
        const u = URL.createObjectURL(blob);
        if (fetched.size >= MAX_KEPT) {
          const [oldKey, oldUrl] = fetched.entries().next().value as [string, string];
          fetched.delete(oldKey);
          URL.revokeObjectURL(oldUrl);
        }
        fetched.set(art, u);
        this.url.set(u);
      },
      error: () => this.url.set(null),
    });
  }

  ngOnDestroy(): void { this.sub?.unsubscribe(); }
}
