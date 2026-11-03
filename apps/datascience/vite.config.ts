import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serviceWorker } from '../../packages/runtime-pyodide/src/vite.ts';

/** Identifies a build for cache busting: the git commit when available, else the build time */
function buildId(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return Date.now().toString(36);
  }
}

export default defineConfig({
  base: '/datascience/',
  publicDir: '../../_static/dstutor-brand',
  plugins: [react(), serviceWorker()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  // The Python runtime is a module worker that imports pyodide
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['pyodide'],
  },
});
