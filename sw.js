const CACHE = 'pace01-v2.2.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './adaptive-engine.js',
  './coach-engine.js',
  './manifest.webmanifest',
  './hero-runner.jpg',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // JS/CSS/HTML: red primero para no quedar atrapados en un beep roto.
  const networkFirst = /\.(?:js|css|html|webmanifest)$/.test(url.pathname)
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('/index.html');

  if (networkFirst) {
    event.respondWith(
      fetch(event.request).then(response => {
        if (response && response.ok && response.type !== 'opaque') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => caches.match(event.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(hit => {
      if (hit) return hit;
      return fetch(event.request).then(response => {
        if (!response || !response.ok || response.type === 'opaque') return response;
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
