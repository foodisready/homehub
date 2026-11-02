import { Component, OnInit, signal, inject, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NotificationHistoryService, type DispatchRow, type HistoryQuery } from '../../core/services/notification-history.service';

/**
 * Audit feed of notification dispatches — what fired, when, to whom,
 * which channel, and whether the user acked it.
 */
@Component({
  selector: 'app-notifications',
  standalone: true,
  imports: [RouterLink, DatePipe, FormsModule],
  styles: [`
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .topbar h1 { font-size: 1.4rem; font-weight: 700; }
    .back-link { color: var(--text-muted); font-size: 0.9rem; }
    .back-link:hover { color: var(--text); }

    .filters { display: flex; gap: 0.6rem; align-items: end; flex-wrap: wrap; margin-bottom: 1rem; }
    .filter-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .filter-field label { font-size: 0.75rem; color: var(--text-muted); }
    .filter-field select, .filter-field input {
      background: var(--surface); border: 1px solid var(--border); color: var(--text);
      padding: 0.35rem 0.6rem; border-radius: 6px; font-size: 0.9rem;
    }
    .btn { font-size: 0.85rem; padding: 0.4rem 0.85rem; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
    .btn:hover { border-color: var(--accent); }

    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--border); }
    th { font-weight: 600; color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    a.sensor-link { color: var(--accent); text-decoration: none; }
    a.sensor-link:hover { text-decoration: underline; }

    .pill {
      font-size: 0.7rem; padding: 0.15rem 0.55rem; border-radius: 999px; font-weight: 600;
      display: inline-block;
    }
    .pill.l1 { background: #1e40af; color: #fff; }
    .pill.l2 { background: #b45309; color: #fff; }
    .pill.l3 { background: #b91c1c; color: #fff; }

    .channel-pill {
      font-size: 0.72rem; padding: 0.15rem 0.55rem; border-radius: 4px;
      background: var(--surface); border: 1px solid var(--border); color: var(--text-muted);
      display: inline-block;
    }
    .channel-pill.push  { color: #60a5fa; border-color: #60a5fa; }
    .channel-pill.email { color: #a78bfa; border-color: #a78bfa; }
    .channel-pill.sms   { color: #4ade80; border-color: #4ade80; }
    .channel-pill.voice { color: #f87171; border-color: #f87171; }

    .ack-yes { color: #4ade80; }
    .ack-no  { color: var(--text-muted); }

    .empty { text-align: center; padding: 3rem 1rem; color: var(--text-muted); }
  `],
  template: `
    <div class="page">
      <div class="topbar">
        <div style="display:flex;align-items:center;gap:1rem">
          <h1>Notifications</h1>
        </div>
        <button class="btn" (click)="refresh()">Refresh</button>
      </div>

      <div class="filters">
        <div class="filter-field">
          <label for="ch">Channel</label>
          <select id="ch" [(ngModel)]="channel" (ngModelChange)="refresh()">
            <option [ngValue]="null">All channels</option>
            <option value="push">Push</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="voice">Voice</option>
          </select>
        </div>
        <div class="filter-field">
          <label for="lvl">Level</label>
          <select id="lvl" [(ngModel)]="level" (ngModelChange)="refresh()">
            <option [ngValue]="null">All levels</option>
            <option [ngValue]="1">L1 — flowing</option>
            <option [ngValue]="2">L2 — 30+ min</option>
            <option [ngValue]="3">L3 — possible leak</option>
          </select>
        </div>
        <div class="filter-field">
          <label for="lim">Limit</label>
          <select id="lim" [(ngModel)]="limit" (ngModelChange)="refresh()">
            <option [ngValue]="50">50</option>
            <option [ngValue]="100">100</option>
            <option [ngValue]="250">250</option>
            <option [ngValue]="500">500</option>
          </select>
        </div>
      </div>

      @if (loading()) {
        <div class="empty">Loading…</div>
      } @else if (rows().length === 0) {
        <div class="empty">
          No dispatches yet.
          <p style="font-size:0.85rem;margin-top:0.5rem">
            Once a sensor crosses an alert threshold, every push/email/SMS will land here.
          </p>
        </div>
      } @else {
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Sensor</th>
              <th>Level</th>
              <th>Channel</th>
              <th>To</th>
              <th>Acked</th>
            </tr>
          </thead>
          <tbody>
            @for (d of rows(); track d.id) {
              <tr>
                <td>{{ d.sentAt | date:'short' }}</td>
                <td>
                  @if (d.sensorId) {
                    <a class="sensor-link" [routerLink]="['/sensors', d.sensorId]">{{ d.sensorAlias }}</a>
                  } @else {
                    <span style="color:var(--text-muted)">— deleted —</span>
                  }
                </td>
                <td><span class="pill" [class]="'pill l' + d.level">L{{ d.level }}</span></td>
                <td><span class="channel-pill" [class]="'channel-pill ' + d.channel">{{ d.channel }}</span></td>
                <td>{{ d.userName ?? '— system —' }}</td>
                <td>
                  @if (d.ackedAt) {
                    <span class="ack-yes">✓ {{ d.ackedAt | date:'short' }}</span>
                  } @else {
                    <span class="ack-no">—</span>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class NotificationsComponent implements OnInit {
  private svc = inject(NotificationHistoryService);

  loading = signal(true);
  rows    = signal<DispatchRow[]>([]);

  channel: 'push' | 'email' | 'sms' | 'voice' | null = null;
  level:   1 | 2 | 3 | null = null;
  limit = 100;

  ngOnInit() {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    const q: HistoryQuery = { limit: this.limit };
    if (this.channel) q.channel = this.channel;
    if (this.level !== null) q.level = this.level;

    this.svc.list(q).subscribe({
      next: (rs) => { this.rows.set(rs); this.loading.set(false); },
      error: ()   => { this.loading.set(false); },
    });
  }
}
