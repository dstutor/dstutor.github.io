import { useRef, useEffect, useState, useCallback, type ReactNode, createContext, useContext } from 'react';
import { Editor } from '@monaco-editor/react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { RunOutput } from '@dstutor/trace-schema';
import { ensureMonaco } from './editorAvailability';
import CellOutput from './CellOutput';
import './NotebookCells.css';

export type CellType = 'code' | 'markdown';
/** What code cells are written in; Monaco highlights each */
export type CellLanguage = 'python' | 'sql';

/** One cell of the notebook */
export interface NotebookCell {
  id: string;
  type: CellType;
  source: string;
  /** Code cells: output of the most recent run */
  output?: RunOutput;
  /** Code cells: execution counter shown as In [n] / Out[n]; undefined until the cell has run */
  execCount?: number;
  /** Markdown cells: false while the source is being edited, true once rendered */
  rendered?: boolean;
}

export type EditorTheme = 'data8-dark' | 'data8-light';

interface NotebookCellsProps {
  cells: NotebookCell[];
  onCellChange: (id: string, source: string) => void;
  onPatchCell: (id: string, patch: Partial<NotebookCell>) => void;
  onRunCell: (id: string) => void;
  /** Insert a new cell at `index`; returns its id so the notebook can select it */
  onInsertCell: (index: number, type: CellType) => string;
  onDeleteCell: (id: string) => void;
  /** Restore the most recently deleted cell; returns its id, or null if nothing to restore */
  onUndoDelete: () => string | null;
  onCopyCell: (id: string) => void;
  /** Paste the copied cell at `index`; returns the new id, or null if the clipboard is empty */
  onPasteCell: (index: number) => string | null;
  onSetCellType: (id: string, type: CellType) => void;
  /** Move the cell one position up (-1) or down (+1) */
  onMoveCell: (id: string, delta: -1 | 1) => void;
  /** Merge the cell with the one below it; returns false if there is none */
  onMergeCell: (id: string) => boolean;
  /** Split the cell's source at a character offset; returns the id of the new (second) cell */
  onSplitCell: (id: string, offset: number) => string | null;
  onInterrupt: () => void;
  onRestartKernel: () => void;
  /** id of the cell currently executing, or null */
  runningCellId: string | null;
  /** False only when Python failed to load; while it is still loading, runs are queued */
  kernelAvailable: boolean;
  /** Embedded view: cells can be run and stepped through but not edited or rearranged */
  readOnly?: boolean;
  /** Lines (1-based, inclusive) of the statement behind the visualization's current step */
  highlight?: { cellId: string; start: number; end: number } | null;
  onEditorWillMount?: (monaco: typeof import('monaco-editor')) => void;
  editorTheme?: EditorTheme;
  /** The language code cells are written in (Monaco's highlighting): Python, or SQL */
  language?: CellLanguage;
  /** Told whenever the selected cell changes (the toolbar's cell-type dropdown follows it) */
  onSelectionChange?: (id: string | null) => void;
  /** Library-specific checklist shown under a cell's error (e.g. which import to start with) */
  errorHints?: ReactNode;
}

/** Modifier key for the run shortcut: ⌘ on Apple platforms, Ctrl elsewhere (matches Monaco's CtrlCmd) */
const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
export const MOD_KEY = IS_APPLE ? '⌘' : 'Ctrl';
export const RUN_SHORTCUT = `${IS_APPLE ? 'Cmd' : 'Ctrl'}+Enter`;

/** Two-key chords (d d, i i, 0 0) must be completed within this window */
const CHORD_MS = 800;

/**
 * Whether the bundled Monaco editor is usable: null while loading, false if it failed (older
 * browsers), in which case cells use a plain textarea that still runs and highlights nothing.
 */
function useMonacoAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    ensureMonaco().then(ok => { if (alive) setAvailable(ok); });
    return () => { alive = false; };
  }, []);
  return available;
}

/** iOS Safari zooms the page when focusing text below 16px, so use a larger editor font on phones */
function useIsNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Editor-side chords shared by code and markdown cells. Returns true when handled. */
interface EditKeyActions {
  onEscape: () => void;
  onRun: () => void;
  onRunAdvance: () => void;
  onRunInsert: () => void;
  onMove: (delta: -1 | 1) => void;
  /** Ctrl+Shift+-: split at the cursor; the cell reports where its cursor is */
  onSplit: (offset: number) => void;
}

