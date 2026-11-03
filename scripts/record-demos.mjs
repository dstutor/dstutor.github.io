// Records the short clips on the hub's "Every tutor is a notebook" cards from the real tutor, so
// they always show the tutor as it is. Drives the built site in Chrome with a drawn cursor (screen
// recordings do not show the real one), captures the frames Chrome paints, and encodes each clip
// with ffmpeg: cropped to the part the card is about, 960x600 H.264, plus a poster image.
// Chrome's screencast paints at the window's own size, so the window is large (1600x1000) and
// each crop is about 960 pixels wide or more: clips are scaled down, never up.
//
//   npm run record:demos      (builds first; needs ffmpeg and Chrome installed)
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
const VIEW = { width: 1600, height: 1000 };
const SCALE = 1;
const SIZE = { width: 960, height: 600 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function moveTo(page, locator, steps = 28) {
  const box = await locator.boundingBox();
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
async function click(page, locator) {
  await moveTo(page, locator);
  await sleep(180);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}

/** Capture the frames Chrome paints while act() runs; returns them with their timestamps */
async function capture(page, act) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE });
  // Nudge a repaint so the clip starts with a frame
  await page.mouse.move(mouse.x, mouse.y);
  const t0 = Date.now() / 1000;
  const marks = await act();
  // Chrome only sends a frame when something repaints, so a still ending would be cut short:
  // the last frame lasts until the action actually ended
  const end = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  return { frames, t0, end, marks: marks ?? {} };
}

