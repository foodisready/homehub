import { Component, OnDestroy, OnInit, computed, inject, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AutomationsService } from '../../core/services/automations.service';
import { SystemService } from '../../core/services/system.service';
import { NicknameReviewComponent } from './nickname-review.component';

interface BridgeStatus {
  state: 'off' | 'starting' | 'running'; kind: 'docker' | 'service' | null; version: string | null;
  /** While starting, what it's doing: "Downloading the Vietnamese voice: 45% of 60 MB". From v0.1.60. */
  detail?: string | null;
  /** Running with other languages than the ones saved: it's about to restart to load them. */
  applying?: boolean;
  /** Each speaker and whether it's connected (from v0.2.10); a Voice PE's wake words and sensitivity (from v0.3.30). */
  speakers?: BridgeSpeaker[];
  /** A restart an admin asked for: 'asked' until the bridge picks it up, then 'restarting'. From v0.2.10. */
  restart?: 'asked' | 'restarting' | null;
}
interface BridgeSpeaker {
  name: string; connected: boolean;
  wakeWords?: { id: string; name: string; on: boolean }[];
  sensitivity?: string; sensitivities?: string[];
  /** Chosen here, and not on the speaker yet. */
  applying?: boolean;
}
interface VoiceSettings {
  enabled: boolean; languages: string[]; bridge: BridgeStatus | null;
  /** The most wake words a speaker may have on at once. From v0.3.30. */
  maxWakeWords?: number; wakeWordLimits?: { min: number; max: number };
}

const POLL_MS = 5_000;

/**
 * Settings → Voice control: turns voice on or off, and adds Cantonese, Mandarin or Vietnamese. The
 * voice bridge that comes with HomeHub waits until voice is on, downloads its
 * speech models the first time, and restarts by itself to apply a change.
 * Admin only.
 */
