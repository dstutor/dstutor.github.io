// The hero's notebook cell. It runs itself the way the tutor does (In [ ] -> In [*] while Cel
// checks each row -> In [n]) until a visitor edits it; then Shift+Enter or the run button runs
// their code. whereDemo.ts interprets cones.where(...) on the table in the page.
import type { CelState } from '@dstutor/brand';
import { evaluate, parseCell, type Column, type Evaluated, type Query } from './whereDemo';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEYWORDS = new Set(['from', 'import', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is', 'lambda', 'def', 'return', 'if', 'else', 'for']);

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Jupyter-style highlighting for the overlay behind the textarea */
function highlight(code: string): string {
  const token = /(#[^\n]*)|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?)|\b(\d+\.?\d*|\.\d+)\b|\b([A-Za-z_]\w*)\b|(==|!=|<=|>=|[=<>+\-*/%])/g;
  let html = '';
  let last = 0;
  for (const m of code.matchAll(token)) {
    html += escapeHtml(code.slice(last, m.index));
    const [text, comment, str, num, word, op] = m;
    const cls = comment ? 'tok-comment' : str ? 'tok-str' : num ? 'tok-num' : op ? 'tok-op' : word && KEYWORDS.has(word) ? 'tok-kw' : '';
    html += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
    last = m.index + text.length;
  }
  // A trailing newline needs a character after it, or the overlay is a line shorter than the textarea
  return html + escapeHtml(code.slice(last)) + (code.endsWith('\n') ? ' ' : '');
}

// The tutor's own words for a where() step (tracers/datascience/tracer.py)
const stepText = {
  checking: (label: string) => `where checks every row's '${label}' value against the condition.`,
  keeping: (kept: number, removed: number) =>
    `Keep the ${kept} row${kept === 1 ? '' : 's'} that satisfy the condition; the other ${removed} (struck through) are removed.`,
  done: (kept: number, removed: number) => `Filtered rows. Kept ${kept}, removed ${removed}.`,
};

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
  if (!cell || !prompt || !runButton || !editor || !code || !highlighted || !out || !viz) return;
  if (!progress || !status || !demo || !cel || !resultCaption) return;

  const sourceTable = demo.querySelector<HTMLTableElement>('table:not(.result)');
  const resultBody = demo.querySelector<HTMLTableSectionElement>('table.result tbody');
  if (!sourceTable || !resultBody) return;
  const header = sourceTable.querySelector<HTMLTableRowElement>('thead tr');
  const headerCells = [...sourceTable.querySelectorAll<HTMLTableCellElement>('thead th')];
  const rows = [...sourceTable.querySelectorAll<HTMLTableRowElement>('tbody tr')];
  const labels = headerCells.map((th) => th.textContent ?? '');
  // The table's columns, read from the page: numbers where every value is one
  const columns: Column[] = labels.map((label, c) => {
    const shown = rows.map((row) => row.cells[c].textContent ?? '');
    const numeric = shown.every((s) => s.trim() !== '' && !Number.isNaN(Number(s)));
    return { label, shown, values: numeric ? shown.map(Number) : shown };
  });
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Editing: a textarea over a highlighted copy of the same text
  editor.classList.add('is-editable');
  code.hidden = false;
  runButton.hidden = false;
  // The script drives the row states from here on; without it the page shows the finished step
  demo.classList.add('is-animated');
  const syncHighlight = () => {
    highlighted.innerHTML = highlight(code.value);
  };
  syncHighlight();

  const setCel = (state: CelState) => cel.setAttribute('data-state', state);
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

  let count = 1;
  /** Tell heartbeat.ts a run finished, and how */
  const finished = (ok: boolean) => cell.dispatchEvent(new CustomEvent('cell-finished', { detail: { ok } }));
  const setPrompt = (value: ' ' | '*' | number) => {
    prompt.textContent = `In [${value}]:`;
    cell.classList.toggle('is-running', value === '*');
  };

  /** The column being checked, highlighted like the tutor's input_highlights */
  const markColumn = (label: string | null) => {
    const c = label === null ? -1 : labels.indexOf(label);
    headerCells.forEach((th, i) => th.classList.toggle('is-checked', i === c));
    rows.forEach((row) => [...row.cells].forEach((td, i) => td.classList.toggle('is-checked', i === c)));
  };

  const resetRows = () => rows.forEach((row) => row.classList.remove('checking', 'kept', 'dropped'));

  /** Fill the result table with the kept rows, hidden until shown */
  const fillResult = (keep: boolean[], caption: string, shown: boolean) => {
    resultCaption.textContent = caption;
    resultBody.replaceChildren();
    const kept = rows.filter((_, i) => keep[i]);
    for (const row of kept) {
      const copy = document.createElement('tr');
      for (const td of row.cells) copy.append(Object.assign(document.createElement('td'), { textContent: td.textContent }));
      if (shown) copy.classList.add('shown');
      resultBody.append(copy);
    }
    if (kept.length === 0) {
      const empty = document.createElement('tr');
      empty.className = 'empty shown';
      empty.append(Object.assign(document.createElement('td'), { colSpan: labels.length, textContent: 'No rows' }));
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
  const showDone = (query: Query, result: Evaluated) => {
    const kept = result.keep.filter(Boolean).length;
    resetRows();
    rows.forEach((row, i) => row.classList.add(result.keep[i] ? 'kept' : 'dropped'));
    markColumn(query.label);
    fillResult(result.keep, query.target ?? `Out[${count}]`, true);
    progress.textContent = `${rows.length} of ${rows.length} rows checked`;
    status.textContent = stepText.done(kept, rows.length - kept);
    setCel('done');
    moveCelTo(header);
  };

  /** Play the step row by row; false if a newer run took over */
  let token = 0;
  const play = async (query: Query, result: Evaluated, mine: number): Promise<boolean> => {
    const live = () => mine === token;
    const kept = result.keep.filter(Boolean).length;
    setPrompt('*');
    clearOutput();
    await sleep(450);
    if (!live()) return false;

    // The new step starts from the untouched table, with an empty result
    resetRows();
    markColumn(query.label);
    fillResult(result.keep, query.target ?? `Out[${count}]`, false);
    setCel('running');
    moveCelTo(header);
    status.textContent = stepText.checking(query.label);
    progress.textContent = `0 of ${rows.length} rows checked`;
    viz.classList.remove('is-cleared');
    await sleep(900);

    for (const [i, row] of rows.entries()) {
      if (!live()) return false;
      const keep = result.keep[i];
      progress.textContent = `Row ${i + 1} of ${rows.length}: ${result.reasons[i]}, ${keep ? 'keep' : 'remove'}`;
      setCel('running');
      moveCelTo(row);
      row.classList.add('checking');
      await sleep(800);
      row.classList.remove('checking');
      row.classList.add(keep ? 'kept' : 'dropped');
      if (!keep) setCel('removed');
      // Hold the crossed-out face long enough to read before moving on
      await sleep(keep ? 300 : 650);
    }
    if (!live()) return false;

    setCel('grouped');
    moveCelTo(header);
    progress.textContent = `${rows.length} of ${rows.length} rows checked`;
    status.textContent = stepText.keeping(kept, rows.length - kept);
    for (const row of resultBody.rows) {
      if (!live()) return false;
      row.classList.add('shown');
      await sleep(420);
    }
    await sleep(1200);
    if (!live()) return false;
    setPrompt(count);
    showDone(query, result);
    finished(true);
    return true;
  };

  /** Run whatever is in the cell, like Shift+Enter in a notebook */
  const runCell = async () => {
    const mine = ++token;
    const parsed = parseCell(code.value, labels);
    if (parsed.kind === 'unsupported') {
      setPrompt(' ');
      viz.classList.remove('is-cleared');
      showOutput('note', 'This preview runs one <code>cones.where(...)</code> on the <code>cones</code> table.');
      return;
    }
    count += 1;
    if (parsed.kind === 'empty') {
      setPrompt(count);
      showOutput(null);
      viz.hidden = true;
      return;
    }
    const result = parsed.kind === 'query' ? evaluate(parsed.query, columns.find((c) => c.label === parsed.query.label)!) : null;
    const error = parsed.kind === 'error' ? parsed.message : result && 'error' in result ? result.error : null;
    if (error !== null || parsed.kind !== 'query' || !result || 'error' in result) {
      setPrompt(count);
      showOutput('error', `<pre>${escapeHtml(error ?? '')}</pre>`);
      finished(false);
      return;
    }
    if (reduceMotion) {
      showOutput(null);
      viz.classList.remove('is-cleared');
      setPrompt(count);
      showDone(parsed.query, result);
    } else {
      await play(parsed.query, result, mine);
    }
  };

  // Until someone edits, the cell replays its own example while it is on screen
  let edited = false;
  const example = parseCell(code.value, labels);
  const exampleQuery = example.kind === 'query' ? example.query : null;
  const exampleResult = exampleQuery ? evaluate(exampleQuery, columns.find((c) => c.label === exampleQuery.label)!) : null;
  if (!exampleQuery || !exampleResult || 'error' in exampleResult) return;

  const autoplay = async (mine: number) => {
    while (mine === token && !edited) {
      count = 1;
      // A cell that has not run has no output
      setPrompt(' ');
      clearOutput();
      await sleep(1400);
      if (mine !== token || edited) return;
      if (!(await play(exampleQuery, exampleResult, mine))) return;
      await sleep(4500);
    }
  };

  const finishExample = () => {
    showOutput(null);
    viz.classList.remove('is-cleared');
    setPrompt(count);
    showDone(exampleQuery, exampleResult);
  };
  finishExample();
  if (!reduceMotion) {
    new IntersectionObserver(([entry]) => {
      if (edited) return;
      const mine = ++token;
      if (entry.isIntersecting) void autoplay(mine);
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
