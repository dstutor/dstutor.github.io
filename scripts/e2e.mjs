// The built site (site/, from npm run build) in Chrome, the way a visitor uses it:
//
// - every tutor loads Python and its library, then runs each gallery example (opened from the
//   Examples gallery, without reloading), with no error and with as many steps as the same
//   example gives under CPython (each tracer's contract_test.py --emit, run with $PYTHON);
// - a step card shows Cel beside its table;
// - Stop interrupts `while True: pass` and the kernel comes back;
// - the hub loads, its library toggle switches the demo cell, and its Tutors menu links to
//   every tutor.
//
//   npm run test:e2e            (needs Chrome; PYTHON=… for the step counts, else python3)
//   E2E_ONLY=pandas npm run test:e2e
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4178;
const BASE = `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.PYTHON || 'python3';
const ONLY = process.env.E2E_ONLY?.split(',');
const LOAD_MS = 240_000;
/** A cell that never finishes, for Stop: Python, or SQL for the SQL tutor */
const ENDLESS = {
  python: 'while True:\n    pass',
  sql: 'SELECT SUM(range) FROM range(1000000000000000);',
};
const RUN_MS = 120_000;

if (!existsSync(join(ROOT, 'site', 'index.html'))) {
  console.error('No site/ to test: run npm run build first.');
  process.exit(1);
}

/** Every tutor: an app with a gallery and a tracer of the same name */
const tutors = readdirSync(join(ROOT, 'apps')).filter(
  (lib) => existsSync(join(ROOT, 'apps', lib, 'src', 'data', 'examples.json')) && existsSync(join(ROOT, 'tracers', lib, 'contract_test.py')),
).filter((lib) => !ONLY || ONLY.includes(lib));

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

/** Steps per gallery example under CPython: {id: count}, or null when Python is not set up */
function cpythonSteps(lib, examples) {
  try {
    const out = execFileSync(PYTHON, ['contract_test.py', '--emit', ...examples.map((e) => `example ${e.id}`)], {
      cwd: join(ROOT, 'tracers', lib),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const results = JSON.parse(out.trim().split('\n').at(-1));
    return Object.fromEntries(examples.map((e) => [e.id, results[`example ${e.id}`].trace.length]));
  } catch (error) {
    console.log(`note: no CPython step counts for ${lib} (${String(error.message).split('\n')[0]}); checking that steps appear`);
    return null;
  }
}

const server = spawn('npx', ['vite', 'preview', '--outDir', 'site', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
const stop = () => server.kill();
process.on('exit', stop);

for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const browser = await chromium.launch({ channel: 'chrome' });

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  return { context, page, errors };
}

const ready = (page) => page.waitForSelector('.status.ready', { timeout: LOAD_MS });
const idle = (page) =>
  page.waitForFunction(() => {
    const run = document.querySelector('.run-button');
    return run && !run.disabled && document.querySelector('.status.ready');
  }, null, { timeout: RUN_MS });

async function testTutor(lib) {
  const { examples } = JSON.parse(readFileSync(join(ROOT, 'apps', lib, 'src', 'data', 'examples.json'), 'utf8'));
  const expected = cpythonSteps(lib, examples);
  const { context, page, errors } = await newPage();
  const started = Date.now();
  await page.goto(`${BASE}/${lib}/`);
  await ready(page);
  console.log(`${lib}: Python ready in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  let sawCel = false;
  let playChecked = false;
  for (const example of examples) {
    await page.locator('.examples-button').click();
    await page.locator('.example-card', { has: page.locator('h3', { hasText: example.title }) }).first().click();
    await page.waitForSelector('.gallery-modal', { state: 'detached' });
    await idle(page);
    await page.locator('.run-button').click();
    await page.waitForFunction(() => document.querySelector('.run-button')?.disabled, null, { timeout: 5000 }).catch(() => {});
    await idle(page);
    const errorCount = await page.locator('.output-error').count();
    const counter = await page.getByText(/Step \d+ of \d+/).first().innerText({ timeout: 2000 }).catch(() => '');
    const steps = Number(counter.match(/of (\d+)/)?.[1] ?? 0);
    const want = expected?.[example.id];
    const stepsOk = want === undefined ? steps > 0 : steps === want;
    check(errorCount === 0 && stepsOk, `${lib} ${example.id}: ${steps} steps${want === undefined ? '' : ` (CPython ${want})`}${errorCount ? `, ${errorCount} errors` : ''}`);
    // Frames stay put until asked; Play moves on by itself (checked once per tutor)
    if (!playChecked && (await page.locator('.nav-button.next:not([disabled])').count()) > 0) {
      playChecked = true;
      const where = () => page.locator('.step-badge').first().innerText();
      const before = await where();
      await page.waitForTimeout(2500);
      const still = (await where()) === before;
      await page.locator('.autoplay-speed select').selectOption('2');
      await page.locator('.autoplay-toggle').click();
      await page.waitForTimeout(2600);
      const moved = still && (await where()) !== before;
      await page.locator('.autoplay-toggle').click();
      check(moved, `${lib}: a frame stays until Play moves it on`);
    }
    // A step that starts from an empty table has no Before table for Cel to stand by; look
    // through the first few frames
    for (let i = 0; i < 6 && !sawCel; i++) {
      sawCel = (await page.locator('.step-card .cel-guide').count()) > 0;
      if (!sawCel) await page.keyboard.press('ArrowRight');
    }
  }
  check(sawCel, `${lib}: Cel stands beside the step tables`);

  // Stop: an endless cell is interrupted, and the kernel comes back
  const endless = encodeURIComponent(JSON.stringify([{ type: 'code', source: ENDLESS[lib] ?? ENDLESS.python }]));
  await page.goto(`${BASE}/${lib}/?cells=${endless}`);
  await ready(page);
  await page.locator('.toolbar-button', { hasText: /^Run all$/ }).click();
  await page.waitForTimeout(1500);
  const before = Date.now();
  await page.locator('.stop-button').click();
  const back = await ready(page).then(() => true, () => false);
  check(back, `${lib}: Stop interrupts a cell that never ends (ready again after ${((Date.now() - before) / 1000).toFixed(1)} s)`);

  check(errors.length === 0, `${lib}: no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
}

async function testHub() {
  const { context, page, errors } = await newPage();
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#demo-cell');

  // The Tutors menu lists every live tutor, and each link loads
  await page.locator('#tutors-button').click();
  const links = await page.locator('#tutors-menu a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  for (const lib of tutors) {
    check(links.some((href) => href?.replace(/\/$/, '').endsWith(`/${lib}`)), `hub: Tutors menu links to ${lib}`);
  }
  for (const href of links) {
    const url = new URL(href, `${BASE}/`);
    if (url.origin !== BASE) continue;
    check((await fetch(url)).ok, `hub: ${url.pathname} loads`);
  }
  await page.keyboard.press('Escape');

  // Each library in the toggle puts its own code in the demo cell
  const options = page.locator('#demo-libraries [role="radio"]:not([disabled])');
  const seen = new Set();
  for (let i = 0; i < (await options.count()); i++) {
    await options.nth(i).click();
    await page.waitForTimeout(300);
    seen.add(await page.locator('#demo-code').inputValue());
    check((await options.nth(i).getAttribute('aria-checked')) === 'true', `hub: toggle selects ${await options.nth(i).innerText()}`);
  }
  check(seen.size === (await options.count()), `hub: each of ${seen.size} libraries shows its own code`);

  check(errors.length === 0, `hub: no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();
}

try {
  await testHub();
  for (const lib of tutors) await testTutor(lib);
} catch (error) {
  check(false, `stopped early: ${error.message.split('\n')[0]}`);
} finally {
  await browser.close();
  stop();
}

console.log(failures.length ? `\n${failures.length} failed` : `\nAll passed (${tutors.join(', ')} and the hub)`);
process.exit(failures.length ? 1 : 0);
