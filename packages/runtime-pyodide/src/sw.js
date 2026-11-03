// Service worker: keeps a tutor's app shell available offline and caches the large Pyodide
// downloads. Two caches with independent lifetimes:
//   - the app cache is named after this tutor's scope and build id (?v=...), so every deploy
//     starts fresh;
//   - the Pyodide cache is named after the Pyodide version (?py=...) only. Every tutor on the
//     site pins the same version, so they share it: the runtime downloads once for the site.
// Tutors share an origin, so cleanup only touches this tutor's old app caches and old Pyodide
// versions, never another tutor's cache.
const params = new URL(self.location.href).searchParams;

// The base path the tutor is served from, e.g. "/datascience/"
const SCOPE = new URL(self.registration ? self.registration.scope : self.location.href).pathname;

const APP_PREFIX = `dstutor-app-${SCOPE}-`;
const PYODIDE_PREFIX = 'dstutor-pyodide-';
const APP_CACHE = `${APP_PREFIX}${params.get('v') || 'dev'}`;
const PYODIDE_CACHE = `${PYODIDE_PREFIX}${params.get('py') || 'unknown'}`;

function isPyodideAsset(url) {
  return (
    url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/pyodide/') ||
    url.hostname === 'files.pythonhosted.org' ||
    url.pathname.endsWith('.whl') ||
    url.pathname.endsWith('.wasm')
  );
}

function isStale(name) {
  return (name.startsWith(APP_PREFIX) && name !== APP_CACHE) ||
    (name.startsWith(PYODIDE_PREFIX) && name !== PYODIDE_CACHE);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll([SCOPE, `${SCOPE}index.html`]).catch(() => undefined))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter(isStale).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Pyodide runtime and wheels: cache first, they never change for a given version
  if (isPyodideAsset(url)) {
    event.respondWith(
      caches.open(PYODIDE_CACHE).then((cache) =>
        cache.match(event.request).then((hit) => hit || fetch(event.request).then((response) => {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        }))
      )
    );
    return;
  }

  // Everything else: network first, falling back to this build's cache when offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && (url.origin === self.location.origin || response.type === 'basic')) {
          const copy = response.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