function handleEditKeys(e: React.KeyboardEvent, actions: EditKeyActions): boolean {
  if (e.key === 'Escape') {
    // Like Jupyter: Esc first closes an open completion or parameter popup, then leaves edit mode
    const popupOpen = (e.currentTarget as HTMLElement).querySelector('.suggest-widget.visible, .parameter-hints-widget.visible');
    if (popupOpen) return false;
    actions.onEscape();
  } else if (e.key === 'Enter' && e.shiftKey) {
    actions.onRunAdvance();
  } else if (e.key === 'Enter' && e.altKey) {
    actions.onRunInsert();
  } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    actions.onRun();
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    actions.onMove(e.key === 'ArrowUp' ? -1 : 1);
  } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '-' || e.key === '_' || e.code === 'Minus')) {
    actions.onSplit(cursorOffset(e.currentTarget as HTMLElement));
  } else {
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

/** Character offset of the caret in the focused editor inside `root` (Monaco or a textarea) */
function cursorOffset(root: HTMLElement): number {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && root.contains(active) && active.classList.contains('markdown-input')) {
    return active.selectionStart;
  }
  const editor = editorForRoot.get(root);
  if (editor) {
    const pos = editor.getPosition();
    const model = editor.getModel();
    if (pos && model) return model.getOffsetAt(pos);
  }
  return 0;
}

/** Monaco instances by the wrapper element they live in, for cursorOffset() */
const editorForRoot = new WeakMap<HTMLElement, MonacoEditor.IStandaloneCodeEditor>();

/** What a code cell is called: "Code", or "SQL" in the SQL tutor */
const CodeLabel = createContext('Code');

interface InsertRowProps {
  onInsert: (type: CellType) => void;
  disabled: boolean;
}

function InsertRow({ onInsert, disabled }: InsertRowProps) {
  const codeLabel = useContext(CodeLabel);
  return (
    <div className="cell-insert">
      <button type="button" className="insert-btn" onClick={() => onInsert('code')} disabled={disabled} title={`Insert a ${codeLabel === 'Code' ? 'code' : codeLabel} cell below (b)`}>
        <PlusIcon />
        <span>{codeLabel}</span>
      </button>
      <button type="button" className="insert-btn" onClick={() => onInsert('markdown')} disabled={disabled} title="Insert a markdown cell below">
        <PlusIcon />
        <span>Markdown</span>
      </button>
    </div>
  );
}

interface CodeCellProps {
  cell: NotebookCell;
  selected: boolean;
  isRunning: boolean;
  anyRunning: boolean;
  canDelete: boolean;
  editorTheme: EditorTheme;
  fontSize: number;
  onEditorWillMount?: (monaco: typeof import('monaco-editor')) => void;
  onChange: (source: string) => void;
  onSelect: () => void;
  onEditFocus: () => void;
  keys: EditKeyActions;
  onRun: () => void;
  kernelAvailable: boolean;
  readOnly: boolean;
  /** Lines to mark as the source of the current visualization step */
  highlightLines: { start: number; end: number } | null;
  /** false: render a plain textarea instead of Monaco (editor chunk unavailable or still loading) */
  richEditor: boolean;
  onDelete: () => void;
  onInsertBelow: (type: CellType) => void;
  onMount: (editor: MonacoEditor.IStandaloneCodeEditor) => void;
  errorHints?: ReactNode;
  language: CellLanguage;
}

