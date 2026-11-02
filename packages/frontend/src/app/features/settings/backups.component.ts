import { Component, OnInit, inject, output, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

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
    .actions { display:flex; gap:0.4rem; flex-wrap:wrap; }
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

    <div class="create">
      <input type="text" [(ngModel)]="note" placeholder="Note (optional), e.g. before moving to the Pi"
             maxlength="200" (keydown.enter)="create()" />
      <button class="btn-sm btn-primary" (click)="create()" [disabled]="busy()">Back up now</button>
    </div>
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
              <button class="btn-sm btn-ghost" (click)="toggleEditor(b.name)">
                {{ editing() === b.name ? 'Close' : 'View / Edit' }}
              </button>
              <button class="btn-sm btn-ghost" (click)="ask(b.name, 'restore')" [disabled]="busy()">Restore</button>
              <button class="btn-sm btn-ghost" (click)="ask(b.name, 'delete')" [disabled]="busy()" aria-label="Delete backup">✕</button>
            </div>
          </div>

          @if (confirming()?.name === b.name) {
            @if (confirming()?.action === 'restore') {
              <div class="confirm danger">
                <span>
                  Replace your current settings with this backup? HomeHub saves your current settings
                  as a new backup first, so you can undo this.
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

  readonly backups = signal<BackupEntry[]>([]);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly confirming = signal<{ name: string; action: 'restore' | 'delete' } | null>(null);
  readonly editing = signal<string | null>(null);
  readonly loadingEditor = signal(false);
  readonly editorError = signal('');

  note = '';
  draft = '';
  private saved = '';

  dirty(): boolean {
    return this.draft !== this.saved;
  }

  ngOnInit(): void {
    this.load();
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

  ask(name: string, action: 'restore' | 'delete'): void {
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
        this.show(`Restored ${name}. Your previous settings are saved as ${r.safetyBackup}.${removed}`);
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
