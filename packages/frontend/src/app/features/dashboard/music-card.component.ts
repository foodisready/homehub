import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import type { Device } from '../../shared/models/device.model';
import { SonosArtComponent } from '../../shared/sonos/sonos-art.component';

interface Room { deviceId: number | null; name: string; volume: number | null }
interface Group {
  id: string;
  deviceId: number;
  rooms: Room[];
  playing: boolean;
  nowPlaying: { title: string | null; artist: string | null; album: string | null; art?: string | null };
  groupVolume: number | null;
}

/** How often the player re-reads the speakers while Home is on screen. */
const REFRESH_MS = 20_000;
const STEP = 2;

/**
 * The music on Home, as a small player: the cover, the rooms, what's playing, play or pause, and
 * the volume of the group (or the one room). Tapping the words goes to Music. Without speakers,
 * nothing shows.
 */
@Component({
  selector: 'app-music-card',
  standalone: true,
  imports: [RouterLink, SonosArtComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .card.music { display: flex; flex-direction: column; gap: 0.55rem; padding: 0.6rem 0.75rem; margin-bottom: 1rem; }
    .music.on { box-shadow: inset 3px 0 0 #c084fc; }
    .top { display: flex; align-items: center; gap: 0.75rem; min-width: 0; }
    .top app-sonos-art { width: 3.2rem; height: 3.2rem; }
    a.text { flex: 1; min-width: 0; color: inherit; text-decoration: none; }
    .rooms { font-size: 0.75rem; color: var(--text-muted); }
    .on .rooms { color: #d8b4fe; }
    .title, .sub { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title { font-weight: 650; font-size: 0.95rem; }
    .sub { font-size: 0.8rem; color: var(--text-muted); }
    .round { width: 2.6rem; height: 2.6rem; flex: none; padding: 0; border-radius: 50%; display: grid; place-items: center; background: var(--green); border: 1px solid var(--green); color: #04140c; }
    .round svg { width: 1rem; height: 1rem; }
    .vol { display: flex; align-items: center; gap: 0.5rem; }
    .vol .what { flex: 1; font-size: 0.78rem; color: var(--text-muted); }
    .vol .value { min-width: 2rem; text-align: center; font-weight: 600; font-variant-numeric: tabular-nums; }
    .step { width: 2rem; height: 2rem; padding: 0; font-size: 1rem; border-radius: 50%; background: var(--bg); border: 1px solid var(--border); color: var(--text); }
    .more { font-size: 0.75rem; color: var(--text-muted); }
    button:disabled { opacity: 0.5; }
    .err { font-size: 0.75rem; color: #fbbf24; margin: 0; }
  `],
  template: `
    @if (speakers().length) {
      <section class="card music" [class.on]="shownPlaying()" aria-label="Music">
        <div class="top">
          @if (group(); as g) { <app-sonos-art [deviceId]="g.deviceId" [art]="g.nowPlaying.art" /> }
          <a class="text" routerLink="/music" [attr.aria-label]="'Music: ' + label()">
            <span class="rooms">{{ roomsText() }}</span>
            <span class="title">{{ titleText() }}</span>
            @if (subText(); as sub) { <span class="sub">{{ sub }}</span> }
          </a>
          @if (group(); as g) {
            <button class="round" type="button" [disabled]="busy()" (click)="playPause(g)" [attr.aria-label]="g.playing ? 'Pause' : 'Play'">
              @if (g.playing) { <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg> }
              @else { <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg> }
            </button>
          }
        </div>
        @if (group(); as g) {
          @if (volume(g); as v) {
            <div class="vol">
              <span class="what">{{ g.rooms.length > 1 ? 'Volume, all ' + g.rooms.length + ' rooms' : 'Volume' }}</span>
              <button class="step" type="button" [disabled]="busy()" (click)="step(g, 'down')" aria-label="Quieter">−</button>
              <span class="value">{{ v }}</span>
              <button class="step" type="button" [disabled]="busy()" (click)="step(g, 'up')" aria-label="Louder">+</button>
            </div>
          }
          @if (others() > 0) { <a class="more" routerLink="/music">{{ others() === 1 ? 'One more group' : others() + ' more groups' }} playing · Music ›</a> }
        }
        @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      </section>
    }
  `,
})
export class MusicCardComponent {
  private readonly http = inject(HttpClient);
  readonly devices = input<Device[]>([]);
  readonly speakers = computed(() => this.devices().filter((d) => d.driverType === 'sonos'));
  private readonly playingNow = computed(() => this.speakers().filter((d) => d.online && d.state));

  readonly groups = signal<Group[] | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  /** The group shown: the first playing, else the first. */
  readonly group = computed(() => this.groups()?.[0] ?? null);
  readonly others = computed(() => (this.groups() ?? []).slice(1).filter((g) => g.playing).length);
  readonly shownPlaying = computed(() => this.group()?.playing ?? this.playingNow().length > 0);

  constructor() {
    // Read again when a speaker starts or stops (the device list follows them live).
    const changes = computed(() => this.speakers().map((d) => `${d.id}:${d.online}:${d.state}`).join(','));
    effect(() => { if (changes()) untracked(() => this.load()); });
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && this.speakers().length && !this.busy()) this.load(); }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private load(): void {
    this.http.get<{ groups: Group[] }>('/api/sonos/system').subscribe({
      next: (s) => this.groups.set(s.groups),
      error: () => undefined, // The words below fall back on the device list.
    });
  }

  roomsText(): string {
    const g = this.group();
    if (!g) return 'Music';
    const names = g.rooms.map((r) => r.name.replace(/ Sonos$/, ''));
    return `${names.join(' + ')} · ${g.playing ? 'Playing' : 'Paused'}`;
  }

  titleText(): string {
    const g = this.group();
    if (g?.nowPlaying.title) return g.nowPlaying.title;
    if (g) return g.playing ? 'Playing' : 'Nothing playing';
    const names = this.playingNow().map((d) => d.alias.replace(/ Sonos$/, ''));
    return names.length ? `Playing in ${names.join(' and ')}` : 'Music';
  }

  subText(): string {
    const np = this.group()?.nowPlaying;
    return np ? [np.artist, np.album].filter(Boolean).join(' · ') : '';
  }

  label(): string { return [this.roomsText(), this.titleText(), this.subText()].filter(Boolean).join(', '); }

  /** The group's volume, or the one room's. */
  volume(g: Group): number | null {
    return g.rooms.length > 1 ? g.groupVolume : g.rooms[0]?.volume ?? null;
  }

  playPause(g: Group): void {
    this.send(`/api/sonos/${g.deviceId}/remote`, { action: g.playing ? 'pause' : 'play' }, () => {
      this.groups.update((gs) => gs?.map((x) => (x.id === g.id ? { ...x, playing: !g.playing } : x)) ?? gs);
    });
  }

  step(g: Group, dir: 'up' | 'down'): void {
    const by = dir === 'up' ? STEP : -STEP;
    // Shown at once; the next read says where it really is.
    this.groups.update((gs) => gs?.map((x) => (x.id !== g.id ? x : x.rooms.length > 1
      ? { ...x, groupVolume: x.groupVolume === null ? null : Math.max(0, Math.min(100, x.groupVolume + by)) }
      : { ...x, rooms: x.rooms.map((r) => ({ ...r, volume: r.volume === null ? null : Math.max(0, Math.min(100, r.volume + by)) })) })) ?? gs);
    if (g.rooms.length > 1) this.send(`/api/sonos/${g.deviceId}/group-volume`, { step: dir });
    else if (g.rooms[0]?.deviceId != null) this.send(`/api/sonos/${g.rooms[0].deviceId}/remote`, { step: dir });
  }

  private send(url: string, body: unknown, after?: () => void): void {
    this.busy.set(true);
    this.error.set('');
    this.http.post(url, body).subscribe({
      next: () => { this.busy.set(false); after?.(); this.load(); },
      error: (e) => { this.busy.set(false); this.error.set(e?.error?.error ?? 'The speakers didn’t do that. Try again.'); this.load(); },
    });
  }
}
