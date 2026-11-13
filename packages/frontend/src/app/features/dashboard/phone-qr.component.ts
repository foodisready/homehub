import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import qrcode from 'qrcode-generator';

const QUIET_ZONE = 4;   // blank modules around the code, which scanners need

@Component({
  selector: 'app-phone-qr',
  standalone: true,
  styles: [`
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
      background: rgba(0, 0, 0, 0.6);
    }
    .panel {
      width: 100%;
      max-width: 320px;
      padding: 1.25rem;
      text-align: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    h2 { font-size: 1.1rem; font-weight: 700; margin-bottom: 0.9rem; }
    .qr { display: block; width: 100%; background: #fff; border-radius: 4px; }
    .url-row { display: flex; align-items: center; justify-content: center; gap: 0.4rem; margin-top: 0.8rem; }
    .url { font-size: 0.8rem; overflow-wrap: anywhere; min-width: 0; user-select: all; }
    .copy {
      margin: 0; flex-shrink: 0; width: 2.4rem; height: 2.4rem; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid var(--border); border-radius: 8px; color: var(--text-muted);
    }
    .copy:hover { color: var(--text); background: var(--bg); }
    .copy.done { border-color: var(--green); color: #4ade80; }
    .copy svg { width: 1.1rem; height: 1.1rem; }
    .copied { font-size: 0.75rem; color: #4ade80; margin-top: 0.3rem; min-height: 1em; }
    .hint { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.35rem; }
    button { margin-top: 0.9rem; }
  `],
  template: `
    <div class="backdrop" (click)="closed.emit()">
      <div class="panel" role="dialog" aria-label="Open HomeHub on your phone" (click)="$event.stopPropagation()">
        <h2>Open on your phone</h2>
        @if (url()) {
          <svg class="qr" [attr.viewBox]="viewBox()" role="img" [attr.aria-label]="'QR code for ' + url()">
            <path [attr.d]="path()" fill="#000" />
          </svg>
          <div class="url-row">
            <span class="url">{{ url() }}</span>
            <button class="copy" type="button" [class.done]="copied() === 'yes'" (click)="copy()"
                    [attr.aria-label]="copied() === 'yes' ? 'Copied' : 'Copy address'" [title]="copied() === 'yes' ? 'Copied' : 'Copy address'">
              @if (copied() === 'yes') {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>
              } @else {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>
              }
            </button>
          </div>
          <p class="copied" role="status">{{ copied() === 'yes' ? 'Copied' : copied() === 'no' ? 'Press and hold the address to copy it' : '' }}</p>
          @if (url().includes('.ts.net')) {
            <p class="hint">Your phone needs Tailscale turned on.</p>
          }
        }
        <button class="btn-sm btn-ghost" (click)="closed.emit()">Close</button>
      </div>
    </div>
  `,
})
export class PhoneQrComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly closed = output<void>();
  readonly url = signal('');
  /** Whether the last tap copied the address. */
  readonly copied = signal<'' | 'yes' | 'no'>('');
  private copiedTimer?: ReturnType<typeof setTimeout>;

  /**
   * Copies the address. The clipboard needs a secure page (https, or
   * localhost); on plain http, as at http://192.168.x.x, fall back to the
   * old copy command, and failing that, say how to copy it by hand.
   */
  copy(): void {
    const text = this.url();
    const done = (ok: boolean) => {
      this.copied.set(ok ? 'yes' : 'no');
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(''), ok ? 2000 : 5000);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(this.copyByCommand(text)));
    } else {
      done(this.copyByCommand(text));
    }
  }

  private copyByCommand(text: string): boolean {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    box.remove();
    return ok;
  }

  private readonly code = computed(() => {
    const qr = qrcode(0, 'M');
    qr.addData(this.url());
    qr.make();
    return qr;
  });

  readonly viewBox = computed(() => {
    const size = this.code().getModuleCount() + QUIET_ZONE * 2;
    return `0 0 ${size} ${size}`;
  });

  readonly path = computed(() => {
    const code  = this.code();
    const count = code.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return d;
  });

  ngOnInit(): void {
    this.http.get<{ url: string | null }>('/api/system/remote-url').subscribe({
      next:  ({ url }) => this.url.set(url ?? window.location.origin),
      error: ()        => this.url.set(window.location.origin),
    });
  }
}
