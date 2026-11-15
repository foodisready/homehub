import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import type { Family, VoiceLanguage } from './family.types';

interface DeviceLite { id: number; alias: string; room: string | null; nicknames: string[]; isProtected: boolean; power?: { excluded: string | null } }
interface SceneLite { id: number; name: string }

export interface CardLine { name: string; on: string | null; off: string }
export interface CardSection { lang: VoiceLanguage; title: string; lines: CardLine[]; timed: string | null; scenes: string[]; questions: string[]; wakeHint: string }

const CHINESE = /[㐀-鿿]/;
/** Vietnamese writes its tones and vowels with marks English doesn't have. */
const isVietnamese = (s: string) => !CHINESE.test(s) && (/[đ]/i.test(s) || /[̀-ͯ]/.test(s.normalize('NFD')));
const isEnglish = (s: string) => !CHINESE.test(s) && !isVietnamese(s);

const TITLE: Record<VoiceLanguage, string> = { yue: '廣東話 · Cantonese', zh: '普通话 · Mandarin', vi: 'Tiếng Việt · Vietnamese', en: 'English' };

/** The command for each language, with a name: on, off (or close, for a garage door), and on for ten minutes. */
const SAY: Record<VoiceLanguage, { on: (n: string) => string; off: (n: string) => string; close: (n: string) => string; timed: (n: string) => string; questions: string[] }> = {
  yue: { on: (n) => `開${n}`, off: (n) => `熄${n}`, close: (n) => `閂${n}`, timed: (n) => `開${n}十分鐘`, questions: ['而家幾點？', '今日天氣點？', '聽日會唔會落雨？'] },
  zh: { on: (n) => `打开${n}`, off: (n) => `关掉${n}`, close: (n) => `关上${n}`, timed: (n) => `打开${n}十分钟`, questions: ['现在几点？', '今天天气怎么样？'] },
  vi: { on: (n) => `Bật ${n}`, off: (n) => `Tắt ${n}`, close: (n) => `Đóng ${n}`, timed: (n) => `Bật ${n} mười phút`, questions: ['Mấy giờ rồi?', 'Thời tiết hôm nay thế nào?'] },
  en: { on: (n) => `Turn on ${n}`, off: (n) => `Turn off ${n}`, close: (n) => `Close ${n}`, timed: (n) => `Turn on ${n} for 10 minutes`, questions: ['What time is it?', 'What’s the weather?'] },
};

/** The name a language says for a device: its first nickname in that script; in English, its name. */
function nameIn(lang: VoiceLanguage, d: DeviceLite): string | null {
  if (lang === 'en') return d.nicknames.find(isEnglish) ?? d.alias;
  if (lang === 'vi') return d.nicknames.find(isVietnamese) ?? null;
  return d.nicknames.find((n) => CHINESE.test(n)) ?? null;
}

const sceneFits = (lang: VoiceLanguage, name: string) =>
  lang === 'yue' || lang === 'zh' ? CHINESE.test(name) : lang === 'vi' ? isVietnamese(name) : isEnglish(name);

/** The card's sections, one per language voice control listens for, from the home's names. */
export function buildCard(languages: VoiceLanguage[], devices: DeviceLite[], scenes: SceneLite[]): CardSection[] {
  const order: VoiceLanguage[] = ['yue', 'zh', 'vi', 'en'];
  const usable = devices
    .filter((d) => !d.isProtected && (!d.power?.excluded || d.power.excluded === 'garage door'))
    .sort((a, b) => (a.room ?? '~').localeCompare(b.room ?? '~') || a.alias.localeCompare(b.alias));
  return order.filter((l) => languages.includes(l)).map((lang) => {
    const say = SAY[lang];
    const seen = new Set<string>();
    const lines: CardLine[] = [];
    for (const d of usable) {
      const name = nameIn(lang, d);
      if (!name || seen.has(name)) continue;   // one name on two devices (both kitchen lights) is said once
      seen.add(name);
      const garage = d.power?.excluded === 'garage door';
      // Voice can close a garage door but never open it.
      lines.push({ name, on: garage ? null : say.on(name), off: garage ? say.close(name) : say.off(name) });
    }
    const lamp = lines.find((l) => l.on);
    return {
      lang, title: TITLE[lang], lines,
      timed: lamp ? say.timed(lamp.name) : null,
      scenes: scenes.map((s) => s.name).filter((n) => sceneFits(lang, n)),
      questions: say.questions,
      wakeHint: lang === 'en' ? 'Say the wake word first' : lang === 'vi' ? 'Nói từ đánh thức trước' : lang === 'zh' ? '先说唤醒词' : '先講喚醒詞',
    };
  }).filter((s) => s.lines.length || s.scenes.length);
}

/**
 * A card of voice commands to print: for each language, each device's on and off command with
 * the name the family uses, a scene or two, and the questions it answers. The wake word is
 * typed in, since it's set on the speaker, not in HomeHub.
 */
