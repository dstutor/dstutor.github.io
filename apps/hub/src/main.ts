// Hub interactions: the theme toggle and the animated where() step. No runtime loads here.
import '@dstutor/brand/cel.css';
import type { CelState } from '@dstutor/brand';

const THEME_KEY = 'dstutor-theme';

function setupThemeToggle(): void {
  const button = document.getElementById('theme-toggle');
  if (!button) return;
  const label = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Plays where('Flavor', 'chocolate') one row at a time, like a step in the tutor.
function setupWhereDemo(): void {
  const demo = document.getElementById('where-demo');
  const status = document.getElementById('cell-status');
  const cel = document.getElementById('demo-cel');
  if (!demo || !status || !cel) return;
  // Cel walks down beside the rows: running while one is checked, removed when it is
  // dropped, then back up to the header, done.
  const setCel = (state: CelState) => cel.setAttribute('data-state', state);
  const header = demo.querySelector<HTMLTableRowElement>('table:not(.result) thead tr');
  const moveCelTo = (row: HTMLTableRowElement | null) => {
    const scan = cel.parentElement;
    if (!row || !scan) return;
    const r = row.getBoundingClientRect();
    const box = cel.getBoundingClientRect();
    const y = r.top - scan.getBoundingClientRect().top + (r.height - box.height) / 2;
    cel.style.transform = `translateY(${Math.round(y)}px)`;
  };
  moveCelTo(header);
  window.addEventListener('resize', () => moveCelTo(header));
  const source = [...demo.querySelectorAll<HTMLTableRowElement>('table:not(.result) tbody tr')];
  const result = [...demo.querySelectorAll<HTMLTableRowElement>('table.result tbody tr')];
  const finalStatus = status.innerHTML;

  const showFinal = () => {
    source.forEach((row) => row.classList.add(row.dataset.keep === 'true' ? 'kept' : 'dropped'));
    result.forEach((row) => row.classList.add('shown'));
    status.innerHTML = finalStatus;
    setCel('done');
    moveCelTo(header);
  };

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    showFinal();
    return;
  }

  demo.classList.add('is-animated');
  let run = 0;

  const play = async (id: number) => {
    while (id === run) {
      source.forEach((row) => row.classList.remove('checking', 'kept', 'dropped'));
      result.forEach((row) => row.classList.remove('shown'));
      setCel('running');
      status.textContent = 'Checking each row: is Flavor chocolate?';
      await sleep(1300);

      for (const [i, row] of source.entries()) {
        if (id !== run) return;
        const flavor = row.cells[0].textContent;
        const keep = row.dataset.keep === 'true';
        setCel('running');
        moveCelTo(row);
        row.classList.add('checking');
        status.textContent = `Row ${i + 1} of ${source.length}: ${flavor} ${keep ? '= chocolate, keep' : '≠ chocolate, drop'}`;
        await sleep(1000);
        row.classList.remove('checking');
        row.classList.add(keep ? 'kept' : 'dropped');
        if (!keep) setCel('removed');
        // Hold the crossed-out face long enough to read before moving on
        await sleep(keep ? 300 : 900);
      }

      for (const row of result) {
        if (id !== run) return;
        row.classList.add('shown');
        await sleep(420);
      }
      setCel('done');
      moveCelTo(header);
      status.textContent = `${result.length} of ${source.length} rows kept.`;
      await sleep(4000);
    }
  };

  // Only animate while the cell is on screen.
  new IntersectionObserver(([entry]) => {
    run += 1;
    if (entry.isIntersecting) void play(run);
    else showFinal();
  }).observe(demo);
}

setupThemeToggle();
setupWhereDemo();
