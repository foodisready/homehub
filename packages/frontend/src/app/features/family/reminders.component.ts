import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LANGUAGE_NAME, WEEKDAYS, clockText, daysText, errorText, onceText, timeIn, todayIn, type AskDay, type Family, type Reminder, type VoiceLanguage } from './family.types';

/** Things to say, for a quick start, in each language the speakers can say. */
const EXAMPLES: Record<VoiceLanguage, string[]> = {
  yue: ['食藥喇', '記得飲水', '夠鐘瞓覺喇'],
  zh: ['该吃药了', '记得喝水'],
  vi: ['Đến giờ uống thuốc rồi', 'Nhớ uống nước nhé'],
  en: ['Time to take your medicine', 'Remember to drink some water'],
};

interface SayState { state: 'waiting' | 'said' | 'not said'; said: string[]; error: string | null }

/**
 * Spoken reminders: said by the home's speakers at a set time, in the language they're written
 * in. Anyone in the family can set them. "Say it now" plays it straight away, to hear how it sounds.
 */
@Component({
  selector: 'app-reminders',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .note { font-size: 0.85rem; line-height: 1.45; padding: 0.7rem 0.85rem; border-radius: var(--radius); background: var(--bg); margin: 0 0 0.9rem; }
    .note.warn { border-left: 3px solid #f59e0b; }
    .once { font-size: 0.85rem; color: var(--text-muted); margin: 0; }
    .note a { color: var(--accent); }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    li { display: grid; grid-template-columns: 5.2rem 1fr auto; gap: 0.3rem 0.9rem; align-items: start; padding: 0.75rem 0; border-top: 1px solid var(--border); }
    li:first-child { border-top: none; padding-top: 0.2rem; }
    li.off { opacity: 0.55; }
    .when { font-weight: 600; font-variant-numeric: tabular-nums; }
    .when small { display: block; font-weight: 400; color: var(--text-muted); font-size: 0.75rem; margin-top: 0.1rem; }
    .what { font-size: 1.05rem; overflow-wrap: anywhere; }
    .lang { font-size: 0.7rem; padding: 0.05rem 0.4rem; border-radius: 4px; border: 1px solid var(--border); color: var(--text-muted); margin-left: 0.35rem; vertical-align: middle; white-space: nowrap; }
    .status { display: block; font-size: 0.78rem; color: var(--text-muted); margin-top: 0.2rem; }
    .status.bad { color: #fcd34d; }
    .acts { display: flex; gap: 0.3rem; flex-wrap: wrap; justify-content: flex-end; }
    .acts button, .small { font-size: 0.8rem; padding: 0.3rem 0.65rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); }
    .empty { color: var(--text-muted); font-size: 0.9rem; margin: 0 0 0.5rem; }

    form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); display: grid; grid-template-columns: minmax(0, 18rem) 10rem; gap: 0.75rem; }
    form .wide { grid-column: 1 / -1; }
    form > * { min-width: 0; }
    form input, form select { min-width: 0; width: 100%; box-sizing: border-box; }
    label.f { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); }
    .examples { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .chip { font-size: 0.82rem; padding: 0.25rem 0.6rem; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); }
    .days { display: flex; gap: 0.3rem; flex-wrap: wrap; }
    .day { min-width: 2.7rem; height: 2.2rem; padding: 0 0.5rem; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); font-size: 0.85rem; }
    .day[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .foot { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .foot button { min-height: 38px; padding: 0 1rem; }
    .heard { font-size: 0.82rem; color: var(--text-muted); }
    .heard.bad { color: #fcd34d; }
    .err { color: var(--red); font-size: 0.85rem; margin: 0; }
    label.check { display: flex; gap: 0.5rem; align-items: flex-start; font-size: 0.85rem; line-height: 1.45; color: var(--text-muted); }
    label.check input { width: auto; margin-top: 0.2rem; }
    .answer { display: block; font-size: 0.82rem; margin-top: 0.25rem; }
    .answer.bad { color: #fcd34d; }
    .linkish { background: none; border: none; color: var(--accent); padding: 0 0 0 0.3rem; font-size: 0.82rem; text-decoration: underline; }
    .week { display: flex; gap: 0.25rem; align-items: center; margin-top: 0.35rem; flex-wrap: wrap; }
    .dot { display: inline-block; width: 0.65rem; height: 0.65rem; border-radius: 50%; background: var(--border); }
    .dot.yes { background: var(--green); }
    .dot.told { background: #f59e0b; }
    .week-label { font-size: 0.72rem; color: var(--text-muted); margin-right: 0.2rem; }
    .week-key { font-size: 0.7rem; color: var(--text-muted); margin-left: 0.4rem; display: inline-flex; align-items: center; gap: 0.25rem; }
    .week-key i { font-style: normal; }
    @media (max-width: 599px) {
      li { grid-template-columns: 4.4rem 1fr; }
      .acts { grid-column: 1 / -1; justify-content: flex-start; }
      form { grid-template-columns: minmax(0, 1fr) minmax(0, 8.5rem); }
    }
  `],
  template: `
    @if (!data().voice.enabled) {
      <p class="note warn">Reminders are said by your voice speakers. Voice control is off: <a routerLink="/settings">turn it on in Settings</a>.</p>
    } @else if (speakerProblem(); as p) {
      <p class="note warn">{{ p }}</p>
    }

    @if (data().reminders.length) {
      <ul>
        @for (r of data().reminders; track r.id) {
          <li [class.off]="!r.enabled">
            <span class="when">{{ clock(r.at) }}<small>{{ r.onDay ? once(r.onDay) : days(r.days) }}</small></span>
            <span>
              <span class="what">{{ r.text }}</span><span class="lang">{{ langOf(r) }}</span>
              @if (sayState()[r.id]; as s) {
                <span class="status" [class.bad]="s.state === 'not said'">{{ sayText(s) }}</span>
              } @else if (r.lastStatus) {
                <span class="status" [class.bad]="r.lastStatus.startsWith('not said')">{{ statusText(r) }}</span>
              }
              @if (r.ask) {
                @if (todayAsk(r); as t) {
                  <span class="answer" [class.bad]="!!t.toldAt && t.answer !== 'yes'">{{ answerText(t) }}
                    @if (t.answer !== 'yes') { <button type="button" class="linkish" (click)="markDone(t)">Mark done</button> }
                  </span>
                }
                @if (r.answers.length > 1) {
                  <span class="week">
                    <span class="week-label">Last {{ r.answers.length }} days</span>
                    @for (a of week(r); track a.day) { <span class="dot" [class]="'dot ' + dotOf(a)" [title]="a.day + ': ' + answerText(a)" role="img" [attr.aria-label]="a.day + ': ' + answerText(a)"></span> }
                    <span class="week-key">· <i class="dot yes"></i> done <i class="dot told"></i> family told</span>
                  </span>
                }
              }
            </span>
            <span class="acts">
              <button type="button" (click)="sayNow(r)" [disabled]="!data().voice.enabled">Say it now</button>
              <button type="button" (click)="edit(r)">Edit</button>
              <button type="button" (click)="toggle(r)">{{ r.enabled ? 'Turn off' : 'Turn on' }}</button>
            </span>
          </li>
        }
      </ul>
    } @else {
      <p class="empty">No reminders yet. Add one below: the speakers say it at that time each day.</p>
    }

    <form (submit)="$event.preventDefault(); save()" [attr.aria-label]="editing() ? 'Edit reminder' : 'New reminder'">
      <label class="f wide">{{ editing() ? 'Edit what to say' : 'What to say' }}
        <input [(ngModel)]="text" name="text" maxlength="200" placeholder="e.g. 食藥喇" />
      </label>
      @if (!text && !editing()) {
        <div class="examples wide" aria-label="Examples">
          @for (e of examples(); track e) { <button type="button" class="chip" (click)="text = e">{{ e }}</button> }
        </div>
      }
      <label class="f">Language
        <select [(ngModel)]="language" name="language">
          <option value="auto">From how it’s written</option>
          @for (l of data().voice.languages; track l) { <option [value]="l">{{ name(l) }}</option> }
        </select>
      </label>
      <label class="f">At
        <input type="time" [(ngModel)]="at" name="at" required />
      </label>
      <label class="check wide">
        <input type="checkbox" [(ngModel)]="ask" name="ask" />
        <span>Ask if it’s done (“{{ askPreview() }}”). If nobody says yes after 3 tries, 10 minutes apart, the family is told.</span>
      </label>
      @if (editing()?.onDay; as day) {
        <p class="wide once">Once, {{ once(day).toLowerCase() }}. To say it on more days, add a new reminder.</p>
      } @else {
        <div class="days wide" role="group" aria-label="Days">
          @for (d of order; track d) {
            <button type="button" class="day" [attr.aria-pressed]="dayList().includes(d)" (click)="toggleDay(d)">{{ weekdays[d] }}</button>
          }
        </div>
      }
      @if (error()) { <p class="err wide" role="alert">{{ error() }}</p> }
      <div class="foot wide">
        <button type="submit" class="btn-primary" [disabled]="saving() || !text.trim() || !at">{{ editing() ? 'Save' : 'Add reminder' }}</button>
        <button type="button" class="small" (click)="tryIt()" [disabled]="!text.trim() || !data().voice.enabled">Hear it on the speakers</button>
        @if (editing()) {
          <button type="button" class="small" (click)="reset()">Cancel</button>
          <button type="button" class="small" style="color:#fca5a5;margin-left:auto" (click)="remove()">{{ confirmDelete() ? 'Yes, delete it' : 'Delete' }}</button>
        }
        @if (trying(); as t) { <span class="heard" [class.bad]="t.state === 'not said'" aria-live="polite">{{ sayText(t) }}</span> }
      </div>
    </form>
  `,
})
export class RemindersComponent {
  readonly data = input.required<Family>();
  readonly changed = output<void>();
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  readonly weekdays = WEEKDAYS;
  readonly order = [1, 2, 3, 4, 5, 6, 0];
  readonly clock = clockText;
  readonly days = daysText;
  once(day: string): string { return onceText(day, this.data().timezone); }

  text = '';
  language: 'auto' | VoiceLanguage = 'auto';
  at = '09:00';
  ask = false;
  readonly dayList = signal<number[]>([0, 1, 2, 3, 4, 5, 6]);
  readonly editing = signal<Reminder | null>(null);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly confirmDelete = signal(false);
  readonly sayState = signal<Record<number, SayState>>({});
  readonly trying = signal<SayState | null>(null);
  private polls: ReturnType<typeof setTimeout>[] = [];

  constructor() { this.destroyRef.onDestroy(() => this.polls.forEach(clearTimeout)); }

  readonly examples = computed(() => {
    const on = this.data().voice.languages;
    return (['yue', 'zh', 'vi', 'en'] as VoiceLanguage[]).filter((l) => on.includes(l)).flatMap((l) => EXAMPLES[l].slice(0, l === 'en' ? 1 : 2));
  });

  /** Why reminders wouldn't be heard, from what the voice bridge last said about its speakers. */
  readonly speakerProblem = computed(() => {
    const s = this.data().voice.speakers;
    if (!s.length) return 'No voice speaker has checked in lately, so reminders can’t be said. Check Health → Voice.';
    const on = s.filter((x) => x.connected);
    if (!on.length) return `${s.map((x) => x.name).join(', ')} ${s.length === 1 ? 'isn’t' : 'aren’t'} connected right now, so reminders wouldn’t be heard.`;
    if (on.every((x) => x.announce === false)) return `${on.map((x) => x.name).join(', ')} can’t say reminders. Update the speaker’s app to a version that supports announcements.`;
    return '';
  });

  name(l: VoiceLanguage): string { return LANGUAGE_NAME[l]; }
  langOf(r: Reminder): string { return r.language === 'auto' ? this.guess(r.text) : LANGUAGE_NAME[r.language]; }
  private guess(text: string): string {
    if (/[㐀-鿿]/.test(text)) return this.data().voice.languages.includes('yue') ? 'Cantonese' : 'Mandarin';
    if (/[ăâđêôơư]/i.test(text) || /[̀-ͯ]/.test(text.normalize('NFD'))) return 'Vietnamese';
    return 'English';
  }

  statusText(r: Reminder): string {
    const s = r.lastStatus ?? '';
    if (s.startsWith('said') && r.lastSaidAt) {
      return `Said ${new Date(r.lastSaidAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: this.data().timezone })} ${s.slice(5)}`;
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  sayText(s: SayState): string {
    if (s.state === 'waiting') return 'Sending to the speakers…';
    if (s.state === 'said') return `Said on ${s.said.join(', ')}.`;
    return `Not said: ${s.error ?? 'no speaker could say it'}.`;
  }

  toggleDay(d: number): void {
    const has = this.dayList().includes(d);
    if (has && this.dayList().length === 1) return;
    this.dayList.set(has ? this.dayList().filter((x) => x !== d) : [...this.dayList(), d]);
  }

  edit(r: Reminder): void {
    this.editing.set(r);
    this.text = r.text; this.language = r.language; this.at = r.at; this.dayList.set(r.days); this.ask = r.ask;
    this.error.set(''); this.confirmDelete.set(false); this.trying.set(null);
  }

  reset(): void {
    this.editing.set(null);
    this.text = ''; this.language = 'auto'; this.at = '09:00'; this.dayList.set([0, 1, 2, 3, 4, 5, 6]); this.ask = false;
    this.error.set(''); this.confirmDelete.set(false); this.trying.set(null);
  }

  save(): void {
    this.saving.set(true);
    this.error.set('');
    const body = { text: this.text.trim(), language: this.language, at: this.at, days: this.dayList(), ask: this.ask };
    const r = this.editing();
    (r ? this.http.put(`/api/family/reminders/${r.id}`, body) : this.http.post('/api/family/reminders', body)).subscribe({
      next: () => { this.saving.set(false); this.reset(); this.changed.emit(); },
      error: (e) => { this.saving.set(false); this.error.set(errorText(e, 'The reminder couldn’t be saved.')); },
    });
  }

  toggle(r: Reminder): void {
    this.http.put(`/api/family/reminders/${r.id}`, { enabled: !r.enabled }).subscribe({ next: () => this.changed.emit() });
  }

  remove(): void {
    const r = this.editing();
    if (!r) return;
    if (!this.confirmDelete()) { this.confirmDelete.set(true); return; }
    this.http.delete(`/api/family/reminders/${r.id}`).subscribe({
      next: () => { this.reset(); this.changed.emit(); },
      error: (e) => this.error.set(errorText(e, 'The reminder couldn’t be deleted.')),
    });
  }

  /** The question it would ask, as the backend words it. */
  askPreview(): string {
    const med = /藥|药|thuốc|medicine|medication|meds|pill|tablet/i.test(this.text);
    const lang = this.guess(this.text);
    if (lang === 'Cantonese') return med ? '食咗藥未呀？' : '做咗未呀？';
    if (lang === 'Mandarin') return med ? '吃药了吗？' : '做了吗？';
    if (lang === 'Vietnamese') return med ? 'Đã uống thuốc chưa?' : 'Đã làm chưa?';
    return med ? 'Have you taken it?' : 'Have you done it?';
  }

  todayAsk(r: Reminder): AskDay | null {
    const today = todayIn(this.data().timezone);
    return r.answers.find((a) => a.day === today) ?? null;
  }

  /** Oldest first, for the row of dots. */
  week(r: Reminder): AskDay[] { return [...r.answers].reverse(); }

  dotOf(a: AskDay): string { return a.answer === 'yes' ? 'yes' : a.toldAt ? 'told' : 'open'; }

  answerText(a: AskDay): string {
    const tz = this.data().timezone;
    if (a.answer === 'yes') return `Done${a.answeredAt ? ` at ${timeIn(a.answeredAt, tz)}` : ''}${a.answeredBy && a.answeredBy !== 'voice' ? `, marked by ${a.answeredBy}` : ', said to the speaker'}.`;
    if (a.toldAt) return `Not said to be done${a.answer === 'no' ? ' (“not yet”)' : ''}: the family was told at ${timeIn(a.toldAt, tz)}.`;
    return a.answer === 'no' ? `“Not yet”: asked ${a.asks} of 3 times so far.` : `Waiting for an answer: asked ${a.asks} of 3 times. If the speaker doesn’t catch it, it asks again.`;
  }

  markDone(a: AskDay): void {
    this.http.post(`/api/family/reminders/asks/${a.id}/done`, {}).subscribe({ next: () => this.changed.emit(), error: () => this.changed.emit() });
  }

  sayNow(r: Reminder): void {
    this.say({ id: r.id }, (s) => this.sayState.set({ ...this.sayState(), [r.id]: s }));
  }

  tryIt(): void {
    this.say({ text: this.text.trim(), language: this.language }, (s) => this.trying.set(s));
  }

  /** Asks the speakers to say it, then follows how it went for up to two minutes. */
  private say(body: object, show: (s: SayState) => void): void {
    show({ state: 'waiting', said: [], error: null });
    this.http.post<{ id: string }>('/api/family/reminders/say', body).subscribe({
      next: ({ id }) => this.follow(id, show, Date.now()),
      error: (e) => show({ state: 'not said', said: [], error: errorText(e, 'HomeHub couldn’t send it').replace(/\.$/, '') }),
    });
  }

  private follow(id: string, show: (s: SayState) => void, started: number): void {
    const t = setTimeout(() => {
      this.http.get<SayState>(`/api/family/reminders/say/${id}`).subscribe({
        next: (s) => {
          show(s);
          if (s.state === 'waiting' && Date.now() - started < 130_000) this.follow(id, show, started);
          else if (s.state === 'said') this.changed.emit();
        },
        error: () => show({ state: 'not said', said: [], error: 'HomeHub lost track of it' }),
      });
    }, 2000);
    this.polls.push(t);
  }
}
