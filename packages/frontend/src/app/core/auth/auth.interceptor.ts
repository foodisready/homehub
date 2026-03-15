import { HttpInterceptorFn, HttpRequest, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

function withBearer(req: HttpRequest<unknown>, token: string | null): HttpRequest<unknown> {
  return token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth   = inject(AuthService);
  const router = inject(Router);

  return next(withBearer(req, auth.accessToken())).pipe(
    catchError((err: HttpErrorResponse) => {
      // Don't try to refresh on auth endpoints or non-401 errors
      if (err.status !== 401 || req.url.includes('/api/auth')) {
        return throwError(() => err);
      }

      return auth.refresh().pipe(
        switchMap((newToken) => next(withBearer(req, newToken))),
        catchError((refreshErr) => {
          auth.clear();
          router.navigate(['/login']);
          return throwError(() => refreshErr);
        }),
      );
    }),
  );
};
