import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

interface HomeSettings {
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  located: boolean;
  source: { location: 'settings' | 'env' | 'none'; timezone: 'settings' | 'env' | 'default' };
  today?: { sunrise: string | null; sunset: string | null } | null;
}

/** Settings → Home: where the home is and its time zone. Admin only. */
@Component({
  selector: 'app-home-settings',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .intro { font-size:0.82rem; color:var(--text-muted); margin:0 0 0.85rem; line-height:1.45; }
    .welcome { font-size:0.88rem; margin:0 0 0.85rem; padding:0.6rem 0.75rem; border:1px solid var(--accent, #3b82f6); border-radius:var(--radius); line-height:1.45; }
    .row { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-bottom:0.6rem; }
    .row label { font-size:0.8rem; color:var(--text-muted); width:100%; }
    .row input, .row select { flex:1; min-width:8rem; font-size:0.88rem; padding:0.4rem 0.6rem; }
    .row select { background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:var(--radius); }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .hint { font-size:0.75rem; color:var(--text-muted); margin:0 0 0.6rem; line-height:1.4; }
    .sun { font-size:0.85rem; margin:0.25rem 0 0.6rem; }
    .msg { font-size:0.82rem; margin:0.4rem 0 0; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); overflow-wrap:anywhere; }
  `],
  template: `
    @if (welcome()) {
      <p class="welcome">
        <b>Welcome to HomeHub.</b> Set your home's location and time zone here, so schedules run at the right times.
        Then add your devices under <b>Devices</b>.
      </p>
    }
    <p class="intro">
      Sunrise and sunset schedules use your home's location. Clock-time schedules, timers and every time HomeHub shows
      use its time zone.
    </p>

    <div class="row">
      <label for="home-tz">Time zone</label>
      <select id="home-tz" [(ngModel)]="timezone">
        @for (tz of zones; track tz) { <option [value]="tz">{{ tz }}</option> }
      </select>
      @if (browserZone && browserZone !== timezone) {
        <button class="btn-sm btn-ghost" type="button" (click)="timezone = browserZone">Use {{ browserZone }}</button>
      }
    </div>
    @if (settings()?.source?.timezone === 'env') { <p class="hint">Currently from .env. Saving here replaces it.</p> }
    @if (settings()?.source?.timezone === 'default') { <p class="hint">Not set yet, so HomeHub is using UTC.</p> }

    <div class="row">
      <label for="home-lat">Location (latitude, longitude)</label>
      <input id="home-lat" type="text" inputmode="decimal" [(ngModel)]="latitude" (ngModelChange)="splitPasted($event)"
             placeholder="Latitude, e.g. 40.71" autocomplete="off" />
      <input id="home-lon" type="text" inputmode="decimal" [(ngModel)]="longitude" placeholder="Longitude, e.g. -74.01" autocomplete="off"
             aria-label="Longitude" />
      @if (canLocate) {
        <button class="btn-sm btn-ghost" type="button" (click)="locate()" [disabled]="locating()">
          {{ locating() ? 'Finding…' : locateLabel }}
        </button>
      }
    </div>
    <p class="hint">
      To find them, open Google Maps, right-click your home and select the numbers at the top. Paste both into the
      first box. Two decimal places is close enough.
    </p>
    @if (settings()?.source?.location === 'env') { <p class="hint">Currently from .env. Saving here replaces it.</p> }

    @if (settings()?.today; as today) {
      @if (today.sunrise && today.sunset) {
        <p class="sun">Today: sunrise {{ clock(today.sunrise) }}, sunset {{ clock(today.sunset) }} ({{ settings()?.timezone }})</p>
      }
    }

    <button class="btn-sm btn-primary" type="button" (click)="save()" [disabled]="busy() || !dirty()">Save</button>
    @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()">{{ message() }}</p> }
  `,
})
export class HomeSettingsComponent implements OnInit {
  private readonly http = inject(HttpClient);

  /** Just created the admin account: say what to do first. */
  readonly welcome = input(false);

  readonly settings = signal<HomeSettings | null>(null);
  readonly busy = signal(false);
  readonly locating = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);

  readonly browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  readonly zones: string[] = HomeSettingsComponent.allZones(this.browserZone);
  /** Browsers share location only on secure pages (https or localhost). */
  readonly canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext;

  readonly locateLabel = 'Use this device\u2019s location';

  timezone = '';
  latitude = '';
  longitude = '';

  private static allZones(extra: string): string[] {
    let zones: string[] = [];
    try { zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { /* older browser */ }
    return [...new Set(['UTC', extra, ...zones].filter(Boolean))].sort();
  }

  ngOnInit(): void {
    this.http.get<HomeSettings>('/api/home-settings').subscribe({
      next: (s) => this.fill(s),
      error: (err) => this.show(this.errorText(err), true),
    });
  }

  private fill(s: HomeSettings): void {
    this.settings.set(s);
    // A new HomeHub: suggest this device's time zone rather than UTC.
    this.timezone = s.source.timezone === 'default' && this.browserZone ? this.browserZone : s.timezone;
    if (!this.zones.includes(this.timezone)) this.zones.push(this.timezone);
    this.latitude = s.latitude === null ? '' : String(s.latitude);
    this.longitude = s.longitude === null ? '' : String(s.longitude);
  }

  dirty(): boolean {
    const s = this.settings();
    if (!s) return false;
    return s.source.timezone === 'default' || this.timezone !== s.timezone
      || this.latitude.trim() !== (s.latitude === null ? '' : String(s.latitude))
      || this.longitude.trim() !== (s.longitude === null ? '' : String(s.longitude));
  }

  /** "39.80, -89.64" pasted from Google Maps fills both boxes. */
  splitPasted(value: string): void {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
    if (m) { this.latitude = m[1]; this.longitude = m[2]; }
  }

  locate(): void {
    this.locating.set(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.locating.set(false);
        this.latitude = pos.coords.latitude.toFixed(4);
        this.longitude = pos.coords.longitude.toFixed(4);
        this.show('Location found. Select Save to keep it.');
      },
      () => { this.locating.set(false); this.show('This browser did not share its location. Enter it instead.', true); },
      { timeout: 15000 },
    );
  }

  save(): void {
    const body: Record<string, unknown> = { timezone: this.timezone };
    const lat = this.latitude.trim(), lon = this.longitude.trim();
    if (lat || lon) {
      if (!lat || !lon) { this.show('Enter both latitude and longitude.', true); return; }
      body['latitude'] = Number(lat);
      body['longitude'] = Number(lon);
      if (!Number.isFinite(body['latitude'] as number) || !Number.isFinite(body['longitude'] as number)) {
        this.show('Latitude and longitude must be numbers, such as 40.71 and -74.01.', true);
        return;
      }
    }
    this.busy.set(true);
    this.http.put<HomeSettings>('/api/home-settings', body).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.fill(s);
        this.show(s.located ? 'Saved. Schedules now use this location and time zone.' : 'Saved. Add your location for sunrise and sunset schedules.');
      },
      error: (err) => { this.busy.set(false); this.show(this.errorText(err), true); },
    });
  }

  readonly clockFormat = computed(() => new Intl.DateTimeFormat([], {
    hour: 'numeric', minute: '2-digit', timeZone: this.settings()?.timezone || undefined,
  }));

  clock(iso: string): string {
    return this.clockFormat().format(new Date(iso));
  }

  private show(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }

  private errorText(err: unknown): string {
    if (err instanceof HttpErrorResponse) return err.error?.error ?? err.message;
    return String(err);
  }
}
