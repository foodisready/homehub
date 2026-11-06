import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface Miss {
  source: 'voice' | 'chat'; id: number; text: string; createdAt: string;
  phrase: string; kind: 'device' | 'scene';
}
interface DeviceLite { id: number; alias: string; room: string | null }
interface SceneLite { id: number; name: string }

/**
 * Settings → Teach HomeHub: commands Chat or voice didn't understand, each
 * with Teach (say which devices or scene they meant) and Ignore. Admin only.
 */
@Component({
  selector: 'app-teach-commands',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.75rem; line-height:1.45; }
    .item { padding:0.6rem 0; border-bottom:1px solid var(--border); }
    .item:last-child { border-bottom:none; }
    .head { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; }
    .text { flex:1; min-width:12rem; font-size:0.9rem; overflow-wrap:anywhere; }
    .meta { font-size:0.72rem; color:var(--text-muted); margin-top:0.1rem; }
    .badge { font-size:0.68rem; padding:0.1rem 0.45rem; border-radius:999px; border:1px solid var(--border); color:var(--text-muted); margin-right:0.35rem; }
    .actions { display:flex; gap:0.4rem; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .btn-ghost:hover { background:var(--surface); color:var(--text); }
    .panel { margin-top:0.6rem; padding:0.75rem; border:1px solid var(--border); border-radius:var(--radius); display:grid; gap:0.6rem; }
    .panel label { font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:0.25rem; }
    .panel input[type=text], .panel select { width:100%; box-sizing:border-box; font-size:0.88rem; padding:0.4rem 0.6rem; }
    .panel input[type=checkbox], .panel input[type=radio] { width:auto; min-width:0; flex:none; margin:0; padding:0; }
    .kinds label, .devices label { white-space:nowrap; }
    .devices label { white-space:normal; }
    .kinds { display:flex; gap:1rem; font-size:0.85rem; }
    .kinds label { display:flex; align-items:center; gap:0.35rem; color:var(--text); margin:0; }
    .room { font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin-top:0.35rem; }
    .devices { display:grid; grid-template-columns:repeat(auto-fill, minmax(12rem, 1fr)); gap:0.2rem 0.75rem; }
    .devices label { display:flex; align-items:center; gap:0.4rem; font-size:0.85rem; color:var(--text); margin:0; }
    .bar { display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; }
    .hint { font-size:0.75rem; color:var(--text-muted); }
    .msg { font-size:0.82rem; margin:0.4rem 0 0; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); overflow-wrap:anywhere; }
    .empty { font-size:0.85rem; color:var(--text-muted); }
  `],
  template: `
    <p class="intro">
      Commands that Chat or voice didn't understand. Select <b>Teach</b> to tell HomeHub what you meant:
      it saves the words as a nickname for those devices, or another name for a scene, and understands them next time.
    </p>
    @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()" style="margin-bottom:0.5rem">{{ message() }}</p> }

    @for (m of misses(); track m.source + m.id) {
      <div class="item">
        <div class="head">
          <div class="text">
            "{{ m.text }}"
            <div class="meta"><span class="badge">{{ m.source === 'voice' ? 'Voice' : 'Chat' }}</span>{{ when(m.createdAt) }}</div>
          </div>
          <div class="actions">
            <button class="btn-sm btn-primary" type="button" (click)="open(m)">{{ openId() === key(m) ? 'Close' : 'Teach' }}</button>
            <button class="btn-sm btn-ghost" type="button" (click)="dismiss(m)" [disabled]="busy()">Ignore</button>
          </div>
        </div>

        @if (openId() === key(m)) {
          <div class="panel">
            <div>
              <label [for]="'phrase-' + key(m)">Words to understand</label>
              <input type="text" [id]="'phrase-' + key(m)" [(ngModel)]="phrase" maxlength="60" autocomplete="off" />
            </div>
            <div class="kinds" role="radiogroup" aria-label="What they mean">
              <label><input type="radio" name="kind" value="device" [(ngModel)]="kind" /> Devices</label>
              <label><input type="radio" name="kind" value="scene" [(ngModel)]="kind" [disabled]="!scenes().length" /> A scene</label>
            </div>
            @if (kind === 'device') {
              <div>
                @for (group of rooms(); track group.room) {
                  <div class="room">{{ group.room }}</div>
                  <div class="devices">
                    @for (d of group.devices; track d.id) {
                      <label><input type="checkbox" [checked]="chosen().has(d.id)" (change)="toggle(d.id)" /> {{ d.alias }}</label>
                    }
                  </div>
                }
              </div>
            } @else {
              <div>
                <label [for]="'scene-' + key(m)">Scene</label>
                <select [id]="'scene-' + key(m)" [(ngModel)]="sceneId">
                  @for (s of scenes(); track s.id) { <option [ngValue]="s.id">{{ s.name }}</option> }
                </select>
              </div>
            }
            <div class="bar">
              <button class="btn-sm btn-primary" type="button" (click)="save(m)"
                      [disabled]="busy() || !phrase.trim() || (kind === 'device' ? !chosen().size : sceneId === null)">Save</button>
              <span class="hint">
                @if (kind === 'device' && isChinese(phrase)) { Then "開{{ phrase.trim() }}" and "熄{{ phrase.trim() }}" switch {{ chosen().size === 1 ? 'that device' : 'those devices' }}. }
                @else if (kind === 'device') { Then "turn on {{ phrase.trim() || '…' }}" switches {{ chosen().size === 1 ? 'that device' : 'those devices' }}. }
                @else { Then "{{ phrase.trim() || '…' }}" runs the scene. }
              </span>
            </div>
            @if (error()) { <p class="msg err">{{ error() }}</p> }
          </div>
        }
      </div>
    } @empty {
      <p class="empty">Nothing to teach. Commands HomeHub doesn't understand show up here.</p>
    }
  `,
})
export class TeachCommandsComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly misses  = signal<Miss[]>([]);
  readonly devices = signal<DeviceLite[]>([]);
  readonly scenes  = signal<SceneLite[]>([]);
  readonly openId  = signal<string | null>(null);
  readonly chosen  = signal<Set<number>>(new Set());
  readonly busy    = signal(false);
  readonly error   = signal('');
  readonly message = signal('');
  readonly isError = signal(false);

  phrase = '';
  kind: 'device' | 'scene' = 'device';
  /** Cantonese words, which voice says with 開 or 熄 rather than "turn on". */
  isChinese(text: string): boolean { return /[\u3400-\u9fff]/.test(text); }
  sceneId: number | null = null;

  readonly rooms = computed(() => {
    const byRoom = new Map<string, DeviceLite[]>();
    for (const d of [...this.devices()].sort((a, b) => a.alias.localeCompare(b.alias))) {
      const room = d.room || 'No room';
      byRoom.set(room, [...(byRoom.get(room) ?? []), d]);
    }
    return [...byRoom.entries()]
      .sort(([a], [b]) => (a === 'No room' ? 1 : b === 'No room' ? -1 : a.localeCompare(b)))
      .map(([room, devices]) => ({ room, devices }));
  });

  ngOnInit(): void {
    this.load();
    this.http.get<DeviceLite[]>('/api/devices').subscribe({ next: (d) => this.devices.set(d), error: () => undefined });
    this.http.get<SceneLite[]>('/api/scenes').subscribe({ next: (s) => this.scenes.set(s), error: () => undefined });
  }

  private load(): void {
    this.http.get<Miss[]>('/api/nlp/misses').subscribe({ next: (m) => this.misses.set(m), error: () => undefined });
  }

  key(m: Miss): string { return `${m.source}-${m.id}`; }

  when(iso: string): string {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  open(m: Miss): void {
    this.error.set('');
    if (this.openId() === this.key(m)) { this.openId.set(null); return; }
    this.openId.set(this.key(m));
    this.phrase = m.phrase;
    this.kind = m.kind === 'scene' && this.scenes().length ? 'scene' : 'device';
    this.sceneId = this.scenes()[0]?.id ?? null;
    this.chosen.set(new Set());
  }

  toggle(id: number): void {
    const next = new Set(this.chosen());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.chosen.set(next);
  }

  save(m: Miss): void {
    this.busy.set(true);
    this.error.set('');
    const target = this.kind === 'device' ? { deviceIds: [...this.chosen()] } : { sceneId: this.sceneId };
    this.http.post<{ phrase: string; devices?: string[]; scene?: string }>('/api/nlp/teach',
      { source: m.source, id: m.id, phrase: this.phrase, ...target }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.openId.set(null);
        this.show(r.scene
          ? `Got it: "${r.phrase}" now runs ${r.scene}.`
          : `Got it: "${r.phrase}" now means ${r.devices!.join(', ')}.`);
        this.load();
      },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.error.set(err.error?.error ?? 'Could not save that.'); },
    });
  }

  dismiss(m: Miss): void {
    this.busy.set(true);
    this.http.post('/api/nlp/misses/dismiss', { source: m.source, id: m.id }).subscribe({
      next: () => { this.busy.set(false); if (this.openId() === this.key(m)) this.openId.set(null); this.load(); },
      error: () => { this.busy.set(false); this.show('Could not remove it. Try again.', true); },
    });
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
