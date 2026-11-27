import { Component, ElementRef, OnDestroy, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Subscription } from 'rxjs';
import type { Device } from '../../shared/models/device.model';
import { FloorsService, shrinkPicture, type Floor, type FloorPin } from '../../shared/floors.service';
import { PATHS, kindOf, roomIcon } from './rooms-view.component';

/** How a room on the map looks: lit by its lights, and how many things are on. */
interface RoomState { lit: number; on: number; of: number; offline: number }

const FLOOR_KEY = 'homehub.map.floor';
const ZOOMS = [1, 1.5, 2, 3];

function readFloor(): number | null {
  try { const v = Number(localStorage.getItem(FLOOR_KEY)); return Number.isInteger(v) && v > 0 ? v : null; } catch { return null; }
}

/**
 * The home as a picture: a photo, a sketch or the robot's map, with each room marked where it is.
 * A room glows when its lights are on; tap it to go in. Admins add pictures and place the rooms.
 * See docs/FLOOR_MAP.md.
 */
@Component({
  selector: 'app-floor-map',
  standalone: true,
  styles: [`
    :host { display: block; }
    .bar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
    .tabs { display: inline-flex; gap: 0.35rem; flex-wrap: wrap; }
    .tabs button { border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); border-radius: 999px; padding: 0.35rem 0.9rem; font-size: 0.9rem; }
    .tabs button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
    .grow { flex: 1; }
    .zoom { display: inline-flex; border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
    .zoom button { border: 0; background: var(--surface); color: var(--text); width: 2.6rem; height: 2.3rem; font-size: 1.2rem; padding: 0; }
    .zoom button:disabled { opacity: 0.35; }
    .zoom button + button { border-left: 1px solid var(--border); }
    .edit-btn { border: 1px solid var(--border); background: transparent; color: var(--text-muted); border-radius: 999px; padding: 0.35rem 0.9rem; font-size: 0.85rem; }

    .scroller { overflow: auto; border-radius: 14px; border: 1px solid var(--border); background: #e5e7eb; max-height: 78vh; touch-action: pan-x pan-y; }
    .canvas { position: relative; min-width: 100%; }
    .canvas img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; pointer-events: none; }
    .canvas.placing { cursor: crosshair; }
    .loading-img { padding: 3rem 1rem; text-align: center; color: #334155; }

    /* A room: a round marker with its icon and name, big enough for any finger. */
    .pin {
      position: absolute; transform: translate(-50%, -50%);
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      background: none; border: 0; padding: 0; color: #0f172a; touch-action: none;
      --lit: 0;
    }
    .dot {
      position: relative; width: 3rem; height: 3rem; border-radius: 50%; display: grid; place-items: center;
      background: #f8fafc; border: 2px solid #64748b; color: #334155;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.35);
    }
    .dot svg { width: 1.5rem; height: 1.5rem; }
    .pin.lit .dot {
      background: radial-gradient(circle, #fff7d6 0%, #fde68a 60%, #fbbf24 100%); border-color: #d97706; color: #78350f;
      box-shadow: 0 0 calc(10px + 22px * var(--lit)) calc(4px + 10px * var(--lit)) rgba(251, 191, 36, 0.75), 0 2px 8px rgba(15, 23, 42, 0.35);
    }
    .pin.away .dot { border-style: dashed; opacity: 0.7; }
    .count { position: absolute; top: -0.35rem; right: -0.45rem; min-width: 1.3rem; height: 1.3rem; border-radius: 999px; background: #16a34a; color: #fff; font-size: 0.75rem; font-weight: 700; display: grid; place-items: center; padding: 0 0.25rem; }
    .warn { background: #dc2626; }
    .name {
      background: rgba(255, 255, 255, 0.94); color: #0f172a; border-radius: 999px; padding: 0.15rem 0.55rem;
      font-size: 0.85rem; font-weight: 700; white-space: nowrap; box-shadow: 0 1px 4px rgba(15, 23, 42, 0.3);
    }
    .pin.chosen .dot { outline: 3px solid var(--accent); outline-offset: 2px; }
    .pin.stale .dot { border-color: #dc2626; }
    .editing .pin { cursor: grab; }
    /* A phone: smaller markers, so rooms next to each other don't cover each other. Zoom in for bigger ones. */
    @media (max-width: 600px) {
      .dot { width: 2.4rem; height: 2.4rem; }
      .dot svg { width: 1.2rem; height: 1.2rem; }
      .name { font-size: 0.75rem; padding: 0.1rem 0.45rem; }
    }

    .hint { color: var(--text-muted); font-size: 0.85rem; text-align: center; margin: 0.6rem 0 0; }
    .empty { text-align: center; padding: 2rem 1rem; }
    .empty h3 { margin: 0 0 0.4rem; }
    .empty p { color: var(--text-muted); margin: 0 auto 1rem; max-width: 30rem; line-height: 1.5; }
    .pick { display: inline-block; cursor: pointer; }
    .pick input { display: none; }
    .err { color: #fca5a5; font-size: 0.85rem; margin: 0.4rem 0; }

    .tools { display: flex; flex-direction: column; gap: 0.7rem; margin-top: 0.8rem; }
    .row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
    .row input[type=text] { flex: 1; min-width: 10rem; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 0.35rem 0.8rem; font-size: 0.85rem; }
    .chip.on { border-color: var(--green); color: #4ade80; }
    .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip.stale { border-color: #dc2626; color: #fca5a5; }
    .lbl { font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }
    .danger { color: #fca5a5; border-color: #7f1d1d; }
  `],
  template: `
    @if (!floors.loaded()) {
      <p class="hint">Loading the map…</p>
    } @else if (floors.floors().length === 0) {
      <div class="card empty">
        <h3>Your home as a picture</h3>
        @if (isAdmin()) {
          <p>Add a picture of a floor: a photo of a sketch on paper, the house plan, or a screenshot of the
             robot vacuum's map. Then tap where each room is, and anyone can tap a room to go in.</p>
          <label class="pick btn-primary">
            <input type="file" accept="image/*" (change)="addFloor($event)" [disabled]="busy()" />
            {{ busy() ? 'Adding…' : 'Add a picture' }}
          </label>
          @if (error()) { <p class="err">{{ error() }}</p> }
        } @else {
          <p>An administrator can add a picture of your home here, so you can tap a room to go in.</p>
        }
      </div>
    } @else {
      <div class="bar">
        @if (floors.floors().length > 1 || editing()) {
          <div class="tabs" role="group" aria-label="Floor">
            @for (f of floors.floors(); track f.id) {
              <button type="button" [attr.aria-pressed]="f.id === floor()?.id" (click)="chooseFloor(f.id)">{{ f.name }}</button>
            }
            @if (editing()) {
              <label class="pick tabs-add"><input type="file" accept="image/*" (change)="addFloor($event)" [disabled]="busy()" />
                <span class="chip">+ Floor</span></label>
            }
          </div>
        }
        <span class="grow"></span>
        <div class="zoom" role="group" aria-label="Zoom">
          <button type="button" (click)="zoomBy(-1)" [disabled]="zoomAt() === 0" aria-label="Zoom out">−</button>
          <button type="button" (click)="zoomBy(1)" [disabled]="zoomAt() === ZOOMS.length - 1" aria-label="Zoom in">+</button>
        </div>
        @if (isAdmin() && !editing()) { <button class="edit-btn" type="button" (click)="startEdit()">Edit map</button> }
      </div>

      @if (floor(); as f) {
        <div class="scroller">
          <div #canvas class="canvas" [class.placing]="editing() && placing() !== null" [class.editing]="editing()"
               [style.width.%]="ZOOMS[zoomAt()] * 100" (click)="canvasTap($event)">
            @if (picture()) {
              <img [src]="picture()" [alt]="'Map of ' + f.name" />
            } @else {
              <div class="loading-img">{{ pictureFailed() ? 'The picture could not be loaded.' : 'Loading the picture…' }}</div>
            }
            @if (picture()) {
              @for (p of shownPins(); track p.room) {
                @if (state(p.room); as s) {
                  <button type="button" class="pin" [class.lit]="s.lit > 0" [style.--lit]="s.lit" [class.away]="s.of === 0 && s.offline > 0"
                          [class.chosen]="editing() && chosen() === p.room" [class.stale]="editing() && !exists(p.room)"
                          [style.left.%]="p.x * 100" [style.top.%]="p.y * 100"
                          [attr.aria-label]="p.room + (s.of ? ', ' + (s.on ? s.on + ' on' : 'all off') : '') + (editing() ? '. Drag to move.' : '. Tap to go in.')"
                          (pointerdown)="pinDown($event, p)" (click)="pinTap($event, p.room)">
                    <span class="dot">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path [attr.d]="iconPath(p.room)" /></svg>
                      @if (s.on) { <span class="count">{{ s.on }}</span> }
                      @else if (s.offline) { <span class="count warn" title="Offline">!</span> }
                    </span>
                    <span class="name">{{ p.room }}</span>
                  </button>
                }
              }
            }
          </div>
        </div>

        @if (!editing()) {
          <p class="hint">Tap a room to go in{{ hiddenRooms() ? ' · ' + hiddenRooms() + ' room' + (hiddenRooms() === 1 ? '' : 's') + ' not on this map' : '' }}</p>
        } @else {
          <div class="card tools">
            @if (placing(); as room) {
              <p class="hint" style="margin:0">Tap the picture where <strong>{{ room }}</strong> is.</p>
            } @else {
              <p class="hint" style="margin:0">Choose a room, then tap where it is. Drag a room on the picture to move it.</p>
            }
            <div>
              <div class="lbl">Rooms</div>
              <div class="chips">
                @for (r of rooms(); track r) {
                  <button type="button" class="chip" [class.on]="placedHere(r)" [attr.aria-pressed]="placing() === r || chosen() === r" (click)="chooseRoom(r)">
                    {{ placedHere(r) ? '✓ ' : '' }}{{ r }}{{ placedElsewhere(r) ? ' (' + placedElsewhere(r) + ')' : '' }}
                  </button>
                }
                @for (p of stalePins(); track p.room) {
                  <button type="button" class="chip stale" [attr.aria-pressed]="chosen() === p.room" (click)="chosen.set(p.room); placing.set(null)">{{ p.room }} · no devices</button>
                }
              </div>
            </div>
            @if (chosen(); as c) {
              <div class="row">
                <span class="grow">{{ exists(c) ? c + ' is placed.' : c + ' has no devices now (renamed or emptied).' }}</span>
                <button type="button" class="btn-ghost" (click)="placing.set(c)">Move</button>
                <button type="button" class="btn-ghost danger" (click)="removePin(c)">Take off the map</button>
              </div>
            }
            <div class="row">
              <span class="lbl">Floor name</span>
              <input type="text" maxlength="40" [value]="f.name" #nameBox (change)="rename(f, nameBox.value)" aria-label="Floor name" />
            </div>
            <div class="row">
              <label class="pick btn-ghost"><input type="file" accept="image/*" (change)="replacePicture(f, $event)" [disabled]="busy()" />Replace picture</label>
              <button type="button" class="btn-ghost danger" (click)="deleteFloor(f)" [disabled]="busy()">Delete this floor</button>
              <span class="grow"></span>
              <button type="button" class="btn-ghost" (click)="cancelEdit()" [disabled]="busy()">Cancel</button>
              <button type="button" class="btn-primary" (click)="save()" [disabled]="busy()">{{ busy() ? 'Saving…' : 'Done' }}</button>
            </div>
            @if (error()) { <p class="err">{{ error() }}</p> }
          </div>
        }
      }
    }
  `,
})
export class FloorMapComponent implements OnDestroy {
  readonly floors = inject(FloorsService);
  private readonly http = inject(HttpClient);

