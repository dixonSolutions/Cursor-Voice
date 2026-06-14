/**
 * Cursor Voice — Service Worker
 *
 * Minimal PWA service worker. Caches the app shell so the UI loads
 * instantly even on a slow Tailscale connection. API calls are always
 * fetched from the network (the bridge may be offline; we don't cache
 * stale data).
 *
 * Strategy: network-first for API routes, cache-first for static assets.
 * Cache is versioned — bump CACHE_NAME when deploying a new build.
 */

const CACHE_NAME = 'cursor-voice-v1';

const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icon.svg',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: clean up old caches ─────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch: network-first for API, cache-first for assets ──────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept: API calls, WebSocket upgrades, cross-origin requests
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/ws/') ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  event.respondWith(
    // Network first — serve fresh; fall back to cache if offline
    fetch(event.request)
      .then((res) => {
        // Only cache successful GET responses
        if (event.request.method === 'GET' && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? Response.error())),
  );
});
