// Hub interactions: the theme toggle and the animated where() step. No runtime loads here.

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
  if (!demo || !status) return;
  const source = [...demo.querySelectorAll<HTMLTableRowElement>('table:not(.result) tbody tr')];
  const result = [...demo.querySelectorAll<HTMLTableRowElement>('table.result tbody tr')];
  const finalStatus = status.innerHTML;

  const showFinal = () => {
    source.forEach((row) => row.classList.add(row.dataset.keep === 'true' ? 'kept' : 'dropped'));
    result.forEach((row) => row.classList.add('shown'));
    status.innerHTML = finalStatus;
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
      status.textContent = 'Checking each row: is Flavor chocolate?';
      await sleep(900);

      for (const [i, row] of source.entries()) {
        if (id !== run) return;
        const flavor = row.cells[0].textContent;
        const keep = row.dataset.keep === 'true';
        row.classList.add('checking');
        status.textContent = `Row ${i + 1} of ${source.length}: ${flavor} ${keep ? '= chocolate, keep' : '≠ chocolate, drop'}`;
        await sleep(650);
        row.classList.remove('checking');
        row.classList.add(keep ? 'kept' : 'dropped');
        await sleep(150);
      }

      for (const row of result) {
        if (id !== run) return;
        row.classList.add('shown');
        await sleep(280);
      }
      status.textContent = `${result.length} of ${source.length} rows kept.`;
      await sleep(3200);
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