  readonly devices = input.required<Device[]>();
  readonly isAdmin = input(false);
  /** A room tapped: open it. */
  readonly roomPicked = output<string>();

  readonly ZOOMS = ZOOMS;
  readonly zoomAt = signal(0);
  readonly floorId = signal<number | null>(readFloor());
  readonly editing = signal(false);
  /** While editing: where each room is on the floor shown, not yet saved. */
  readonly draft = signal<FloorPin[]>([]);
  /** The room waiting for a tap on the picture. */
  readonly placing = signal<string | null>(null);
  /** The room picked on the picture, to move or take off. */
  readonly chosen = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly picture = signal<string | null>(null);
  readonly pictureFailed = signal(false);

  private readonly canvas = viewChild<ElementRef<HTMLElement>>('canvas');
  private pictureSub?: Subscription;

  constructor() {
    this.floors.load();
  }

  readonly floor = computed<Floor | null>(() => {
    const all = this.floors.floors();
    return all.find((f) => f.id === this.floorId()) ?? all[0] ?? null;
  });

  /** Which picture to show: changes with the floor or a new picture, not when rooms move. */
  private readonly pictureKey = computed(() => { const f = this.floor(); return f ? `${f.id}|${f.updatedAt}` : ''; });

  /** The picture of the floor shown, fetched with the sign-in (a plain <img src> can't send it). */
  private readonly loadPicture = effect(() => {
    this.pictureKey();
    untracked(() => {
      const f = this.floor();
      this.pictureSub?.unsubscribe();
      const old = this.picture();
      if (old) URL.revokeObjectURL(old);
      this.picture.set(null);
      this.pictureFailed.set(false);
      if (!f) return;
      this.pictureSub = this.http.get(this.floors.imageUrl(f), { responseType: 'blob' }).subscribe({
        next: (b) => this.picture.set(URL.createObjectURL(b)),
        error: () => this.pictureFailed.set(true),
      });
    });
  });

