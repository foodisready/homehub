import { Component, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { AutomationsService, ServerRole } from '../../core/services/automations.service';

const CHOICES: { role: ServerRole; label: string; sub: string }[] = [
  { role: 'active', label: 'Active', sub: 'Runs everything: schedules, motion lights, timers, water shutoff, voice and cameras. Only one HomeHub should be active.' },
  { role: 'backup', label: 'Backup', sub: "A standby copy, ready to take over. It doesn't run automations, voice or cameras, and answers to homehub-backup.local." },
  { role: 'dev', label: 'Development', sub: 'For a development copy that shares your devices. Like a backup, it leaves everything to the active HomeHub.' },
];

/** Settings → Preferences → This server: active, backup or development. Admin only. */
@Component({
  selector: 'app-server-role',
  standalone: true,
  styles: [`
    :host { display:block; padding:0.65rem 0; border-bottom:1px solid var(--border); }
    .pref-label { font-size:0.9rem; }
    .pref-sub { font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem; }
    .choices { display:flex; flex-direction:column; gap:0.4rem; margin-top:0.5rem; }
    .choice {
      display:flex; gap:0.6rem; align-items:flex-start; text-align:left; width:100%;
      padding:0.55rem 0.7rem; border:1px solid var(--border); border-radius:var(--radius);
      background:transparent; color:var(--text); cursor:pointer;
    }
    .choice:hover:not(:disabled) { background:var(--surface); }
    .choice.on { border-color:var(--accent); }
    .choice:disabled { cursor:default; opacity:0.6; }
    .dot { width:0.9rem; height:0.9rem; border-radius:50%; border:2px solid var(--text-muted); flex:none; margin-top:0.15rem; }
    .choice.on .dot { border-color:var(--accent); background:radial-gradient(var(--accent) 45%, transparent 50%); }
    .label { font-size:0.9rem; }
    .sub { font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem; line-height:1.4; }
    .confirm {
      margin-top:0.5rem; padding:0.6rem 0.75rem; border:1px solid var(--red); border-radius:var(--radius);
      font-size:0.85rem; display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;
    }
    .confirm span { flex:1; min-width:12rem; line-height:1.45; }
    .btn-sm { padding:0.3rem 0.75rem; font-size:0.8rem; }
    .btn-ghost { background:transparent; border:1px solid var(--border); color:var(--text-muted); }
    .btn-red { background:var(--red); border:1px solid var(--red); color:#fff; }
    .note { font-size:0.8rem; color:var(--text-muted); margin:0.45rem 0 0; line-height:1.45; }
    .msg { font-size:0.82rem; margin-top:0.4rem; }
    .msg.ok { color:var(--green); }
    .msg.err { color:var(--red); }
  `],
  template: `
    <div class="pref-label">
      This server
      <div class="pref-sub">For a home with more than one HomeHub, such as a backup computer ready to take over.</div>
    </div>
    @if (status(); as s) {
      <div class="choices" role="radiogroup" aria-label="This server's role">
        @for (c of choices; track c.role) {
          <button type="button" class="choice" role="radio" [class.on]="s.role === c.role" [attr.aria-checked]="s.role === c.role"
                  [disabled]="busy()" (click)="choose(c.role)">
            <span class="dot" aria-hidden="true"></span>
            <span><div class="label">{{ c.label }}</div><div class="sub">{{ c.sub }}</div></span>
          </button>
        }
      </div>

      @if (pending(); as p) {
        <div class="confirm">
          <span>{{ warning(p) }}</span>
          <button type="button" class="btn-sm btn-red" (click)="apply(p)" [disabled]="busy()">{{ buttonText(p) }}</button>
          <button type="button" class="btn-sm btn-ghost" (click)="pending.set(null)">Cancel</button>
        </div>
      }

      @if (s.other && s.role === 'active') {
        <p class="msg err">
          The HomeHub at {{ s.other.address }} also answers as the active one. Make one of them a backup, or both may run your schedules.
        </p>
      } @else if (s.other) {
        <p class="note">The active HomeHub on your network is at {{ s.other.address }}.</p>
      }
      @if (message()) { <p class="msg" [class.ok]="!isError()" [class.err]="isError()">{{ message() }}</p> }
    }
  `,
})
export class ServerRoleComponent {
  private readonly automations = inject(AutomationsService);
  readonly choices = CHOICES;
  readonly status = computed(() => this.automations.role());
  readonly pending = signal<ServerRole | null>(null);
  readonly busy = signal(false);
  readonly message = signal('');
  readonly isError = signal(false);

  labelOf(role: ServerRole): string {
    return role === 'dev' ? 'development' : role;
  }

  choose(role: ServerRole): void {
    this.message.set('');
    this.pending.set(role === this.status()?.role ? null : role);
  }

  warning(role: ServerRole): string {
    if (role === 'active') {
      const other = this.status()?.other;
      return other
        ? `The HomeHub at ${other.address} still answers as the active one. Make it a backup first, or both will run your schedules and fight over the cameras and voice speakers.`
        : 'Make sure no other HomeHub is active, or both will run your schedules. This HomeHub starts its schedules, motion lights, timers, water shutoff, voice and cameras now.';
    }
    const name = role === 'dev' ? 'homehub-dev.local' : 'homehub-backup.local';
    if (this.status()?.role !== 'active') {
      return `This HomeHub keeps leaving everything to the active one, and answers to ${name}.`;
    }
    return `Schedules, motion lights, timers, automatic water shutoff, voice and cameras stop on this HomeHub straight away. Another HomeHub needs to be active to run them. You can still open this one and switch devices by hand.`;
  }

  buttonText(role: ServerRole): string {
    return role === 'active' ? 'Make it active' : role === 'backup' ? 'Make it a backup' : 'Make it a development copy';
  }

  apply(role: ServerRole): void {
    this.busy.set(true);
    this.automations.setRole(role).subscribe({
      next: (s) => {
        this.busy.set(false);
        this.pending.set(null);
        this.isError.set(false);
        this.message.set(s.role === 'active'
          ? 'This HomeHub is now the active one. Voice and cameras take a minute to start.'
          : `This HomeHub is now a ${this.labelOf(s.role)} server.`);
      },
      error: (err) => {
        this.busy.set(false);
        this.isError.set(true);
        this.message.set(err instanceof HttpErrorResponse ? err.error?.error ?? err.message : String(err));
      },
    });
  }
}
