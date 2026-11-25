import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Device } from '../../shared/models/device.model';

/**
 * The music at a glance on Home: which speakers are playing, from the device list (no extra
 * questions to the speakers). Tapping goes to Music, with every room and where the music plays.
 */
@Component({
  selector: 'app-music-card',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .card.music { display: flex; align-items: center; gap: 0.85rem; padding: 0.6rem 0.75rem; margin-bottom: 1rem; color: inherit; text-decoration: none; }
    .music:hover { border-color: var(--accent); }
    .music.on { box-shadow: inset 3px 0 0 #c084fc; }
    .icon { width: 2.2rem; height: 2.2rem; border-radius: 50%; display: grid; place-items: center; background: var(--bg); color: var(--text-muted); flex-shrink: 0; }
    .on .icon { color: #d8b4fe; }
    .icon svg { width: 1.1rem; height: 1.1rem; }
    .text { flex: 1; min-width: 0; }
    .title { font-weight: 700; font-size: 0.95rem; }
    .what { display: block; font-size: 0.8rem; color: var(--text-muted); margin-top: 0.15rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .go { color: var(--text-muted); font-size: 1.1rem; }
  `],
  template: `
    @if (speakers().length) {
      <a class="card music" [class.on]="playing().length > 0" routerLink="/music" [attr.aria-label]="'Music: ' + summary()">
        <span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 9l11-2" /></svg></span>
        <span class="text"><span class="title">Music</span><span class="what">{{ summary() }}</span></span>
        <span class="go" aria-hidden="true">›</span>
      </a>
    }
  `,
})
export class MusicCardComponent {
  readonly devices = input<Device[]>([]);
  readonly speakers = computed(() => this.devices().filter((d) => d.driverType === 'sonos'));
  readonly playing = computed(() => this.speakers().filter((d) => d.online && d.state));

  /** "Playing in Kitchen and Main Bedroom", or "Paused in 2 rooms". */
  summary(): string {
    const names = this.playing().map((d) => d.alias.replace(/ Sonos$/, ''));
    if (!names.length) {
      const n = this.speakers().length;
      return n === 1 ? `Paused in ${this.speakers()[0].alias.replace(/ Sonos$/, '')}` : `Paused in ${n} rooms`;
    }
    return `Playing in ${names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`}`;
  }
}
