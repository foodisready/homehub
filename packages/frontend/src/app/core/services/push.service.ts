import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Where this browser stands with HomeHub's notifications:
 * - on / off: it can have them, and does or doesn't
 * - home-screen: an iPhone or iPad, which only allows them once HomeHub is added to the Home Screen
 * - blocked: the person said no when the browser asked, so only the browser's settings can undo it
 * - unsupported: this browser can't have them at all
 * - checking: not known yet
 */
export type PushState = 'checking' | 'on' | 'off' | 'home-screen' | 'blocked' | 'unsupported';

const isAppleMobile = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

/** Whether a subscription's key (bytes) is the server's key (base64url). */
function sameKey(bytes: ArrayBuffer | null, key: string): boolean {
  if (!bytes) return true;   // the browser doesn't say: assume it's fine
  const b64 = btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64 === key.replace(/=+$/, '');
}

/** A service worker that's registered, or null after a few seconds (none is registered on localhost). */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
  ]);
}

/** Turns HomeHub's notifications on and off for this browser, for Settings and the Family page. */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly http = inject(HttpClient);
  readonly state = signal<PushState>('checking');

  constructor() { void this.refresh(); }

  async refresh(): Promise<void> {
    this.state.set(await this.check());
  }

  private async check(): Promise<PushState> {
    if (!('PushManager' in window) || !('Notification' in window)) {
      return isAppleMobile() && !isStandalone() ? 'home-screen' : 'unsupported';
    }
    if (Notification.permission === 'denied') return 'blocked';
    const reg = await worker();
    if (!reg) return 'unsupported';
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      try {
        // Signed up with another key (HomeHub restored onto another computer makes new ones):
        // HomeHub's notifications would never arrive, so sign up again with the current key.
        const { key } = await firstValueFrom(this.http.get<{ key: string }>('/api/push/vapid-public-key'));
        if (!sameKey(sub.options.applicationServerKey, key) && Notification.permission === 'granted') {
          await sub.unsubscribe();
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
        // Tell HomeHub again: it may have dropped a subscription the phone still has (after a restore,
        // or one that failed once), and this keeps it under whoever is signed in now.
        const json = sub.toJSON();
        await firstValueFrom(this.http.post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys }));
      } catch { /* offline, or HomeHub can't send push: the browser still has its sign-up */ }
    }
    return sub ? 'on' : 'off';
  }

  /** Asks the browser, then signs this browser up with HomeHub. Throws a message to show if it can't. */
  async enable(): Promise<void> {
    const reg = await worker();
    if (!reg) throw new Error('This browser can’t get notifications.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      this.state.set(permission === 'denied' ? 'blocked' : 'off');
      throw new Error(permission === 'denied' ? 'Notifications are blocked for HomeHub in this browser.' : 'Notifications weren’t allowed.');
    }
    const { key } = await firstValueFrom(this.http.get<{ key: string }>('/api/push/vapid-public-key'));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    await firstValueFrom(this.http.post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys }));
    this.state.set('on');
  }

  async disable(): Promise<void> {
    const reg = await worker();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await firstValueFrom(this.http.delete('/api/push/subscribe', { body: { endpoint: sub.endpoint } })).catch(() => undefined);
      await sub.unsubscribe();
    }
    this.state.set('off');
  }

  /** What to tell someone whose browser can't simply turn them on, or null when it can. */
  static help(state: PushState): string | null {
    switch (state) {
      case 'home-screen': return 'On an iPhone or iPad, add HomeHub to the Home Screen first (Share → Add to Home Screen), open it from there, then turn notifications on.';
      case 'blocked': return 'Notifications are blocked for HomeHub in this browser. Allow them in the browser’s site settings (the icon next to the address), then come back.';
      case 'unsupported': return 'This browser can’t get notifications. Try Chrome on Android, or Safari from the Home Screen on an iPhone.';
      default: return null;
    }
  }
}
