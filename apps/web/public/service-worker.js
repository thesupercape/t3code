const CACHE_NAME = "t3code-app-shell-v1";
const CORE_RESOURCES = [
  "/",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
  "/pwa-icon-maskable-512.png",
];
const BYPASS_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  "/@vite",
  "/@react-refresh",
  "/src",
  "/node_modules",
];
const CORE_PATHS = new Set(CORE_RESOURCES);

function isCacheableResource(url) {
  return CORE_PATHS.has(url.pathname) || url.pathname.startsWith("/assets/");
}

function shouldBypass(url, request) {
  return (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    BYPASS_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )
  );
}

async function cacheResponse(request, response) {
  if (response.ok && response.type !== "opaque") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put("/", response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) ?? (await caches.match("/")) ?? Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_RESOURCES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("t3code-app-shell-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_APP_RESOURCES" || !Array.isArray(event.data.resources)) return;
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(
        event.data.resources.map((resource) => {
          if (typeof resource !== "string") return undefined;
          try {
            const url = new URL(resource, self.location.origin);
            if (url.origin !== self.location.origin || !isCacheableResource(url)) return undefined;
            const request = new Request(url.href);
            return shouldBypass(url, request) ? undefined : cache.add(request);
          } catch {
            return undefined;
          }
        }),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (shouldBypass(url, event.request)) return;

  if (event.request.mode === "navigate") {
    event.respondWith(navigationResponse(event.request));
    return;
  }
  if (!isCacheableResource(url)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => cacheResponse(event.request, response));
    }),
  );
});

function notificationRoute(data) {
  const route = data?.route;
  return typeof route === "string" && /^\/[^/]+\/[^/]+$/.test(route) ? route : "/";
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(notificationRoute(event.notification.data), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find(
        (candidate) => new URL(candidate.url).origin === self.location.origin,
      );
      if (client) {
        if ("navigate" in client) await client.navigate(targetUrl);
        return client.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
