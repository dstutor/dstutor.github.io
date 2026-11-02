// Assembles the GitHub Pages site: apps/hub/dist at /, apps/<lib>/dist at /<lib>/.
// Run after every app is built (npm run build does both).
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const site = join(root, 'site');
const appsDir = join(root, 'apps');

function fail(message) {
  console.error(`assemble: ${message}`);
  process.exit(1);
}

function distOf(app) {
  const dist = join(appsDir, app, 'dist');
  if (!existsSync(join(dist, 'index.html'))) fail(`apps/${app}/dist/index.html is missing; build ${app} first`);
  return dist;
}

// Every local URL a page references must live under its own base, or it 404s once mounted.
function checkBase(app, base) {
  const html = readFileSync(join(site, base, 'index.html'), 'utf8');
  for (const [, url] of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) {
    if (url === '/' && app !== 'hub') continue; // links back to the hub
    if (!url.startsWith(`/${base}`)) fail(`${app}: ${url} is outside /${base}; set base: '/${base}' in its vite.config.ts`);
  }
}

rmSync(site, { recursive: true, force: true });
cpSync(distOf('hub'), site, { recursive: true });
checkBase('hub', '');

const tutors = readdirSync(appsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'hub')
  .map((entry) => entry.name);

for (const app of tutors) {
  if (existsSync(join(site, app))) fail(`hub output already has /${app}/, which would collide with the ${app} app`);
  cpSync(distOf(app), join(site, app), { recursive: true });
  checkBase(app, `${app}/`);
}

writeFileSync(join(site, '.nojekyll'), '');
console.log(`assemble: site/ has the hub at / and ${tutors.map((t) => `/${t}/`).join(', ') || 'no tutors'}`);
