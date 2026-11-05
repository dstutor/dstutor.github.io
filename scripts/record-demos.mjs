// Records the looping clips on the hub's "Every tutor is a notebook" cards from the real tutors,
// so they always show the tutors as they are. Each clip drives the built site in Chrome at a
// laptop's size (1280x800, at 2x for sharp text) with a drawn cursor (screen recordings do not show
// the real one), captures the frames Chrome paints, then films them with a camera: it starts on the
// whole window and eases in on what each click is about, the way an edited screen recording does,
// so the tutor reads at card size. The camera is composed frame by frame on a canvas (sub-pixel, so
// pans never judder) and ffmpeg encodes the result: 1200x750 H.264 and a poster image.
//
//   npm run record:demos [notebook|steps|present|share ...]   (builds first; needs ffmpeg and Chrome)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(root, 'apps/hub/src/demos');
const PORT = 4175;
// The browser sends dstutor.org to the local preview server, so links in the clips (Share's
// copied link) show the real address rather than localhost
const BASE = 'http://dstutor.org';
const VIEW = { width: 1280, height: 800 };
const SCALE = 2;
const SIZE = { width: 1200, height: 750 };
const FPS = 30;
// The camera never magnifies more than this, so text stays sharp
const MAX_ZOOM = 2;
const WHOLE = { x: 0, y: 0, width: VIEW.width, height: VIEW.height };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;

