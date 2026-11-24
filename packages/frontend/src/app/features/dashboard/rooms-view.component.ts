import {
  AfterViewChecked, ChangeDetectorRef, Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild,
} from '@angular/core';
import type { Device } from '../../shared/models/device.model';
import { ThermostatService, offQuestion, shown } from '../../shared/thermostat/thermostat.service';
import { DeviceRowComponent, OverrideRequest } from './device-row/device-row.component';
import { isVacuum, vacuumWord } from '../../shared/vacuum';

/** What a device is, for its bubble: lights glow warm, plugs show watts, the rest have their own look. */
type Kind = 'light' | 'plug' | 'thermostat' | 'camera' | 'door' | 'vacuum';

const LIGHT_WORDS = /\b(lamps?|lights?|lighting|bulbs?|chandelier|pendants?|sconces?|lanterns?|led|strip)\b|燈|灯|đèn/i;

export function kindOf(d: Device): Kind {
  if (d.driverConfig?.['kind'] === 'thermostat') return 'thermostat';
  if (d.driverType === 'wyze') return 'camera';
  if (d.driverType === 'meross') return 'door';
  if (isVacuum(d)) return 'vacuum';
  if (LIGHT_WORDS.test(d.alias) || LIGHT_WORDS.test(d.power?.label ?? '') || d.nicknames.some((n) => LIGHT_WORDS.test(n))) return 'light';
  return 'plug';
}

