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

setupThemeToggle();
setupHeroCell();
const hero = document.querySelector<HTMLElement>('.hero');
const cell = document.getElementById('demo-cell');
const prompt = document.getElementById('demo-prompt');
if (hero && cell && prompt) setupHeartbeat(hero, cell, prompt);
setupCelEyes();
