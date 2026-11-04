// The hero's notebook cell. It runs itself the way the tutors do (In [ ] -> In [*] while Cel
// checks each row -> In [n]) until a visitor edits it; then Shift+Enter or the run button runs
// their code. The toggle above it switches library: demoLibraries.ts holds each one's code,
// interpreter and wording, so the same filter can be watched in datascience and in pandas.
import type { CelState } from '@dstutor/brand';
import type { Column, Evaluated } from './whereDemo';
import { LIBRARIES, type DemoLibrary } from './demoLibraries';

const LIBRARY_KEY = 'dstutor-hero-library';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYWORDS = new Set(['from', 'import', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'lambda', 'def', 'return', 'if', 'else', 'for']);
/** SQL keywords, matched in any case */
const SQL_KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'AS', 'GROUP', 'BY', 'ORDER',
  'HAVING', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT', 'ON', 'USING', 'DISTINCT', 'ASC', 'DESC', 'IS', 'IN', 'LIKE', 'BETWEEN']);

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Jupyter-style highlighting for the overlay behind the textarea, for Python or SQL */
function highlight(code: string, language: 'python' | 'sql'): string {
  const sql = language === 'sql';
  // SQL: -- comments, 'text' with '' inside, and "names" (not strings, so not colored as one)
  const token = sql
    ? /(--[^\n]*)|('(?:''|[^'\n])*'?)|("(?:""|[^"\n])*"?)|\b(\d+\.?\d*|\.\d+)\b|\b([A-Za-z_]\w*)\b|(==|!=|<>|<=|>=|[=<>+\-*/%])/g
    : /(#[^\n]*)|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?)|()\b(\d+\.?\d*|\.\d+)\b|\b([A-Za-z_]\w*)\b|(==|!=|<=|>=|[=<>+\-*/%])/g;
  let html = '';
  let last = 0;
  for (const m of code.matchAll(token)) {
    html += escapeHtml(code.slice(last, m.index));
    const [text, comment, str, , num, word, op] = m;
    const keyword = word && (sql ? SQL_KEYWORDS.has(word.toUpperCase()) : KEYWORDS.has(word));
    const cls = comment ? 'tok-comment' : str ? 'tok-str' : num ? 'tok-num' : op ? 'tok-op' : keyword ? 'tok-kw' : '';
    html += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    last = m.index + text.length;
  }
  // A trailing newline needs a character after it, or the overlay is a line shorter than the textarea
  return html + escapeHtml(code.slice(last)) + (code.endsWith('\n') ? ' ' : '');
}

/** A runnable query: where it is assigned, the column it checks, and what it does to each row */
interface Step {
  target: string | null;
  label: string;
  result: Evaluated;
}

