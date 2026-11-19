// HomeHub service worker — app shell cache + push notifications
const CACHE    = 'homehub-v4';
const APP_SHELL = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const { title, body, data } = event.data.json();
  // A call for help or a missed check-in stays on screen until it's dealt with, and buzzes longer.
  const urgent = !!(data && data.urgent);
  const tag = data && typeof data.tag === 'string' ? data.tag : 'homehub-sos';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/icons/icon.svg',
      badge: '/icons/icon.svg',
      data,
      vibrate: urgent ? [500, 200, 500, 200, 500] : [200, 100, 200],
      requireInteraction: urgent,
      ...(urgent ? { tag, renotify: true } : {}),
    })
  );
});

// Opens the page the notification is about (a check-in opens Family), in a HomeHub window
// that's already open if there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = event.notification.data && typeof event.notification.data.url === 'string' && event.notification.data.url.startsWith('/')
    ? event.notification.data.url : '/dashboard';
  event.waitUntil((async () => {
    const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (here) {
      await here.focus();
      return here.navigate(wanted).catch(() => clients.openWindow(wanted));
    }
    return clients.openWindow(wanted);
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Always fetch API, socket.io, and cross-origin resources from network
  if (event.request.method !== 'GET' ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.origin !== self.location.origin) {
    return;
  }

  // Network first, so updates appear straight away. The cache is only the
  // offline fallback: serving it first would pin the app to an old version.
  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      const shell = event.request.mode === 'navigate' ? await caches.match('/') : undefined;
      return shell ?? Response.error();
    })
  );
});
