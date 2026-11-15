import { ChangeDetectionStrategy, Component, OnDestroy, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { errorText, type SosAlert } from './family.types';

const HOLD_MS = 2000;

/**
 * The "Call for help" button: held for two seconds, so a tap in a pocket or by a grandchild
 * doesn't send it. A ring fills while it's held; letting go early sends nothing.
 */
@Component({
  selector: 'app-help-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .wrap { display: flex; flex-direction: column; align-items: center; gap: 0.7rem; text-align: center; }
    button.help {
      position: relative; width: var(--size, 9.5rem); height: var(--size, 9.5rem); border-radius: 50%;
      background: #dc2626; color: #fff; font-weight: 800; font-size: 1.15rem; line-height: 1.2; padding: 0.8rem;
      border: 4px solid #fecaca; box-shadow: 0 6px 18px rgba(220, 38, 38, 0.35); touch-action: none; user-select: none;
      -webkit-user-select: none; -webkit-touch-callout: none;
    }
    button.help:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
    button.help.holding { transform: scale(0.97); }
    svg { position: absolute; inset: -4px; width: calc(100% + 8px); height: calc(100% + 8px); transform: rotate(-90deg); pointer-events: none; }
    circle { fill: none; stroke: #fff; stroke-width: 5; stroke-linecap: round; }
    .hint { color: var(--text-muted); font-size: 0.85rem; max-width: 22rem; line-height: 1.45; }
    .sent { font-size: 1rem; font-weight: 600; }
    .err { color: var(--red); font-size: 0.85rem; }
    @media (prefers-reduced-motion: reduce) { button.help.holding { transform: none; } }
  `],
  template: `
    <div class="wrap">
      <button type="button" class="help" [class.holding]="progress() > 0"
              (pointerdown)="start($event)" (pointerup)="stop()" (pointerleave)="stop()" (pointercancel)="stop()"
              (keydown.enter)="startKey($event)" (keydown.space)="startKey($event)" (keyup.enter)="stop()" (keyup.space)="stop()"
              (contextmenu)="$event.preventDefault()" [disabled]="sending()"
              aria-label="Call for help: press and hold for two seconds">
        @if (progress() > 0) {
          <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47" pathLength="100" [attr.stroke-dasharray]="progress() + ' 100'" /></svg>
        }
        {{ sending() ? 'Sending…' : label() }}
      </button>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      @else if (progress() > 0) { <p class="hint" aria-live="polite">Keep holding…</p> }
      @else { <p class="hint">Press and hold for 2 seconds. The family is told at once, on their phones and by email.</p> }
    </div>
  `,
})
export class HelpButtonComponent implements OnDestroy {
  private readonly http = inject(HttpClient);
  readonly label = input('Call for help');
  readonly sent = output<SosAlert>();
  readonly progress = signal(0);
  readonly sending = signal(false);
  readonly error = signal('');
  private started = 0;
  private frame = 0;

  start(e: PointerEvent): void {
    if (e.button !== 0 || this.sending()) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.begin();
  }

  startKey(e: Event): void {
    e.preventDefault();
    if ((e as KeyboardEvent).repeat || this.started) return;
    this.begin();
  }

  private begin(): void {
    this.error.set('');
    this.started = performance.now();
    const step = () => {
      const p = Math.min(100, ((performance.now() - this.started) / HOLD_MS) * 100);
      this.progress.set(p);
      if (p >= 100) { this.reset(); this.send(); return; }
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  stop(): void { if (this.started) this.reset(); }

  private reset(): void {
    cancelAnimationFrame(this.frame);
    this.started = 0;
    this.progress.set(0);
  }

  private send(): void {
    this.sending.set(true);
    navigator.vibrate?.(200);
    this.http.post<{ state: string; alert: SosAlert }>('/api/family/sos', {}).subscribe({
      next: (r) => { this.sending.set(false); this.sent.emit(r.alert); },
      error: (e) => { this.sending.set(false); this.error.set(errorText(e, 'It couldn’t be sent. Phone someone for help.')); },
    });
  }

  ngOnDestroy(): void { cancelAnimationFrame(this.frame); }
}
