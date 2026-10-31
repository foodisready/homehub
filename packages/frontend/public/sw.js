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
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  '/icons/icon.svg',
      badge: '/icons/icon.svg',
      data,
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/dashboard'));
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
