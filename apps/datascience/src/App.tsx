import { useState, useEffect, useRef, useCallback } from 'react';
import { NotebookCells, ipynbToJson, parseIpynb, encodeNotebook, decodeNotebook, type NotebookCell, type CellType } from '@dstutor/notebook-ui';
import { StepSlideshow, StepCard, framesFor, renderStepCanvases, saveStepsPdf, stepsZip, type Frame, type DetailLevel } from '@dstutor/viz';
import type { RunOutput, TraceRecord } from '@dstutor/trace-schema';
import './App.css';
import TracePanel from './TracePanel';
import ExamplesGallery from './ExamplesGallery';
import { InterruptedError } from '@dstutor/runtime-pyodide';
import { runtime } from './runtime';
import Cel from './Cel';
import { registerPythonCompletions, setUserNamesProvider, extractUserNames } from './completions';
import { type Example, getExampleById } from './examples';

const DEFAULT_MARKDOWN = `## How to use this notebook

- **Cells:** Click a cell's margin to select it, press **Enter** to edit and **Esc** to get back. In this mode single keys act on the selected cell, like Jupyter: **a**/**b** add a cell above/below, **d d** deletes, **m**/**y** switch it to markdown/code, **z** undoes a delete.
- **Running:** **Ctrl+Enter** (**Cmd+Enter** on Mac) runs a cell; **Shift+Enter** runs it and moves on. A table named on the last line of a cell is shown beneath it. **Run all** runs every cell top to bottom; **Restart** forgets everything the cells defined.
- **Visualize:** **Run all & visualize** runs everything and shows each Table operation step by step on the right. **Visualize** on its own shows the operations from whichever cells you have run so far. Use the arrows to step through, **Export** to save a PDF, or **Share** to copy a permanent link.`;

const DEFAULT_CELLS: Array<{ type: CellType; source: string }> = [
  { type: 'markdown', source: DEFAULT_MARKDOWN },
  { type: 'code', source: `from datascience import *` },
  { type: 'code', source: `cones = Table().with_columns(
    'Flavor', make_array('strawberry', 'chocolate', 'vanilla'),
    'Price', make_array(3.55, 4.75, 4.25)
)
cones` },
];

/** Added to the "Things to check" list under a cell's error */
const DATASCIENCE_ERROR_HINT = (
  <li>Start with <code>from datascience import *</code> so <code>Table</code>, <code>make_array</code> and <code>are</code> are available</li>
);

let cellIdCounter = 0;
function newCell(source: string, type: CellType = 'code'): NotebookCell {
  cellIdCounter += 1;
  return { id: `cell-${Date.now().toString(36)}-${cellIdCounter}`, type, source, rendered: type === 'markdown' ? true : undefined };
}

/** Cells as stored in share links and localStorage */
interface StoredCell {
  type: CellType;
  source: string;
}

function parseStoredCells(value: unknown): NotebookCell[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  // Older saves were arrays of code strings
  if (value.every(x => typeof x === 'string')) return (value as string[]).map(src => newCell(src));
  if (value.every(x => x && typeof x === 'object' && typeof (x as StoredCell).source === 'string')) {
    return (value as StoredCell[]).map(c => newCell(c.source, c.type === 'markdown' ? 'markdown' : 'code'));
  }
  return null;
}

/** An example as a notebook: its note first, then one code cell per step */
function exampleCells(example: Example): NotebookCell[] {
  return [newCell(example.markdown, 'markdown'), ...example.cells.map(src => newCell(src))];
}

const THEME_STORAGE_KEY = 'theme';

type PyodideStatus = 'loading' | 'ready' | 'error';
type AppTheme = 'berkeley' | 'jupyter';

const THEMES: AppTheme[] = ['berkeley', 'jupyter'];
const THEME_LABELS: Record<AppTheme, string> = { berkeley: 'Berkeley', jupyter: 'Jupyter' };

function readStoredTheme(): AppTheme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'berkeley' ? 'berkeley' : 'jupyter';
  } catch {
    return 'jupyter';
  }
}

/** Which panel is shown on narrow (phone) screens; ignored on desktop where both are visible */
type MobileView = 'notebook' | 'visualization';

const NOTEBOOK_WIDTH_STORAGE_KEY = 'notebookWidthPercent';
const NOTEBOOK_STORAGE_KEY = 'notebook';

