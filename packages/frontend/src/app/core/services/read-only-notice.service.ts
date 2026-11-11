import { Injectable, signal } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';

/**
 * A backup HomeHub is read-only (the backend refuses changes with
 * BACKUP_READ_ONLY). Pages hide most edit controls on a backup; this catches
 * the rest, so a refused change is always explained, whichever page made it.
 */
@Injectable({ providedIn: 'root' })
export class ReadOnlyNotice {
  readonly message = signal('');
  private timer?: ReturnType<typeof setTimeout>;

  show(text: string): void {
    this.message.set(text);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.message.set(''), 10_000);
  }
}

export const readOnlyInterceptor: HttpInterceptorFn = (req, next) => {
  const notice = inject(ReadOnlyNotice);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 409 && err.error?.code === 'BACKUP_READ_ONLY') {
        notice.show(err.error.error);
      }
      return throwError(() => err);
    }),
  );
};
