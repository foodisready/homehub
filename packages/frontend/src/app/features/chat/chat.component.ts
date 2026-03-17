import { Component, signal, computed, ViewChild, ElementRef, AfterViewChecked, NgZone } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

interface ActionTaken {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

interface ChatEntry {
  role: 'user' | 'assistant';
  content: string;
  actions?: ActionTaken[];
  error?: boolean;
}

// Human-readable labels for tool names
const TOOL_LABELS: Record<string, string> = {
  list_devices:       'Listed devices',
  set_power_state:    'Toggled device',
  get_energy_metrics: 'Checked energy',
  create_schedule:    'Created schedule',
  list_schedules:     'Listed schedules',
  delete_schedule:    'Deleted schedule',
  get_sunrise_sunset: 'Checked solar times',
};

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [FormsModule, RouterLink],
  // HttpClient not needed — uses native fetch() for SSE streaming
  styles: [`
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
    }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .chat-wrap {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 160px);
      min-height: 300px;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      padding-bottom: 0.5rem;
    }

    .bubble-row {
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
    }
    .bubble-row.user { flex-direction: row-reverse; }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      font-weight: 700;
    }
    .avatar-user      { background: var(--accent); color: #fff; }
    .avatar-assistant { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); }

    .bubble {
      max-width: 75%;
      padding: 0.65rem 0.95rem;
      border-radius: 1rem;
      font-size: 0.9rem;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .bubble-user      { background: var(--accent); color: #fff; border-bottom-right-radius: 0.25rem; }
    .bubble-assistant { background: var(--surface); color: var(--text); border-bottom-left-radius: 0.25rem; }
    .bubble-error     { background: #450a0a; color: var(--red); }

    .actions-list {
      margin-top: 0.4rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
    }
    .action-chip {
      background: #0f2f1a;
      color: var(--green);
      border: 1px solid #14532d;
      border-radius: 999px;
      padding: 0.15rem 0.6rem;
      font-size: 0.72rem;
      font-weight: 500;
    }

    .typing {
      display: flex;
      gap: 5px;
      align-items: center;
      padding: 0.65rem 0.95rem;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--text-muted);
      animation: bounce 1.2s ease-in-out infinite;
    }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
      40%           { transform: scale(1);   opacity: 1; }
    }

    .cursor {
      display: inline-block;
      animation: blink 1s step-end infinite;
      color: var(--accent);
      margin-left: 1px;
    }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

    .input-row {
      display: flex;
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .input-row input {
      flex: 1;
      font-size: 0.95rem;
    }
    .btn-send {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      padding: 0.5rem 1.25rem;
      white-space: nowrap;
    }
    .btn-send:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-send:disabled { opacity: 0.5; cursor: not-allowed; }

    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .suggestion-btn {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.8rem;
      padding: 0.35rem 0.85rem;
      border-radius: 999px;
    }
    .suggestion-btn:hover { background: var(--bg); color: var(--text); border-color: var(--accent); }
  `],
  template: `
    <div class="page">

      <div class="topbar">
        <div style="display:flex; align-items:center; gap:1rem">
          <a class="back-link" routerLink="/dashboard">← Dashboard</a>
          <h1>Chat</h1>
        </div>
      </div>

      <div class="chat-wrap">

        <!-- Suggestions (only when history is empty) -->
        @if (entries().length === 0) {
          <div class="suggestions">
            @for (s of suggestions; track s) {
              <button class="suggestion-btn" (click)="useSuggestion(s)">{{ s }}</button>
            }
          </div>
        }

        <!-- Messages -->
        <div class="messages" #messageList>
          @for (entry of entries(); track $index) {
            <div class="bubble-row" [class.user]="entry.role === 'user'">
              <div class="avatar" [class.avatar-user]="entry.role === 'user'" [class.avatar-assistant]="entry.role === 'assistant'">
                {{ entry.role === 'user' ? (userInitial()) : 'AI' }}
              </div>
              <div>
                <div class="bubble" [class.bubble-user]="entry.role === 'user'" [class.bubble-assistant]="entry.role === 'assistant'" [class.bubble-error]="entry.error">
                  {{ entry.content }}
                </div>
                @if (entry.actions?.length) {
                  <div class="actions-list">
                    @for (a of entry.actions!; track $index) {
                      <span class="action-chip">{{ actionLabel(a) }}</span>
                    }
                  </div>
                }
              </div>
            </div>
          }

          <!-- Typing / streaming indicator -->
          @if (loading()) {
            <div class="bubble-row">
              <div class="avatar avatar-assistant">AI</div>
              <div class="bubble bubble-assistant">
                @if (streamingText()) {
                  {{ streamingText() }}<span class="cursor">▋</span>
                } @else {
                  <div class="typing">
                    <div class="dot"></div>
                    <div class="dot"></div>
                    <div class="dot"></div>
                  </div>
                }
              </div>
            </div>
          }
        </div>

        <!-- Input -->
        <div class="input-row">
          <input
            type="text"
            placeholder="Ask anything — &quot;turn off all lights&quot;, &quot;what's on right now?&quot;…"
            [(ngModel)]="draft"
            (keydown.enter)="send()"
            [disabled]="loading()" />
          <button class="btn-send" (click)="send()" [disabled]="!draft.trim() || loading()">
            Send
          </button>
        </div>

      </div>
    </div>
  `,
})
export class ChatComponent implements AfterViewChecked {
  @ViewChild('messageList') private messageList!: ElementRef<HTMLDivElement>;

