import { Component, OnInit, signal, computed, OnDestroy, viewChild, inject, effect, ElementRef, DestroyRef } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth/auth.service';
import { SystemService } from '../../core/services/system.service';
import { PushService } from '../../core/services/push.service';
import { SocketService } from '../../core/socket/socket.service';
import { DeviceFilterComponent, brandOf, matchesDevice, type DeviceFilter } from '../../shared/device-filter/device-filter.component';
import { CamerasStateService } from '../../core/services/cameras-state.service';
import { Device } from '../../shared/models/device.model';
import { BackupsComponent } from './backups.component';
import { BackupSyncComponent } from './backup-sync.component';
import { ServerRoleComponent } from './server-role.component';
import { MailProvider, providerForAddress, providerForHost } from './email-providers';
import { InviteQrComponent } from '../welcome/invite-qr.component';
import { MatterPairComponent } from './matter-pair.component';
import { MerossLoginComponent } from './meross-login.component';
import { HoneywellLoginComponent } from './honeywell-login.component';
import { AlarmcomLoginComponent } from './alarmcom-login.component';
import { OtherNetworksComponent } from './other-networks.component';
import { HomeSettingsComponent } from './home-settings.component';
import { AiConnectionComponent } from './ai-connection.component';
import { AiChoiceComponent } from './ai-choice.component';
import { CamerasToggleComponent } from './cameras-toggle.component';
import { TeachCommandsComponent } from './teach-commands.component';
import { VoiceRepliesComponent } from './voice-replies.component';
import { VoiceControlComponent } from './voice-control.component';
import { SettingsTilesComponent, type SettingsTile } from './settings-tiles.component';
import { AutomationsService } from '../../core/services/automations.service';
import { SecretInputDirective } from '../../shared/secret-input/secret-input.directive';
import { NicknameChipsComponent, type NicknameSuggestion } from '../../shared/nickname-chips/nickname-chips.component';
import { ThermostatRangesComponent } from '../../shared/thermostat/thermostat-ranges.component';
import { DeviceLockComponent } from '../../shared/lock/device-lock.component';
import { SpotifyConnectComponent } from '../../shared/spotify/spotify-connect.component';
import { LockService } from '../../core/lock/lock.service';

interface ChatStats {
  total: number;
  rules: number;
  model: number;
  recentModel: { text: string; createdAt: string }[];
  voice: {
    total: number;
    understood: number;
    missed: number;
    recentMissed: { text: string; createdAt: string }[];
  };
}

interface HealthItemLite { id: string; label: string; level: 'ok' | 'info' | 'warn' | 'error'; detail?: string }

/** What the Settings tiles show, from requests that each may fail on their own. */
interface SettingsSummary {
  health?:    { items: HealthItemLite[] };
  home?:      { timezone: string | null; located: boolean; temperatureUnit?: 'F' | 'C' };
  ai?:        { mode: 'local' | 'claude'; usage?: { costUsd?: number }; overLimit?: boolean };
  voice?:     { enabled: boolean; languages: string[] };
  misses?:    unknown[];
  honeywell?: { signedIn: boolean; rejected: boolean };
  alarm?:     { signedIn: boolean; rejected: boolean };
  meross?:    { signedIn: boolean };
  ring?:      { state: string };
}

const LANGUAGE_NAME: Record<string, string> = { en: 'English', yue: 'Cantonese', zh: 'Mandarin', vi: 'Vietnamese' };
const LANG_ORDER = ['en', 'yue', 'zh', 'vi'];

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
  mac?:         string;
  needsLogin?:  boolean;
  /** A device of another kind is saved at this address but isn't answering: it moved, and this one has it now. */
  staleOwner?:  string;
  moved?:       { deviceId: number; alias: string; previousIp: string };
  // editable before registering
  pendingAlias?:    string;
  pendingKey?:      string;   // Tuya only: local key required for control
  pendingDeviceId?: string;   // Tuya only: deviceId (from TCP scan, no UDP gwId)
  pendingUser?:     string;   // Only for devices that need a login
  pendingPass?:     string;
}

interface MerossAccountDevice { uuid: string; name: string; type: string; online: boolean; registered: boolean }

