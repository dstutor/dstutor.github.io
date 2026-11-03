// Vite plugin for tutor apps: serves sw.js at the app's base in dev and emits it at the root of
// the build, so the worker's scope is the whole tutor (a hashed asset under assets/ would only
// control assets/). Runs in Node, from the app's vite.config.ts.
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

const SOURCE = new URL('./sw.js', import.meta.url);

export function serviceWorker(): Plugin {
  let base = '/';
  return {
    name: 'dstutor-service-worker',
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== `${base}sw.js`) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.end(readFileSync(SOURCE));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: readFileSync(SOURCE, 'utf8') });
    },
  };
}
