import { ChangeDetectionStrategy, Component, HostListener, computed, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { AuthImgComponent } from './auth-img.component';
import type { CameraBrand } from './camera-filter';

/** One camera on the wall, whatever its kind: what it shows and what can be done with it. */
export interface WallItem {
  key: string;
  kind: CameraBrand;
  id: number;
  name: string;
  /** The group it's in when grouped by room. */
  room: string;
  /** Model, place and when it last saw motion. */
  sub: string;
  /** The picture: a live still, or the latest snapshot; null when there's none. */
  img: string | null;
  refreshSeconds: number;
  /** What shows instead of a picture. */
  failedText: string;
  status: 'watching' | 'paused' | 'offline' | 'warn' | 'checking' | 'plain';
  statusLabel: string;
  /** How old the picture is, when that's known. */
  stamp: string | null;
  doorbell: boolean;
  /** Something to know about it, such as why there's no picture. */
  hint: string | null;
  canLive: boolean;
  canSnapshot: boolean;
  /** Whether it can be paused, and whether it is; null when it can't be. */
  paused: boolean | null;
  canEdit: boolean;
  canRemove: boolean;
}

export type WallAction = 'live' | 'snapshot' | 'pause' | 'resume' | 'edit' | 'remove' | 'picture';

const GROUP_KEY = 'homehub.cameras.group';

/**
 * Every camera as a tile: its picture, whether it's watching, paused or offline, and a bell on a doorbell.
 * Tapping one opens it full screen with Live, Snapshot and Pause; swipe, the arrows or the arrow keys
 * move to the next. Pausing and removing ask first. What the buttons do is up to the page.
 */
@Component({
  selector: 'app-camera-wall',
  standalone: true,
  imports: [AuthImgComponent, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: contents; }
    .bar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.25rem; grid-column: 1 / -1; }
    .counts { display: flex; gap: 0.4rem; flex-wrap: wrap; flex: 1; }
    .count { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.76rem; padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid var(--border); color: var(--text-muted); }
    .dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--text-muted); flex: none; }
    .dot.watching { background: var(--green); } .dot.offline { background: var(--red); } .dot.warn { background: #f5b83d; }
    .group { grid-column: 1 / -1; margin: 0.6rem 0 -0.2rem 0.2rem; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .tile { padding: 0; border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--surface); color: var(--text); text-align: left; display: grid; font: inherit; cursor: pointer; }
    .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .shot { position: relative; aspect-ratio: 16 / 10; max-width: 100%; background: #0b1020; overflow: hidden; }
    .shot app-auth-img { display: block; width: 100%; height: 100%; pointer-events: none; }
    .shot .none { position: absolute; inset: 0; display: grid; place-items: center; padding: 0.5rem; text-align: center; color: #94a3b8; font-size: 0.74rem; }
    .shot.dim::after { content: attr(data-label); position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 0.82rem; font-weight: 600; background: rgba(8, 12, 22, 0.62); }
    .state { position: absolute; right: 0.4rem; top: 0.4rem; display: flex; align-items: center; gap: 0.3rem; font-size: 0.66rem; color: #fff; background: rgba(0, 0, 0, 0.55); padding: 0.1rem 0.45rem; border-radius: 999px; }
    .stamp { position: absolute; left: 0.4rem; bottom: 0.35rem; font-size: 0.66rem; color: #fff; background: rgba(0, 0, 0, 0.5); padding: 0 0.4rem; border-radius: 6px; }
    .stamp.still { left: 0.6rem; bottom: 0.6rem; font-size: 0.78rem; padding: 0.15rem 0.55rem; background: rgba(0, 0, 0, 0.6); }
    .bell { position: absolute; left: 0.4rem; top: 0.4rem; width: 1.4rem; height: 1.4rem; border-radius: 50%; background: rgba(0, 0, 0, 0.55); color: #fff; display: grid; place-items: center; }
    svg { width: 0.85rem; height: 0.85rem; }
    .cap { padding: 0.5rem 0.65rem 0.6rem; display: grid; gap: 0.05rem; min-width: 0; }
    .cap b { font-size: 0.86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cap small { font-size: 0.72rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .viewer { position: fixed; inset: 0; z-index: 50; background: #05070d; color: #fff; display: flex; flex-direction: column; animation: hh-fade .2s ease;
      padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px); }
    .vtop { display: flex; align-items: center; gap: 0.6rem; padding: 0.85rem 1rem; }
    .vtop h2 { margin: 0; font-size: 1.05rem; flex: 1; min-width: 0; }
    .vtop small { display: block; color: #9aa6c0; font-size: 0.76rem; font-weight: 400; margin-top: 0.1rem; }
    .round { width: 2.4rem; height: 2.4rem; border-radius: 50%; border: 0; padding: 0; background: rgba(255, 255, 255, 0.13); color: #fff; display: grid; place-items: center; flex: none; }
    .round svg { width: 1.1rem; height: 1.1rem; }
    .vpic { position: relative; flex: 1; min-height: 0; display: grid; place-items: center; touch-action: pan-y; }
    .vpic .shot { width: min(100%, 72rem); max-height: 100%; aspect-ratio: 16 / 9; cursor: pointer; }
    .vpic .shot app-auth-img { pointer-events: auto; }
    .step { position: absolute; top: 50%; transform: translateY(-50%); }
    .prev { left: 0.6rem; } .next { right: 0.6rem; }
    .hint { margin: 0.5rem 1rem 0; font-size: 0.8rem; color: #fbbf24; line-height: 1.45; text-align: center; }
    .msg { margin: 0.5rem 1rem 0; font-size: 0.8rem; color: #f87171; text-align: center; }
    .pos { display: flex; justify-content: center; gap: 0.35rem; padding-top: 0.6rem; font-size: 0.75rem; color: #9aa6c0; }
    .pos i { width: 0.4rem; height: 0.4rem; border-radius: 50%; background: rgba(255, 255, 255, 0.3); }
    .pos i.cur { background: #fff; }
    .acts { display: flex; gap: 0.6rem; padding: 0.85rem 1rem 1.1rem; max-width: 40rem; width: 100%; margin: 0 auto; }
    .acts button { flex: 1; border: 0; border-radius: 14px; padding: 0.8rem 0; background: rgba(255, 255, 255, 0.13); color: #fff; font-weight: 600; font-size: 0.88rem; }
    .acts button.primary { background: var(--accent); }
    .acts button:disabled { opacity: 0.4; }
    .more { display: flex; justify-content: center; gap: 1.2rem; padding-bottom: 0.6rem; }
    .more button { background: none; border: 0; color: #9aa6c0; font-size: 0.82rem; text-decoration: underline; padding: 0.3rem; }
    .hh-scrim { z-index: 55; }
    .hh-sheet p { color: var(--text-muted); line-height: 1.45; font-size: 0.9rem; }
  `],
  template: `
    @if (items().length) {
      <div class="bar">
        <div class="counts">
          @if (counts().watching) { <span class="count"><span class="dot watching"></span>{{ counts().watching }} watching</span> }
          @if (counts().paused) { <span class="count"><span class="dot"></span>{{ counts().paused }} paused</span> }
          @if (counts().offline) { <span class="count"><span class="dot offline"></span>{{ counts().offline }} offline</span> }
          @if (counts().warn) { <span class="count"><span class="dot warn"></span>{{ counts().warn }} no picture</span> }
        </div>
        @if (rooms()) {
          <div class="hh-seg" role="group" aria-label="Show cameras">
            <button type="button" [attr.aria-pressed]="grouped()" (click)="setGrouped(true)">Rooms</button>
            <button type="button" [attr.aria-pressed]="!grouped()" (click)="setGrouped(false)">All</button>
          </div>
        }
        @if (pausable().length) {
          <button type="button" class="btn-sm ghost" (click)="askAll()">{{ anyWatching() ? 'Pause all' : 'Resume all' }}</button>
        }
      </div>
    }
    @for (g of groups(); track g.name) {
      @if (g.name) { <div class="group">{{ g.name }}</div> }
      @for (c of g.items; track c.key) {
        <button type="button" class="tile" (click)="open(c)" [attr.aria-label]="c.name + ', ' + c.statusLabel">
          <ng-container *ngTemplateOutlet="picture; context: { $implicit: c, big: false }" />
          <span class="cap"><b>{{ c.name }}</b><small>{{ c.sub }}</small></span>
        </button>
      }
    }

    @if (viewing(); as c) {
      <div class="viewer" role="dialog" aria-modal="true" [attr.aria-label]="c.name">
        <div class="vtop">
          <h2>{{ c.name }}<small>{{ c.statusLabel }} · {{ c.sub }}</small></h2>
          <button type="button" class="round" (click)="close()" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div class="vpic" (touchstart)="touchStart($event)" (touchend)="touchEnd($event)">
          <ng-container *ngTemplateOutlet="picture; context: { $implicit: c, big: true }" />
          @if (items().length > 1) {
            <button type="button" class="round step prev" (click)="step(-1)" aria-label="Previous camera">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <button type="button" class="round step next" (click)="step(1)" aria-label="Next camera">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
            </button>
          }
        </div>
        @if (c.hint) { <p class="hint">{{ c.hint }}</p> }
        @if (message()) { <p class="msg" role="status">{{ message() }}</p> }
        @if (order().length > 1) {
          <div class="pos" aria-hidden="true">
            @if (order().length <= 12) { @for (x of order(); track x.key) { <i [class.cur]="x.key === c.key"></i> } }
            @else { {{ position() }} }
          </div>
        }
        <div class="acts">
          <button type="button" class="primary" (click)="act.emit({ action: 'live', item: c })" [disabled]="!c.canLive">Watch live</button>
          <button type="button" (click)="act.emit({ action: 'snapshot', item: c })" [disabled]="!c.canSnapshot || busy() === c.key">{{ busy() === c.key ? 'Saving…' : 'Snapshot' }}</button>
          @if (c.paused !== null) {
            <button type="button" (click)="c.paused ? act.emit({ action: 'resume', item: c }) : asking.set({ kind: 'pause', item: c })" [disabled]="busy() === c.key">{{ c.paused ? 'Resume' : 'Pause' }}</button>
          }
        </div>
        @if (c.canEdit || c.canRemove) {
          <div class="more">
            @if (c.canEdit) { <button type="button" (click)="act.emit({ action: 'edit', item: c })">Edit</button> }
            @if (c.canRemove) { <button type="button" (click)="asking.set({ kind: 'remove', item: c })">Remove</button> }
          </div>
        }
      </div>
    }

    @if (asking(); as a) {
      <div class="hh-scrim" (click)="asking.set(null)">
        <div class="hh-sheet" role="dialog" aria-modal="true" aria-labelledby="cam-ask" (click)="$event.stopPropagation()">
          <div class="hh-grab"></div>
          @switch (a.kind) {
            @case ('pause') {
              <h3 id="cam-ask">Pause {{ a.item!.name }}?</h3>
              <p>It stops watching, recording and detecting motion until you resume it.</p>
            }
            @case ('pause-all') {
              <h3 id="cam-ask">Pause {{ watchingPausable().length === 1 ? watchingPausable()[0].name : 'all ' + watchingPausable().length + ' cameras' }}?</h3>
              <p>They stop watching, recording and detecting motion until you resume them.@if (pausable().length < items().length) { Ring and IP cameras can't be paused, so they keep watching.}</p>
            }
            @case ('remove') {
              <h3 id="cam-ask">Take {{ a.item!.name }} out of HomeHub?</h3>
              <p>The camera itself isn't changed, and its snapshots stay here until they're old enough to delete.</p>
            }
          }
          <div class="hh-acts">
            <button type="button" (click)="asking.set(null)">Cancel</button>
            <button type="button" class="danger" (click)="confirm()">{{ a.kind === 'remove' ? 'Remove' : 'Pause' }}</button>
          </div>
        </div>
      </div>
    }

    <ng-template #picture let-c let-big="big">
      <span class="shot" [class.dim]="c.status === 'paused' || c.status === 'offline'"
            [attr.data-label]="c.status === 'paused' ? 'Paused' : c.status === 'offline' ? 'Offline' : null"
            (click)="big && c.kind === 'ring' && c.img ? act.emit({ action: 'picture', item: c }) : big && c.canLive ? act.emit({ action: 'live', item: c }) : null">
        @if (c.img) {
          <app-auth-img [src]="c.img" [alt]="c.name" [failedText]="c.failedText" [refreshSeconds]="c.status === 'paused' ? 0 : big ? Math.min(c.refreshSeconds, 10) : c.refreshSeconds"
                        (result)="thumb.emit({ key: c.key, ok: $event })" />
        } @else {
          <span class="none">{{ c.failedText }}</span>
        }
        @if (c.doorbell) {
          <span class="bell" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg></span>
        }
        @if (c.status !== 'paused' && c.status !== 'offline' && c.status !== 'plain') {
          <span class="state"><span class="dot" [class]="'dot ' + c.status"></span>{{ c.statusLabel }}</span>
        }
        @if (big && c.img && c.status !== 'paused' && c.status !== 'offline') {
          <!-- So a picture that refreshes isn't taken for live video. -->
          <span class="stamp still">{{ c.stamp ? 'Snapshot · ' + c.stamp : c.refreshSeconds ? 'Still picture · updates every ' + Math.min(c.refreshSeconds, 10) + ' s' : 'Still picture' }}{{ c.canLive ? ' · tap for live' : '' }}</span>
        } @else if (c.stamp && c.status !== 'paused' && c.status !== 'offline') { <span class="stamp">{{ c.stamp }}</span> }
      </span>
    </ng-template>
  `,
})
export class CameraWallComponent {
  readonly items = input.required<WallItem[]>();
  /** The camera whose button is busy, by key. */
  readonly busy = input<string | null>(null);
  /** The last thing that went wrong, shown in the viewer. */
  readonly message = input('');
  readonly act = output<{ action: WallAction; item: WallItem }>();
  readonly pauseAll = output<{ items: WallItem[]; pause: boolean }>();
  readonly thumb = output<{ key: string; ok: boolean }>();
  protected readonly Math = Math;

  private readonly openKey = signal<string | null>(null);
  readonly asking = signal<{ kind: 'pause' | 'pause-all' | 'remove'; item?: WallItem } | null>(null);
  readonly grouped = signal(load());

  /** More than one room, so grouping by room means something. */
  readonly rooms = computed(() => new Set(this.items().map((c) => c.room)).size > 1);
  readonly groups = computed(() => {
    if (!this.grouped() || !this.rooms()) return [{ name: '', items: this.items() }];
    const out: Array<{ name: string; items: WallItem[] }> = [];
    for (const c of this.items()) {
      const g = out.find((x) => x.name === c.room);
      if (g) g.items.push(c); else out.push({ name: c.room, items: [c] });
    }
    return out;
  });
  /** The tiles in the order they show, for moving to the next. */
  readonly order = computed(() => this.groups().flatMap((g) => g.items));
  readonly viewing = computed(() => this.items().find((c) => c.key === this.openKey()) ?? null);
  readonly position = computed(() => `${this.order().findIndex((c) => c.key === this.openKey()) + 1} of ${this.order().length}`);

  readonly counts = computed(() => {
    const n = { watching: 0, paused: 0, offline: 0, warn: 0 };
    for (const c of this.items()) if (c.status in n) n[c.status as keyof typeof n]++;
    return n;
  });
  readonly pausable = computed(() => this.items().filter((c) => c.paused !== null && c.status !== 'offline'));
  readonly watchingPausable = computed(() => this.pausable().filter((c) => !c.paused));
  readonly anyWatching = computed(() => this.watchingPausable().length > 0);

  setGrouped(on: boolean): void {
    this.grouped.set(on);
    try { localStorage.setItem(GROUP_KEY, on ? 'rooms' : 'all'); } catch { /* the choice lasts this visit */ }
  }

  open(c: WallItem): void { this.openKey.set(c.key); }
  close(): void { this.openKey.set(null); this.asking.set(null); }

  step(by: number): void {
    const list = this.order();
    const i = list.findIndex((c) => c.key === this.openKey());
    if (i < 0 || list.length < 2) return;
    this.openKey.set(list[(i + by + list.length) % list.length].key);
  }

  askAll(): void {
    if (this.anyWatching()) this.asking.set({ kind: 'pause-all' });
    else this.pauseAll.emit({ items: this.pausable().filter((c) => c.paused), pause: false });
  }

  confirm(): void {
    const a = this.asking();
    this.asking.set(null);
    if (!a) return;
    if (a.kind === 'pause-all') this.pauseAll.emit({ items: this.watchingPausable(), pause: true });
    else if (a.item) this.act.emit({ action: a.kind, item: a.item });
  }

  private x0: number | null = null;
  touchStart(e: TouchEvent): void { this.x0 = e.touches[0]?.clientX ?? null; }
  touchEnd(e: TouchEvent): void {
    if (this.x0 === null) return;
    const dx = (e.changedTouches[0]?.clientX ?? this.x0) - this.x0;
    this.x0 = null;
    if (Math.abs(dx) > 50) this.step(dx < 0 ? 1 : -1);
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent): void {
    if (!this.openKey() || document.querySelector('app-live-view, app-ring-live')) return;
    if (e.key === 'Escape') { if (this.asking()) this.asking.set(null); else this.close(); }
    else if (!this.asking() && e.key === 'ArrowRight') this.step(1);
    else if (!this.asking() && e.key === 'ArrowLeft') this.step(-1);
  }
}

function load(): boolean {
  try { return localStorage.getItem(GROUP_KEY) !== 'all'; } catch { return true; }
}
