// Minimal service worker: makes Reverie installable and keeps the app shell
// available while the server restarts. Network-first; API calls are never cached.
const CACHE = 'reverie-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname.startsWith('/scripts/') || url.pathname.startsWith('/st-shim/')) return;
    event.respondWith(
        fetch(event.request)
            .then(res => {
                if (res.ok && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE).then(c => c.put(event.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(event.request)),
    );
});
