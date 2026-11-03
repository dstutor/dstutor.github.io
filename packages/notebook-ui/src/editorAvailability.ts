/**
 * Loads the bundled Monaco chunk once and reports whether the rich editor is usable.
 * Resolves false (plain textarea editor) if the chunk fails to load or parse, e.g. on an
 * older phone browser, or takes unreasonably long.
 */
const LOAD_TIMEOUT_MS = 15000;

let availability: Promise<boolean> | null = null;

export function ensureMonaco(): Promise<boolean> {
  if (!availability) {
    availability = Promise.race([
      import('./monacoSetup').then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), LOAD_TIMEOUT_MS)),
    ]).catch((error: unknown) => {
      console.error('The code editor could not be loaded; using the plain editor instead.', error);
      return false;
    });
  }
  return availability;
}