  /** The rooms HomeHub knows, from its devices. */
  readonly rooms = computed(() => [...new Set(this.devices().map((d) => d.room?.trim()).filter((r): r is string => !!r))]
    .sort((a, b) => a.localeCompare(b)));

  private readonly states = computed(() => {
    const out = new Map<string, RoomState>();
    for (const room of this.rooms()) {
      const devices = this.devices().filter((d) => d.room?.trim() === room);
      const switchable = devices.filter((d) => ['light', 'plug'].includes(kindOf(d)));
      const lights = devices.filter((d) => kindOf(d) === 'light');
      out.set(room, {
        on: switchable.filter((d) => d.online && d.state).length,
        of: switchable.length,
        lit: lights.length ? lights.filter((d) => d.online && d.state).length / lights.length : 0,
        offline: devices.filter((d) => !d.online).length,
      });
    }
    return out;
  });

  /** A room's look; a room with no devices any more shows only while editing. */
  state(room: string): RoomState | null {
    return this.states().get(room) ?? (this.editing() ? { lit: 0, on: 0, of: 0, offline: 0 } : null);
  }
  exists(room: string): boolean { return this.states().has(room); }

  readonly shownPins = computed(() => (this.editing() ? this.draft() : this.floor()?.pins ?? []));
  readonly stalePins = computed(() => this.draft().filter((p) => !this.exists(p.room)));
  /** Rooms with devices that aren't on any floor. */
  readonly hiddenRooms = computed(() => {
    const placed = new Set(this.floors.floors().flatMap((f) => f.pins.map((p) => p.room)));
    return this.rooms().filter((r) => !placed.has(r)).length;
  });

