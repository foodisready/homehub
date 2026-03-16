import { Component, OnInit, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Device } from '../../shared/models/device.model';

interface UserRow {
  id:   number;
  name: string;
  role: 'admin' | 'member';
}

interface DiscoveredDevice {
  ip: string;
  alias: string;
  model: string;
  hasEmeter: boolean;
  // editable alias before registering
  pendingAlias?: string;
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, RouterLink],
  styles: [`
    .topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.5rem; }
    .topbar h1 { font-size:1.4rem; font-weight:700; }
    .back-link { color:var(--text-muted); font-size:0.9rem; }
    .back-link:hover { color:var(--text); }

    .section { margin-bottom:2rem; }
    .section-title {
      font-size:0.7rem;
      font-weight:700;
      letter-spacing:0.1em;
      text-transform:uppercase;
      color:var(--text-muted);
      margin-bottom:0.75rem;
    }

    /* Table-like rows */
    .row-item {
      display:flex;
      align-items:center;
      gap:0.75rem;
      padding:0.65rem 0;
      border-bottom:1px solid var(--border);
      flex-wrap:wrap;
    }
    .row-item:last-child { border-bottom:none; }
    .row-label { flex:1; min-width:0; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row-meta  { font-size:0.78rem; color:var(--text-muted); }
    .role-badge {
      font-size:0.72rem; font-weight:600;
      padding:0.1rem 0.55rem; border-radius:999px;
      background:var(--surface); color:var(--text-muted);
    }
    .role-badge.admin { background:#1e3a5f; color:var(--accent); }

    .btn-sm {
      padding:0.3rem 0.75rem;
      font-size:0.8rem;
    }
    .btn-ghost {
      background:transparent;
      border:1px solid var(--border);
      color:var(--text-muted);
    }
    .btn-ghost:hover { background:var(--surface); color:var(--text); }
    .btn-danger {
      background:transparent;
      border:1px solid transparent;
      color:var(--text-muted);
    }
    .btn-danger:hover { color:var(--red); }

    /* Inline edit row */
    .edit-row {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:0.5rem;
      margin-top:0.5rem;
      width:100%;
    }
    .edit-row.single { grid-template-columns:1fr; }
    .edit-row input { font-size:0.85rem; padding:0.4rem 0.7rem; }

    /* Preferences */
    .pref-row {
      display:flex;
      align-items:center;
      gap:1rem;
      padding:0.65rem 0;
      border-bottom:1px solid var(--border);
    }
    .pref-row:last-child { border-bottom:none; }
    .pref-label { flex:1; font-size:0.9rem; }
    .pref-sub   { font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem; }
    .pref-input { width:120px; font-size:0.9rem; text-align:right; }

    .add-form {
      display:grid;
      grid-template-columns:1fr 1fr auto;
      gap:0.5rem;
      margin-top:0.75rem;
      flex-wrap:wrap;
    }
    .add-form input { font-size:0.85rem; }

    .msg { font-size:0.82rem; margin-top:0.4rem; }
    .msg.ok  { color:var(--green); }
    .msg.err { color:var(--red); }

    /* Discovery results */
    .discover-list { margin-top:0.75rem; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; }
    .discover-row {
      display:flex; align-items:center; gap:0.75rem;
      padding:0.5rem 0.75rem; border-bottom:1px solid var(--border); font-size:0.88rem;
    }
    .discover-row:last-child { border-bottom:none; }
    .discover-row input[type=checkbox] { width:1rem; height:1rem; flex-shrink:0; accent-color:var(--accent); cursor:pointer; }
    .discover-alias { flex:1; min-width:0; }
    .discover-alias input { font-size:0.85rem; padding:0.25rem 0.5rem; width:100%; }
    .discover-ip   { font-size:0.78rem; color:var(--text-muted); white-space:nowrap; }
    .discover-model{ font-size:0.72rem; color:var(--text-muted); white-space:nowrap; }
    .discover-footer { display:flex; align-items:center; justify-content:space-between; margin-top:0.5rem; }
  `],
  template: `
    <div class="page">

      <div class="topbar">
        <div style="display:flex;align-items:center;gap:1rem">
          <a class="back-link" routerLink="/dashboard">← Dashboard</a>
          <h1>Settings</h1>
        </div>
      </div>

      <!-- ── Devices ───────────────────────────────────────────── -->
      <div class="section">
        <div class="section-title">Devices</div>
        <div class="card">
          @for (d of devices(); track d.id) {
            <div class="row-item">
              @if (editingDeviceId() === d.id) {
                <div style="flex:1; width:100%">
                  <div class="edit-row">
                    <input type="text" [(ngModel)]="editAlias" placeholder="Alias" />
                    <input type="text" [(ngModel)]="editIp"    placeholder="IP address" />
                  </div>
                  <div style="display:flex;gap:0.5rem;margin-top:0.4rem">
                    <button class="btn-sm btn-primary" (click)="saveDevice(d.id)">Save</button>
                    <button class="btn-sm btn-ghost" (click)="cancelDeviceEdit()">Cancel</button>
                    @if (deviceMsg()) { <span class="msg" [class.ok]="!deviceErr()" [class.err]="deviceErr()">{{ deviceMsg() }}</span> }
                  </div>
                </div>
              } @else {
                <div class="row-label">
                  {{ d.alias }}
                  <span class="row-meta"> · {{ d.ip }}</span>
                  @if (d.hasEmeter) { <span class="row-meta"> · ⚡ emeter</span> }
                </div>
                @if (isAdmin()) {
                  <button class="btn-sm btn-ghost" (click)="startDeviceEdit(d)">Edit</button>
                  <button class="btn-sm btn-danger" (click)="deleteDevice(d.id, d.alias)">✕</button>
                }
              }
            </div>
          }

          @if (devices().length === 0) {
            <p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No devices registered. Use Discover to find plugs on your network.</p>
          }

          @if (isAdmin()) {
            <!-- Manual add -->
            <div class="add-form" style="margin-top:0.75rem">
              <input type="text" [(ngModel)]="newDeviceAlias" placeholder="Alias (e.g. Porch Light)" />
              <input type="text" [(ngModel)]="newDeviceIp"    placeholder="IP address (e.g. 192.168.1.50)" />
              <button class="btn-sm btn-primary" (click)="addManual()" [disabled]="!newDeviceAlias.trim() || !newDeviceIp.trim()">Add</button>
            </div>
            <button class="btn-sm btn-ghost" style="margin-top:0.5rem" [disabled]="discovering()" (click)="discover()">
              {{ discovering() ? 'Scanning…' : '+ Discover on network' }}
            </button>
            @if (discoverMsg()) { <p class="msg" [class.ok]="!discoverErr()" [class.err]="discoverErr()">{{ discoverMsg() }}</p> }

            <!-- Discovery results: selectable list -->
            @if (discoveredDevices().length > 0) {
              <div class="discover-list">
                @for (d of discoveredDevices(); track d.ip) {
                  <div class="discover-row">
                    <input type="checkbox" [checked]="isSelected(d.ip)" (change)="toggleSelect(d.ip)" />
                    <div class="discover-alias">
                      <input type="text" [(ngModel)]="d.pendingAlias" placeholder="Alias" />
                    </div>
                    <span class="discover-ip">{{ d.ip }}</span>
                    @if (d.model) { <span class="discover-model">{{ d.model }}</span> }
                  </div>
                }
              </div>
              <div class="discover-footer">
                <span style="font-size:0.8rem;color:var(--text-muted)">{{ selectedCount() }} of {{ discoveredDevices().length }} selected</span>
                <button class="btn-sm btn-primary" [disabled]="selectedCount() === 0 || registering()" (click)="registerSelected()">
                  {{ registering() ? 'Registering…' : 'Register Selected' }}
                </button>
              </div>
            }
          }
        </div>
      </div>

      <!-- ── Users (admin only) ────────────────────────────────── -->
      @if (isAdmin()) {
        <div class="section">
          <div class="section-title">Users</div>
          <div class="card">
            @for (u of users(); track u.id) {
              <div class="row-item">
                @if (editingUserId() === u.id) {
                  <div style="flex:1;width:100%">
                    <div class="edit-row single">
                      <input type="password" [(ngModel)]="editPassword" placeholder="New password" autocomplete="new-password" />
                    </div>
                    <div style="display:flex;gap:0.5rem;margin-top:0.4rem">
                      <button class="btn-sm btn-primary" (click)="savePassword(u.id)">Save</button>
                      <button class="btn-sm btn-ghost" (click)="cancelUserEdit()">Cancel</button>
                      @if (userMsg()) { <span class="msg" [class.ok]="!userErr()" [class.err]="userErr()">{{ userMsg() }}</span> }
                    </div>
                  </div>
                } @else {
                  <span class="row-label">{{ u.name }}</span>
                  <span class="role-badge" [class.admin]="u.role === 'admin'">{{ u.role }}</span>
                  <button class="btn-sm btn-ghost" (click)="startUserEdit(u.id)">Change password</button>
                  @if (u.name !== currentUser()) {
                    <button class="btn-sm btn-danger" (click)="deleteUser(u.id, u.name)">✕</button>
                  }
                }
              </div>
            }

            <!-- Add user form -->
            <div class="add-form" style="margin-top:0.75rem">
              <input type="text"     [(ngModel)]="newUsername" placeholder="Username" autocomplete="off" />
              <input type="password" [(ngModel)]="newPassword" placeholder="Password" autocomplete="new-password" />
              <button class="btn-sm btn-primary" (click)="addUser()" [disabled]="!newUsername.trim() || !newPassword.trim()">Add user</button>
            </div>
            @if (addUserMsg()) { <p class="msg" [class.ok]="!addUserErr()" [class.err]="addUserErr()">{{ addUserMsg() }}</p> }
          </div>
        </div>
      }

      <!-- ── Notifications ─────────────────────────────────────── -->
      @if (pushSupported) {
        <div class="section">
          <div class="section-title">Notifications</div>
          <div class="card">
            <div class="pref-row">
              <div class="pref-label">
                Push notifications
                <div class="pref-sub">Get notified when a device goes offline</div>
              </div>
              <button class="btn-sm" [class.btn-primary]="!pushEnabled()" [class.btn-ghost]="pushEnabled()" (click)="togglePush()">
                {{ pushEnabled() ? 'Disable' : 'Enable' }}
              </button>
            </div>
            @if (pushMsg()) { <p class="msg" [class.ok]="!pushErr()" [class.err]="pushErr()">{{ pushMsg() }}</p> }
          </div>
        </div>
      }

      <!-- ── Preferences ───────────────────────────────────────── -->
      <div class="section">
        <div class="section-title">Preferences</div>
        <div class="card">
          <div class="pref-row">
            <div class="pref-label">
              Energy rate
              <div class="pref-sub">Used for monthly cost estimates on the Energy page</div>
            </div>
            <input
              class="pref-input"
              type="number"
              step="0.01"
              min="0"
              [(ngModel)]="kwhRateDraft"
              (change)="saveKwhRate()"
              placeholder="0.15" />
            <span style="font-size:0.85rem;color:var(--text-muted)">$/kWh</span>
          </div>

          <div class="pref-row">
            <div class="pref-label">
              Location
              <div class="pref-sub">Latitude / Longitude — used for solar scheduling. Edit <code>LATITUDE</code> and <code>LONGITUDE</code> in <code>.env</code> to update.</div>
            </div>
          </div>
        </div>
      </div>

    </div>
  `,
})
export class SettingsComponent implements OnInit {
  private readonly _devices = signal<Device[]>([]);
  private readonly _users   = signal<UserRow[]>([]);