/** Encode captured frames: constant 30 fps, the given crop or zoom filter, 960x600 */
function encode(name, { frames, end }, filter) {
  const dir = mkdtempSync(join(tmpdir(), `demo-${name}-`));
  const lines = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const file = join(dir, `${String(i).padStart(5, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    const next = frames[i + 1];
    lines.push(`file '${file}'`, `duration ${(next ? next.t - f.t : Math.max(0.1, end - f.t)).toFixed(4)}`);
  });
  // The concat demuxer needs the last file repeated for its duration to count
  lines.push(`file '${join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
  writeFileSync(join(dir, 'list.txt'), lines.join('\n'));
  const vf = `fps=30,${filter},scale=${SIZE.width}:${SIZE.height}:flags=lanczos,format=yuv420p`;
  const mp4 = join(OUT, `${name}.mp4`);
  const run = (args) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${frames.length} frames in ${dir}, filter ${vf}`);
  };
  run(['-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', vf, '-c:v', 'libx264', '-preset', 'slow', '-crf', '25',
    '-movflags', '+faststart', '-an', mp4]);
  // The poster is the last frame: the finished result, for reduced motion and before the clip loads
  run(['-sseof', '-0.2', '-i', mp4, '-frames:v', '1', '-q:v', '3', join(OUT, `${name}.jpg`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`wrote apps/hub/src/demos/${name}.mp4 (${frames.length} frames)`);
}

/** A crop of the page, in CSS pixels, widened to the clip's 16:10 */
function cropOf(rect) {
  const w = Math.round(rect.width * SCALE);
  const h = Math.round((w * SIZE.height) / SIZE.width);
  return `crop=${w}:${h}:${Math.round(rect.x * SCALE)}:${Math.round(rect.y * SCALE)}`;
}

async function openTutor(browser, query, notebookWidth) {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await context.addInitScript(installCursor);
  await context.addInitScript((w) => {
    localStorage.setItem('theme', 'jupyter');
    localStorage.setItem('notebookWidthPercent', String(w));
  }, notebookWidth);
  const page = await context.newPage();
  await page.goto(`${BASE}/datascience/${query}`);
  await page.waitForSelector('.status.ready', { timeout: 180000 });
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(400);
  return page;
}
const idle = (page) =>
  page.waitForFunction(() => !document.querySelector('.run-button[disabled]') && document.querySelector('.status.ready'), null, { timeout: 120000 });

const CELLS = [
  { type: 'code', source: 'from datascience import *' },
  { type: 'code', source: "cones = Table().with_columns(\n    'Flavor', make_array('chocolate', 'vanilla', 'chocolate'),\n    'Price', make_array(4.75, 4.25, 5.25))" },
  { type: 'code', source: "chocolate = cones.where('Flavor', 'chocolate')\nchocolate" },
];

// On 127.0.0.1 explicitly: dstutor.org is mapped there, and localhost can resolve to IPv6
// and Vite's host check has to let dstutor.org through
const server = spawn('npx', ['vite', 'preview', '--outDir', 'site', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'dstutor.org' },
});
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

  // 1. The notebook: Run all fills the prompts and outputs, cell by cell
  {
    mouse = { x: 900, y: 700 };
    const page = await openTutor(browser, `?cells=${encodeURIComponent(encodeURIComponent(JSON.stringify(CELLS)))}`, 78);
    const panel = await page.locator('.notebook-panel').boundingBox();
    const clip = await capture(page, async () => {
      await sleep(500);
      await click(page, page.locator('.toolbar-button', { hasText: /^Run all$/ }));
      await idle(page);
      await sleep(1800);
    });
    // The cells, not the whole panel: the code is short and the rest of the row is empty
    encode('notebook', clip, cropOf({ x: panel.x, y: 0, width: Math.min(panel.width, 980) }));
    await page.context().close();
  }

  // 2. Stepping through: Next walks the where() step frame by frame
  {
    mouse = { x: 900, y: 800 };
    const page = await openTutor(browser, '?example=filter-rows', 30);
    await page.locator('.run-button').click();
    await idle(page);
    await sleep(800);
    const panel = await page.locator('.trace-panel').boundingBox();
    const clip = await capture(page, async () => {
      await sleep(500);
      for (let i = 0; i < 3; i++) {
        await click(page, page.getByRole('button', { name: /^Next/ }));
        await sleep(1500);
      }
      await sleep(600);
    });
    encode('steps', clip, cropOf({ x: panel.x, y: panel.y, width: panel.width }));
    await page.context().close();
  }

  // 3. Present: close on the button, click, then pull back to the full-window presentation
  {
    mouse = { x: 1250, y: 330 };
    const page = await openTutor(browser, '?example=filter-rows', 45);
    await page.locator('.run-button').click();
    await idle(page);
    await sleep(800);
    const present = page.locator('.present-button');
    const box = await present.boundingBox();
    const clip = await capture(page, async () => {
      await sleep(400);
      await click(page, present);
      const clicked = Date.now() / 1000;
      await page.waitForSelector('.presentation');
      await sleep(1600);
      // Step through in the presentation, as a lecturer would
      for (let i = 0; i < 2; i++) {
        await click(page, page.locator('.presentation').getByRole('button', { name: /^Next/ }));
        await sleep(1500);
      }
      return { clicked };
    });
    // Zoomed 1.8x on the button until just after the click, then out to the whole window over 1.2 s
    const zoomStart = Math.max(0, Math.round((clip.marks.clicked - clip.frames[0].t + 0.25) * 30));
    const zoomEnd = zoomStart + 36;
    const z = `if(lt(on,${zoomStart}),1.8,if(lt(on,${zoomEnd}),1.8-0.8*(on-${zoomStart})/${zoomEnd - zoomStart},1))`;
    const cx = (box.x + box.width / 2) * SCALE;
    const cy = (box.y + box.height / 2) * SCALE;
    const zoom = `zoompan=z='${z}':x='max(0,min(iw-iw/zoom,${cx}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,${cy}-ih/zoom/2))':d=1:s=${VIEW.width * SCALE}x${VIEW.height * SCALE}:fps=30`;
    encode('present', clip, zoom);
    await page.context().close();
  }

  // 4. Share: the link is copied and the popover says what it carries
  {
    mouse = { x: 1150, y: 420 };
    // A narrow notebook, so the crop of the header's right end shows only the visualization side
    const page = await openTutor(browser, '?example=filter-rows', 30);
    const header = await page.locator('.header').boundingBox();
    const clip = await capture(page, async () => {
      await sleep(400);
      await click(page, page.locator('.share-button'));
      await page.waitForSelector('.share-popover');
      await sleep(2600);
    });
    const width = 1000;
    encode('share', clip, cropOf({ x: header.x + header.width - width, y: 0, width }));
    await page.context().close();
  }

  await browser.close();
} finally {
  server.kill();
}
