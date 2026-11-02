import { defineConfig } from 'vite';

// Static landing page: plain HTML and CSS, loads no runtime.
export default defineConfig({
  base: '/',
  publicDir: '../../_static/dstutor-brand',
});
