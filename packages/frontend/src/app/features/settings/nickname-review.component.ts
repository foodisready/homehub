import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { forkJoin } from 'rxjs';
import { SUGGEST_HTML_LANG, SUGGEST_TAG, type NicknameSuggestion } from '../../shared/nickname-chips/nickname-chips.component';

const DISMISSED_KEY = 'homehub.nicknameSuggestions.dismissed';

function readDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}

function saveDismissed(keys: Set<string>): void {
  try { localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys].slice(-500))); } catch { /* only shown again */ }
}

interface DeviceNames { id: number; alias: string; nicknames: string[] }
interface Pending { device: DeviceNames; items: NicknameSuggestion[]; owners: string[] }

/**
 * Settings → Voice control: the Vietnamese and Cantonese nicknames HomeHub
 * suggests for every device at once, ticked to start with. Untick any that
 * aren't right, then add the rest with one button.
 */
@Component({
  selector: 'app-nickname-review',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pending().length) {
      <section class="review" aria-labelledby="nick-review-title">
        <div class="head">
          <div>
            <h3 id="nick-review-title">Suggested nicknames</h3>
            <p class="sub">{{ summary() }}</p>
          </div>
          @if (!open()) {
            <button type="button" class="btn-secondary" (click)="open.set(true)">Review</button>
          }
        </div>

        @if (open()) {
          <p class="sub">Tap a nickname to leave it out; ones left out aren't suggested here again. Nothing changes until you add them.</p>
          <ul class="devices">
            @for (p of pending(); track p.device.id) {
              <li>
                <div class="device">{{ p.device.alias }}</div>
                <div class="tags">
                  @for (s of plainItems(p); track s.text) {
                    <button type="button" class="tag" [class.on]="isOn(p.device.id, s.text)" role="checkbox"
                            [attr.aria-checked]="isOn(p.device.id, s.text)" (click)="toggle(p.device.id, s.text)"
                            [attr.lang]="htmlLangs[s.lang]">
                      <span class="box" aria-hidden="true">
                        @if (isOn(p.device.id, s.text)) {
                          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        }
                      </span>
                      <span class="lang">{{ tag(s) }}</span>{{ s.text }}
                    </button>
                  }
                </div>
                @for (who of p.owners; track who) {
                  <label class="owner">
                    <span>{{ who }} in Chinese</span>
                    <input type="text" lang="zh-HK" [value]="ownerName(p.device.id, who)" (input)="setOwner(p.device.id, who, $any($event.target).value)"
                           placeholder="e.g. 以信" autocomplete="off" />
                  </label>
                  @if (ownerName(p.device.id, who).trim()) {
                    <div class="tags">
                      @for (s of templates(p, who); track s.text) {
                        <button type="button" class="tag" [class.on]="isOn(p.device.id, named(p.device.id, s))" role="checkbox"
                                [attr.aria-checked]="isOn(p.device.id, named(p.device.id, s))" (click)="toggle(p.device.id, named(p.device.id, s))" lang="zh-HK">
                          <span class="box" aria-hidden="true">
                            @if (isOn(p.device.id, named(p.device.id, s))) {
                              <svg viewBox="0 0 24 24" width="12" height="12"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            }
                          </span>
                          <span class="lang">粵</span>{{ named(p.device.id, s) }}
                        </button>
                      }
                    </div>
                  }
                }
              </li>
            }
          </ul>

          <div class="bar">
            <button type="button" class="btn-primary" (click)="save()" [disabled]="saving() || !chosenCount()">
              {{ saving() ? 'Adding…' : chosenCount() === 1 ? 'Add 1 nickname' : 'Add ' + chosenCount() + ' nicknames' }}
            </button>
            <button type="button" class="link" (click)="setAll(chosenCount() === 0)">{{ chosenCount() === 0 ? 'Tick all' : 'Untick all' }}</button>
            <button type="button" class="link" (click)="open.set(false)">Close</button>
          </div>
        }
        @if (message()) { <p class="msg" [class.err]="failed()" role="status">{{ message() }}</p> }
      </section>
    } @else if (message()) {
      <p class="msg" [class.err]="failed()" role="status">{{ message() }}</p>
    }
  `,
  styles: [`
    .review { margin-top: 1rem; padding: 0.8rem; border: 1px solid var(--border); border-radius: var(--radius); background: color-mix(in srgb, var(--bg) 40%, var(--surface)); }
    .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; }
    h3 { font-size: 0.95rem; margin: 0; color: var(--text); }
    .sub { font-size: 0.8rem; color: var(--text-muted); margin: 0.2rem 0 0; line-height: 1.4; }
    .devices { list-style: none; margin: 0.6rem 0 0; padding: 0; display: flex; flex-direction: column; }
    .devices > li { padding: 0.65rem 0; border-top: 1px solid color-mix(in srgb, var(--border) 50%, transparent); display: flex; flex-direction: column; gap: 0.45rem; }
    .device { font-size: 0.9rem; font-weight: 600; color: var(--text); }
    .tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .tag {
      display: inline-flex; align-items: center; gap: 0.4rem; min-height: 38px; padding: 0 0.8rem 0 0.45rem;
      border-radius: 999px; border: 1px dashed var(--border); background: transparent; color: var(--text-muted);
      font: inherit; font-size: 0.95rem; cursor: pointer; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-muted) 60%, transparent);
    }
    .tag.on {
      border-style: solid; border-color: color-mix(in srgb, var(--accent) 60%, transparent); color: var(--text); text-decoration: none;
      background: color-mix(in srgb, var(--accent) 18%, var(--surface));
    }
    .box { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--border); flex: none; }
    .tag.on .box { background: var(--accent); border-color: var(--accent); color: #fff; }
    .lang { font-size: 0.62rem; font-weight: 700; letter-spacing: 0.04em; color: var(--text-muted); }
    .owner { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-muted); }
    .owner input { width: 8rem; min-height: 36px; font-size: 1rem; }
    .bar {
      position: sticky; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin-top: 0.4rem;
      padding: 0.6rem 0 0.2rem; background: color-mix(in srgb, var(--bg) 40%, var(--surface)); border-top: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
    }
    /* Above the phone's bottom tabs (3.6rem and the home indicator). */
    @media (max-width: 899px) { .bar { bottom: calc(3.6rem + 1px + env(safe-area-inset-bottom, 0px)); } }
    .link { background: none; border: none; padding: 0.4rem; color: var(--accent); font-size: 0.85rem; font-weight: 600; cursor: pointer; }
    .msg { font-size: 0.82rem; margin: 0.6rem 0 0; color: var(--green); }
    .msg.err { color: var(--red); }
  `],
})
export class NicknameReviewComponent {
  private readonly http = inject(HttpClient);
  /** The voice languages saved, so the list refreshes when they change. */
  languages = input<string[]>([]);
  /** Nicknames were added: the device list elsewhere on the page should reload. */
  changed = output<void>();

  readonly open = signal(false);
  readonly saving = signal(false);
  readonly message = signal('');
  readonly failed = signal(false);
  private readonly devices = signal<DeviceNames[]>([]);
  private readonly suggestions = signal<Record<number, NicknameSuggestion[]>>({});
  /** "deviceId|nickname" for each one left ticked. */
  private readonly chosen = signal<Set<string>>(new Set());
  /** "deviceId|owner" → their Chinese name, as typed. */
  private readonly owners = signal<Record<string, string>>({});
  private loadedFor: string | null = null;

  /** Suggestions left unticked when the rest were added: not offered here again, in this browser. */
  private readonly dismissed = signal<Set<string>>(readDismissed());

  readonly pending = computed<Pending[]>(() => this.devices()
    .map((device) => {
      const items = (this.suggestions()[device.id] ?? []).filter((s) => s.needsName || !this.dismissed().has(`${device.id}|${s.text}`));
      return { device, items, owners: [...new Set(items.filter((s) => s.needsName).map((s) => s.needsName!))] };
    })
    .filter((p) => p.items.length));

  readonly chosenCount = computed(() => this.chosen().size);

  readonly summary = computed(() => {
    const p = this.pending();
    const langs = [...new Set(p.flatMap((x) => x.items.map((s) => s.lang)))];
    const words = langs.map((l) => (l === 'vi' ? 'Vietnamese' : 'Cantonese')).join(' and ');
    return `${words} nicknames for ${p.length} ${p.length === 1 ? 'device' : 'devices'}, so voice commands in ${langs.length > 1 ? 'those languages' : 'that language'} find them.`;
  });

  constructor() {
    // Load, and again when the saved languages change.
    effect(() => {
      const k = this.languages().join(',');
      if (k === this.loadedFor) return;
      this.loadedFor = k;
      untracked(() => this.load());
    });
  }

  load(): void {
    forkJoin({
      devices: this.http.get<DeviceNames[]>('/api/devices'),
      s: this.http.get<{ suggestions: Record<number, NicknameSuggestion[]> }>('/api/devices/nickname-suggestions'),
    }).subscribe({
      next: ({ devices, s }) => {
        this.devices.set(devices.map((d) => ({ id: d.id, alias: d.alias, nicknames: d.nicknames ?? [] })));
        this.suggestions.set(s.suggestions ?? {});
        this.setAll(true);
      },
      error: () => { /* nothing to suggest */ },
    });
  }

  /** Vietnamese first, then Cantonese. */
  plainItems(p: Pending): NicknameSuggestion[] {
    return p.items.filter((s) => !s.needsName).sort((a, b) => (a.lang === b.lang ? 0 : a.lang === 'vi' ? -1 : 1));
  }
  templates(p: Pending, who: string): NicknameSuggestion[] { return p.items.filter((s) => s.needsName === who); }
  readonly htmlLangs = SUGGEST_HTML_LANG;
  tag(s: NicknameSuggestion): string { return SUGGEST_TAG[s.lang]; }

  ownerName(id: number, who: string): string { return this.owners()[`${id}|${who}`] ?? ''; }
  named(id: number, s: NicknameSuggestion): string { return this.ownerName(id, s.needsName!).trim() + s.text; }

  setOwner(id: number, who: string, value: string): void {
    const before = this.pending().find((p) => p.device.id === id);
    const old = before ? this.templates(before, who).map((s) => this.named(id, s)) : [];
    this.owners.update((o) => ({ ...o, [`${id}|${who}`]: value }));
    // The names made with what was typed are ticked as it changes.
    this.chosen.update((set) => {
      const next = new Set(set);
      old.forEach((n) => next.delete(`${id}|${n}`));
      if (value.trim() && before) this.templates(before, who).forEach((s) => next.add(`${id}|${this.named(id, s)}`));
      return next;
    });
  }

  isOn(id: number, text: string): boolean { return this.chosen().has(`${id}|${text}`); }

  toggle(id: number, text: string): void {
    this.chosen.update((set) => {
      const next = new Set(set);
      const k = `${id}|${text}`;
      if (!next.delete(k)) next.add(k);
      return next;
    });
  }

  setAll(on: boolean): void {
    const next = new Set<string>();
    if (on) {
      for (const p of this.pending()) {
        this.plainItems(p).forEach((s) => next.add(`${p.device.id}|${s.text}`));
        for (const who of p.owners) {
          if (this.ownerName(p.device.id, who).trim()) this.templates(p, who).forEach((s) => next.add(`${p.device.id}|${this.named(p.device.id, s)}`));
        }
      }
    }
    this.chosen.set(next);
  }

  save(): void {
    const byDevice = new Map<number, string[]>();
    for (const k of this.chosen()) {
      const at = k.indexOf('|');
      const id = Number(k.slice(0, at));
      byDevice.set(id, [...(byDevice.get(id) ?? []), k.slice(at + 1)]);
    }
    const calls = [...byDevice].map(([id, names]) => {
      const d = this.devices().find((x) => x.id === id)!;
      return this.http.patch(`/api/devices/${id}`, { nicknames: [...d.nicknames, ...names] });
    });
    if (!calls.length) return;
    const count = this.chosenCount();
    const unticked = this.pending().flatMap((p) => this.plainItems(p).map((s) => `${p.device.id}|${s.text}`)).filter((k) => !this.chosen().has(k));
    this.saving.set(true);
    this.message.set('');
    forkJoin(calls).subscribe({
      next: () => {
        this.saving.set(false);
        this.failed.set(false);
        this.open.set(false);
        this.message.set(`Added ${count} ${count === 1 ? 'nickname' : 'nicknames'} to ${calls.length} ${calls.length === 1 ? 'device' : 'devices'}. Voice knows them within a minute.`);
        this.owners.set({});
        if (unticked.length) {
          const next = new Set([...this.dismissed(), ...unticked]);
          this.dismissed.set(next);
          saveDismissed(next);
        }
        this.changed.emit();
        this.load();
      },
      error: (err) => {
        this.saving.set(false);
        this.failed.set(true);
        this.message.set(err?.error?.error ?? "Couldn't add them all. Some may have been added: check Devices, then try again.");
        this.load();
      },
    });
  }
}
