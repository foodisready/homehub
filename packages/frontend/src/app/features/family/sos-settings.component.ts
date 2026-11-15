import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { errorText, type SosView } from './family.types';

/** An admin's SOS settings: whose name it says, phone calls, buttons, and a test. */
@Component({
  selector: 'app-sos-settings',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .block + .block { margin-top: 1.1rem; padding-top: 1.1rem; border-top: 1px solid var(--border); }
    h3 { font-size: 0.95rem; margin: 0 0 0.45rem; }
    p { margin: 0; line-height: 1.5; font-size: 0.9rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-top: 0.5rem; }
    .row input[type=text] { flex: 1 1 12rem; min-width: 0; max-width: 18rem; }
    .row button, .acts button { min-height: 38px; padding: 0 1rem; }
    label.check { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.9rem; line-height: 1.45; }
    label.check input { width: auto; margin-top: 0.25rem; }
    .btn { padding: 0.7rem 0.8rem; border-radius: var(--radius); background: var(--bg); margin-top: 0.6rem; }
    .btn-head { display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
    .btn-head b { font-size: 0.95rem; }
    .url { display: grid; grid-template-columns: auto 1fr auto; gap: 0.4rem; align-items: center; margin-top: 0.4rem; font-size: 0.8rem; }
    .url code { overflow-wrap: anywhere; color: var(--text-muted); }
    .url button { font-size: 0.75rem; padding: 0.2rem 0.55rem; min-height: 30px; }
    .linkish { background: none; border: none; color: var(--text-muted); text-decoration: underline; padding: 0; font-size: 0.8rem; min-height: auto; }
    .ok { color: var(--green); font-size: 0.85rem; }
    .err { color: var(--red); font-size: 0.85rem; }
    a { color: var(--accent); }
  `],
  template: `
    <div class="block">
      <h3>Whose name it says</h3>
      <p class="muted">Alerts say “{{ sos().who }} asked for help”.</p>
      <div class="row">
        <input type="text" [(ngModel)]="who" name="who" maxlength="40" [placeholder]="sos().who" aria-label="Name in alerts" />
        <button type="button" class="btn-ghost" (click)="save({ who: who.trim() || null })" [disabled]="busy() || (who.trim() || null) === sos().settings.who">Save</button>
      </div>
    </div>

    <div class="block">
      <h3>Texts and phone calls</h3>
      @if (sos().texts) {
        <p>A text goes to {{ sos().texts }} {{ sos().texts === 1 ? 'number' : 'numbers' }} through your Twilio account.</p>
        <label class="check" style="margin-top:0.5rem">
          <input type="checkbox" [ngModel]="sos().settings.calls" (ngModelChange)="save({ calls: $event })" name="calls" [disabled]="busy()" />
          <span>Phone calls too: one number every 5 minutes, in turn, until someone says they’re on it. A call is the alert most likely to wake someone at night. About $0.014 a minute.</span>
        </label>
      } @else {
        <p class="muted">Push and email are free and always used. For texts and phone calls, add your Twilio account and the family’s numbers in <a routerLink="/settings" [queryParams]="{ section: 'integrations' }">Settings → Integrations</a>.</p>
      }
    </div>

    <div class="block">
      <h3>Buttons</h3>
      <p class="muted">A button by the bed or in the bathroom, for when speaking isn’t possible. A Shelly Button1 works without a hub: in the Shelly app, under Actions, paste the first address into “Button short press” and the second into “Button double press”. Anything that can visit an address on a press works too.</p>
      @for (b of sos().buttons; track b.id) {
        <div class="btn">
          <div class="btn-head">
            <b>{{ b.name }}</b>
            <span class="muted">{{ b.lastUsedAt ? 'Last pressed ' + when(b.lastUsedAt) : 'Not pressed yet' }}</span>
          </div>
          @if (b.help && b.cancel) {
            <div class="url"><span>Press:</span><code>{{ b.help }}</code><button type="button" class="btn-ghost" (click)="copy(b.help)">Copy</button></div>
            <div class="url"><span>Double:</span><code>{{ b.cancel }}</code><button type="button" class="btn-ghost" (click)="copy(b.cancel)">Copy</button></div>
          } @else {
            <p class="err">HomeHub couldn’t find its address on the home network.</p>
          }
          <div class="row"><button type="button" class="linkish" (click)="removeButton(b.id)">Remove</button></div>
        </div>
      }
      <div class="row">
        <input type="text" [(ngModel)]="buttonName" name="buttonName" maxlength="40" placeholder="Name, e.g. Bedside" aria-label="Button name" />
        <button type="button" class="btn-ghost" (click)="addButton()" [disabled]="busy() || !buttonName.trim()">Add a button</button>
      </div>
      @if (copied()) { <p class="ok" aria-live="polite">Copied.</p> }
    </div>

    <div class="block">
      <h3>Test it</h3>
      <p class="muted">Sends a message labelled as a test the same ways: push, email, texts, and a call to the first number if calls are on. It isn’t repeated and nobody needs to answer.</p>
      <div class="acts row">
        <button type="button" class="btn-ghost" (click)="test()" [disabled]="busy()">Send a test</button>
        @if (result()) { <span class="muted" aria-live="polite">{{ result() }}</span> }
      </div>
    </div>
    @if (error()) { <p class="err" role="alert" style="margin-top:0.8rem">{{ error() }}</p> }
  `,
})
export class SosSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly sos = input.required<SosView>();
  readonly changed = output<void>();
  readonly busy = signal(false);
  readonly error = signal('');
  readonly result = signal('');
  readonly copied = signal(false);
  who = '';
  buttonName = '';

  ngOnInit(): void { this.who = this.sos().settings.who ?? ''; }

  when(iso: string): string {
    return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  save(body: Record<string, unknown>): void {
    this.run(this.http.put('/api/family/sos/settings', body));
  }

  addButton(): void {
    this.run(this.http.post('/api/family/sos/buttons', { name: this.buttonName.trim() }), () => { this.buttonName = ''; });
  }

  removeButton(id: number): void {
    this.run(this.http.delete(`/api/family/sos/buttons/${id}`));
  }

  test(): void {
    this.result.set('');
    this.busy.set(true);
    this.http.post<{ phones: number; emails: number; texts: number; calls: number }>('/api/family/sos/test', {}).subscribe({
      next: (t) => {
        this.busy.set(false);
        const ways = [t.phones && `${t.phones} ${t.phones === 1 ? 'phone' : 'phones'}`, t.emails && `${t.emails} email ${t.emails === 1 ? 'address' : 'addresses'}`,
          t.texts && `${t.texts} by text`, t.calls && '1 call'].filter(Boolean);
        this.result.set(ways.length ? `Sent to ${ways.join(', ')}. Check that everyone got it.` : 'Nobody to send it to yet.');
      },
      error: (e) => { this.busy.set(false); this.error.set(errorText(e, 'The test couldn’t be sent.')); },
    });
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch { /* not allowed: the address is on screen to copy by hand */ }
  }

  private run(req: Observable<unknown>, then?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    req.subscribe({
      next: () => { this.busy.set(false); then?.(); this.changed.emit(); },
      error: (e) => { this.busy.set(false); this.error.set(errorText(e, 'That didn’t work. Try again.')); },
    });
  }
}
