// packages/viz must render without the tutor shell (Roadmap: the %%dstutor widget), so every
// design token its CSS reads needs a default in standalone.css, and its sources may import only
// React, the trace schema and the brand.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir);
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

const used = new Set<string>();
for (const name of files.filter((f) => f.endsWith('.css') && f !== 'standalone.css')) {
  // var(--x, fallback) brings its own default (a value set inline, like a row's --row)
  for (const [, token] of read(name).matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(token);
}
const defined = new Set([...read('standalone.css').matchAll(/^\s*(--[a-z0-9-]+):/gm)].map(([, token]) => token));
// Cel's colors come with Cel, from @dstutor/brand/cel.css
const fromBrand = (token: string) => token.startsWith('--cel-');

describe('standalone.css', () => {
  it('gives every token the viz uses a default', () => {
    const missing = [...used].filter((token) => !defined.has(token) && !fromBrand(token));
    expect(missing).toEqual([]);
  });
});

describe('viz imports', () => {
  it('reach nothing but React, the trace schema, the brand and its own files', () => {
    const allowed = /^(react(\/.*)?|@dstutor\/trace-schema|@dstutor\/brand(\/cel\.css)?|html2canvas|jspdf|fflate|vitest|node:.*|\.\/.*)$/;
    const sources = files.filter((f) => /\.(ts|tsx)$/.test(f));
    const imports = sources.flatMap((f) => [...read(f).matchAll(/(?:from|import)\s+'([^']+)'/g)].map(([, spec]) => spec));
    expect(imports.filter((spec) => !allowed.test(spec))).toEqual([]);
  });
});
