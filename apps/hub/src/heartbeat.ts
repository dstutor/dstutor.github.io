// Kernel heartbeat: while the hero cell runs (In [*]:), square rings of the hero's dot grid
// light up around its prompt, one ring per beat, stepping outward a dot at a time and fading as
// they spread. When the run finishes, one last ring goes out in Cel's color for the outcome
// (teal when it worked, coral for an error) and then the grid rests. The canvas sits over the
// CSS dot grid and only draws while a ring is alive.

/** The hero's dot grid: background-size in style.css, one dot centred in each tile */
const GRID = 18;
const DOT = 4;
/** How far a ring travels, in dots, how long each step takes, and how often a beat comes */
const REACH = 16;
const STEP_MS = 65;
const BEAT_MS = 950;

interface Ring {
  born: number;
  color: string;
  /** The finishing ring is a little brighter than the beats */
  strength: number;
}

export function setupHeartbeat(hero: HTMLElement, cell: HTMLElement, origin: HTMLElement): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-pulse';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const fit = () => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(hero.clientWidth * dpr);
    canvas.height = Math.round(hero.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  new ResizeObserver(fit).observe(hero);

  const color = (name: string, fallback: string) => getComputedStyle(hero).getPropertyValue(name).trim() || fallback;
  let running = false;
  let lastBeat = -Infinity;
  let rings: Ring[] = [];
  let frame = 0;

  const dot = (gx: number, gy: number) => ctx.fillRect(GRID / 2 + gx * GRID - DOT / 2, GRID / 2 + gy * GRID - DOT / 2, DOT, DOT);

  const draw = (now: number) => {
    frame = 0;
    if (running && now - lastBeat >= BEAT_MS) {
      rings.push({ born: now, color: color('--accent', '#f37726'), strength: 0.65 });
      lastBeat = now;
    }
    ctx.clearRect(0, 0, hero.clientWidth, hero.clientHeight);

    // The centre: the grid dot nearest the prompt
    const heroBox = hero.getBoundingClientRect();
    const box = origin.getBoundingClientRect();
    const cx = Math.round((box.left + box.width / 2 - heroBox.left - GRID / 2) / GRID);
    const cy = Math.round((box.top + box.height / 2 - heroBox.top - GRID / 2) / GRID);

    rings = rings.filter((ring) => {
      // Stepped, a whole dot at a time, so it reads as pixels rather than a smooth wave
      const r = Math.floor((now - ring.born) / STEP_MS) + 1;
      if (r >= REACH) return false;
      if (r < 1) return true;
      ctx.fillStyle = ring.color;
      ctx.globalAlpha = ring.strength * (1 - r / REACH) ** 1.5;
      for (let i = -r; i <= r; i++) {
        dot(cx + i, cy - r);
        dot(cx + i, cy + r);
        dot(cx - r, cy + i);
        dot(cx + r, cy + i);
      }
      return true;
    });
    ctx.globalAlpha = 1;
    if (running || rings.length > 0) frame = requestAnimationFrame(draw);
  };
  const wake = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };

  // heroCell.ts marks the cell is-running for exactly as long as the prompt shows In [*]:
  new MutationObserver(() => {
    running = cell.classList.contains('is-running');
    if (running) lastBeat = -Infinity;
    wake();
  }).observe(cell, { attributes: true, attributeFilter: ['class'] });

  // ...and announces how each run ended: one last ring in that color, then rest
  cell.addEventListener('cell-finished', (event) => {
    const ok = (event as CustomEvent<{ ok: boolean }>).detail.ok;
    rings.push({
      born: performance.now(),
      color: ok ? color('--cel-done', '#0f9d94') : color('--cel-error', '#f0634f'),
      strength: 0.9,
    });
    wake();
  });
}
