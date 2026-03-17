import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));

// Register service worker for PWA / offline shell caching — skip in dev
if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('/sw.js').catch(() => {/* non-critical */});
}
