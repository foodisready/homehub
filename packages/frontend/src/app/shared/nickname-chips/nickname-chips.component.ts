import { ChangeDetectionStrategy, Component, ElementRef, computed, input, model, signal, viewChild } from '@angular/core';

/** A nickname HomeHub offers for a device, from GET /api/devices/nickname-suggestions. */
export interface NicknameSuggestion {
  text: string;
  lang: 'vi' | 'yue';
  from: string;
  /** Cantonese with a person's Chinese name unknown: `text` is what follows it (房燈). */
  needsName?: string;
}

export type NameLang = 'en' | 'vi' | 'yue';

/** Which language a name is in: Chinese characters are Cantonese, Vietnamese letters Vietnamese. */
export function nameLang(name: string): NameLang {
  if (/\p{Script=Han}/u.test(name)) return 'yue';
  if (/[^\x00-\x7f’]/.test(name)) return 'vi';
  return 'en';
}

export const LANG_TAG: Record<NameLang, string> = { en: 'EN', vi: 'VI', yue: '粵' };
export const LANG_NAME: Record<NameLang, string> = { en: 'English', vi: 'Tiếng Việt', yue: '廣東話' };

/** Lower case without accents, one letter for one: "Đèn" → "den". */
const fold = (s: string) => [...s.normalize('NFC')].map((c) => c.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/, 'd').toLowerCase().slice(0, 1) || c).join('');

const key = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s-]+/g, ' ').trim();

/**
 * A device's nicknames as tags: each one easy to read and to remove on a phone,
 * with HomeHub's suggestions underneath to add with a tap.
 */