export function setupHeroCell(): void {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const cell = el('demo-cell');
  const prompt = el('demo-prompt');
  const runButton = el<HTMLButtonElement>('demo-run');
  const editor = el('demo-editor');
  const code = el<HTMLTextAreaElement>('demo-code');
  const highlighted = el('demo-highlight');
  const out = el('demo-out');
  const viz = el('demo-viz');
  const progress = el('demo-progress');
  const status = el('cell-status');
  const demo = el('where-demo');
  const cel = el('demo-cel');
  const resultCaption = el('demo-result-caption');
  const toggle = el('demo-libraries');
  const tryLink = el<HTMLAnchorElement>('hero-try');
  const tryName = el('hero-try-name');
  if (!cell || !prompt || !runButton || !editor || !code || !highlighted || !out || !viz) return;
  if (!progress || !status || !demo || !cel || !resultCaption) return;

  const sourceTable = demo.querySelector<HTMLTableElement>('table:not(.result)');
  const resultBody = demo.querySelector<HTMLTableSectionElement>('table.result tbody');
  if (!sourceTable || !resultBody) return;
  const header = sourceTable.querySelector<HTMLTableRowElement>('thead tr');
  // Index cells (.idx) belong to pandas' view; the data columns are the rest
  const dataCells = (row: HTMLTableRowElement) => [...row.cells].filter((c) => !c.classList.contains('idx'));
  const headerCells = header ? dataCells(header) : [];
  const rows = [...sourceTable.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  const labels = headerCells.map((th) => th.textContent ?? '');
  // The table's columns, read from the page: numbers where every value is one
  const columns: Column[] = labels.map((label, c) => {
    const shown = rows.map((row) => dataCells(row)[c].textContent ?? '');
    const numeric = shown.every((s) => s.trim() !== '' && !Number.isNaN(Number(s)));
    return { label, shown, values: numeric ? shown.map(Number) : shown };
  });
  const columnFor = (label: string) => columns.find((c) => c.label === label)!;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The headline's intro (style.css) plays first, and the cell fades in as its last part; the
  // cell only starts running once that has ended, so one thing moves at a time
  let introPlaying = !reduceMotion && document.documentElement.classList.contains('intro');
  const introDone = new Promise<void>((resolve) => {
    if (!introPlaying) return resolve();
    cell.addEventListener('animationend', (event) => {
      if (event.target === cell) resolve();
    });
    // In case the animation never runs (a hidden tab, say)
    setTimeout(resolve, 4500);
  }).then(() => {
    introPlaying = false;
  });

  // Editing: a textarea over a highlighted copy of the same text
  editor.classList.add('is-editable');
  code.hidden = false;
  runButton.hidden = false;
  // The script drives the row states from here on; without it the page shows the finished step
  demo.classList.add('is-animated');
  const syncHighlight = () => {
    highlighted.innerHTML = highlight(code.value, library.language);
  };

  /** New text fades in rather than snapping, so the lines above the tables do not flicker */
  const swapText = (el: HTMLElement, text: string) => {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!reduceMotion) el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
  };

  const setCel = (state: CelState) => cel.setAttribute('data-state', state);
  const moveCelTo = (row: HTMLTableRowElement | null) => {
    const scan = cel.parentElement;
    if (!row || !scan) return;
    const r = row.getBoundingClientRect();
    const box = cel.getBoundingClientRect();
    const y = r.top - scan.getBoundingClientRect().top + (r.height - box.height) / 2;
    cel.style.transform = `translateY(${Math.round(y)}px)`;
  };
  window.addEventListener('resize', () => moveCelTo(header));

  let library: DemoLibrary = LIBRARIES.datascience;
  let count = 1;
  /** Tell heartbeat.ts a run finished, and how */
  const finished = (ok: boolean) => cell.dispatchEvent(new CustomEvent('cell-finished', { detail: { ok } }));
  const setPrompt = (value: ' ' | '*' | number) => {
    prompt.textContent = `In [${value}]:`;
    cell.classList.toggle('is-running', value === '*');
  };

  /** The column being checked, highlighted like the tutors' input_highlights */
  const markColumn = (label: string | null) => {
    const c = label === null ? -1 : labels.indexOf(label);
    headerCells.forEach((th, i) => th.classList.toggle('is-checked', i === c));
    rows.forEach((row) => dataCells(row).forEach((td, i) => td.classList.toggle('is-checked', i === c)));
  };

  const resetRows = () => rows.forEach((row) => row.classList.remove('checking', 'kept', 'dropped'));

  /** Fill the result table with the kept rows (and their index labels), hidden until shown */
  const fillResult = (keep: boolean[], caption: string, shown: boolean) => {
    resultCaption.textContent = caption;
    resultBody.replaceChildren();
    const kept = rows.filter((_, i) => keep[i]);
    for (const row of kept) {
      const copy = document.createElement('tr');
      for (const td of row.cells) copy.append(Object.assign(document.createElement('td'), { textContent: td.textContent, className: td.className }));
      copy.querySelectorAll('.is-checked').forEach((td) => td.classList.remove('is-checked'));
      if (shown) copy.classList.add('shown');
      resultBody.append(copy);
    }
    if (kept.length === 0) {
      const empty = document.createElement('tr');
      empty.className = 'empty shown';
      empty.append(Object.assign(document.createElement('td'), { colSpan: rows[0].cells.length, textContent: 'No rows' }));
      resultBody.append(empty);
    }
  };

  const showOutput = (kind: 'error' | 'note' | null, html = '') => {
    out.hidden = kind === null;
    out.className = kind ? `nb-out is-${kind}` : 'nb-out';
    out.innerHTML = html;
    viz.hidden = kind !== null;
  };

  /** Like Jupyter on a rerun: the old output goes away before the new one arrives */
  const clearOutput = () => {
    showOutput(null);
    viz.classList.add('is-cleared');
  };

  /** The finished step, without animation */
  const showDone = (step: Step) => {
    const kept = step.result.keep.filter(Boolean).length;
    resetRows();
    rows.forEach((row, i) => row.classList.add(step.result.keep[i] ? 'kept' : 'dropped'));
    markColumn(step.label);
    fillResult(step.result.keep, step.target ?? `Out[${count}]`, true);
    swapText(progress, `${rows.length} of ${rows.length} rows checked`);
    swapText(status, library.done(kept, rows.length - kept));
    setCel('done');
    moveCelTo(header);
  };

  /** Play the step row by row; false if a newer run took over */
  let token = 0;
  const play = async (step: Step, mine: number): Promise<boolean> => {
    const live = () => mine === token;
    const { result } = step;
    const kept = result.keep.filter(Boolean).length;
    setPrompt('*');
    clearOutput();
    await sleep(600);
    if (!live()) return false;

    // The new step starts from the untouched table, with an empty result
    resetRows();
    markColumn(step.label);
    fillResult(result.keep, step.target ?? `Out[${count}]`, false);
    setCel('running');
    moveCelTo(header);
    swapText(status, library.checking(step.label));
    swapText(progress, `0 of ${rows.length} rows checked`);
    viz.classList.remove('is-cleared');
    await sleep(1400);

    for (const [i, row] of rows.entries()) {
      if (!live()) return false;
      const keep = result.keep[i];
      swapText(progress, `Row ${i + 1} of ${rows.length}: ${result.reasons[i]}, ${keep ? 'keep' : 'remove'}`);
      setCel('running');
      moveCelTo(row);
      row.classList.add('checking');
      await sleep(1100);
      row.classList.remove('checking');
      row.classList.add(keep ? 'kept' : 'dropped');
      if (!keep) setCel('removed');
      // Hold the crossed-out face long enough to read before moving on
      await sleep(keep ? 450 : 900);
    }
    if (!live()) return false;

    setCel('grouped');
    moveCelTo(header);
    swapText(progress, `${rows.length} of ${rows.length} rows checked`);
    swapText(status, library.keeping(kept, rows.length - kept));
    for (const row of resultBody.rows) {
      if (!live()) return false;
      row.classList.add('shown');
      await sleep(600);
    }
    await sleep(1800);
    if (!live()) return false;
    setPrompt(count);
    showDone(step);
    finished(true);
    return true;
  };

  /** Run whatever is in the cell, like Shift+Enter in a notebook */
  const runCell = async () => {
    const mine = ++token;
    const run = library.parse(code.value, labels);
    if (run.kind === 'unsupported') {
      setPrompt(' ');
      viz.classList.remove('is-cleared');
      showOutput('note', library.unsupported);
      return;
    }
    count += 1;
    if (run.kind === 'empty') {
      setPrompt(count);
      showOutput(null);
      viz.hidden = true;
      return;
    }
    const outcome = run.kind === 'query' ? run.evaluate(columnFor(run.label)) : null;
    if (run.kind === 'error' || !outcome || 'error' in outcome) {
      setPrompt(count);
      const message = run.kind === 'error' ? run.message : outcome && 'error' in outcome ? outcome.error : '';
      // DuckDB ends with the line and a caret under the spot: kept unwrapped so the caret lines up
      const [text, place] = message.split(/\n\n(?=LINE \d+: )/);
      showOutput('error', `<pre>${escapeHtml(text)}</pre>${place ? `<pre class="nb-out-place">${escapeHtml(place)}</pre>` : ''}`);
      finished(false);
      return;
    }
    const step = { target: run.target, label: run.label, result: outcome };
    if (reduceMotion) {
      showOutput(null);
      viz.classList.remove('is-cleared');
      setPrompt(count);
      showDone(step);
    } else {
      await play(step, mine);
    }
  };

  // Until someone edits, the cell replays its library's example while it is on screen
  let edited = false;
  let visible = false;
  let example: Step | null = null;

  const exampleFor = (lib: DemoLibrary): Step | null => {
    const run = lib.parse(lib.code, labels);
    if (run.kind !== 'query') return null;
    const outcome = run.evaluate(columnFor(run.label));
    return 'error' in outcome ? null : { target: run.target, label: run.label, result: outcome };
  };

  const autoplay = async (mine: number) => {
    await introDone;
    while (mine === token && !edited && example) {
      count = 1;
      // A cell that has not run has no output
      setPrompt(' ');
      clearOutput();
      await sleep(1800);
      if (mine !== token || edited) return;
      if (!(await play(example, mine))) return;
      await sleep(5500);
    }
  };

  const finishExample = () => {
    if (!example) return;
    showOutput(null);
    viz.classList.remove('is-cleared');
    setPrompt(count);
    showDone(example);
  };

  /** Show a library: its code and table view, its example finished, then replaying if on screen */
  const showLibrary = (lib: DemoLibrary) => {
    library = lib;
    example = exampleFor(lib);
    token += 1;
    edited = false;
    count = 1;
    code.value = lib.code;
    syncHighlight();
    demo.classList.toggle('show-index', lib.showIndex);
    if (tryLink && tryName) {
      tryLink.href = lib.href;
      tryName.textContent = lib.name;
    }
    toggle?.querySelectorAll<HTMLButtonElement>('[data-library]').forEach((button) => {
      const checked = button.dataset.library === lib.id;
      button.setAttribute('aria-checked', String(checked));
      // Only the chosen library is in the tab order; arrow keys move between them
      button.tabIndex = checked ? 0 : -1;
    });
    // During the intro the cell waits, not yet run, rather than showing a finished step
    if (introPlaying) {
      setPrompt(' ');
      clearOutput();
    } else {
      finishExample();
    }
    if (visible && !reduceMotion) void autoplay(++token);
  };

  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LIBRARY_KEY);
  } catch {
    // Storage blocked: start with datascience
  }
  showLibrary(LIBRARIES[stored ?? ''] ?? LIBRARIES.datascience);

  if (toggle) {
    toggle.hidden = false;
    const buttons = [...toggle.querySelectorAll<HTMLButtonElement>('[data-library]:not([disabled])')];
    const choose = (button: HTMLButtonElement) => {
      const lib = LIBRARIES[button.dataset.library ?? ''];
      if (!lib || lib === library) return;
      try {
        localStorage.setItem(LIBRARY_KEY, lib.id);
      } catch {
        // Storage blocked: the choice still holds for this visit
      }
      showLibrary(lib);
    };
    for (const button of buttons) {
      button.addEventListener('click', () => choose(button));
      // A radio group: arrow keys move between the libraries
      button.addEventListener('keydown', (event) => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        const next = buttons[(buttons.indexOf(button) + step + buttons.length) % buttons.length];
        next.focus();
        choose(next);
      });
    }
  }

  if (!reduceMotion) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (edited) return;
      const mine = ++token;
      if (visible) void autoplay(mine);
      else finishExample();
    }).observe(demo);
  }

  // The first edit stops the replay and leaves the finished example in place
  const takeOver = () => {
    if (edited) return;
    edited = true;
    token += 1;
    count = 1;
    finishExample();
  };
  code.addEventListener('focus', takeOver);
  code.addEventListener('input', () => {
    takeOver();
    syncHighlight();
  });
  code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      takeOver();
      void runCell();
    }
  });
  runButton.addEventListener('click', () => {
    takeOver();
    void runCell();
  });
}
