import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SYSTEM_NAME, kwhText, money, type DeviceUsage, type HvacUsage, type Usage } from './energy.types';

interface Row { key: string; name: string; sub: string; value: number; kwh: number | null; therms: number | null; cost: number | null; detail: string }

const SHOWN = 8;
const hrs = (h: number) => (h < 10 ? h.toFixed(1) : Math.round(h).toString());

/**
 * Where it goes: each device (or room), biggest first, as bars on one shared scale; then the
 * devices HomeHub can't count yet, with a box to say what they draw; then what's left out.
 */
@Component({
  selector: 'app-energy-where',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
    .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .seg button { background: transparent; color: var(--text-muted); border: none; border-radius: 0; padding: 0.3rem 0.75rem; font-size: 0.8rem; }
    .seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
    .scale { font-size: 0.75rem; color: var(--text-muted); }
    .insight { font-size: 0.9rem; margin: 0 0 0.6rem; line-height: 1.45; }
    ul { list-style: none; margin: 0; padding: 0; }
    li.r { display: grid; grid-template-columns: minmax(8rem, 15rem) 1fr auto; gap: 0.25rem 0.8rem; align-items: center; padding: 0.45rem 0; border-top: 1px solid var(--border); }
    li.r:first-child { border-top: none; }
    .name { font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub { font-size: 0.74rem; color: var(--text-muted); grid-column: 1 / -1; margin-top: -0.15rem; }
    .track { height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; min-width: 2px; }
    .val { font-size: 0.85rem; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .more { background: none; border: none; color: var(--accent); font-size: 0.85rem; padding: 0.5rem 0 0; }
    h3 { font-size: 0.9rem; font-weight: 600; margin: 1.2rem 0 0.2rem; }
    .note { font-size: 0.8rem; color: var(--text-muted); margin: 0.2rem 0 0.4rem; line-height: 1.5; }
    li.n { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.45rem 0; border-top: 1px solid var(--border); font-size: 0.9rem; }
    li.n .who { flex: 1; min-width: 9rem; }
    li.n .who small { display: block; font-size: 0.74rem; color: var(--text-muted); }
    li.n .set { display: inline-flex; gap: 0.4rem; align-items: center; }
    li.n input { width: 5.2rem; }
    .err { color: var(--red); font-size: 0.78rem; width: 100%; }
    @media (max-width: 520px) { li.r { grid-template-columns: 1fr auto; } .track { grid-column: 1 / -1; grid-row: 2; } .sub { grid-row: 3; } }
  `],
  template: `
    <div class="card">
      @if (rows().length) {
        <div class="head">
          <div class="seg" role="group" aria-label="Group by">
            <button type="button" [attr.aria-pressed]="!byRoom()" (click)="byRoom.set(false)">Devices</button>
            <button type="button" [attr.aria-pressed]="byRoom()" (click)="byRoom.set(true)">Rooms</button>
          </div>
          <span class="scale">{{ byCost() ? 'By estimated cost' : 'By energy' }}</span>
        </div>
        @if (insight()) { <p class="insight">{{ insight() }}</p> }
        <ul>
          @for (r of visible(); track r.key) {
            <li class="r">
              <span class="name" [title]="r.name">{{ r.name }}</span>
              <div class="track" aria-hidden="true"><div class="fill" [style.width.%]="width(r)"></div></div>
              <span class="val">{{ r.detail }}</span>
              <span class="sub">{{ r.sub }}</span>
            </li>
          }
        </ul>
        @if (rows().length > shown) {
          <button type="button" class="more" (click)="all.set(!all())">{{ all() ? 'Show fewer' : 'Show all ' + rows().length }}</button>
        }
        @if (idle().length) { <p class="note">Not on this month: {{ idle().join(', ') }}.</p> }
      } @else {
        <p class="note">Nothing to count yet for this month.</p>
      }

      @if (waiting().length || hvacWaiting().length || waitingIdle().length) {
        <h3>Not counted yet</h3>
        <p class="note">HomeHub doesn’t know what these draw. An LED bulb is about 9 W: for a lamp, that’s usually it; for a wall switch, add up its bulbs. The bulb or the device’s label says.</p>
        <ul>
          @for (d of waiting(); track d.id) {
            <li class="n">
              <span class="who">{{ d.alias }}<small>{{ hrs(d.onHours) }} h on{{ d.room ? ' · ' + d.room : '' }}</small></span>
              @if (admin()) {
                <span class="set">
                  <input type="number" min="0" max="5000" step="1" [(ngModel)]="draft[d.id]" [name]="'w' + d.id" placeholder="watts" [attr.aria-label]="'Watts for ' + d.alias" />
                  <button type="button" class="btn-sm btn-primary" (click)="saveWatts(d)" [disabled]="!draft[d.id] && draft[d.id] !== 0">Save</button>
                </span>
              }
              @if (errors()[d.id]; as e) { <span class="err" role="alert">{{ e }}</span> }
            </li>
          }
          @for (h of hvacWaiting(); track h.id + h.kind) {
            <li class="n">
              <span class="who">{{ h.alias }} {{ h.kind }}<small>{{ hrs(h.hours) }} h this month</small></span>
              <a [routerLink]="['/settings']" [queryParams]="{ section: 'devices' }">Set its system in Settings → Devices → Edit</a>
            </li>
          }
        </ul>
        @if (waitingIdle().length) { <p class="note">Also without a wattage, but not on this month: {{ waitingIdle().join(', ') }}. Set theirs in Settings → Devices → Edit.</p> }
        @if (!admin()) { <p class="note">An admin can set them.</p> }
      }

      @if (excludedText()) { <p class="note" style="margin-top:0.9rem">{{ excludedText() }}</p> }
    </div>
  `,
})
export class EnergyWhereComponent {
  readonly usage = input.required<Usage>();
  readonly admin = input(false);
  readonly changed = output<void>();
  private readonly http = inject(HttpClient);

  readonly shown = SHOWN;
  readonly hrs = hrs;
  readonly byRoom = signal(false);
  readonly all = signal(false);
  readonly errors = signal<Record<number, string>>({});
  draft: Record<number, number | null> = {};

  /** Rank by cost when every counted row has one; otherwise by kWh. */
  readonly byCost = computed(() => {
    const u = this.usage();
    const counted = [...u.devices.filter((d) => d.kwh !== null && d.kwh > 0), ...u.hvac.filter((h) => h.kwh !== null)];
    return counted.length > 0 && counted.every((r) => r.cost !== null);
  });

  private deviceRow(d: DeviceUsage): Row {
    const how = d.method === 'measured' ? 'measured'
      : d.method === 'set' ? `${d.watts} W, set by you`
      : `${d.watts} W, typical for ${d.label}`;
    const sub = `${hrs(d.onHours)} h on · ${how}${d.rough ? ' · at most: it switches itself on and off' : ''}${d.room ? ' · ' + d.room : ''}`;
    return { key: `d${d.id}`, name: d.alias, sub, value: 0, kwh: d.kwh, therms: null, cost: d.cost, detail: '' };
  }

  private hvacRow(h: HvacUsage): Row {
    const sys = h.system ? SYSTEM_NAME[h.system] ?? h.system : '';
    return {
      key: `h${h.id}${h.kind}`, name: h.kind === 'heating' ? 'Heating' : 'Cooling',
      sub: `${h.alias} · ${hrs(h.hours)} h running · estimated for your ${sys}`, value: 0, kwh: h.kwh, therms: h.therms, cost: h.cost, detail: '',
    };
  }

  readonly rows = computed<Row[]>(() => {
    const u = this.usage();
    const cost = this.byCost();
    let rows: Row[] = [
      ...u.devices.filter((d) => d.kwh !== null && (d.kwh > 0 || d.onHours > 0)).map((d) => this.deviceRow(d)),
      ...u.hvac.filter((h) => h.kwh !== null && h.hours > 0).map((h) => this.hvacRow(h)),
    ];
    if (this.byRoom()) {
      const rooms = new Map<string, Row>();
      const count = new Map<string, number>();
      for (const d of u.devices.filter((x) => x.kwh !== null)) {
        const room = d.room ?? 'No room';
        const r = rooms.get(room) ?? { key: `room-${room}`, name: room, sub: '', value: 0, kwh: 0, therms: null, cost: cost ? 0 : null, detail: '' };
        r.kwh = (r.kwh ?? 0) + (d.kwh ?? 0);
        if (cost) r.cost = (r.cost ?? 0) + (d.cost ?? 0);
        count.set(room, (count.get(room) ?? 0) + 1);
        r.sub = `${count.get(room)} ${count.get(room) === 1 ? 'device' : 'devices'}`;
        rooms.set(room, r);
      }
      const hv = u.hvac.filter((h) => h.kwh !== null && h.hours > 0);
      if (hv.length) {
        rooms.set('Heating and cooling', {
          key: 'room-hvac', name: 'Heating and cooling', sub: hv.map((h) => `${hrs(h.hours)} h ${h.kind}`).join(' · '), value: 0,
          kwh: hv.reduce((s, h) => s + (h.kwh ?? 0), 0), therms: hv.reduce((s, h) => s + (h.therms ?? 0), 0) || null,
          cost: cost ? hv.reduce((s, h) => s + (h.cost ?? 0), 0) : null, detail: '',
        });
      }
      rows = [...rooms.values()];
    }
    const cur = u.prices.currency;
    for (const r of rows) {
      r.value = cost ? (r.cost ?? 0) : (r.kwh ?? 0);
      const parts = [kwhText(Math.round((r.kwh ?? 0) * 100) / 100)];
      if (r.therms) parts.push(`${Math.round(r.therms * 10) / 10} therms`);
      if (cost && r.cost !== null) parts.push(money(r.cost, cur));
      r.detail = parts.join(' · ');
    }
    return rows.filter((r) => r.value > 0 || (r.kwh ?? 0) > 0).sort((a, b) => b.value - a.value);
  });

  readonly visible = computed(() => (this.all() ? this.rows() : this.rows().slice(0, SHOWN)));

  /** What the list says, in a sentence: the biggest share, and everything else together. */
  readonly insight = computed(() => {
    const rows = this.rows();
    if (rows.length < 2) return '';
    const total = rows.reduce((s, r) => s + r.value, 0);
    if (total <= 0) return '';
    const top = rows[0];
    const share = Math.round((top.value / total) * 100);
    if (share < 40) return '';
    const what = this.byCost() ? 'the estimated cost' : 'the energy';
    const rest = total - top.value;
    const restText = this.byCost() ? money(rest, this.usage().prices.currency) : kwhText(Math.round(rest * 100) / 100);
    return `${top.name} is ${share}% of ${what} here. Everything else together: ${restText}.`;
  });
  private readonly max = computed(() => Math.max(...this.rows().map((r) => r.value), 1e-9));
  width(r: Row): number { return (r.value / this.max()) * 100; }

  readonly idle = computed(() => this.byRoom() ? [] : this.usage().devices.filter((d) => d.kwh !== null && d.onHours === 0).map((d) => d.alias));
  /** Without a wattage and on this month: these leave the totals short, so they're listed with a box. */
  readonly waiting = computed(() => this.usage().devices.filter((d) => d.kwh === null && d.onHours > 0).sort((a, b) => b.onHours - a.onHours));
  readonly waitingIdle = computed(() => this.usage().devices.filter((d) => d.kwh === null && d.onHours === 0).map((d) => d.alias));
  readonly hvacWaiting = computed(() => this.usage().hvac.filter((h) => h.kwh === null && h.hours > 0));

  readonly excludedText = computed(() => {
    const ex = this.usage().excluded;
    if (!ex.length) return '';
    const counts = new Map<string, number>();
    for (const e of ex) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
    const words = [...counts].map(([reason, n]) => (n === 1 ? `the ${reason}` : `${n} ${reason === 'valve' ? 'valves' : reason + 's'}`));
    const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0];
    return `Not included: ${list}. They aren’t plug loads, so their time on doesn’t say what they use.`;
  });

  saveWatts(d: DeviceUsage): void {
    const watts = Number(this.draft[d.id]);
    this.errors.update((e) => ({ ...e, [d.id]: '' }));
    this.http.patch(`/api/devices/${d.id}`, { watts }).subscribe({
      next: () => this.changed.emit(),
      error: (e) => this.errors.update((x) => ({ ...x, [d.id]: e?.error?.error ?? 'Couldn’t save.' })),
    });
  }
}