@Component({
  selector: 'app-voice-control',
  standalone: true,
  imports: [FormsModule, NicknameReviewComponent],
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.8rem; line-height:1.45; }
    .check { display:flex; align-items:flex-start; gap:0.55rem; font-size:0.9rem; color:var(--text); margin:0 0 0.55rem; cursor:pointer; }
    .check input { width:auto; margin-top:0.2rem; flex:none; }
    .check small { display:block; color:var(--text-muted); font-size:0.78rem; margin-top:0.1rem; }
    .langs { margin:0.2rem 0 0.4rem 1.6rem; }
    .langs.off { opacity:0.5; }
    .status { display:flex; gap:0.5rem; align-items:flex-start; font-size:0.84rem; margin:0.8rem 0 0; line-height:1.45; }
    .dot { width:9px; height:9px; border-radius:50%; margin-top:0.4rem; flex:none; background:var(--text-muted); }
    .dot.ok { background:var(--green); }
    .dot.busy { background:#f59e0b; }
    .bar { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin-top:0.9rem; }
    .msg { font-size:0.82rem; margin:0; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); }
    code { font-size:0.78rem; overflow-wrap:anywhere; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .speakers { margin:0.9rem 0 0; padding:0.75rem 0 0; border-top:1px solid var(--border); }
    .speakers h3 { font-size:0.84rem; font-weight:600; margin:0 0 0.45rem; color:var(--text); }
    .speakers ul { list-style:none; margin:0; padding:0; }
    .speakers li { display:flex; gap:0.5rem; align-items:flex-start; font-size:0.84rem; margin:0 0 0.35rem; line-height:1.45; }
    .speakers .name { overflow-wrap:anywhere; }
    .speakers .state { color:var(--text-muted); }
    .speakers .sp { display:flex; flex-direction:column; gap:0.35rem; min-width:0; }
    .speakers .ww { display:flex; flex-wrap:wrap; gap:0.35rem; align-items:center; }
    .speakers .label { font-size:0.78rem; color:var(--text-muted); margin-right:0.15rem; }
    .speakers .chip { display:inline-flex; align-items:center; gap:0.3rem; font-size:0.8rem; padding:0.2rem 0.55rem; border:1px solid var(--border); border-radius:999px; cursor:pointer; }
    .speakers .chip.on { border-color:var(--green); }
    .speakers .chip input { width:auto; margin:0; }
    .speakers .sens { display:flex; gap:0.4rem; align-items:center; }
    .speakers .sens select { width:auto; font-size:0.8rem; padding:0.2rem 0.4rem; }
    .speakers .limit { display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center; margin:0.5rem 0 0.6rem; font-size:0.84rem; }
    .speakers .limit select { width:auto; font-size:0.8rem; padding:0.2rem 0.4rem; }
    .speakers .limit .hint { flex-basis:100%; font-size:0.78rem; color:var(--text-muted); }
    .speakers .none { font-size:0.82rem; color:var(--text-muted); margin:0; }
    .restart { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin-top:0.7rem; }
    .restart .hint { font-size:0.78rem; color:var(--text-muted); flex:1 1 14rem; line-height:1.4; }
  `],
  template: `
    <p class="intro">
      Control HomeHub by talking to a speaker or tablet, with no cloud. It needs a voice speaker, such as the Ava app on an
      Android tablet, on the same network.
    </p>
    @if (standby()) {
      <p class="intro"><b>Voice runs on the active HomeHub.</b> This one is a backup or development server, so its voice bridge waits.
        Your choices here are kept for when it's the active server.</p>
    }
    @if (loaded()) {
      <label class="check">
        <input type="checkbox" [(ngModel)]="enabled" (ngModelChange)="dirty.set(true)" />
        <span>Voice control
          <small>The first time, HomeHub downloads its speech models: about 200 MB for English.</small>
        </span>
      </label>
      <div class="langs" [class.off]="!enabled">
        <label class="check">
          <input type="checkbox" checked disabled />
          <span>English</span>
        </label>
        <label class="check">
          <input type="checkbox" [(ngModel)]="cantonese" (ngModelChange)="dirty.set(true)" [disabled]="!enabled" />
          <span>Cantonese 廣東話
            <small>Commands in either language, answered in the same one. Needs Cantonese nicknames on your devices, such as 廚房燈. Adds about 350 MB.</small>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" [(ngModel)]="mandarin" (ngModelChange)="dirty.set(true)" [disabled]="!enabled" />
          <span>Mandarin 普通话
            <small>Answered in Mandarin. Needs Chinese nicknames on your devices, such as 厨房灯; Cantonese ones work too. Adds about 300 MB, or 60 MB with Cantonese.</small>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" [(ngModel)]="vietnamese" (ngModelChange)="dirty.set(true)" [disabled]="!enabled" />
          <span>Vietnamese Tiếng Việt
            <small>Answered in Vietnamese. Needs Vietnamese nicknames on your devices, such as đèn bếp, and one for each way you say it, such as đèn nhà bếp. Adds about 150 MB.</small>
          </span>
        </label>
      </div>

      <div class="bar">
        <button class="btn-primary" type="button" (click)="save()" [disabled]="saving() || !dirty()">{{ saving() ? 'Saving…' : 'Save' }}</button>
        @if (message()) { <p class="msg" [class.ok]="!failed()" [class.err]="failed()">{{ message() }}</p> }
      </div>

      <div class="status" role="status">
        <span class="dot" [class.ok]="status().tone === 'ok'" [class.busy]="status().tone === 'busy'"></span>
        <span>{{ status().text }} @if (status().command) { <code>{{ status().command }}</code> }</span>
      </div>

      @if (canRestart()) {
        <section class="speakers" aria-labelledby="speakers-title">
          <h3 id="speakers-title">Speakers</h3>
          @if (speakers() === null) {
            <p class="none">Each speaker's status is under More → Health.</p>
          } @else if (speakers()!.length) {
            <ul>
              @for (sp of speakers(); track $index) {
                <li>
                  <span class="dot" [class.ok]="sp.connected" [class.busy]="!sp.connected"></span>
                  <span class="sp">
                    <span><span class="name">{{ sp.name }}</span> · <span class="state">{{ sp.connected ? 'Connected' : 'Not connected' }}</span></span>
                    @if (sp.wakeWords?.length) {
                      <span class="ww" role="group" [attr.aria-label]="'Wake words for ' + sp.name">
                        <span class="label">Wake words</span>
                        @for (w of sp.wakeWords; track w.id) {
                          <label class="chip" [class.on]="w.on">
                            <input type="checkbox" [checked]="w.on" [disabled]="speakerBusy() === sp.name || (w.on && onCount(sp) === 1) || (!w.on && onCount(sp) >= maxWakeWords())"
                                   (change)="toggleWakeWord(sp, w.id, $any($event.target).checked)" /> {{ w.name }}
                          </label>
                        }
                      </span>
                    }
                    @if (sp.wakeWords?.length && onCount(sp) >= maxWakeWords()) {
                      <span class="state">{{ onCount(sp) > maxWakeWords() ? onCount(sp) + ' are on, more than the limit of ' + maxWakeWords() + '.' : 'At the limit of ' + maxWakeWords() + ' on at once.' }} Untick one to choose another.</span>
                    }
                    @if (sp.sensitivity && sp.sensitivities?.length) {
                      <label class="sens">
                        <span class="label">Sensitivity</span>
                        <select [value]="sp.sensitivity" [disabled]="speakerBusy() === sp.name" (change)="setSensitivity(sp, $any($event.target).value)">
                          @for (o of sp.sensitivities; track o) { <option [value]="o" [selected]="o === sp.sensitivity">{{ o }}</option> }
                        </select>
                      </label>
                    }
                    @if (sp.applying) { <span class="state">Setting it on the speaker…</span> }
                    @if (speakerError()?.name === sp.name) { <span class="msg err">{{ speakerError()!.text }}</span> }
                  </span>
                </li>
              }
            </ul>
          } @else {
            <p class="none">No speakers found. Check the speaker or tablet is on, and the voice app is open.</p>
          }
          @if (hasWakeWords()) {
            <label class="limit">
              <span class="label">Most wake words on at once</span>
              <select [value]="maxWakeWords()" [disabled]="limitBusy()" (change)="setLimit(+$any($event.target).value)">
                @for (n of limitChoices(); track n) { <option [value]="n" [selected]="n === maxWakeWords()">{{ n }}</option> }
              </select>
              <span class="hint">Each one is listened for all the time. More can slow the speaker, and means more chances for the TV to wake it.</span>
            </label>
            @if (limitError()) { <p class="msg err">{{ limitError() }}</p> }
          }
          <div class="restart">
            <button class="btn-sm btn-ghost" type="button" (click)="restart()" [disabled]="restarting()">
              {{ asking() ? 'Asking…' : restartState() ? 'Restarting…' : 'Restart voice bridge' }}
            </button>
            <span class="hint">
              If a speaker stops answering or shows Not connected. Speakers reconnect in about a minute.
              If one still doesn't, open the voice app on it again, or restart the tablet.
            </span>
          </div>
          @if (restartError()) { <p class="msg err" style="margin-top:0.5rem">{{ restartError() }}</p> }
        </section>
      }

      @if (otherLanguages().length) {
        <app-nickname-review [languages]="otherLanguages()" (changed)="nicknamesChanged.emit()" />
      }
    } @else if (loadError()) {
      <p class="msg err">{{ loadError() }}</p>
    }
  `,
})
export class VoiceControlComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly automations = inject(AutomationsService);
  private readonly system = inject(SystemService);
  readonly standby = computed(() => { const r = this.automations.role()?.role; return r === 'backup' || r === 'dev'; });
  readonly loaded = signal(false);
  readonly loadError = signal('');
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly message = signal('');
  readonly failed = signal(false);
  private readonly saved = signal<VoiceSettings | null>(null);
  /** Cantonese, Mandarin or Vietnamese, saved: their nicknames can be suggested. */
  readonly otherLanguages = computed(() => (this.saved()?.languages ?? []).filter((l) => l !== 'en'), { equal: (a, b) => a.join() === b.join() });
  /** Nicknames were added from the suggestions. */
  readonly nicknamesChanged = output<void>();
  enabled = false;
  cantonese = false;
  vietnamese = false;
  mandarin = false;
  private timer?: ReturnType<typeof setInterval>;
  readonly asking = signal(false);
  readonly restartError = signal('');
  /** Null from a HomeHub before v0.2.10, which doesn't send them. */
  readonly speakers = computed(() => this.saved()?.bridge?.speakers ?? null);
  readonly restartState = computed(() => this.saved()?.bridge?.restart ?? null);
  readonly restarting = computed(() => this.asking() || this.restartState() !== null);
  /** The bridge is checking in and running (or restarting at an admin's request): it can be asked to restart. */
  readonly canRestart = computed(() => {
    const s = this.saved();
    const b = s?.bridge;
    return !!s?.enabled && !this.standby() && !!b && (b.state === 'running' || b.restart != null);
  });

  /** What the voice bridge is doing, in words. */
  readonly status = computed((): { text: string; tone: 'ok' | 'busy' | 'none'; command?: string } => {
    const s = this.saved();
    const b = s?.bridge;
    if (b?.kind === 'service') {
      return {
        text: 'A voice bridge installed on its own (with install.sh) is running, and uses its own settings file. To let HomeHub run it from here instead, stop that one on the computer it runs on:',
        tone: 'busy', command: 'systemctl --user disable --now homehub-voice',
      };
    }
    if (!s?.enabled) return { text: 'Voice is off.', tone: 'none' };
    if (b?.restart === 'asked') return { text: 'Asked to restart. It restarts when it next checks in, within a minute.', tone: 'busy' };
    if (b?.restart === 'restarting') return { text: 'Restarting…', tone: 'busy' };
    if (!b) return { text: 'Turning on. The voice bridge checks in within a minute.', tone: 'busy' };
    if (b.state === 'off') return { text: 'Turning on…', tone: 'busy' };
    if (b.state === 'starting') {
      return { text: b.detail ? `${b.detail}…` : 'Starting. The first time, it downloads its speech models, which can take a few minutes.', tone: 'busy' };
    }
    // Saved, but the bridge is still running with the old languages: a command in a newly
    // ticked language would go to another one until it restarts.
    if (b.applying) {
      return { text: 'Applying your change: the voice bridge restarts to load the new languages.', tone: 'busy' };
    }
    return { text: `Running${b.version ? ` (${b.version})` : ''}.`, tone: 'ok' };
  });

  ngOnInit(): void {
    this.load(true);
    this.timer = setInterval(() => this.load(false), POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private load(first: boolean): void {
    this.http.get<VoiceSettings>('/api/nlp/voice').subscribe({
      next: (s) => {
        this.saved.set(s);
        // Keep what the admin is changing; refresh only the bridge's status.
        if (first || !this.dirty()) {
          this.enabled = s.enabled;
          this.cantonese = s.languages.includes('yue');
          this.vietnamese = s.languages.includes('vi');
          this.mandarin = s.languages.includes('zh');
        }
        this.loaded.set(true);
      },
      error: () => { if (first) this.loadError.set("Couldn't load the voice settings."); },
    });
  }

  /** The speaker whose wake words are being saved, and what went wrong for which. */
  readonly speakerBusy = signal<string | null>(null);
  readonly speakerError = signal<{ name: string; text: string } | null>(null);

  readonly maxWakeWords = computed(() => this.saved()?.maxWakeWords ?? 5);
  readonly limitChoices = computed(() => {
    const l = this.saved()?.wakeWordLimits ?? { min: 1, max: 5 };
    return Array.from({ length: l.max - l.min + 1 }, (_, i) => l.min + i);
  });
  readonly hasWakeWords = computed(() => (this.speakers() ?? []).some((sp) => sp.wakeWords?.length) && this.saved()?.maxWakeWords != null);
  readonly limitBusy = signal(false);
  readonly limitError = signal('');

  setLimit(max: number): void {
    this.limitBusy.set(true);
    this.limitError.set('');
    this.http.put<{ max: number }>('/api/nlp/voice/wake-word-limit', { max }).subscribe({
      next: (r) => { this.limitBusy.set(false); this.saved.update((v) => (v ? { ...v, maxWakeWords: r.max } : v)); },
      error: (err) => { this.limitBusy.set(false); this.limitError.set(err?.error?.error ?? "Couldn't change it. Try again."); this.load(false); },
    });
  }

  onCount(sp: BridgeSpeaker): number {
    return (sp.wakeWords ?? []).filter((w) => w.on).length;
  }

  toggleWakeWord(sp: BridgeSpeaker, id: string, on: boolean): void {
    const ids = (sp.wakeWords ?? []).filter((w) => (w.id === id ? on : w.on)).map((w) => w.id);
    this.chooseForSpeaker(sp.name, { wakeWords: ids });
  }

  setSensitivity(sp: BridgeSpeaker, level: string): void {
    this.chooseForSpeaker(sp.name, { sensitivity: level });
  }

  private chooseForSpeaker(name: string, choice: { wakeWords?: string[]; sensitivity?: string }): void {
    this.speakerBusy.set(name);
    this.speakerError.set(null);
    this.http.put('/api/nlp/voice/speakers', { name, ...choice }).subscribe({
      next: () => { this.speakerBusy.set(null); this.load(false); },
      error: (err) => {
        this.speakerBusy.set(null);
        this.speakerError.set({ name, text: err?.error?.error ?? "Couldn't change it. Try again." });
        this.load(false);
      },
    });
  }

  restart(): void {
    this.asking.set(true);
    this.restartError.set('');
    this.system.restartVoiceBridge().subscribe({
      next: () => { this.asking.set(false); this.load(false); },
      error: (err) => {
        this.asking.set(false);
        this.restartError.set(err?.error?.error ?? "Couldn't ask the voice bridge to restart. Try again.");
      },
    });
  }

  save(): void {
    this.saving.set(true);
    this.message.set('');
    const languages = ['en', ...(this.cantonese ? ['yue'] : []), ...(this.vietnamese ? ['vi'] : []), ...(this.mandarin ? ['zh'] : [])];
    this.http.put<{ enabled: boolean; languages: string[] }>('/api/nlp/voice', { enabled: this.enabled, languages }).subscribe({
      next: (s) => {
        this.saving.set(false);
        this.dirty.set(false);
        this.failed.set(false);
        this.message.set(s.enabled ? 'Saved. The voice bridge applies it within a minute.' : 'Saved. Voice is off.');
        this.saved.update((v) => (v ? { ...v, ...s } : v));
        this.load(false);
      },
      error: (err) => {
        this.saving.set(false);
        this.failed.set(true);
        this.message.set(err?.error?.error ?? "Couldn't save. Try again.");
      },
    });
  }
}
