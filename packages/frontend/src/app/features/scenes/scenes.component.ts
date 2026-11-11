import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { AutomationsService } from '../../core/services/automations.service';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { Device } from '../../shared/models/device.model';

interface SceneAction { deviceId: number; alias: string; state: boolean; camera?: boolean }
interface Scene { id: number; name: string; icon: string | null; actions: SceneAction[]; voiceMayPause?: boolean }

const SCENE_ICONS = ['💡','🌙','🌅','🎬','🏠','🎉','😴','🔒','🌿','⚡'];

@Component({
  selector: 'app-scenes',
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.5rem; }
    .topbar h1 { font-size:1.4rem; font-weight:700; }
    .back-link { color:var(--text-muted); font-size:0.9rem; }
    .back-link:hover { color:var(--text); }

    .scenes-grid {
      display:grid;
      grid-template-columns: repeat(auto-fill, minmax(160px,1fr));
      gap:1rem;
      margin-bottom:1.5rem;
    }
    .scene-card {
      display:flex; flex-direction:column; align-items:center;
      gap:0.5rem; padding:1.25rem 1rem; cursor:pointer;
      text-align:center; transition:border-color 0.15s;
    }
    .scene-card:hover { border-color:var(--accent); }
    .scene-icon { font-size:2rem; line-height:1; }
    .scene-name { font-weight:600; font-size:0.9rem; }
    .scene-sub  { font-size:0.75rem; color:var(--text-muted); }
    .run-btn {
      width:100%; margin-top:0.25rem;
      background:var(--accent); color:#fff; font-size:0.8rem;
      padding:0.35rem; font-weight:600;
    }
    .run-btn:hover:not(:disabled) { background:var(--accent-hover); }
    .run-btn:disabled { opacity:0.5; }
    .delete-btn {
      background:transparent; border:none;
      color:var(--text-muted); font-size:0.85rem; padding:0.2rem 0.4rem;
    }
    .delete-btn:hover { color:var(--red); }

    .result-msg { font-size:0.8rem; color:var(--green); margin-top:0.25rem; text-align:center; }

    /* Create form */
    .form-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; padding:1rem; z-index:100; }
    .form-card { width:100%; max-width:500px; max-height:100%; overflow-y:auto; overscroll-behavior:contain; }
    .form-card h2 { font-size:1.2rem; font-weight:700; margin-bottom:1.25rem; }
    .field { margin-bottom:1rem; }
    label { display:block; font-size:0.82rem; font-weight:500; color:var(--text-muted); margin-bottom:0.3rem; }
    .icon-picker { display:flex; flex-wrap:wrap; gap:0.4rem; }
    .icon-btn {
      width:2.2rem; height:2.2rem; font-size:1.2rem; padding:0;
      display:flex; align-items:center; justify-content:center;
      background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
    }
    .icon-btn.selected { border-color:var(--accent); background:rgba(59,130,246,0.15); }
    .device-action-row { display:flex; align-items:center; gap:0.75rem; padding:0.4rem 0; border-bottom:1px solid var(--border); }
    .device-action-row:last-child { border-bottom:none; }
    .device-name { flex:1; font-size:0.88rem; }
    .state-toggle { display:flex; gap:0.3rem; }
    .state-btn { padding:0.2rem 0.6rem; font-size:0.8rem; background:var(--surface); border:1px solid var(--border); color:var(--text-muted); }
    .state-btn.active-on  { background:#14532d; border-color:var(--green); color:var(--green); }
    .state-btn.active-off { background:#1c1917; border-color:var(--border); color:var(--text-muted); }
    .state-btn.skip { opacity:0.5; }
    .form-actions { display:flex; gap:0.75rem; margin-top:1.25rem; }
    .btn-cancel { flex:1; background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .btn-save { flex:2; }
    .error-msg { color:var(--red); font-size:0.82rem; margin-top:0.4rem; }
    .empty { text-align:center; padding:3rem 1rem; color:var(--text-muted); }

    /* Voice may pause cameras */
    .check { display:flex; align-items:flex-start; gap:0.5rem; font-size:0.85rem; color:var(--text); font-weight:500; margin:0; cursor:pointer; }
    .check input { width:auto; margin-top:0.15rem; }
    .check-help { font-size:0.78rem; color:var(--text-muted); margin:0.3rem 0 0 1.6rem; line-height:1.4; }
    .voice-pause { font-size:0.75rem; color:var(--text-muted); text-align:left; width:100%; }
    .voice-pause .check { font-size:0.75rem; font-weight:400; color:var(--text-muted); }
    .voice-pause.on, .voice-pause.on .check { color:var(--amber, #f59e0b); }
    .voice-err { color:var(--red); font-size:0.75rem; }
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <div style="display:flex;align-items:center;gap:1rem">
          <h1>Scenes</h1>
        </div>
        @if (canEdit()) {
          <button class="btn-primary" style="padding:0.5rem 1.1rem;font-weight:600" (click)="showForm.set(true)">+ New Scene</button>
        }
      </div>

      @if (scenes().length === 0) {
        <div class="empty">
          <strong>No scenes yet</strong>
          <p style="margin-top:0.5rem;font-size:0.9rem">Create a scene to control multiple plugs at once — "Goodnight", "Movie Mode", etc.</p>
        </div>
      } @else {
        <div class="scenes-grid">
          @for (s of scenes(); track s.id) {
            <div class="card scene-card">
              <div class="scene-icon">{{ s.icon ?? '💡' }}</div>
              <div class="scene-name">{{ s.name }}</div>
              <div class="scene-sub">{{ s.actions.length }} device{{ s.actions.length !== 1 ? 's' : '' }}</div>
              <button class="run-btn" [disabled]="runningId() === s.id" (click)="run(s)">
                {{ runningId() === s.id ? 'Running…' : 'Run' }}
              </button>
              @if (runResult()[s.id]) {
                <div class="result-msg">{{ runResult()[s.id] }}</div>
              }
              @if (pausesCameras(s)) {
                <div class="voice-pause" [class.on]="s.voiceMayPause">
                  @if (canEdit()) {
                    <label class="check">
                      <input type="checkbox" [checked]="!!s.voiceMayPause" [disabled]="savingVoice() === s.id"
                             (change)="setVoiceMayPause(s, $any($event.target))" />
                      🎙 Voice may pause cameras
                    </label>
                  } @else if (s.voiceMayPause) {
                    🎙 Voice may pause cameras
                  }
                  @if (voiceError()[s.id]) { <div class="voice-err">{{ voiceError()[s.id] }}</div> }
                </div>
              }
              @if (canEdit()) {
                <button class="delete-btn" (click)="deleteScene(s)">✕ Delete</button>
              }
            </div>
          }
        </div>
      }
    </div>

    @if (showForm()) {
      <div class="form-overlay" (click)="closeForm()">
        <div class="card form-card" (click)="$event.stopPropagation()">
          <h2>New Scene</h2>

          <div class="field">
            <label>Name</label>
            <input type="text" [(ngModel)]="form.name" placeholder='e.g. Goodnight' />
          </div>

          <div class="field">
            <label>Icon</label>
            <div class="icon-picker">
              @for (ic of icons; track ic) {
                <button class="icon-btn" [class.selected]="form.icon === ic" (click)="form.icon = ic">{{ ic }}</button>
              }
            </div>
          </div>

          <div class="field">
            <label>Device actions</label>
            @for (d of devices(); track d.id) {
              <div class="device-action-row">
                <span class="device-name">{{ d.alias }}</span>
                <div class="state-toggle">
                  <button class="state-btn" [class.active-on]="actionState(d.id) === true" (click)="setAction(d.id, true)">{{ d.driverType === 'wyze' ? 'Resume' : 'On' }}</button>
                  <button class="state-btn" [class.active-off]="actionState(d.id) === false" (click)="setAction(d.id, false)">{{ d.driverType === 'wyze' ? 'Pause' : 'Off' }}</button>
                  <button class="state-btn skip" [class.active-off]="actionState(d.id) === null" (click)="setAction(d.id, null)">Skip</button>
                </div>
              </div>
            }
          </div>

          @if (formPausesCameras()) {
            <div class="field">
              <label class="check">
                <input type="checkbox" [(ngModel)]="form.voiceMayPause" />
                Voice may pause cameras
              </label>
              <p class="check-help">
                Without this, saying the scene's name leaves cameras on, because anyone who says the wake word could
                otherwise turn them off. Pick a name a visitor wouldn't guess. Everyone's phone gets a notification
                when voice or Chat pauses cameras.
              </p>
            </div>
          }

          @if (formError()) { <p class="error-msg">{{ formError() }}</p> }

          <div class="form-actions">
            <button class="btn-cancel" (click)="closeForm()">Cancel</button>
            <button class="btn-primary btn-save" [disabled]="saving()" (click)="save()">
              {{ saving() ? 'Saving…' : 'Save Scene' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ScenesComponent implements OnInit {
  readonly icons = SCENE_ICONS;

  private readonly _scenes  = signal<Scene[]>([]);
  private readonly _devices = signal<Device[]>([]);
  private readonly _runResult = signal<Record<number, string>>({});

  readonly scenes    = this._scenes.asReadonly();
  readonly devices   = this._devices.asReadonly();
  readonly runResult = this._runResult.asReadonly();
  readonly showForm  = signal(false);
  readonly saving    = signal(false);
  readonly formError = signal('');
  readonly runningId = signal<number | null>(null);
  readonly savingVoice = signal<number | null>(null);
  readonly voiceError = signal<Record<number, string>>({});
  /** Bumped when the form's actions change, so formPausesCameras re-reads them. */
  private readonly actionsChanged = signal(0);
  readonly formPausesCameras = computed(() => {
    this.actionsChanged();
    return this.devices().some((d) => d.driverType === 'wyze' && this.actionMap.get(d.id) === false);
  });

  form = this.blankForm();
  // Map deviceId → true/false/null(skip)
  private actionMap = new Map<number, boolean | null>();

  private readonly automations = inject(AutomationsService);
  /** Admins edit, except on a backup HomeHub, which is copied from the active one. */
  readonly canEdit = computed(() => this.auth.user()?.role === 'admin' && !this.automations.readOnly());

  constructor(readonly auth: AuthService, private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<Scene[]>('/api/scenes').subscribe((s) => this._scenes.set(s));
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
  }

  private blankForm() { return { name: '', icon: '💡', voiceMayPause: false }; }

  pausesCameras(scene: Scene): boolean {
    return scene.actions.some((a) => a.camera && !a.state);
  }

  setVoiceMayPause(scene: Scene, box: HTMLInputElement): void {
    const voiceMayPause = box.checked;
    this.savingVoice.set(scene.id);
    this._voiceErr(scene.id, '');
    this.http.patch<Scene>(`/api/scenes/${scene.id}`, { voiceMayPause }).subscribe({
      next: (updated) => {
        this._scenes.update((list) => list.map((s) => (s.id === updated.id ? updated : s)));
        this.savingVoice.set(null);
      },
      error: (err) => {
        box.checked = !voiceMayPause;   // put the box back as it was
        this._voiceErr(scene.id, err.error?.error ?? 'Couldn\'t save. Try again.');
        this.savingVoice.set(null);
      },
    });
  }

  private _voiceErr(id: number, msg: string): void {
    this.voiceError.update((e) => ({ ...e, [id]: msg }));
  }

  actionState(deviceId: number): boolean | null {
    return this.actionMap.has(deviceId) ? (this.actionMap.get(deviceId) ?? null) : null;
  }

  setAction(deviceId: number, state: boolean | null): void {
    if (state === null) this.actionMap.delete(deviceId);
    else this.actionMap.set(deviceId, state);
    this.actionsChanged.update((n) => n + 1);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.form = this.blankForm();
    this.actionMap.clear();
    this.actionsChanged.update((n) => n + 1);
    this.formError.set('');
  }

  save(): void {
    if (!this.form.name.trim()) { this.formError.set('Name is required.'); return; }
    const actions = Array.from(this.actionMap.entries())
      .filter(([, s]) => s !== null)
      .map(([deviceId, state]) => ({ deviceId, state: state as boolean }));
    if (!actions.length) { this.formError.set('Add at least one device action.'); return; }

    this.saving.set(true);
    this.http.post<Scene>('/api/scenes', {
      name: this.form.name.trim(), icon: this.form.icon, actions,
      voiceMayPause: this.formPausesCameras() && this.form.voiceMayPause,
    }).subscribe({
      next: (created) => {
        this._scenes.update((list) => [...list, created].sort((a, b) => a.name.localeCompare(b.name)));
        this.closeForm();
        this.saving.set(false);
      },
      error: (err) => { this.formError.set(err.error?.error ?? 'Failed to save.'); this.saving.set(false); },
    });
  }

  run(scene: Scene): void {
    this.runningId.set(scene.id);
    this.http.post<{ actions: { alias: string; state: boolean }[]; failed: number }>(`/api/scenes/${scene.id}/run`, {}).subscribe({
      next: ({ actions, failed }) => {
        const summary = actions.map((a) => `${a.alias} → ${a.state ? 'on' : 'off'}`).join(', ');
        const msg = failed ? `Done (${failed} failed): ${summary}` : `Done: ${summary}`;
        this._runResult.update((r) => ({ ...r, [scene.id]: msg }));
        this.runningId.set(null);
        setTimeout(() => this._runResult.update((r) => { const n = { ...r }; delete n[scene.id]; return n; }), 4000);
      },
      error: () => { this.runningId.set(null); },
    });
  }

  deleteScene(scene: Scene): void {
    if (!confirm(`Delete scene "${scene.name}"?`)) return;
    this.http.delete(`/api/scenes/${scene.id}`).subscribe({
      next: () => this._scenes.update((list) => list.filter((s) => s.id !== scene.id)),
    });
  }
}
