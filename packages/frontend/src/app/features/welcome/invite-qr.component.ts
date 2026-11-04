import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import qrcode from 'qrcode-generator';

interface Invite { id: number; code?: string; expiresAt: string; uses: number; maxUses: number }

const QUIET_ZONE = 4;
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/**
 * A QR code family members scan to make their own login. Used in first-run
 * setup and Settings → Users. Admin only.
 */
@Component({
  selector: 'app-invite-qr',
  standalone: true,
  styles: [`
    :host { display:block; }
    .qr-wrap { display:flex; gap:1.25rem; align-items:center; flex-wrap:wrap; }
    .qr { width:200px; max-width:100%; background:#fff; border-radius:8px; flex-shrink:0; }
    .side { flex:1; min-width:14rem; font-size:0.88rem; line-height:1.5; }
    .side ol { margin:0.25rem 0 0.75rem 1.1rem; }
    .muted { color:var(--text-muted); font-size:0.8rem; }
    .link { font-size:0.75rem; color:var(--text-muted); overflow-wrap:anywhere; margin:0.4rem 0; }
    .row { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem; }
    .warn { border:1px solid #b45309; background:rgba(180,83,9,0.12); border-radius:8px; padding:0.6rem 0.8rem; font-size:0.85rem; margin-bottom:0.75rem; }
    .err { color:var(--red); font-size:0.85rem; }
    .btn-sm { padding:0.35rem 0.8rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text); }
  `],
  template: `
    @if (!invite()) {
      <button class="btn-primary" type="button" (click)="create()" [disabled]="busy()">
        {{ busy() ? 'Making a code…' : 'Show an invite code' }}
      </button>
      @if (active().length) {
        <p class="muted" style="margin-top:0.5rem">
          {{ active().length === 1 ? 'An earlier invite still works' : active().length + ' earlier invites still work' }}
          until {{ until(active()[0].expiresAt) }}.
          <button class="btn-sm btn-ghost" type="button" (click)="cancelAll()">Cancel {{ active().length === 1 ? 'it' : 'them' }}</button>
        </p>
      }
    } @else {
      @if (localOnly()) {
        <p class="warn">
          This page is open on <b>{{ host }}</b>, which phones can't reach. Open HomeHub using its network address
          (such as <b>http://homehub.local:4200</b>) and make the code there.
        </p>
      }
      <div class="qr-wrap">
        <svg class="qr" [attr.viewBox]="viewBox()" role="img" aria-label="Invite QR code"><path [attr.d]="path()" fill="#000" /></svg>
        <div class="side">
          <ol>
            <li>Each person points their phone's camera at this code.</li>
            <li>They choose a name and password.</li>
            <li>HomeHub opens, ready to use, and shows how to add it to their home screen.</li>
          </ol>
          <p class="muted">Works for {{ invite()!.maxUses }} people until {{ until(invite()!.expiresAt) }}. They get family logins: they can use devices, but not change settings.</p>
          <p class="link">{{ link() }}</p>
          <div class="row">
            <button class="btn-sm btn-ghost" type="button" (click)="copy()">{{ copied() ? 'Copied' : 'Copy link' }}</button>
            <button class="btn-sm btn-ghost" type="button" (click)="cancel()">Cancel this invite</button>
          </div>
        </div>
      </div>
    }
    @if (error()) { <p class="err">{{ error() }}</p> }
  `,
})
export class InviteQrComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly invite = signal<Invite | null>(null);
  readonly active = signal<Invite[]>([]);
  readonly busy = signal(false);
  readonly copied = signal(false);
  readonly error = signal('');
  private readonly remote = signal<string | null>(null);

  readonly host = window.location.hostname;

  /** Phones reach HomeHub at this page's own address, unless it's only this computer's. */
  private readonly base = computed(() =>
    LOCAL.test(window.location.hostname) && this.remote() ? this.remote()!.replace(/\/$/, '') : window.location.origin);
  readonly localOnly = computed(() => LOCAL.test(new URL(this.base()).hostname));
  // The code goes after #, so it never reaches a server log.
  readonly link = computed(() => `${this.base()}/join#${this.invite()?.code ?? ''}`);

  private readonly qr = computed(() => {
    const qr = qrcode(0, 'M');
    qr.addData(this.link());
    qr.make();
    return qr;
  });
  readonly viewBox = computed(() => { const n = this.qr().getModuleCount() + QUIET_ZONE * 2; return `0 0 ${n} ${n}`; });
  readonly path = computed(() => {
    const qr = this.qr(), n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    return d;
  });

  ngOnInit(): void {
    this.http.get<{ url: string | null }>('/api/system/remote-url').subscribe({ next: ({ url }) => this.remote.set(url), error: () => undefined });
    this.loadActive();
  }

  private loadActive(): void {
    this.http.get<Invite[]>('/api/setup/invites').subscribe({ next: (list) => this.active.set(list), error: () => undefined });
  }

  create(): void {
    this.busy.set(true);
    this.error.set('');
    this.http.post<Invite>('/api/setup/invites', {}).subscribe({
      next: (inv) => { this.busy.set(false); this.invite.set(inv); },
      error: (err: HttpErrorResponse) => { this.busy.set(false); this.error.set(err.error?.error ?? 'Could not make an invite.'); },
    });
  }

  cancel(): void {
    const inv = this.invite();
    if (!inv) return;
    this.http.delete(`/api/setup/invites/${inv.id}`).subscribe({
      next: () => { this.invite.set(null); this.loadActive(); },
      error: () => this.error.set('Could not cancel the invite.'),
    });
  }

  cancelAll(): void {
    for (const inv of this.active()) this.http.delete(`/api/setup/invites/${inv.id}`).subscribe({ error: () => undefined });
    this.active.set([]);
  }

  copy(): void {
    navigator.clipboard?.writeText(this.link()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    }).catch(() => this.error.set('Could not copy. Select the link and copy it instead.'));
  }

  until(iso: string): string {
    return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }
}
