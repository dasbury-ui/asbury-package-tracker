/**
 * Service worker: offline shell + Web Push handling.
 *
 * Deliberately does NOT cache the data files. A stale package status shown as
 * if it were current is exactly the failure mode this system exists to avoid,
 * so data is always fetched from the network and the app shows its true age.
 */

const SHELL = 'asbury-shell-v1';
const SHELL_FILES = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never serve data from cache.
  if (url.pathname.includes('/data/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let data = { title: 'Packages', body: 'Something changed.' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    tag: data.tag || 'asbury-packages',
    renotify: true,
    badge: 'icons/icon-192.png',
    icon: 'icons/icon-192.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