function CodeCell({
  cell,
  selected,
  isRunning,
  anyRunning,
  canDelete,
  editorTheme,
  fontSize,
  onEditorWillMount,
  onChange,
  onSelect,
  onEditFocus,
  keys,
  onRun,
  kernelAvailable,
  readOnly,
  highlightLines,
  richEditor,
  onDelete,
  onInsertBelow,
  onMount,
  errorHints,
  language,
}: CodeCellProps) {
  const [editorHeight, setEditorHeight] = useState(60);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const monacoRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);

  // Mark the statement the visualization is showing (without scrolling to it)
  useEffect(() => {
    const editor = monacoRef.current;
    if (!editor) return;
    if (!decorationsRef.current) decorationsRef.current = editor.createDecorationsCollection();
    if (!highlightLines) {
      decorationsRef.current.clear();
      return;
    }
    decorationsRef.current.set([{
      range: { startLineNumber: highlightLines.start, startColumn: 1, endLineNumber: highlightLines.end, endColumn: 1 },
      options: { isWholeLine: true, className: 'trace-line', linesDecorationsClassName: 'trace-line-gutter' },
    }]);
    // Highlight only: no scrolling, so stepping through the visualization never moves the reader
  }, [highlightLines]);
  // Keep the latest callback reachable from the Monaco listener registered once on mount
  const editFocusRef = useRef(onEditFocus);
  editFocusRef.current = onEditFocus;

  // The cell always fits its content (like a notebook cell); the panel scrolls, not the editor
  const updateHeight = useCallback((editor: MonacoEditor.IStandaloneCodeEditor) => {
    const padding = 20;
    setEditorHeight(Math.round(Math.max(60, editor.getContentHeight() + padding)));
    if (editor.hasTextFocus()) {
      requestAnimationFrame(() => {
        wrapperRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
  }, []);

  const prompt = isRunning ? 'In [*]:' : `In [${cell.execCount ?? ' '}]:`;

  return (
    <div className={`nb-cell code-cell ${selected ? 'selected' : ''} ${isRunning ? 'is-running' : ''}`} data-cell-id={cell.id}>
      <div className="cell-row">
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div className="cell-prompt" onMouseDown={(e) => { e.preventDefault(); onSelect(); }}>
          <span className="prompt-label">{prompt}</span>
          <div className="cell-gutter-actions">
            <button
              type="button"
              className="gutter-btn gutter-btn-run"
              onClick={onRun}
              disabled={!kernelAvailable || anyRunning}
              title={`Run cell (${RUN_SHORTCUT})`}
              aria-label="Run cell"
            >
              <PlayIcon />
            </button>
            {canDelete && (
              <button
                type="button"
                className="gutter-btn gutter-btn-delete"
                onClick={onDelete}
                disabled={anyRunning}
                title="Delete cell (d d)"
                aria-label="Delete cell"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        </div>
        {/* Intercept the run chords before Monaco's own Ctrl+Enter (insert line) binding sees them */}
        <div
          className="cell-editor"
          ref={wrapperRef}
          onKeyDownCapture={(e) => {
            if (handleEditKeys(e, keys)) return;
            // Tab after a name or a dot opens completions (Jupyter's behaviour); elsewhere Tab indents,
            // and with the list already open Monaco's own Tab accepts the highlighted entry
            if (e.key === 'Tab' && !e.shiftKey && monacoRef.current) {
              const editor = monacoRef.current;
              const popupOpen = e.currentTarget.querySelector('.suggest-widget.visible');
              const pos = editor.getPosition();
              if (!popupOpen && pos) {
                const before = editor.getModel()?.getLineContent(pos.lineNumber).slice(0, pos.column - 1) ?? '';
                if (/[\w.]$/.test(before)) {
                  e.preventDefault();
                  e.stopPropagation();
                  editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
                }
              }
            }
          }}
        >
          {!richEditor ? (
            <textarea
              className="code-fallback"
              value={cell.source}
              onChange={(e) => onChange(e.target.value)}
              onFocus={onEditFocus}
              readOnly={isRunning || readOnly}
              rows={Math.max(2, cell.source.split('\n').length)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={language === 'sql' ? 'SQL' : 'Code'}
            />
          ) : (
          <Editor
            height={editorHeight}
            defaultLanguage={language}
            value={cell.source}
            beforeMount={onEditorWillMount}
            onChange={(value) => onChange(value || '')}
            onMount={(editor) => {
              monacoRef.current = editor;
              if (wrapperRef.current) editorForRoot.set(wrapperRef.current, editor);
              if (highlightLines) {
                decorationsRef.current = editor.createDecorationsCollection([{
                  range: { startLineNumber: highlightLines.start, startColumn: 1, endLineNumber: highlightLines.end, endColumn: 1 },
                  options: { isWholeLine: true, className: 'trace-line', linesDecorationsClassName: 'trace-line-gutter' },
                }]);
              }
              onMount(editor);
              updateHeight(editor);
              // Fires for edits, new values (examples, shared links) and word-wrap changes on resize
              editor.onDidContentSizeChange(() => updateHeight(editor));
              editor.onDidFocusEditorText(() => editFocusRef.current());
            }}
            theme={editorTheme}
            options={{
              minimap: { enabled: false },
              fontSize,
              lineNumbers: 'off',
              glyphMargin: false,
              folding: false,
              lineDecorationsWidth: 16,
              lineNumbersMinChars: 0,
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              scrollbar: { vertical: 'hidden', horizontal: 'auto', alwaysConsumeMouseWheel: false },
              fixedOverflowWidgets: true, // suggest/hover widgets escape the cell's overflow clipping
              // Like Jupyter: completions only on Tab (see the wrapper's key handler), never while typing
              wordBasedSuggestions: 'off',
              quickSuggestions: false,
              suggestOnTriggerCharacters: false,
              acceptSuggestionOnEnter: 'on',
              tabCompletion: 'off',
              suggest: { showWords: false, preview: false, snippetsPreventQuickSuggestions: true },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              readOnly: isRunning || readOnly,
              tabSize: 4,
              wordWrap: 'on',
              // Wrap at spaces and after commas, not inside 4.75 or pl.col(...) as the default does
              wordWrapBreakAfterCharacters: ' \t})]?|&,;',
              padding: { top: 10, bottom: 10 },
            }}
          />
          )}
        </div>
      </div>
      {cell.output && <CellOutput key={cell.execCount ?? 0} output={cell.output} execCount={cell.execCount} errorHints={errorHints} />}
      <InsertRow onInsert={onInsertBelow} disabled={anyRunning} />
    </div>
  );
}

interface MarkdownCellProps {
  cell: NotebookCell;
  selected: boolean;
  editing: boolean;
  anyRunning: boolean;
  canDelete: boolean;
  onChange: (source: string) => void;
  onSelect: () => void;
  onEdit: () => void;
  onEditFocus: () => void;
  keys: EditKeyActions;
  onDelete: () => void;
  onInsertBelow: (type: CellType) => void;
  onMount: (el: HTMLTextAreaElement | null) => void;
}

function MarkdownCell({
  cell,
  selected,
  editing,
  anyRunning,
  canDelete,
  onChange,
  onSelect,
  onEdit,
  onEditFocus,
  keys,
  onDelete,
  onInsertBelow,
  onMount,
}: MarkdownCellProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  // Register the textarea once per edit session (a ref callback would re-fire on every render)
  useEffect(() => {
    onMountRef.current(editing ? textareaRef.current : null);
  }, [editing]);

  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (editing) resize();
  }, [editing, cell.source, resize]);

  return (
    <div className={`nb-cell md-cell ${selected ? 'selected' : ''} ${editing ? 'is-editing' : ''}`} data-cell-id={cell.id}>
      <div className="cell-row">
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
        <div className="cell-prompt" onMouseDown={(e) => { e.preventDefault(); onSelect(); }}>
          <div className="cell-gutter-actions">
            {editing && (
              <button type="button" className="gutter-btn gutter-btn-run" onClick={keys.onRun} title="Render (Shift+Enter)" aria-label="Render markdown">
                <PlayIcon />
              </button>
            )}
            {canDelete && (
              <button type="button" className="gutter-btn gutter-btn-delete" onClick={onDelete} disabled={anyRunning} title="Delete cell (d d)" aria-label="Delete cell">
                <CloseIcon />
              </button>
            )}
          </div>
        </div>
        <div className="cell-body">
          {editing ? (
            <textarea
              ref={textareaRef}
              className="markdown-input"
              value={cell.source}
              onChange={(e) => { onChange(e.target.value); resize(); }}
              onFocus={onEditFocus}
              onKeyDown={(e) => handleEditKeys(e, keys)}
              placeholder="Write text in **Markdown**. Shift+Enter renders it."
              rows={3}
              spellCheck="false"
            />
          ) : (
            <div
              className="markdown-preview-only"
              role="button"
              tabIndex={-1}
              onClick={onSelect}
              onDoubleClick={onEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); onEdit(); }
              }}
              aria-label="Double-click or press Enter to edit"
              title="Double-click to edit"
            >
              {cell.source.trim() ? (
                <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {cell.source}
                </ReactMarkdown>
              ) : (
                <span className="markdown-preview-placeholder">Empty markdown cell. Double-click to edit.</span>
              )}
            </div>
          )}
        </div>
      </div>
      <InsertRow onInsert={onInsertBelow} disabled={anyRunning} />
    </div>
  );
}

