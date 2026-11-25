import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { SonosPickerComponent } from '../../shared/sonos/sonos-picker.component';

interface Room { deviceId: number | null; name: string; volume: number | null; muted: boolean }
interface Group {
  id: string;
  deviceId: number;
  rooms: Room[];
  playing: boolean;
  nowPlaying: { title: string | null; artist: string | null; album: string | null };
  groupVolume: number | null;
}
interface SoundSystem { groups: Group[]; unreachable: { deviceId: number; name: string }[] }

/** How often the page re-reads the speakers while it's open and on screen. */
const REFRESH_MS = 5000;
const STEP = 2;

/**
 * The whole sound system: each group of rooms playing together, what it's playing, its volume and
 * each room's, which rooms it plays in, and music to choose.
 */
@Component({
  selector: 'app-music',
  standalone: true,
  imports: [SonosPickerComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .topbar { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    h1 { font-size: 1.4rem; font-weight: 700; margin: 0; }
    .groups { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(min(100%, 22rem), 1fr)); align-items: start; }
    .group { display: flex; flex-direction: column; gap: 0.8rem; }
    .head { display: flex; justify-content: space-between; gap: 0.5rem; align-items: baseline; }
    .head h2 { font-size: 1rem; font-weight: 650; margin: 0; }
    .state { font-size: 0.75rem; color: var(--text-muted); white-space: nowrap; }
    .state.on { color: #d8b4fe; }
    .track { min-width: 0; }
    .track b, .track span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track b { font-size: 1.05rem; font-weight: 600; }
    .track span { font-size: 0.82rem; color: var(--text-muted); }
    .row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    .round { width: 2.6rem; height: 2.6rem; padding: 0; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; display: grid; place-items: center; }
    .round.main { width: 3rem; height: 3rem; background: var(--green); border-color: var(--green); color: #04140c; }
    .round svg { width: 1.1rem; height: 1.1rem; }
    .label { font-size: 0.8rem; color: var(--text-muted); margin: 0 0 0.35rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol .name { flex: 1; min-width: 0; font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .vol .value { min-width: 2rem; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
    .step { width: 2.2rem; height: 2.2rem; padding: 0; font-size: 1.1rem; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 50%; }
    .vols { display: flex; flex-direction: column; gap: 0.4rem; }
    .vol.all .name { font-weight: 600; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip { font-size: 0.82rem; padding: 0.4rem 0.75rem; border-radius: 999px; background: var(--bg); border: 1px solid var(--border); color: var(--text-muted); }
    .chip[aria-pressed="true"] { border-color: #c084fc; color: #e9d5ff; background: color-mix(in srgb, #c084fc 14%, var(--bg)); }
    button:disabled { opacity: 0.5; }
    .note { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.4; }
    .err { color: #fbbf24; }
    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <h1>Music</h1>
        @if (system(); as s) { <span class="note">{{ roomCount() }} {{ roomCount() === 1 ? 'room' : 'rooms' }}</span> }
      </div>
      @if (error()) { <p class="note err" role="alert">{{ error() }}</p> }
      @if (readError()) { <p class="note err">{{ readError() }}</p> }
      @if (system(); as s) {
        @if (!s.groups.length && !s.unreachable.length) {
          <div class="empty">No speakers yet. Add a Sonos in <a routerLink="/settings">Settings → Devices</a> with Discover on network.</div>
        }
        <div class="groups">
          @for (g of s.groups; track g.id) {
            <section class="card group" [attr.aria-label]="roomNames(g)">
              <div class="head">
                <h2>{{ roomNames(g) }}</h2>
                <span class="state" [class.on]="g.playing">{{ g.playing ? 'Playing' : 'Paused' }}</span>
              </div>
              <div class="track">
                @if (g.nowPlaying.title) {
                  <b>{{ g.nowPlaying.title }}</b>
                  @if (subtitle(g); as sub) { <span>{{ sub }}</span> }
                } @else { <span>{{ g.playing ? 'Playing' : 'Nothing playing' }}</span> }
              </div>
              <div class="row">
                <button class="round" type="button" [disabled]="busy()" (click)="remote(g, { action: 'previous' })" aria-label="Previous">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
                </button>
                <button class="round main" type="button" [disabled]="busy()" (click)="remote(g, { action: g.playing ? 'pause' : 'play' })" [attr.aria-label]="g.playing ? 'Pause' : 'Play'">
                  @if (g.playing) { <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg> }
                  @else { <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg> }
                </button>
                <button class="round" type="button" [disabled]="busy()" (click)="remote(g, { action: 'next' })" aria-label="Next">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
                </button>
              </div>

              <div>
                <p class="label">Volume</p>
                <div class="vols">
                  @if (g.groupVolume !== null) {
                    <div class="vol all">
                      <span class="name">All {{ g.rooms.length }} rooms</span>
                      <button class="step" type="button" [disabled]="busy()" (click)="groupStep(g, 'down')" aria-label="All rooms quieter">−</button>
                      <span class="value">{{ g.groupVolume }}</span>
                      <button class="step" type="button" [disabled]="busy()" (click)="groupStep(g, 'up')" aria-label="All rooms louder">+</button>
                    </div>
                  }
                  @for (r of g.rooms; track r.name) {
                    <div class="vol">
                      <span class="name">{{ r.name }}{{ r.muted ? ' (muted)' : '' }}</span>
                      @if (r.deviceId !== null && r.volume !== null) {
                        <button class="step" type="button" [disabled]="busy()" (click)="roomStep(r, 'down')" [attr.aria-label]="r.name + ' quieter'">−</button>
                        <span class="value">{{ r.volume }}</span>
                        <button class="step" type="button" [disabled]="busy()" (click)="roomStep(r, 'up')" [attr.aria-label]="r.name + ' louder'">+</button>
                      }
                    </div>
                  }
                </div>
              </div>

              @if (speakers().length > 1) {
                <div>
                  <p class="label" [id]="'on-' + g.id">Play on</p>
                  <div class="chips" role="group" [attr.aria-labelledby]="'on-' + g.id">
                    @for (sp of speakers(); track sp.deviceId) {
                      <button class="chip" type="button" [attr.aria-pressed]="inGroup(g, sp.deviceId)" [disabled]="busy()" (click)="toggleRoom(g, sp.deviceId)">{{ sp.name }}</button>
                    }
                    @if (!everywhere(g)) { <button class="chip" type="button" [disabled]="busy()" (click)="playEverywhere(g)">Everywhere</button> }
                  </div>
                </div>
              }

              <app-sonos-picker [deviceId]="g.deviceId" (started)="refresh()" />
            </section>
          }
        </div>
        @for (u of s.unreachable; track u.deviceId) { <p class="note err">Couldn’t reach {{ u.name }}.</p> }
        @if (s.groups.length) {
          <p class="note" style="margin-top:1rem">Rooms playing together play the same music. Taking a room out stops it. Each room keeps its own volume; “All rooms” moves them together.</p>
        }
      } @else if (!readError()) {
        <p class="note">Checking the speakers…</p>
      }
    </div>
  `,
})
export class MusicComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  readonly system = signal<SoundSystem | null>(null);
  readonly busy = signal(false);
  /** What went wrong with the last button: stays until the next one. */
  readonly error = signal('');
  /** Reading the speakers failed: goes once a read works. */
  readonly readError = signal('');

  /** Every HomeHub speaker, to choose where the music plays. */
  readonly speakers = computed(() => {
    const s = this.system();
    if (!s) return [];
    const rooms = s.groups.flatMap((g) => g.rooms).filter((r): r is Room & { deviceId: number } => r.deviceId !== null);
    return rooms.map((r) => ({ deviceId: r.deviceId, name: r.name.replace(/ Sonos$/, '') })).sort((a, b) => a.name.localeCompare(b.name));
  });
  readonly roomCount = computed(() => this.system()?.groups.reduce((n, g) => n + g.rooms.length, 0) ?? 0);

  ngOnInit(): void {
    this.refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !this.busy()) this.refresh(); }, REFRESH_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  refresh(): void {
    this.http.get<SoundSystem>('/api/sonos/system').subscribe({
      next: (s) => { this.system.set(s); this.readError.set(''); },
      error: (e: HttpErrorResponse) => this.readError.set(e.error?.error ?? 'Couldn’t read the speakers. Trying again shortly.'),
    });
  }

  roomNames(g: Group): string {
    const names = g.rooms.map((r) => r.name.replace(/ Sonos$/, ''));
    return names.length < 3 ? names.join(' + ') : `${names.slice(0, -1).join(', ')} + ${names.at(-1)}`;
  }

  subtitle(g: Group): string {
    return [g.nowPlaying.artist, g.nowPlaying.album].filter(Boolean).join(' · ');
  }

  inGroup(g: Group, deviceId: number): boolean {
    return g.rooms.some((r) => r.deviceId === deviceId);
  }

  everywhere(g: Group): boolean {
    return this.speakers().every((sp) => this.inGroup(g, sp.deviceId));
  }

  /** A button on a group's remote; the page reads everything again afterwards. */
  remote(g: Group, body: Record<string, unknown>): void {
    this.run(this.http.post(`/api/sonos/${g.deviceId}/remote`, body), true);
  }

  roomStep(r: Room, step: 'up' | 'down'): void {
    if (r.deviceId === null) return;
    // Shown at once; the speakers' answer then says where it really is.
    this.patchRoom(r.deviceId, (x) => ({ ...x, volume: Math.max(0, Math.min(100, (x.volume ?? 0) + (step === 'up' ? STEP : -STEP))) }));
    this.run(this.http.post(`/api/sonos/${r.deviceId}/remote`, { step }), true);
  }

  groupStep(g: Group, step: 'up' | 'down'): void {
    this.run(this.http.post<SoundSystem>(`/api/sonos/${g.deviceId}/group-volume`, { step }));
  }

  toggleRoom(g: Group, deviceId: number): void {
    const now = g.rooms.map((r) => r.deviceId).filter((id): id is number => id !== null);
    const next = now.includes(deviceId) ? now.filter((id) => id !== deviceId) : [...now, deviceId];
    if (!next.length) { this.error.set('The music needs at least one room. To stop it, pause it.'); return; }
    this.run(this.http.post<SoundSystem>(`/api/sonos/${g.deviceId}/play-on`, { rooms: next }));
  }

  playEverywhere(g: Group): void {
    this.run(this.http.post<SoundSystem>(`/api/sonos/${g.deviceId}/play-on`, { everywhere: true }));
  }

  private patchRoom(deviceId: number, f: (r: Room) => Room): void {
    const s = this.system();
    if (!s) return;
    this.system.set({ ...s, groups: s.groups.map((g) => ({ ...g, rooms: g.rooms.map((r) => (r.deviceId === deviceId ? f(r) : r)) })) });
  }

  /** Sends a change; an answer that's the whole system is shown, otherwise the page reads it again. */
  private run(req: ReturnType<HttpClient['post']>, reload = false): void {
    this.busy.set(true);
    this.error.set('');
    req.subscribe({
      next: (answer) => {
        this.busy.set(false);
        if (!reload && answer && typeof answer === 'object' && 'groups' in answer) this.system.set(answer as SoundSystem);
        else this.refresh();
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(e.error?.error ?? 'The speakers didn’t do that. Try again.');
        this.refresh();
      },
    });
  }
}
