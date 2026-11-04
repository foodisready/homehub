import { Component, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { inject } from '@angular/core';

type App = 'google' | 'apple' | 'alexa' | 'smartthings' | 'new';

const STEPS: Record<App, { label: string; steps: string[] }> = {
  google: {
    label: 'Google Home',
    steps: [
      'Open the Google Home app and select the device.',
      'Open its settings (⚙), then <b>Linked Matter apps &amp; services</b>.',
      'Select <b>Link apps &amp; services</b>. The app shows a pairing code.',
    ],
  },
  apple: {
    label: 'Apple Home',
    steps: [
      'Open the Home app, then press and hold the device and select <b>Settings</b>.',
      'Scroll down and select <b>Turn On Pairing Mode</b>.',
      'The app shows a setup code. Copy it.',
    ],
  },
  alexa: {
    label: 'Alexa',
    steps: [
      'Open the Alexa app and select <b>Devices</b>, then the device.',
      'Open its settings (⚙), then <b>Other assistants and apps</b>.',
      'Select <b>Add another</b>, then <b>Device</b>. The app shows a pairing code.',
    ],
  },
  smartthings: {
    label: 'SmartThings',
    steps: [
      'Open the SmartThings app and select the device.',
      'Select the menu (⋮), then <b>Share with other services</b>.',
      'The app shows a pairing code.',
    ],
  },
  new: {
    label: 'A new device',
    steps: [
      'A brand-new Matter device needs a phone app to join your Wi-Fi first: HomeHub can’t use Bluetooth.',
      'Add it with Google Home, Apple Home, Alexa or SmartThings, using the code on the device or its box.',
      'Then share it with HomeHub from that app, using the steps on its tab here.',
    ],
  },
};

/**
 * Settings → Devices → Add a Matter device. A device is shared with HomeHub
 * from another Matter app, which shows a pairing code to type here. Admin only.
 */
@Component({
  selector: 'app-matter-pair',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    :host { display:block; }
    .intro { font-size:0.82rem; color:var(--text-muted); line-height:1.5; margin:0 0 0.75rem; }
    .tabs { display:flex; gap:0.35rem; flex-wrap:wrap; margin-bottom:0.6rem; }
    .tab { background:transparent; border:1px solid var(--border); color:var(--text-muted); padding:0.3rem 0.7rem; font-size:0.8rem; border-radius:999px; }
    .tab.on { border-color:var(--accent); color:var(--text); background:rgba(59,130,246,0.15); }
    ol { margin:0 0 0.9rem 1.2rem; font-size:0.85rem; line-height:1.6; }
    .row { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; }
    .row input { flex:1; min-width:12rem; font-size:1rem; letter-spacing:0.04em; padding:0.5rem 0.7rem; }
    .hint { font-size:0.75rem; color:var(--text-muted); margin:0.35rem 0 0; }
    .msg { font-size:0.85rem; margin:0.6rem 0 0; line-height:1.45; }
    .ok { color:var(--green); }
    .err { color:var(--red); }
    .busy { color:var(--text-muted); }
    .btn-sm { padding:0.4rem 0.9rem; font-size:0.85rem; }
  `],
  template: `
    <p class="intro">
      Matter devices work with many apps at once. Share one with HomeHub from the app it's already in, and it stays there
      too. HomeHub then controls it directly on your network, without the cloud.
    </p>
    <div class="tabs" role="tablist" aria-label="Where the device is now">
      @for (a of apps; track a) {
        <button type="button" class="tab" role="tab" [class.on]="app() === a" [attr.aria-selected]="app() === a" (click)="app.set(a)">{{ steps[a].label }}</button>
      }
    </div>
    <ol>
      @for (s of steps[app()].steps; track $index) { <li [innerHTML]="s"></li> }
      @if (app() !== 'new') { <li>Enter the code here within a few minutes.</li> }
    </ol>
    <div class="row">
      <input [(ngModel)]="code" placeholder="e.g. 3497-011-2332" inputmode="numeric" autocomplete="off"
             aria-label="Matter pairing code" (keydown.enter)="pair()" [disabled]="busy()" />
      <button class="btn-sm btn-primary" type="button" (click)="pair()" [disabled]="busy() || !code.trim()">
        {{ busy() ? 'Adding…' : 'Add device' }}
      </button>
    </div>
    <p class="hint">11 digits, or the text of a QR code that starts with MT:</p>
    @if (busy()) { <p class="msg busy" role="status">Finding the device and pairing it. This can take up to a minute.</p> }
    @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()" role="status">{{ message() }}</p> }
  `,
})
export class MatterPairComponent {
  private readonly http = inject(HttpClient);

  /** Fired with the new devices once a pairing works. */
  readonly added = output<{ id: number; alias: string }[]>();

  readonly apps: App[] = ['google', 'apple', 'alexa', 'smartthings', 'new'];
  readonly steps = STEPS;
  readonly app = signal<App>('google');
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  code = '';

  pair(): void {
    const code = this.code.trim();
    if (!code || this.busy()) return;
    this.busy.set(true);
    this.message.set('');
    this.http.post<{ devices: { id: number; alias: string }[] }>('/api/matter/pair', { code }).subscribe({
      next: ({ devices }) => {
        this.busy.set(false);
        this.code = '';
        this.isError.set(false);
        const names = devices.map((d) => d.alias).join(', ');
        this.message.set(devices.length === 1
          ? `Added ${names}. Rename it or pick its room below.`
          : `Added ${devices.length} devices: ${names}. Rename them or pick rooms below.`);
        this.added.emit(devices);
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.isError.set(true);
        this.message.set(err.error?.error ?? 'The device couldn’t be added. Try again.');
      },
    });
  }
}