export default function NotebookCells({
  cells,
  onCellChange,
  onPatchCell,
  onRunCell,
  onInsertCell,
  onDeleteCell,
  onUndoDelete,
  onCopyCell,
  onPasteCell,
  onSetCellType,
  onMoveCell,
  onMergeCell,
  onSplitCell,
  onInterrupt,
  onRestartKernel,
  runningCellId,
  kernelAvailable,
  readOnly = false,
  highlight = null,
  onEditorWillMount,
  editorTheme = 'data8-light',
  errorHints,
  language = 'python',
  onSelectionChange,
}: NotebookCellsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorsRef = useRef(new Map<string, MonacoEditor.IStandaloneCodeEditor>());
  const textareasRef = useRef(new Map<string, HTMLTextAreaElement>());
  const [selectedId, setSelectedId] = useState<string | null>(cells[0]?.id ?? null);
  /** Cell whose editor should receive focus once it exists (new cell, or Enter on a markdown cell) */
  const [pendingEdit, setPendingEdit] = useState<string | null>(null);
  /** Bumped whenever an editor mounts, so a pending focus can be retried once its editor exists */
  const [mountTick, setMountTick] = useState(0);
  const chordRef = useRef<{ key: string; at: number } | null>(null);
  const selectionChangeRef = useRef(onSelectionChange);
  selectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    selectionChangeRef.current?.(selectedId);
  }, [selectedId]);
  const isNarrowScreen = useIsNarrowScreen();
  const monacoAvailable = useMonacoAvailable();
  const anyRunning = runningCellId !== null;

  // Keep the selection valid as cells come and go
  useEffect(() => {
    if (cells.length === 0) return;
    if (!selectedId || !cells.some(c => c.id === selectedId)) {
      setSelectedId(cells[0].id);
    }
  }, [cells, selectedId]);

  const indexOf = useCallback((id: string | null) => cells.findIndex(c => c.id === id), [cells]);

  /** Command mode: the notebook container holds focus and single keys act on the selected cell */
  const enterCommandMode = useCallback((id?: string) => {
    if (id) setSelectedId(id);
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  /** Edit mode: focus the cell's editor (Monaco, or the markdown textarea, un-rendering it first) */
  const enterEditMode = useCallback((id: string) => {
    setSelectedId(id);
    const cell = cells.find(c => c.id === id);
    if (!cell) return;
    if (readOnly && cell.type === 'markdown') return;
    if (cell.type === 'code') {
      const editor = editorsRef.current.get(id);
      if (editor) {
        editor.focus();
        return;
      }
    } else if (cell.rendered !== false) {
      onPatchCell(id, { rendered: false });
    } else {
      const ta = textareasRef.current.get(id);
      if (ta) {
        ta.focus();
        return;
      }
    }
    setPendingEdit(id);
  }, [cells, onPatchCell, readOnly]);

  // Focus an editor that was not mounted yet when edit mode was requested
  useEffect(() => {
    if (!pendingEdit) return;
    const cell = cells.find(c => c.id === pendingEdit);
    if (!cell) {
      setPendingEdit(null);
      return;
    }
    const target = cell.type === 'code' ? editorsRef.current.get(pendingEdit) : textareasRef.current.get(pendingEdit);
    if (!target) return;
    target.focus();
    setPendingEdit(null);
  }, [pendingEdit, cells, mountTick]);

  // Keep the selected cell in view when navigating from the keyboard
  useEffect(() => {
    if (!selectedId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-cell-id="${selectedId}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const selectRelative = useCallback((delta: number) => {
    const idx = indexOf(selectedId);
    const next = cells[Math.max(0, Math.min(cells.length - 1, idx + delta))];
    if (next) setSelectedId(next.id);
  }, [cells, selectedId, indexOf]);

  const runCell = useCallback((id: string) => {
    const cell = cells.find(c => c.id === id);
    if (!cell) return;
    if (cell.type === 'markdown') {
      onPatchCell(id, { rendered: true });
    } else {
      onRunCell(id);
    }
  }, [cells, onPatchCell, onRunCell]);

  /** Shift+Enter: run, then select the next cell (creating one at the end, like a notebook) */
  const runAndAdvance = useCallback((id: string) => {
    runCell(id);
    const idx = indexOf(id);
    if (idx === cells.length - 1) {
      const newId = onInsertCell(idx + 1, 'code');
      setSelectedId(newId);
      setPendingEdit(newId);
    } else {
      enterCommandMode(cells[idx + 1].id);
    }
  }, [runCell, indexOf, cells, onInsertCell, enterCommandMode]);

  /** Alt+Enter: run, then insert a new cell below and edit it */
  const runAndInsert = useCallback((id: string) => {
    runCell(id);
    const newId = onInsertCell(indexOf(id) + 1, 'code');
    setSelectedId(newId);
    setPendingEdit(newId);
  }, [runCell, indexOf, onInsertCell]);

  const insertAt = useCallback((index: number, type: CellType, edit: boolean) => {
    const newId = onInsertCell(index, type);
    setSelectedId(newId);
    if (edit) setPendingEdit(newId);
    else enterCommandMode(newId);
  }, [onInsertCell, enterCommandMode]);

  const deleteCell = useCallback((id: string) => {
    if (cells.length <= 1) return;
    const idx = indexOf(id);
    const neighbour = cells[idx + 1] ?? cells[idx - 1];
    onDeleteCell(id);
    if (neighbour) enterCommandMode(neighbour.id);
  }, [cells, indexOf, onDeleteCell, enterCommandMode]);

  const splitCell = useCallback((id: string, offset: number) => {
    const newId = onSplitCell(id, offset);
    if (newId) {
      setSelectedId(newId);
      setPendingEdit(newId);
    }
  }, [onSplitCell]);

  const keyActionsFor = useCallback((id: string): EditKeyActions => ({
    onEscape: () => enterCommandMode(id),
    onRun: () => { runCell(id); enterCommandMode(id); },
    onRunAdvance: () => runAndAdvance(id),
    onRunInsert: () => runAndInsert(id),
    onMove: (delta) => onMoveCell(id, delta),
    onSplit: (offset) => splitCell(id, offset),
  }), [enterCommandMode, runCell, runAndAdvance, runAndInsert, onMoveCell, splitCell]);

  /** Jupyter command-mode shortcuts; only active while the container itself has focus */
  const handleCommandKey = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== containerRef.current || !selectedId) return;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      if (e.key === 'Enter' && !e.altKey) {
        runCell(selectedId);
      } else if (e.key === 'Enter' && e.altKey) {
        runAndInsert(selectedId);
      } else if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        onMoveCell(selectedId, e.key === 'ArrowUp' ? -1 : 1);
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      onMergeCell(selectedId);
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const idx = indexOf(selectedId);
    const now = Date.now();
    const chord = chordRef.current && now - chordRef.current.at < CHORD_MS ? chordRef.current.key : null;
    chordRef.current = null;
    if (readOnly && !['Enter', 'ArrowUp', 'ArrowDown', 'j', 'k'].includes(e.key)) return;
    let handled = true;

    switch (e.key) {
      case 'Enter':
        if (e.shiftKey) runAndAdvance(selectedId);
        else enterEditMode(selectedId);
        break;
      case 'ArrowUp':
      case 'k':
        selectRelative(-1);
        break;
      case 'ArrowDown':
      case 'j':
        selectRelative(1);
        break;
      case 'a':
        insertAt(idx, 'code', false);
        break;
      case 'b':
        insertAt(idx + 1, 'code', false);
        break;
      case 'm':
        onSetCellType(selectedId, 'markdown');
        break;
      case 'y':
        onSetCellType(selectedId, 'code');
        break;
      case 'x':
        onCopyCell(selectedId);
        deleteCell(selectedId);
        break;
      case 'c':
        onCopyCell(selectedId);
        break;
      case 'v': {
        const newId = onPasteCell(idx + 1);
        if (newId) enterCommandMode(newId);
        break;
      }
      case 'V': {
        const newId = onPasteCell(idx);
        if (newId) enterCommandMode(newId);
        break;
      }
      case 'z': {
        const restored = onUndoDelete();
        if (restored) enterCommandMode(restored);
        break;
      }
      case 'd':
        if (chord === 'd') deleteCell(selectedId);
        else chordRef.current = { key: 'd', at: now };
        break;
      case 'i':
        if (chord === 'i') onInterrupt();
        else chordRef.current = { key: 'i', at: now };
        break;
      case '0':
        if (chord === '0') onRestartKernel();
        else chordRef.current = { key: '0', at: now };
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, [selectedId, indexOf, runCell, runAndInsert, runAndAdvance, enterEditMode, selectRelative, insertAt, onSetCellType, onCopyCell, deleteCell, onPasteCell, enterCommandMode, onUndoDelete, onInterrupt, onRestartKernel, onMoveCell, onMergeCell, readOnly]);

  return (
    <CodeLabel.Provider value={language === 'sql' ? 'SQL' : 'Code'}>
    {/* The container is the focus target for command mode; its keys act on the selected cell. */}
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions */}
    <div className={`notebook-cells-container ${readOnly ? 'is-readonly' : ''}`} ref={containerRef} tabIndex={0} onKeyDown={handleCommandKey} role="list" aria-label="Notebook cells">
      {cells.map((cell, index) => {
        const selected = cell.id === selectedId;
        const common = {
          selected,
          anyRunning,
          canDelete: cells.length > 1,
          onChange: (source: string) => onCellChange(cell.id, source),
          onSelect: () => enterCommandMode(cell.id),
          onEditFocus: () => setSelectedId(cell.id),
          keys: keyActionsFor(cell.id),
          onDelete: () => deleteCell(cell.id),
          onInsertBelow: (type: CellType) => insertAt(index + 1, type, true),
        };
        return cell.type === 'code' ? (
          <CodeCell
            key={cell.id}
            cell={cell}
            {...common}
            isRunning={runningCellId === cell.id}
            kernelAvailable={kernelAvailable}
            readOnly={readOnly}
            highlightLines={highlight && highlight.cellId === cell.id ? { start: highlight.start, end: highlight.end } : null}
            richEditor={monacoAvailable === true}
            editorTheme={editorTheme}
            fontSize={isNarrowScreen ? 13 : 14}
            onEditorWillMount={onEditorWillMount}
            errorHints={errorHints}
            language={language}
            onRun={() => runCell(cell.id)}
            onMount={(editor) => {
              editorsRef.current.set(cell.id, editor);
              setMountTick(t => t + 1);
            }}
          />
        ) : (
          <MarkdownCell
            key={cell.id}
            cell={cell}
            {...common}
            editing={cell.rendered === false}
            onEdit={() => enterEditMode(cell.id)}
            onMount={(el) => {
              if (el) {
                textareasRef.current.set(cell.id, el);
                setMountTick(t => t + 1);
              } else {
                textareasRef.current.delete(cell.id);
              }
            }}
          />
        );
      })}

      <div className="notebook-hint">
        <span><kbd>Esc</kbd> command mode</span>
        <span><kbd>Enter</kbd> edit</span>
        <span><kbd>Shift</kbd><kbd>Enter</kbd> run, next</span>
        <span><kbd>{MOD_KEY}</kbd><kbd>Enter</kbd> run</span>
        <span><kbd>a</kbd>/<kbd>b</kbd> cell above/below</span>
        <span><kbd>d</kbd><kbd>d</kbd> delete</span>
        <span><kbd>m</kbd>/<kbd>y</kbd> markdown/code</span>
        <span><kbd>z</kbd> undo delete</span>
        <span><kbd>{MOD_KEY}</kbd><kbd>Shift</kbd><kbd>↑</kbd>/<kbd>↓</kbd> move cell</span>
        <span><kbd>Shift</kbd><kbd>M</kbd> merge with below</span>
        <span><kbd>{MOD_KEY}</kbd><kbd>Shift</kbd><kbd>-</kbd> split at cursor</span>
        <span><kbd>0</kbd><kbd>0</kbd> restart kernel</span>
      </div>
    </div>
    </CodeLabel.Provider>
  );
}