@Component({
  selector: 'app-nickname-chips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="nick">
      <div class="label-row">
        <span class="label">Nicknames</span>
        <span class="hint">For Chat and voice</span>
      </div>

      @if (nicknames().length) {
        <ul class="tags" aria-label="Nicknames">
          @for (n of nicknames(); track n) {
            <li class="tag" [class.shared]="sharedWith(n).length" [attr.lang]="htmlLang(n)">
              <span class="lang" [attr.aria-label]="langName(n)">{{ tag(n) }}</span>
              <span class="text">{{ n }}</span>
              <button type="button" class="remove" (click)="remove(n)" [attr.aria-label]="'Remove ' + n">
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="empty">No nicknames yet. Add the names people say, in any language.</p>
      }

      @if (shared().length) {
        <p class="note">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <span>
            @for (s of shared(); track s.device; let last = $last) {
              Shared with <b>{{ s.device }}</b>: {{ s.names.join(', ') }}@if (!last) {<br />}
            }
          </span>
        </p>
      }

      @if (undo(); as u) {
        <p class="undo" role="status">Removed “{{ u }}” <button type="button" class="link" (click)="restore()">Undo</button></p>
      }

      <div class="add-row">
        <div class="field">
          @if (ghost(); as g) {
            <span class="ghost" aria-hidden="true"><span class="typed">{{ draft() }}</span>{{ g.rest }}</span>
          }
          <input #box type="text" [value]="draft()" (input)="onInput(box)" (keydown)="onKey($event)" (paste)="onPaste($event)"
                 (blur)="commit()" [placeholder]="placeholder()" autocomplete="off" autocapitalize="off" enterkeyhint="done"
                 [attr.lang]="next() ? (next()!.lang === 'yue' ? 'zh-HK' : 'vi') : null"
                 [attr.aria-label]="next() ? 'Add a nickname. Tab adds ' + nextLabel() : 'Add a nickname'" />
          @if (next()) {<kbd class="key" aria-hidden="true">Tab</kbd>}
        </div>
        <button type="button" class="add btn-primary" (click)="addClicked(); box.focus()" [disabled]="!draft().trim() && !next()"
                [attr.aria-label]="!draft().trim() && next() ? 'Add ' + nextLabel() : null">Add</button>
      </div>
      @if (namePrompt(); as who) {
        <p class="note">Type {{ who }}'s name in Chinese in front, then press Add.</p>
      }

      @if (offered().length) {
        <div class="suggest">
          <div class="label-row">
            <span class="label">Suggested</span>
            @if (plain().length > 1) {
              <button type="button" class="link" (click)="addAll()">Add all {{ plain().length }}</button>
            } @else {
              <span class="hint">Tap to add</span>
            }
          </div>
          @for (g of groups(); track g.lang) {
            <div class="group">
              <span class="group-name">{{ g.name }}</span>
              <div class="tags">
                @for (s of g.items; track s.text + (s.needsName ?? '')) {
                  <button type="button" class="tag offer" [attr.lang]="g.lang === 'yue' ? 'zh-HK' : 'vi'" (click)="take(s)"
                          [attr.aria-label]="s.needsName ? 'Add ' + s.text + ' after ' + s.needsName + ' in Chinese' : 'Add ' + s.text"
                          [title]="'From “' + s.from + '”'">
                    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
                    @if (s.needsName) {<span class="blank">{{ s.needsName }}</span>}<span class="text">{{ s.text }}</span>
                  </button>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .nick { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.6rem; }
    .label-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
    .label { font-size: 0.8rem; font-weight: 600; color: var(--text); letter-spacing: 0.01em; }
    .hint, .empty, .note, .undo { font-size: 0.75rem; color: var(--text-muted); margin: 0; }
    .note { display: flex; align-items: flex-start; gap: 0.35rem; line-height: 1.5; }
    .note svg { margin-top: 0.2rem; }
    .note svg { flex: none; }
    .note b { color: var(--text); font-weight: 600; }
    .tags { display: flex; flex-wrap: wrap; gap: 0.4rem; list-style: none; margin: 0; padding: 0; }
    .tag {
      display: inline-flex; align-items: center; gap: 0.4rem; max-width: 100%;
      min-height: 36px; padding: 0 0.25rem 0 0.35rem; border-radius: 999px;
      background: color-mix(in srgb, var(--accent) 16%, var(--surface));
      border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
      color: var(--text); font-size: 0.95rem; line-height: 1.2;
    }
    .tag.shared { border-style: dashed; }
    .tag .text { overflow-wrap: anywhere; padding: 0.3rem 0; }
    .lang {
      flex: none; min-width: 1.6rem; padding: 0.1rem 0.3rem; border-radius: 999px; text-align: center;
      background: color-mix(in srgb, var(--bg) 70%, transparent); color: var(--text-muted);
      font-size: 0.65rem; font-weight: 700; letter-spacing: 0.04em;
    }
    .remove {
      flex: none; display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border-radius: 50%;
      background: transparent; border: none; color: var(--text-muted); cursor: pointer;
    }
    .remove:hover, .remove:focus-visible { background: color-mix(in srgb, var(--red) 25%, transparent); color: var(--text); }
    .add-row { display: flex; gap: 0.4rem; }
    .field { position: relative; flex: 1; min-width: 0; background: var(--bg); border-radius: var(--radius); }
    .field input { position: relative; width: 100%; font-size: 1rem; line-height: 1.25; min-height: 40px; background: transparent; padding-right: 3.2rem; }
    /* The rest of a suggestion, shown after what's typed. */
    .ghost {
      position: absolute; inset: 0; display: flex; align-items: center; overflow: hidden; pointer-events: none;
      padding: 0 calc(3.2rem + 1px) 0 calc(0.9rem + 1px); font-size: 1rem; line-height: 1.25; white-space: pre;
      color: var(--text-muted); opacity: 0.8;
    }
    .ghost .typed { color: transparent; }
    .key {
      position: absolute; right: 0.5rem; top: 50%; transform: translateY(-50%); pointer-events: none;
      padding: 0.05rem 0.35rem; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px;
      font-family: inherit; font-size: 0.65rem; font-weight: 600; line-height: 1.4; color: var(--text-muted); background: var(--surface);
    }
    /* Phones have no Tab key: the Add button takes the suggestion instead. */
    @media (hover: none) { .key { display: none; } .field input { padding-right: 0.9rem; } .ghost { padding-right: calc(0.9rem + 1px); } }
    .add { flex: none; min-height: 40px; padding: 0 1rem; }
    .add:disabled { opacity: 0.45; cursor: default; }
    .suggest {
      display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.25rem; padding: 0.6rem;
      border: 1px dashed var(--border); border-radius: var(--radius);
    }
    .group { display: flex; flex-direction: column; gap: 0.3rem; }
    .group-name { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .offer {
      background: transparent; border: 1px dashed var(--border); color: var(--text-muted);
      padding: 0 0.75rem 0 0.55rem; cursor: pointer; font: inherit; font-size: 0.95rem;
    }
    .offer:hover, .offer:focus-visible { border-style: solid; border-color: var(--accent); color: var(--text); }
    .offer svg { flex: none; color: var(--accent); }
    .blank {
      padding: 0 0.3rem; border-bottom: 1.5px dashed currentColor; font-size: 0.75rem; font-style: italic; opacity: 0.85;
    }
    .link { background: none; border: none; padding: 0.2rem; color: var(--accent); font-size: 0.8rem; font-weight: 600; cursor: pointer; }
    .link:hover { text-decoration: underline; }
  `],
})
export class NicknameChipsComponent {
  /** The device's nicknames, edited in place. */
  nicknames = model<string[]>([]);
  /** HomeHub's suggestions for this device. Ones already added are hidden. */
  suggestions = input<NicknameSuggestion[]>([]);
  /** The other devices, to show which nicknames are shared. */
  others = input<Array<{ alias: string; nicknames: string[] }>>([]);

  draft = signal('');
  undo = signal<string | null>(null);
  namePrompt = signal<string | null>(null);
  private removedAt = -1;
  private box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  private have = computed(() => new Set(this.nicknames().map(key)));

  offered = computed(() => this.suggestions().filter((s) =>
    s.needsName ? !this.nicknames().some((n) => n.endsWith(s.text) && n !== s.text) : !this.have().has(key(s.text))));
  plain = computed(() => this.offered().filter((s) => !s.needsName));
  groups = computed(() => (['vi', 'yue'] as const)
    .map((lang) => ({ lang, name: LANG_NAME[lang], items: this.offered().filter((s) => s.lang === lang) }))
    .filter((g) => g.items.length));

  /** The other devices that share a nickname with this one, and which nicknames. */
  shared = computed(() => {
    const byDevice = new Map<string, string[]>();
    for (const name of this.nicknames()) {
      for (const device of this.sharedWith(name)) byDevice.set(device, [...(byDevice.get(device) ?? []), name]);
    }
    return [...byDevice].map(([device, names]) => ({ device, names }));
  });

  /** The suggestion Tab (or Add, with nothing typed) takes: one whose start is typed, or the next one. */
  next = computed<NicknameSuggestion | null>(() => {
    const typed = this.draft();
    if (typed.trim()) return this.ghost()?.s ?? null;
    if (this.namePrompt()) return null;
    return this.plain()[0] ?? this.offered()[0] ?? null;
  });
  nextLabel = computed(() => { const s = this.next(); return s ? (s.needsName ? `${s.needsName} + ${s.text}` : s.text) : ''; });

  /** A suggestion that starts with what's typed, accents left out (den → đèn bếp), and the rest of it to show. */
  ghost = computed<{ s: NicknameSuggestion; rest: string } | null>(() => {
    const typed = this.draft();
    if (!typed.trim() || this.overflowing()) return null;
    const t = fold(typed);
    const s = this.plain().find((p) => p.text.length > typed.length && fold(p.text.slice(0, typed.length)) === t);
    return s ? { s, rest: s.text.slice(typed.length) } : null;
  });
  private overflowing = signal(false);

  placeholder = computed(() => {
    const s = this.next();
    if (s) return s.needsName ? `${s.needsName}’s Chinese name + ${s.text}` : s.text;
    return this.nicknames().length ? 'Add another nickname' : 'Add a nickname, such as đèn bếp or 廚房燈';
  });

  sharedWith(name: string, others = this.others()): string[] {
    const k = key(name);
    return others.filter((d) => key(d.alias) === k || d.nicknames.some((n) => key(n) === k)).map((d) => d.alias);
  }

  tag(n: string): string { return LANG_TAG[nameLang(n)]; }
  langName(n: string): string { return LANG_NAME[nameLang(n)]; }
  htmlLang(n: string): string | null { const l = nameLang(n); return l === 'yue' ? 'zh-HK' : l === 'vi' ? 'vi' : null; }

  private add(names: string[]): void {
    const list = [...this.nicknames()];
    const seen = new Set(list.map(key));
    for (const raw of names) {
      const n = raw.trim();
      if (n && !seen.has(key(n))) { list.push(n); seen.add(key(n)); }
    }
    if (list.length !== this.nicknames().length) this.nicknames.set(list);
  }

  /** The text typed so far becomes a tag (or several, if it has commas). */
  commit(): void {
    const text = this.draft().trim();
    if (!text) return;
    // A suggestion's ending alone (房燈), with no name typed in front, isn't a nickname yet.
    const waiting = this.namePrompt();
    if (waiting && this.suggestions().some((s) => s.needsName === waiting && s.text === text)) return;
    this.add(text.split(/[,，、]/));
    this.draft.set('');
    this.box().nativeElement.value = '';
    this.namePrompt.set(null);
  }

  onInput(el: HTMLInputElement): void {
    this.draft.set(el.value);
    this.overflowing.set(el.scrollWidth > el.clientWidth);
    if (!el.value) this.namePrompt.set(null);
  }

  /** Tab, or Add with nothing typed: take the suggestion shown in the box. */
  private accept(): boolean {
    const s = this.next();
    if (!s) return false;
    if (s.needsName) { this.take(s); return true; }
    this.add([s.text]);
    this.draft.set('');
    this.box().nativeElement.value = '';
    return true;
  }

  addClicked(): void {
    if (!this.draft().trim()) this.accept();
    else this.commit();
  }

  onKey(e: KeyboardEvent): void {
    if (e.key === 'Tab' && !e.shiftKey && !e.isComposing) {
      if (this.accept()) e.preventDefault();   // with nothing to take, Tab moves on as usual
    } else if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      this.commit();
    } else if (e.key === 'Backspace' && !this.draft() && this.nicknames().length) {
      // Backspace in an empty box picks up the last tag to edit it.
      const last = this.nicknames()[this.nicknames().length - 1];
      e.preventDefault();
      this.nicknames.set(this.nicknames().slice(0, -1));
      this.draft.set(last);
      this.box().nativeElement.value = last;
    }
  }

  onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!/[,，、\n]/.test(text)) return;
    e.preventDefault();
    this.add(text.split(/[,，、\n]/));
  }

  remove(name: string): void {
    this.removedAt = this.nicknames().indexOf(name);
    this.nicknames.set(this.nicknames().filter((n) => n !== name));
    this.undo.set(name);
  }

  restore(): void {
    const name = this.undo();
    if (!name) return;
    const list = [...this.nicknames()];
    list.splice(Math.max(0, Math.min(this.removedAt, list.length)), 0, name);
    this.nicknames.set(list);
    this.undo.set(null);
  }

  take(s: NicknameSuggestion): void {
    if (!s.needsName) {
      this.add([s.text]);
      return;
    }
    // Their Chinese name goes in front: the box gets 房燈 with the cursor before it.
    const el = this.box().nativeElement;
    this.draft.set(s.text);
    el.value = s.text;
    this.namePrompt.set(s.needsName);
    el.focus();
    el.setSelectionRange(0, 0);
  }

  addAll(): void {
    this.add(this.plain().map((s) => s.text));
  }
}
