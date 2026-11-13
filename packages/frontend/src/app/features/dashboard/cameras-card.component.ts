import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { SocketService } from '../../core/socket/socket.service';
import { CamerasStateService } from '../../core/services/cameras-state.service';
import { AuthImgComponent } from '../cameras/auth-img.component';

interface Latest { id: number; cameraName: string; trigger: 'motion' | 'manual' | 'doorbell'; takenAt: string }
interface Summary { enabled: boolean; wyze: number; ring: number; ip: number; latest: Latest | null }

/**
 * Every camera at a glance on the Dashboard: how many of each brand, and the
 * newest picture. Ring and IP cameras have nothing to switch, so they aren't
 * device rows; this is where the Dashboard shows them. Tapping goes to Cameras.
 */
@Component({
  selector: 'app-cameras-card',
  standalone: true,
  imports: [RouterLink, AuthImgComponent],
  styles: [`
    :host { display: block; }
    .card.cams {
      display: flex; align-items: center; gap: 0.85rem; padding: 0.6rem 0.75rem; margin-bottom: 1rem;
      color: inherit; text-decoration: none;
    }
    .cams:hover { border-color: var(--accent); }
    .cams.rang { box-shadow: inset 3px 0 0 #f59e0b; }
    app-auth-img { width: 6rem; aspect-ratio: 16 / 9; border-radius: 6px; flex-shrink: 0; }
    .text { flex: 1; min-width: 0; }
    .title { font-weight: 700; font-size: 0.95rem; }
    .count { color: var(--text-muted); font-size: 0.78rem; font-weight: 400; margin-left: 0.35rem; }
    .latest { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rang .latest { color: #fbbf24; }
    .go { color: var(--text-muted); font-size: 1.1rem; }
  `],
  template: `
    @if (shown(); as s) {
      <a class="card cams" [class.rang]="recentRing()" routerLink="/cameras" [queryParams]="s.latest ? { tab: 'snapshots' } : null"
         [attr.aria-label]="'Cameras: ' + brands() + (s.latest ? '. Latest picture from ' + s.latest.cameraName + ', ' + ago(s.latest.takenAt) : '')">
        @if (s.latest; as l) {
          <app-auth-img [src]="'/api/cameras/snapshots/' + l.id + '/image'" [alt]="l.cameraName" failedText="" />
        }
        <span class="text">
          <span class="title">Cameras<span class="count">{{ brands() }}</span></span>
          <span class="latest" style="display:block">
            @if (s.latest; as l) {
              {{ l.cameraName }} · {{ l.trigger === 'doorbell' ? 'doorbell rang' : l.trigger === 'motion' ? 'motion' : 'snapshot' }} · {{ ago(l.takenAt) }}
            } @else {
              No pictures yet
            }
          </span>
        </span>
        <span class="go" aria-hidden="true">›</span>
      </a>
    }
  `,
})
export class CamerasCardComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly socket = inject(SocketService);
  private readonly cams = inject(CamerasStateService);

  readonly summary = signal<Summary | null>(null);
  /** Re-read now and then, so "5 min ago" stays right. */
  private readonly now = signal(Date.now());

  /** Only with cameras on and at least one camera. */
  readonly shown = computed(() => {
    const s = this.summary();
    return s && s.enabled && this.cams.visible() && s.wyze + s.ring + s.ip > 0 ? s : null;
  });

  readonly brands = computed(() => {
    const s = this.summary();
    if (!s) return '';
    const parts = [[s.wyze, 'Wyze'], [s.ring, 'Ring'], [s.ip, 'IP']] as const;
    return parts.filter(([n]) => n > 0).map(([n, name]) => `${n} ${name}`).join(' · ');
  });

  /** The doorbell rang in the last 15 minutes. */
  readonly recentRing = computed(() => {
    const l = this.summary()?.latest;
    return !!l && l.trigger === 'doorbell' && this.now() - Date.parse(l.takenAt) < 15 * 60_000;
  });

  private stopSnapshots?: () => void;
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    this.stopSnapshots = this.socket.onCameraSnapshot(() => this.load());
    this.timer = setInterval(() => {
      if (document.hidden) return;
      this.now.set(Date.now());
    }, 60_000);
  }

  ngOnDestroy(): void {
    this.stopSnapshots?.();
    if (this.timer) clearInterval(this.timer);
  }

  private load(): void {
    this.http.get<Summary>('/api/cameras/summary').subscribe({
      next: (s) => this.summary.set(s),
      error: () => undefined,   // an older server, or none: no card
    });
  }

  ago(iso: string): string {
    const mins = Math.round((this.now() - Date.parse(iso)) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}