  placedHere(room: string): boolean { return this.draft().some((p) => p.room === room); }
  /** The other floor a room is on, if any. */
  placedElsewhere(room: string): string {
    const id = this.floor()?.id;
    return this.floors.floors().find((f) => f.id !== id && f.pins.some((p) => p.room === room))?.name ?? '';
  }

  iconPath(room: string): string { return PATHS[roomIcon(room)] ?? PATHS['house']; }

  chooseFloor(id: number): void {
    if (this.editing()) this.draft.set([...(this.floors.floors().find((f) => f.id === id)?.pins ?? [])]);
    this.floorId.set(id);
    this.placing.set(null);
    this.chosen.set(null);
    try { localStorage.setItem(FLOOR_KEY, String(id)); } catch { /* this visit only */ }
  }

  zoomBy(step: number): void {
    this.zoomAt.update((z) => Math.min(ZOOMS.length - 1, Math.max(0, z + step)));
  }

  // ── Looking ──

  pinTap(e: Event, room: string): void {
    e.stopPropagation();
    if (this.editing()) {
      if (this.moved) return;
      this.chosen.set(room);
      this.placing.set(null);
      return;
    }
    if (this.exists(room)) this.roomPicked.emit(room);
  }

  // ── Editing ──

  startEdit(): void {
    this.draft.set([...(this.floor()?.pins ?? [])]);
    this.error.set('');
    this.editing.set(true);
  }

  cancelEdit(): void {
    this.editing.set(false);
    this.placing.set(null);
    this.chosen.set(null);
    this.error.set('');
  }

  chooseRoom(room: string): void {
    this.error.set('');
    if (this.placedHere(room)) { this.chosen.set(room); this.placing.set(null); return; }
    this.chosen.set(null);
    this.placing.set(this.placing() === room ? null : room);
  }

