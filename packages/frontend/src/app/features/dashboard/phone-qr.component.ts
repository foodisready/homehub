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
    .url { font-size: 0.8rem; margin-top: 0.8rem; overflow-wrap: anywhere; }
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
          <p class="url">{{ url() }}</p>
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
