import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppNavComponent } from './core/nav/app-nav.component';
import { AuthService } from './core/auth/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, AppNavComponent],
  styles: [`
    /* Room for the phone tab bar, so it never covers the end of a page. */
    @media (max-width: 899px) {
      .tab-space { padding-bottom: calc(3.6rem + env(safe-area-inset-bottom, 0px)); }
    }
  `],
  template: `
    <app-nav />
    <div [class.tab-space]="auth.isLoggedIn()">
      <router-outlet />
    </div>
  `,
})
export class AppComponent {
  readonly auth = inject(AuthService);
}
