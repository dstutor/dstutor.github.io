// Cel watches the pointer: the pupils of the header logo, and of the hero's Cel while it is
// resting, lean a few units toward it. Both blink now and then. Offsets use the CSS `translate`
// property so they add to cel.css's own state transforms instead of replacing them.

/** Furthest the pupils move, in the SVG's own units (the viewBox is 120 wide) */
const REACH = 5;

interface Watcher {
  svg: SVGSVGElement;
  pupils: SVGElement[];
  /** Whether the pupils should follow right now (the hero's Cel only does at rest) */
  active: () => boolean;
}

export function setupCelEyes(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const logo = document.querySelector<SVGSVGElement>('.brand .logo');
  const cel = document.querySelector<SVGSVGElement>('#demo-cel');
  const watchers: Watcher[] = [];
  if (logo) watchers.push({ svg: logo, pupils: [...logo.querySelectorAll<SVGElement>('.logo-eye, .logo-glint')], active: () => true });
  if (cel) {
    watchers.push({
      svg: cel,
      pupils: [...cel.querySelectorAll<SVGElement>('.cel-eyes, .cel-glints')],
      active: () => ['done', 'brand'].includes(cel.dataset.state ?? ''),
    });
  }
  if (watchers.length === 0) return;

  // Follow a mouse or pen; a touch screen has no pointer to watch
  if (window.matchMedia('(pointer: fine)').matches) {
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const update = () => {
      frame = 0;
      for (const w of watchers) {
        let offset = '0px 0px';
        if (pointer && w.active()) {
          const box = w.svg.getBoundingClientRect();
          const dx = pointer.x - (box.left + box.width / 2);
          const dy = pointer.y - (box.top + box.height / 2);
          const dist = Math.hypot(dx, dy) || 1;
          // Full reach once the pointer is a little way off; gentler right next to Cel
          const k = Math.min(dist / 160, 1) * REACH;
          offset = `${((dx / dist) * k).toFixed(2)}px ${((dy / dist) * k).toFixed(2)}px`;
        }
        for (const p of w.pupils) p.style.translate = offset;
      }
    };
    window.addEventListener(
      'pointermove',
      (event) => {
        pointer = { x: event.clientX, y: event.clientY };
        if (!frame) frame = requestAnimationFrame(update);
      },
      { passive: true },
    );
    document.documentElement.addEventListener('pointerleave', () => {
      pointer = null;
      if (!frame) frame = requestAnimationFrame(update);
    });
    // The hero's Cel changes state on its own; recentre its eyes when it starts working
    if (cel) {
      new MutationObserver(() => {
        if (!frame) frame = requestAnimationFrame(update);
      }).observe(cel, { attributes: true, attributeFilter: ['data-state'] });
    }
  }

  // A blink every few seconds, at slightly different moments for each Cel; only at rest, so a
  // working Cel never looks eyeless
  for (const w of watchers) {
    const blink = () => {
      if (!document.hidden && w.active()) {
        w.svg.classList.add('is-blinking');
        setTimeout(() => w.svg.classList.remove('is-blinking'), 150);
      }
      setTimeout(blink, 3500 + Math.random() * 4000);
    };
    setTimeout(blink, 1500 + Math.random() * 3000);
  }
}
