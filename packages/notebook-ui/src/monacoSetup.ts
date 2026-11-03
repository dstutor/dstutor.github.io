/**
 * Bundle Monaco with the app instead of loading it from a CDN at runtime.
 *
 * @monaco-editor/react defaults to fetching the *latest* monaco-editor from jsdelivr, so the
 * editor version could change under us (and newer releases drop older browsers). Bundling pins
 * it to the version in package.json, serves it from our origin (cached by the service worker),
 * and lets the app fall back to a plain editor if this chunk cannot load. Imported dynamically
 * from editorAvailability.ts so a load failure here never takes the rest of the app down.
 */
// monaco-editor 0.56+ entry points: the editor core, every editor feature (suggest, find,
// folding, ...), and just the Python language definition
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/python/register';
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { loader } from '@monaco-editor/react';

self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

loader.config({ monaco });

export { monaco };