  private readonly _entries      = signal<ChatEntry[]>([]);
  private readonly _loading      = signal(false);
  private readonly _streamingText = signal('');
  private shouldScroll = false;

  readonly entries       = this._entries.asReadonly();
  readonly loading       = this._loading.asReadonly();
  readonly streamingText = this._streamingText.asReadonly();
  readonly userInitial   = computed(() => {
    const name = this.auth.user()?.name ?? '';
    return name.charAt(0).toUpperCase() || 'U';
  });

  draft = '';

  readonly suggestions = [
    'Which devices are on right now?',
    'Turn off all devices',
    'When is sunset today?',
    'Show me all schedules',
    'Turn on the living room lamp',
  ];

  constructor(readonly auth: AuthService, private zone: NgZone) {}

  ngAfterViewChecked(): void {
    if (this.shouldScroll) {
      this.scrollToBottom();
      this.shouldScroll = false;
    }
  }

  private scrollToBottom(): void {
    const el = this.messageList?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  useSuggestion(text: string): void {
    this.draft = text;
    this.send();
  }

  send(): void {
    const text = this.draft.trim();
    if (!text || this.loading()) return;

    this.draft = '';
    this._entries.update((list) => [...list, { role: 'user', content: text }]);
    this._loading.set(true);
    this._streamingText.set('');
    this.shouldScroll = true;

    const history = this._entries()
      .slice(0, -1)
      .filter((e) => !e.error)
      .map((e) => ({ role: e.role, content: e.content }));

    const token   = this.auth.accessToken() ?? '';
    const actions: ActionTaken[] = [];

    fetch('/api/nlp/stream', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify({ message: text, history }),
    }).then(async (res) => {
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buf     = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            this.zone.run(() => {
              if (event.type === 'action') {
                actions.push(event.action);
              } else if (event.type === 'token') {
                this._streamingText.update((t) => t + event.content);
                this.shouldScroll = true;
              } else if (event.type === 'done') {
                const finalText = this._streamingText();
                this._entries.update((list) => [
                  ...list, { role: 'assistant', content: finalText, actions: [...actions] }
                ]);
                this._loading.set(false);
                this._streamingText.set('');
                this.shouldScroll = true;
              } else if (event.type === 'error') {
                this._entries.update((list) => [
                  ...list, { role: 'assistant', content: event.message, error: true }
                ]);
                this._loading.set(false);
                this._streamingText.set('');
              }
            });
          } catch { /* skip malformed line */ }
        }
      }
    }).catch((err) => {
      this.zone.run(() => {
        this._entries.update((list) => [
          ...list, { role: 'assistant', content: 'Connection error. Please try again.', error: true }
        ]);
        this._loading.set(false);
        this._streamingText.set('');
      });
    });
  }

  actionLabel(action: ActionTaken): string {
    const base = TOOL_LABELS[action.tool] ?? action.tool;
    const r = action.result as any;
    if (action.tool === 'set_power_state' && r?.alias) {
      return `${r.state === 'on' ? 'Turned on' : 'Turned off'}: ${r.alias}`;
    }
    if (action.tool === 'create_schedule' && r?.label) {
      return `Created: "${r.label}"`;
    }
    if (action.tool === 'delete_schedule' && r?.deleted_id) {
      return `Deleted schedule #${r.deleted_id}`;
    }
    return base;
  }
}