@Component({
  selector: 'app-voice-card',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .bar a { color: var(--text-muted); font-size: 0.9rem; }
    .bar .opts { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .big-toggle { display: inline-flex; align-items: center; gap: 0.4rem; }
    .big-toggle input { width: auto; margin: 0; }
    .sheet { background: #fff; color: #111; border-radius: var(--radius); padding: 1.6rem 1.8rem; max-width: 860px; margin: 0 auto; }
    .sheet h1 { font-size: 1.5rem; margin: 0 0 0.2rem; color: #111; }
    .sheet .hint { color: #555; margin: 0 0 1rem; font-size: 0.95rem; }
    section { break-inside: avoid; margin-top: 1.4rem; }
    section:first-of-type { margin-top: 0.6rem; }
    h2 { font-size: 1.15rem; margin: 0 0 0.15rem; padding-bottom: 0.3rem; border-bottom: 2px solid #111; color: #111; }
    .wake { font-size: 1rem; margin: 0.45rem 0 0.6rem; color: #333; }
    .wake b { font-size: 1.2rem; }
    .wake input { font: inherit; font-weight: 700; width: 9rem; border: none; border-bottom: 1.5px dashed #888; background: transparent; color: #111; padding: 0 0.2rem; border-radius: 0; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 0.42rem 0.5rem 0.42rem 0; border-bottom: 1px solid #ddd; font-size: 1.25rem; vertical-align: top; }
    td { width: 50%; overflow-wrap: anywhere; }
    .extra { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem 1.5rem; margin-top: 0.7rem; }
    .extra h3 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin: 0 0 0.2rem; }
    .extra p { margin: 0; font-size: 1.15rem; line-height: 1.6; }
    .big td { font-size: 1.55rem; padding: 0.55rem 0.5rem 0.55rem 0; }
    .big .extra p { font-size: 1.4rem; }
    @media (max-width: 599px) {
      .sheet { padding: 1.1rem 1rem; }
      td { font-size: 1.05rem; }
      .extra { grid-template-columns: 1fr; }
    }
    @media print {
      .bar { display: none; }
      .sheet { padding: 0; max-width: none; border-radius: 0; }
      .wake input { border-bottom-color: transparent; }
    }
  `],
  template: `
    <div class="page">
      <div class="bar">
        <a routerLink="/family">‹ Family</a>
        <div class="opts">
          <label class="muted big-toggle"><input type="checkbox" [(ngModel)]="big" name="big" /> Larger text</label>
          <button type="button" class="btn-primary" style="min-height:38px;padding:0 1rem" (click)="print()">Print</button>
        </div>
      </div>

      @if (sections(); as list) {
        @if (list.length) {
          <div class="sheet" [class.big]="big">
            <h1>{{ title() }}</h1>
            <p class="hint">Say the wake word, wait for the sound, then say a command.</p>
            @for (s of list; track s.lang) {
              <section>
                <h2>{{ s.title }}</h2>
                <p class="wake">{{ s.wakeHint }}: <input [ngModel]="wake()[s.lang] ?? ''" (ngModelChange)="setWake(s.lang, $event)" [name]="'wake-' + s.lang" aria-label="Wake word" placeholder="…" /></p>
                <table>
                  @for (l of s.lines; track l.name) {
                    <tr>
                      <td>{{ l.on ?? '' }}</td>
                      <td>{{ l.off }}</td>
                    </tr>
                  }
                </table>
                <div class="extra">
                  @if (s.timed || s.scenes.length) {
                    <div>
                      @if (s.timed) { <h3>{{ s.lang === 'en' ? 'For a while' : s.lang === 'vi' ? 'Trong một lúc' : s.lang === 'zh' ? '一段时间' : '一陣' }}</h3><p>{{ s.timed }}</p> }
                      @if (s.scenes.length) {
                        <h3>{{ s.lang === 'en' ? 'Scenes' : s.lang === 'vi' ? 'Cảnh' : s.lang === 'zh' ? '场景' : '場景' }}</h3>
                        @for (sc of s.scenes.slice(0, 4); track sc) { <p>{{ sc }}</p> }
                      }
                    </div>
                  }
                  <div>
                    <h3>{{ s.lang === 'en' ? 'Ask' : s.lang === 'vi' ? 'Hỏi' : s.lang === 'zh' ? '问' : '問' }}</h3>
                    @for (q of s.questions; track q) { <p>{{ q }}</p> }
                  </div>
                </div>
              </section>
            }
          </div>
        } @else {
          <p class="muted">No names to put on the card yet. Add nicknames to your devices in Settings → Devices, or turn on a language in Settings → Voice control.</p>
        }
      } @else if (failed()) {
        <p class="muted">The card couldn’t be made. Reload the page to try again.</p>
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
})
export class VoiceCardComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly sections = signal<CardSection[] | null>(null);
  readonly failed = signal(false);
  readonly wake = signal<Partial<Record<VoiceLanguage, string>>>(this.readWake());
  big = false;

  readonly title = computed(() => {
    const langs = (this.sections() ?? []).map((s) => s.lang);
    return langs.includes('yue') ? '聲控指令 · Voice commands' : langs.includes('vi') ? 'Lệnh giọng nói · Voice commands' : 'Voice commands';
  });

  ngOnInit(): void {
    forkJoin({
      family: this.http.get<Family>('/api/family'),
      devices: this.http.get<DeviceLite[]>('/api/devices'),
      scenes: this.http.get<SceneLite[]>('/api/scenes'),
    }).subscribe({
      next: ({ family, devices, scenes }) => this.sections.set(buildCard(family.voice.languages, devices, scenes)),
      error: () => this.failed.set(true),
    });
  }

  print(): void { window.print(); }

  setWake(lang: VoiceLanguage, value: string): void {
    const next = { ...this.wake(), [lang]: value.slice(0, 30) };
    this.wake.set(next);
    try { localStorage.setItem('homehub.voiceCard.wake', JSON.stringify(next)); } catch { /* private window */ }
  }

  private readWake(): Partial<Record<VoiceLanguage, string>> {
    try { return JSON.parse(localStorage.getItem('homehub.voiceCard.wake') ?? '{}'); } catch { return {}; }
  }
}
