import { PYODIDE_VERSION } from './version';

/**
 * Register the tutor's service worker (sw.js, emitted at the app's base by the Vite plugin in
 * ./vite.ts). The query string versions it: a new build id replaces the app cache, and a new
 * Pyodide version replaces the shared package cache.
 */
export function registerServiceWorker({ base, buildId }: { base: string; buildId: string }): void {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const url = `${base}sw.js?v=${encodeURIComponent(buildId)}&py=${encodeURIComponent(PYODIDE_VERSION)}`;
    navigator.serviceWorker.register(url).catch((error) => {
      console.log('Service worker registration failed:', error);
    });
  });
}
