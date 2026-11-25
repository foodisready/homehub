import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LockService } from '../../core/lock/lock.service';
import { isWallHome } from '../../core/wall-home';

/**
 * Settings → Lock HomeHub: this phone or tablet asks for its person's PIN when HomeHub is opened
 * again after being away for a while. The PIN is the login's (the same as the wall display's);
 * whether this device locks, and after how long, is this device's own choice.
 */
@Component({
  selector: 'app-device-lock',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 0.75rem; }
    p { margin: 0; font-size: 0.85rem; line-height: 1.45; }
    .muted { color: var(--text-muted); font-size: 0.8rem; }
    .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.92rem; font-weight: 500; }
    .check input { width: auto; }
    label.f { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.78rem; color: var(--text-muted); }
    .pin { width: 7.5rem; letter-spacing: 0.2em; -webkit-text-security: disc; }
    select { width: auto; }
    .linkish { background: none; border: 0; padding: 0; color: var(--accent); font-size: inherit; text-decoration: underline; }
    .danger { background: none; border: 1px solid var(--red); color: var(--red); }
    .err { color: var(--red); font-size: 0.82rem; }
    .ok { color: #4ade80; font-size: 0.82rem; }
  `],
  template: `
    @if (wall) {
      <p>This tablet is a wall display. Its lock is in the wall display’s ⋯ menu, and locks after a while without a touch.</p>
    } @else if (lock.pinSet() === null) {
      <p class="muted">Checking…</p>
    } @else if (!lock.pinSet() || mode() === 'change') {
      <p>{{ lock.pinSet() ? 'Enter your PIN now, then the new one.' : 'Choose a PIN first. It’s yours: it opens HomeHub on any of your devices that lock, and the wall display.' }}</p>
      <div class="row">
        @if (lock.pinSet()) { <label class="f">PIN now <input class="pin" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore maxlength="8" [(ngModel)]="current" /></label> }
        <label class="f">New PIN <input class="pin" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore maxlength="8" placeholder="4–8 digits" [(ngModel)]="pinNew" /></label>
        <label class="f">Again <input class="pin" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore maxlength="8" [(ngModel)]="pinAgain" /></label>
      </div>
      <div class="row">
        <button type="button" class="btn-primary" [disabled]="busy()" (click)="savePin()">Save PIN</button>
        @if (mode() === 'change') { <button type="button" class="linkish" (click)="reset()">Cancel</button> }
      </div>
    } @else if (mode() === 'remove') {
      <p>Removing the PIN stops every device of yours from locking, the wall display too.</p>
      <div class="row">
        <label class="f">PIN now <input class="pin" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" data-lpignore="true" data-1p-ignore maxlength="8" [(ngModel)]="current" /></label>
        <button type="button" class="danger" [disabled]="busy()" (click)="removePin()">Remove PIN</button>
        <button type="button" class="linkish" (click)="reset()">Cancel</button>
      </div>
    } @else {
      <label class="check"><input type="checkbox" [ngModel]="on()" (ngModelChange)="setOn($event)" /> Lock HomeHub on this device</label>
      <div class="row">
        <label class="f">Ask for the PIN when it’s opened again
          <select [ngModel]="minutes()" (ngModelChange)="setMinutes($event)" [disabled]="!on()">
            @for (m of choices; track m) { <option [ngValue]="m">{{ m === 0 ? 'right away' : 'after ' + m + (m === 1 ? ' minute' : ' minutes') + ' away' }}</option> }
          </select>
        </label>
      </div>
      @if (on()) { <div class="row"><button type="button" (click)="lock.lockNow()">Lock now</button></div> }
      <p class="muted">
        Away means HomeHub was closed, or another app or the phone’s lock screen was in front of it.
        If the PIN is forgotten, “Forgot the PIN?” on the lock screen signs out; sign in again with your password.
        This keeps HomeHub from someone who picks up the phone unlocked; the phone’s own screen lock still matters most.
      </p>
      <p class="muted"><button type="button" class="linkish" (click)="mode.set('change'); msg.set('')">Change PIN</button> · <button type="button" class="linkish" (click)="mode.set('remove'); msg.set('')">Remove PIN</button></p>
    }
    @if (err()) { <p class="err" role="alert">{{ err() }}</p> }
    @if (msg()) { <p class="ok" role="status">{{ msg() }}</p> }
  `,
})
export class DeviceLockComponent {
  readonly lock = inject(LockService);
  readonly wall = isWallHome();
  readonly choices = [0, 1, 5, 15, 60];

  /** This device locks after being away (a wall tablet's own lock isn't counted). */
  readonly on = computed(() => this.lock.settings().auto && !!this.lock.settings().away);
  readonly minutes = computed(() => (this.lock.settings().away ? this.lock.settings().idleMinutes : 1));

  readonly mode = signal<'' | 'change' | 'remove'>('');
  readonly busy = signal(false);
  readonly err = signal('');
  readonly msg = signal('');
  current = '';
  pinNew = '';
  pinAgain = '';

  setOn(on: boolean): void {
    this.lock.saveSettings({ auto: on, away: true, idleMinutes: this.minutes() });
    this.msg.set(on ? 'This device now asks for your PIN when HomeHub is opened again.' : 'This device won’t lock.');
  }

  setMinutes(m: number): void {
    this.lock.saveSettings({ ...this.lock.settings(), away: true, idleMinutes: Number(m) });
  }

  reset(): void {
    this.mode.set(''); this.err.set('');
    this.current = this.pinNew = this.pinAgain = '';
  }

  savePin(): void {
    this.err.set(''); this.msg.set('');
    if (!/^\d{4,8}$/.test(this.pinNew)) { this.err.set('A PIN is 4 to 8 digits.'); return; }
    if (this.pinNew !== this.pinAgain) { this.err.set('The two PINs aren’t the same.'); return; }
    const first = !this.lock.pinSet();
    // A first PIN here is for locking this device, after a minute away unless chosen otherwise.
    const was = this.lock.settings();
    this.busy.set(true);
    this.lock.setPin(this.pinNew, this.current || undefined).subscribe({
      next: () => {
        this.busy.set(false);
        if (first) this.lock.saveSettings({ auto: true, away: true, idleMinutes: was.away ? was.idleMinutes : 1 });
        this.reset();
        this.msg.set(first ? 'PIN saved. This device now asks for it when HomeHub is opened again after a minute away.' : 'PIN changed.');
      },
      error: (e) => { this.busy.set(false); this.err.set(e?.error?.error ?? 'The PIN couldn’t be saved.'); },
    });
  }

  removePin(): void {
    this.err.set(''); this.busy.set(true);
    this.lock.removePin(this.current).subscribe({
      next: () => { this.busy.set(false); this.reset(); this.msg.set('PIN removed. HomeHub won’t lock on your devices.'); },
      error: (e) => { this.busy.set(false); this.err.set(e?.error?.error ?? 'It couldn’t be removed.'); },
    });
  }
}