const DRIVER_LABEL: Record<string, string> = {
  kasa:   'Kasa',
  shelly: 'Shelly',
  tuya:   'Tuya',
  meross: 'Meross',
  wyze:   'Wyze',
  matter: 'Matter',
  honeywell: 'Honeywell',
  roomba: 'Roomba',
  lgtv:   'LG TV',
  sonos:  'Sonos',
};

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [SecretInputDirective, NicknameChipsComponent, ThermostatRangesComponent, FormsModule, RouterLink, InviteQrComponent, MatterPairComponent, DeviceFilterComponent, BackupsComponent, BackupSyncComponent, ServerRoleComponent, MerossLoginComponent, HoneywellLoginComponent, AlarmcomLoginComponent, OtherNetworksComponent, HomeSettingsComponent, AiConnectionComponent, AiChoiceComponent, CamerasToggleComponent, TeachCommandsComponent, VoiceRepliesComponent, VoiceControlComponent, SettingsTilesComponent, DeviceLockComponent, SpotifyConnectComponent],
  styles: [`
    .topbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:1.5rem; }
    .topbar h1 { font-size:1.4rem; font-weight:700; }
    .back-link { color:var(--text-muted); font-size:0.9rem; }
    .back-link:hover { color:var(--text); }

    .section { margin-bottom:1.25rem; }
    .section-toggle {
      display:flex; align-items:center; gap:0.4rem; width:100%; background:none; border:none;
      padding:0.35rem 0; cursor:pointer; text-align:left; font-family:inherit;
    }
    .section-toggle:hover { color:var(--text); }
    .section-toggle .chev { width:0.8rem; font-size:0.8rem; }
    .support { display:flex; align-items:center; gap:0.75rem 1rem; flex-wrap:wrap; margin-top:1.25rem; }
    .support-text { flex:1; min-width:14rem; }
    .support-links { display:flex; gap:0.5rem; flex-wrap:wrap; }
    .support-links a { text-decoration:none; display:inline-flex; align-items:center; }
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
    .group-title {
      font-size:0.72rem; font-weight:700; letter-spacing:0.06em; text-transform:uppercase;
      color:var(--text-muted); padding:0.9rem 0 0.2rem; border-bottom:1px solid var(--border);
    }
    .group-title:first-of-type { padding-top:0.2rem; }
    .group-toggle {
      display:flex; align-items:center; gap:0.35rem; width:100%; background:none; border:none;
      border-bottom:1px solid var(--border); border-radius:0; cursor:pointer; text-align:left; font-family:inherit;
    }
    .group-toggle:hover { color:var(--text); }
    .group-toggle .chev { width:0.75rem; }
    .group-count { font-weight:500; letter-spacing:0; opacity:0.75; margin-left:0.25rem; }
    .row-label .row-name, .row-label .row-sub { display:block; overflow:hidden; text-overflow:ellipsis; }
    .row-sub .offline { color:var(--red); }
    .link-btn { background:none; border:none; padding:0; color:var(--accent); font-size:inherit; cursor:pointer; text-decoration:underline; }
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
    .driver-badge.meross { border-color:#7c3aed; color:#c4b5fd; }
    .driver-badge.honeywell { border-color:#dc2626; color:#fca5a5; }
    .driver-badge.wyze   { border-color:#0e7490; color:#67e8f9; }
    .driver-badge.matter { border-color:#be185d; color:#f9a8d4; }
    .driver-badge.roomba { border-color:#4d7c0f; color:#bef264; }
    .driver-badge.lgtv{border-color:#913;color:#fab}
    .matter-panel { margin-top:0.75rem; padding:0.9rem; border:1px solid var(--border); border-radius:var(--radius); }

    .btn-sm {
      padding:0.3rem 0.75rem;
      font-size:0.8rem;
    }
    .teach-link { margin-top:0.75rem; }
    .btn-ghost {
      background:transparent;
      border:1px solid var(--border);
      color:var(--text-muted);
    }
    .btn-ghost:hover { background:var(--surface); color:var(--text); }
    .device-switch { min-width:3.2rem; }
    .device-switch.on { color:#4ade80; border-color:#4ade80; }
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

    @media (max-width: 599px) { .dev-edit .edit-row { grid-template-columns:1fr; } }
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
    /* The email form reads top to bottom: address first, then what it fills in. */
    .email-form { grid-template-columns:1fr; max-width:34rem; }
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
    .discover-login-note { flex-basis:100%; margin:0.2rem 0 0; font-size:0.78rem; color:var(--text-muted); }
    .discover-login-note.stale { color:#fbbf24; }
    .discover-ip    { font-size:0.78rem; color:var(--text-muted); white-space:nowrap; }
    .discover-model { font-size:0.72rem; color:var(--text-muted); white-space:nowrap; }
    .discover-footer { display:flex; align-items:center; justify-content:space-between; margin-top:0.5rem; }
    .key-warning { font-size:0.75rem; color:#fbbf24; margin-top:0.25rem; }
  `],
  template: `
    <div class="page" [class.hh-tiles]="view() === 'tiles'">

      <div class="topbar">
        <div style="display:flex;align-items:center;gap:1rem">
          <h1>Settings</h1>
        </div>
        <div class="hh-seg" role="group" aria-label="Show settings as">
          <button type="button" [attr.aria-pressed]="view() === 'tiles'" (click)="setView('tiles')">Tiles</button>
          <button type="button" [attr.aria-pressed]="view() === 'list'" (click)="setView('list')">List</button>
        </div>
      </div>

      @if (view() === 'tiles') {
        @if (pageTile(); as t) {
          <div class="hh-pagebar">
            <button type="button" class="hh-back" (click)="closePage()" aria-label="Back to all settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <h2>{{ t.name }}</h2>
          </div>
        } @else {
          <app-settings-tiles [tiles]="tiles()" (open)="toggleSection($event, true)" />
        }
      }

      <!-- ── Devices ───────────────────────────────────────────── -->
      <div class="section">
        <button type="button" id="section-devices" class="section-title section-toggle" (click)="toggleSection('devices')" [attr.aria-expanded]="isSectionOpen('devices')">
          <span class="chev">{{ isSectionOpen('devices') ? '▾' : '▸' }}</span> Devices
        </button>
        @if (isSectionOpen('devices')) {
          <div class="card">
            @if (devices().length > 0) {
              <app-device-filter style="margin-bottom:0.75rem" [devices]="devices()"
                                 [(search)]="deviceSearch" [(filter)]="deviceFilter" [showBrands]="true" [(brand)]="deviceBrand" />
            }
            @for (group of deviceGroups(); track group.name) {
              @if (group.name) {
                <button type="button" class="group-title group-toggle" (click)="toggleGroup(group.name)"
                        [attr.aria-expanded]="isGroupOpen(group.name)">
                  <span class="chev">{{ isGroupOpen(group.name) ? '▾' : '▸' }}</span>
                  {{ group.name }} <span class="group-count">{{ group.devices.length }}</span>
                </button>
              }
            @for (d of (!group.name || isGroupOpen(group.name) ? group.devices : []); track d.id) {
              <div class="row-item">
                @if (editingDeviceId() === d.id) {
                  <!-- A popup, so it's clear which device is being edited: inline, the form
                       sat under the row above it and read as that device's. -->
                  <div class="popup-overlay" (keydown.escape)="cancelDeviceEdit()">
                  <div #devEdit class="card popup-card dev-edit" role="dialog" aria-modal="true" aria-labelledby="dev-edit-title" tabindex="-1">
                    <div class="form-head">
                      <div>
                        <h2 id="dev-edit-title">{{ d.alias }}</h2>
                        <span class="row-meta">{{ driverLabel(d.driverType) }}{{ noAddress(d) ? '' : ' · ' + d.ip }}{{ d.room ? ' · ' + d.room : '' }}</span>
                      </div>
                      <button type="button" class="close" (click)="cancelDeviceEdit()" aria-label="Close without saving">
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
                      </button>
                    </div>
                    <div class="edit-row">
                      <label class="f">Name
                        <input type="text" [(ngModel)]="editAlias" placeholder="Name" />
                      </label>
                      @if (!noAddress(d)) {
                        <label class="f">IP address
                          <input type="text" [(ngModel)]="editIp"    placeholder="IP address" />
                        </label>
                      }
                    </div>
                    <div class="edit-row" style="margin-top:0.4rem">
                      <label class="f">Room
                        <input type="text" [(ngModel)]="editRoom" placeholder="Room" list="device-rooms" autocomplete="off" />
                      </label>
                      <datalist id="device-rooms">
                        @for (room of roomNames(); track room) { <option [value]="room"></option> }
                      </datalist>
                    </div>
                    <app-nickname-chips [(nicknames)]="editNicknames" [suggestions]="nicknameSuggestions()[d.id] ?? []"
                                        [others]="otherDevices(d.id)" />
                    <p style="font-size:0.75rem;color:var(--text-muted);margin:0.2rem 0 0">Give several devices the same nickname to switch them together by Chat or voice.</p>
                    <label style="display:flex;align-items:center;gap:0.4rem;margin-top:0.4rem;font-size:0.85rem">
                      <input type="checkbox" style="width:auto" [(ngModel)]="editProtected" />
                      Don't let Chat or AI assistants switch this device
                    </label>
                    <p style="font-size:0.75rem;color:var(--text-muted);margin:0.2rem 0 0">Valves, garage doors, cameras and automatic shutoff devices are always protected.</p>
                    @if (d.power && !d.power.excluded) {
                      <label class="f" style="margin-top:0.6rem">Power when on
                        @if (d.power.method === 'measured' && editWatts === null) {
                          <span style="font-size:0.85rem;color:var(--text)">Measured: {{ d.power.watts ?? '–' }} W
                            <button type="button" class="link" style="background:none;border:none;color:var(--accent);padding:0 0.3rem;font-size:0.8rem" (click)="editWatts = d.power.watts">Set instead</button></span>
                        } @else {
                          <span style="display:flex;align-items:center;gap:0.4rem">
                            <input type="number" min="0" max="5000" step="1" style="width:6.5rem" [(ngModel)]="editWatts"
                                   [placeholder]="d.power.method === 'typical' ? d.power.watts + ' (typical)' : 'watts'" aria-label="Power when on, in watts" /> W
                          </span>
                        }
                      </label>
                      <p style="font-size:0.75rem;color:var(--text-muted);margin:0.2rem 0 0">{{ powerHint(d) }}</p>
                    }
                    @if (d.driverConfig?.['kind'] === 'thermostat' && isAdmin()) { <app-thermostat-ranges [deviceId]="d.id" /> }
                    @if (d.driverType === 'shelly' || d.driverType === 'tuya') {
                      <div class="edit-row" style="margin-top:0.4rem">
                        <input type="text"     [(ngModel)]="editAuthUser" placeholder="Username (clear to remove the login)" autocomplete="off" aria-label="Username" />
                        <div class="pass-wrap">
                          <input [type]="showAuthPass ? 'text' : 'password'" [(ngModel)]="editAuthPass" [placeholder]="hasSavedPassword(d) ? 'Saved (leave blank to keep)' : 'Password'" autocomplete="new-password" aria-label="Password" />
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
                    @if (usesKasaLogin(d)) {
                      <div class="edit-row" style="margin-top:0.4rem">
                        <input type="email" [(ngModel)]="editKasaUser" placeholder="TP-Link email" autocomplete="off" />
                        <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore [(ngModel)]="editKasaPass" placeholder="TP-Link password" />
                        <button class="btn-sm btn-ghost" (click)="saveEditedKasaLogin()"
                                [disabled]="!editKasaUser.trim() || !editKasaPass || kasaLoginSaving()">
                          {{ kasaLoginSaving() ? 'Checking…' : 'Save login' }}
                        </button>
                      </div>
                      <p style="font-size:0.75rem;color:var(--text-muted);margin:0.2rem 0 0">
                        The account used in the Kasa app. It's shared by every Kasa plug that needs a login.
                      </p>
                      @if (kasaLoginMsg()) { <p class="msg" [class.ok]="!kasaLoginErr()" [class.err]="kasaLoginErr()">{{ kasaLoginMsg() }}</p> }
                    }
                    @if (d.driverType === 'tuya') {
                      <div class="edit-row" style="margin-top:0.4rem">
                        <input type="text" [(ngModel)]="editTuyaDeviceId" placeholder="Device ID (leave blank to keep existing)" autocomplete="off" />
                        <input type="text" [(ngModel)]="editTuyaKey"      placeholder="Local Key (leave blank to keep existing)" autocomplete="off" />
                      </div>
                      <div class="edit-row" style="margin-top:0.4rem">
                        <select [(ngModel)]="editTuyaVersion">
                          <option value="3.1">Protocol 3.1</option>
                          <option value="3.3">Protocol 3.3</option>
                          <option value="3.4">Protocol 3.4</option>
                          <option value="3.5">Protocol 3.5</option>
                        </select>
                        <span></span>
                      </div>
                      <p style="font-size:0.75rem;color:var(--text-muted);margin:0.2rem 0 0">Leave Device ID and Local Key blank to keep existing values.</p>
                    }
                    <div class="form-foot">
                      <button class="btn-primary" (click)="saveDevice(d.id, d.driverType)">Save</button>
                      <button class="btn-ghost" (click)="cancelDeviceEdit()">Cancel</button>
                      @if (deviceMsg()) { <span class="msg" [class.ok]="!deviceErr()" [class.err]="deviceErr()">{{ deviceMsg() }}</span> }
                    </div>
                  </div>
                  </div>
                }
                  <div class="row-label">
                    <span class="row-name">{{ d.alias }}</span>
                    <span class="row-meta row-sub">
                      {{ d.driverType === 'matter' ? matterModel(d) : d.driverType === 'honeywell' ? 'Honeywell · Total Connect Comfort' : d.ip }}
                      @if (d.hasEmeter) { · ⚡ }
                      @if (!d.online && d.isProtected) { <span class="offline"> · Offline</span> }
                    </span>
                  </div>
                  <span class="driver-badge" [class]="'driver-badge ' + d.driverType">
                    {{ driverLabel(d.driverType) }}
                  </span>
                  @if (!d.isProtected) {
                    <button class="btn-sm btn-ghost device-switch" [class.on]="d.state && d.online"
                            [disabled]="!d.online || switchingId() === d.id" (click)="switchDevice(d)"
                            [attr.aria-label]="(d.state ? 'Turn off ' : 'Turn on ') + d.alias">
                      {{ !d.online ? 'Offline' : d.state ? 'On' : 'Off' }}
                    </button>
                  }
                  @if (isAdmin() && !automations.readOnly()) {
                    <button class="btn-sm btn-ghost" (click)="startDeviceEdit(d)">Edit</button>
                    <button class="btn-sm btn-danger" (click)="deleteDevice(d.id, d.alias)">✕</button>
                  }
              </div>
            }
            }

            @if (devices().length > 0 && filteredDevices().length === 0) {
              <p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No devices match.</p>
            }

            @if (devices().length === 0) {
              <p style="color:var(--text-muted);font-size:0.85rem;padding:0.5rem 0">No devices registered. Use Discover to find devices on your network.</p>
            }

            @if (otherCameras(); as other) {
              <!-- Ring and IP cameras have nothing to switch, so they live on the Cameras page, not here. -->
              <p style="color:var(--text-muted);font-size:0.82rem;padding:0.5rem 0 0">
                Also on the <a routerLink="/cameras" [queryParams]="isAdmin() ? { tab: 'setup' } : null">Cameras page</a>: {{ other }}.
              </p>
            }

            @if (isAdmin() && !automations.readOnly()) {
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
                <button class="btn-sm btn-ghost" type="button" (click)="showMatter.set(!showMatter())" [attr.aria-expanded]="showMatter()">
                  + Add a Matter device
                </button>
              </div>
              @if (showMatter()) {
                <div class="matter-panel"><app-matter-pair (added)="reloadDevices()" /></div>
              }
              @if (discoverMsg()) { <p class="msg" [class.ok]="!discoverErr()" [class.err]="discoverErr()">{{ discoverMsg() }}</p> }
              @for (m of unreachedMeross(); track m.uuid) {
                <p class="msg err">
                  {{ m.name }} ({{ m.type }}) is on your Meross account, but HomeHub couldn't reach it.
                  @if (!m.online) { Meross says it's offline. }
                  <button type="button" class="link-btn" (click)="otherNetworks()?.open()">Is it on another Wi-Fi network?</button>
                </p>
              }
              <div style="margin-top:0.5rem"><app-other-networks /></div>

              <!-- Registered devices that now answer at a different address -->
              @if (movedDevices().length > 0) {
                <div class="discover-list">
                  @for (d of movedDevices(); track d.ip) {
                    <div class="discover-row">
                      <span class="discover-alias">{{ d.moved?.alias }} moved from {{ d.moved?.previousIp }} to {{ d.ip }}</span>
                      <button class="btn-sm btn-primary" (click)="applyMove(d)">Update address</button>
                    </div>
                  }
                </div>
              }

              <!-- Discovery results -->
              @if (discoveredDevices().length > 0) {
                <div class="discover-list">
                  @for (d of discoveredDevices(); track d.ip) {
                    <div class="discover-row">
                      <input type="checkbox" [checked]="isSelected(d.ip)" (change)="toggleSelect(d.ip)"
                             [disabled]="d.driverType === 'roomba' || d.driverType === 'lgtv' || !!d.staleOwner || (d.driverType === 'meross' && d.needsLogin) || (d.driverType === 'tuya' && (!d.pendingKey?.trim() || (!d.driverConfig?.['deviceId'] && !d.pendingDeviceId?.trim())))" />
                      <div class="discover-alias">
                        <input type="text" [(ngModel)]="d.pendingAlias" placeholder="Alias" />
                      </div>
                      <span class="discover-ip">{{ d.ip }}</span>
                      @if (d.model && d.model !== d.ip) { <span class="discover-model">{{ d.model }}</span> }
                      <span class="driver-badge" [class]="'driver-badge ' + d.driverType">{{ driverLabel(d.driverType) }}</span>
                      @if (d.staleOwner) {
                        <p class="discover-login-note stale">
                          {{ d.staleOwner }} is saved at {{ d.ip }}, but it isn't answering there: this device has that address now.
                          Change {{ d.staleOwner }}'s address under its settings, or remove it, then select Discover again.
                        </p>
                      } @else if (d.needsLogin && d.driverType === 'meross') {
                        <span class="discover-key-label">Sign in under Integrations → Meross, then Discover again</span>
                      } @else if (d.driverType === 'roomba') {
                        <p class="discover-login-note">
                          @if (pairingIp() === d.ip) {
                            Now hold the robot's <strong>Home</strong> button for about 2 seconds, until it plays a tone. After the tone, HomeHub can take up to a minute to connect.
                          } @else {
                            With the robot on its dock, tap Pair, then hold its <strong>Home</strong> button for about 2 seconds until it plays a tone. HomeHub then controls it over your Wi-Fi; no iRobot password is needed.
                          }
                        </p>
                        <button class="btn-sm btn-primary" type="button" (click)="pairRoomba(d)" [disabled]="pairingIp() !== null">
                          {{ pairingIp() === d.ip ? 'Waiting for the Home button…' : 'Pair' }}
                        </button>
                      } @else if (d.driverType === 'lgtv') {
                        <p class="discover-login-note">
                          @if (pairingIp() === d.ip) {
                            Look at the TV: it asks whether to allow HomeHub. Choose <strong>OK</strong> (or <strong>Allow</strong>) with its remote.
                          } @else {
                            With the TV on, tap Pair, then choose <strong>OK</strong> on the TV with its remote. To turn it on from HomeHub, also turn on <strong>Turn on via Wi-Fi</strong> (or <strong>Mobile TV On</strong>) in the TV's settings.
                          }
                        </p>
                        <button class="btn-sm btn-primary" type="button" (click)="pairTv(d)" [disabled]="pairingIp() !== null">
                          {{ pairingIp() === d.ip ? 'Waiting for OK on the TV…' : 'Pair' }}
                        </button>
                      } @else if (d.needsLogin) {
                        @if (d.driverType === 'kasa') {
                          <p class="discover-login-note">
                            @if (kasaUsername) {
                              Your saved TP-Link logins didn't work on this plug. Enter the password this plug's Kasa account has; it's checked on this plug and added to the saved ones, so your other plugs keep working.
                            } @else {
                              This plug needs the TP-Link login it was set up with in the Kasa app. It's saved for every plug that needs one.
                            }
                          </p>
                        }
                        <div class="discover-key">
                          <span class="discover-key-label">{{ d.driverType === 'kasa' ? 'TP-Link email' : 'Username' }}</span>
                          <input type="text" [(ngModel)]="d.pendingUser" autocomplete="off" />
                        </div>
                        <div class="discover-key">
                          <span class="discover-key-label">Password</span>
                          <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore [(ngModel)]="d.pendingPass" />
                        </div>
                        @if (d.driverType === 'kasa') {
                          <button class="btn-sm btn-primary" (click)="saveDiscoveredKasaLogin(d)"
                                  [disabled]="!d.pendingUser?.trim() || !d.pendingPass || kasaLoginSaving()">
                            {{ kasaLoginSaving() ? 'Checking…' : 'Save login' }}
                          </button>
                        }
                      }
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
        }
      </div>

      <!-- ── Home location and time zone (admin only) ─────────── -->
      @if (isAdmin() && !automations.readOnly()) {
        <div class="section">
          <button type="button" id="section-home" class="section-title section-toggle" (click)="toggleSection('home')" [attr.aria-expanded]="isSectionOpen('home')">
            <span class="chev">{{ isSectionOpen('home') ? '▾' : '▸' }}</span> Home
          </button>
          @if (isSectionOpen('home')) {
            <div class="card">
              <app-home-settings [welcome]="welcome()" />
              <p style="margin-top:1rem;font-size:0.82rem;color:var(--text-muted)">
                New to HomeHub, or moved house? <a routerLink="/welcome">Run the guided setup again</a>.
              </p>
            </div>
          }
        </div>
      }

      <!-- ── Integrations (admin only) ────────────────────────── -->
      @if (isAdmin() && !automations.readOnly()) {
        <div class="section">
          <button type="button" id="section-integrations" class="section-title section-toggle" (click)="toggleSection('integrations')" [attr.aria-expanded]="isSectionOpen('integrations')">
            <span class="chev">{{ isSectionOpen('integrations') ? '▾' : '▸' }}</span> Integrations
          </button>
          @if (isSectionOpen('integrations')) {
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

            <!-- ── Meross ────────────────────────────────────────────── -->
            <div class="card">
              <app-meross-login [openRequest]="merossOpenRequest()" (signedInChange)="onMerossSignIn($event)" />
            </div>

            <!-- ── Honeywell (Total Connect Comfort) ─────────────────── -->
            <div class="card">
              <app-honeywell-login (devicesChanged)="reloadDevices()" />
            </div>

            <!-- ── Alarm.com (the alarm system, read only) ───────────── -->
            <div class="card">
              <app-alarmcom-login />
            </div>

            <!-- ── Email (BYOK SMTP) ────────────────────────────────── -->
            <div class="card">
              <div class="pref-row" style="cursor:pointer" (click)="emailExpanded.set(!emailExpanded())">
                <div class="pref-label">
                  Email alerts (SMTP)
                  <div class="pref-sub">Resend, Gmail App Password, AWS SES — any SMTP server. Used for L2+ alerts.</div>
                </div>
                @if (emailReady()) { <span class="tuya-synced">● Configured</span> }
                <span style="color:var(--text-muted);font-size:0.85rem">{{ emailExpanded() ? '▲' : '▼' }}</span>
              </div>
              @if (emailExpanded()) {
                <div class="tuya-cloud-form email-form">
                  <input type="email" [(ngModel)]="smtpUser" placeholder="Your email address (or SMTP username)" autocomplete="email"
                         (blur)="fillFromAddress()" aria-label="Email address or SMTP username" />
                  @if (mailProvider(); as mp) {
                    @if (mp.unsupported) {
                      <div class="msg err" style="font-size:0.8rem;line-height:1.45">{{ mp.unsupported }}</div>
                    } @else {
                      <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.45">
                        {{ mp.name }}: for the password, use an <b>app password</b>, not your normal one. Create it at
                        <a [href]="mp.passwordUrl" target="_blank" rel="noopener">{{ mp.passwordUrl?.replace('https://', '') }}</a>.
                        {{ mp.passwordNote }}
                      </div>
                    }
                  } @else if (!smtpHost.trim()) {
                    <div style="font-size:0.8rem;color:var(--text-muted);line-height:1.45">
                      Enter your address and HomeHub fills in the server for Gmail, Yahoo, iCloud and AOL. For anything else, such as
                      Resend or your internet provider, enter its server below.
                    </div>
                  }
                  <div class="pass-wrap">
                    <input [type]="showSmtpPass ? 'text' : 'password'" [(ngModel)]="smtpPass"
                           [placeholder]="hasSmtpPass() ? 'Password (leave blank to keep current)' : 'Password / API key'"
                           autocomplete="new-password" />
                    <button type="button" class="pass-eye" (click)="showSmtpPass = !showSmtpPass">
                      @if (showSmtpPass) {
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
                  <input type="text" [(ngModel)]="smtpHost" placeholder="Server (e.g. smtp.resend.com)" autocomplete="off" aria-label="SMTP server" />
                  <div style="display:flex;gap:0.5rem">
                    <input type="number" [(ngModel)]="smtpPort" placeholder="Port" style="width:6rem" aria-label="SMTP port" />
                    <label style="display:flex;align-items:center;gap:0.4rem;font-size:0.85rem;color:var(--text-muted);white-space:nowrap">
                      <input type="checkbox" [(ngModel)]="smtpSecure" /> TLS (port 465)
                    </label>
                  </div>
                  <input type="text" [(ngModel)]="smtpFrom" placeholder='From (optional), e.g. HomeHub or "HomeHub" <alerts@example.com>' autocomplete="off" />
                  <input type="text" [(ngModel)]="emailRecipients" placeholder="Recipients (comma-separated)" autocomplete="off" />
                  <div style="display:flex;align-items:center;gap:0.5rem">
                    <button class="btn-sm btn-primary" (click)="saveSmtp()"
                            [disabled]="!smtpHost.trim() || !emailRecipients.trim()">Save</button>
                    @if (emailMsg()) {
                      <span class="msg" [class.ok]="!emailErr()" [class.err]="emailErr()">{{ emailMsg() }}</span>
                    }
                  </div>
                </div>
              }
            </div>

            <!-- ── SMS (BYOK Twilio) ────────────────────────────────── -->
            <div class="card">
              <div class="pref-row" style="cursor:pointer" (click)="smsExpanded.set(!smsExpanded())">
                <div class="pref-label">
                  SMS alerts (Twilio)
                  <div class="pref-sub">Used for L3 critical alerts. Sender must be a Twilio-verified number in E.164.</div>
                </div>
                @if (smsReady()) { <span class="tuya-synced">● Configured</span> }
                <span style="color:var(--text-muted);font-size:0.85rem">{{ smsExpanded() ? '▲' : '▼' }}</span>
              </div>
              @if (smsExpanded()) {
                <div class="tuya-cloud-form">
                  <input type="text" [(ngModel)]="twilioAccountSid" placeholder="Account SID (starts with AC)" autocomplete="off" />
                  <div class="pass-wrap">
                    <input [type]="showTwilioToken ? 'text' : 'password'" [(ngModel)]="twilioAuthToken"
                           [placeholder]="hasTwilioToken() ? 'Auth Token (leave blank to keep current)' : 'Auth Token'"
                           autocomplete="new-password" />
                    <button type="button" class="pass-eye" (click)="showTwilioToken = !showTwilioToken">
                      @if (showTwilioToken) {
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
                  <input type="text" [(ngModel)]="twilioFrom" placeholder="From number (e.g. +15555551234)" autocomplete="off" />
                  <input type="text" [(ngModel)]="smsRecipients" placeholder="Recipient numbers (E.164, comma-separated)" autocomplete="off" />
                  <div style="display:flex;align-items:center;gap:0.5rem">
                    <button class="btn-sm btn-primary" (click)="saveTwilio()"
                            [disabled]="!twilioAccountSid.trim() || !twilioFrom.trim() || !smsRecipients.trim()">Save</button>
                    @if (smsMsg()) {
                      <span class="msg" [class.ok]="!smsErr()" [class.err]="smsErr()">{{ smsMsg() }}</span>
                    }
                  </div>
                </div>
              }
              <app-cameras-toggle />
              <div class="pref-row" style="cursor:pointer" (click)="aiExpanded.set(!aiExpanded())">
                <div class="pref-label">
                  AI assistant (MCP)
                  <div class="pref-sub">Connect an AI app such as Claude Desktop</div>
                </div>
                <span class="chev">{{ aiExpanded() ? '▾' : '▸' }}</span>
              </div>
              @if (aiExpanded()) {
                <app-ai-connection />
              }
            </div>
          }
        </div>
      }

      <!-- ── Users (admin only) ────────────────────────────────── -->
      @if (isAdmin()) {
        <div class="section">
          <button type="button" id="section-users" class="section-title section-toggle" (click)="toggleSection('users')" [attr.aria-expanded]="isSectionOpen('users')">
            <span class="chev">{{ isSectionOpen('users') ? '▾' : '▸' }}</span> Users
          </button>
          @if (isSectionOpen('users')) {
            <div class="card" style="margin-bottom:0.75rem">
              <p style="font-weight:600;margin-bottom:0.25rem">Invite family</p>
              <p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem">They scan a code and choose their own name and password.</p>
              <app-invite-qr />
            </div>
            <div class="card">
              @for (u of users(); track u.id) {
                <div class="row-item">
                  @if (editingUserId() === u.id) {
                    <div style="flex:1;width:100%">
                      <div class="edit-row single">
                        <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore [(ngModel)]="editPassword" placeholder="New password" />
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
                <input type="text" class="secret" autocomplete="off" spellcheck="false" autocapitalize="off" data-1p-ignore data-lpignore="true" data-bwignore [(ngModel)]="newPassword" placeholder="Password" />
                <button class="btn-sm btn-primary" style="grid-column:span 2" (click)="addUser()" [disabled]="!newUsername.trim() || !newPassword.trim()">Add user</button>
              </div>
              @if (addUserMsg()) { <p class="msg" [class.ok]="!addUserErr()" [class.err]="addUserErr()">{{ addUserMsg() }}</p> }
            </div>
          }
        </div>
      }

      <!-- ── Notifications ─────────────────────────────────────── -->
      <div class="section">
        <button type="button" id="section-notifications" class="section-title section-toggle" (click)="toggleSection('notifications')" [attr.aria-expanded]="isSectionOpen('notifications')">
          <span class="chev">{{ isSectionOpen('notifications') ? '▾' : '▸' }}</span> Notifications
        </button>
        @if (isSectionOpen('notifications')) {
          <div class="card">
            <div class="pref-row">
              <div class="pref-label">
                Notifications on this device
                <div class="pref-sub">HomeHub’s alerts on this phone or computer: a missed check-in, a water leak, a device going offline</div>
              </div>
              @if (push.state() === 'on' || push.state() === 'off') {
                <button class="btn-sm" [class.btn-primary]="push.state() === 'off'" [class.btn-ghost]="push.state() === 'on'" (click)="togglePush()" [disabled]="pushBusy()">
                  {{ push.state() === 'on' ? 'Turn off' : 'Turn on' }}
                </button>
              }
            </div>
            @if (pushHelp(); as h) { <p class="msg">{{ h }}</p> }
            @if (pushMsg()) { <p class="msg" [class.ok]="!pushErr()" [class.err]="pushErr()">{{ pushMsg() }}</p> }
          </div>
        }
      </div>

      <!-- ── Preferences ───────────────────────────────────────── -->
      <!-- ── AI for Chat and voice (admin only) ─────────────────────────── -->
      @if (isAdmin() && !automations.readOnly()) {
        <div class="section" id="ai-choice">
          <button type="button" id="section-ai" class="section-title section-toggle" (click)="toggleSection('ai')" [attr.aria-expanded]="isSectionOpen('ai')">
            <span class="chev">{{ isSectionOpen('ai') ? '▾' : '▸' }}</span> AI for Chat and voice
          </button>
          @if (isSectionOpen('ai')) {
            <div class="card"><app-ai-choice /></div>
          }
        </div>
      }

      <!-- ── Voice control (admin only) ─────────────────────────── -->
      @if (isAdmin() && !automations.readOnly()) {
        <div class="section">
          <button type="button" id="section-voice" class="section-title section-toggle" (click)="toggleSection('voice')" [attr.aria-expanded]="isSectionOpen('voice')">
            <span class="chev">{{ isSectionOpen('voice') ? '▾' : '▸' }}</span> Voice control
          </button>
          @if (isSectionOpen('voice')) {
            <div class="card"><app-voice-control (nicknamesChanged)="reloadDevices()" /></div>
          }
        </div>
      }

      <!-- ── Teach HomeHub (admin only) ───────────────────────── -->
      @if (isAdmin() && !automations.readOnly()) {
        <div class="section" id="teach-homehub">
          <button type="button" id="section-teach" class="section-title section-toggle" (click)="toggleSection('teach')" [attr.aria-expanded]="isSectionOpen('teach')">
            <span class="chev">{{ isSectionOpen('teach') ? '▾' : '▸' }}</span> Teach HomeHub
          </button>
          @if (isSectionOpen('teach')) {
            <div class="card"><app-teach-commands /></div>
          }
        </div>
      }

      <!-- ── Voice replies (admin only) ─────────────────────────── -->
      @if (isAdmin() && !automations.readOnly()) {
        <div class="section">
          <button type="button" id="section-replies" class="section-title section-toggle" (click)="toggleSection('replies')" [attr.aria-expanded]="isSectionOpen('replies')">
            <span class="chev">{{ isSectionOpen('replies') ? '▾' : '▸' }}</span> Voice replies
          </button>
          @if (isSectionOpen('replies')) {
            <div class="card"><app-voice-replies /></div>
          }
        </div>
      }

      <div class="section">
        <button type="button" id="section-chat-commands" class="section-title section-toggle" (click)="toggleSection('chat-commands')" [attr.aria-expanded]="isSectionOpen('chat-commands')">
          <span class="chev">{{ isSectionOpen('chat-commands') ? '▾' : '▸' }}</span> Chat commands
        </button>
        @if (isSectionOpen('chat-commands')) {
          <div class="card">
            @if (chatStats(); as stats) {
              <p style="margin:0">
                <strong>{{ stats.rules }}</strong> of {{ stats.total }} answered instantly by rules ·
                <strong>{{ stats.model }}</strong> sent to the AI model
              </p>
              @if (stats.recentModel.length) {
                <p style="font-size:0.75rem;color:var(--text-muted);margin:0.75rem 0 0.25rem">Latest messages sent to the AI model:</p>
                @for (item of stats.recentModel.slice(0, 10); track $index) {
                  <div style="font-size:0.85rem;padding:0.15rem 0;overflow-wrap:anywhere">{{ item.text }}</div>
                }
                @if (isAdmin()) {
                  @if (!automations.readOnly()) { <button type="button" class="btn-sm btn-primary teach-link" (click)="openTeach()">Teach these</button> }
                }
              }
            } @else {
              <p style="margin:0;color:var(--text-muted)">No stats available.</p>
            }
          </div>
        }
      </div>

      @if (chatStats()?.voice; as voice) {
        @if (voice.total > 0) {
          <div class="section">
            <button type="button" id="section-voice-commands" class="section-title section-toggle" (click)="toggleSection('voice-commands')" [attr.aria-expanded]="isSectionOpen('voice-commands')">
              <span class="chev">{{ isSectionOpen('voice-commands') ? '▾' : '▸' }}</span> Voice commands
            </button>
            @if (isSectionOpen('voice-commands')) {
              <div class="card">
                <p style="margin:0">
                  <strong>{{ voice.understood }}</strong> of {{ voice.total }} understood ·
                  <strong>{{ voice.missed }}</strong> missed
                </p>
                @if (voice.recentMissed.length) {
                  <p style="font-size:0.75rem;color:var(--text-muted);margin:0.75rem 0 0.25rem">Latest misses, as speech recognition heard them:</p>
                  @for (item of voice.recentMissed.slice(0, 10); track $index) {
                    <div style="font-size:0.85rem;padding:0.15rem 0;overflow-wrap:anywhere">{{ item.text }}</div>
                  }
                  @if (isAdmin()) {
                    @if (!automations.readOnly()) { <button type="button" class="btn-sm btn-primary teach-link" (click)="openTeach()">Teach these</button> }
                  }
                }
              </div>
            }
          </div>
        }
      }

      <!-- ── Backups (admin only) ──────────────────────────────── -->
      @if (isAdmin()) {
        <div class="section">
          <button type="button" id="section-backups" class="section-title section-toggle" (click)="toggleSection('backups')" [attr.aria-expanded]="isSectionOpen('backups')">
            <span class="chev">{{ isSectionOpen('backups') ? '▾' : '▸' }}</span> Backups
          </button>
          @if (isSectionOpen('backups')) {
            <div class="card">
              <app-backup-sync (copied)="reloadAfterRestore()" />
              <app-backups [emailChanged]="emailSettingsChanged()" (restored)="reloadAfterRestore()" />
            </div>
          }
        </div>
      }

      <div class="section">
        <button type="button" id="section-spotify" class="section-title section-toggle" (click)="toggleSection('spotify')" [attr.aria-expanded]="isSectionOpen('spotify')">
          <span class="chev">{{ isSectionOpen('spotify') ? '▾' : '▸' }}</span> Spotify
        </button>
        @if (isSectionOpen('spotify')) { <div class="card"><app-spotify-connect /></div> }
      </div>

      <div class="section">
        <button type="button" id="section-lock" class="section-title section-toggle" (click)="toggleSection('lock')" [attr.aria-expanded]="isSectionOpen('lock')">
          <span class="chev">{{ isSectionOpen('lock') ? '▾' : '▸' }}</span> Lock HomeHub
        </button>
        @if (isSectionOpen('lock')) { <div class="card"><app-device-lock /></div> }
      </div>

      <div class="section">
        <button type="button" id="section-preferences" class="section-title section-toggle" (click)="toggleSection('preferences')" [attr.aria-expanded]="isSectionOpen('preferences')">
          <span class="chev">{{ isSectionOpen('preferences') ? '▾' : '▸' }}</span> Preferences
        </button>
        @if (isSectionOpen('preferences')) {
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

            @if (isAdmin()) { <app-server-role /> }

            <!-- For developers: shown on a development copy, or to resume one that's paused. -->
            @if (isAdmin() && (appVersion() === 'dev' || automations.paused())) {
              <div class="pref-row">
                <div class="pref-label">
                  Pause automations
                  <div class="pref-sub">
                    For a second HomeHub, such as a development copy, that uses the same devices as your main one.
                    While paused, this HomeHub runs no schedules, motion rules, timers, camera motion snapshots or automatic water shutoff.
                    You can still switch devices by hand.
                  </div>
                </div>
                <input type="checkbox" [checked]="automations.paused()" (change)="setPaused($any($event.target))"
                       aria-label="Pause automations on this HomeHub" style="width:1.1rem;height:1.1rem;flex-shrink:0" />
              </div>
              @if (pauseMsg()) { <p class="msg err" style="margin:0 0 0.5rem">{{ pauseMsg() }}</p> }
            }

            <div class="pref-row">
              <div class="pref-label">
                Version
                <div class="pref-sub">
                  {{ appVersion() === 'dev' ? 'Development build, running outside Docker' : 'Installed release' }}
                </div>
              </div>
              <span style="font-size:0.9rem">{{ appVersion() || '…' }}</span>
            </div>
          </div>
        }
      </div>

      @if (view() === 'list' || !pageTile()) {
      <div class="card support">
        <div class="support-text">
          <strong>Support HomeHub</strong>
          <div class="pref-sub">HomeHub is free and open source. If it's useful to you, a donation helps keep it going.</div>
        </div>
        <div class="support-links">
          <a class="btn-sm btn-primary" href="https://buy.stripe.com/aFabIUfbD70fgk7fmY2B200" target="_blank" rel="noopener">Donate</a>
          <a class="btn-sm btn-ghost" href="https://github.com/foodisready/homehub" target="_blank" rel="noopener">Source code</a>
        </div>
      </div>
      }

    </div>
  `,
})
export class SettingsComponent implements OnInit, OnDestroy {
  private readonly _devices = signal<Device[]>([]);
  private readonly _users   = signal<UserRow[]>([]);

