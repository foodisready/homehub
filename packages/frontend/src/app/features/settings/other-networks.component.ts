import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface Networks { own: string[]; extra: string[]; suggested: string[]; max: number }

/**
 * Settings → Devices: other networks for Discover to search, for devices on
 * another Wi-Fi network, such as a garage access point with its own router.
 */
@Component({
  selector: 'app-other-networks',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .toggle { background:none; border:none; padding:0; color:var(--accent); font-size:0.82rem; cursor:pointer; text-align:left; }
    .toggle:hover { text-decoration:underline; }
    .panel { margin-top:0.5rem; padding:0.75rem; border:1px solid var(--border); border-radius:var(--radius); }
    p { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.5rem; line-height:1.45; }
    .chips { display:flex; flex-wrap:wrap; gap:0.4rem; margin-bottom:0.5rem; }
    .chip {
      display:inline-flex; align-items:center; gap:0.3rem; font-size:0.8rem; padding:0.2rem 0.6rem;
      border-radius:999px; border:1px solid var(--border); background:var(--bg); color:var(--text);
    }
    .chip button { background:none; border:none; padding:0; color:var(--text-muted); cursor:pointer; font-size:0.85rem; line-height:1; }
    .chip.suggest { cursor:pointer; color:var(--text-muted); border-style:dashed; }
    .chip.suggest:hover { color:var(--text); }
    .add { display:flex; gap:0.5rem; flex-wrap:wrap; }
    .add input { flex:1; min-width:9rem; font-size:0.85rem; padding:0.35rem 0.6rem; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .msg { font-size:0.8rem; margin:0.4rem 0 0; }
    .msg.err { color:var(--red); }
    .msg.ok { color:var(--green); }
    details { margin-top:0.75rem; font-size:0.82rem; }
    summary { cursor:pointer; color:var(--text); }
    details ul { margin:0.4rem 0 0; padding-left:1.1rem; color:var(--text-muted); line-height:1.5; }
    details li { margin-bottom:0.3rem; }
    .label { font-size:0.75rem; color:var(--text-muted); margin-bottom:0.3rem; }
  `],
  template: `
    <button type="button" class="toggle" (click)="expanded.set(!expanded())" [attr.aria-expanded]="expanded()">
      {{ expanded() ? '▾' : '▸' }} Devices on another Wi-Fi network?
      @if (networks()?.extra?.length) { ({{ networks()!.extra.join(', ') }}) }
    </button>

    @if (expanded()) {
      <div class="panel">
        <p>
          Discover searches HomeHub's own network{{ (networks()?.own?.length ?? 0) > 1 ? 's' : '' }}@if (networks()?.own?.length) {&#32;(<strong>{{ networks()!.own.join(', ') }}</strong>)}.
          If a device is on a different Wi-Fi network, such as a garage access point, add that network's address
          and Discover searches it too. Find it in the device's app, for example 192.168.1.20 is on <strong>192.168.1.x</strong>.
        </p>

        @if (networks()?.extra?.length) {
          <div class="label">Also searching</div>
          <div class="chips">
            @for (n of networks()!.extra; track n) {
              <span class="chip">{{ n }}
                <button type="button" (click)="remove(n)" [disabled]="saving()" [attr.aria-label]="'Stop searching ' + n">✕</button>
              </span>
            }
          </div>
        }

        <div class="add">
          <input type="text" [(ngModel)]="draft" placeholder="e.g. 192.168.1.x" aria-label="Network to search"
                 (keydown.enter)="add(draft)" autocomplete="off" />
          <button class="btn-sm btn-primary" (click)="add(draft)" [disabled]="saving() || !draft.trim()">Add network</button>
        </div>

        @if (networks()?.suggested?.length) {
          <div class="label" style="margin-top:0.6rem">Common home networks</div>
          <div class="chips">
            @for (n of networks()!.suggested; track n) {
              <button type="button" class="chip suggest" (click)="add(n)" [disabled]="saving()">+ {{ n }}</button>
            }
          </div>
        }
        @if (message()) { <p class="msg" [class.err]="isError()" [class.ok]="!isError()">{{ message() }}</p> }

        <details>
          <summary>Still can't find a device?</summary>
          <ul>
            <li>
              It works if HomeHub's router is plugged into the router that runs the other Wi-Fi.
              It can't work the other way round: a second router plugged into your main network blocks HomeHub from reaching devices behind it.
            </li>
            <li>
              <strong>Best fix:</strong> set the other router or access point to <strong>bridge</strong> or
              <strong>access point mode</strong>, so its devices join your main network.
            </li>
            <li>Or move the device to your main Wi-Fi, if it can connect to it.</li>
            <li>
              As a last resort, forward port 80 on the other router to the device, then add the router's address in
              Settings → Devices. Only do this on a router inside your home, never on the one connected to the internet.
            </li>
            <li>You can always add a device by its IP address, using Probe above.</li>
          </ul>
        </details>
      </div>
    }
  `,
})
export class OtherNetworksComponent implements OnInit {
  private readonly http = inject(HttpClient);

  readonly expanded = signal(false);
  readonly networks = signal<Networks | null>(null);
  readonly saving = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);
  draft = '';

  ngOnInit(): void {
    this.http.get<Networks>('/api/devices/discover/networks').subscribe((n) => this.networks.set(n));
  }

  /** Opens the panel, e.g. when a device on the Meross account wasn't found. */
  open(): void {
    this.expanded.set(true);
  }

  add(network: string): void {
    if (!network.trim()) return;
    const before = this.networks()?.extra.length ?? 0;
    this.save([...(this.networks()?.extra ?? []), network.trim()], () => {
      this.draft = '';
      if ((this.networks()?.extra.length ?? 0) > before) this.show('Added. Select Discover on network to search it.');
      else this.show('Discover already searches that network.');
    });
  }

  remove(network: string): void {
    this.save((this.networks()?.extra ?? []).filter((n) => n !== network), () => this.show(''));
  }

  private save(list: string[], done: () => void): void {
    this.saving.set(true);
    this.http.put<Networks>('/api/devices/discover/networks', { networks: list }).subscribe({
      next: (n) => { this.saving.set(false); this.networks.set(n); done(); },
      error: (err: HttpErrorResponse) => {
        this.saving.set(false);
        this.show(err.error?.error ?? 'Could not save the network.', true);
      },
    });
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }
}
