import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { CamerasStateService } from '../../core/services/cameras-state.service';

/** Settings → Integrations → Cameras: turn Wyze and Ring cameras on or off in HomeHub. Admin only. */
@Component({
  selector: 'app-cameras-toggle',
  standalone: true,
  imports: [RouterLink],
  styles: [`
    .row { display:flex; align-items:center; gap:0.75rem; justify-content:space-between; padding:0.6rem 0; }
    .label { font-size:0.9rem; }
    .sub { font-size:0.78rem; color:var(--text-muted); margin-top:0.15rem; line-height:1.4; }
    .sub code { font-size:0.75rem; }
    input[type=checkbox] { width:1.1rem; height:1.1rem; flex-shrink:0; }
    .msg { font-size:0.8rem; margin:0 0 0.4rem; }
    .msg.err { color:var(--red); }
  `],
  template: `
    @if (cams.state(); as s) {
      <div class="row">
        <div>
          <div class="label">Cameras</div>
          @if (s.enabled) {
            <div class="sub">Wyze and Ring cameras. Turn off to hide Cameras from the menu and stop watching for motion and doorbell presses.</div>
          } @else {
            <div class="sub">Off. Cameras is hidden from the menu and nothing is watched.</div>
          }
          @if (!s.bridgeInstalled && s.enabled) {
            <div class="sub">
              Wyze cameras need the camera bridge, which is left out of this HomeHub. To add it, remove <code>HOMEHUB_CAMERA_BRIDGE=0</code>
              from HomeHub's <code>.env</code>, then run <code>docker compose -f docker-compose.yml up -d</code>.
              Ring cameras don't need it: <a routerLink="/cameras">set them up on the Cameras page</a>.
            </div>
          }
        </div>
        <input type="checkbox" [checked]="s.enabled" [disabled]="busy()" (change)="set($any($event.target))"
               aria-label="Cameras on" />
      </div>
      @if (error()) { <p class="msg err">{{ error() }}</p> }
    }
  `,
})
export class CamerasToggleComponent {
  readonly cams = inject(CamerasStateService);
  readonly busy = signal(false);
  readonly error = signal('');

  set(box: HTMLInputElement): void {
    this.busy.set(true);
    this.error.set('');
    this.cams.setEnabled(box.checked).subscribe({
      next: () => this.busy.set(false),
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        box.checked = !box.checked;
        this.error.set(err.error?.error ?? 'Could not save. Try again.');
      },
    });
  }
}
