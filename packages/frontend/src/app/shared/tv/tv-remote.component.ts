import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface Choice { id: string; label: string }
export interface TvRemote {
  on: boolean;
  volume: number | null;
  muted: boolean | null;
  input: string | null;
  app: string | null;
  inputs: Choice[];
  apps: Choice[];
}

/** A message on the TV's screen: a line or two. Matches the backend's limit. */
const MAX_MESSAGE = 200;

/**
 * An LG TV's remote, in its row on the dashboard: volume and mute, the input or app on screen,
 * and a message to show on the screen. On and off are the row's own switch.
 */
@Component({
  selector: 'app-tv-remote',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styles: [`
    .r { display: flex; flex-direction: column; gap: 0.7rem; }
    .vol { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .vol .what { width: 3.6rem; font-size: 0.85rem; color: var(--text-muted); }
    .vol .value { min-width: 2.2rem; text-align: center; font-size: 1.3rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .step { width: 2.6rem; height: 2.6rem; padding: 0; font-size: 1.3rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; }
    .mute { font-size: 0.8rem; padding: 0.45rem 0.8rem; border-radius: var(--radius); background: var(--bg); border: 1px solid var(--border); color: var(--text); }
    .mute[aria-pressed="true"] { border-color: #fbbf24; color: #fbbf24; }
    .pick { display: flex; flex-direction: column; gap: 0.25rem; }
    .pick span { font-size: 0.75rem; color: var(--text-muted); }
    .pick select { max-width: 100%; }
    .say { display: flex; gap: 0.4rem; }
    .say input { flex: 1 1 auto; min-width: 0; font-size: 0.85rem; padding: 0.45rem 0.6rem; }
    .say button { font-size: 0.8rem; padding: 0.45rem 0.9rem; border-radius: var(--radius); background: var(--bg); border: 1px solid var(--border); color: var(--text); }
    button:disabled, select:disabled { opacity: 0.5; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; }
    .note.err { color: #fbbf24; }
    .note.ok { color: var(--green); }
  `],
  template: `
    <div class="r">
      @if (remote(); as t) {
        @if (!t.on) {
          <p class="note">It's off. Turn it on with the switch above to use the remote.</p>
        } @else {
          <div class="vol">
            <span class="what">Volume</span>
            <button class="step" type="button" [disabled]="busy()" (click)="press({ step: 'down' })" aria-label="Volume down">−</button>
            <span class="value" aria-live="polite">{{ t.volume ?? '–' }}</span>
            <button class="step" type="button" [disabled]="busy()" (click)="press({ step: 'up' })" aria-label="Volume up">+</button>
            @if (t.muted !== null) {
              <button class="mute" type="button" [attr.aria-pressed]="t.muted" [disabled]="busy()" (click)="press({ mute: !t.muted })">{{ t.muted ? 'Muted' : 'Mute' }}</button>
            }
          </div>
          @if (t.volume === null) { <p class="note">The sound goes to a soundbar or receiver, so the TV can't say its volume. − and + still work.</p> }
          @if (t.inputs.length) {
            <label class="pick"><span>Input</span>
              <select [ngModel]="t.input ?? ''" (ngModelChange)="$event && press({ input: $event })" [disabled]="busy()">
                @if (!t.input) { <option value="">{{ t.app ? 'An app is on' : 'Choose an input' }}</option> }
                @for (i of t.inputs; track i.id) { <option [value]="i.id">{{ i.label }}</option> }
              </select>
            </label>
          }
          @if (t.apps.length) {
            <label class="pick"><span>App</span>
              <select [ngModel]="t.app ?? ''" (ngModelChange)="$event && press({ app: $event })" [disabled]="busy()">
                @if (!t.app || !hasApp(t)) { <option value="">{{ t.input ? 'An input is on' : 'Choose an app' }}</option> }
                @for (a of t.apps; track a.id) { <option [value]="a.id">{{ a.label }}</option> }
              </select>
            </label>
          }
          <label class="pick"><span>Show a message on the screen</span>
            <div class="say">
              <input type="text" [maxlength]="maxMessage" [(ngModel)]="message" placeholder="e.g. Dinner's ready" (keydown.enter)="send()" />
              <button type="button" [disabled]="busy() || !message.trim()" (click)="send()">Show</button>
            </div>
          </label>
        }
      } @else if (!error()) {
        <p class="note">Checking the TV…</p>
      }
      @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
      @else if (sent()) { <p class="note ok" role="status">{{ sent() }}</p> }
    </div>
  `,
})
export class TvRemoteComponent {
  private readonly http = inject(HttpClient);
  readonly deviceId = input.required<number>();
  /** The row's on/off: the remote reloads when it changes. */
  readonly on = input(false);

  readonly remote = signal<TvRemote | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly sent = signal('');
  readonly maxMessage = MAX_MESSAGE;
  message = '';

  constructor() {
    effect(() => {
      this.on();
      const id = this.deviceId();
      untracked(() => this.load(id));
    });
  }

  hasApp(t: TvRemote): boolean { return t.apps.some((a) => a.id === t.app); }

  private load(id: number): void {
    this.http.get<TvRemote>(`/api/lgtv/${id}/remote`).subscribe({
      next: (r) => { this.remote.set(r); this.error.set(''); },
      error: (e: HttpErrorResponse) => { this.error.set(e.error?.error ?? 'Couldn’t reach the TV.'); },
    });
  }

  press(body: Record<string, unknown>): void {
    this.busy.set(true);
    this.sent.set('');
    // − and + show at once; the TV's answer then says where it really is.
    const r = this.remote();
    if (r && r.volume !== null && body['step']) this.remote.set({ ...r, volume: Math.max(0, Math.min(100, r.volume + (body['step'] === 'up' ? 1 : -1))) });
    this.http.post<TvRemote>(`/api/lgtv/${this.deviceId()}/remote`, body).subscribe({
      next: (next) => { this.busy.set(false); this.remote.set(next); this.error.set(''); },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? 'The TV didn’t do that. Try again.');
        this.load(this.deviceId());
      },
    });
  }

  send(): void {
    const text = this.message.trim();
    if (!text || this.busy()) return;
    this.busy.set(true);
    this.sent.set('');
    this.http.post<TvRemote>(`/api/lgtv/${this.deviceId()}/remote`, { message: text }).subscribe({
      next: (next) => { this.busy.set(false); this.remote.set(next); this.error.set(''); this.message = ''; this.sent.set('Shown on the TV.'); },
      error: (e: HttpErrorResponse) => { this.busy.set(false); this.error.set(e.error?.error ?? 'The message wasn’t shown. Try again.'); },
    });
  }
}
