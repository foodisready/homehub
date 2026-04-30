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
  ip:           string;
  alias:        string;
  model:        string;
  hasEmeter:    boolean;
  driverType:   string;
  driverConfig?: Record<string, unknown>;
  // editable before registering
  pendingAlias?:    string;
  pendingKey?:      string;   // Tuya only: local key required for control
  pendingDeviceId?: string;   // Tuya only: deviceId (from TCP scan, no UDP gwId)
}

const DRIVER_LABEL: Record<string, string> = {
  kasa:   'Kasa',
  shelly: 'Shelly',
  tuya:   'Tuya',
};

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

    .driver-badge {
      font-size:0.68rem; font-weight:600;
      padding:0.1rem 0.5rem; border-radius:999px;
      background:var(--surface); color:var(--text-muted);
      border:1px solid var(--border);
      flex-shrink:0;
    }
    .driver-badge.kasa   { border-color:#1d4ed8; color:#60a5fa; }
    .driver-badge.shelly { border-color:#b45309; color:#fbbf24; }
    .driver-badge.tuya   { border-color:#15803d; color:#4ade80; }

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

    .edit-row {
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:0.5rem;
      margin-top:0.5rem;
      width:100%;
    }
    .edit-row.single { grid-template-columns:1fr; }
    .edit-row input { font-size:0.85rem; padding:0.4rem 0.7rem; }

    .pass-wrap { position:relative; display:flex; align-items:center; }
    .pass-wrap input { flex:1; padding-right:2.2rem; }
    .pass-eye {
      position:absolute; right:0.5rem;
      background:none; border:none; padding:0; cursor:pointer;
      color:var(--text-muted); line-height:0;
    }
    .pass-eye:hover { color:var(--text); }

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
      grid-template-columns:1fr 1fr auto auto;
      gap:0.5rem;
      margin-top:0.75rem;
      align-items:center;
    }
    .add-form input { font-size:0.85rem; }

    .msg { font-size:0.82rem; margin-top:0.4rem; }
    .msg.ok  { color:var(--green); }
    .msg.err { color:var(--red); }

    .tuya-cloud-form {
      display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; margin-top:0.75rem;
    }
    .tuya-cloud-form input, .tuya-cloud-form select { font-size:0.85rem; padding:0.4rem 0.7rem; }
    .tuya-synced { font-size:0.72rem; color:#4ade80; margin-left:0.4rem; }

    .discover-list { margin-top:0.75rem; border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; }
    .discover-row {
      display:flex; align-items:center; gap:0.6rem;
      padding:0.5rem 0.75rem; border-bottom:1px solid var(--border); font-size:0.88rem;
      flex-wrap:wrap;
    }
    .discover-row:last-child { border-bottom:none; }
    .discover-row input[type=checkbox] { width:1rem; height:1rem; flex-shrink:0; accent-color:var(--accent); cursor:pointer; }
    .discover-alias { flex:1; min-width:120px; }
    .discover-alias input { font-size:0.85rem; padding:0.25rem 0.5rem; width:100%; }
    .discover-key { min-width:150px; }
    .discover-key input { font-size:0.8rem; padding:0.25rem 0.5rem; width:100%; }
    .discover-key-label { font-size:0.72rem; color:var(--text-muted); display:block; margin-bottom:2px; }
    .discover-ip    { font-size:0.78rem; color:var(--text-muted); white-space:nowrap; }
    .discover-model { font-size:0.72rem; color:var(--text-muted); white-space:nowrap; }
    .discover-footer { display:flex; align-items:center; justify-content:space-between; margin-top:0.5rem; }
    .key-warning { font-size:0.75rem; color:#fbbf24; margin-top:0.25rem; }
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
                  @if (d.driverType === 'shelly' || d.driverType === 'tuya') {
                    <div class="edit-row" style="margin-top:0.4rem">
                      <input type="text"     [(ngModel)]="editAuthUser" placeholder="Username (leave blank to clear)" autocomplete="off" />
                      <div class="pass-wrap">
                        <input [type]="showAuthPass ? 'text' : 'password'" [(ngModel)]="editAuthPass" placeholder="Password (leave blank to clear)" autocomplete="new-password" />
                        <button type="button" class="pass-eye" (click)="showAuthPass = !showAuthPass" [attr.aria-label]="showAuthPass ? 'Hide password' : 'Show password'">
                          @if (showAuthPass) {
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                              <line x1="1" y1="1" x2="23" y2="23"/>
                            </svg>
                          } @else {
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                              <circle cx="12" cy="12" r="3"/>
                            </svg>
                          }
                        </button>
                      </div>
                    </div>
                    <p style="font-size:0.75rem;color:var(--text-muted);margin:0.2rem 0 0">Leave both blank to remove stored credentials.</p>
                  }
                  <div style="display:flex;gap:0.5rem;margin-top:0.4rem">
                    <button class="btn-sm btn-primary" (click)="saveDevice(d.id, d.driverType)">Save</button>
                    <button class="btn-sm btn-ghost" (click)="cancelDeviceEdit()">Cancel</button>
                    @if (deviceMsg()) { <span class="msg" [class.ok]="!deviceErr()" [class.err]="deviceErr()">{{ deviceMsg() }}</span> }
                  </div>
                </div>
              } @else {
                <div class="row-label">
                  {{ d.alias }}
                  <span class="row-meta"> · {{ d.ip }}</span>
                  @if (d.hasEmeter) { <span class="row-meta"> · ⚡</span> }
                </div>
                <span class="driver-badge" [class]="'driver-badge ' + (d.driverType ?? 'kasa')">
                  {{ driverLabel(d.driverType ?? 'kasa') }}
                </span>
                @if (isAdmin()) {
                  <button class="btn-sm btn-ghost" (click)="startDeviceEdit(d)">Edit</button>
                  <button class="btn-sm btn-danger" (click)="deleteDevice(d.id, d.alias)">✕</button>
                }
              }
            </div>
          }

          @if (devices().length === 0) {
            <p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No devices registered. Use Discover to find devices on your network.</p>
          }

          @if (isAdmin()) {
            <!-- Manual add with Probe -->
            <div class="add-form" style="margin-top:0.75rem">
              <input type="text" [(ngModel)]="newDeviceAlias" placeholder="Alias (e.g. Porch Light)" />
              <input type="text" [(ngModel)]="newDeviceIp"    placeholder="IP address (e.g. 192.168.1.50)"
                     (keydown.enter)="probeIp()" />
              <button class="btn-sm btn-ghost" (click)="probeIp()" [disabled]="!newDeviceIp.trim() || probing()">
                {{ probing() ? '…' : 'Probe' }}
              </button>
              <button class="btn-sm btn-primary" (click)="addManual()" [disabled]="!newDeviceAlias.trim() || !newDeviceIp.trim()">Add</button>
            </div>
            @if (probeMsg()) {
              <p class="msg" [class.ok]="!probeErr()" [class.err]="probeErr()">{{ probeMsg() }}</p>
            }

            <!-- Discover buttons -->
            <div style="display:flex;gap:0.5rem;margin-top:0.5rem;flex-wrap:wrap">
              <button class="btn-sm btn-ghost" [disabled]="discovering()" (click)="discover()">
                {{ discovering() ? 'Scanning…' : '+ Discover on network' }}
              </button>
            </div>
            @if (discoverMsg()) { <p class="msg" [class.ok]="!discoverErr()" [class.err]="discoverErr()">{{ discoverMsg() }}</p> }

            <!-- Discovery results -->
            @if (discoveredDevices().length > 0) {
              <div class="discover-list">
                @for (d of discoveredDevices(); track d.ip) {
                  <div class="discover-row">
                    <input type="checkbox" [checked]="isSelected(d.ip)" (change)="toggleSelect(d.ip)"
                           [disabled]="d.driverType === 'tuya' && (!d.pendingKey?.trim() || (!d.driverConfig?.['deviceId'] && !d.pendingDeviceId?.trim()))" />
                    <div class="discover-alias">
                      <input type="text" [(ngModel)]="d.pendingAlias" placeholder="Alias" />
                    </div>
                    <span class="discover-ip">{{ d.ip }}</span>
                    @if (d.model && d.model !== d.ip) { <span class="discover-model">{{ d.model }}</span> }
                    <span class="driver-badge" [class]="'driver-badge ' + d.driverType">{{ driverLabel(d.driverType) }}</span>
                    @if (d.driverType === 'tuya') {
                      @if (tuyaCloudDevices.length > 0) {
                        <div class="discover-key" style="min-width:180px">
                          <span class="discover-key-label">Match to cloud device</span>
                          <select (change)="applyCloudDevice(d, $event)">
                            <option value="">— select —</option>
                            @for (c of tuyaCloudDevices; track c.deviceId) {
                              <option [value]="c.deviceId">{{ c.name || c.deviceId }}</option>
                            }
                          </select>
                        </div>
                      } @else {
                        @if (!d.driverConfig?.['deviceId']) {
                          <div class="discover-key">
                            <span class="discover-key-label">Device ID (required)</span>
                            <input type="text" [(ngModel)]="d.pendingDeviceId" placeholder="e.g. bf1234abcd5678ef"
                                   (ngModelChange)="onTuyaKeyChange(d)" />
                          </div>
                        }
                        <div class="discover-key">
                          <span class="discover-key-label">Local Key (required)</span>
                          <input type="text" [(ngModel)]="d.pendingKey" placeholder="e.g. a1b2c3d4e5f6g7h8"
                                 (ngModelChange)="onTuyaKeyChange(d)" />
                        </div>
                      }
                    }
                  </div>
                }
              </div>
              @if (hasTuyaDevices()) {
                <p class="key-warning">
                  ⚠ Tuya devices require a <strong>Device ID</strong> and <strong>Local Key</strong>.
                  @if (tuyaCloudReady()) {
                    <button class="btn-sm btn-ghost" style="margin-left:0.5rem" [disabled]="tuyaSyncing()" (click)="syncTuyaCloud()">
                      {{ tuyaSyncing() ? 'Syncing…' : '⟳ Auto-fill from Tuya Cloud' }}
                    </button>
                    @if (tuyaSyncMsg()) { <span [class]="tuyaSyncErr() ? 'msg err' : 'msg ok'" style="margin-left:0.4rem">{{ tuyaSyncMsg() }}</span> }
                  } @else {
                    Enter them below, or configure Tuya Cloud credentials in the <strong>Integrations</strong> section to auto-fill.
                  }
                </p>
              }
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

      <!-- ── Integrations (admin only) ────────────────────────── -->
      @if (isAdmin()) {
        <div class="section">
          <div class="section-title">Integrations</div>
          <div class="card">
            <div class="pref-row" style="cursor:pointer" (click)="tuyaCloudExpanded.set(!tuyaCloudExpanded())">
              <div class="pref-label">
                Tuya Cloud
                <div class="pref-sub">Connect to iot.tuya.com to auto-fill Device IDs and Local Keys during discovery</div>
              </div>
              @if (tuyaCloudReady()) { <span class="tuya-synced">● Connected</span> }
              <span style="color:var(--text-muted);font-size:0.85rem">{{ tuyaCloudExpanded() ? '▲' : '▼' }}</span>
            </div>
            @if (tuyaCloudExpanded()) {
              <div class="tuya-cloud-form">
                <input type="text"     [(ngModel)]="tuyaAccessId"     placeholder="Access ID (Client ID)" autocomplete="off" />
                <div class="pass-wrap">
                  <input [type]="showTuyaSecret ? 'text' : 'password'" [(ngModel)]="tuyaAccessSecret"
                         placeholder="Access Secret" autocomplete="new-password" />
                  <button type="button" class="pass-eye" (click)="showTuyaSecret = !showTuyaSecret">
                    @if (showTuyaSecret) {
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                        <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    } @else {
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    }
                  </button>
                </div>
                <select [(ngModel)]="tuyaRegion">
                  <option value="us">Americas (openapi.tuyaus.com)</option>
                  <option value="eu">Europe (openapi.tuyaeu.com)</option>
                  <option value="cn">China (openapi.tuyacn.com)</option>
                  <option value="in">India (openapi.tuyain.com)</option>
                </select>
                <div style="display:flex;align-items:center;gap:0.5rem">
                  <button class="btn-sm btn-primary" (click)="saveTuyaCredentials()"
                          [disabled]="!tuyaAccessId.trim() || !tuyaAccessSecret.trim()">Save</button>
                  @if (tuyaCredsMsg()) {
                    <span class="msg" [class.ok]="!tuyaCredsErr()" [class.err]="tuyaCredsErr()">{{ tuyaCredsMsg() }}</span>
                  }
                </div>
              </div>
            }
          </div>
        </div>
      }

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

            <div class="add-form" style="margin-top:0.75rem">
              <input type="text"     [(ngModel)]="newUsername" placeholder="Username" autocomplete="off" />
              <input type="password" [(ngModel)]="newPassword" placeholder="Password" autocomplete="new-password" />
              <button class="btn-sm btn-primary" style="grid-column:span 2" (click)="addUser()" [disabled]="!newUsername.trim() || !newPassword.trim()">Add user</button>
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
  editAlias    = '';
  editIp       = '';
  editAuthUser  = '';
  editAuthPass  = '';
  showAuthPass  = false;
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

  // Manual add + probe
  newDeviceAlias      = '';
  newDeviceIp         = '';
  newDeviceDriverType = 'kasa';
  newDeviceDriverConfig: Record<string, unknown> | null = null;
  probing   = signal(false);
  probeMsg  = signal('');
  probeErr  = signal(false);

  // Discovery
  discovering       = signal(false);
  discoverMsg       = signal('');
  discoverErr       = signal(false);
  registering       = signal(false);
  private readonly _discoveredDevices = signal<DiscoveredDevice[]>([]);
  readonly discoveredDevices = this._discoveredDevices.asReadonly();
  private selectedIps = new Set<string>();
  readonly selectedCount = computed(() => {
    this.discoveredDevices();
    return this.selectedIps.size;
  });
  readonly hasTuyaDevices = computed(() =>
    this.discoveredDevices().some((d) => d.driverType === 'tuya')
  );

  // Tuya Cloud integration
  tuyaAccessId      = '';
  tuyaAccessSecret  = '';
  tuyaRegion        = 'us';
  showTuyaSecret    = false;
  tuyaCloudExpanded = signal(false);
  tuyaCloudReady    = signal(false);
  tuyaCredsMsg      = signal('');
  tuyaCredsErr      = signal(false);
  tuyaSyncing       = signal(false);
  tuyaSyncMsg       = signal('');
  tuyaSyncErr       = signal(false);
  tuyaCloudDevices: Array<{ deviceId: string; localKey: string; name: string; ip?: string }> = [];

  // Push notifications
  pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
  pushEnabled   = signal(false);
  pushMsg       = signal('');
  pushErr       = signal(false);

  // kWh rate
  kwhRateDraft = localStorage.getItem('kwhRate') ?? '0.15';

  constructor(readonly auth: AuthService, private http: HttpClient) {}

  ngOnInit(): void {
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
    if (this.isAdmin()) {
      this.http.get<UserRow[]>('/api/users').subscribe((u) => this._users.set(u));
      this.http.get<{ accessId: string; region: string; hasSecret: boolean }>('/api/tuya/credentials').subscribe((c) => {
        this.tuyaAccessId  = c.accessId;
        this.tuyaRegion    = c.region;
        this.tuyaCloudReady.set(!!c.accessId && c.hasSecret);
      });
    }
    this.checkPushStatus();
  }

  driverLabel(type: string): string {
    return DRIVER_LABEL[type] ?? type;
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
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
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
    this.editAlias    = d.alias;
    this.editIp       = d.ip;
    // Pre-fill credentials if already stored
    const auth = (d.driverConfig as any)?.auth;
    this.editAuthUser = auth?.user ?? '';
    this.editAuthPass = auth?.pass ?? '';
    this.showAuthPass = false;
    this.deviceMsg.set('');
  }

  cancelDeviceEdit(): void {
    this.editingDeviceId.set(null);
    this.editAuthUser = '';
    this.editAuthPass = '';
    this.showAuthPass = false;
    this.deviceMsg.set('');
  }

  saveDevice(id: number, driverType?: string): void {
    const device  = this.devices().find((d) => d.id === id);
    const payload: Record<string, unknown> = { alias: this.editAlias, ip: this.editIp };

    // For Shelly/Tuya, merge auth into driverConfig
    if (driverType === 'shelly' || driverType === 'tuya') {
      const baseConfig = { ...(device?.driverConfig ?? {}) } as Record<string, unknown>;
      if (this.editAuthUser.trim() && this.editAuthPass.trim()) {
        baseConfig['auth'] = { user: this.editAuthUser.trim(), pass: this.editAuthPass.trim() };
      } else {
        delete baseConfig['auth'];
      }
      payload['driverConfig'] = baseConfig;
    }

    this.http.patch<Device>(`/api/devices/${id}`, payload).subscribe({
      next: (updated) => {
        this._devices.update((list) => list.map((d) => d.id === id ? { ...d, ...updated } : d));
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

  // ── Probe ──────────────────────────────────────────────────

  probeIp(): void {
    const ip = this.newDeviceIp.trim();
    if (!ip) return;
    this.probing.set(true);
    this.probeMsg.set('');
    this.probeErr.set(false);
    this.http.post<any>('/api/devices/probe', { ip }).subscribe({
      next: (result) => {
        this.probing.set(false);
        this.newDeviceDriverType   = result.driverType ?? 'kasa';
        this.newDeviceDriverConfig = result.driverConfig ?? null;
        if (!this.newDeviceAlias.trim()) {
          this.newDeviceAlias = result.alias && result.alias !== ip ? result.alias : '';
        }
        this.probeMsg.set(`Detected: ${result.model ?? result.driverType} (${this.driverLabel(result.driverType)})`);
      },
      error: () => {
        this.probing.set(false);
        this.newDeviceDriverType   = 'kasa';
        this.newDeviceDriverConfig = null;
        this.probeMsg.set('Could not detect device — it may be offline or use an unsupported protocol.');
        this.probeErr.set(true);
      },
    });
  }

  // ── Discover ───────────────────────────────────────────────

  isSelected(ip: string): boolean { return this.selectedIps.has(ip); }

  toggleSelect(ip: string): void {
    if (this.selectedIps.has(ip)) this.selectedIps.delete(ip);
    else this.selectedIps.add(ip);
    this._discoveredDevices.update((list) => [...list]);
  }

  applyCloudDevice(d: DiscoveredDevice, event: Event): void {
    const deviceId = (event.target as HTMLSelectElement).value;
    if (!deviceId) return;
    const cloud = this.tuyaCloudDevices.find((c) => c.deviceId === deviceId);
    if (!cloud) return;
    d.pendingDeviceId = cloud.deviceId;
    d.pendingKey      = cloud.localKey;
    if (!d.pendingAlias?.trim()) d.pendingAlias = cloud.name || d.ip;
    this.onTuyaKeyChange(d);
  }

  onTuyaKeyChange(d: DiscoveredDevice): void {
    const hasId  = d.driverConfig?.['deviceId'] || d.pendingDeviceId?.trim();
    const hasKey = d.pendingKey?.trim();
    if (hasId && hasKey) this.selectedIps.add(d.ip);
    else this.selectedIps.delete(d.ip);
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
          this.discoverMsg.set('No new devices found. Kasa uses UDP broadcast; Shelly/Tuya must be added via IP probe.');
          this.discoverErr.set(false);
          return;
        }
        const existingIps = new Set(this._devices().map((d) => d.ip));
        const newDevices  = found
          .filter((f) => !existingIps.has(f.ip))
          .map((f) => ({ ...f, pendingAlias: f.alias && f.alias !== f.ip ? f.alias : '' }));
        if (newDevices.length === 0) {
          this.discoverMsg.set(`Found ${found.length} device(s) — all already registered.`);
          this.discoverErr.set(false);
          return;
        }
        // Pre-select non-Tuya devices (Tuya needs key first)
        newDevices.filter((d) => d.driverType !== 'tuya').forEach((d) => this.selectedIps.add(d.ip));
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
      // Build driver config — for Tuya, merge the user-supplied deviceId + key
      let driverConfig = d.driverConfig ?? null;
      if (d.driverType === 'tuya') {
        driverConfig = { ...driverConfig };
        if (d.pendingDeviceId?.trim()) driverConfig['deviceId'] = d.pendingDeviceId.trim();
        if (d.pendingKey?.trim())      driverConfig['key']      = d.pendingKey.trim();
      }

      this.http.post<Device>('/api/devices', {
        alias:        (d.pendingAlias || d.ip).trim(),
        ip:           d.ip,
        model:        d.model ?? null,
        hasEmeter:    d.hasEmeter ?? false,
        driverType:   d.driverType,
        driverConfig: driverConfig ?? undefined,
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
      alias:        this.newDeviceAlias.trim(),
      ip:           this.newDeviceIp.trim(),
      driverType:   this.newDeviceDriverType,
      driverConfig: this.newDeviceDriverConfig ?? undefined,
    }).subscribe({
      next: (created) => {
        this._devices.update((list) => [...list, created]);
        this.newDeviceAlias       = '';
        this.newDeviceIp          = '';
        this.newDeviceDriverType  = 'kasa';
        this.newDeviceDriverConfig = null;
        this.probeMsg.set(`"${created.alias}" added.`);
        this.probeErr.set(false);
        setTimeout(() => this.probeMsg.set(''), 2000);
      },
      error: (err) => { this.probeMsg.set(err.error?.error ?? 'Failed to add device.'); this.probeErr.set(true); },
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

  // ── Tuya Cloud ──────────────────────────────────────────────

  saveTuyaCredentials(): void {
    this.tuyaCredsMsg.set('');
    this.http.put('/api/tuya/credentials', {
      accessId:     this.tuyaAccessId.trim(),
      accessSecret: this.tuyaAccessSecret.trim(),
      region:       this.tuyaRegion,
    }).subscribe({
      next: () => {
        this.tuyaCloudReady.set(true);
        this.tuyaAccessSecret = '';
        this.showTuyaSecret   = false;
        this.tuyaCredsMsg.set('Saved');
        this.tuyaCredsErr.set(false);
        setTimeout(() => this.tuyaCredsMsg.set(''), 2000);
      },
      error: (err) => { this.tuyaCredsMsg.set(err.error?.error ?? 'Failed'); this.tuyaCredsErr.set(true); },
    });
  }

  syncTuyaCloud(): void {
    this.tuyaSyncing.set(true);
    this.tuyaSyncMsg.set('');
    this.http.post<Array<{ deviceId: string; localKey: string; name: string; ip?: string }>>('/api/tuya/sync', {}).subscribe({
      next: (devices) => {
        this.tuyaSyncing.set(false);
        this.tuyaCloudDevices = devices;
        // Auto-fill deviceId + localKey for any discovered Tuya devices
        let filled = 0;
        this._discoveredDevices.update((list) => list.map((d) => {
          if (d.driverType !== 'tuya') return d;
          // Match by IP first, then by name
          const match = devices.find((c) => c.ip === d.ip)
                     ?? devices.find((c) => c.name && d.alias && c.name.toLowerCase() === d.alias.toLowerCase());
          if (!match) return d;
          filled++;
          return {
            ...d,
            pendingAlias:    d.pendingAlias || match.name || d.alias,
            pendingDeviceId: match.deviceId,
            pendingKey:      match.localKey,
          };
        }));
        // Trigger checkbox re-evaluation for auto-filled devices
        this._discoveredDevices().filter((d) => d.driverType === 'tuya').forEach((d) => this.onTuyaKeyChange(d));
        const msg = filled > 0
          ? `Auto-filled ${filled} of ${this._discoveredDevices().filter(d => d.driverType === 'tuya').length} Tuya device(s). ${devices.length} total in cloud.`
          : `Fetched ${devices.length} cloud device(s) — no IP matches found. Enter Device IDs manually or check IPs.`;
        this.tuyaSyncMsg.set(msg);
        this.tuyaSyncErr.set(filled === 0 && devices.length > 0);
      },
      error: (err) => {
        this.tuyaSyncing.set(false);
        this.tuyaSyncMsg.set(err.error?.error ?? 'Cloud sync failed');
        this.tuyaSyncErr.set(true);
      },
    });
  }

  // ── Preferences ─────────────────────────────────────────────

  saveKwhRate(): void {
    const rate = parseFloat(this.kwhRateDraft);
    if (!isNaN(rate) && rate >= 0) localStorage.setItem('kwhRate', String(rate));
  }
}