  readonly devices = this._devices.asReadonly();
  readonly users   = this._users.asReadonly();
  readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  readonly automations = inject(AutomationsService);
  readonly lockService = inject(LockService);
  readonly pauseMsg = signal('');

  setPaused(box: HTMLInputElement): void {
    this.pauseMsg.set('');
    this.automations.setPaused(box.checked).subscribe({
      error: (err: HttpErrorResponse) => {
        box.checked = !box.checked;
        this.pauseMsg.set(err.error?.error ?? 'Could not save. Try again.');
      },
    });
  }

  // ── Collapsible sections ───────────────────────────────────
  // One open at a time, so the page stays short enough to find things in, on a phone above all. Devices
  // starts open; the one open last is remembered on this browser.
  private static readonly SECTION_KEY = 'homehub.settings.open';
  // As tiles (the default) or the list of sections, as this browser last chose. As tiles, an open
  // section is a page of its own, in the address (?section=), so the phone's Back button goes back.
  private static readonly VIEW_KEY = 'homehub.settings.view';
  readonly view = signal<'tiles' | 'list'>(SettingsComponent.loadView());
  private readonly openSection = signal<string | null>(this.view() === 'tiles' ? null : SettingsComponent.loadSection());
  private readonly router = inject(Router);
  /** Opened a page from the tiles here, so Back in the page bar can go back in the browser's history. */
  private pagedHere = false;

