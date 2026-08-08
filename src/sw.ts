/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

declare const __BUILD_ID__: string;
declare const __SHELL_MANIFEST__: string[];

const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
const SHELL_MANIFEST = Array.isArray(__SHELL_MANIFEST__) ? __SHELL_MANIFEST__ : ["/index.html"];

const SHELL_CACHE_PREFIX = "shell-content-release-";
const RELEASE_META_CACHE = "shell-release-meta-v1";
const DIAGNOSTIC_CACHE = "shell-diagnostics-v1";
const API_CACHE = "api-v1";
const SELECTED_RELEASE_KEY = "/selected-release.json";
const DIAGNOSTIC_KEY = "/sw-diagnostics.json";
const NAV_TIMEOUT_MS = 2000;
const OPTIONAL_SHELL_FILES = [
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
];

interface ShellRelease {
  id: string;
  entryUrl: string;
  criticalUrls: string[];
  ready: boolean;
  cachedAt: number;
}

interface Diagnostics {
  buildId: string;
  activeReleaseId?: string;
  locallyPresentReleaseIds: string[];
  lastNavigationReleaseId?: string;
  lastNavigationFallback?: "hit" | "miss";
  lastMissingCriticalUrl?: string;
  events: Array<{ at: number; type: string; detail?: string }>;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      await recordEvent("install-started", BUILD_ID);
      await installReadyRelease();
      await recordEvent("install-completed", BUILD_ID);
      await self.skipWaiting();
    })().catch(async (error) => {
      await recordEvent("install-failed", describeError(error));
      throw error;
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const selected = await selectBestReadyRelease();
      await recordEvent("activated", selected?.id ?? "none");
      await cleanupOldShellCaches(selected?.id);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "REFRESH_APP_SHELL") {
    event.waitUntil(
      installReadyRelease()
        .then(selectBestReadyRelease)
        .then((release) => cleanupOldShellCaches(release?.id))
        .catch((error) => recordEvent("refresh-failed", describeError(error))),
    );
    return;
  }

  if (type === "VERIFY_SHELL") {
    event.waitUntil(reply(event, verifyShellStatus()));
    return;
  }

  if (type === "GET_DIAGNOSTICS") {
    event.waitUntil(reply(event, getDiagnostics()));
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    event.respondWith(navigationResponse(event.request));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstShellAsset(event.request));
    return;
  }

  if (isShellEntryPath(url.pathname)) {
    event.respondWith(navigationResponse(event.request));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (url.pathname.startsWith("/api/texts/")) {
      event.respondWith(fetch(event.request));
      return;
    }
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(cacheFirstShellAsset(event.request));
});

function cacheNameForRelease(releaseId: string): string {
  return `${SHELL_CACHE_PREFIX}${releaseId}`;
}

function criticalUrls(): string[] {
  return Array.from(new Set(["/index.html", "/", ...SHELL_MANIFEST.map(normalizeSameOriginPath)]));
}

function normalizeSameOriginPath(path: string): string {
  return new URL(path, self.location.origin).pathname;
}

function isShellEntryPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/index.html";
}

async function installReadyRelease(): Promise<ShellRelease> {
  const release: ShellRelease = {
    id: BUILD_ID,
    entryUrl: "/index.html",
    criticalUrls: criticalUrls(),
    ready: false,
    cachedAt: Date.now(),
  };
  const cache = await caches.open(cacheNameForRelease(release.id));

  for (const url of release.criticalUrls) {
    const fetchUrl = url === "/" ? "/index.html" : url;
    const response = await fetch(fetchUrl, { cache: "reload" });
    if (!response.ok) {
      await recordEvent("critical-fetch-failed", `${url}: ${response.status}`);
      throw new Error(`Critical shell asset failed: ${url}`);
    }
    await cache.put(url, response.clone());
  }

  for (const url of OPTIONAL_SHELL_FILES) {
    try {
      const response = await fetch(url, { cache: "reload" });
      if (response.ok) await cache.put(url, response);
    } catch {
      await recordEvent("optional-fetch-failed", url);
    }
  }

  await verifyReleaseAssets(release, cache);
  release.ready = true;
  await saveRelease(release);
  return release;
}

async function verifyReleaseAssets(release: ShellRelease, existingCache?: Cache): Promise<void> {
  const cache = existingCache ?? await caches.open(cacheNameForRelease(release.id));
  for (const url of release.criticalUrls) {
    const response = await cache.match(url);
    if (!response?.ok) {
      await recordEvent("missing-critical-asset", url);
      await updateDiagnostics({ lastMissingCriticalUrl: url });
      throw new Error(`Missing critical shell asset: ${url}`);
    }
  }
}

async function saveRelease(release: ShellRelease): Promise<void> {
  const meta = await caches.open(RELEASE_META_CACHE);
  await meta.put(`/release-${release.id}.json`, jsonResponse(release));
}

async function readReadyReleases(): Promise<ShellRelease[]> {
  const meta = await caches.open(RELEASE_META_CACHE);
  const keys = await meta.keys();
  const releases: ShellRelease[] = [];
  for (const request of keys) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/release-")) continue;
    const response = await meta.match(request);
    if (!response) continue;
    try {
      const release = await response.json() as ShellRelease;
      if (release.ready) releases.push(release);
    } catch {
      // Ignore malformed stale metadata.
    }
  }
  releases.sort((a, b) => b.cachedAt - a.cachedAt);
  return releases;
}

