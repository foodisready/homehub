import { ApplicationConfig, provideZoneChangeDetection, APP_INITIALIZER } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { readOnlyInterceptor } from './core/services/read-only-notice.service';
import { AuthService } from './core/auth/auth.service';
import { SocketService } from './core/socket/socket.service';

function initAuth(auth: AuthService, socket: SocketService) {
  return () => auth.refresh().toPromise()
    .then(() => { if (auth.isLoggedIn()) socket.connect(); })
    .catch(() => null);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor, readOnlyInterceptor])),
    {
      provide: APP_INITIALIZER,
      useFactory: initAuth,
      deps: [AuthService, SocketService],
      multi: true,
    },
  ],
};