function App() {
  const [cells, setCells] = useState<NotebookCell[]>(() => DEFAULT_CELLS.map(c => newCell(c.source, c.type)));
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [sharePopover, setSharePopover] = useState<{ url: string; copied: boolean } | null>(null);
  /** Bumped whenever the whole notebook is replaced (example, reset, shared link) so the cells fade in */
  const [notebookVersion, setNotebookVersion] = useState(0);
  /** Bumped whenever a new visualization is shown so the panel fades in */
  const [visualizationVersion, setVisualizationVersion] = useState(0);
  const shareUrlInputRef = useRef<HTMLInputElement>(null);
  const execCounterRef = useRef(0);
  /** Deleted cells, most recent last, for z (undo delete) */
  const deletedCellsRef = useRef<Array<{ cell: NotebookCell; index: number }>>([]);
  /** Cell copied with c / x, for v */
  const clipboardRef = useRef<NotebookCell | null>(null);
  const [output, setOutput] = useState<RunOutput>({ stdout: '', stderr: '' });
  /** Every run is traced quietly; this is the trace of everything run since the last restart or Run all */
  const sessionTraceRef = useRef<TraceRecord[]>([]);
  const sessionTraceTruncatedRef = useRef(false);
  const [isRunning, setIsRunning] = useState(false);
  const [pyodideStatus, setPyodideStatus] = useState<PyodideStatus>('loading');
  const [statusMessage, setStatusMessage] = useState('Initializing Pyodide...');
  const [showGallery, setShowGallery] = useState(false);
  const [currentExample, setCurrentExample] = useState<string>('');
  const [mobileView, setMobileView] = useState<MobileView>('notebook');
  /** Full-window visualization for lecturing (arrow keys, big type, no notebook) */
  const [presenting, setPresenting] = useState(false);
  /** Source lines of the step currently shown in the visualization, highlighted in its cell */
  const [activeSite, setActiveSite] = useState<{ cellId: string; start: number; end: number } | null>(null);
  const handleFrameChange = useCallback((frame: Frame) => {
    const { cell, site } = frame.record;
    setActiveSite(cell && site ? { cellId: cell, start: site.stmt_start, end: site.stmt_end } : null);
  }, []);
  /** Every walkthrough frame, or one result frame per operation (also governs exports) */
  const [detail, setDetail] = useState<DetailLevel>('all');
  /** ?embed=1: a read-only notebook with no chrome, for iframes in the textbook or course site */
  const [embed] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('embed') === '1';
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<AppTheme>(readStoredTheme);
  const [notebookWidthPercent, setNotebookWidthPercent] = useState(() => {
    if (typeof localStorage === 'undefined') return 45;
    const stored = localStorage.getItem(NOTEBOOK_WIDTH_STORAGE_KEY);
    if (stored == null) return 45;
    const n = Number(stored);
    return Number.isFinite(n) && n >= 20 && n <= 80 ? n : 45;
  });
  const mainContentRef = useRef<HTMLDivElement>(null);
  const slideshowRef = useRef<HTMLDivElement>(null);
  const exportContainerRef = useRef<HTMLDivElement>(null);
  const runTokenRef = useRef(0);
  const [isExporting, setIsExporting] = useState(false);

  // Sync theme to DOM and localStorage
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (e: MouseEvent) => {
      const el = mainContentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const next = Math.max(20, Math.min(80, ((e.clientX - rect.left) / rect.width) * 100));
      setNotebookWidthPercent(next);
      try {
        localStorage.setItem(NOTEBOOK_WIDTH_STORAGE_KEY, String(next));
      } catch {
        /* ignore */
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const handleResizerKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' ? -2 : 2;
    setNotebookWidthPercent(prev => {
      const next = Math.max(20, Math.min(80, prev + delta));
      try {
        localStorage.setItem(NOTEBOOK_WIDTH_STORAGE_KEY, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const switchMobileView = useCallback((view: MobileView) => {
    setMobileView(view);
    window.scrollTo({ top: 0 });
  }, []);

  // Completions see the names defined anywhere in the notebook
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  useEffect(() => {
    setUserNamesProvider(() => extractUserNames(cellsRef.current.filter(c => c.type === 'code').map(c => c.source)));
  }, []);

  const handleEditorWillMount = (monaco: typeof import('monaco-editor')) => {
    registerPythonCompletions(monaco);
    monaco.editor.defineTheme('data8-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '9fb3ff' },
        { token: 'comment.doc', foreground: '9fb3ff' },
        { token: 'string', foreground: 'f6d98a' },
        { token: 'keyword', foreground: '82aaff' },
        { token: 'number', foreground: 'f6b178' }
      ],
      colors: {
        'editor.background': '#04070f',
        'editorGutter.background': '#04070f',
        'editor.lineHighlightBackground': '#0b1933',
        'editorLineNumber.foreground': '#a8b9ff',
        'editorLineNumber.activeForeground': '#d6e2ff',
        'editorCursor.foreground': '#f7f9fd',
        'editor.selectionBackground': '#213c63',
        'editorBracketMatch.background': '#1c2c4a',
        'editorBracketMatch.border': '#3f6fb3'
      }
    });
    // JupyterLab's light editor colors (its CodeMirror theme)
    monaco.editor.defineTheme('data8-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '408080', fontStyle: 'italic' },
        { token: 'comment.doc', foreground: '408080', fontStyle: 'italic' },
        { token: 'string', foreground: 'ba2121' },
        { token: 'keyword', foreground: '008000', fontStyle: 'bold' },
        { token: 'number', foreground: '008000' },
        { token: 'delimiter', foreground: '212121' },
        { token: 'type', foreground: '212121' },
        { token: 'identifier', foreground: '212121' }
      ],
      colors: {
        'editor.background': '#f7f7f7',
        'editorGutter.background': '#f7f7f7',
        'editor.foreground': '#212121',
        'editor.lineHighlightBackground': '#f7f7f7',
        'editor.lineHighlightBorder': '#f7f7f7',
        'editorLineNumber.foreground': '#9e9e9e',
        'editorLineNumber.activeForeground': '#616161',
        'editorCursor.foreground': '#212121',
        'editor.selectionBackground': '#cfe6fb',
        'editor.inactiveSelectionBackground': '#e5e5e5',
        'editorBracketMatch.background': '#e0e0e0',
        'editorBracketMatch.border': '#bdbdbd',
        'editorIndentGuide.background': '#e0e0e0',
        'editorWidget.background': '#ffffff',
        'editorWidget.border': '#bdbdbd'
      }
    });
  };

  // Share links carry the code, markdown and example as query params. The address bar
  // itself stays clean; the link is only built when the user clicks Share.
  const buildShareUrl = useCallback(() => {
    const params = new URLSearchParams();
    params.set('n', encodeNotebook(cells.map(c => ({ type: c.type, source: c.source }))));
    if (currentExample) {
      params.set('example', currentExample);
    }
    return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  }, [cells, currentExample]);

  // On mount: a shared link wins; otherwise restore the last session from localStorage.
  // Query params are consumed and removed so the URL stays clean while editing.
  const restoredRef = useRef(false);
  useEffect(() => {
    // Runs once: the first pass consumes the URL params, so a second pass (React StrictMode in
    // development re-runs effects) must not fall through to the localStorage restore
    if (restoredRef.current) return;
    restoredRef.current = true;
    try {
      const params = new URLSearchParams(window.location.search);
      const packedParam = params.get('n');
      const cellsParam = params.get('cells'); // older links: JSON cells
      const codeParam = params.get('code'); // oldest links: a single code cell
      if (packedParam || cellsParam || codeParam) {
        let loaded: NotebookCell[] | null = null;
        if (packedParam) {
          const shared = decodeNotebook(packedParam);
          if (shared) loaded = shared.map(c => newCell(c.source, c.type));
        } else if (cellsParam) {
          loaded = parseStoredCells(JSON.parse(decodeURIComponent(cellsParam)));
        } else if (codeParam) {
          loaded = [newCell(decodeURIComponent(codeParam))];
        }
        // Older links carried the markdown note separately
        const mdParam = params.get('md');
        if (loaded && mdParam && !loaded.some(c => c.type === 'markdown')) {
          try {
            loaded = [newCell(decodeURIComponent(mdParam), 'markdown'), ...loaded];
          } catch {
            /* ignore */
          }
        }
        if (loaded) {
          setCells(loaded);
          setNotebookVersion(v => v + 1);
        }
        const exampleId = params.get('example');
        if (exampleId) {
          setCurrentExample(exampleId);
        }
        window.history.replaceState(null, '', window.location.pathname);
        return;
      }
      // A link to a gallery example by id (?example=filter-rows), used by embeds and the course site
      const exampleParam = params.get('example');
      const example = exampleParam ? getExampleById(exampleParam) : undefined;
      if (example) {
        setCells(exampleCells(example));
        setNotebookVersion(v => v + 1);
        setCurrentExample(example.title);
        if (!embed) window.history.replaceState(null, '', window.location.pathname);
        return;
      }
      if (embed) return;
      const saved = localStorage.getItem(NOTEBOOK_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { cells?: unknown; markdown?: string; example?: string };
        let loaded = parseStoredCells(parsed.cells);
        if (loaded && typeof parsed.markdown === 'string' && !loaded.some(c => c.type === 'markdown')) {
          loaded = [newCell(parsed.markdown, 'markdown'), ...loaded];
        }
        if (loaded) setCells(loaded);
        if (typeof parsed.example === 'string') setCurrentExample(parsed.example);
      }
    } catch (e) {
      console.error('Failed to restore notebook:', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the current notebook in localStorage (debounced) so a reload doesn't lose work
  useEffect(() => {
    if (embed) return;
    const timeoutId = setTimeout(() => {
      try {
        localStorage.setItem(
          NOTEBOOK_STORAGE_KEY,
          JSON.stringify({ cells: cells.map(c => ({ type: c.type, source: c.source })), example: currentExample })
        );
      } catch {
        /* ignore */
      }
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [cells, currentExample, embed]);

  // Initialize Pyodide on mount. The notebook is fully usable meanwhile: editing, examples and
  // sharing work, and a run requested before the kernel is ready is queued and starts on its own.
  useEffect(() => {
    const init = async () => {
      try {
        setStatusMessage('Loading Python (about 10 s)...');
        await runtime.init();
        pyodideStatusRef.current = 'ready';
        setPyodideStatus('ready');
        const pending = pendingRunRef.current;
        pendingRunRef.current = null;
        if (pending) {
          if (pending.kind === 'cell') void runCellRef.current(pending.id);
          else void runAllRef.current(pending.visualize);
        } else {
          setStatusMessage('Ready to run Python code!');
        }
      } catch (error) {
        // Stopped or restarted while loading: whoever stopped it starts the next load
        if (error instanceof InterruptedError) return;
        setPyodideStatus('error');
        setStatusMessage(error instanceof Error ? error.message : 'Failed to load Pyodide');
        console.error('Pyodide initialization error:', error);
      }
    };

    init();
  }, []);

  const closeShareOnEscape = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    setSharePopover(null);
    (e.currentTarget.closest('.share-menu')?.querySelector('.share-button') as HTMLElement | null)?.focus();
  };

  /** Copy the share link and open a popover that confirms it and says what the link contains */
  const handleShare = async () => {
    const url = buildShareUrl();
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (e) {
      console.error('Failed to copy link:', e);
    }
    setSharePopover({ url, copied });
    if (!copied) {
      // Clipboard blocked (e.g. insecure context): let the user copy from the field
      requestAnimationFrame(() => shareUrlInputRef.current?.select());
    }
  };

  /** File-safe name for downloads, from the current example's title */
  const downloadBaseName = () =>
    (currentExample || 'table-tutor').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'notebook';

  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** Every step card in the off-screen export container (mounted while `isExporting` is true) */
  const exportCards = () =>
    Array.from(exportContainerRef.current?.querySelectorAll<HTMLElement>('.step-card') ?? []);

  const exportSteps = (kind: 'pdf' | 'images') => {
    if (!output.trace?.length) {
      setStatusMessage('Nothing to export');
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 2000);
      return;
    }
    setStatusMessage(kind === 'pdf' ? 'Generating PDF...' : 'Rendering step images...');
    setIsExporting(true);
    // Let React mount the export container before rasterising
    setTimeout(async () => {
      try {
        // Solid background so the images read on any slide, matching the current theme
        const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-panel').trim() || '#ffffff';
        const canvases = await renderStepCanvases(exportCards(), backgroundColor);
        if (canvases.length === 0) {
          setStatusMessage('Failed to export');
          return;
        }
        if (kind === 'pdf') {
          saveStepsPdf(canvases, `${downloadBaseName()}-steps.pdf`);
          setStatusMessage('PDF downloaded');
        } else {
          triggerDownload(await stepsZip(canvases, framesFor(output.trace!, detail)), `${downloadBaseName()}-steps.zip`);
          setStatusMessage(`${canvases.length} step image${canvases.length !== 1 ? 's' : ''} downloaded`);
        }
      } catch (e) {
        console.error('Failed to export:', e);
        setStatusMessage('Failed to export');
      } finally {
        setIsExporting(false);
        setTimeout(() => setStatusMessage('Ready to run Python code!'), 2500);
      }
    }, 200);
  };

  const setCellOutput = useCallback((id: string, output: RunOutput | undefined, execCount?: number) => {
    setCells(prev => prev.map(c => (c.id === id ? { ...c, output, execCount: execCount ?? c.execCount } : c)));
  }, []);

  /** Run one cell in the shared kernel. Returns the result, or null if the run was superseded. */
  const executeCell = useCallback(async (cell: NotebookCell, token: number, trace: { enabled: boolean; reset: boolean }) => {
    setRunningCellId(cell.id);
    const result = await runtime.runCell(cell.source, { enableTracing: trace.enabled, resetTrace: trace.reset, cellId: cell.id });
    if (token !== runTokenRef.current) return null;
    execCounterRef.current += 1;
    setCellOutput(cell.id, result, execCounterRef.current);
    return result;
  }, [setCellOutput]);

  /** Show the operations traced so far in the visualization panel */
  const showSessionTrace = useCallback(() => {
    const trace = sessionTraceRef.current;
    if (trace.length === 0) {
      setStatusMessage('Nothing to visualize yet: run some cells first');
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
      return;
    }
    setOutput({ stdout: '', stderr: '', trace });
    setVisualizationVersion(v => v + 1);
    switchMobileView('visualization');
    setStatusMessage(sessionTraceTruncatedRef.current
      ? `Visualized the first ${trace.length} operations (the rest were not recorded)`
      : `Visualized ${trace.length} operation${trace.length !== 1 ? 's' : ''}`);
    setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
  }, [switchMobileView]);

  /** Wrap up a run: remember its (cumulative) trace, and show it only if asked */
  const finishRun = useCallback((result: RunOutput | null, visualize: boolean, label: string) => {
    if (!result) return;
    if (result.trace) {
      sessionTraceRef.current = result.trace;
      sessionTraceTruncatedRef.current = Boolean(result.traceTruncated);
    }
    if (result.error) {
      switchMobileView('notebook');
      setStatusMessage('Execution error, see the output under the cell');
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
    } else if (visualize) {
      showSessionTrace();
    } else {
      setStatusMessage(label);
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
    }
  }, [switchMobileView, showSessionTrace]);

  // Refs mirror the kernel state so a run started right after a restart (before React
  // re-renders the callbacks) sees the current values rather than a stale closure.
  const pyodideStatusRef = useRef<PyodideStatus>('loading');
  pyodideStatusRef.current = pyodideStatus;
  const isRunningRef = useRef(false);
  isRunningRef.current = isRunning;

  /** A run requested while Python is still loading; the latest request wins */
  type PendingRun = { kind: 'cell'; id: string } | { kind: 'all'; visualize: boolean };
  const pendingRunRef = useRef<PendingRun | null>(null);

  /** Queue a run if the kernel is still loading. Returns true when the caller should stop. */
  const deferIfLoading = useCallback((pending: PendingRun) => {
    if (pyodideStatusRef.current !== 'loading') return false;
    pendingRunRef.current = pending;
    setStatusMessage('Python is still loading; this will run as soon as it is ready');
    return true;
  }, []);

  const beginRun = useCallback(() => {
    if (pyodideStatusRef.current !== 'ready') {
      setStatusMessage('Python is not available. Try reloading the page.');
      return null;
    }
    if (isRunningRef.current) return null;
    const token = ++runTokenRef.current;
    isRunningRef.current = true;
    setIsRunning(true);
    setStatusMessage('Running...');
    return token;
  }, []);

  const endRun = useCallback((token: number) => {
    if (token === runTokenRef.current) {
      isRunningRef.current = false;
      setIsRunning(false);
      setRunningCellId(null);
    }
  }, []);

  /** Run a single cell, like Ctrl+Enter in a notebook */
  const handleRunCell = useCallback(async (id: string) => {
    const cell = cells.find(c => c.id === id);
    if (!cell) return;
    if (!cell.source.trim()) {
      setCellOutput(id, undefined);
      return;
    }
    if (deferIfLoading({ kind: 'cell', id })) return;
    const token = beginRun();
    if (token === null) return;
    try {
      finishRun(await executeCell(cell, token, { enabled: true, reset: false }), false, 'Ran cell');
    } catch (error) {
      if (token !== runTokenRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setCellOutput(id, { stdout: '', stderr: '', error: message });
      switchMobileView('notebook');
      setStatusMessage('Execution failed, see the output under the cell');
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
    } finally {
      endRun(token);
    }
  }, [cells, deferIfLoading, beginRun, executeCell, finishRun, endRun, setCellOutput, switchMobileView]);

  /**
   * Run every cell top to bottom, stopping at the first error like a notebook's Run All.
   * With `visualize`, Table operations are traced and the visualization panel shows them.
   */
  const runAll = useCallback(async (visualize: boolean) => {
    if (deferIfLoading({ kind: 'all', visualize })) return;
    const token = beginRun();
    if (token === null) return;
    sessionTraceRef.current = [];
    try {
      let last: RunOutput | null = null;
      let first = true;
      for (const cell of cells) {
        if (cell.type === 'markdown') {
          setCells(prev => prev.map(c => (c.id === cell.id ? { ...c, rendered: true } : c)));
          continue;
        }
        if (!cell.source.trim()) {
          setCellOutput(cell.id, undefined);
          continue;
        }
        const result = await executeCell(cell, token, { enabled: true, reset: first });
        first = false;
        if (!result) return;
        last = result;
        if (result.error) break;
      }
      if (last === null) sessionTraceRef.current = [];
      finishRun(last, visualize, 'Ran all cells');
    } catch (error) {
      if (token !== runTokenRef.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setOutput({ stdout: '', stderr: '', error: message });
      switchMobileView('notebook');
      setStatusMessage('Execution failed, see the output under the cell');
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
    } finally {
      endRun(token);
    }
  }, [cells, deferIfLoading, beginRun, executeCell, finishRun, endRun, setCellOutput, switchMobileView]);

  const handleRunAll = useCallback(() => runAll(false), [runAll]);
  const handleRunAllAndVisualize = useCallback(() => runAll(true), [runAll]);
  const handleVisualize = showSessionTrace;

  const handleInsertCell = useCallback((index: number, type: CellType) => {
    const cell = newCell('', type);
    if (type === 'markdown') cell.rendered = false;
    setCells(prev => {
      const next = [...prev];
      next.splice(Math.max(0, Math.min(prev.length, index)), 0, cell);
      return next;
    });
    return cell.id;
  }, []);

  const handleDeleteCell = useCallback((id: string) => {
    setCells(prev => {
      if (prev.length <= 1) return prev;
      const index = prev.findIndex(c => c.id === id);
      if (index === -1) return prev;
      deletedCellsRef.current.push({ cell: prev[index], index });
      return prev.filter(c => c.id !== id);
    });
  }, []);

  const handleUndoDelete = useCallback(() => {
    const entry = deletedCellsRef.current.pop();
    if (!entry) return null;
    const restored = { ...entry.cell, id: newCell('').id };
    setCells(prev => {
      const next = [...prev];
      next.splice(Math.min(entry.index, prev.length), 0, restored);
      return next;
    });
    return restored.id;
  }, []);

  const handleCopyCell = useCallback((id: string) => {
    const cell = cells.find(c => c.id === id);
    if (cell) clipboardRef.current = cell;
  }, [cells]);

  const handlePasteCell = useCallback((index: number) => {
    const copied = clipboardRef.current;
    if (!copied) return null;
    const pasted: NotebookCell = { ...copied, id: newCell('').id, output: undefined, execCount: undefined };
    setCells(prev => {
      const next = [...prev];
      next.splice(Math.max(0, Math.min(prev.length, index)), 0, pasted);
      return next;
    });
    return pasted.id;
  }, []);

  const handleSetCellType = useCallback((id: string, type: CellType) => {
    setCells(prev => prev.map(c => {
      if (c.id !== id || c.type === type) return c;
      return type === 'markdown'
        ? { id: c.id, type, source: c.source, rendered: false }
        : { id: c.id, type, source: c.source };
    }));
  }, []);

  const handleMoveCell = useCallback((id: string, delta: -1 | 1) => {
    setCells(prev => {
      const i = prev.findIndex(c => c.id === id);
      const j = i + delta;
      if (i === -1 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }, []);

  /** Merge with the cell below: sources joined by a blank line; the lower cell's output is dropped */
  const handleMergeCell = useCallback((id: string) => {
    const i = cells.findIndex(c => c.id === id);
    if (i === -1 || i === cells.length - 1) return false;
    const below = cells[i + 1];
    deletedCellsRef.current.push({ cell: below, index: i + 1 });
    setCells(prev => {
      const k = prev.findIndex(c => c.id === id);
      if (k === -1 || k === prev.length - 1) return prev;
      const merged: NotebookCell = {
        ...prev[k],
        source: `${prev[k].source.replace(/\s+$/, '')}\n\n${prev[k + 1].source.replace(/^\s+/, '')}`,
        output: undefined,
        execCount: undefined,
      };
      return [...prev.slice(0, k), merged, ...prev.slice(k + 2)];
    });
    return true;
  }, [cells]);

  /** Split at a character offset: text before stays, text after becomes a new cell of the same type */
  const handleSplitCell = useCallback((id: string, offset: number) => {
    const cell = cells.find(c => c.id === id);
    if (!cell) return null;
    const head = cell.source.slice(0, offset).replace(/\n+$/, '');
    const tail = cell.source.slice(offset).replace(/^\n+/, '');
    const second = newCell(tail, cell.type);
    if (cell.type === 'markdown') second.rendered = false;
    setCells(prev => {
      const k = prev.findIndex(c => c.id === id);
      if (k === -1) return prev;
      const first: NotebookCell = { ...prev[k], source: head, output: undefined, execCount: undefined };
      return [...prev.slice(0, k), first, second, ...prev.slice(k + 1)];
    });
    return second.id;
  }, [cells]);

  const handleCellChange = useCallback((id: string, source: string) => {
    setCells(prev => prev.map(c => (c.id === id ? { ...c, source } : c)));
  }, []);

  const handlePatchCell = useCallback((id: string, patch: Partial<NotebookCell>) => {
    setCells(prev => prev.map(c => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const runAllRef = useRef(runAll);
  runAllRef.current = runAll;
  const runCellRef = useRef(handleRunCell);
  runCellRef.current = handleRunCell;

  const presentationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!presenting) return;
    presentationRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPresenting(false);
    };
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setPresenting(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [presenting]);

  const startPresentation = () => {
    setPresenting(true);
    // Best effort: browsers may refuse fullscreen; the overlay works either way
    document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  // Ctrl/Cmd+Enter outside an editor runs the whole notebook (inside one, Monaco runs that cell)
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
      if ((event.target as HTMLElement | null)?.closest('.monaco-editor')) return;
      event.preventDefault();
      handleRunAll();
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [handleRunAll]);

  /** Forget what has run: clear every cell's output and In [n] label and start counting over */
  const clearRunState = useCallback(() => {
    execCounterRef.current = 0;
    sessionTraceRef.current = [];
    sessionTraceTruncatedRef.current = false;
    setActiveSite(null);
    setOutput({ stdout: '', stderr: '' });
    setCells(prev => prev.map(c => (c.type === 'code' ? { ...c, output: undefined, execCount: undefined } : c)));
  }, []);

  /**
   * Restart the kernel: names defined by cells are forgotten and outputs are cleared, but the
   * interpreter and packages stay loaded, so it is instant. Falls back to a full reload if the
   * interpreter itself is not usable.
   */
  const restartKernel = useCallback(async (message: string) => {
    runTokenRef.current = 0;
    isRunningRef.current = false;
    setIsRunning(false);
    setRunningCellId(null);
    clearRunState();
    setStatusMessage(message);
    try {
      if (pyodideStatusRef.current === 'ready') {
        await runtime.restart();
      } else {
        runtime.stop();
        pyodideStatusRef.current = 'loading';
        setPyodideStatus('loading');
        await runtime.init();
        pyodideStatusRef.current = 'ready';
        setPyodideStatus('ready');
      }
      setStatusMessage('Kernel restarted');
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 2000);
      return true;
    } catch {
      pyodideStatusRef.current = 'error';
      setPyodideStatus('error');
      setStatusMessage('Failed to restart the kernel');
      return false;
    }
  }, [clearRunState]);

  /**
   * Interrupt (i i): Python runs in a worker, which is terminated (a `while True` loop included)
   * and replaced by a fresh one. Outputs are cleared like a restart.
   */
  const handleStop = useCallback(() => {
    if (!isRunning) return;
    runTokenRef.current = 0;
    isRunningRef.current = false;
    setIsRunning(false);
    setRunningCellId(null);
    clearRunState();
    runtime.stop();
    pyodideStatusRef.current = 'loading';
    setPyodideStatus('loading');
    setStatusMessage('Interrupted. Reloading Python...');
    (async () => {
      try {
        await runtime.init();
        pyodideStatusRef.current = 'ready';
        setPyodideStatus('ready');
        setStatusMessage('Ready to run Python code!');
      } catch {
        pyodideStatusRef.current = 'error';
        setPyodideStatus('error');
        setStatusMessage('Failed to reload after interrupt');
      }
    })();
  }, [isRunning, clearRunState]);

  const handleRestartKernel = useCallback(() => {
    void restartKernel('Restarting the kernel...');
  }, [restartKernel]);

  const handleRestartAndRunAll = useCallback(async () => {
    if (await restartKernel('Restarting the kernel...')) {
      void runAllRef.current(false);
    }
  }, [restartKernel]);

  /** Open a .ipynb chosen with the file picker: replaces the notebook, outputs included */
  const openIpynbInputRef = useRef<HTMLInputElement>(null);
  const handleOpenIpynb = async (file: File) => {
    try {
      const loaded = parseIpynb(await file.text(), () => newCell('').id);
      openNotebook(loaded, file.name.replace(/\.ipynb$/i, ''));
      setStatusMessage(`Opened ${file.name}`);
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 3000);
    } catch (e) {
      console.error('Failed to open notebook:', e);
      setStatusMessage(`Could not open ${file.name}: ${e instanceof Error ? e.message : 'not a notebook'}`);
      setTimeout(() => setStatusMessage('Ready to run Python code!'), 4000);
    }
  };

  /** Download the notebook as an .ipynb (nbformat 4.5) with outputs included */
  const handleExportIpynb = () => {
    triggerDownload(new Blob([ipynbToJson(cells)], { type: 'application/x-ipynb+json' }), `${downloadBaseName()}.ipynb`);
    setStatusMessage('Notebook downloaded');
    setTimeout(() => setStatusMessage('Ready to run Python code!'), 2000);
  };

  /**
   * Replace the whole notebook, like opening a new one in Jupyter: a fresh kernel (names from
   * the previous notebook are gone), counting starts at In [1], and the visualization is cleared.
   */
  const openNotebook = useCallback((nextCells: NotebookCell[], exampleTitle: string) => {
    runTokenRef.current = 0;
    isRunningRef.current = false;
    setIsRunning(false);
    setRunningCellId(null);
    pendingRunRef.current = null;
    setCells(nextCells);
    setNotebookVersion(v => v + 1);
    setCurrentExample(exampleTitle);
    execCounterRef.current = 0;
    sessionTraceRef.current = [];
    sessionTraceTruncatedRef.current = false;
    setActiveSite(null);
    setOutput({ stdout: '', stderr: '' });
    switchMobileView('notebook');
    // A kernel that is still loading is already clean; otherwise forget the previous notebook's names
    if (pyodideStatusRef.current === 'ready') {
      runtime.restart().catch(e => console.error('Failed to reset the kernel:', e));
    }
  }, [switchMobileView]);

  // Back to the starter notebook (what you see on first visit)
  const handleResetNotebook = () => openNotebook(DEFAULT_CELLS.map(c => newCell(c.source, c.type)), '');

  const handleSelectExample = (example: Example) => openNotebook(exampleCells(example), example.title);

  const stepCount = output.trace?.length ? framesFor(output.trace, detail).length : 0;

  return (
    <div className={`app ${embed ? 'is-embed' : ''}`}>
      {embed ? (
        <div className="embed-bar">
          <span className="embed-title">
            <code className="brand-code">datascience</code> Table Tutor{currentExample ? `: ${currentExample}` : ''}
          </span>
          <a className="embed-open" href={window.location.href.replace(/([?&])embed=1&?/, '$1').replace(/[?&]$/, '')} target="_blank" rel="noopener noreferrer">
            Open in Table Tutor
          </a>
        </div>
      ) : (
      <header className="header">
        <div className="header-left">
          <a className="brand" href="/" title="All tutors">
            <Cel state="brand" className="brand-cel" />
            <div className="brand-title">
              <span className="brand-name">Data Science Tutor</span>
              <code className="brand-code">datascience</code>
            </div>
          </a>
          {currentExample && (
            <span className="current-example" title={currentExample}>{currentExample}</span>
          )}
        </div>
        <div className="header-controls">
          <div className="theme-switcher" role="group" aria-label="Theme">
            {THEMES.map(t => (
              <button
                key={t}
                type="button"
                className={`theme-option ${theme === t ? 'active' : ''}`}
                onClick={() => setTheme(t)}
                aria-pressed={theme === t}
                title={`${THEME_LABELS[t]} theme`}
              >
                {THEME_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="export-menu" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setShowExportMenu(false); }}>
            <button
              className="export-button"
              onClick={() => setShowExportMenu(v => !v)}
              aria-haspopup="menu"
              aria-expanded={showExportMenu}
              title="Open or save the notebook, export the visualization"
            >
              File
              <svg className="caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <input
              ref={openIpynbInputRef}
              type="file"
              accept=".ipynb,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleOpenIpynb(file);
              }}
            />
            {showExportMenu && (
              <div className="export-menu-list rise-in" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="export-menu-item"
                  onClick={() => { setShowExportMenu(false); openIpynbInputRef.current?.click(); }}
                  title="Open a Jupyter notebook from your computer"
                >
                  <span>Open notebook (.ipynb)…</span>
                </button>
                <div className="export-menu-separator" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  className="export-menu-item"
                  onClick={() => { setShowExportMenu(false); exportSteps('pdf'); }}
                  disabled={!stepCount}
                  title={stepCount ? 'Save the step-by-step visualization as a PDF, one page per step' : 'Use Visualize first'}
                >
                  <span>Steps as PDF</span>
                  <span className="export-menu-hint">{stepCount ? `${stepCount} page${stepCount !== 1 ? 's' : ''}` : 'visualize first'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="export-menu-item"
                  onClick={() => { setShowExportMenu(false); exportSteps('images'); }}
                  disabled={!stepCount}
                  title={stepCount ? 'One PNG per step in a zip, ready to drop into slides' : 'Use Visualize first'}
                >
                  <span>Steps as PNGs (zip)</span>
                  <span className="export-menu-hint">{stepCount ? `${stepCount} PNG${stepCount !== 1 ? 's' : ''}` : 'visualize first'}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="export-menu-item"
                  onClick={() => { setShowExportMenu(false); handleExportIpynb(); }}
                  title="Download the notebook with its outputs; opens in Jupyter"
                >
                  <span>Save notebook (.ipynb)</span>
                  <span className="export-menu-hint">{cells.length} cell{cells.length !== 1 ? 's' : ''}</span>
                </button>
              </div>
            )}
          </div>
          <div
            className="share-menu"
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSharePopover(null); }}
          >
            <button
              className={`share-button ${sharePopover?.copied ? 'is-copied' : ''}`}
              onClick={handleShare}
              aria-haspopup="dialog"
              aria-expanded={sharePopover !== null}
              onKeyDown={closeShareOnEscape}
              title="Copy a link to this notebook"
            >
              {sharePopover?.copied ? 'Copied' : 'Share'}
            </button>
            {sharePopover && (
              <div className="share-popover rise-in" role="dialog" aria-label="Share link">
                <div className="share-popover-title">
                  {sharePopover.copied ? 'Permanent link copied' : 'Permanent link'}
                </div>
                <div className="share-url-row">
                  <input
                    ref={shareUrlInputRef}
                    className="share-url"
                    type="text"
                    readOnly
                    value={sharePopover.url}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={closeShareOnEscape}
                    aria-label="Share link"
                  />
                  <button type="button" className="share-copy-again" onClick={handleShare} onKeyDown={closeShareOnEscape}>
                    Copy
                  </button>
                </div>
                <p className="share-popover-body">
                  Opens a copy of these {cells.length} cells as they are now. Outputs are not included.
                </p>
              </div>
            )}
          </div>
          <button
            className="examples-button"
            onClick={() => setShowGallery(true)}
          >
            Examples
          </button>
        </div>
      </header>
      )}

      {/* Phone-only: toggle between the two panels (hidden on desktop via CSS) */}
      <div className="mobile-view-switcher" role="tablist" aria-label="Panel">
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === 'notebook'}
          className={`mobile-view-tab ${mobileView === 'notebook' ? 'active' : ''}`}
          onClick={() => switchMobileView('notebook')}
        >
          Notebook
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mobileView === 'visualization'}
          className={`mobile-view-tab ${mobileView === 'visualization' ? 'active' : ''}`}
          onClick={() => switchMobileView('visualization')}
        >
          Visualization
          {output.trace && output.trace.length > 0 && (
            <span className="mobile-view-badge">{output.trace.length}</span>
          )}
        </button>
      </div>

      <div
        ref={mainContentRef}
        className={`main-content jupyter-style mobile-view-${mobileView}`}
        style={{ ['--notebook-width' as string]: `${notebookWidthPercent}%` }}
      >
        {/* Left: Notebook (markdown + code cells) */}
        <div className="notebook-panel">
          <div className="notebook-header">
            <div className="notebook-toolbar" role="toolbar" aria-label="Kernel">
              <button
                className="run-button"
                onClick={handleRunAllAndVisualize}
                disabled={pyodideStatus === 'error' || isRunning}
                title="Run every cell top to bottom, then show each Table operation step by step"
              >
                <span className="btn-icon" aria-hidden="true">▶▶</span>
                {isRunning ? 'Running...' : 'Run all & visualize'}
              </button>
              <button
                className="toolbar-button"
                onClick={handleRunAll}
                disabled={pyodideStatus === 'error' || isRunning}
                title="Run every cell top to bottom without changing the visualization"
              >
                Run all
              </button>
              <button
                className="toolbar-button"
                onClick={handleVisualize}
                disabled={isRunning}
                title="Show the Table operations from the cells you have run since the last restart or Run all"
              >
                <span className="btn-icon" aria-hidden="true">◈</span>
                Visualize
              </button>
              <button
                className="toolbar-button icon-button stop-button"
                onClick={handleStop}
                disabled={!isRunning}
                title="Interrupt the running cell (i i)"
                aria-label="Interrupt"
              >
                <span className="btn-icon" aria-hidden="true">■</span>
              </button>
              <button
                className="toolbar-button icon-button"
                onClick={handleRestartKernel}
                disabled={pyodideStatus === 'loading'}
                title="Restart the kernel: names defined so far are forgotten and outputs cleared (0 0)"
                aria-label="Restart kernel"
              >
                <span className="btn-icon" aria-hidden="true">↻</span>
              </button>
              <button
                className="toolbar-button icon-button"
                onClick={handleRestartAndRunAll}
                disabled={pyodideStatus === 'loading'}
                title="Restart the kernel, then run every cell"
                aria-label="Restart kernel and run all"
              >
                <span className="btn-icon" aria-hidden="true">↻▶</span>
              </button>
            </div>
            <span className={`status ${pyodideStatus}`} role="status" title={statusMessage}>
              <Cel state={pyodideStatus === 'error' ? 'error' : pyodideStatus === 'loading' || isRunning ? 'running' : 'done'} />
              <span className="status-text">{statusMessage}</span>
            </span>
          </div>

          <div className="notebook-cells-wrapper fade-in" key={notebookVersion}>
            <NotebookCells
              cells={cells}
              onCellChange={handleCellChange}
              onPatchCell={handlePatchCell}
              onRunCell={handleRunCell}
              onInsertCell={handleInsertCell}
              onDeleteCell={handleDeleteCell}
              onUndoDelete={handleUndoDelete}
              onCopyCell={handleCopyCell}
              onPasteCell={handlePasteCell}
              onSetCellType={handleSetCellType}
              onMoveCell={handleMoveCell}
              onMergeCell={handleMergeCell}
              onSplitCell={handleSplitCell}
              onInterrupt={handleStop}
              onRestartKernel={handleRestartKernel}
              runningCellId={runningCellId}
              readOnly={embed}
              highlight={output.trace?.length ? activeSite : null}
              kernelAvailable={pyodideStatus !== 'error'}
              onEditorWillMount={handleEditorWillMount}
              editorTheme={theme === 'jupyter' ? 'data8-light' : 'data8-dark'}
              errorHints={DATASCIENCE_ERROR_HINT}
            />
          </div>
        </div>

        {/* ARIA "window splitter" pattern: a focusable separator is valid, but
            jsx-a11y doesn't model it */}
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
        <div
          className="panel-resizer"
          role="separator"
          aria-label="Resize panels"
          aria-orientation="vertical"
          aria-valuenow={Math.round(notebookWidthPercent)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          onMouseDown={handleResizerMouseDown}
          onKeyDown={handleResizerKeyDown}
        />
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}

        {/* Right: Visualization */}
        <TracePanel
          output={output}
          slideshowRef={slideshowRef}
          version={visualizationVersion}
          onPresent={output.trace?.length ? startPresentation : undefined}
          onFrameChange={handleFrameChange}
          detail={detail}
          onDetailChange={setDetail}
        />
      </div>

      {/* Presentation mode: the visualization alone, full window, big type; arrow keys step */}
      {presenting && output.trace && output.trace.length > 0 && (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div className="presentation fade-in" ref={presentationRef} tabIndex={0} role="dialog" aria-label="Presentation">
          <div className="presentation-bar">
            <span className="presentation-title">{currentExample || 'Table Tutor'}</span>
            <button type="button" className="presentation-exit" onClick={() => setPresenting(false)} title="Leave presentation (Esc)">
              Exit
            </button>
          </div>
          <div className="presentation-body">
            <StepSlideshow trace={output.trace} detail={detail} autoplay />
          </div>
        </div>
      )}

      {/* Hidden container for multi-step PDF export (off-screen, same layout as panel) */}
      {isExporting && output.trace && output.trace.length > 0 && (
        <div
          ref={exportContainerRef}
          className="export-pdf-container"
          style={{
            position: 'absolute',
            left: '-9999px',
            top: 0,
            width: 900,
            zIndex: -1,
          }}
        >
          {framesFor(output.trace, detail).map((frame, i) => (
            <StepCard key={i} frame={frame} />
          ))}
        </div>
      )}

      {/* Examples Gallery Modal */}
      {showGallery && (
        <ExamplesGallery
          onSelectExample={handleSelectExample}
          onReset={handleResetNotebook}
          onClose={() => setShowGallery(false)}
        />
      )}
    </div>
  );
}

export default App;

