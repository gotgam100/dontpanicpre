/* Don't Panic Pre — service worker
 * Strategy:
 *   - App shell precache (HTML/CSS/JS/icons).
 *   - HTML: network-first, fall back to cached index.html offline.
 *   - Same-origin static assets: stale-while-revalidate.
 *   - Everything else (Firebase, Google Fonts, gstatic): pass through.
 *     Firebase SDK manages its own offline cache via IndexedDB.
 */

const VERSION = "v152-2026-05-28-insert-scene-stable-num";
const SHELL_CACHE  = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./about.html",
  "./assets/app.css",
  "./assets/responsive.css",
  "./assets/app.js",
  "./assets/responsive.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-512-maskable.png",
  "./assets/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Pass-through: Firebase, Google Fonts, gstatic, anything non-http(s).
  const passthroughHosts = [
    "firestore.googleapis.com",
    "firebaseinstallations.googleapis.com",
    "identitytoolkit.googleapis.com",
    "securetoken.googleapis.com",
    "www.googleapis.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "www.gstatic.com",
  ];
  if (passthroughHosts.includes(url.hostname)) return;

  // Only handle same-origin from here.
  if (url.origin !== self.location.origin) return;

  // HTML navigations: network-first.
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
