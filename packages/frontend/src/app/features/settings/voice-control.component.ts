import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AutomationsService } from '../../core/services/automations.service';

interface BridgeStatus { state: 'off' | 'starting' | 'running'; kind: 'docker' | 'service' | null; version: string | null }
interface VoiceSettings { enabled: boolean; languages: string[]; bridge: BridgeStatus | null }

const POLL_MS = 5_000;

/**
 * Settings → Voice control: turns voice on or off, and adds Cantonese. The
 * voice bridge that comes with HomeHub waits until voice is on, downloads its
 * speech models the first time, and restarts by itself to apply a change.
 * Admin only.
 */
@Component({
  selector: 'app-voice-control',
  standalone: true,
  imports: [FormsModule],
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
      </div>

      <div class="bar">
        <button class="btn-primary" type="button" (click)="save()" [disabled]="saving() || !dirty()">{{ saving() ? 'Saving…' : 'Save' }}</button>
        @if (message()) { <p class="msg" [class.ok]="!failed()" [class.err]="failed()">{{ message() }}</p> }
      </div>

      <div class="status" role="status">
        <span class="dot" [class.ok]="status().tone === 'ok'" [class.busy]="status().tone === 'busy'"></span>
        <span>{{ status().text }} @if (status().command) { <code>{{ status().command }}</code> }</span>
      </div>
    } @else if (loadError()) {
      <p class="msg err">{{ loadError() }}</p>
    }
  `,
})
export class VoiceControlComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly automations = inject(AutomationsService);
  readonly standby = computed(() => { const r = this.automations.role()?.role; return r === 'backup' || r === 'dev'; });
  readonly loaded = signal(false);
  readonly loadError = signal('');
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly message = signal('');
  readonly failed = signal(false);
  private readonly saved = signal<VoiceSettings | null>(null);
  enabled = false;
  cantonese = false;
  private timer?: ReturnType<typeof setInterval>;

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
    if (!b) return { text: 'Turning on. The voice bridge checks in within a minute.', tone: 'busy' };
    if (b.state === 'off') return { text: 'Turning on…', tone: 'busy' };
    if (b.state === 'starting') return { text: 'Starting. The first time, it downloads its speech models, which can take a few minutes.', tone: 'busy' };
    return { text: `Running${b.version ? ` (${b.version})` : ''}. Speakers are listed under More → Health.`, tone: 'ok' };
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
        }
        this.loaded.set(true);
      },
      error: () => { if (first) this.loadError.set("Couldn't load the voice settings."); },
    });
  }

  save(): void {
    this.saving.set(true);
    this.message.set('');
    const languages = ['en', ...(this.cantonese ? ['yue'] : [])];
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