async function selectBestReadyRelease(): Promise<ShellRelease | null> {
  const releases = await readReadyReleases();
  for (const release of releases) {
    try {
      await verifyReleaseAssets(release);
      const meta = await caches.open(RELEASE_META_CACHE);
      await meta.put(SELECTED_RELEASE_KEY, jsonResponse(release));
      await updateDiagnostics({
        activeReleaseId: release.id,
        locallyPresentReleaseIds: releases.map((r) => r.id),
      });
      return release;
    } catch {
      continue;
    }
  }
  await updateDiagnostics({ activeReleaseId: undefined, locallyPresentReleaseIds: [] });
  return null;
}

async function getSelectedRelease(): Promise<ShellRelease | null> {
  const meta = await caches.open(RELEASE_META_CACHE);
  const response = await meta.match(SELECTED_RELEASE_KEY);
  if (response) {
    try {
      const release = await response.json() as ShellRelease;
      await verifyReleaseAssets(release);
      return release;
    } catch {
      return selectBestReadyRelease();
    }
  }
  return selectBestReadyRelease();
}

async function cleanupOldShellCaches(selectedId?: string): Promise<void> {
  const releases = await readReadyReleases();
  const keep = new Set(releases.slice(0, 3).map((release) => cacheNameForRelease(release.id)));
  if (selectedId) keep.add(cacheNameForRelease(selectedId));
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && !keep.has(key))
      .map((key) => caches.delete(key)),
  );
  await recordEvent("cleanup-completed", `kept=${[...keep].join(",")}`);
}

async function navigationResponse(request: Request): Promise<Response> {
  try {
    const response = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
    if (response.ok) return response;
  } catch {
    // Fall through to selected release.
  }

  const release = await getSelectedRelease();
  if (release) {
    const cache = await caches.open(cacheNameForRelease(release.id));
    const cached = await cache.match(release.entryUrl) ?? await cache.match("/");
    if (cached) {
      await updateDiagnostics({
        lastNavigationReleaseId: release.id,
        lastNavigationFallback: "hit",
      });
      await recordEvent("navigation-fallback-hit", release.id);
      return cached;
    }
  }

  await updateDiagnostics({ lastNavigationFallback: "miss" });
  await recordEvent("navigation-fallback-miss", new URL(request.url).pathname);
  return diagnosticFallbackResponse();
}

async function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirstShellAsset(request: Request): Promise<Response> {
  const release = await getSelectedRelease();
  if (release) {
    const cache = await caches.open(cacheNameForRelease(release.id));
    const cached = await cache.match(normalizeSameOriginPath(new URL(request.url).pathname));
    if (cached) return cached;
  }

  const response = await fetch(request);
  if (response.ok && release) {
    const cache = await caches.open(cacheNameForRelease(release.id));
    await cache.put(request, response.clone());
  }
  return response;
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

async function verifyShellStatus(): Promise<unknown> {
  const releases = await readReadyReleases();
  const selected = await getSelectedRelease();
  let verified = false;
  let reason = "";
  if (selected) {
    try {
      await verifyReleaseAssets(selected);
      verified = true;
    } catch (error) {
      reason = describeError(error);
    }
  } else {
    reason = "No ready shell release is selected.";
  }

  const diagnostics = await getDiagnostics();
  return {
    buildId: BUILD_ID,
    controlled: true,
    verified,
    reason,
    activeReleaseId: selected?.id,
    locallyPresentReleaseIds: releases.map((release) => release.id),
    diagnostics,
  };
}

async function reply(event: ExtendableMessageEvent, valuePromise: Promise<unknown>): Promise<void> {
  const port = event.ports?.[0];
  if (!port) return;
  try {
    port.postMessage({ ok: true, value: await valuePromise });
  } catch (error) {
    port.postMessage({ ok: false, error: describeError(error) });
  }
}

async function getDiagnostics(): Promise<Diagnostics> {
  const cache = await caches.open(DIAGNOSTIC_CACHE);
  const response = await cache.match(DIAGNOSTIC_KEY);
  if (response) {
    try {
      return await response.json() as Diagnostics;
    } catch {
      // Replace malformed diagnostics below.
    }
  }
  return {
    buildId: BUILD_ID,
    locallyPresentReleaseIds: [],
    events: [],
  };
}

async function updateDiagnostics(fields: Partial<Diagnostics>): Promise<void> {
  const cache = await caches.open(DIAGNOSTIC_CACHE);
  const diagnostics = await getDiagnostics();
  await cache.put(DIAGNOSTIC_KEY, jsonResponse({ ...diagnostics, ...fields, buildId: BUILD_ID }));
}

async function recordEvent(type: string, detail?: string): Promise<void> {
  const cache = await caches.open(DIAGNOSTIC_CACHE);
  const diagnostics = await getDiagnostics();
  const events = [...diagnostics.events, { at: Date.now(), type, detail }].slice(-50);
  await cache.put(DIAGNOSTIC_KEY, jsonResponse({ ...diagnostics, buildId: BUILD_ID, events }));
}

function diagnosticFallbackResponse(): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Chinese Reader Offline</title></head><body><h1>Chinese Reader offline shell unavailable</h1><p>The service worker could not find a complete cached app shell. Reconnect once to repair offline launch.</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 200 },
  );
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
