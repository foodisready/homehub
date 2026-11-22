import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** One Settings section, as a tile: what it is, and how it's doing now. */
export interface SettingsTile {
  key: string;
  name: string;
  group: string;
  icon: keyof typeof ICONS;
  hue: string;
  /** A short line on how it's doing: "27 devices · 2 offline". */
  status: string;
  /** Something there needs the person's attention; 'problem' for something wrong. */
  look?: boolean | 'problem';
  /** More words a search finds it by. */
  words: string;
}

/** 24×24 outline icons, drawn with stroke="currentColor". */
const ICONS = {
  devices: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z',
  house: 'M3 11l9-8 9 8M5 10v10h14V10M10 20v-6h4v6',
  users: 'M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 20v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  backup: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  mic: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8',
  speaker: 'M11 5L6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  brain: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  teach: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5',
  list: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z',
  wave: 'M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h0',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  hub: 'M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM8 9h8M8 13h5',
  chip: 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
} as const;

/**
 * Settings as tiles: grouped, each with how it's doing now and a "Look" badge when something needs
 * attention, and a search box that finds a setting by what it's called or what's in it.
 */
@Component({
  selector: 'app-settings-tiles',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; animation: hh-fade .2s ease-out; }
    .search { width: 100%; padding: 0.7rem 0.9rem; border-radius: 14px; font-size: 0.95rem; margin-bottom: 1.1rem; }
    .group { margin-bottom: 1.25rem; }
    h2 { margin: 0 0 0.5rem 0.25rem; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr)); gap: 0.6rem; }
    @media (max-width: 420px) { .grid { grid-template-columns: 1fr 1fr; } }
    .tile {
      position: relative; text-align: left; border: 1px solid var(--border); border-radius: 18px; padding: 0.8rem;
      background: var(--surface); color: var(--text); display: grid; gap: 0.45rem; align-content: start; min-height: 6.5rem;
      font: inherit; cursor: pointer; transition: border-color .15s, transform .15s;
    }
    .tile:hover { border-color: color-mix(in srgb, var(--hue) 60%, var(--border)); }
    .tile:active { transform: scale(0.98); }
    .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .ico { width: 2.1rem; height: 2.1rem; border-radius: 11px; display: grid; place-items: center;
      background: color-mix(in srgb, var(--hue) 18%, transparent); color: var(--hue); }
    .ico svg { width: 1.15rem; height: 1.15rem; }
    b { font-size: 0.92rem; font-weight: 600; padding-right: 2.6rem; }
    small { color: var(--text-muted); font-size: 0.76rem; line-height: 1.3; overflow-wrap: anywhere; }
    .look { position: absolute; top: 0.7rem; right: 0.7rem; font-size: 0.68rem; font-weight: 700; color: #1a1300;
      background: #f5b83d; border-radius: 999px; padding: 0.1rem 0.45rem; }
    .look.bad { background: var(--red); color: #fff; }
    .empty { color: var(--text-muted); text-align: center; padding: 2rem 0; }
  `],
  template: `
    @if (searchable()) {
    <input class="search" type="search" [value]="query()" (input)="query.set($any($event.target).value)" (keydown.enter)="openOnly()"
           placeholder="Search settings: password, wake word, backup…" aria-label="Search settings" />
    }
    @for (g of groups(); track g.name) {
      <section class="group" [attr.aria-label]="g.name">
        <h2>{{ g.name }}</h2>
        <div class="grid">
          @for (t of g.tiles; track t.key) {
            <button type="button" class="tile" [style.--hue]="t.hue" (click)="open.emit(t.key)">
              <span class="ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path [attr.d]="icon(t)" /></svg>
              </span>
              <b>{{ t.name }}</b>
              <small>{{ t.status }}</small>
              @if (t.look === 'problem') { <span class="look bad"><span aria-hidden="true">Fix</span><span class="sr-only">Something is wrong</span></span> }
              @else if (t.look) { <span class="look"><span aria-hidden="true">Look</span><span class="sr-only">Needs a look</span></span> }
            </button>
          }
        </div>
      </section>
    } @empty {
      <p class="empty">Nothing matches “{{ query() }}”.</p>
    }
  `,
})
export class SettingsTilesComponent {
  readonly tiles = input.required<SettingsTile[]>();
  /** Shows the search box. */
  readonly searchable = input(true);
  readonly open = output<string>();
  readonly query = signal('');

  private readonly matches = computed(() => {
    const words = this.query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.tiles().filter((t) => {
      const text = `${t.name} ${t.status} ${t.words}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  });

  /** The tiles in their groups, in the order the groups first appear. */
  readonly groups = computed(() => {
    const out: Array<{ name: string; tiles: SettingsTile[] }> = [];
    for (const t of this.matches()) {
      const g = out.find((x) => x.name === t.group);
      if (g) g.tiles.push(t); else out.push({ name: t.group, tiles: [t] });
    }
    return out;
  });

  icon(t: SettingsTile): string { return ICONS[t.icon]; }

  /** Enter in the search box opens the one setting it found. */
  openOnly(): void {
    const m = this.matches();
    if (m.length === 1) this.open.emit(m[0].key);
  }
}
