/// <reference lib="webworker" />
// NOTE: Service workers require HTTPS (or localhost) in most browsers.
// On Android Chrome over a LAN IP (e.g. 192.168.x.x), registration may
// silently fail. Workarounds: use mkcert+nginx with a trusted cert, a
// *.local mDNS hostname, or enable chrome://flags/#unsafely-treat-insecure-origin-as-secure
// for your dev IP during testing.
declare const self: ServiceWorkerGlobalScope;

const SHELL_CACHE = "shell-v2";
const API_CACHE = "api-v1";
const TEXT_CACHE = "text-v1";

const SHELL_FILES = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_FILES);
      await cacheLinkedShellAssets(cache);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => ![SHELL_CACHE, API_CACHE, TEXT_CACHE].includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Same-origin only
  if (url.origin !== self.location.origin) return;

  // Text content + vocab-cache: cache-first in dedicated TEXT_CACHE
  if (url.pathname.startsWith("/api/texts/")) {
    event.respondWith(cacheFirstText(event.request));
    return;
  }

  // Other API routes: network-first, cache fallback
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Shell + assets: cache-first
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirstText(request: Request): Promise<Response> {
  const cache = await caches.open(TEXT_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && request.method === "GET") {
    cache.put(request, response.clone());
  }
  return response;
}

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

async function cacheLinkedShellAssets(cache: Cache): Promise<void> {
  const indexResponse = await cache.match("/index.html") ?? await cache.match("/");
  if (!indexResponse) return;

  const html = await indexResponse.clone().text();
  const assetUrls = new Set<string>();
  const attrPattern = /\s(?:src|href)=["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = attrPattern.exec(html)) !== null) {
    const rawUrl = match[1];
    if (!rawUrl || rawUrl.startsWith("http:") || rawUrl.startsWith("https:") || rawUrl.startsWith("data:")) {
      continue;
    }
    const url = new URL(rawUrl, self.location.origin);
    if (url.origin === self.location.origin) {
      assetUrls.add(url.pathname);
    }
  }

  await Promise.all(
    [...assetUrls].map(async (url) => {
      try {
        const response = await fetch(url, { cache: "reload" });
        if (response.ok) {
          await cache.put(url, response);
        }
      } catch (err) {
        console.warn("Failed to cache shell asset:", url, err);
      }
    }),
  );
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
