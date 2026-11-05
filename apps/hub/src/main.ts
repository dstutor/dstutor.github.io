// Hub interactions: the theme toggle and the hero's notebook cell. No runtime loads here.
import '@fontsource-variable/manrope/wght.css';
import { setupHeroCell } from './heroCell';
import { setupHeartbeat } from './heartbeat';
import { setupCelEyes } from './celEyes';

const THEME_KEY = 'dstutor-theme';

// A switch labelled "Dark theme": on in dark, off in light.
function setupThemeToggle(): void {
  const button = document.getElementById('theme-toggle');
  if (!button) return;
  const label = () => {
    button.setAttribute('aria-checked', String(document.documentElement.dataset.theme === 'dark'));
  };
  label();
  button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage can be blocked (private windows); the toggle still works for this visit.
    }
    label();
  });
}

// The header's Tutors link becomes a dropdown of every tutor (without the script it jumps to
// the tutor cards). A disclosure: Escape or a click elsewhere closes it.
function setupTutorsMenu(): void {
  const button = document.getElementById('tutors-button');
  const menu = document.getElementById('tutors-menu');
  if (!button || !menu) return;
  button.setAttribute('role', 'button');
  button.setAttribute('aria-expanded', 'false');
  let open = false;
  const setOpen = (next: boolean) => {
    open = next;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', (event) => {
    event.preventDefault();
    setOpen(!open);
  });
  // A link with role=button should also answer Space, like a button
  button.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
      setOpen(!open);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open) {
      setOpen(false);
      button.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (open && !menu.parentElement?.contains(event.target as Node)) setOpen(false);
  });
}

// The feature cards' clips loop like GIFs while they are on screen and stop when not. Each card's
// button (or a click on its clip) pauses and resumes it. With reduced motion none plays until the
// reader presses its play button.
function setupFeatureClips(): void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const card of document.querySelectorAll<HTMLElement>('.feature')) {
    const video = card.querySelector<HTMLVideoElement>('.feature-clip');
    const button = card.querySelector<HTMLButtonElement>('.feature-pause');
    if (!video || !button) continue;
    const title = card.querySelector('.feature-title')?.textContent ?? 'this feature';
    // The script plays it; native controls were only for a page without it
    video.removeAttribute('controls');
    button.hidden = false;
    let onScreen = false;
    let paused = reduced;
    const sync = () => {
      if (onScreen && !paused) video.play().catch(() => {});
      else video.pause();
      button.classList.toggle('is-paused', paused);
      button.setAttribute('aria-label', `${paused ? 'Play' : 'Pause'} the clip: ${title}`);
    };
    const toggle = () => {
      paused = !paused;
      sync();
    };
    button.addEventListener('click', toggle);
    video.addEventListener('click', toggle);
    new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        sync();
      },
      { threshold: 0.5 },
    ).observe(video);
    sync();
  }
}

setupThemeToggle();
setupTutorsMenu();
setupFeatureClips();
setupHeroCell();
const hero = document.querySelector<HTMLElement>('.hero');
const cell = document.getElementById('demo-cell');
const prompt = document.getElementById('demo-prompt');
if (hero && cell && prompt) setupHeartbeat(hero, cell, prompt);
setupCelEyes();
