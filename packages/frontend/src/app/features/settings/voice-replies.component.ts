import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

type Moment = 'on' | 'off' | 'timer' | 'scene' | 'not_understood';
type Style = 'plain' | 'friendly' | 'funny';

interface MomentMeta { id: Moment; label: string; placeholders: string[]; required: string | null }
interface BuiltIn { id: string; moment: Moment; style: Style; text: string }
interface Choice { builtIn: string[]; custom: string[] }
type Choices = Record<Moment, Choice>;
interface RepliesResponse { moments: MomentMeta[]; builtIn: BuiltIn[]; chosen: Choices; maxCustom: number; maxLength: number }

/** Example values for previews: what a reply sounds like in practice. */
const SAMPLE: Record<string, string> = { device: 'Office lamp', minutes: '20 minutes', scene: 'Goodnight' };

/**
 * Settings → Voice replies: what voice and Chat say after a command. Pick
 * built-in lines (Plain, Friendly, Funny) and add your own; HomeHub picks one
 * at random each time. Admin only. Checks mirror backend/src/nlp/replies.ts.
 */
@Component({
  selector: 'app-voice-replies',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.75rem; line-height:1.45; }
    .quick { display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center; margin-bottom:0.9rem; }
    .quick span { font-size:0.8rem; color:var(--text-muted); margin-right:0.2rem; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text); }
    .btn-ghost:hover { background:var(--surface); }
    .moment { border-top:1px solid var(--border); padding:0.7rem 0; }
    .moment h3 { font-size:0.9rem; margin:0 0 0.15rem; }
    .moment .hint { font-size:0.75rem; color:var(--text-muted); margin:0 0 0.45rem; }
    .line { display:flex; align-items:center; gap:0.5rem; padding:0.2rem 0; font-size:0.86rem; }
    .line label { display:flex; align-items:center; gap:0.5rem; flex:1; min-width:0; margin:0; color:var(--text); cursor:pointer; }
    .line input[type=checkbox] { width:auto; min-width:0; flex:none; margin:0; padding:0; }
    .line .text { overflow-wrap:anywhere; }
    .tag { font-size:0.65rem; padding:0.05rem 0.4rem; border-radius:999px; border:1px solid var(--border); color:var(--text-muted); flex:none; }
    .tag.funny { border-color:#a855f7; color:#c084fc; }
    .tag.friendly { border-color:#0ea5e9; color:#38bdf8; }
    .tag.mine { border-color:#22c55e; color:#4ade80; }
    .icon-btn { background:transparent; border:none; color:var(--text-muted); cursor:pointer; padding:0.15rem 0.35rem; font-size:0.85rem; flex:none; }
    .icon-btn:hover { color:var(--text); }
    .add { display:flex; gap:0.4rem; margin-top:0.4rem; flex-wrap:wrap; }
    .add input { flex:1; min-width:12rem; font-size:0.86rem; padding:0.35rem 0.6rem; }
    .problem { font-size:0.78rem; color:var(--red); margin:0.3rem 0 0; overflow-wrap:anywhere; }
    .none { font-size:0.78rem; color:var(--text-muted); margin:0.2rem 0 0; }
    .bar { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin-top:0.8rem; }
    .msg { font-size:0.82rem; margin:0; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); overflow-wrap:anywhere; }
  `],
  template: `
    <p class="intro">
      What voice and Chat say after a command. Tick the replies you like and add your own: HomeHub picks one at random each time.
      Garage doors, cameras and valves always get a plain confirmation.
    </p>

    @if (data(); as d) {
      <div class="quick">
        <span>Start from:</span>
        <button class="btn-sm btn-ghost" type="button" (click)="useStyles(['plain'])">Plain</button>
        <button class="btn-sm btn-ghost" type="button" (click)="useStyles(['friendly'])">Friendly</button>
        <button class="btn-sm btn-ghost" type="button" (click)="useStyles(['funny'])">Funny</button>
        <button class="btn-sm btn-ghost" type="button" (click)="useStyles(['plain', 'friendly', 'funny'])">A bit of everything</button>
      </div>

      @for (m of d.moments; track m.id) {
        <div class="moment">
          <h3>{{ m.label }}</h3>
          <p class="hint">
            @if (m.placeholders.length) { Fill-ins: @for (p of m.placeholders; track p) { <code>{{ '{' + p + '}' }}</code>&nbsp;}
              @if (m.required) { · every reply needs <code>{{ '{' + m.required + '}' }}</code> }
            } @else { Any words you like. }
          </p>

          @for (b of builtInFor(m.id); track b.id) {
            <div class="line">
              <label>
                <input type="checkbox" [checked]="isChosen(m.id, b.id)" (change)="toggleBuiltIn(m.id, b.id)" />
                <span class="text">{{ b.text }}</span>
              </label>
              <span class="tag" [class.funny]="b.style === 'funny'" [class.friendly]="b.style === 'friendly'">{{ styleName(b.style) }}</span>
              <button class="icon-btn" type="button" (click)="hear(b.text)" [attr.aria-label]="'Hear: ' + b.text" title="Hear it">▶</button>
            </div>
          }
          @for (c of choices()[m.id].custom; track c; let i = $index) {
            <div class="line">
              <label><input type="checkbox" checked disabled /> <span class="text">{{ c }}</span></label>
              <span class="tag mine">Mine</span>
              <button class="icon-btn" type="button" (click)="hear(c)" [attr.aria-label]="'Hear: ' + c" title="Hear it">▶</button>
              <button class="icon-btn" type="button" (click)="removeCustom(m.id, i)" [attr.aria-label]="'Remove: ' + c" title="Remove">✕</button>
            </div>
          }
          @if (!countFor(m.id)) { <p class="none">None ticked, so HomeHub uses the Plain reply.</p> }

          <div class="add">
            <input type="text" [(ngModel)]="drafts[m.id]" [maxlength]="d.maxLength" autocomplete="off"
                   [placeholder]="placeholderFor(m)" (keydown.enter)="addCustom(m)" [attr.aria-label]="'Add your own reply for ' + m.label" />
            <button class="btn-sm btn-ghost" type="button" (click)="hear(drafts[m.id])" [disabled]="!drafts[m.id].trim()" title="Hear it">▶ Hear</button>
            <button class="btn-sm btn-primary" type="button" (click)="addCustom(m)" [disabled]="!drafts[m.id].trim()">Add</button>
          </div>
          @if (draftProblem(m); as p) { <p class="problem">{{ p }}</p> }
        </div>
      }

      <div class="bar">
        <button class="btn-sm btn-primary" type="button" (click)="save()" [disabled]="busy() || !dirty()">{{ busy() ? 'Saving…' : 'Save replies' }}</button>
        @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()">{{ message() }}</p> }
      </div>
    } @else {
      <p class="intro">Loading…</p>
    }
  `,
})
export class VoiceRepliesComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly data    = signal<RepliesResponse | null>(null);
  readonly choices = signal<Choices>({} as Choices);
  readonly dirty   = signal(false);
  readonly busy    = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  /** Typed but not yet added, per moment. Showing a problem waits for Add. */
  drafts: Record<Moment, string> = { on: '', off: '', timer: '', scene: '', not_understood: '' };
  private tried: Partial<Record<Moment, boolean>> = {};

  ngOnInit(): void {
    this.http.get<RepliesResponse>('/api/nlp/replies').subscribe({
      next: (r) => { this.data.set(r); this.choices.set(structuredClone(r.chosen)); },
      error: () => this.show("Couldn't load the replies.", true),
    });
  }

  builtInFor(moment: Moment): BuiltIn[] {
    return (this.data()?.builtIn ?? []).filter((b) => b.moment === moment);
  }

  styleName(style: Style): string {
    return style === 'plain' ? 'Plain' : style === 'friendly' ? 'Friendly' : 'Funny';
  }

  isChosen(moment: Moment, id: string): boolean {
    return this.choices()[moment]?.builtIn.includes(id) ?? false;
  }

  countFor(moment: Moment): number {
    const c = this.choices()[moment];
    return c ? c.builtIn.length + c.custom.length : 0;
  }

  placeholderFor(m: MomentMeta): string {
    if (m.id === 'on') return 'e.g. {device} is awake and ready to party.';
    if (m.id === 'off') return 'e.g. Nap time for {device}.';
    if (m.id === 'timer') return 'e.g. {device} is on. Back to sleep in {minutes}.';
    if (m.id === 'scene') return 'e.g. {scene}, coming up.';
    return 'e.g. Pardon? My ears were off.';
  }

  /** Sets the ticks for every moment to the chosen styles. Your own replies stay. */
  useStyles(styles: Style[]): void {
    const next = structuredClone(this.choices());
    for (const m of this.data()?.moments ?? []) {
      next[m.id].builtIn = this.builtInFor(m.id).filter((b) => styles.includes(b.style)).map((b) => b.id);
    }
    this.update(next);
  }

  toggleBuiltIn(moment: Moment, id: string): void {
    const next = structuredClone(this.choices());
    const list = next[moment].builtIn;
    next[moment].builtIn = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    this.update(next);
  }

  removeCustom(moment: Moment, index: number): void {
    const next = structuredClone(this.choices());
    next[moment].custom.splice(index, 1);
    this.update(next);
  }

  addCustom(m: MomentMeta): void {
    this.tried[m.id] = true;
    const text = this.drafts[m.id].trim().replace(/\s+/g, ' ');
    if (!text || this.problem(m, text)) return;
    const next = structuredClone(this.choices());
    if (!next[m.id].custom.includes(text)) next[m.id].custom.push(text);
    this.drafts[m.id] = '';
    this.tried[m.id] = false;
    this.update(next);
  }

  /** Shown once Add was pressed, then live while the text is fixed. */
  draftProblem(m: MomentMeta): string | null {
    const text = this.drafts[m.id].trim();
    if (!this.tried[m.id] || !text) return null;
    return this.problem(m, text);
  }

  private problem(m: MomentMeta, text: string): string | null {
    const d = this.data()!;
    if (text.length > d.maxLength) return `Keep a reply under ${d.maxLength} characters.`;
    if (this.choices()[m.id].custom.length >= d.maxCustom) return `Up to ${d.maxCustom} of your own replies here.`;
    for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
      if (!m.placeholders.includes(name)) {
        return m.placeholders.length
          ? `{${name}} isn't available here. Use ${m.placeholders.map((p) => `{${p}}`).join(' or ')}.`
          : `{${name}} isn't available here.`;
      }
    }
    if (m.required && !text.includes(`{${m.required}}`)) return `Include {${m.required}}, so you always hear what changed.`;
    return null;
  }

  /** Plays the reply with example values, in the browser's voice. */
  hear(text: string): void {
    if (!text.trim() || typeof speechSynthesis === 'undefined') return;
    const filled = text.replace(/\{(\w+)\}/g, (whole, name: string) => SAMPLE[name] ?? whole);
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(filled.charAt(0).toUpperCase() + filled.slice(1)));
  }

  save(): void {
    this.busy.set(true);
    this.http.put<{ chosen: Choices }>('/api/nlp/replies', this.choices()).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.choices.set(r.chosen);
        this.dirty.set(false);
        this.show('Saved. Voice and Chat use these replies now.');
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.show(err.error?.error ?? "Couldn't save the replies.", true);
      },
    });
  }

  private update(next: Choices): void {
    this.choices.set(next);
    this.dirty.set(true);
    this.message.set('');
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
