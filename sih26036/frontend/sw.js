// frontend/sw.js
// Cache-first for the app shell only. /api/* is deliberately never cached —
// those requests must hit the real server or fail visibly, so app.js can
// decide to queue them in IndexedDB (see idb-queue.js) rather than the
// service worker silently serving stale data for a write operation.

const CACHE_NAME = 'setu-shell-v2';
const SHELL_FILES = ['/', '/index.html', '/styles.css', '/app.js', '/idb-queue.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return; // never intercept API calls
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