// The drawn cursor: an arrow that follows the mouse, and a ripple on every click
function installCursor() {
  const add = () => {
    const cursor = document.createElement('div');
    cursor.id = 'demo-cursor';
    cursor.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2l15 11.5-6.6 1.1 3.9 7.4-3 1.5-3.8-7.6L4 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px, -100px)' });
    document.body.append(cursor);
    addEventListener('mousemove', (e) => { cursor.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`; }, true);
    addEventListener('mousedown', (e) => {
      const ring = document.createElement('div');
      Object.assign(ring.style, {
        position: 'fixed', left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: '36px', height: '36px',
        borderRadius: '50%', border: '3px solid #f37726', zIndex: '2147483646', pointerEvents: 'none',
        transition: 'transform 450ms ease-out, opacity 450ms ease-out', transform: 'scale(0.3)', opacity: '1',
      });
      document.body.append(ring);
      requestAnimationFrame(() => { ring.style.transform = 'scale(1.2)'; ring.style.opacity = '0'; });
      setTimeout(() => ring.remove(), 600);
    }, true);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
}

let mouse = { x: 900, y: 520 };
async function moveTo(page, target, steps = 30) {
  const box = 'boundingBox' in target ? await target.boundingBox() : target;
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // An eased path, the way a hand moves
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(mouse.x + (to.x - mouse.x) * e, mouse.y + (to.y - mouse.y) * e);
    await sleep(16);
  }
  mouse = to;
  return to;
}
async function click(page, target) {
  // A real reader scrolls to a button below the fold before clicking it
  if ('scrollIntoViewIfNeeded' in target) await target.scrollIntoViewIfNeeded();
  await moveTo(page, target);
  await sleep(200);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

/** The smallest rect around some elements (CSS pixels) */
async function around(...locators) {
  const boxes = (await Promise.all(locators.map((l) => l.boundingBox()))).filter(Boolean);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return {
    x, y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}

/** The camera frame that shows a rect: padded, the video's shape, no closer than MAX_ZOOM, inside the window */
function frameFor(rect, pad = 32) {
  const aspect = VIEW.width / VIEW.height;
  let w = rect.width + 2 * pad;
  let h = rect.height + 2 * pad;
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  w = Math.min(VIEW.width, Math.max(VIEW.width / MAX_ZOOM, w));
  h = w / aspect;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: Math.min(Math.max(cx - w / 2, 0), VIEW.width - w),
    y: Math.min(Math.max(cy - h / 2, 0), VIEW.height - h),
    width: w,
    height: h,
  };
}

/**
 * The camera's moves while a clip records. Each move eases from wherever the camera is to a new
 * frame; the clip carries on while it does.
 */
function makeCamera() {
  const moves = [];
  return {
    moves,
    /** Ease in on a rect, or back out to the whole window with no rect */
    to(rect, { ms = 1000, pad } = {}) {
      moves.push({ t: now(), frame: rect ? frameFor(rect, pad) : WHOLE, ms: ms / 1000 });
    },
  };
}

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
/** Between two frames: the width changes by a constant ratio (zoom feels even), the center moves linearly */
function between(a, b, p) {
  const e = ease(Math.min(1, Math.max(0, p)));
  const w = a.width * (b.width / a.width) ** e;
  const h = (w * VIEW.height) / VIEW.width;
  const cx = a.x + a.width / 2 + (b.x + b.width / 2 - a.x - a.width / 2) * e;
  const cy = a.y + a.height / 2 + (b.y + b.height / 2 - a.y - a.height / 2) * e;
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}
/** The camera's frame at time t */
function cameraPath(moves) {
  let at = () => WHOLE;
  for (const move of moves) {
    // Each move starts from wherever the moves before it had the camera
    const segment = { ...move, from: at(move.t) };
    const before = at;
    at = (t) => (t < segment.t ? before(t) : between(segment.from, segment.frame, segment.ms ? (t - segment.t) / segment.ms : 1));
  }
  return at;
}

/** Capture the frames Chrome paints while act() runs */
async function capture(page, act) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE });
  // Nudge a repaint so the clip starts with a frame
  await page.mouse.move(mouse.x, mouse.y + 1);
  await page.mouse.move(mouse.x, mouse.y);
  const camera = makeCamera();
  const start = now();
  const marks = (await act(camera)) ?? {};
  // Chrome only sends a frame when something repaints, so a still ending would be cut short:
  // the last frame lasts until the action actually ended
  const end = now();
  await cdp.send('Page.stopScreencast');
  return { frames, start, end, moves: camera.moves, marks };
}

/** Film the captured frames through the camera, then encode the clip and its poster */
async function film(browser, name, { frames, start, end, moves, marks }) {
  const dir = mkdtempSync(join(tmpdir(), `demo-${name}-`));
  const page = await browser.newPage();
  await page.evaluate(({ width, height }) => {
    const canvas = Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    Object.assign(window, { canvas, ctx, bitmap: null });
  }, SIZE);
  const at = cameraPath(moves);
  const t0 = Math.max(start, frames[0].t);
  const count = Math.round((end - t0) * FPS);
  let shown = -1;
  let source = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i / FPS;
    while (source + 1 < frames.length && frames[source + 1].t <= t) source++;
    if (source !== shown) {
      await page.evaluate(async (data) => {
        window.bitmap?.close();
        window.bitmap = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
      }, frames[source].data);
      shown = source;
    }
    const frame = at(t);
    const url = await page.evaluate(({ x, y, width, height, view }) => {
      const k = window.bitmap.width / view;
      window.ctx.drawImage(window.bitmap, x * k, y * k, width * k, height * k, 0, 0, window.canvas.width, window.canvas.height);
      return window.canvas.toDataURL('image/jpeg', 0.94);
    }, { ...frame, view: VIEW.width });
    writeFileSync(join(dir, `${String(i).padStart(5, '0')}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
  await page.close();
  const run = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${count} frames in ${dir}`);
  };
  run(['-framerate', String(FPS), '-i', join(dir, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(OUT, `${name}.mp4`)]);
  // The poster is the frame the clip is about (or its last): what shows before it plays, and with reduced motion
  const posterIndex = marks.poster ? Math.min(count - 1, Math.round((marks.poster - t0) * FPS)) : count - 1;
  run(['-i', join(dir, `${String(posterIndex).padStart(5, '0')}.jpg`), '-vf', 'scale=1280:800:flags=lanczos', '-q:v', '4', join(OUT, `${name}.jpg`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`wrote apps/hub/src/demos/${name}.mp4 (${(end - t0).toFixed(1)} s, ${frames.length} frames painted)`);
}

async function openTutor(browser, path, notebookWidth, theme = 'jupyter') {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await context.addInitScript(installCursor);
  await context.addInitScript(([w, t]) => {
    localStorage.setItem('theme', t);
    localStorage.setItem('notebookWidthPercent', String(w));
  }, [notebookWidth, theme]);
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`);
  // Attached, not visible: a narrow notebook pane hides the status text
  await page.waitForSelector('.status.ready', { state: 'attached', timeout: 180000 });
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(500);
  return page;
}
const idle = (page) =>
  page.waitForFunction(() => !document.querySelector('.run-button[disabled]') && document.querySelector('.status.ready'), null, { timeout: 120000 });
const cellsQuery = (cells) => `?cells=${encodeURIComponent(encodeURIComponent(JSON.stringify(cells)))}`;
const nextButton = (scope) => scope.getByRole('button', { name: /^Next/ });

// On 127.0.0.1 explicitly: dstutor.org is mapped there, and localhost can resolve to IPv6
// and Vite's host check has to let dstutor.org through
const server = spawn('npx', ['vite', 'preview', '--outDir', 'site', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'dstutor.org' },
});
const only = process.argv.slice(2);
const wanted = (name) => only.length === 0 || only.includes(name);
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/datascience/`)).ok) break; } catch { /* not up yet */ }
    await sleep(250);
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    channel: process.env.E2E_CHROME_CHANNEL || 'chrome',
    args: [
      `--host-resolver-rules=MAP dstutor.org:80 127.0.0.1:${PORT}`,
      // Plain http is not a secure origin; the clipboard (Share) needs one
      `--unsafely-treat-insecure-origin-as-secure=${BASE}`,
    ],
  });

  // Each card shows a different tutor on its own small dataset, so the four together show the range

  // 1. A notebook in the browser (datascience, penguins): Run all fills each cell's prompt and
  // output in turn, then a new cell is typed and run with Shift+Enter
  if (wanted('notebook')) {
    mouse = { x: 980, y: 560 };
    const page = await openTutor(browser, `/datascience/${cellsQuery([
      { type: 'markdown', source: '## Penguins\n\nEvery cell runs in the same Python, so a later cell can use what an earlier one made.' },
      { type: 'code', source: 'from datascience import *' },
      { type: 'code', source: "penguins = Table().with_columns(\n    'species', make_array('Adelie', 'Gentoo', 'Chinstrap', 'Adelie', 'Gentoo'),\n    'mass_g', make_array(3750, 5000, 3800, 3450, 5550))\npenguins" },
      { type: 'code', source: '' },
    ])}`, 64);
    const clip = await capture(page, async (camera) => {
      await sleep(900);
      const runAll = page.locator('.toolbar-button', { hasText: /^Run all$/ });
      camera.to(await around(page.locator('.notebook-toolbar'), page.locator('.code-cell').nth(1)), { ms: 1000, pad: 12 });
      await sleep(500);
      await click(page, runAll);
      await idle(page);
      await sleep(500);
      // Down to the table and the empty cell
      const last = page.locator('.code-cell').last();
      await last.scrollIntoViewIfNeeded();
      camera.to(await around(page.locator('.code-cell').nth(1), last), { ms: 1000, pad: 12 });
      await sleep(900);
      await click(page, last.locator('.monaco-editor'));
      await sleep(250);
      await page.keyboard.type("penguins.group('species')", { delay: 60 });
      await sleep(450);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Shift+Enter');
      await idle(page);
      await sleep(300);
      camera.to(await around(last, page.locator('.code-cell').nth(1)), { ms: 800, pad: 12 });
      await sleep(600);
      const marks = { poster: now() };
      await sleep(1800);
      camera.to(null, { ms: 1000 });
      await sleep(1300);
      return marks;
    });
    await film(browser, 'notebook', clip);
    await page.context().close();
  }

  // 2. Stepping through, beside the code (pandas, flights and airports): Run all & visualize, then
  // Next through a left merge's stages (which keys match, how rows pair, the result) with its
  // line marked in the notebook
  if (wanted('steps')) {
    mouse = { x: 900, y: 620 };
    const page = await openTutor(browser, `/pandas/${cellsQuery([
      { type: 'code', source: 'import pandas as pd' },
      { type: 'code', source: "flights = pd.DataFrame({\n    'flight': ['UA 12', 'DL 40', 'UA 88', 'AA 7', 'AS 21'],\n    'airport': ['SFO', 'JFK', 'SFO', 'LAX', 'SEA'],\n})" },
      { type: 'code', source: "airports = pd.DataFrame({\n    'airport': ['SFO', 'JFK', 'LAX', 'ORD'],\n    'city': ['San Francisco', 'New York', 'Los Angeles', 'Chicago'],\n})" },
      { type: 'code', source: "trips = flights.merge(airports, on='airport', how='left')\ntrips" },
    ])}`, 40);
    const clip = await capture(page, async (camera) => {
      await sleep(1000);
      const run = page.locator('.run-button');
      camera.to(await around(run, page.locator('.code-cell').first()), { ms: 900 });
      await sleep(400);
      await click(page, run);
      await sleep(200);
      // Out to both panes as the steps arrive beside the code
      camera.to(null, { ms: 1000 });
      await idle(page);
      await sleep(1300);
      const panel = page.locator('.trace-panel');
      camera.to(await around(panel), { ms: 1000, pad: 0 });
      await sleep(1300);
      const marks = { poster: now() };
      await sleep(900);
      for (let i = 0; i < 2; i++) {
        await click(page, nextButton(panel));
        await sleep(2400);
      }
      camera.to(null, { ms: 1000 });
      await sleep(1500);
      return marks;
    });
    await film(browser, 'steps', clip);
    await page.context().close();
  }

  // 3. Present (SQL, bike rides, in the Berkeley theme): the notebook and its steps, then Present
  // fills the window with the step for lecture, stepped through, then back to the notebook
  if (wanted('present')) {
    mouse = { x: 900, y: 620 };
    const page = await openTutor(browser, `/sql/${cellsQuery([
      { type: 'markdown', source: '## Bike rides\n\nHow long is the average ride from each city?' },
      { type: 'code', source: "CREATE OR REPLACE TABLE rides (city VARCHAR, minutes INTEGER);\nINSERT INTO rides VALUES\n    ('Oakland', 12), ('Berkeley', 8), ('Oakland', 20),\n    ('Berkeley', 14), ('Albany', 9), ('Oakland', 16);" },
      { type: 'code', source: 'SELECT city, AVG(minutes) AS avg_minutes\nFROM rides\nGROUP BY city\nORDER BY avg_minutes DESC;' },
    ])}`, 40, 'berkeley');
    await page.locator('.run-button').click();
    await idle(page);
    await sleep(900);
    const present = page.locator('.present-button');
    const clip = await capture(page, async (camera) => {
      await sleep(1300);
      camera.to(await present.boundingBox(), { ms: 900, pad: 100 });
      await sleep(250);
      await click(page, present);
      await page.waitForSelector('.presentation');
      await sleep(200);
      camera.to(await around(page.locator('.presentation-body')), { ms: 1000, pad: 0 });
      await sleep(1500);
      const marks = { poster: now() };
      for (let i = 0; i < 2; i++) {
        await click(page, nextButton(page.locator('.presentation')));
        await sleep(2200);
      }
      camera.to(null, { ms: 800 });
      await sleep(300);
      await click(page, page.locator('.presentation-exit'));
      await sleep(1500);
      return marks;
    });
    await film(browser, 'present', clip);
    await page.context().close();
  }

  // 4. Share and save (polars, planets): Share copies a link that carries the notebook; File opens
  // and saves .ipynb
  if (wanted('share')) {
    mouse = { x: 800, y: 560 };
    const page = await openTutor(browser, `/polars/${cellsQuery([
      { type: 'code', source: 'import polars as pl' },
      { type: 'code', source: "planets = pl.DataFrame({\n    'planet': ['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn'],\n    'diameter_km': [4879, 12104, 12756, 6792, 142984, 120536],\n})" },
      { type: 'code', source: 'big = planets.filter(pl.col("diameter_km") > 10_000)\nbig' },
    ])}`, 44);
    await page.locator('.run-button').click();
    await idle(page);
    await sleep(900);
    const clip = await capture(page, async (camera) => {
      await sleep(1100);
      const share = page.locator('.share-button');
      const file = page.locator('.export-button');
      camera.to(await around(file, share, page.locator('.examples-button')), { ms: 900, pad: 150 });
      await sleep(350);
      await click(page, share);
      await page.waitForSelector('.share-popover');
      await sleep(300);
      camera.to(await around(page.locator('.share-popover'), share), { ms: 700, pad: 30 });
      await sleep(1000);
      const marks = { poster: now() };
      await sleep(1400);
      await click(page, file);
      await page.waitForSelector('.export-menu-list');
      await sleep(250);
      camera.to(await around(page.locator('.export-menu-list'), file), { ms: 700, pad: 30 });
      await sleep(600);
      await moveTo(page, page.locator('.export-menu-item', { hasText: 'Open notebook' }));
      await sleep(800);
      await moveTo(page, page.locator('.export-menu-item', { hasText: 'Save notebook' }));
      await sleep(1400);
      await click(page, file);
      camera.to(null, { ms: 1000 });
      await sleep(1400);
      return marks;
    });
    await film(browser, 'share', clip);
    await page.context().close();
  }

  await browser.close();
} finally {
  server.kill();
}