  private at(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const box = this.canvas()?.nativeElement.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
    return { x: clamp((e.clientX - box.left) / box.width), y: clamp((e.clientY - box.top) / box.height) };
  }

  canvasTap(e: MouseEvent): void {
    const room = this.placing();
    if (!this.editing() || room === null) return;
    const p = this.at(e);
    if (!p) return;
    this.draft.update((pins) => [...pins.filter((x) => x.room !== room), { room, ...p }]);
    this.placing.set(null);
    this.chosen.set(room);
  }

  /** Dragging a room on the picture moves it. */
  private dragging: string | null = null;
  private moved = false;
  private start = { x: 0, y: 0 };
  private readonly onMove = (e: PointerEvent) => {
    if (this.dragging === null) return;
    if (!this.moved && Math.hypot(e.clientX - this.start.x, e.clientY - this.start.y) < 6) return;
    this.moved = true;
    const p = this.at(e);
    const room = this.dragging;
    if (p) this.draft.update((pins) => pins.map((x) => (x.room === room ? { room, ...p } : x)));
  };
  private readonly onUp = () => {
    this.dragging = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onUp);
    // The click that follows a drag isn't a tap on the room.
    setTimeout(() => { this.moved = false; }, 0);
  };

  pinDown(e: PointerEvent, p: FloorPin): void {
    if (!this.editing()) return;
    e.preventDefault();
    this.dragging = p.room;
    this.moved = false;
    this.start = { x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
  }

  removePin(room: string): void {
    this.draft.update((pins) => pins.filter((p) => p.room !== room));
    this.chosen.set(null);
  }

  save(): void {
    const f = this.floor();
    if (!f) return;
    this.busy.set(true);
    this.error.set('');
    this.floors.savePins(f.id, this.draft()).subscribe({
      next: () => { this.busy.set(false); this.cancelEdit(); },
      error: (e) => { this.busy.set(false); this.error.set(e?.error?.error ?? 'Could not save the map.'); },
    });
  }

  rename(f: Floor, name: string): void {
    const clean = name.trim();
    if (!clean || clean === f.name) return;
    this.floors.rename(f.id, clean).subscribe({ error: (e) => this.error.set(e?.error?.error ?? 'Could not rename the floor.') });
  }

  private async picked(e: Event): Promise<Blob | null> {
    const inputEl = e.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return null;
    this.error.set('');
    try {
      return await shrinkPicture(file);
    } catch {
      this.error.set('That file could not be read as a picture. Try a photo or a screenshot.');
      return null;
    }
  }

  async addFloor(e: Event): Promise<void> {
    this.busy.set(true);
    const image = await this.picked(e);
    if (!image) { this.busy.set(false); return; }
    const n = this.floors.floors().length;
    const name = n === 0 ? 'Main floor' : `Floor ${n + 1}`;
    this.floors.add(name, image).subscribe({
      next: (f) => {
        this.busy.set(false);
        this.floorId.set(f.id);
        try { localStorage.setItem(FLOOR_KEY, String(f.id)); } catch { /* this visit only */ }
        this.startEdit();
      },
      error: (err) => { this.busy.set(false); this.error.set(err?.error?.error ?? 'Could not add the picture.'); },
    });
  }

  async replacePicture(f: Floor, e: Event): Promise<void> {
    this.busy.set(true);
    const image = await this.picked(e);
    if (!image) { this.busy.set(false); return; }
    this.floors.replaceImage(f.id, image).subscribe({
      next: () => this.busy.set(false),
      error: (err) => { this.busy.set(false); this.error.set(err?.error?.error ?? 'Could not replace the picture.'); },
    });
  }

  deleteFloor(f: Floor): void {
    if (!confirm(`Delete ${f.name} and where its rooms are? The devices aren't changed.`)) return;
    this.busy.set(true);
    this.floors.remove(f.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.cancelEdit();
        this.floorId.set(this.floors.floors()[0]?.id ?? null);
      },
      error: (err) => { this.busy.set(false); this.error.set(err?.error?.error ?? 'Could not delete the floor.'); },
    });
  }

  ngOnDestroy(): void {
    this.pictureSub?.unsubscribe();
    const url = this.picture();
    if (url) URL.revokeObjectURL(url);
    this.onUp();
  }
}
