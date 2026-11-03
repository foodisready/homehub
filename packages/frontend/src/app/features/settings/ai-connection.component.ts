import { Component, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';

/**
 * Settings → Integrations → AI assistant: what an AI app such as Claude
 * Desktop needs to control HomeHub through its MCP server. HomeHub generates
 * the secret itself, so this is the only place to see it. Admin only.
 */
@Component({
  selector: 'app-ai-connection',
  standalone: true,
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.6rem; line-height:1.45; }
    .field { font-size:0.8rem; color:var(--text-muted); margin-top:0.5rem; }
    code { display:block; margin-top:0.2rem; padding:0.4rem 0.55rem; font-size:0.8rem; overflow-wrap:anywhere;
           background:var(--bg); border:1px solid var(--border); border-radius:var(--radius); color:var(--text); user-select:all; }
    .row { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem; align-items:center; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .msg { font-size:0.8rem; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); }
  `],
  template: `
    <p class="intro">
      Lets an AI app, such as Claude Desktop, see and switch your devices. Give the app this address and secret.
      Anyone with the secret can control every device, so share it only with apps you trust.
    </p>
    <div class="field">Address<code>{{ address }}</code></div>
    <div class="field">Secret (sent as <span style="font-family:monospace">Authorization: Bearer</span>)
      <code>{{ secret() ?? '••••••••••••••••' }}</code>
    </div>
    <div class="row">
      @if (secret() === null) {
        <button class="btn-sm btn-ghost" type="button" (click)="reveal()">Show secret</button>
      } @else {
        <button class="btn-sm btn-ghost" type="button" (click)="copy()">Copy secret</button>
        <button class="btn-sm btn-ghost" type="button" (click)="secret.set(null); message.set('')">Hide</button>
      }
      @if (message()) { <span class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</span> }
    </div>
  `,
})
export class AiConnectionComponent {
  private readonly http = inject(HttpClient);

  readonly secret = signal<string | null>(null);
  readonly message = signal('');
  readonly isError = signal(false);
  readonly address = `http://${location.hostname}:3001/mcp`;

  reveal(): void {
    this.http.get<{ secret: string | null }>('/api/home-settings/mcp').subscribe({
      next: (r) => {
        if (r.secret) this.secret.set(r.secret);
        else this.show('No MCP secret is set, so the MCP server is open on this network.', true);
      },
      error: (err: HttpErrorResponse) => this.show(err.error?.error ?? 'Could not load the secret', true),
    });
  }

  copy(): void {
    const value = this.secret();
    if (!value) return;
    // The clipboard needs a secure page (https); otherwise select the text and copy it by hand.
    if (!navigator.clipboard || !window.isSecureContext) {
      this.show('Select the secret above and copy it.');
      return;
    }
    navigator.clipboard.writeText(value).then(
      () => this.show('Copied'),
      () => this.show('Select the secret above and copy it.'),
    );
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
