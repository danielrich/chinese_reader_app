/// <reference lib="webworker" />
// NOTE: Service workers require HTTPS (or localhost) in most browsers.
// On Android Chrome over a LAN IP (e.g. 192.168.x.x), registration may
// silently fail. Workarounds: use mkcert+nginx with a trusted cert, a
// *.local mDNS hostname, or enable chrome://flags/#unsafely-treat-insecure-origin-as-secure
// for your dev IP during testing.
declare const self: ServiceWorkerGlobalScope;

const SHELL_CACHE = "shell-v1";
const API_CACHE = "api-v1";

const SHELL_FILES = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => ![SHELL_CACHE, API_CACHE].includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // API: network-first, cache fallback
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Shell + assets: cache-first
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Last resort: return cached index.html for SPA navigations
    if (request.mode === "navigate") {
      const fallback = await cache.match("/index.html");
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && request.method === "GET") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
