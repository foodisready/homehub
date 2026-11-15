import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { errorText, howText, timeIn, type SosAlert } from './family.types';

/**
 * A call for help that's still going: who, how and when, who has been told, and the two things
 * to do: "I'm on it" (the others stop being called, and the person hears who's coming) or
 * "Cancel" (they're OK).
 */
@Component({
  selector: 'app-sos-alert',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .banner { border-radius: var(--radius); padding: 1rem 1.15rem; border: 2px solid #dc2626; background: rgba(220, 38, 38, 0.14); }
    .banner.on-it { border-color: #f59e0b; background: rgba(245, 158, 11, 0.12); }
    h2 { margin: 0 0 0.35rem; font-size: 1.2rem; font-weight: 800; color: var(--text); text-transform: none; letter-spacing: 0; }
    p { margin: 0.2rem 0 0; line-height: 1.5; font-size: 0.92rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .acts { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.85rem; }
    .acts button { min-height: 44px; padding: 0 1.1rem; border-radius: var(--radius); font-weight: 700; font-size: 0.95rem; }
    .on { background: #dc2626; color: #fff; }
    .cancel { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .err { color: var(--red); font-size: 0.85rem; margin-top: 0.5rem; }
  `],
  template: `
    @if (alert(); as a) {
      <div class="banner" [class.on-it]="!!a.ackedBy" role="alert">
        @if (forPerson()) {
          <h2>{{ a.ackedBy ? a.ackedBy + ' is coming' : 'The family has been told' }}</h2>
          <p>{{ a.ackedBy ? a.ackedBy + ' knows you need help.' : 'HomeHub keeps telling them until someone answers.' }}</p>
          <div class="acts"><button type="button" class="cancel" (click)="act('cancel')" [disabled]="busy()">Cancel: I’m OK</button></div>
        } @else {
          <h2>{{ a.ackedBy ? a.ackedBy + ' is on it' : a.who + ' asked for help' }}</h2>
          <p>{{ a.who }} asked for help {{ how() }} at {{ at() }}.@if (a.heard) { They said “{{ a.heard }}”. }</p>
          <p class="muted">{{ status() }}</p>
          <div class="acts">
            @if (!a.ackedBy) { <button type="button" class="on" (click)="act('ack')" [disabled]="busy()">I’m on it</button> }
            <button type="button" class="cancel" (click)="act('cancel')" [disabled]="busy()">Cancel: {{ a.who }} is OK</button>
          </div>
        }
        @if (error()) { <p class="err">{{ error() }}</p> }
        @if (!forPerson()) { <p class="muted" style="margin-top:0.7rem">HomeHub doesn’t call 911. If you can’t reach {{ a.who }}, call emergency services.</p> }
      </div>
    }
  `,
})
export class SosAlertComponent {
  private readonly http = inject(HttpClient);
  readonly alert = input<SosAlert | null>(null);
  readonly timezone = input('UTC');
  /** Shown to the person who asked for help, on their own device: no "I'm on it". */
  readonly forPerson = input(false);
  readonly changed = output<void>();
  readonly busy = signal(false);
  readonly error = signal('');

  readonly how = computed(() => { const a = this.alert(); return a ? howText(a) : ''; });
  readonly at = computed(() => { const a = this.alert(); return a ? timeIn(a.startedAt, this.timezone()) : ''; });

  readonly status = computed(() => {
    const a = this.alert();
    if (!a) return '';
    if (a.ackedBy) return `${a.ackedBy} said they’re on it at ${timeIn(a.ackedAt!, this.timezone())}. HomeHub has stopped calling the others${a.via === 'app' ? '' : ' and told ' + a.who + ' who’s coming'}.`;
    const t = a.told;
    const ways = t ? [
      t.phones ? `${t.phones} ${t.phones === 1 ? 'phone' : 'phones'}` : '',
      t.emails ? `${t.emails} email ${t.emails === 1 ? 'address' : 'addresses'}` : '',
      t.texts ? `${t.texts} ${t.texts === 1 ? 'number' : 'numbers'} by text` : '',
      t.calls ? 'a phone call' : '',
    ].filter(Boolean) : [];
    const told = ways.length ? `Told: ${ways.join(', ')}.` : 'Telling the family…';
    return `${told} Asked ${a.rounds} ${a.rounds === 1 ? 'time' : 'times'} so far; HomeHub asks again every 5 minutes until someone is on it.`;
  });

  act(what: 'ack' | 'cancel'): void {
    const a = this.alert();
    if (!a) return;
    this.busy.set(true);
    this.error.set('');
    this.http.post(`/api/family/sos/${a.id}/${what}`, {}).subscribe({
      next: () => { this.busy.set(false); this.changed.emit(); },
      error: (e) => { this.busy.set(false); this.error.set(errorText(e, 'That didn’t work. Try again.')); },
    });
  }
}
