import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { HelpButtonComponent } from './help-button.component';
import { SosAlertComponent } from './sos-alert.component';
import type { Family, SosAlert } from './family.types';

/**
 * Just the "Call for help" button, big, for the person's own phone or tablet: add this page to
 * the Home Screen and it opens straight to the button. Shows the call once sent, and who's coming.
 */
@Component({
  selector: 'app-sos-page',
  standalone: true,
  imports: [RouterLink, HelpButtonComponent, SosAlertComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 1.4rem; align-items: center; padding-top: 1.5rem; }
    .back { align-self: flex-start; color: var(--text-muted); font-size: 0.9rem; }
    app-help-button { --size: min(70vw, 16rem); }
    app-sos-alert { width: 100%; max-width: 32rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; text-align: center; max-width: 26rem; line-height: 1.5; }
  `],
  template: `
    <div class="page">
      <a class="back" routerLink="/family">‹ Family</a>
      @if (open(); as a) {
        <app-sos-alert [alert]="a" [timezone]="timezone()" [forPerson]="true" (changed)="load()" />
      } @else {
        <app-help-button (sent)="open.set($event)" />
      }
      <p class="muted">You can also say “救命”, “cứu tôi với” or “help me” to a speaker. HomeHub doesn’t call 911.</p>
    </div>
  `,
})
export class SosPageComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  readonly open = signal<SosAlert | null>(null);
  readonly timezone = signal('UTC');
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.load(); }, 10_000);
  }

  load(): void {
    this.http.get<Family>('/api/family').subscribe({
      next: (f) => { this.open.set(f.sos.open); this.timezone.set(f.timezone); },
      error: () => undefined,
    });
  }

  ngOnDestroy(): void { clearInterval(this.timer); }
}