  private static loadView(): 'tiles' | 'list' {
    try { return localStorage.getItem(SettingsComponent.VIEW_KEY) === 'list' ? 'list' : 'tiles'; } catch { return 'tiles'; }
  }

  setView(v: 'tiles' | 'list'): void {
    if (v === this.view()) return;
    this.view.set(v);
    try { localStorage.setItem(SettingsComponent.VIEW_KEY, v); } catch { /* the choice lasts this visit */ }
    this.pagedHere = false;
    // The open page stays open as the list's open section; going to tiles starts at all of them.
    if (v === 'tiles') {
      this.openSection.set(null);
      void this.router.navigate([], { relativeTo: this.route, queryParams: { section: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
  }

  /** The tile whose page is open, as tiles; null shows all the tiles. */
  readonly pageTile = computed(() => {
    const key = this.openSection();
    return this.view() === 'tiles' && key ? this.tiles().find((t) => t.key === key) ?? null : null;
  });

  closePage(): void {
    if (this.pagedHere) { this.pagedHere = false; history.back(); return; }
    void this.router.navigate([], { relativeTo: this.route, queryParams: { section: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  private static loadSection(): string | null {
    try {
      const saved = localStorage.getItem(SettingsComponent.SECTION_KEY);
      return saved === null ? 'devices' : saved || null;
    } catch {
      return 'devices';
    }
  }

  // Room groups in Devices: closed until opened, except Unassigned, which lists devices still to set up.
  // Always open while searching or filtering. Choices are remembered on this browser.
  private static readonly GROUPS_KEY = 'homehub.settings.rooms';
  private readonly groupState = signal<Record<string, boolean>>(SettingsComponent.loadGroupState());

  private static loadGroupState(): Record<string, boolean> {
    try {
      const state = JSON.parse(localStorage.getItem(SettingsComponent.GROUPS_KEY) ?? '{}');
      return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch {
      return {};
    }
  }

  isGroupOpen(name: string): boolean {
    if (this.deviceSearch().trim() || this.deviceFilter() !== 'all' || this.activeBrand() !== 'all') return true;
    return this.groupState()[name] ?? name === 'Unassigned';
  }

  toggleGroup(name: string): void {
    if (this.deviceSearch().trim() || this.deviceFilter() !== 'all' || this.activeBrand() !== 'all') return;   // results always show
    this.groupState.update((state) => ({ ...state, [name]: !this.isGroupOpen(name) }));
    try { localStorage.setItem(SettingsComponent.GROUPS_KEY, JSON.stringify(this.groupState())); } catch { /* private window */ }
  }

  /** Arrived from creating the first admin account (/settings?welcome=1). */
  readonly welcome = signal(false);
  readonly aiExpanded = signal(false);
  private readonly route = inject(ActivatedRoute);

  isSectionOpen(key: string): boolean {
    return this.openSection() === key;
  }

  /** From a list of misses: opens Teach HomeHub, where each one can be taught or ignored. */
  openTeach(): void {
    this.toggleSection('teach', true);
    setTimeout(() => document.getElementById('teach-homehub')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /**
   * Opening a section closes the one that was open. When that one was above it, the page gets shorter
   * above the section just opened and its title can end up off the top of the screen: it's scrolled
   * back into view, just below the top bar. A title still in view isn't moved.
   */
  toggleSection(key: string, open = !this.isSectionOpen(key)): void {
    if (this.view() === 'tiles') {
      // The address says which page is open: the route change below opens or closes it.
      if (open === this.isSectionOpen(key)) return;
      if (open) this.pagedHere = true;
      void this.router.navigate([], { relativeTo: this.route, queryParams: { section: open ? key : null }, queryParamsHandling: 'merge', replaceUrl: !open });
      return;
    }
    if (!open && !this.isSectionOpen(key)) return;
    this.openSection.set(open ? key : null);
    try { localStorage.setItem(SettingsComponent.SECTION_KEY, open ? key : ''); } catch { /* private window */ }
    // Once the page has been laid out again, after the closed section is gone.
    if (open) requestAnimationFrame(() => requestAnimationFrame(() => this.bringIntoView(key)));
  }

  private bringIntoView(key: string): void {
    const title = document.getElementById(`section-${key}`);
    if (!title) return;
    // The top bar on a wide screen stays at the top; on a phone the menu is at the bottom.
    const bar = Math.max(document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0, 0);
    const top = title.getBoundingClientRect().top;
    // At once, not smoothly: the page has just jumped anyway, and a smooth scroll is cut short by the
    // new section's content as it loads.
    if (top < bar + 8) window.scrollTo({ top: window.scrollY + top - bar - 12 });
  }
  readonly currentUser = computed(() => this.auth.user()?.name ?? '');

  chatStats = signal<ChatStats | null>(null);

  // ── Settings as tiles ──────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  /** How things are, for the tiles' status lines. Each part is filled in as it arrives, or stays unknown. */
  private readonly summary = signal<SettingsSummary>({});

  /** Fetches what the tiles show. Each request is on its own: one that fails leaves its tile plain. */
  private loadSummary(): void {
    const get = <K extends keyof SettingsSummary>(url: string, key: K) =>
      this.http.get<SettingsSummary[K]>(url).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (value) => this.summary.update((s) => ({ ...s, [key]: value })),
        error: () => undefined,
      });
    get('/api/system/health', 'health');
    get('/api/home-settings', 'home');
    if (!this.isAdmin()) return;
    get('/api/ai', 'ai');
    get('/api/nlp/voice', 'voice');
    get('/api/nlp/misses', 'misses');
    get('/api/honeywell/login', 'honeywell');
    get('/api/alarm/login', 'alarm');
    get('/api/meross/login', 'meross');
    get('/api/ring', 'ring');
  }

  private healthItem(id: string): HealthItemLite | undefined {
    return this.summary().health?.items.find((i) => i.id === id);
  }

  /** The sections this person can open, as tiles, with how each is doing. */
  readonly tiles = computed<SettingsTile[]>(() => {
    const admin = this.isAdmin();
    const full = admin && !this.automations.readOnly();
    const sum = this.summary();
    const bad = (i?: HealthItemLite) => i?.level === 'warn' || i?.level === 'error';
    const out: SettingsTile[] = [];

    // Your home
    const devices = this.devices();
    const offline = devices.filter((d) => !d.online).length;
    out.push({
      key: 'devices', name: 'Devices', group: 'Your home', icon: 'devices', hue: '#4f8cff',
      status: !devices.length ? 'None yet: add your first' : offline ? `${devices.length} devices · ${offline} offline` : `${devices.length} devices · all online`,
      look: offline > 0, words: 'add discover find scan probe rename room nickname matter kasa tuya shelly meross wyze honeywell roomba irobot vacuum lg tv television webos sonos speaker music thermostat plug light',
    });
    if (full) {
      const h = sum.home;
      const city = h?.timezone ? (h.timezone.split('/').pop() ?? '').replace(/_/g, ' ') : '';
      out.push({
        key: 'home', name: 'Home', group: 'Your home', icon: 'house', hue: '#3ddc97',
        status: !h ? 'Location and time zone' : [city || 'Time zone not set', h.located ? '' : 'location not set', `°${h.temperatureUnit ?? 'F'}`].filter(Boolean).join(' · '),
        look: !!h && !h.located && bad(this.healthItem('location')), words: 'location address time zone timezone sunrise sunset temperature unit fahrenheit celsius',
      });
    }
    if (admin) {
      const n = this.users().length;
      out.push({
        key: 'users', name: 'People', group: 'Your home', icon: 'users', hue: '#c38bff',
        status: n ? `${n} ${n === 1 ? 'person' : 'people'}` : 'Who can sign in', words: 'users invite qr password admin member account sign in',
      });
      const backup = this.healthItem('backups');
      const made = backup?.detail?.match(/^Last made ([^.]+)\./)?.[1];
      out.push({
        key: 'backups', name: 'Backups', group: 'Your home', icon: 'backup', hue: '#5ad1e6',
        status: made ? `Last backup ${made}` : bad(backup) ? 'No recent backup' : 'Save and restore',
        look: bad(backup), words: 'backup restore download upload export email copy sync second homehub',
      });
    }

    // Talking to HomeHub
    if (full) {
      const v = sum.voice;
      const bridge = this.healthItem('voice-bridge');
      const speakers = this.healthItem('speakers');
      const trouble = bad(bridge) ? bridge : bad(speakers) ? speakers : undefined;
      // Always English, then Cantonese, Mandarin and Vietnamese, however they were saved.
      const langs = v && [...v.languages].sort((a, b) => LANG_ORDER.indexOf(a) - LANG_ORDER.indexOf(b)).map((l) => LANGUAGE_NAME[l] ?? l).join(', ');
      out.push({
        key: 'voice', name: 'Voice control', group: 'Talking to HomeHub', icon: 'mic', hue: '#ff8a3d',
        status: !v ? 'Speakers and languages' : !v.enabled ? 'Off' : trouble ? `${trouble.label}: needs a look` : langs || 'On',
        look: !!v?.enabled && !!trouble, words: 'voice wake word speaker ava voice pe language cantonese vietnamese mandarin english bridge',
      });
      out.push({
        key: 'replies', name: 'Voice replies', group: 'Talking to HomeHub', icon: 'speaker', hue: '#ffb44d',
        status: 'What HomeHub says back', words: 'reply replies answer friendly funny plain custom',
      });
      const ai = sum.ai;
      out.push({
        key: 'ai', name: 'AI for Chat and voice', group: 'Talking to HomeHub', icon: 'brain', hue: '#9b8cff',
        status: !ai ? 'Which AI understands you' : ai.mode === 'claude' ? `Claude · $${(ai.usage?.costUsd ?? 0).toFixed(2)} this month` : 'On this HomeHub',
        look: !!ai?.overLimit, words: 'ai claude model ollama api key limit cost chat',
      });
      const misses = sum.misses?.length ?? 0;
      out.push({
        key: 'teach', name: 'Teach HomeHub', group: 'Talking to HomeHub', icon: 'teach', hue: '#ff6fa8',
        status: misses ? `${misses} ${misses === 1 ? 'thing' : 'things'} it didn't understand` : 'Words it should know',
        words: 'teach missed misunderstood nickname words phrases commands',
      });
    }
    out.push({
      key: 'chat-commands', name: 'Chat commands', group: 'Talking to HomeHub', icon: 'list', hue: '#7aa2c9',
      status: 'What you can say', words: 'chat commands help examples say',
    });
    const voice = this.chatStats()?.voice;
    if (voice && voice.total > 0) {
      out.push({
        key: 'voice-commands', name: 'Voice commands', group: 'Talking to HomeHub', icon: 'wave', hue: '#e98a5b',
        status: `${voice.understood} of ${voice.total} understood`, words: 'voice commands heard understood missed',
      });
    }

    // Connections
    if (full) {
      const linked: string[] = [];
      if (sum.honeywell?.signedIn) linked.push('Honeywell');
      if (sum.alarm?.signedIn) linked.push('Alarm.com');
      if (sum.meross?.signedIn) linked.push('Meross');
      if (sum.ring && sum.ring.state !== 'signed-out') linked.push('Ring');
      if (this.tuyaCloudReady()) linked.push('Tuya');
      if (this.emailReady()) linked.push('Email');
      if (this.smsReady()) linked.push('Text messages');
      const ringBad = sum.ring?.state === 'expired';
      out.push({
        key: 'integrations', name: 'Integrations', group: 'Connections', icon: 'link', hue: '#4f8cff',
        status: sum.honeywell?.rejected ? 'Honeywell: sign in again' : sum.alarm?.rejected ? 'Alarm.com: sign in again' : ringBad ? 'Ring: sign in again' : linked.length ? linked.join(' · ') : 'Accounts and services',
        look: !!sum.honeywell?.rejected || !!sum.alarm?.rejected || ringBad,
        words: 'integrations account sign in honeywell total connect comfort alarm.com alarm security panel meross ring tuya cloud email smtp sms text twilio cameras ai assistant mcp',
      });
    }
    const push = this.push.state();
    out.push({
      key: 'notifications', name: 'Notifications', group: 'Connections', icon: 'bell', hue: '#f25f5c',
      status: push === 'on' ? 'On for this device' : push === 'blocked' ? 'Blocked on this device' : push === 'off' || push === 'home-screen' ? 'Off on this device' : 'Alerts on this device',
      words: 'notifications push alerts phone',
    });

    out.push({
      key: 'spotify', name: 'Spotify', group: 'Connections', icon: 'music', hue: '#1ed760',
      status: 'Search and play from your Spotify on the speakers',
      words: 'spotify music search playlists liked songs albums sonos connect client id developer',
    });

    // More
    const lock = this.lockService.settings();
    out.push({
      key: 'lock', name: 'Lock HomeHub', group: 'More', icon: 'lock', hue: '#f5b84d',
      status: this.lockService.pinSet() === false ? 'No PIN yet' : lock.auto && lock.away ? (lock.idleMinutes ? `This device: after ${lock.idleMinutes} min away` : 'This device: every time') : 'Off on this device',
      words: 'lock pin passcode privacy phone tablet away security',
    });
    out.push({
      key: 'preferences', name: 'Preferences', group: 'More', icon: 'sliders', hue: '#8e9ab4',
      status: [this.kwhRateDraft ? `$${this.kwhRateDraft}/kWh` : '', this.appVersion()].filter(Boolean).join(' · ') || 'Energy rate and version',
      words: 'preferences energy rate price kwh version server role backup active pause automations',
    });
    return out;
  });

  // Device editing
  editingDeviceId = signal<number | null>(null);
  editAlias    = '';
  editIp       = '';
  editNicknames: string[] = [];
  /** Cantonese, Mandarin and Vietnamese nicknames HomeHub offers, by device id. */
  nicknameSuggestions = signal<Partial<Record<number, NicknameSuggestion[]>>>({});
  editRoom = '';
  deviceSearch = signal('');
  deviceFilter = signal<DeviceFilter>('all');
  deviceBrand = signal('all');
  /** The brand chosen, or all once none of its devices is left. */
  readonly activeBrand = computed(() => {
    const b = this.deviceBrand();
    return b !== 'all' && this.devices().some((d) => brandOf(d) === b) ? b : 'all';
  });
  private readonly camerasState = inject(CamerasStateService);
  private readonly cameraSummary = signal<{ ring: number; ip: number } | null>(null);
  /** "2 Ring cameras and 1 IP camera": not devices, so the list says where they are rather than seem to miss them. */
  readonly otherCameras = computed(() => {
    const c = this.cameraSummary();
    if (!c || !this.camerasState.visible()) return '';
    const parts: string[] = [];
    if (c.ring) parts.push(`${c.ring} Ring camera${c.ring === 1 ? '' : 's'}`);
    if (c.ip) parts.push(`${c.ip} IP camera${c.ip === 1 ? '' : 's'}`);
    return parts.join(' and ');
  });
  editProtected = false;
  /** What the device draws when on, if a person set it; null: typical for its name, or measured. */
  editWatts: number | null = null;
  editAuthUser  = '';
  editAuthPass  = '';
  showAuthPass  = false;
  editKasaUser  = '';
  editKasaPass  = '';
  kasaLoginSaving = signal(false);
  /** The robot vacuum being paired, while HomeHub waits for its Home button. */
  readonly pairingIp = signal<string | null>(null);

  /**
   * Pairs a Roomba: HomeHub asks it for its password while someone holds its
   * Home button, then adds it. The password stays on HomeHub.
   */
  pairRoomba(d: DiscoveredDevice): void {
    this.pairingIp.set(d.ip);
    this.discoverMsg.set('');
    this.http.post<{ id: number; alias: string; updated: boolean }>('/api/roomba/pair', { ip: d.ip, alias: d.pendingAlias?.trim() || d.alias }).subscribe({
      next: (r) => {
        this.pairingIp.set(null);
        this._discoveredDevices.update((list) => list.filter((x) => x !== d));
        this.discoverMsg.set(r.updated ? `${r.alias} paired again.` : `${r.alias} added. It's on the dashboard.`);
        this.discoverErr.set(false);
        this.reloadDevices();
      },
      error: (err: HttpErrorResponse) => {
        this.pairingIp.set(null);
        this.discoverMsg.set(err.error?.error ?? 'Pairing failed. Try again.');
        this.discoverErr.set(true);
      },
    });
  }
  /**
   * Pairs an LG TV: the TV asks on its screen whether to let HomeHub in, someone chooses OK with
   * its remote, and HomeHub adds it. The TV's key stays on HomeHub.
   */
  pairTv(d: DiscoveredDevice): void {
    this.pairingIp.set(d.ip);
    this.discoverMsg.set('');
    this.http.post<{ id: number; alias: string; updated: boolean; canWake: boolean }>('/api/lgtv/pair', { ip: d.ip, alias: d.pendingAlias?.trim() || d.alias }).subscribe({
      next: (r) => {
        this.pairingIp.set(null);
        this._discoveredDevices.update((list) => list.filter((x) => x !== d));
        const wake = r.canWake ? '' : ' It didn’t say how to wake it, so HomeHub can turn it off but not on.';
        this.discoverMsg.set((r.updated ? `${r.alias} paired again.` : `${r.alias} added. It's on the dashboard.`) + wake);
        this.discoverErr.set(false);
        this.reloadDevices();
      },
      error: (err: HttpErrorResponse) => {
        this.pairingIp.set(null);
        this.discoverMsg.set(err.error?.error ?? 'Pairing failed. Try again.');
        this.discoverErr.set(true);
      },
    });
  }
  kasaLoginMsg    = signal('');
  kasaLoginErr    = signal(false);
  editTuyaDeviceId = '';
  editTuyaKey      = '';
  editTuyaVersion  = '3.3';
  deviceMsg = signal('');
  readonly filteredDevices = computed(() =>
    this.devices().filter((d) => matchesDevice(d, this.deviceSearch(), this.deviceFilter(), this.activeBrand())));
  /**
   * Devices by room, like the dashboard, but Unassigned comes first: here it's
   * the list of devices still to set up. Offline devices stay in their room,
   * since they're often the ones being fixed. With no rooms at all, one
   * untitled group.
   */
  readonly deviceGroups = computed(() => {
    const list = this.filteredDevices();
    const rooms = [...new Set(list.flatMap((d) => d.room ?? []))].sort((a, b) => a.localeCompare(b));
    if (!this.devices().some((d) => d.room)) return [{ name: '', devices: list }];
    return [
      { name: 'Unassigned', devices: list.filter((d) => !d.room) },
      ...rooms.map((room) => ({ name: room, devices: list.filter((d) => d.room === room) }))].filter((g) => g.devices.length > 0);
  });
  readonly roomNames = computed(() =>
    [...new Set(this.devices().flatMap((d) => d.room ?? []))].sort((a, b) => a.localeCompare(b)));
  switchingId = signal<number | null>(null);
  private stopWatchingDevices?: () => void;
  private stopWatchingOnline?: () => void;
  protected kasaUsername = '';
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
  /** Found by Probe, kept so Add stores them too. */
  private newDeviceModel: string | null = null;
  private newDeviceMac: string | null = null;
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
  private readonly _movedDevices = signal<DiscoveredDevice[]>([]);
  readonly movedDevices = this._movedDevices.asReadonly();
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

  // ── BYOK notification credentials ─────────────────────────────
  // SMTP / email
  smtpHost      = '';
  smtpPort      = '587';
  smtpSecure    = false;
  smtpUser      = '';
  smtpPass      = '';   // write-only; GET returns has_smtp_pass instead
  smtpFrom      = '';

  /**
   * The address typed in fills in its service's server, when the server is
   * empty or belongs to another known service, and becomes the first
   * recipient if there's none yet. A server someone typed themselves is kept.
   */
  fillFromAddress(): void {
    const address = this.smtpUser.trim();
    const p = providerForAddress(address);
    if (p?.host && (!this.smtpHost.trim() || providerForHost(this.smtpHost))) {
      this.smtpHost = p.host;
      this.smtpPort = String(p.port);
      this.smtpSecure = !!p.secure;
    }
    if (address.includes('@') && !this.emailRecipients.trim()) this.emailRecipients = address;
  }

  /** The known service for the address typed in, or else for the server. */
  mailProvider(): MailProvider | null {
    return providerForAddress(this.smtpUser) ?? providerForHost(this.smtpHost);
  }
  emailRecipients = '';
  showSmtpPass    = false;
  hasSmtpPass     = signal(false);
  emailExpanded   = signal(false);
  emailReady      = signal(false);
  emailMsg        = signal('');
  emailErr        = signal(false);

  // Twilio / SMS
  twilioAccountSid  = '';
  twilioAuthToken   = '';   // write-only; GET returns has_twilio_auth_token
  twilioFrom        = '';
  smsRecipients     = '';
  showTwilioToken   = false;
  hasTwilioToken    = signal(false);
  smsExpanded       = signal(false);
  smsReady          = signal(false);
  smsMsg            = signal('');
  smsErr            = signal(false);

  // Push notifications
  readonly push = inject(PushService);
  readonly pushBusy = signal(false);
  readonly pushMsg = signal('');
  readonly pushErr = signal(false);
  readonly pushHelp = computed(() => PushService.help(this.push.state()));

  // kWh rate
  kwhRateDraft = localStorage.getItem('kwhRate') ?? '0.15';

  private devEdit = viewChild<ElementRef<HTMLElement>>('devEdit');
  private thermostatRanges = viewChild(ThermostatRangesComponent);

  constructor(readonly auth: AuthService, private http: HttpClient, private socket: SocketService, private system: SystemService) {
    // Focus the device editor popup when it opens (not a field, so a phone keyboard
    // doesn't cover it), so Esc closes it.
    effect(() => this.devEdit()?.nativeElement.focus());
  }

  switchDevice(device: Device): void {
    const on = !device.state;
    this.switchingId.set(device.id);
    this.http.post(`/api/devices/${device.id}/${on ? 'on' : 'off'}`, {}).subscribe({
      next: () => {
        this.switchingId.set(null);
        this._devices.update((list) => list.map((d) => d.id === device.id ? { ...d, state: on } : d));
      },
      error: () => {
        this.switchingId.set(null);
        this._devices.update((list) => list.map((d) => d.id === device.id ? { ...d, online: false } : d));
      },
    });
  }

  ngOnDestroy(): void {
    this.stopWatchingDevices?.();
    this.stopWatchingOnline?.();
    document.documentElement.style.overflowAnchor = '';
  }

  ngOnInit(): void {
    // No scroll anchoring on this page: when a section opens and the one above it closes, the page is
    // shorter, and the browser would then scroll again as the new section's content loads (Voice control's
    // settings), pushing its title off the top of the screen.
    document.documentElement.style.overflowAnchor = 'none';
    if (this.route.snapshot.queryParamMap.get('welcome')) {
      this.welcome.set(true);
      this.toggleSection('home', true);
    }
    // The dashboard's "time zone not set" notice links to /settings?section=home. As tiles, the
    // address also says which page is open, and follows the browser's Back and Forward.
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const section = q.get('section');
      if (this.view() === 'tiles') {
        if (section === this.openSection()) return;
        if (!section) this.pagedHere = false;
        this.openSection.set(section);
        window.scrollTo({ top: 0 });
        if (!section) this.loadSummary();
      } else if (section) {
        this.toggleSection(section, true);
      }
    });
    if (this.view() === 'tiles' && !this.route.snapshot.queryParamMap.get('section')) this.loadSummary();
    this.http.get<{ enabled: boolean; ring: number; ip: number }>('/api/cameras/summary').subscribe({
      next: (c) => this.cameraSummary.set(c.enabled ? c : null),
      error: () => undefined,
    });
    this.stopWatchingDevices = this.socket.onDeviceState((event) => {
      this._devices.update((list) => list.map((d) => d.id === event.id ? { ...d, state: event.state } : d));
    });
    this.stopWatchingOnline = this.socket.onDeviceOnline((event) => {
      this._devices.update((list) => list.map((d) => d.id === event.id ? { ...d, online: event.online } : d));
    });
    this.http.get<ChatStats>('/api/nlp/stats').subscribe({ next: (stats) => this.chatStats.set(stats) });
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
    this.system.version().subscribe({ next: (v) => this.appVersion.set(v.running), error: () => undefined });
    if (this.isAdmin()) {
      this.http.get<UserRow[]>('/api/users').subscribe((u) => this._users.set(u));
      this.http.get<{ accessId: string; region: string; hasSecret: boolean }>('/api/tuya/credentials').subscribe((c) => {
        this.tuyaAccessId  = c.accessId;
        this.tuyaRegion    = c.region;
        this.tuyaCloudReady.set(!!c.accessId && c.hasSecret);
      });
      this.http.get<{ username: string | null }>('/api/kasa/login').subscribe((login) => {
        this.kasaUsername = login.username ?? '';
      });
      this.loadNotificationSettings();
    }
  }

  /** A restore can replace devices and users, so fetch both again. */
  reloadAfterRestore(): void {
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
    this.http.get<UserRow[]>('/api/users').subscribe((u) => this._users.set(u));
  }

  private loadNotificationSettings(): void {
    this.http.get<Record<string, string | boolean>>('/api/notifications/settings').subscribe((s) => {
      this.smtpHost        = String(s['smtp_host']        ?? '');
      this.smtpPort        = String(s['smtp_port']        ?? '587');
      this.smtpSecure      = String(s['smtp_secure']      ?? '0') === '1';
      this.smtpUser        = String(s['smtp_user']        ?? '');
      this.smtpFrom        = String(s['smtp_from']        ?? '');
      this.emailRecipients = String(s['email_recipients'] ?? '');
      this.hasSmtpPass.set(!!s['has_smtp_pass']);
      this.emailReady.set(!!this.smtpHost && (!!s['has_smtp_pass'] || !this.smtpUser));

      this.twilioAccountSid = String(s['twilio_account_sid'] ?? '');
      this.twilioFrom       = String(s['twilio_from']        ?? '');
      this.smsRecipients    = String(s['sms_recipients']     ?? '');
      this.hasTwilioToken.set(!!s['has_twilio_auth_token']);
      this.smsReady.set(!!this.twilioAccountSid && !!s['has_twilio_auth_token'] && !!this.twilioFrom);
    });
  }

  /** Counts saves of the email settings, so Backups → Email backups notices straight away. */
  readonly emailSettingsChanged = signal(0);

  saveSmtp(): void {
    this.emailMsg.set(''); this.emailErr.set(false);
    const body: Record<string, string> = {
      smtp_host:        this.smtpHost.trim(),
      smtp_port:        this.smtpPort.trim() || '587',
      smtp_secure:      this.smtpSecure ? '1' : '0',
      smtp_user:        this.smtpUser.trim(),
      smtp_from:        this.smtpFrom.trim(),
      email_recipients: this.emailRecipients.trim(),
    };
    // Only send the password field if the user typed something — otherwise leave it untouched.
    if (this.smtpPass) body['smtp_pass'] = this.smtpPass;

    this.http.put('/api/notifications/settings', body).subscribe({
      next: () => {
        this.emailMsg.set('Saved');
        this.smtpPass = '';
        this.loadNotificationSettings();
        this.emailSettingsChanged.update((n) => n + 1);   // Backups → Email backups checks again
      },
      error: () => { this.emailMsg.set('Save failed'); this.emailErr.set(true); },
    });
  }

  saveTwilio(): void {
    this.smsMsg.set(''); this.smsErr.set(false);
    const body: Record<string, string> = {
      twilio_account_sid: this.twilioAccountSid.trim(),
      twilio_from:        this.twilioFrom.trim(),
      sms_recipients:     this.smsRecipients.trim(),
    };
    if (this.twilioAuthToken) body['twilio_auth_token'] = this.twilioAuthToken;

    this.http.put('/api/notifications/settings', body).subscribe({
      next: () => {
        this.smsMsg.set('Saved');
        this.twilioAuthToken = '';
        this.loadNotificationSettings();
      },
      error: () => { this.smsMsg.set('Save failed'); this.smsErr.set(true); },
    });
  }

  driverLabel(type: string): string {
    return DRIVER_LABEL[type] ?? type;
  }

  async togglePush(): Promise<void> {
    this.pushMsg.set('');
    this.pushBusy.set(true);
    try {
      if (this.push.state() === 'on') {
        await this.push.disable();
        this.pushMsg.set('Notifications are off on this device.');
      } else {
        await this.push.enable();
        this.pushMsg.set('Notifications are on for this device.');
      }
      this.pushErr.set(false);
    } catch (err) {
      this.pushMsg.set(err instanceof Error ? err.message : 'Notifications couldn’t be changed.');
      this.pushErr.set(true);
    } finally {
      this.pushBusy.set(false);
    }
  }

  // ── Device methods ──────────────────────────────────────────

  readonly showMatter = signal(false);

  reloadDevices(): void {
    this.http.get<Device[]>('/api/devices').subscribe((d) => this._devices.set(d));
  }

  /** Matter and Honeywell devices have no network address to show or edit. */
  noAddress(d: Device): boolean {
    return d.driverType === 'matter' || d.driverType === 'honeywell';
  }

  /** "Eve Energy" for a Matter device, which has no address worth showing. */
  matterModel(d: Device): string {
    return d.model && d.model !== 'Matter device' ? `Matter · ${d.model}` : 'Matter';
  }

  /** The other devices' names, so the nickname editor can say which nicknames are shared. */
  otherDevices(id: number): Array<{ alias: string; nicknames: string[] }> {
    return this.devices().filter((x) => x.id !== id);
  }

  startDeviceEdit(d: Device): void {
    this.editingDeviceId.set(d.id);
    this.editAlias    = d.alias;
    this.editIp       = d.ip;
    this.editNicknames = [...d.nicknames];
    this.http.get<{ suggestions: Record<number, NicknameSuggestion[]> }>('/api/devices/nickname-suggestions').subscribe({
      next: (r) => this.nicknameSuggestions.set(r.suggestions ?? {}),
      error: () => this.nicknameSuggestions.set({}),   // only the suggestions are missing
    });
    this.editRoom = d.room ?? '';
    this.editProtected = d.isProtected;
    this.editWatts = d.power?.set ?? null;
    // Pre-fill credentials if already stored
    const auth = (d.driverConfig as any)?.auth;
    this.editAuthUser = auth?.user ?? '';
    this.editAuthPass = '';   // never sent to the browser; blank keeps the saved one
    this.showAuthPass = false;
    this.editKasaUser = this.kasaUsername;
    this.editKasaPass = '';
    this.kasaLoginMsg.set('');
    this.editTuyaDeviceId = '';
    this.editTuyaKey      = '';
    this.editTuyaVersion  = (d.driverConfig as any)?.version ?? '3.3';
    this.deviceMsg.set('');
  }

  hasSavedPassword(d: Device): boolean {
    return d.savedSecrets?.includes('auth.pass') ?? false;
  }

  cancelDeviceEdit(): void {
    this.editingDeviceId.set(null);
    this.editAuthUser = '';
    this.editAuthPass = '';
    this.showAuthPass = false;
    this.editTuyaDeviceId = '';
    this.editTuyaKey      = '';
    this.editTuyaVersion  = '3.3';
    this.deviceMsg.set('');
  }

  usesKasaLogin(d: Device): boolean {
    return d.driverType === 'kasa' && d.driverConfig?.['protocol'] === 'klap';
  }

  /** The plug checks the login before it's saved. Only hashes of it are stored. */
  private saveKasaLogin(username: string, password: string, ip: string, onSaved: () => void, onFailed: (message: string) => void): void {
    this.kasaLoginSaving.set(true);
    // Checked on this plug: plugs can hold different passwords for the same account.
    this.http.put<{ username: string; verified: boolean }>('/api/kasa/login', { username, password, ip }).subscribe({
      next: (login) => {
        this.kasaLoginSaving.set(false);
        this.kasaUsername = login.username;
        onSaved();
      },
      error: (err) => {
        this.kasaLoginSaving.set(false);
        onFailed(err.error?.error ?? 'Could not save the login.');
      },
    });
  }

  saveEditedKasaLogin(): void {
    this.kasaLoginMsg.set('');
    this.saveKasaLogin(this.editKasaUser.trim(), this.editKasaPass, this.editIp.trim(), () => {
      this.editKasaPass = '';
      this.kasaLoginMsg.set('Login saved');
      this.kasaLoginErr.set(false);
    }, (message) => {
      this.kasaLoginMsg.set(message);
      this.kasaLoginErr.set(true);
    });
  }

  saveDiscoveredKasaLogin(d: DiscoveredDevice): void {
    this.saveKasaLogin(d.pendingUser?.trim() ?? '', d.pendingPass ?? '', d.ip, () => this.discover(), (message) => {
      this.discoverMsg.set(message);
      this.discoverErr.set(true);
    });
  }

  saveDevice(id: number, driverType?: string): void {
    const device  = this.devices().find((d) => d.id === id);
    const payload: Record<string, unknown> = {
      alias:     this.editAlias,
      ip:        this.editIp,
      nicknames: this.editNicknames,
      room:      this.editRoom,
    };
    if (this.editProtected !== device?.isProtected) payload['isProtected'] = this.editProtected;
    // Blank goes back to typical for its name, or measured.
    const watts = this.editWatts === null || (this.editWatts as unknown) === '' ? null : Number(this.editWatts);
    if (device?.power && !device.power.excluded && watts !== (device.power.set ?? null)) payload['watts'] = watts;

    // For Shelly/Tuya, merge auth into driverConfig
    if (driverType === 'shelly' || driverType === 'tuya') {
      const baseConfig = { ...(device?.driverConfig ?? {}) } as Record<string, unknown>;
      // HomeHub keeps the saved password when none is sent. Clearing the username removes the login.
      const user = this.editAuthUser.trim();
      const pass = this.editAuthPass.trim();
      if (!user) {
        delete baseConfig['auth'];
      } else if (pass || (device && this.hasSavedPassword(device))) {
        baseConfig['auth'] = pass ? { user, pass } : { user };
      } else {
        this.deviceMsg.set('Enter the password too');
        this.deviceErr.set(true);
        return;
      }
      // Blank deviceId/key preserve existing — clearing them bricks LAN control.
      if (driverType === 'tuya') {
        const newDeviceId = this.editTuyaDeviceId.trim();
        const newKey      = this.editTuyaKey.trim();
        if (newDeviceId) baseConfig['deviceId'] = newDeviceId;
        if (newKey)      baseConfig['key']      = newKey;
        baseConfig['version'] = this.editTuyaVersion;
      }
      payload['driverConfig'] = baseConfig;
    }

    // A thermostat's temperature ranges first: if they don't fit, nothing is saved and it says why.
    const ranges = this.thermostatRanges();
    if (ranges) {
      ranges.save().subscribe({
        next: () => this.patchDevice(id, payload),
        error: (err) => { this.deviceMsg.set(err.error?.error ?? 'The temperatures couldn’t be saved'); this.deviceErr.set(true); },
      });
      return;
    }
    this.patchDevice(id, payload);
  }

  private patchDevice(id: number, payload: Record<string, unknown>): void {
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

  /** Under the power box: where the number comes from, and what blank means. */
  powerHint(d: Device): string {
    const p = d.power;
    if (!p) return '';
    if (p.method === 'measured' && this.editWatts === null) return 'This device measures its own power, so its energy is measured, not estimated.';
    if (p.method === 'typical') return `Blank uses ${p.watts} W, typical for ${p.label}. The bulb or the device's label says the real figure.`;
    if (p.method === 'none' && this.editWatts === null) return "HomeHub doesn't know what this draws, so its energy isn't counted. An LED bulb is about 9 W; for a wall switch, add up its bulbs.";
    return 'For the Energy page. Leave blank to go back to typical for its name.';
  }

  deleteDevice(id: number, alias: string): void {
    if (!confirm(`Delete "${alias}"? This also removes its schedules and history.`)) return;
    this.http.delete(`/api/devices/${id}`).subscribe({
      next: () => this._devices.update((list) => list.filter((d) => d.id !== id)),
    });
  }

  // ── Probe ──────────────────────────────────────────────────

  readonly merossOpenRequest = signal(0);
  readonly appVersion = signal('');
  readonly otherNetworks = viewChild(OtherNetworksComponent);
  readonly unreachedMeross = signal<MerossAccountDevice[]>([]);

  /** After signing in to Meross, finish identifying the device the user was adding. */
  onMerossSignIn(signedIn: boolean): void {
    if (signedIn && this.newDeviceIp.trim()) this.probeIp();
  }

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
        this.newDeviceModel        = result.model ?? null;
        this.newDeviceMac          = result.mac ?? null;
        if (!this.newDeviceAlias.trim()) {
          this.newDeviceAlias = result.alias && result.alias !== ip ? result.alias : '';
        }
        if (result.needsLogin && result.driverType === 'meross') {
          this.probeMsg.set('Found a Meross device. Sign in to Meross under Integrations (opened below), then open Devices again and select Probe.');
          this.probeErr.set(true);
          this.toggleSection('integrations', true);
          this.merossOpenRequest.update((n) => n + 1);
          return;
        }
        // A TV is paired, not added: it goes in the list below with its Pair button.
        if (result.driverType === 'lgtv') {
          const found = { ...result, pendingAlias: this.newDeviceAlias.trim() || result.alias } as DiscoveredDevice;
          this._discoveredDevices.update((list) => [found, ...list.filter((x) => x.ip !== found.ip)]);
          this.probeMsg.set('Found an LG TV. Pair it below.');
          return;
        }
        this.probeMsg.set(`Detected: ${result.model ?? result.driverType} (${this.driverLabel(result.driverType)})`);
      },
      error: () => {
        this.probing.set(false);
        this.newDeviceDriverType   = 'kasa';
        this.newDeviceDriverConfig = null;
        this.newDeviceModel        = null;
        this.newDeviceMac          = null;
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
    this._movedDevices.set([]);
    this.selectedIps.clear();
    this.http.post<DiscoveredDevice[]>('/api/devices/discover', {}).subscribe({
      next: (found) => {
        this.discovering.set(false);
        if (found.length === 0) {
          this.discoverMsg.set('No new devices found. If a device is on another Wi-Fi network, add that network below.');
          this.discoverErr.set(false);
          this.checkMerossAccount([]);
          return;
        }
        this.checkMerossAccount(found);
        const moved       = found.filter((f) => f.moved);
        const byIp        = new Map(this._devices().map((d) => [d.ip, d]));
        // Saved at this address: hidden, unless what's saved there is another kind of device that isn't
        // answering. That one moved, and its old address went to this one, so it's shown with a note.
        const staleOwner  = (f: DiscoveredDevice) => {
          const d = byIp.get(f.ip);
          return d && d.driverType !== f.driverType && !d.online ? d.alias : undefined;
        };
        const newDevices  = found
          .filter((f) => !f.moved && (!byIp.has(f.ip) || staleOwner(f)))
          .map((f) => ({
            ...f,
            staleOwner: staleOwner(f),
            pendingAlias: f.alias && f.alias !== f.ip ? f.alias : '',
            // A Kasa plug that refused the saved login: start from the saved email, so only the password is typed.
            ...(f.needsLogin && f.driverType === 'kasa' && this.kasaUsername ? { pendingUser: this.kasaUsername } : {}),
          }));
        this._movedDevices.set(moved);
        if (moved.length === 0 && newDevices.length === 0) {
          this.discoverMsg.set(`Found ${found.length} device(s) — all already registered.`);
          this.discoverErr.set(false);
          return;
        }
        // Pre-select devices that are ready: Tuya needs a key, and Meross a sign-in, first
        newDevices.filter((d) => d.driverType !== 'tuya' && d.driverType !== 'roomba' && d.driverType !== 'lgtv' && !(d.driverType === 'meross' && d.needsLogin))
          .forEach((d) => this.selectedIps.add(d.ip));
        this._discoveredDevices.set(newDevices);
        this.discoverMsg.set([
          moved.length ? `${moved.length} device(s) changed address.` : '',
          newDevices.length ? `Found ${newDevices.length} new device(s). Review and register below.` : ''].join(' ').trim());
        this.discoverErr.set(false);
      },
      error: () => { this.discovering.set(false); this.discoverMsg.set('Discovery failed.'); this.discoverErr.set(true); },
    });
  }

  /**
   * Openers on the Meross account that are neither registered nor found by
   * this search: probably on a network HomeHub doesn't search yet.
   */
  private checkMerossAccount(found: DiscoveredDevice[]): void {
    this.unreachedMeross.set([]);
    if (!this.isAdmin()) return;
    const foundUuids = new Set(found.map((f) => f.driverConfig?.['uuid']).filter(Boolean));
    this.http.get<MerossAccountDevice[]>('/api/meross/devices').subscribe({
      next: (list) => this.unreachedMeross.set(list.filter((m) => !m.registered && !foundUuids.has(m.uuid))),
      error: () => this.unreachedMeross.set([]),
    });
  }

  applyMove(d: DiscoveredDevice): void {
    if (!d.moved) return;
    this.http.patch<Device>(`/api/devices/${d.moved.deviceId}`, { ip: d.ip, mac: d.mac }).subscribe({
      next: (updated) => {
        this._devices.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        this._movedDevices.update((list) => list.filter((x) => x !== d));
        this.discoverMsg.set(`${updated.alias} updated to ${updated.ip}.`);
        this.discoverErr.set(false);
      },
      error: (err: HttpErrorResponse) => {
        this.discoverMsg.set(err.error?.error ?? 'Could not update the address.');
        this.discoverErr.set(true);
      },
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
      if (d.driverType === 'shelly' && d.pendingUser?.trim() && d.pendingPass) {
        driverConfig = { ...driverConfig, auth: { user: d.pendingUser.trim(), pass: d.pendingPass } };
      }

      this.http.post<Device>('/api/devices', {
        alias:        (d.pendingAlias || d.ip).trim(),
        ip:           d.ip,
        model:        d.model ?? null,
        hasEmeter:    d.hasEmeter ?? false,
        driverType:   d.driverType,
        driverConfig: driverConfig ?? undefined,
        mac:          d.mac,
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
      model:        this.newDeviceModel ?? undefined,
      mac:          this.newDeviceMac ?? undefined,
    }).subscribe({
      next: (created) => {
        this._devices.update((list) => [...list, created]);
        this.newDeviceAlias       = '';
        this.newDeviceIp          = '';
        this.newDeviceDriverType  = 'kasa';
        this.newDeviceDriverConfig = null;
        this.newDeviceModel        = null;
        this.newDeviceMac          = null;
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
