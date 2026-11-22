import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth   = inject(AuthService);
  const router = inject(Router);

  if (auth.isLoggedIn()) return true;

  // Back to this page once signed in (login.component's next()).
  router.navigate(['/login'], { queryParams: state.url && state.url !== '/' ? { next: state.url } : {} });
  return false;
};
