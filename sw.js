// sw.js — service worker. Caches the app shell + food data so the whole text
// path works with no network (PLAN.md §Phase 3). Bump CACHE to force an update.
const CACHE = "foodlog-v11";
const ASSETS = [
  "./", "./index.html", "./style.css",
  "./config.js", "./resolver.js", "./storage.js", "./drive.js", "./app.js",
  "./manifest.webmanifest",
  "./data/foods.json", "./data/targets.json",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for our own assets; network fallback keeps data fresh when online.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Only ever handle our own assets. Google sign-in and Drive API calls must go
  // straight to the network, never through this cache.
  if (url.origin !== self.location.origin) return;

  // Data files (food list, targets): network-FIRST, so foods added on the laptop
  // show up as soon as the phone is online. Cache is only the offline fallback.
  if (url.pathname.includes("/data/")) {
    e.respondWith(
      fetch(url.pathname, { cache: "no-store" })
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell (html/js/css): cache-FIRST for instant, offline-capable loads.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match("./index.html"))
    )
  );
});
