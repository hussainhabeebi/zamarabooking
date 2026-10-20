// FlyPoomas agent portal service worker: makes the portal installable and keeps
// the app shell available on weak connections. API calls always go to the network.
const CACHE = "fp-agent-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/logo.png"]))); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/logo.png") {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
    })));
    return;
  }
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((hit) => hit || new Response("<h2 style='font-family:sans-serif;padding:24px'>You're offline. Reconnect to use the FlyPoomas agent portal.</h2>", { headers: { "Content-Type": "text/html" } }))));
  }
});
