import { Component, OnInit, signal, inject, computed } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FirmwareService } from '../../core/services/firmware.service';
import { AuthService } from '../../core/auth/auth.service';
import type { FirmwareRelease } from '../../shared/models/sensor.model';

/**
 * Admin firmware library — upload .bin files, list releases, delete.
 *
 * Pairs with the per-sensor "Update" button on the sensor-detail page,
 * which references a releaseId from this list when triggering OTA.
 */
@Component({
  selector: 'app-firmware',
  standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: 0.6rem; }

    .form-row { display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap; }
    .form-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .form-field label { font-size: 0.78rem; color: var(--text-muted); }
    .form-field input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.9rem; }
    .form-field input[type=file] { padding: 0.25rem 0.4rem; }
    .form-field input:focus { outline: none; border-color: var(--accent); }
    .help { font-size: 0.75rem; color: var(--text-muted); }

    .btn { font-size: 0.9rem; padding: 0.45rem 0.95rem; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
    .btn:hover:not(:disabled) { border-color: var(--accent); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
    .btn.danger { color: #f87171; border-color: #6b1d1d; }
    .btn.danger:hover { background: #6b1d1d; color: #fff; }

    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); }
    th { font-weight: 600; color: var(--text-muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
    td.mono { font-family: 'SF Mono', Monaco, monospace; font-size: 0.8rem; }
    .latest-badge { background: var(--accent); color: #fff; font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 999px; margin-left: 0.4rem; }

    .empty { text-align: center; padding: 2rem 1rem; color: var(--text-muted); font-size: 0.9rem; }
    .err { color: #f87171; font-size: 0.85rem; margin-top: 0.4rem; }
    .ok  { color: #4ade80; font-size: 0.85rem; margin-top: 0.4rem; }

    .read-only-banner { background: rgba(180, 83, 9, 0.15); color: #fbbf24; padding: 0.7rem 1rem; border-radius: 6px; font-size: 0.88rem; margin-bottom: 1rem; }
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <div style="display:flex;align-items:center;gap:1rem">
          <h1>Firmware library</h1>
        </div>
        <span></span>
      </div>

      @if (!isAdmin()) {
        <div class="read-only-banner">
          You're viewing this page as a member. Only admins can upload, delete, or dispatch firmware.
        </div>
      }

      @if (isAdmin()) {
        <div class="card">
          <h2>Upload a release</h2>
          <div class="form-row">
            <div class="form-field">
              <label for="ver">Version</label>
              <input id="ver" type="text" [(ngModel)]="version" placeholder="0.2.0" />
            </div>
            <div class="form-field">
              <label for="tgt">Target</label>
              <input id="tgt" type="text" [(ngModel)]="target" />
            </div>
            <div class="form-field">
              <label for="notes">Notes (optional)</label>
              <input id="notes" type="text" [(ngModel)]="notes" placeholder="What's new" />
            </div>
            <div class="form-field">
              <label for="bin">Binary (.bin)</label>
              <input id="bin" type="file" accept=".bin" (change)="onFile($event)" />
            </div>
            <button class="btn primary" (click)="upload()" [disabled]="!canUpload() || uploading()">
              {{ uploading() ? 'Uploading…' : 'Upload' }}
            </button>
          </div>
          <div class="help">
            Use <code>npm run build:firmware</code> in the auraflow repo to produce
            <code>src/firmware/c/build/auraflow.bin</code>, then upload it here.
          </div>
          @if (uploadError()) { <div class="err">{{ uploadError() }}</div> }
          @if (uploadOk())    { <div class="ok">Uploaded {{ uploadOk() }}</div> }
        </div>
      }

      <div class="card">
        <h2>Releases</h2>
        @if (loading()) {
          <div class="empty">Loading…</div>
        } @else if (releases().length === 0) {
          <div class="empty">No firmware uploaded yet.</div>
        } @else {
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Target</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Notes</th>
                <th>SHA-256</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (r of releases(); track r.id) {
                <tr>
                  <td>
                    <strong>{{ r.version }}</strong>
                    @if (r.id === latestId()) {
                      <span class="latest-badge">latest</span>
                    }
                  </td>
                  <td>{{ r.target }}</td>
                  <td>{{ (r.sizeBytes / 1024) | number:'1.0-1' }} KB</td>
                  <td>{{ r.uploadedAt | date:'short' }}</td>
                  <td>{{ r.notes || '—' }}</td>
                  <td class="mono">{{ r.sha256.slice(0, 12) }}…</td>
                  <td>
                    @if (isAdmin()) {
                      <button class="btn danger" (click)="deleteRelease(r)" [disabled]="deletingId() === r.id">
                        {{ deletingId() === r.id ? 'Deleting…' : 'Delete' }}
                      </button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    </div>
  `,
})
export class FirmwareComponent implements OnInit {
  private firmware = inject(FirmwareService);
  private auth     = inject(AuthService);

  releases    = signal<FirmwareRelease[]>([]);
  loading     = signal(true);
  uploading   = signal(false);
  uploadError = signal<string | null>(null);
  uploadOk    = signal<string | null>(null);
  deletingId  = signal<number | null>(null);

  version = '';
  target  = 'auraflow-mainline';
  notes   = '';
  file: File | null = null;

  isAdmin = computed(() => this.auth.user()?.role === 'admin');
  canUpload = () => this.isAdmin() && this.version.trim().length > 0 && !!this.file;

  // The first row in the list is the most recent for the default target,
  // since the API sorts by uploaded_at DESC.
  latestId = computed(() => this.releases()[0]?.id);

  ngOnInit() {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.firmware.list().subscribe({
      next: (rs) => { this.releases.set(rs); this.loading.set(false); },
      error: ()   => { this.loading.set(false); },
    });
  }

  onFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    this.file = input.files?.[0] ?? null;
  }

  upload() {
    if (!this.canUpload() || !this.file) return;
    this.uploading.set(true);
    this.uploadError.set(null);
    this.uploadOk.set(null);

    this.firmware.upload(this.file, this.version.trim(), this.target.trim(), this.notes.trim() || undefined).subscribe({
      next: (r) => {
        this.uploading.set(false);
        this.uploadOk.set(`${r.target} v${r.version}`);
        this.version = '';
        this.notes = '';
        this.file = null;
        // Reset the file input by reloading; cheaper than tracking a ref.
        const input = document.getElementById('bin') as HTMLInputElement | null;
        if (input) input.value = '';
        this.refresh();
      },
      error: (err) => {
        this.uploading.set(false);
        this.uploadError.set(err?.error?.error ?? err?.message ?? 'Upload failed');
      },
    });
  }

  deleteRelease(r: FirmwareRelease) {
    if (!confirm(`Delete ${r.target} v${r.version}? Devices that try to OTA from this release after deletion will fail.`)) return;
    this.deletingId.set(r.id);
    this.firmware.delete(r.id).subscribe({
      next: () => { this.deletingId.set(null); this.refresh(); },
      error: () => { this.deletingId.set(null); },
    });
  }
}
