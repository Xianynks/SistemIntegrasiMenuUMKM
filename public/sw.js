// Service worker: shell aplikasi tersedia saat offline. API tidak pernah di-cache,
// jadi pesanan dan pembayaran selalu butuh koneksi.
const V = 'umkm-shell-v1';
const SHELL = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(r).then((res) => { const copy = res.clone(); caches.open(V).then((c) => c.put(r, copy)); return res; })
      .catch(() => caches.match(r).then((m) => m || caches.match('/')))
  );
});