/** A room's icon, from its name: a bed for bedrooms, a pan for the kitchen, and so on. */
export function roomIcon(name: string): string {
  const n = name.toLowerCase();
  if (/bed|bedroom|'s room|nursery|guest|房|phòng ngủ/.test(n)) return 'bed';
  if (/kitchen|廚|厨|bếp/.test(n)) return 'pan';
  if (/breakfast|dining|coffee|nook/.test(n)) return 'coffee';
  if (/garage|車房|车库|ga-ra|gara/.test(n)) return 'car';
  if (/living|family|lounge|den|tv|客廳|客厅|khách/.test(n)) return 'sofa';
  if (/hall|stair|landing|corridor|走廊/.test(n)) return 'stairs';
  if (/foyer|entry|porch|front|door|mudroom|玄關/.test(n)) return 'door';
  if (/office|study|desk|書房/.test(n)) return 'desk';
  if (/bath|toilet|washroom|laundry|浴|廁/.test(n)) return 'bath';
  if (/yard|garden|patio|deck|outdoor|outside|花園/.test(n)) return 'tree';
  return 'house';
}

const PATHS: Record<string, string> = {
  bed: 'M3 18v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7M3 14h18M7 9V6h4v3M3 18v2M21 18v2',
  coffee: 'M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9ZM16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3v3M12 3v3',
  door: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14 12h.01',
  car: 'M3 21V9l9-5 9 5v12M7 21v-6h10v6M7 18h10',
  stairs: 'M3 20h5v-4h4v-4h4V8h5',
  pan: 'M3 12h12a6 6 0 0 1-6 6H9a6 6 0 0 1-6-6ZM15 13l6-3M7 8c0-1 1-1 1-2s-1-1-1-2M11 8c0-1 1-1 1-2s-1-1-1-2',
  sofa: 'M4 11V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3M2 14a2 2 0 0 1 4 0v1h12v-1a2 2 0 0 1 4 0v4H2v-4ZM5 19v2M19 19v2',
  desk: 'M3 9h18M5 9v11M19 9v11M9 13h6M8 5h8v4H8z',
  bath: 'M4 12h16v3a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-3ZM6 12V5a2 2 0 0 1 4 0M7 20l-1 2M17 20l1 2',
  tree: 'M12 22v-6M7 16h10l-5-12-5 12Z',
  house: 'M3 11l9-7 9 7M5 9.5V20h14V9.5',
  light: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z',
  plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5',
  camera: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  vacuum: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18ZM5 9h14M12 13.5h.01',
  door_: 'M3 21V9l9-5 9 5v12M6 21v-9h12v9M6 15h12M6 18h12',
  back: 'M15 5l-7 7 7 7',
};

interface RoomTile {
  name: string;
  icon: string;
  devices: Device[];
  /** Lights and plugs on, of how many. */
  on: number;
  of: number;
  /** Share of its lights that are on, 0–1: how warm the tile glows. */
  lit: number;
  thermostats: Device[];
  camera: boolean;
  openDoor: boolean;
  door: boolean;
  offline: number;
}

const UNASSIGNED = 'Other devices';
/** More devices than this and the room view is a grid: lines from the hub to each would tangle. */
const MAX_WIRED = 8;

/**
 * Home as rooms: a tile per room that glows warmer the more of its lights are on, and,
 * tapped, the room itself, its devices as bubbles hanging off it, lit when on. Tap a
 * bubble to switch it; press and hold for its controls (the same panel as the list's).
 */
@Component({
  selector: 'app-rooms-view',
  standalone: true,
  imports: [DeviceRowComponent],
  styles: [`
    :host { display: block; scroll-margin-top: 4.5rem; --warm: #fbbf24; --heat: #fb923c; --cool: #60a5fa; --line: #33445e; --surface-2: #26354d; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(46%, 190px), 1fr)); gap: 0.75rem; }
    .tile { position: relative; text-align: left; border: 1px solid var(--line); border-radius: 20px; padding: 0.85rem 0.85rem 0.75rem;
      min-height: 8.2rem; background: var(--surface); color: var(--text); display: flex; flex-direction: column; gap: 0.5rem; overflow: hidden;
      transition: transform .15s ease, border-color .2s ease; }
    .tile:active { transform: scale(.97); }
    .glow { position: absolute; inset: 0; pointer-events: none;
      background: radial-gradient(120% 90% at 20% 0%, color-mix(in srgb, var(--warm) calc(var(--lit) * 32%), transparent), transparent 70%); }
    .top { display: flex; justify-content: space-between; align-items: flex-start; position: relative; }
    .ico { width: 2.5rem; height: 2.5rem; border-radius: 13px; display: grid; place-items: center; background: var(--surface-2); color: var(--text-muted); }
    .tile.lit .ico { background: color-mix(in srgb, var(--warm) 22%, var(--surface-2)); color: var(--warm); }
    .ico svg { width: 1.35rem; height: 1.35rem; }
    .name { position: relative; font-weight: 650; font-size: 0.98rem; line-height: 1.2; text-wrap: balance; }
    .meta { position: relative; display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: auto; }
    /* A camera watching: the red REC light, the one use of a red dot here. Problems are said in words (the "offline" chip). */
    .live { display: inline-flex; align-items: center; gap: .3rem; font-size: .7rem; color: var(--text-muted); padding: .15rem .45rem; border-radius: 99px; background: var(--surface-2); }
    .live svg { width: .85rem; height: .85rem; }
    .live i { width: 6px; height: 6px; border-radius: 50%; background: var(--red); }
    /* Lights and plugs on: warm, like the tile's glow, not green. */
    .tile .hh-chip.on { color: var(--warm); background: #fbbf2429; }

    .head { border-radius: 20px; padding: 0.85rem; background: var(--surface); border: 1px solid var(--line); position: relative; overflow: hidden; }
    .head .glow { background: radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, var(--warm) calc(var(--lit) * 28%), transparent), transparent 70%); }
    .bar { position: relative; display: flex; align-items: center; gap: 0.6rem; }
    .back { border: 0; background: var(--surface-2); color: var(--text); width: 2.3rem; height: 2.3rem; border-radius: 12px; display: grid; place-items: center; padding: 0; flex: none; }
    .back svg { width: 1.2rem; height: 1.2rem; }
    .bar h2 { margin: 0; font-size: 1.2rem; flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .all-off { border: 1px solid var(--green); color: #4ade80; background: none; border-radius: 999px; padding: 0.3rem 0.75rem; font-size: 0.8rem; flex: none; }
    .sub { position: relative; color: var(--text-muted); font-size: 0.83rem; margin-top: 0.45rem; }

    .map { position: relative; margin-top: 0.5rem; padding: 0.5rem 0 0; max-width: 560px; margin-inline: auto; }
    .wires { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
    .wires path { fill: none; stroke: var(--line); stroke-width: 2; }
    .wires path.on { stroke: var(--green); stroke-width: 2.5; stroke-dasharray: 6 8; animation: flow 1.4s linear infinite; }
    .wires path.light { stroke: var(--warm); }
    .wires path.heat { stroke: var(--heat); }
    @keyframes flow { to { stroke-dashoffset: -28; } }
    .hub { position: relative; z-index: 1; margin: 0 auto; width: 4.5rem; height: 4.5rem; border-radius: 50%; display: grid; place-items: center;
      background: var(--surface-2); border: 2px solid var(--line); color: var(--text-muted); }
    .hub.lit { border-color: color-mix(in srgb, var(--warm) 70%, var(--line)); color: var(--warm); box-shadow: 0 0 24px color-mix(in srgb, var(--warm) 35%, transparent); }
    .hub svg { width: 2rem; height: 2rem; }
    .bubbles { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: 1.6rem 0.5rem; margin-top: 3.2rem; }
    .bubbles.grid { margin-top: 1rem; }
    .bubble { border: 0; background: none; color: var(--text); display: flex; flex-direction: column; align-items: center; gap: 0.45rem; padding: 0;
      -webkit-touch-callout: none; user-select: none; touch-action: pan-y; }
    .orb { width: 4.7rem; height: 4.7rem; border-radius: 50%; display: grid; place-items: center; background: var(--surface); border: 2px solid var(--line);
      color: var(--text-muted); position: relative; transition: transform .18s ease, box-shadow .25s ease, background .25s ease, border-color .25s ease; }
    .bubble:active:not(:disabled) .orb { transform: scale(.93); }
    .orb svg { width: 1.85rem; height: 1.85rem; }
    .bubble.on .orb { border-color: var(--green); color: #4ade80; background: color-mix(in srgb, var(--green) 12%, var(--surface)); box-shadow: 0 0 22px color-mix(in srgb, var(--green) 28%, transparent); }
    .bubble.light.on .orb { border-color: var(--warm); color: var(--warm); background: color-mix(in srgb, var(--warm) 15%, var(--surface)); box-shadow: 0 0 26px color-mix(in srgb, var(--warm) 42%, transparent); }
    .bubble.offline .orb { opacity: .45; border-style: dashed; }
    .bubble.door.on .orb { border-color: #f59e0b; color: #fbbf24; background: color-mix(in srgb, #f59e0b 14%, var(--surface)); box-shadow: 0 0 22px color-mix(in srgb, #f59e0b 30%, transparent); }
    .bubble.busy .orb { opacity: .7; }
    .lbl { font-size: 0.8rem; text-align: center; line-height: 1.2; max-width: 7rem; text-wrap: balance; overflow-wrap: anywhere; }
    .st { font-size: 0.72rem; color: var(--text-muted); margin-top: -0.25rem; font-variant-numeric: tabular-nums; text-align: center; }
    .bubble.on .st { color: #4ade80; }
    .bubble.light.on .st { color: var(--warm); }
    .bubble.door.on .st { color: #fbbf24; }
    .ring { position: absolute; inset: -2px; width: calc(100% + 4px); height: calc(100% + 4px); transform: rotate(135deg); }
    .ring circle { fill: none; stroke-width: 4; stroke-linecap: round; }
    .deg { font-size: 1.15rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
    .watts { position: absolute; bottom: -2px; right: -0.4rem; font-size: 0.64rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 0 0.3rem; color: var(--text-muted); }
    .hint { text-align: center; color: var(--text-muted); font-size: 0.78rem; margin: 1.3rem 0 0; }
    .nextprev { display: flex; justify-content: space-between; gap: 0.5rem; margin-top: 1rem; max-width: 560px; margin-inline: auto; }
    .nextprev button { border: 1px solid var(--line); background: var(--surface); color: var(--text-muted); border-radius: 12px; padding: 0.45rem 0.75rem; font-size: 0.82rem;
      max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  `],
  template: `
    @if (room(); as r) {
      <!-- Swipe left or right for the next or previous room, as the buttons below do. -->
      <div [class]="'hh-swipe ' + slide()" (pointerdown)="swipeStart($event)" (pointermove)="swipeMove($event)"
           (pointerup)="swipeEnd($event)" (pointercancel)="swipe = null" (animationend)="slide.set('')">
      <div class="head" [style.--lit]="r.lit" [style.view-transition-name]="vt(r.name)">
        <span class="glow"></span>
        <div class="bar">
          <button class="back" type="button" (click)="close()" aria-label="Back to rooms"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path('back')" /></svg></button>
          <h2>{{ r.name }}</h2>
          @if (canTurnOff(r)) { <button class="all-off" type="button" (click)="allOff.emit(r.devices)">All off</button> }
        </div>
        <div class="sub">{{ subtitle(r) }}</div>
      </div>
      <div class="map" #map>
        @if (wired(r)) {
          <svg class="wires" aria-hidden="true">@for (w of wires(); track w.id) { <path [attr.d]="w.d" [attr.class]="w.cls" /> }</svg>
          <div class="hub" #hub [class.lit]="r.lit > 0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path(r.icon)" /></svg></div>
        }
        <div class="bubbles" [class.grid]="!wired(r)" [style.--cols]="cols(r)">
          @for (d of r.devices; track d.id) {
            <button class="bubble" type="button" [attr.data-id]="d.id"
                    [class]="'bubble ' + kind(d) + (isOn(d) ? ' on' : '') + (d.online ? '' : ' offline') + (busyIds().has(d.id) ? ' busy' : '')"
                    [attr.aria-label]="d.alias + ': ' + stateText(d) + '. Tap to switch; press and hold for controls.'"
                    (pointerdown)="press(d)" (pointerup)="release()" (pointerleave)="release()" (pointercancel)="release()"
                    (contextmenu)="$event.preventDefault()" (click)="tap(d)">
              <span class="orb">
                @if (kind(d) === 'thermostat') {
                  @if (therm(d); as t) {
                    <svg class="ring" viewBox="0 0 80 80" aria-hidden="true">
                      <circle cx="40" cy="40" r="36" stroke="var(--line)" [attr.stroke-dasharray]="ARC + ' ' + C" />
                      <circle cx="40" cy="40" r="36" [attr.stroke]="ringColor(d)" [attr.stroke-dasharray]="ringLen(d) + ' ' + C" />
                    </svg>
                    <span class="deg">{{ t.temperature === null ? '–' : shown(t.temperature, t.unit) + '°' }}</span>
                  } @else { <span class="deg">–</span> }
                } @else {
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path(kind(d) === 'door' ? 'door_' : kind(d))" /></svg>
                  @if (kind(d) === 'plug' && isOn(d) && d.wattage) { <span class="watts">{{ round(d.wattage) }} W</span> }
                }
              </span>
              <span class="lbl">{{ d.alias }}</span>
              <span class="st">{{ stateText(d) }}</span>
            </button>
          }
        </div>
      </div>
      <p class="hint">{{ wired(r) ? '' : 'More than 8 devices, so they\\'re shown as a grid. ' }}Tap to switch · press and hold for controls{{ tiles().length > 1 ? ' · swipe for the next room' : '' }}</p>
      </div>
      @if (tiles().length > 1) {
        <div class="nextprev">
          <button type="button" (click)="step(-1)">‹ {{ neighbour(-1) }}</button>
          <button type="button" (click)="step(1)">{{ neighbour(1) }} ›</button>
        </div>
      }
    } @else {
      <div class="tiles">
        @for (r of tiles(); track r.name) {
          <button class="tile" type="button" [class.lit]="r.lit > 0" [style.--lit]="r.lit" [style.view-transition-name]="vt(r.name)"
                  [attr.aria-label]="r.name + ', ' + tileSummary(r)" (click)="open(r.name)">
            <span class="glow"></span>
            <span class="top">
              <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path(r.icon)" /></svg></span>
              @if (r.camera) { <span class="live" title="A camera here is watching"><i></i><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="path('camera')" /></svg>Watching</span> }
            </span>
            <span class="name">{{ r.name }}</span>
            <span class="meta">
              @if (r.of) { <span class="hh-chip" [class.on]="r.on > 0">{{ r.on ? r.on + ' on' : 'All off' }}</span> }
              @for (t of r.thermostats; track t.id) {
                @if (therm(t); as v) {
                  @if (v.temperature !== null) {
                    <span class="hh-chip" [class.heat]="v.running === 'heating'" [class.cool]="v.running === 'cooling'">{{ shown(v.temperature, v.unit) }}°{{ v.mode === 'off' ? ' · off' : v.running === 'heating' ? ' · heating' : v.running === 'cooling' ? ' · cooling' : '' }}</span>
                  }
                }
              }
              @if (r.door) { <span class="hh-chip" [class.warn]="r.openDoor">{{ r.openDoor ? 'Door open' : 'Door closed' }}</span> }
              @if (r.offline) { <span class="hh-chip warn">{{ r.offline }} offline</span> }
            </span>
          </button>
        } @empty {
          <p class="hint">No devices match.</p>
        }
      </div>
    }

    @if (asking(); as a) {
      <div class="hh-scrim" (click)="asking.set(null)">
        <div class="hh-sheet" role="alertdialog" aria-modal="true" [attr.aria-label]="a.question" (click)="$event.stopPropagation()">
          <div class="hh-grab"></div>
          <h3>{{ a.question }}</h3>
          @if (a.detail) { <p>{{ a.detail }}</p> }
          <div class="hh-acts">
            <button type="button" (click)="asking.set(null)">Cancel</button>
            <button type="button" class="danger" (click)="confirmAsk()">{{ a.action }}</button>
          </div>
        </div>
      </div>
    }

    @if (controlsFor(); as d) {
      <div class="hh-scrim" (click)="controls.set(null)">
        <div class="hh-sheet" role="dialog" aria-modal="true" [attr.aria-label]="d.alias" (click)="$event.stopPropagation()">
          <div class="hh-grab"></div>
          <app-device-row [device]="d" [busy]="busyIds().has(d.id)" [startOpen]="true"
                          (toggled)="toggled.emit($event)" (overrideSet)="overrideSet.emit($event)" (overrideCancelled)="overrideCancelled.emit($event)" />
        </div>
      </div>
    }
  `,
})
export class RoomsViewComponent implements AfterViewChecked, OnDestroy {
  readonly devices = input.required<Device[]>();
  readonly busyIds = input<Set<number>>(new Set());

  readonly toggled = output<Device>();
  readonly overrideSet = output<OverrideRequest>();
  readonly overrideCancelled = output<Device>();
  readonly allOff = output<Device[]>();
  /** A room opened: these are its devices. */
  readonly roomOpened = output<number[]>();

  private readonly thermostats = inject(ThermostatService);
  private readonly cd = inject(ChangeDetectorRef);

  /**
   * A room just opened: its devices, for the page to read now rather than show what the last
   * regular check saw, so a garage door opened with its remote shows open.
   */
  private readonly announceOpenRoom = effect(() => {
    const name = this.openName();
    if (name === null) return;
    const ids = untracked(() => this.tiles().find((t) => t.name === name)?.devices.map((d) => d.id) ?? []);
    if (ids.length) this.roomOpened.emit(ids);
  });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly map = viewChild<ElementRef<HTMLElement>>('map');
  private readonly hub = viewChild<ElementRef<HTMLElement>>('hub');

  readonly shown = shown;
  readonly C = 2 * Math.PI * 36;
  readonly ARC = this.C * 0.75;

  /** The room open, or null for the tiles. */
  readonly openName = signal<string | null>(null);
  readonly asking = signal<{ device: Device; question: string; detail: string; action: string } | null>(null);
  readonly controls = signal<number | null>(null);
  readonly wires = signal<{ id: number; d: string; cls: string }[]>([]);

  private readonly watchThermostats = effect(() => {
    for (const d of this.devices()) if (kindOf(d) === 'thermostat') untracked(() => this.thermostats.watch(d.id));
  });

  readonly tiles = computed<RoomTile[]>(() => {
    const byRoom = new Map<string, Device[]>();
    for (const d of [...this.devices()].sort((a, b) => a.alias.localeCompare(b.alias))) {
      const room = d.room?.trim() || UNASSIGNED;
      byRoom.set(room, [...(byRoom.get(room) ?? []), d]);
    }
    return [...byRoom.keys()]
      .sort((a, b) => Number(a === UNASSIGNED) - Number(b === UNASSIGNED) || a.localeCompare(b))
      .map((name) => {
        const devices = byRoom.get(name)!;
        const switchable = devices.filter((d) => ['light', 'plug'].includes(kindOf(d)));
        const lights = devices.filter((d) => kindOf(d) === 'light');
        const doors = devices.filter((d) => kindOf(d) === 'door');
        return {
          name, devices, icon: name === UNASSIGNED ? 'house' : roomIcon(name),
          on: switchable.filter((d) => d.online && d.state).length,
          of: switchable.length,
          lit: lights.length ? Math.round((lights.filter((d) => d.online && d.state).length / lights.length) * 100) / 100 : 0,
          thermostats: devices.filter((d) => kindOf(d) === 'thermostat'),
          camera: devices.some((d) => kindOf(d) === 'camera' && d.online && d.state),
          door: doors.length > 0,
          openDoor: doors.some((d) => d.online && d.state),
          offline: devices.filter((d) => !d.online).length,
        };
      });
  });

  readonly room = computed(() => {
    const name = this.openName();
    return name === null ? null : this.tiles().find((t) => t.name === name) ?? null;
  });

  readonly controlsFor = computed(() => {
    const id = this.controls();
    return id === null ? null : this.devices().find((d) => d.id === id) ?? null;
  });

  // ── Opening and moving between rooms ──

  /** The tile and the room's header share a name, so the tile grows into the room. */
  vt(name: string): string { return 'room-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + name.length; }

  private transition(change: () => void): void {
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || still) { change(); return; }
    doc.startViewTransition(() => { change(); this.cd.detectChanges(); });
  }

  open(name: string): void {
    this.transition(() => this.openName.set(name));
    // The room starts at the top of the screen, wherever its tile was.
    requestAnimationFrame(() => this.host.nativeElement.scrollIntoView({ block: 'start' }));
  }
  close(): void { this.transition(() => this.openName.set(null)); }

  step(dir: -1 | 1): void {
    const list = this.tiles(), i = list.findIndex((t) => t.name === this.openName());
    if (i < 0) return;
    this.openName.set(list[(i + dir + list.length) % list.length].name);
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.slide.set(still ? '' : dir > 0 ? 'next' : 'prev');
  }

  // ── Swiping between rooms (touch only; a mouse uses the buttons) ──

  readonly slide = signal<'' | 'next' | 'prev'>('');
  swipe: { x: number; y: number; at: number; id: number; moved: boolean } | null = null;
  /** A swipe just ended: the tap that follows it mustn't switch a device. */
  private swiped = false;

  swipeStart(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || this.tiles().length < 2) return;
    this.swipe = { x: e.clientX, y: e.clientY, at: Date.now(), id: e.pointerId, moved: false };
  }

  swipeMove(e: PointerEvent): void {
    const s = this.swipe;
    if (!s || e.pointerId !== s.id || s.moved) return;
    // Moving sideways: a swipe, not a press, so no controls pop up.
    if (Math.abs(e.clientX - s.x) > 12 && Math.abs(e.clientX - s.x) > Math.abs(e.clientY - s.y)) { s.moved = true; this.release(); }
  }

  swipeEnd(e: PointerEvent): void {
    const s = this.swipe;
    this.swipe = null;
    if (!s || e.pointerId !== s.id) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - s.at > 800) return;
    this.swiped = true;
    setTimeout(() => { this.swiped = false; }, 350);
    this.step(dx < 0 ? 1 : -1);
  }
  neighbour(dir: -1 | 1): string {
    const list = this.tiles(), i = list.findIndex((t) => t.name === this.openName());
    return i < 0 ? '' : list[(i + dir + list.length) % list.length].name;
  }

  // ── What each thing shows ──

  path(name: string): string { return PATHS[name] ?? PATHS['house']; }
  kind(d: Device): Kind { return kindOf(d); }
  therm(d: Device) { return this.thermostats.views().get(d.id); }
  round(w: number): number { return Math.round(w); }
  wired(r: RoomTile): boolean { return r.devices.length <= MAX_WIRED; }
  cols(r: RoomTile): number { const n = r.devices.length; return n <= 2 ? Math.max(n, 1) : n === 4 ? 2 : 3; }

  isOn(d: Device): boolean {
    if (!d.online) return false;
    if (kindOf(d) === 'thermostat') { const t = this.therm(d); return t ? t.mode !== 'off' : d.state; }
    return d.state;
  }

  stateText(d: Device): string {
    if (!d.online) return 'Offline';
    switch (kindOf(d)) {
      case 'thermostat': {
        const t = this.therm(d);
        if (!t) return d.state ? 'On' : 'Off';
        if (t.mode === 'off') return 'Off';
        const doing = t.running === 'heating' ? 'Heating' : t.running === 'cooling' ? 'Cooling' : null;
        if (t.mode === 'heat' && t.heat !== null) return `${doing ?? 'Heat'} to ${shown(t.heat, t.unit)}°`;
        if (t.mode === 'cool' && t.cool !== null) return `${doing ?? 'Cool'} to ${shown(t.cool, t.unit)}°`;
        if (t.mode === 'auto' && t.heat !== null && t.cool !== null) return `${doing ? doing + ' · ' : ''}${shown(t.heat, t.unit)}–${shown(t.cool, t.unit)}°`;
        return 'Set on the thermostat';
      }
      case 'camera': return d.state ? 'Watching' : 'Paused';
      case 'door': return d.state ? 'Open' : 'Closed';
      case 'vacuum': return vacuumWord(d.vacuum, d.state);
      default: return d.state ? 'On' : 'Off';
    }
  }

  ringColor(d: Device): string {
    const t = this.therm(d);
    if (!t || t.mode === 'off') return 'var(--line)';
    return t.running === 'heating' ? 'var(--heat)' : t.running === 'cooling' ? 'var(--cool)' : 'var(--accent)';
  }
  /** The ring fills with the room's temperature, from 50 °F to 90 °F. */
  ringLen(d: Device): number {
    const t = this.therm(d);
    if (!t || t.temperature === null) return 0;
    const f = t.temperature * 9 / 5 + 32;
    return this.ARC * Math.max(0, Math.min(1, (f - 50) / 40));
  }

  tileSummary(r: RoomTile): string {
    return [r.of ? `${r.on} of ${r.of} on` : '', r.camera ? 'camera watching' : '', r.openDoor ? 'door open' : '', r.offline ? `${r.offline} offline` : ''].filter(Boolean).join(', ');
  }
  subtitle(r: RoomTile): string {
    const parts = [r.of ? `${r.on} of ${r.of} lights and plugs on` : 'No lights or plugs'];
    for (const d of r.thermostats) { const t = this.therm(d); if (t?.temperature != null) parts.push(`${shown(t.temperature, t.unit)}° inside`); }
    if (r.camera) parts.push('camera watching');
    if (r.offline) parts.push(`${r.offline} offline`);
    return parts.join(' · ');
  }
  /** "All off" here, as on the list: lights and plugs, never a thermostat or anything protected. */
  canTurnOff(r: RoomTile): boolean {
    return r.devices.some((d) => d.online && d.state && !d.isProtected && kindOf(d) !== 'thermostat' && kindOf(d) !== 'vacuum');
  }

  // ── Tap to switch, press and hold for controls ──

  private holdTimer?: ReturnType<typeof setTimeout>;
  private held = false;

  press(d: Device): void {
    this.held = false;
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => { this.held = true; this.controls.set(d.id); }, 480);
  }
  release(): void { clearTimeout(this.holdTimer); }

  tap(d: Device): void {
    if (this.swiped) return;
    if (this.held) { this.held = false; return; }
    if (!d.online) { this.controls.set(d.id); return; }
    if (this.busyIds().has(d.id)) return;
    const k = kindOf(d);
    // The same questions as the list's switch: a thermostat turned off, a garage door, a camera paused, anything protected.
    if (k === 'thermostat' && d.state) {
      const q = offQuestion(this.therm(d), d.alias);
      const split = q.indexOf('? ');
      this.asking.set({ device: d, question: split > 0 ? q.slice(0, split + 1) : q, detail: split > 0 ? q.slice(split + 2) : '', action: 'Turn off' });
      return;
    }
    if (k === 'door') { this.asking.set({ device: d, question: `${d.state ? 'Close' : 'Open'} ${d.alias}?`, detail: '', action: d.state ? 'Close' : 'Open' }); return; }
    if (k === 'camera' && d.state) { this.asking.set({ device: d, question: `Pause ${d.alias}?`, detail: 'It stops watching until you resume it.', action: 'Pause' }); return; }
    if (d.isProtected && k !== 'camera') { this.asking.set({ device: d, question: `Turn ${d.state ? 'off' : 'on'} ${d.alias}?`, detail: `${d.alias} is protected.`, action: `Turn ${d.state ? 'off' : 'on'}` }); return; }
    this.toggled.emit(d);
  }

  confirmAsk(): void {
    const a = this.asking();
    this.asking.set(null);
    if (a) this.toggled.emit(a.device);
  }

  // ── The lines from the room to each device ──

  private lastWires = '';
  private observer?: ResizeObserver;

  ngAfterViewChecked(): void {
    const map = this.map()?.nativeElement;
    if (map && !this.observer && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.drawWires());
      this.observer.observe(map);
    }
    if (!map && this.observer) { this.observer.disconnect(); this.observer = undefined; }
    this.drawWires();
  }

  ngOnDestroy(): void { this.observer?.disconnect(); clearTimeout(this.holdTimer); }

  private drawWires(): void {
    const map = this.map()?.nativeElement, hub = this.hub()?.nativeElement, r = this.room();
    if (!map || !hub || !r || !this.wired(r)) { if (this.lastWires) { this.lastWires = ''; this.wires.set([]); } return; }
    const m = map.getBoundingClientRect(), h = hub.getBoundingClientRect();
    const x0 = h.left + h.width / 2 - m.left, y0 = h.bottom - m.top;
    const out: { id: number; d: string; cls: string }[] = [];
    for (const el of Array.from(map.querySelectorAll<HTMLElement>('.bubble'))) {
      const d = r.devices.find((x) => String(x.id) === el.dataset['id']);
      const orb = el.querySelector('.orb')?.getBoundingClientRect();
      if (!d || !orb) continue;
      const x1 = orb.left + orb.width / 2 - m.left, y1 = orb.top - m.top, my = (y0 + y1) / 2;
      const k = kindOf(d), t = k === 'thermostat' ? this.therm(d) : undefined;
      const cls = !this.isOn(d) ? '' : k === 'light' ? 'on light' : t?.running === 'heating' ? 'on heat' : 'on';
      out.push({ id: d.id, d: `M${x0.toFixed(1)},${y0.toFixed(1)} C${x0.toFixed(1)},${my.toFixed(1)} ${x1.toFixed(1)},${my.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`, cls });
    }
    const key = JSON.stringify(out);
    if (key !== this.lastWires) { this.lastWires = key; queueMicrotask(() => this.wires.set(out)); }
  }
}
