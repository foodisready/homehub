import { Component, OnDestroy, OnInit, inject, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

export interface SyncStatus {
  role: 'active' | 'backup' | 'dev';
  serving: { pairedAt: string; last: { at: string; address: string } | null } | null;
  following: {
    address: string; pairedAt: string; checkedAt: string | null; copiedAt: string | null; error: string | null;
  } | null;
  activeSeen: string | null;
  everyMinutes: number;
}

const SYNC_ICON = 'M21 12a9 9 0 0 1-15.5 6.3L3 16M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M3 21v-5h5';

/** "5 minutes ago", "3 hours ago", "2 days ago". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'not yet';
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * Settings → Backups → Keep a backup HomeHub in step. On the active HomeHub it
 * makes the pairing code; on a backup it takes the code and shows how syncing goes.
 */
@Component({
  selector: 'app-backup-sync',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .box { border:1px solid var(--border); border-radius:var(--radius); padding:0.65rem 0.75rem; margin:0 0 0.85rem; }
    .head { display:flex; align-items:center; gap:0.5rem; font-size:0.9rem; }
    .head svg { width:1.1rem; height:1.1rem; fill:none; stroke:var(--text-muted); stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    p { font-size:0.8rem; margin:0.35rem 0 0; line-height:1.45; color:var(--text-muted); }
    p b { color:var(--text); }
    .code {
      font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:1.15rem; letter-spacing:0.08em;
      color:var(--text); margin:0.5rem 0 0; padding:0.5rem 0.7rem; border:1px dashed var(--accent);
      border-radius:var(--radius); display:inline-block; user-select:all;
    }
    .form { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem; }
    .form input { flex:1; min-width:10rem; font-size:0.85rem; padding:0.4rem 0.7rem; }
    .form input.code-in { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; flex-basis:16rem; }
    .actions { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.55rem; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .btn-ghost:hover { background:var(--surface); color:var(--text); }
    .msg { font-size:0.82rem; margin-top:0.4rem; }
    .msg.ok  { color:var(--green); }
    .msg.err { color:var(--red); overflow-wrap:anywhere; }
  `],
  template: `
    @if (status(); as s) {
      <div class="box">
        <div class="head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon" /></svg>
          <b>Keep a backup HomeHub in step</b>
        </div>

        @if (s.role === 'active') {
          @if (code()) {
            <p>On the backup HomeHub, open <b>Settings → Backups</b> and enter this code. It's shown only once.</p>
            <div class="code" aria-label="Pairing code">{{ code() }}</div>
            <div class="actions"><button class="btn-sm btn-ghost" (click)="code.set('')">Done</button></div>
          } @else if (s.serving) {
            <p>
              A backup HomeHub is paired, and copies this one every {{ s.everyMinutes }} minutes.
              @if (s.serving.last) { It last copied {{ ago(s.serving.last.at) }}. } @else { It hasn't copied yet. }
            </p>
            <div class="actions">
              <button class="btn-sm btn-ghost" (click)="makeCode()" [disabled]="busy()">New pairing code</button>
              <button class="btn-sm btn-ghost" (click)="unpair()" [disabled]="busy()">Unpair</button>
            </div>
          } @else {
            <p>
              A backup HomeHub, such as an old laptop, can copy this one's devices, rooms, schedules and scenes every hour,
              so it's ready to take over. Make it a backup first, in <b>Settings → Preferences → This server</b> on that computer.
            </p>
            <div class="actions"><button class="btn-sm btn-primary" (click)="makeCode()" [disabled]="busy()">Pair a backup HomeHub</button></div>
          }
        } @else if (s.role === 'backup') {
          @if (s.following; as f) {
            <p>
              Copies the active HomeHub at <b>{{ f.address }}</b> every {{ s.everyMinutes }} minutes.
              Last copied {{ ago(f.copiedAt) }}, last checked {{ ago(f.checkedAt) }}.
              Accounts here keep their passwords.
            </p>
            @if (f.error) { <p class="msg err">{{ f.error }}</p> }
            <div class="actions">
              <button class="btn-sm btn-primary" (click)="syncNow()" [disabled]="busy()">{{ busy() ? 'Copying…' : 'Sync now' }}</button>
              <button class="btn-sm btn-ghost" (click)="stop()" [disabled]="busy()">Stop syncing</button>
            </div>
          } @else {
            <p>
              Copy the active HomeHub's devices, rooms, schedules and scenes here every hour. On the active HomeHub,
              open <b>Settings → Backups</b> and select <b>Pair a backup HomeHub</b>, then enter its code here.
            </p>
            <div class="form">
              <input class="code-in" [(ngModel)]="codeIn" placeholder="Pairing code" aria-label="Pairing code"
                     autocomplete="off" spellcheck="false" autocapitalize="characters" />
              <input [(ngModel)]="addressIn" [placeholder]="s.activeSeen ? 'Address: ' + s.activeSeen : 'Active HomeHub address, e.g. 192.168.1.20'"
                     aria-label="Active HomeHub address" autocomplete="off" spellcheck="false" autocapitalize="off" />
              <button class="btn-sm btn-primary" (click)="follow()" [disabled]="busy() || !codeIn.trim()">{{ busy() ? 'Pairing…' : 'Pair' }}</button>
            </div>
            <p>
              @if (s.activeSeen) { The active HomeHub was found at {{ s.activeSeen }}; leave the address empty to use it. }
              @else { The active HomeHub wasn't found on the network by name, so enter its address. }
            </p>
          }
        } @else {
          <p>A development copy doesn't copy the active HomeHub. Make this HomeHub a backup to keep it in step.</p>
        }
        @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()">{{ message() }}</p> }
      </div>
    }
  `,
})
export class BackupSyncComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  /** After a copy was restored here, so the backup list and devices can reload. */
  readonly copied = output<void>();
  readonly icon = SYNC_ICON;
  readonly ago = ago;
  readonly status = signal<SyncStatus | null>(null);
  readonly code = signal('');
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  codeIn = '';
  addressIn = '';
  private timer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => { if (!this.busy()) this.load(); }, 60_000);   // keep "minutes ago" fresh
  }

  ngOnDestroy(): void { clearInterval(this.timer); }

  load(): void {
    this.http.get<SyncStatus>('/api/backups/sync').subscribe({ next: (s) => this.status.set(s), error: () => undefined });
  }

  makeCode(): void {
    this.run(this.http.post<{ code: string; status: SyncStatus }>('/api/backups/sync/code', {}), (r) => {
      this.status.set(r.status);
      this.code.set(r.code);
    });
  }

  unpair(): void {
    this.run(this.http.delete<SyncStatus>('/api/backups/sync/code'), (s) => {
      this.status.set(s);
      this.say('Unpaired. The backup HomeHub keeps the copy it has, but no longer gets changes.');
    });
  }

  follow(): void {
    const body = { code: this.codeIn, ...(this.addressIn.trim() ? { address: this.addressIn.trim() } : {}) };
    this.run(this.http.put<SyncStatus>('/api/backups/sync/follow', body), (s) => this.after(s, true));
  }

  syncNow(): void {
    const before = this.status()?.following?.copiedAt;
    this.run(this.http.post<SyncStatus>('/api/backups/sync/now', {}), (s) => this.after(s, s.following?.copiedAt !== before));
  }

  stop(): void {
    this.run(this.http.delete<SyncStatus>('/api/backups/sync/follow'), (s) => {
      this.status.set(s);
      this.say('Stopped. This HomeHub keeps the copy it has.');
    });
  }

  private after(s: SyncStatus, changed: boolean): void {
    this.status.set(s);
    const f = s.following;
    if (!f) return;
    this.codeIn = '';
    this.addressIn = '';
    if (f.error) { this.message.set(''); return; }   // shown in the box
    if (changed && f.copiedAt) {
      this.say('Copied the active HomeHub.');
      this.copied.emit();
    } else {
      this.say('Already up to date.');
    }
  }

  private say(text: string, error = false): void {
    this.isError.set(error);
    this.message.set(text);
  }

  private run<T>(req: import('rxjs').Observable<T>, done: (r: T) => void): void {
    this.busy.set(true);
    this.message.set('');
    req.subscribe({
      next: (r) => { this.busy.set(false); done(r); },
      error: (err) => {
        this.busy.set(false);
        this.say(err instanceof HttpErrorResponse ? err.error?.error ?? err.message : String(err), true);
      },
    });
  }
}