  readonly devices = this._devices.asReadonly();
  readonly users   = this._users.asReadonly();
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly currentUser = computed(() => this.auth.user()?.name ?? '');

  // Device editing
  editingDeviceId = signal<number | null>(null);
  editAlias = '';
  editIp    = '';
  deviceMsg = signal('');
  deviceErr = signal(false);

  // User editing
  editingUserId = signal<number | null>(null);
  editPassword  = '';
  userMsg = signal('');
  userErr = signal(false);

  // Add user
  newUsername = '';
  newPassword = '';
  addUserMsg = signal('');
  addUserErr = signal(false);

  // Discovery + manual add
  discovering       = signal(false);
  discoverMsg       = signal('');
  discoverErr       = signal(false);
  registering       = signal(false);
  private readonly _discoveredDevices = signal<DiscoveredDevice[]>([]);
  readonly discoveredDevices = this._discoveredDevices.asReadonly();
  private selectedIps = new Set<string>();
  readonly selectedCount = computed(() => {
    this.discoveredDevices(); // track signal
    return this.selectedIps.size;
  });
  newDeviceAlias = '';
  newDeviceIp    = '';

  // Push notifications
  pushSupported  = 'serviceWorker' in navigator && 'PushManager' in window;
  pushEnabled    = signal(false);
  pushMsg        = signal('');
  pushErr        = signal(false);

