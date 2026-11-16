import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { SecretInputDirective } from '../../shared/secret-input/secret-input.directive';

type Mode = 'local' | 'claude';
interface AiView {
  mode: Mode;
  keyHint: string | null;
  model: string;
  price: { input: number; output: number };
  usage: { month: string; requests: number; inputTokens: number; outputTokens: number; fallbacks: number; costUsd: number; lastError?: string; lastErrorAt?: string };
}

/**
 * Settings → AI for Chat: which model works out what the rules don't understand.
 * This HomeHub's own (default) or Claude Haiku with the household's Anthropic key. Admin only.
 * The figures come from the household test set (homehub-business/evals, 2026-11-16).
 */
@Component({
  selector: 'app-ai-choice',
  standalone: true,
  imports: [FormsModule, SecretInputDirective],
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.75rem; line-height:1.45; }
    .option { display:flex; gap:0.6rem; align-items:flex-start; padding:0.65rem 0.7rem; border:1px solid var(--border);
              border-radius:var(--radius); margin-bottom:0.5rem; cursor:pointer; }
    .option.on { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, transparent); }
    .option input { width:auto; min-width:0; flex:none; margin:0.2rem 0 0; }
    .option h3 { font-size:0.9rem; margin:0 0 0.2rem; }
    .option p { font-size:0.78rem; color:var(--text-muted); margin:0; line-height:1.45; }
    .facts { display:flex; flex-wrap:wrap; gap:0.3rem; margin:0.35rem 0 0; }
    .fact { font-size:0.7rem; padding:0.05rem 0.45rem; border-radius:999px; border:1px solid var(--border); color:var(--text-muted); }
    .fact.good { border-color:var(--green); color:var(--green); }
    .fact.weak { border-color:var(--orange, #f59e0b); color:var(--orange, #f59e0b); }
    .key { margin:0.25rem 0 0.75rem 1.9rem; }
    .key label { font-size:0.8rem; color:var(--text-muted); display:block; margin-bottom:0.25rem; }
    .key .row { display:flex; gap:0.4rem; flex-wrap:wrap; align-items:center; }
    .key input { flex:1; min-width:12rem; font-size:0.85rem; }
    .hint { font-size:0.75rem; color:var(--text-muted); margin:0.35rem 0 0; line-height:1.45; }
    .saved { font-size:0.82rem; }
    .saved code { font-size:0.8rem; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text); }
    .usage { font-size:0.8rem; color:var(--text-muted); border-top:1px solid var(--border); padding-top:0.6rem; margin-top:0.6rem; line-height:1.5; }
    .usage strong { color:var(--text); font-weight:600; }
    .warn { font-size:0.8rem; color:var(--red); margin:0.35rem 0 0; overflow-wrap:anywhere; }
    .msg { font-size:0.82rem; margin:0.4rem 0 0; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); overflow-wrap:anywhere; }
    a { color:var(--accent); }
  `],
  template: `
    <p class="intro">
      When HomeHub's own rules don't understand a message in Chat, an AI model works out what was meant.
      Either way, HomeHub asks before switching anything it isn't sure about, and never opens a garage door.
      Voice commands use HomeHub's rules only, for now.
    </p>

    @if (view(); as v) {
      <label class="option" [class.on]="choice() === 'local'">
        <input type="radio" name="ai-choice" value="local" [checked]="choice() === 'local'" (change)="choose('local')" [disabled]="busy()" />
        <div>
          <h3>This HomeHub (free)</h3>
          <p>
            Private, and works without the internet, but slower and less accurate on a Pi.
            In a test of 166 real household commands in English, Cantonese and Vietnamese, it understood 121
            and often asked about the wrong device.
          </p>
          <div class="facts">
            <span class="fact good">Private</span><span class="fact good">Works offline</span>
            <span class="fact weak">121 of 166 understood</span><span class="fact weak">~15 s on a Pi 4</span>
          </div>
        </div>
      </label>

      <label class="option" [class.on]="choice() === 'claude'">
        <input type="radio" name="ai-choice" value="claude" [checked]="choice() === 'claude'" (change)="choose('claude')" [disabled]="busy()" />
        <div>
          <h3>Claude Haiku (your own Anthropic key)</h3>
          <p>
            Understood 156 of the same 166 and rarely asks about the wrong device. Messages the rules don't understand,
            with your device and room names, are sent to Anthropic. If the internet or the key stops working,
            this HomeHub answers instead.
          </p>
          <div class="facts">
            <span class="fact good">156 of 166 understood</span><span class="fact good">1–2 s</span>
            <span class="fact">About $0.0003 a message</span><span class="fact">Needs the internet</span>
          </div>
        </div>
      </label>

      @if (choice() === 'claude') {
        <div class="key">
          @if (v.keyHint && !replacing()) {
            <div class="row saved">
              <span>Key saved: <code>{{ v.keyHint }}</code></span>
              <button class="btn-sm btn-ghost" type="button" (click)="check()" [disabled]="busy()">Check key</button>
              <button class="btn-sm btn-ghost" type="button" (click)="replacing.set(true)" [disabled]="busy()">Replace</button>
              <button class="btn-sm btn-ghost" type="button" (click)="remove()" [disabled]="busy()">Remove</button>
            </div>
          } @else {
            <label for="anthropic-key">Anthropic API key</label>
            <div class="row">
              <input id="anthropic-key" class="secret" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
                     data-lpignore="true" data-1p-ignore placeholder="sk-ant-…"
                     [ngModel]="keyInput()" (ngModelChange)="keyInput.set($event)" (keyup.enter)="saveKey()" />
              <button class="btn-sm" type="button" (click)="saveKey()" [disabled]="busy() || !keyInput().trim()">
                {{ busy() ? 'Checking…' : 'Save and use Claude' }}
              </button>
              @if (v.keyHint) { <button class="btn-sm btn-ghost" type="button" (click)="replacing.set(false); keyInput.set('')">Cancel</button> }
            </div>
            <p class="hint">
              Make one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>
              (API keys), and set a monthly spending limit there, such as $5. Most homes spend a few cents a month.
              HomeHub keeps the key on this box and never shows it again.
            </p>
          }
        </div>
      }

      @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }

      @if (v.keyHint || v.usage.requests) {
        <div class="usage">
          This month: <strong>{{ v.usage.requests }}</strong> {{ v.usage.requests === 1 ? 'request' : 'requests' }} to Claude,
          about <strong>{{ dollars(v.usage.costUsd) }}</strong>.
          @if (v.usage.fallbacks) { {{ v.usage.fallbacks }} {{ v.usage.fallbacks === 1 ? 'message was' : 'messages were' }} answered by this HomeHub because Claude couldn't be reached. }
          @if (v.usage.lastError && v.mode === 'claude') {
            <p class="warn">Last problem{{ v.usage.lastErrorAt ? ' (' + when(v.usage.lastErrorAt) + ')' : '' }}: {{ v.usage.lastError }}</p>
          }
        </div>
      }
    } @else if (loadError()) {
      <p class="msg err">{{ loadError() }}</p>
    }
  `,
})
export class AiChoiceComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly view = signal<AiView | null>(null);
  /** What's ticked: Claude can be ticked before a key is saved, while the key is entered. */
  readonly choice = signal<Mode>('local');
  readonly keyInput = signal('');
  readonly replacing = signal(false);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly loadError = signal('');

  ngOnInit(): void {
    this.http.get<AiView>('/api/ai').subscribe({
      next: (v) => this.set(v),
      error: (err: HttpErrorResponse) => this.loadError.set(err.error?.error ?? 'Could not load the AI setting'),
    });
  }

  choose(mode: Mode): void {
    this.message.set('');
    this.choice.set(mode);
    const v = this.view();
    // Claude without a key waits for the key; everything else is saved now.
    if (mode === 'claude' && !v?.keyHint) return;
    if (v?.mode === mode) return;
    this.send({ mode }, mode === 'claude' ? 'Claude Haiku answers from now on.' : 'This HomeHub answers from now on.');
  }

  saveKey(): void {
    const apiKey = this.keyInput().trim();
    if (!apiKey) return;
    this.send({ apiKey, mode: 'claude' }, 'Key checked and saved. Claude Haiku answers from now on.', () => {
      this.keyInput.set('');
      this.replacing.set(false);
    });
  }

  check(): void {
    this.busy.set(true);
    this.http.post<AiView>('/api/ai/check', {}).subscribe({
      next: (v) => { this.busy.set(false); this.set(v); this.show('Anthropic accepts the key.'); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Could not check the key', true); },
    });
  }

  remove(): void {
    this.busy.set(true);
    this.http.delete<AiView>('/api/ai/key').subscribe({
      next: (v) => { this.busy.set(false); this.choice.set(v.mode); this.set(v); this.show('Key removed. This HomeHub answers from now on. You can also delete the key at console.anthropic.com.'); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.show(err.error?.error ?? 'Could not remove the key', true); },
    });
  }

  dollars(usd: number): string {
    if (usd === 0) return '$0';
    if (usd < 0.01) return 'less than 1¢';
    return `$${usd.toFixed(2)}`;
  }

  when(iso: string): string {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  private send(body: { mode?: Mode; apiKey?: string }, ok: string, done?: () => void): void {
    this.busy.set(true);
    this.http.put<AiView>('/api/ai', body).subscribe({
      next: (v) => { this.busy.set(false); this.set(v); done?.(); this.show(ok); },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        // A rejected key stays on Claude so it can be corrected; anything else goes back to what's saved.
        this.choice.set(body.apiKey ? 'claude' : (this.view()?.mode ?? 'local'));
        this.show(err.error?.error ?? 'Could not save', true);
      },
    });
  }

  private set(v: AiView): void {
    this.view.set(v);
    // Keep Claude ticked while a key is being entered.
    if (!(this.choice() === 'claude' && !v.keyHint)) this.choice.set(v.mode);
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
