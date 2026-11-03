/** Pinned so an upstream release cannot change behaviour under us; bump deliberately.
 * Every tutor shares this version, so the service worker's Pyodide cache serves the whole site. */
export const PYODIDE_VERSION = '314.0.7';