  // kWh rate
  kwhRateDraft = localStorage.getItem('kwhRate') ?? '0.15';

  constructor(readonly auth: AuthService, private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
    if (this.isAdmin()) {
      this.http.get<UserRow[]>('/api/users').subscribe((u) => this._users.set(u));
    }
    this.checkPushStatus();
  }

  private async checkPushStatus(): Promise<void> {
    if (!this.pushSupported) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    this.pushEnabled.set(!!sub);
  }

  async togglePush(): Promise<void> {
    if (!this.pushSupported) return;
    this.pushMsg.set('');
    try {
      const reg = await navigator.serviceWorker.ready;
      if (this.pushEnabled()) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await sub.unsubscribe();
          this.http.delete('/api/push/subscribe', { body: { endpoint: sub.endpoint } }).subscribe();
        }
        this.pushEnabled.set(false);
        this.pushMsg.set('Notifications disabled.');
      } else {
        const keyRes = await fetch('/api/push/vapid-public-key', {
          headers: { 'Authorization': `Bearer ${this.auth.accessToken()}` },
        });
        if (!keyRes.ok) { this.pushMsg.set('Push not configured on server.'); this.pushErr.set(true); return; }
        const { key } = await keyRes.json();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });
        const json = sub.toJSON() as any;
        this.http.post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys }).subscribe();
        this.pushEnabled.set(true);
        this.pushMsg.set('Notifications enabled.');
        this.pushErr.set(false);
      }
    } catch (err: any) {
      this.pushMsg.set(err.message ?? 'Failed to toggle notifications.');
      this.pushErr.set(true);
    }
  }

  // ── Device methods ──────────────────────────────────────────

  startDeviceEdit(d: Device): void {
    this.editingDeviceId.set(d.id);
    this.editAlias = d.alias;
    this.editIp    = d.ip;
    this.deviceMsg.set('');
  }

  cancelDeviceEdit(): void {
    this.editingDeviceId.set(null);
    this.deviceMsg.set('');
  }

  saveDevice(id: number): void {
    this.http.patch<Device>(`/api/devices/${id}`, { alias: this.editAlias, ip: this.editIp }).subscribe({
      next: (updated) => {
        this._devices.update((list) => list.map((d) => d.id === id ? { ...d, alias: updated.alias, ip: updated.ip } : d));
        this.deviceMsg.set('Saved');
        this.deviceErr.set(false);
        setTimeout(() => this.cancelDeviceEdit(), 800);
      },
      error: (err) => { this.deviceMsg.set(err.error?.error ?? 'Failed'); this.deviceErr.set(true); },
    });
  }

  deleteDevice(id: number, alias: string): void {
    if (!confirm(`Delete "${alias}"? This also removes its schedules and history.`)) return;
    this.http.delete(`/api/devices/${id}`).subscribe({
      next: () => this._devices.update((list) => list.filter((d) => d.id !== id)),
    });
  }

  isSelected(ip: string): boolean { return this.selectedIps.has(ip); }

  toggleSelect(ip: string): void {
    if (this.selectedIps.has(ip)) this.selectedIps.delete(ip);
    else this.selectedIps.add(ip);
    // Re-trigger selectedCount computed by writing to the signal
    this._discoveredDevices.update((list) => [...list]);
  }

  discover(): void {
    this.discovering.set(true);
    this.discoverMsg.set('');
    this._discoveredDevices.set([]);
    this.selectedIps.clear();
    this.http.post<DiscoveredDevice[]>('/api/devices/discover', {}).subscribe({
      next: (found) => {
        this.discovering.set(false);
        if (found.length === 0) {
          this.discoverMsg.set('No devices found. Check that plugs are on the same network.');
          this.discoverErr.set(false);
          return;
        }
        const existingIps = new Set(this._devices().map((d) => d.ip));
        const newDevices  = found
          .filter((f) => !existingIps.has(f.ip))
          .map((f) => ({ ...f, pendingAlias: f.alias || f.ip }));
        if (newDevices.length === 0) {
          this.discoverMsg.set(`Found ${found.length} device(s) — all already registered.`);
          this.discoverErr.set(false);
          return;
        }
        // Pre-select all
        newDevices.forEach((d) => this.selectedIps.add(d.ip));
        this._discoveredDevices.set(newDevices);
        this.discoverMsg.set(`Found ${newDevices.length} new device(s). Review and register below.`);
        this.discoverErr.set(false);
      },
      error: () => { this.discovering.set(false); this.discoverMsg.set('Discovery failed.'); this.discoverErr.set(true); },
    });
  }

  registerSelected(): void {
    const toRegister = this.discoveredDevices().filter((d) => this.selectedIps.has(d.ip));
    if (!toRegister.length) return;
    this.registering.set(true);
    let done = 0;
    for (const d of toRegister) {
      this.http.post<Device>('/api/devices', {
        alias:     (d.pendingAlias || d.ip).trim(),
        ip:        d.ip,
        model:     d.model ?? null,
        hasEmeter: d.hasEmeter ?? false,
      }).subscribe({
        next: (created) => {
          this._devices.update((list) => [...list, created]);
          this._discoveredDevices.update((list) => list.filter((x) => x.ip !== d.ip));
          this.selectedIps.delete(d.ip);
          done++;
          if (done === toRegister.length) {
            this.registering.set(false);
            this.discoverMsg.set(`Registered ${done} device(s) successfully.`);
            this.discoverErr.set(false);
          }
        },
        error: () => {
          done++;
          this.discoverMsg.set('Some devices could not be registered.');
          this.discoverErr.set(true);
          if (done === toRegister.length) this.registering.set(false);
        },
      });
    }
  }

  addManual(): void {
    if (!this.newDeviceAlias.trim() || !this.newDeviceIp.trim()) return;
    this.http.post<Device>('/api/devices', {
      alias: this.newDeviceAlias.trim(),
      ip:    this.newDeviceIp.trim(),
    }).subscribe({
      next: (created) => {
        this._devices.update((list) => [...list, created]);
        this.newDeviceAlias = '';
        this.newDeviceIp    = '';
        this.discoverMsg.set(`"${created.alias}" added.`);
        this.discoverErr.set(false);
        setTimeout(() => this.discoverMsg.set(''), 2000);
      },
      error: (err) => { this.discoverMsg.set(err.error?.error ?? 'Failed to add device.'); this.discoverErr.set(true); },
    });
  }

  // ── User methods ────────────────────────────────────────────

  startUserEdit(id: number): void {
    this.editingUserId.set(id);
    this.editPassword = '';
    this.userMsg.set('');
  }

  cancelUserEdit(): void {
    this.editingUserId.set(null);
    this.userMsg.set('');
  }

  savePassword(id: number): void {
    if (!this.editPassword.trim()) return;
    this.http.patch(`/api/users/${id}/password`, { password: this.editPassword }).subscribe({
      next: () => {
        this.userMsg.set('Password updated');
        this.userErr.set(false);
        setTimeout(() => this.cancelUserEdit(), 800);
      },
      error: (err) => { this.userMsg.set(err.error?.error ?? 'Failed'); this.userErr.set(true); },
    });
  }

  deleteUser(id: number, name: string): void {
    if (!confirm(`Delete user "${name}"?`)) return;
    this.http.delete(`/api/users/${id}`).subscribe({
      next: () => this._users.update((list) => list.filter((u) => u.id !== id)),
    });
  }

  addUser(): void {
    this.http.post<UserRow>('/api/users', { name: this.newUsername, password: this.newPassword, role: 'member' }).subscribe({
      next: (u) => {
        this._users.update((list) => [...list, u]);
        this.newUsername = '';
        this.newPassword = '';
        this.addUserMsg.set(`User "${u.name}" created`);
        this.addUserErr.set(false);
        setTimeout(() => this.addUserMsg.set(''), 2000);
      },
      error: (err) => { this.addUserMsg.set(err.error?.error ?? 'Failed'); this.addUserErr.set(true); },
    });
  }

  // ── Preferences ─────────────────────────────────────────────

  saveKwhRate(): void {
    const rate = parseFloat(this.kwhRateDraft);
    if (!isNaN(rate) && rate >= 0) {
      localStorage.setItem('kwhRate', String(rate));
    }
  }
}
