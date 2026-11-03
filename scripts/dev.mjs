// The whole site in development, laid out as it is deployed: the hub at / and every tutor at
// /<lib>/, each app served by its own Vite dev server (with hot reload) behind one address.
//
//   npm run dev            then open http://localhost:5173/
//   PORT=8080 npm run dev
import { createServer as createHttpServer } from 'node:http';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT || 5173);

const apps = readdirSync(`${root}apps`, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// Each app keeps its own base (vite.config.ts) and its own hot-reload socket
const servers = [];
for (const [i, app] of apps.entries()) {
  const vite = await createServer({
    root: `${root}apps/${app}`,
    configFile: `${root}apps/${app}/vite.config.ts`,
    server: { middlewareMode: true, hmr: { port: 24700 + i } },
  });
  servers.push({ app, base: app === 'hub' ? '/' : `/${app}/`, vite });
}
const hub = servers.find((s) => s.base === '/');
const tutors = servers.filter((s) => s !== hub);

createHttpServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  // /pandas -> /pandas/, as GitHub Pages does
  const bare = tutors.find((s) => path === s.base.slice(0, -1));
  if (bare) {
    res.writeHead(301, { Location: bare.base });
    res.end();
    return;
  }
  const target = tutors.find((s) => path.startsWith(s.base)) ?? hub;
  target.vite.middlewares(req, res, () => {
    res.statusCode = 404;
    res.end('Not found');
  });
}).listen(port, () => {
  console.log(`dstutor dev server: http://localhost:${port}/`);
  for (const s of servers) console.log(`  ${s.base.padEnd(14)} apps/${s.app}`);
});
