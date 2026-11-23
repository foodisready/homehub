import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { SecretInputDirective } from '../../shared/secret-input/secret-input.directive';

type CodeMethod = 'sms' | 'email' | 'app';
interface AlarmAccount {
  username: string | null;
  signedIn: boolean;
  /** Alarm.com refused the saved password, or forgot this HomeHub; sign in again. */
  rejected: boolean;
  message: string | null;
  /** An alarm PIN is set, so disarming from HomeHub is possible. */
  pinSet: boolean;
}
/** What signing in needs next. */
type Step =
  | { step: 'done'; account: AlarmAccount; partitions: number; sensors: number }
  | { step: 'code'; methods: CodeMethod[]; sentTo: string | null };

const METHOD_WORDS: Record<CodeMethod, string> = { sms: 'Text me a code', email: 'Email me a code', app: 'Use my authenticator app' };

/**
 * Settings → Integrations → Alarm.com. Signs in to the Alarm.com account the alarm system reports to,
 * so HomeHub can show whether it's armed and which doors and windows are open, and arm and disarm
 * it. Also sets the alarm PIN, which disarming from HomeHub asks for.
 */
@Component({
  selector: 'app-alarmcom-login',
  standalone: true,
  imports: [SecretInputDirective, FormsModule],
  styles: [`
    .head { display:flex; align-items:center; gap:1rem; padding:0.65rem 0; cursor:pointer; background:none; border:none;
            width:100%; text-align:left; color:var(--text); font:inherit; }
    .label { flex:1; font-size:0.9rem; }
    .sub { font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem; }
    .ok-badge { font-size:0.72rem; color:#4ade80; white-space:nowrap; }
    .warn-badge { font-size:0.72rem; color:#fbbf24; white-space:nowrap; }
    .chev { color:var(--text-muted); font-size:0.85rem; }
    .form { display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; margin-top:0.25rem; }
    .form input { font-size:0.85rem; padding:0.4rem 0.7rem; min-width:0; }
    .wide { grid-column:1 / -1; }
    .bar { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .note { font-size:0.75rem; color:var(--text-muted); line-height:1.4; margin:0; }
    .note.warn { color:#fbbf24; }
    .msg { font-size:0.82rem; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); }
    .code { letter-spacing:0.2em; font-variant-numeric:tabular-nums; max-width:9rem; }
    .pin { display:flex; flex-direction:column; gap:0.35rem; border-top:1px solid var(--border); padding-top:0.6rem; margin-top:0.25rem; }
    .pin b { font-size:0.85rem; }
    @media (max-width: 480px) { .form { grid-template-columns:1fr; } }
  `],
  template: `
    <button type="button" class="head" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()">
      <div class="label">
        Alarm.com
        <div class="sub">For an alarm system with the Alarm.com app. See whether it’s armed and which doors and windows are open, and arm and disarm it.</div>
      </div>
      @if (account()?.rejected) { <span class="warn-badge">● Sign in again</span> }
      @else if (account()?.signedIn) { <span class="ok-badge">● Signed in</span> }
      <span class="chev">{{ expanded() ? '▲' : '▼' }}</span>
    </button>
    @if (expanded()) {
      <div class="form">
        @if (account()?.rejected) {
          <p class="note warn wide">Alarm.com stopped accepting the saved sign-in{{ account()?.message ? ' (' + account()?.message + ')' : '' }}. Sign in again to bring the alarm back.</p>
        }
        @if (methods(); as m) {
          <!-- Two-step verification -->
          @if (!codeAsked()) {
            <p class="note wide">Alarm.com wants to check it’s you before it trusts this HomeHub. How should it send the code?</p>
            <div class="bar wide">
              @for (k of m; track k) {
                <button class="btn-sm btn-primary" (click)="sendCode(k)" [disabled]="saving()">{{ words(k) }}</button>
              }
              <button class="btn-sm btn-ghost" (click)="restart()" [disabled]="saving()">Cancel</button>
            </div>
          } @else {
            <p class="note wide">{{ sentTo() === 'app' ? 'Enter the code from your authenticator app.' : sentTo() ? 'Enter the code Alarm.com sent to ' + sentTo() + '.' : 'Enter the code.' }}</p>
            <input class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" [(ngModel)]="code" placeholder="Code" aria-label="Verification code" (keydown.enter)="submitCode()" />
            <div class="bar">
              <button class="btn-sm btn-primary" (click)="submitCode()" [disabled]="saving() || !code.trim()">{{ saving() ? 'Checking…' : 'Confirm' }}</button>
              <button class="btn-sm btn-ghost" (click)="restart()" [disabled]="saving()">Cancel</button>
            </div>
          }
        } @else {
          <input type="text" [(ngModel)]="username" placeholder="Alarm.com username" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Alarm.com username" />
          <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore
                 [(ngModel)]="password" placeholder="Password" aria-label="Alarm.com password" (keydown.enter)="save()" />
          <div class="bar wide">
            <button class="btn-sm btn-primary" (click)="save()" [disabled]="saving() || !username.trim() || !password">{{ saving() ? 'Signing in…' : 'Sign in' }}</button>
            @if (account()?.signedIn) {
              <button class="btn-sm btn-ghost" (click)="signOut()" [disabled]="saving()">Forget</button>
            }
          </div>
        }
        @if (message()) { <span class="msg wide" [class.ok]="!isError()" [class.err]="isError()" role="status">{{ message() }}</span> }

        @if (account()?.signedIn && !methods()) {
          <div class="wide pin">
            <b>Alarm PIN</b>
            <p class="note">
              @if (account()?.pinSet) { Set. Disarming from HomeHub asks for it every time. }
              @else { Not set, so nobody can disarm from HomeHub yet. Arming works without it. }
              Use 4 to 8 digits. It can match your keypad code, but needn’t.
            </p>
            <div class="bar">
              <input type="text" class="secret code" inputmode="numeric" maxlength="8" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore
                     [(ngModel)]="pin" [placeholder]="account()?.pinSet ? 'New PIN' : 'PIN'" aria-label="Alarm PIN" (keydown.enter)="savePin()" />
              <button class="btn-sm btn-primary" (click)="savePin()" [disabled]="savingPin() || !pinOk()">{{ account()?.pinSet ? 'Change' : 'Set PIN' }}</button>
              @if (account()?.pinSet) { <button class="btn-sm btn-ghost" (click)="removePin()" [disabled]="savingPin()">Remove</button> }
            </div>
            @if (pinMessage()) { <span class="msg" [class.ok]="!pinError()" [class.err]="pinError()" role="status">{{ pinMessage() }}</span> }
          </div>
        }

        <p class="note wide">
          Use the username and password you use in the Alarm.com app. A separate Alarm.com login just for HomeHub is
          safer: in the app, the account owner can add one under Users or Login Info; allow it to arm and disarm.
          Alarm.com asks for the password again now and then, so HomeHub keeps it on this HomeHub and never shows it again.
        </p>
        <p class="note wide">
          Arming and disarming are only in the app, never by Chat, voice, scenes or schedules. Each arm and disarm shows on the
          alarm card with who did it. The keypad and the Alarm.com app work as before.
        </p>
        <p class="note wide">
          Alarm.com offers no public connection for homeowners, so HomeHub uses the one its website uses, as Home Assistant does.
          If Alarm.com changes it, the alarm card may stop updating until HomeHub is updated. The alarm itself and its monitoring are not affected.
        </p>
      </div>
    }
  `,
})
export class AlarmcomLoginComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly expanded = signal(false);
  readonly account = signal<AlarmAccount | null>(null);
  /** Set while Alarm.com wants a code: how it can send one. */
  readonly methods = signal<CodeMethod[] | null>(null);
  readonly codeAsked = signal(false);
  readonly sentTo = signal<string | null>(null);
  readonly saving = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);

  readonly savingPin = signal(false);
  readonly pinMessage = signal('');
  readonly pinError = signal(false);

  username = '';
  password = '';
  code = '';
  pin = '';

  pinOk(): boolean { return /^\d{4,8}$/.test(this.pin); }

  savePin(): void {
    if (!this.pinOk()) return;
    this.savingPin.set(true);
    this.http.put('/api/alarm/pin', { pin: this.pin }).subscribe({
      next: () => {
        this.savingPin.set(false);
        this.pin = '';
        const a = this.account();
        if (a) this.account.set({ ...a, pinSet: true });
        this.pinShow('PIN saved. Share it only with people who should disarm the alarm.');
      },
      error: (e: HttpErrorResponse) => { this.savingPin.set(false); this.pinShow(e.error?.error ?? 'Couldn’t save the PIN.', true); },
    });
  }

  removePin(): void {
    this.savingPin.set(true);
    this.http.delete('/api/alarm/pin').subscribe({
      next: () => {
        this.savingPin.set(false);
        const a = this.account();
        if (a) this.account.set({ ...a, pinSet: false });
        this.pinShow('PIN removed. Nobody can disarm from HomeHub until a new one is set.');
      },
      error: () => { this.savingPin.set(false); this.pinShow('Couldn’t remove the PIN.', true); },
    });
  }

  private pinShow(text: string, error = false): void { this.pinMessage.set(text); this.pinError.set(error); }

  ngOnInit(): void {
    this.http.get<AlarmAccount>('/api/alarm/login').subscribe({
      next: (a) => {
        this.account.set(a);
        this.username = a.username ?? '';
        if (a.rejected) this.expanded.set(true);
      },
      error: () => undefined,
    });
  }

  words(k: CodeMethod): string { return METHOD_WORDS[k] ?? k; }

  save(): void {
    if (!this.username.trim() || !this.password) return;
    this.busy();
    this.http.put<Step>('/api/alarm/login', { username: this.username.trim(), password: this.password }).subscribe({
      next: (s) => { this.password = ''; this.take(s); },
      error: (e: HttpErrorResponse) => this.fail(e, 'Couldn’t sign in to Alarm.com.'),
    });
  }

  sendCode(method: CodeMethod): void {
    if (method === 'app') {
      this.http.post('/api/alarm/login/app', {}).subscribe({
        next: () => { this.codeAsked.set(true); this.sentTo.set('app'); },
        error: (e: HttpErrorResponse) => this.fail(e, 'Couldn’t switch to the authenticator app.'),
      });
      return;
    }
    this.busy();
    this.http.post<{ sentTo: string | null }>('/api/alarm/login/send', { method }).subscribe({
      next: (r) => { this.saving.set(false); this.codeAsked.set(true); this.sentTo.set(r.sentTo ?? (method === 'sms' ? 'your phone by text' : 'your email')); },
      error: (e: HttpErrorResponse) => this.fail(e, 'Alarm.com didn’t send a code. Try again.'),
    });
  }

  submitCode(): void {
    const code = this.code.replace(/\s/g, '');
    if (!code) return;
    this.busy();
    this.http.post<Step>('/api/alarm/login/code', { code }).subscribe({
      next: (s) => { this.code = ''; this.take(s); },
      error: (e: HttpErrorResponse) => {
        this.fail(e, 'That code didn’t work. Check it and try again.');
        if (e.status === 410) this.restart(false);   // the sign-in timed out: start over
      },
    });
  }

  restart(clearMessage = true): void {
    this.methods.set(null);
    this.codeAsked.set(false);
    this.sentTo.set(null);
    this.code = '';
    if (clearMessage) this.message.set('');
    this.http.delete('/api/alarm/login/pending').subscribe({ error: () => undefined });
  }

  signOut(): void {
    this.http.delete('/api/alarm/login').subscribe(() => {
      this.account.set({ username: null, signedIn: false, rejected: false, message: null, pinSet: this.account()?.pinSet ?? false });
      this.username = '';
      this.show('Forgotten. The alarm card is gone from the Dashboard until you sign in again.');
    });
  }

  private take(s: Step): void {
    this.saving.set(false);
    if (s.step === 'code') {
      this.methods.set(s.methods.length ? s.methods : ['sms', 'email']);
      this.codeAsked.set(false);
      this.sentTo.set(s.sentTo);
      this.message.set('');
      return;
    }
    this.methods.set(null);
    this.codeAsked.set(false);
    this.account.set(s.account);
    this.show(s.sensors
      ? `Signed in. HomeHub sees ${s.sensors} sensor${s.sensors === 1 ? '' : 's'}; the alarm card is on the Dashboard.`
      : 'Signed in. The alarm card appears on the Dashboard as soon as Alarm.com lists the sensors.');
  }

  private busy(): void { this.saving.set(true); this.message.set(''); }

  private fail(e: HttpErrorResponse, fallback: string): void {
    this.saving.set(false);
    this.show(e.error?.error ?? fallback, true);
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
