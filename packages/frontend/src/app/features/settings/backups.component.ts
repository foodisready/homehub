import { Component, HostListener, OnInit, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface EmailStatus {
  emailReady: boolean;
  recipients: string[];
  passphraseSet: boolean;
  hint?: string;
  auto: boolean;
  paused: boolean;
  last: { at: string; ok: boolean; reason: 'manual' | 'weekly' | 'update'; file: string; error?: string } | null;
}

type Action = 'restore' | 'delete' | 'email';

/** 24×24 stroked paths, like the navigation icons. */
const ICONS = {
  edit:     'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  close:    'M6 6l12 12M18 6 6 18',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  more:     'M5 12h.01M12 12h.01M19 12h.01',
  email:    'M3 6h18v12H3zM3 7l9 6 9-6',
  restore:  'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5',
  delete:   'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  eye:      'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff:   'M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22',
};

interface BackupEntry {
  name: string;
  createdAt: string;
  note: string | null;
  size: number;
  counts: Record<string, number>;
}

interface RestoreResult {
  counts: Record<string, number>;
  removed: number;
  accounts?: { added: string[]; kept: string[] };
  safetyBackup: string;
}

const COUNT_LABELS: [string, string, string][] = [
  ['devices', 'device', 'devices'],
  ['schedules', 'schedule', 'schedules'],
  ['scenes', 'scene', 'scenes'],
  ['motion_rules', 'motion rule', 'motion rules'],
  ['users', 'user', 'users'],
];

/** Settings → Backups: make, list, view, edit, restore and delete JSON backups. Admin only. */
@Component({
  selector: 'app-backups',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.75rem; line-height:1.45; }
    .create { display:flex; gap:0.5rem; flex-wrap:wrap; }
    .create input { flex:1; min-width:10rem; font-size:0.85rem; padding:0.4rem 0.7rem; }
    .list { margin-top:0.75rem; }
    .item { padding:0.65rem 0; border-bottom:1px solid var(--border); }
    .item:last-child { border-bottom:none; }
    .item-head { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
    .item-main { flex:1; min-width:12rem; }
    .item-date { font-size:0.9rem; }
    .item-note { font-size:0.82rem; color:var(--text); margin-top:0.1rem; overflow-wrap:anywhere; }
    .item-meta { font-size:0.75rem; color:var(--text-muted); margin-top:0.15rem; overflow-wrap:anywhere; }
    .actions { display:flex; gap:0.25rem; align-items:center; position:relative; }
    .icon-btn {
      width:2.1rem; height:2.1rem; display:inline-flex; align-items:center; justify-content:center;
      background:transparent; border:1px solid transparent; border-radius:var(--radius);
      color:var(--text-muted); cursor:pointer; padding:0;
    }
    .icon-btn:hover:not(:disabled), .icon-btn[aria-expanded="true"] { background:var(--surface); border-color:var(--border); color:var(--text); }
    .icon-btn:disabled { opacity:0.45; cursor:default; }
    svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; flex-shrink:0; }
    .menu {
      position:absolute; top:calc(100% + 0.25rem); right:0; z-index:20; min-width:11rem;
      background:var(--bg); border:1px solid var(--border); border-radius:var(--radius);
      box-shadow:0 6px 20px rgba(0,0,0,0.18); padding:0.25rem; display:flex; flex-direction:column;
    }
    .menu button {
      display:flex; align-items:center; gap:0.6rem; width:100%; text-align:left;
      background:transparent; border:none; border-radius:calc(var(--radius) - 2px);
      color:var(--text); font-size:0.85rem; padding:0.5rem 0.6rem; cursor:pointer;
    }
    .menu button:hover, .menu button:focus-visible { background:var(--surface); }
    .menu button.danger { color:var(--red); }
    .email-box { border:1px solid var(--border); border-radius:var(--radius); padding:0.65rem 0.75rem; margin:0 0 0.85rem; }
    .email-head { display:flex; align-items:center; gap:0.5rem; font-size:0.9rem; }
    .email-head svg { color:var(--text-muted); }
    .email-box p { font-size:0.8rem; margin:0.35rem 0 0; line-height:1.45; }
    .email-box p:not(.msg) { color:var(--text-muted); }
    .pass-form { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem; }
    .pass-form input { flex:1; min-width:10rem; font-size:0.85rem; padding:0.4rem 0.7rem; }
    .pw { position:relative; flex:1; min-width:10rem; display:flex; }
    .pw input { width:100%; padding-right:2.4rem; }
    .eye {
      position:absolute; right:0.25rem; top:50%; transform:translateY(-50%);
      background:transparent; border:none; color:var(--text-muted); cursor:pointer; padding:0.3rem; display:flex;
    }
    .eye:hover { color:var(--text); }
    .check { display:flex; align-items:flex-start; gap:0.5rem; font-size:0.85rem; margin-top:0.55rem; cursor:pointer; }
    .check input { flex:none; width:auto; margin:0.2rem 0 0; }
    .check span { flex:1; }
    .linkish { background:none; border:none; padding:0; color:var(--accent, var(--text)); text-decoration:underline; cursor:pointer; font-size:inherit; }
    .confirm {
      margin-top:0.5rem; padding:0.6rem 0.75rem; border:1px solid var(--border);
      border-radius:var(--radius); font-size:0.85rem; display:flex; gap:0.5rem;
      align-items:center; flex-wrap:wrap;
    }
    .confirm.danger { border-color:var(--red); }
    .confirm span { flex:1; min-width:12rem; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .btn-ghost:hover { background:var(--surface); color:var(--text); }
    .btn-red { background:var(--red); border:1px solid var(--red); color:#fff; }
    .editor { margin-top:0.6rem; }
    .editor textarea {
      width:100%; box-sizing:border-box; min-height:22rem; resize:vertical;
      font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size:0.78rem; line-height:1.4; padding:0.6rem; tab-size:2;
      white-space:pre; overflow:auto;
      background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:var(--radius);
    }
    .editor-bar { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.4rem; }
    .hint { font-size:0.75rem; color:var(--text-muted); }
    .msg { font-size:0.82rem; margin-top:0.4rem; }
    .msg.ok  { color:var(--green); }
    .msg.err { color:var(--red); overflow-wrap:anywhere; }
    .empty { font-size:0.85rem; color:var(--text-muted); padding:0.5rem 0; }
  `],
  template: `
    <p class="intro">
      Saves your devices, rooms, schedules, scenes, motion rules, users and logins as a JSON file
      in HomeHub's <code>data/backups</code> folder. Energy history isn't included.
      Passwords and keys show as <code>&lt;hidden&gt;</code>, and stay as they are when you save an edit.
    </p>
    <p class="intro">
      To move to another HomeHub, such as a Raspberry Pi, use <b>Download</b> here, then <b>Upload a backup</b>
      on the other one and press Restore. A downloaded file includes passwords and device logins, so keep it private.
    </p>

    @if (email(); as e) {
      <div class="email-box">
        <div class="email-head">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.email" /></svg>
          <b>Email backups</b>
        </div>
        @if (!e.emailReady) {
          <p>
            Email an encrypted copy of a backup, so it survives if this computer fails. First set up email under
            <b>Settings → Integrations → Email alerts</b>.
          </p>
        } @else if (!e.passphraseSet || changingPass()) {
          <p>
            Emailed backups are encrypted with a passphrase you choose. You'll need it to restore one, and HomeHub
            can't recover it, so write it down somewhere other than this computer.
            @if (e.passphraseSet) { Backups already emailed still open with the old passphrase. }
          </p>
          <div class="pass-form">
            <div class="pw">
              <input [type]="showPass() ? 'text' : 'password'" [(ngModel)]="pass1" placeholder="Backup passphrase (10+ characters)"
                     autocomplete="new-password" aria-label="Backup passphrase" spellcheck="false" autocapitalize="off" />
              <button type="button" class="eye" (click)="showPass.set(!showPass())"
                    [attr.aria-label]="showPass() ? 'Hide passphrase' : 'Show passphrase'" [title]="showPass() ? 'Hide' : 'Show'">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="showPass() ? icons.eyeOff : icons.eye" /></svg>
            </button>
            </div>
            <div class="pw">
              <input [type]="showPass() ? 'text' : 'password'" [(ngModel)]="pass2" placeholder="Type it again"
                     autocomplete="new-password" aria-label="Type the backup passphrase again" spellcheck="false" autocapitalize="off" />
            </div>
          </div>
          <div class="pass-form">
            <input type="text" [(ngModel)]="hint" maxlength="100" placeholder="Hint to help you remember it (optional)"
                   aria-label="Passphrase hint" (keydown.enter)="savePassphrase()" />
          </div>
          <p>The hint goes in each backup email and shows when you restore, so make it something only you understand, never the passphrase itself.</p>
          <div class="pass-form">
            <button class="btn-sm btn-primary" (click)="savePassphrase()" [disabled]="busy() || !pass1 || !pass2">Save</button>
            @if (e.passphraseSet) { <button class="btn-sm btn-ghost" (click)="cancelPassphrase()">Cancel</button> }
          </div>
          @if (passError()) { <p class="msg err">{{ passError() }}</p> }
        } @else {
          <label class="check">
            <input type="checkbox" [checked]="e.auto" (change)="setAuto($any($event.target).checked)" [disabled]="busy()" />
            <span>Email a backup every week, and after each HomeHub update</span>
          </label>
          <p>
            Sent to {{ e.recipients.join(', ') }}, encrypted with your backup passphrase.
            You can also email any backup from its <b>⋯</b> menu.
            <button class="linkish" (click)="changingPass.set(true)">Change passphrase</button>
          </p>
          @if (e.hint) { <p>Passphrase hint: <i>{{ e.hint }}</i></p> }
          @if (e.auto && e.paused) {
            <p>Automations are paused on this HomeHub, so automatic emails wait until they're resumed.</p>
          }
          @if (e.last; as last) {
            @if (last.ok) {
              <p>Last emailed {{ when(last.at) }}{{ reasonText(last.reason) }}.</p>
            } @else {
              <p class="msg err">Last email failed {{ when(last.at) }}: {{ last.error }}</p>
            }
          }
        }
      </div>
    }

    <div class="create">
      <input type="text" [(ngModel)]="note" placeholder="Note (optional), e.g. before moving to the Pi"
             maxlength="200" (keydown.enter)="create()" />
      <button class="btn-sm btn-primary" (click)="create()" [disabled]="busy()">Back up now</button>
      <button class="btn-sm btn-ghost" (click)="fileInput.click()" [disabled]="busy()">Upload a backup</button>
      <input #fileInput type="file" accept=".json,application/json" hidden (change)="upload(fileInput)" />
    </div>
    @if (pendingUpload(); as p) {
      <div class="confirm">
        <span>
          {{ p.fileName }} is an encrypted backup. Enter the backup passphrase it was emailed with.
          @if (p.hint) { <br />Your hint: <i>{{ p.hint }}</i> }
        </span>
        <div class="pass-form" style="margin-top:0;flex:1 1 100%">
          <div class="pw">
            <input [type]="showPass() ? 'text' : 'password'" [(ngModel)]="uploadPass" placeholder="Backup passphrase" autocomplete="off"
                   aria-label="Backup passphrase for the uploaded file" (keydown.enter)="sendUpload()" spellcheck="false" autocapitalize="off" />
            <button type="button" class="eye" (click)="showPass.set(!showPass())"
                    [attr.aria-label]="showPass() ? 'Hide passphrase' : 'Show passphrase'" [title]="showPass() ? 'Hide' : 'Show'">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="showPass() ? icons.eyeOff : icons.eye" /></svg>
            </button>
          </div>
          <button class="btn-sm btn-primary" (click)="sendUpload()" [disabled]="busy() || !uploadPass">Open</button>
          <button class="btn-sm btn-ghost" (click)="pendingUpload.set(null)">Cancel</button>
        </div>
      </div>
    }
    @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()">{{ message() }}</p> }

    <div class="list">
      @for (b of backups(); track b.name) {
        <div class="item">
          <div class="item-head">
            <div class="item-main">
              <div class="item-date">{{ when(b.createdAt) }}</div>
              @if (b.note) { <div class="item-note">{{ b.note }}</div> }
              <div class="item-meta">{{ summary(b) }} · {{ b.name }}</div>
            </div>
            <div class="actions">
              <button class="icon-btn" (click)="toggleEditor(b.name)"
                      [attr.aria-label]="editing() === b.name ? 'Close' : 'View or edit'"
                      [title]="editing() === b.name ? 'Close' : 'View / Edit'">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="editing() === b.name ? icons.close : icons.edit" /></svg>
              </button>
              <button class="icon-btn" (click)="download(b.name)" [disabled]="busy()" aria-label="Download" title="Download">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.download" /></svg>
              </button>
              <button class="icon-btn" (click)="toggleMenu(b.name, $event)" aria-label="More" title="More"
                      aria-haspopup="menu" [attr.aria-expanded]="menuFor() === b.name">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.more" style="stroke-width:3.2" /></svg>
              </button>
              @if (menuFor() === b.name) {
                <div class="menu" role="menu" (click)="$event.stopPropagation()">
                  <button role="menuitem" (click)="pick(b.name, 'email')" [disabled]="busy()">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.email" /></svg> Email
                  </button>
                  <button role="menuitem" (click)="pick(b.name, 'restore')" [disabled]="busy()">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.restore" /></svg> Restore
                  </button>
                  <button role="menuitem" class="danger" (click)="pick(b.name, 'delete')" [disabled]="busy()">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icons.delete" /></svg> Delete
                  </button>
                </div>
              }
            </div>
          </div>

          @if (confirming()?.name === b.name) {
            @if (confirming()?.action === 'email') {
              @if (emailBlocker(); as why) {
                <div class="confirm">
                  <span>{{ why }}</span>
                  <button class="btn-sm btn-ghost" (click)="confirming.set(null)">OK</button>
                </div>
              } @else {
                <div class="confirm">
                  <span>
                    Email this backup to {{ email()?.recipients?.join(', ') }}? It's encrypted with your backup
                    passphrase, which you'll need to restore it.
                  </span>
                  <button class="btn-sm btn-primary" (click)="emailIt(b.name)" [disabled]="busy()">Send</button>
                  <button class="btn-sm btn-ghost" (click)="confirming.set(null)">Cancel</button>
                </div>
              }
            } @else if (confirming()?.action === 'restore') {
              <div class="confirm danger">
                <span>
                  Replace your devices, rooms, schedules and settings with this backup? Accounts here keep
                  their passwords, and accounts only in the backup are added. HomeHub saves your current
                  settings as a new backup first, so you can undo this.
                </span>
                <button class="btn-sm btn-red" (click)="restore(b.name)" [disabled]="busy()">Restore</button>
                <button class="btn-sm btn-ghost" (click)="confirming.set(null)">Cancel</button>
              </div>
            } @else {
              <div class="confirm">
                <span>Delete this backup? This can't be undone.</span>
                <button class="btn-sm btn-red" (click)="remove(b.name)" [disabled]="busy()">Delete</button>
                <button class="btn-sm btn-ghost" (click)="confirming.set(null)">Cancel</button>
              </div>
            }
          }

          @if (editing() === b.name) {
            <div class="editor">
              @if (loadingEditor()) {
                <p class="hint">Loading…</p>
              } @else {
                <textarea [(ngModel)]="draft" (ngModelChange)="editorError.set('')" spellcheck="false"
                          autocapitalize="off" autocomplete="off" aria-label="Backup JSON"></textarea>
                <div class="editor-bar">
                  <button class="btn-sm btn-primary" (click)="save(b.name)" [disabled]="busy() || !dirty()">Save changes</button>
                  <button class="btn-sm btn-ghost" (click)="format()">Tidy</button>
                  <button class="btn-sm btn-ghost" (click)="toggleEditor(b.name)">Close</button>
                  @if (dirty()) { <span class="hint">Unsaved changes</span> }
                </div>
                <p class="hint">
                  Saving checks the backup against your current database without changing anything.
                  Remove a whole table, such as <code>"users"</code>, to leave it alone when you restore.
                </p>
                @if (editorError()) { <p class="msg err">{{ editorError() }}</p> }
              }
            </div>
          }
        </div>
      } @empty {
        <div class="empty">No backups yet.</div>
      }
    </div>
  `,
})
export class BackupsComponent implements OnInit {
  private readonly http = inject(HttpClient);

  /** Fired after a restore, so the page can reload devices and users. */
  readonly restored = output<void>();
  /** Changes when the email settings are saved, so Email backups checks again. */
  readonly emailChanged = input(0);

  readonly backups = signal<BackupEntry[]>([]);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly confirming = signal<{ name: string; action: Action } | null>(null);
  readonly editing = signal<string | null>(null);
  readonly loadingEditor = signal(false);
  readonly editorError = signal('');
  readonly menuFor = signal<string | null>(null);
  readonly email = signal<EmailStatus | null>(null);
  readonly changingPass = signal(false);
  readonly passError = signal('');
  /** An encrypted file waiting for its passphrase. */
  readonly pendingUpload = signal<{ fileName: string; content: string; hint?: string } | null>(null);
  /** Shows what's typed in the passphrase boxes. */
  readonly showPass = signal(false);
  readonly icons = ICONS;

  note = '';
  draft = '';
  pass1 = '';
  pass2 = '';
  hint = '';
  uploadPass = '';
  private saved = '';

  dirty(): boolean {
    return this.draft !== this.saved;
  }

  constructor() {
    // Runs once at the start, then whenever the email settings are saved on this page.
    effect(() => { this.emailChanged(); untracked(() => this.loadEmail()); });
  }

  ngOnInit(): void {
    this.load();
  }

  /** Coming back to the page, for example after setting up email on another device, checks again. */
  @HostListener('document:visibilitychange')
  onVisible(): void {
    if (document.visibilityState === 'visible') this.loadEmail();
  }

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  closeMenu(): void {
    this.menuFor.set(null);
  }

  toggleMenu(name: string, event: Event): void {
    event.stopPropagation();
    this.menuFor.set(this.menuFor() === name ? null : name);
  }

  pick(name: string, action: Action): void {
    this.menuFor.set(null);
    this.ask(name, action);
  }

  // ── Email ──────────────────────────────────────────────────────

  private loadEmail(): void {
    this.http.get<EmailStatus>('/api/backups/email').subscribe({
      next: (s) => this.email.set(s),
      error: () => this.email.set(null),
    });
  }

  /** Why a backup can't be emailed yet, or '' when it can. */
  emailBlocker(): string {
    const e = this.email();
    if (!e || !e.emailReady) return 'Set up email first, under Settings → Integrations → Email alerts.';
    if (!e.passphraseSet) return 'Choose a backup passphrase first, under Email backups above, so the email is encrypted.';
    return '';
  }

  savePassphrase(): void {
    this.passError.set('');
    if (this.pass1 !== this.pass2) { this.passError.set("The two passphrases don't match"); return; }
    this.busy.set(true);
    this.http.put<EmailStatus>('/api/backups/email', { passphrase: this.pass1, hint: this.hint }).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.email.set(s);
        this.pass1 = this.pass2 = this.hint = '';
        this.showPass.set(false);
        this.changingPass.set(false);
        this.show('Backup passphrase saved. Keep it somewhere safe: you need it to restore an emailed backup.');
      },
      error: (err) => { this.busy.set(false); this.passError.set(this.errorText(err)); },
    });
  }

  cancelPassphrase(): void {
    this.pass1 = this.pass2 = this.hint = '';
    this.showPass.set(false);
    this.passError.set('');
    this.changingPass.set(false);
  }

  setAuto(on: boolean): void {
    this.busy.set(true);
    this.http.put<EmailStatus>('/api/backups/email', { auto: on }).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.email.set(s);
        if (on && s.last?.ok && Date.now() - Date.parse(s.last.at) < 60_000) this.show(`Sent the first backup email to ${s.recipients.join(', ')}.`);
        else if (!on) this.show('Automatic backup emails are off.');
      },
      error: (err) => { this.busy.set(false); this.show(this.errorText(err), true); this.loadEmail(); },
    });
  }

  emailIt(name: string): void {
    this.busy.set(true);
    this.http.post<{ file: string; recipients: string[] }>(`/api/backups/${encodeURIComponent(name)}/email`, {}).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.confirming.set(null);
        this.show(`Emailed ${name} to ${r.recipients.join(', ')}, encrypted.`);
        this.loadEmail();
      },
      error: (err) => { this.busy.set(false); this.show(this.errorText(err), true); this.loadEmail(); },
    });
  }

  reasonText(reason: 'manual' | 'weekly' | 'update'): string {
    return reason === 'weekly' ? ' (weekly)' : reason === 'update' ? ' (after an update)' : '';
  }

  private load(): void {
    this.http.get<BackupEntry[]>('/api/backups').subscribe({
      next: (list) => this.backups.set(list),
      error: (err) => this.show(this.errorText(err), true),
    });
  }

  create(): void {
    this.busy.set(true);
    this.http.post<BackupEntry>('/api/backups', { note: this.note }).subscribe({
      next: (entry) => {
        this.busy.set(false);
        this.note = '';
        this.show(`Backed up to ${entry.name}`);
        this.load();
      },
      error: (err) => { this.busy.set(false); this.show(this.errorText(err), true); },
    });
  }

  /** Saves the whole file, passwords included, to this computer. */
  download(name: string): void {
    this.http.get(`/api/backups/${encodeURIComponent(name)}/download`, { responseType: 'blob' }).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: (err) => this.show(this.errorText(err), true),
    });
  }

  /** Adds a file from another HomeHub to the list. Restoring it is a separate step. */
  upload(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { this.show('That file is too big to be a HomeHub backup', true); return; }
    this.pendingUpload.set(null);
    file.text().then(
      (content) => this.postUpload(file.name, content),
      () => this.show('Could not read that file', true),
    );
  }

  /** Try the waiting encrypted file again, with the passphrase typed in. */
  sendUpload(): void {
    const p = this.pendingUpload();
    if (p && this.uploadPass) this.postUpload(p.fileName, p.content, this.uploadPass);
  }

  private postUpload(fileName: string, content: string, passphrase?: string): void {
    this.busy.set(true);
    this.message.set('');
    this.http.post<BackupEntry>('/api/backups/upload', passphrase ? { content, passphrase } : { content }).subscribe({
      next: (entry) => {
        this.busy.set(false);
        this.pendingUpload.set(null);
        this.uploadPass = '';
        this.show(`Uploaded ${fileName}. It's in the list as ${entry.name}. Press Restore on it to use it.`);
        this.load();
        this.confirming.set({ name: entry.name, action: 'restore' });
      },
      error: (err) => {
        this.busy.set(false);
        const code = err instanceof HttpErrorResponse ? err.error?.code : undefined;
        const hint = err instanceof HttpErrorResponse && typeof err.error?.hint === 'string' ? err.error.hint : undefined;
        if (code === 'PASSPHRASE_REQUIRED') {
          this.pendingUpload.set({ fileName, content, hint });
          return;
        }
        if (code === 'PASSPHRASE_WRONG') { this.uploadPass = ''; this.pendingUpload.update((p) => (p ? { ...p, hint: hint ?? p.hint } : p)); }
        else this.pendingUpload.set(null);
        this.show(this.errorText(err), true);
      },
    });
  }

  ask(name: string, action: Action): void {
    const current = this.confirming();
    this.confirming.set(current?.name === name && current.action === action ? null : { name, action });
  }

  restore(name: string): void {
    this.busy.set(true);
    this.http.post<RestoreResult>(`/api/backups/${encodeURIComponent(name)}/restore`, {}).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.confirming.set(null);
        const removed = r.removed ? ` Removed ${r.removed} history entries for devices that aren't in it.` : '';
        const added = r.accounts?.added.length ? ` Added ${r.accounts.added.length === 1 ? 'account' : 'accounts'} ${r.accounts.added.join(', ')}.` : '';
        this.show(`Restored ${name}. Your previous settings are saved as ${r.safetyBackup}.${added}${removed}`);
        this.load();
        this.restored.emit();
      },
      error: (err) => { this.busy.set(false); this.show(this.errorText(err), true); },
    });
  }

  remove(name: string): void {
    this.busy.set(true);
    this.http.delete(`/api/backups/${encodeURIComponent(name)}`).subscribe({
      next: () => {
        this.busy.set(false);
        this.confirming.set(null);
        if (this.editing() === name) this.editing.set(null);
        this.show(`Deleted ${name}`);
        this.load();
      },
      error: (err) => { this.busy.set(false); this.show(this.errorText(err), true); },
    });
  }

  toggleEditor(name: string): void {
    if (this.editing() === name) {
      this.editing.set(null);
      return;
    }
    this.editing.set(name);
    this.editorError.set('');
    this.loadingEditor.set(true);
    this.http.get<{ content: string }>(`/api/backups/${encodeURIComponent(name)}`).subscribe({
      next: ({ content }) => {
        this.loadingEditor.set(false);
        this.saved = content;
        this.draft = content;
      },
      error: (err) => { this.loadingEditor.set(false); this.editorError.set(this.errorText(err)); },
    });
  }

  format(): void {
    try {
      this.draft = JSON.stringify(JSON.parse(this.draft), null, 2);
      this.editorError.set('');
    } catch (err) {
      this.editorError.set(`Not valid JSON: ${(err as Error).message}`);
    }
  }

  save(name: string): void {
    try {
      JSON.parse(this.draft);
    } catch (err) {
      this.editorError.set(`Not valid JSON: ${(err as Error).message}`);
      return;
    }
    this.busy.set(true);
    this.http.put<BackupEntry>(`/api/backups/${encodeURIComponent(name)}`, { content: this.draft }).subscribe({
      next: () => {
        this.busy.set(false);
        this.saved = this.draft;
        this.show(`Saved changes to ${name}`);
        this.load();
      },
      error: (err) => { this.busy.set(false); this.editorError.set(this.errorText(err)); },
    });
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  summary(b: BackupEntry): string {
    const parts = COUNT_LABELS
      .filter(([key]) => b.counts[key] !== undefined)
      .map(([key, one, many]) => `${b.counts[key]} ${b.counts[key] === 1 ? one : many}`);
    parts.push(`${Math.max(1, Math.round(b.size / 1024))} KB`);
    return parts.join(' · ');
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }

  private errorText(err: unknown): string {
    if (err instanceof HttpErrorResponse) return err.error?.error ?? err.message;
    return String(err);
  }
}
