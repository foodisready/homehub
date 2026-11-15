import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { SecretInputDirective } from '../../shared/secret-input/secret-input.directive';
import { kwhText, money, type PanelReading, type PanelRole, type PanelView, type Usage } from './energy.types';

interface Draft { key: string; name: string; role: PanelRole; watts: number | null }

const CLAMP = (k: string) => (/^\d$/.test(k) ? `Clamp ${Number(k) + 1}` : `Clamp ${k.toUpperCase()}`);

/**
 * The whole home, measured: a panel monitor (Shelly Pro 3EM) on the mains, and on a circuit or
 * two. Without one, how to add one. With one, the month's measured total, each circuit, how much
 * of it HomeHub's own devices account for, and what each clamp reads now.
 */
@Component({
  selector: 'app-energy-panel',
  standalone: true,
  imports: [FormsModule, SecretInputDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .card { padding: 1.1rem 1.25rem; }
    p { margin: 0; line-height: 1.5; font-size: 0.9rem; }
    .muted { color: var(--text-muted); font-size: 0.85rem; }
    .big { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: baseline; }
    .big .v { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
    .big .l { color: var(--text-muted); font-size: 0.8rem; }
    .rows { margin-top: 0.9rem; display: flex; flex-direction: column; gap: 0.45rem; }
    .row { display: flex; justify-content: space-between; gap: 0.2rem 0.8rem; flex-wrap: wrap; font-size: 0.9rem; padding: 0.35rem 0; border-top: 1px solid var(--border); }
    .row:first-child { border-top: none; }
    .row .n { font-weight: 600; }
    .row .w { font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .share { margin-top: 0.9rem; }
    .bar { height: 0.6rem; border-radius: 4px; background: var(--border); overflow: hidden; margin-top: 0.35rem; display: flex; }
    .bar span { display: block; height: 100%; background: var(--accent); }
    form { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.9rem; max-width: 34rem; }
    .fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0.6rem; }
    label.f { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.75rem; font-weight: 600; color: var(--text-muted); }
    .clamp { display: grid; grid-template-columns: 5rem minmax(0, 1fr) 8.5rem; gap: 0.5rem; align-items: center; font-size: 0.85rem; }
    .clamp .w { color: var(--text-muted); font-size: 0.78rem; font-variant-numeric: tabular-nums; }
    .acts { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .acts button { min-height: 38px; padding: 0 1rem; }
    .link { background: none; border: none; color: var(--accent); padding: 0; font-size: 0.85rem; text-decoration: underline; min-height: auto; }
    .err { color: var(--red); font-size: 0.85rem; }
    .warn { color: #fcd34d; font-size: 0.85rem; margin-top: 0.6rem; }
    @media (max-width: 599px) { .fields { grid-template-columns: 1fr; } .clamp { grid-template-columns: 4rem minmax(0, 1fr); } .clamp select { grid-column: 1 / -1; } }
  `],
  template: `
    <div class="card">
      @if (view(); as v) {
        @if (!v.set || setting()) {
          @if (!v.set) {
            <p>HomeHub can measure your whole home, not only estimate the devices it switches, with a panel monitor: a <b>Shelly Pro 3EM</b> fitted in the breaker panel by an electrician, with clamps on the two mains and one on a circuit such as the dryer or furnace. It’s read over the home network; nothing goes to a cloud.</p>
          }
          @if (admin()) {
            <form (submit)="$event.preventDefault(); test()">
              <div class="fields">
                <label class="f">Meter’s address <input [(ngModel)]="ip" name="ip" placeholder="e.g. 192.168.86.60" autocomplete="off" spellcheck="false" /></label>
                <label class="f">Password, if it has one
                  <input class="secret" type="text" [(ngModel)]="password" name="password" [placeholder]="v.hasPassword ? 'Saved; type to change' : 'None'" autocomplete="off" spellcheck="false" />
                </label>
              </div>
              <div class="acts">
                <button type="submit" class="btn-ghost" [disabled]="busy() || !ip.trim()">Read the meter</button>
                @if (v.set) { <button type="button" class="link" (click)="setting.set(false); drafts.set([])">Cancel</button> }
              </div>
              @if (drafts().length) {
                <p class="muted">What each clamp measures. The mains add up to the whole home.</p>
                @for (d of drafts(); track d.key) {
                  <div class="clamp">
                    <span>{{ clamp(d.key) }} <span class="w">{{ d.watts === null ? '' : watts(d.watts) }}</span></span>
                    <input [(ngModel)]="d.name" [name]="'name-' + d.key" maxlength="40" [placeholder]="d.role === 'main' ? 'Main' : 'e.g. Dryer'" aria-label="Name" />
                    <select [(ngModel)]="d.role" [name]="'role-' + d.key" aria-label="What it measures">
                      <option value="main">Mains</option>
                      <option value="circuit">A circuit</option>
                      <option value="off">Not used</option>
                    </select>
                  </div>
                }
                <div class="acts"><button type="button" class="btn-primary" (click)="save()" [disabled]="busy()">Save</button></div>
              }
              @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
            </form>
          } @else if (!v.set) {
            <p class="muted" style="margin-top:0.6rem">An admin can add one.</p>
          }
        } @else {
          @if (u().panel; as m) {
            <div class="big">
              <div><div class="v">{{ m.wholeKwh === null ? '—' : kwh(m.wholeKwh) }}</div><div class="l">Whole home, measured{{ sinceText() }}</div></div>
              @if (cost(); as c) { <div><div class="v">{{ c }}</div><div class="l">at your electricity price</div></div> }
              @if (liveWhole() !== null) { <div><div class="v">{{ watts(liveWhole()!) }}</div><div class="l">now</div></div> }
            </div>
            @if (share(); as s) {
              <div class="share">
                <p class="muted">HomeHub’s devices account for about {{ s.pct }}% ({{ kwh(s.devices) }}, estimated). The rest is the fridge, water heater, oven and anything else HomeHub doesn’t switch{{ circuitsText() }}.</p>
                <div class="bar" aria-hidden="true"><span [style.width.%]="s.pct"></span></div>
              </div>
            }
          }
          <div class="rows">
            @for (c of liveRows(); track c.key) {
              <div class="row"><span class="n">{{ c.name }}</span><span class="w">{{ rowText(c.key, c.watts) }}</span></div>
            }
          </div>
          @if (v.error) { <p class="warn">The meter isn’t answering: {{ v.error }}</p> }
          @if (v.problems?.length) { <p class="warn">The meter reports: {{ v.problems!.join(', ') }}.</p> }
          @if (admin()) { <p style="margin-top:0.8rem"><button type="button" class="link" (click)="startSetting()">Change the meter or clamps</button> · <button type="button" class="link" (click)="remove()">Remove</button></p> }
        }
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
})
export class EnergyPanelComponent implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  readonly u = input.required<Usage>();
  readonly admin = input(false);
  readonly changed = output<void>();
  readonly view = signal<PanelView | null>(null);
  readonly setting = signal(false);
  readonly drafts = signal<Draft[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  ip = '';
  password = '';
  private timer?: ReturnType<typeof setInterval>;

  readonly clamp = CLAMP;
  readonly kwh = kwhText;
  watts(w: number): string { return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(2)} kW` : `${Math.round(w)} W`; }

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => { if (document.visibilityState === 'visible' && this.view()?.set && !this.setting()) this.load(); }, 10_000);
  }
  ngOnDestroy(): void { clearInterval(this.timer); }

  load(): void {
    this.http.get<PanelView>('/api/energy/panel').subscribe({ next: (v) => this.view.set(v), error: () => this.view.set({ set: false }) });
  }

  readonly liveRows = computed(() => (this.view()?.channels ?? []).filter((c) => c.role !== 'off'));
  readonly liveWhole = computed(() => {
    const mains = this.liveRows().filter((c) => c.role === 'main' && c.watts !== null);
    return mains.length ? mains.reduce((n, c) => n + (c.watts ?? 0), 0) : null;
  });

  /** "1.10 kW now · 0.81 kWh this month" */
  rowText(key: string, w: number | null): string {
    const c = this.u().panel?.channels.find((x) => x.key === key);
    return [w === null ? '' : `${this.watts(w)} now`, c ? `${kwhText(c.kwh)} this month` : ''].filter(Boolean).join(' · ');
  }

  readonly sinceText = computed(() => {
    const since = this.u().panel?.since;
    if (!since) return '';
    const d = new Date(`${since}:00`);
    return d.getDate() > 1 || d.getHours() > 0 ? ` since ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '';
  });

  readonly cost = computed(() => {
    const m = this.u().panel, price = this.u().prices.electricity;
    return m?.wholeKwh != null && price != null ? money(m.wholeKwh * price, this.u().prices.currency) : null;
  });

  /** HomeHub's device estimates as a share of the measured whole, when both cover the same days. */
  readonly share = computed(() => {
    const m = this.u().panel;
    if (!m?.wholeKwh || m.wholeKwh < 1) return null;
    const devices = this.u().devices.reduce((n, d) => n + (d.kwh ?? 0), 0) + this.u().hvac.reduce((n, h) => n + (h.kwh ?? 0), 0);
    if (devices <= 0) return null;
    return { devices, pct: Math.min(100, Math.round((devices / m.wholeKwh) * 100)) };
  });

  readonly circuitsText = computed(() => {
    const c = (this.u().panel?.channels ?? []).filter((x) => x.role === 'circuit' && x.kwh > 0);
    return c.length ? `; ${c.map((x) => `${x.name} ${kwhText(x.kwh)}`).join(', ')} of it measured on its own circuit` : '';
  });

  startSetting(): void {
    const v = this.view();
    this.ip = v?.ip ?? '';
    this.password = '';
    this.error.set('');
    this.setting.set(true);
    if (v?.channels?.length) this.drafts.set(v.channels.map((c) => ({ key: c.key, name: c.name, role: c.role, watts: c.watts })));
  }

  test(): void {
    this.busy.set(true);
    this.error.set('');
    this.http.post<{ channels: PanelReading[] }>('/api/energy/panel/test', { ip: this.ip.trim(), password: this.password }).subscribe({
      next: (r) => {
        this.busy.set(false);
        const saved = this.view()?.channels ?? [];
        this.drafts.set(r.channels.map((c) => {
          const s = saved.find((x) => x.key === c.key);
          const role: PanelRole = s?.role ?? (c.key === 'c' || c.key === '2' ? 'circuit' : 'main');
          return { key: c.key, name: s?.name ?? '', role, watts: c.watts };
        }));
      },
      error: (e) => { this.busy.set(false); this.error.set(e?.error?.error ?? 'The meter couldn’t be read.'); },
    });
  }

  save(): void {
    this.busy.set(true);
    const channels = Object.fromEntries(this.drafts().map((d) => [d.key, { name: d.name, role: d.role }]));
    const body: Record<string, unknown> = { ip: this.ip.trim(), channels };
    if (this.password) body['password'] = this.password;
    this.http.put<PanelView>('/api/energy/panel', body).subscribe({
      next: (v) => { this.busy.set(false); this.view.set(v); this.setting.set(false); this.drafts.set([]); this.changed.emit(); },
      error: (e) => { this.busy.set(false); this.error.set(e?.error?.error ?? 'It couldn’t be saved.'); },
    });
  }

  remove(): void {
    this.http.put<PanelView>('/api/energy/panel', { ip: null }).subscribe({ next: (v) => { this.view.set(v); this.changed.emit(); } });
  }
}
