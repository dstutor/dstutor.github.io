import { useState, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { TableState, Highlights, Panel } from '@dstutor/trace-schema';
import Cel from './Cel';
import StagePanel from './StagePanel';
import type { CelPose } from './celPlan';
import { formatColumn, formatValue, isNumericColumn, shownText, sizeText, type TableStyle } from './tableFormat';
import './DataTransformation.css';

export { formatValue, isNumericColumn, shownText };

const DEFAULT_VISIBLE_ROWS = 10;

export interface AuxTable {
  label: string;
  state: TableState;
  highlights?: Highlights;
}

interface DataTransformationProps {
  before: TableState;
  after: TableState;
  operation: string;
  /** Shown on the arrow; defaults to operation() */
  title?: string;
  inputHighlights?: Highlights;
  outputHighlights?: Highlights;
  /** Intermediate result table shown instead of `after` while an operation is being built up */
  outputOverride?: TableState;
  auxTable?: AuxTable;
  /** Second result table, shown under the main result (e.g. the rest of a split) */
  auxOutput?: AuxTable;
  /** Heading for the result panel; defaults to After / Result (building) */
  outputLabel?: string;
  /** True when rendering a sub-step frame: disables the legacy add/remove column diff */
  isSubStep?: boolean;
  /** How the tables print, as the tutor's library prints them (default datascience) */
  tableStyle?: TableStyle;
  /** Cel beside the Before table, posed for this frame (see celPlan.ts); none when absent */
  cel?: CelPose;
  /** Draw the frame where it ends, without motion (exports) */
  still?: boolean;
  /** The stage's picture when it is not a table (keys, pairs, groups, order, plan) */
  panel?: Panel;
}

/** An array drawn the way Data 8 draws one: a strip of item blocks with their 0-based positions */
export function ArrayView({ state, highlights, caption }: { state: TableState; highlights?: Highlights; caption?: string }) {
  const items = state.preview.map(row => row[0]);
  const more = state.num_rows - items.length;
  const lit = new Set<number>([...(highlights?.rows ?? []), ...((highlights?.cells ?? []).map(([r]) => r))]);
  const wholeStrip = Boolean(highlights?.columns?.length) && lit.size === 0;

  return (
    <div className={`array-view ${wholeStrip ? 'is-lit' : ''}`}>
      {caption && <div className="array-caption">{caption}</div>}
      {items.length === 0 ? (
        <div className="array-strip array-empty"><span className="array-placeholder">nothing yet</span></div>
      ) : (
        <div className="array-strip">
          {items.map((v, i) => (
            <div key={i} className={`array-item ${lit.has(i) ? 'hl' : ''}`}>
              <span className="array-index">{i}</span>
              <span className="array-value">{formatValue(v)}</span>
            </div>
          ))}
          {more > 0 && (
            <div className="array-item array-more">
              <span className="array-index">…</span>
              <span className="array-value">+{more} more</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Leading columns that are row labels (a pandas index), shown but not counted as columns */
const indexCount = (state: TableState) => state.index_columns ?? 0;
const dataColumns = (state: TableState) => state.columns.slice(indexCount(state));
const columnCount = (state: TableState) => state.num_columns - indexCount(state);

/** The text of every cell, column by column, as the tutor's library prints it */
function useCellText(state: TableState, style: TableStyle): string[][] {
  return useMemo(
    () => state.columns.map((_, j) => formatColumn(state.preview.map(row => row[j]), style, state.column_types?.[j])),
    [state, style],
  );
}

interface TableViewProps {
  state: TableState;
  style: TableStyle;
  highlights?: Highlights;
  /** Legacy column diffing (select/drop/with_column); suppressed when sub-step highlights exist */
  addedColumns?: string[];
  removedColumns?: string[];
  /** Rows that were not there a moment ago slide in (the result side) */
  rowsEnter?: boolean;
  /** A column worked out for every row at once: its cells fill in together */
  fillColumns?: string[];
}

function TableView({ state, style, highlights, addedColumns, removedColumns, rowsEnter, fillColumns }: TableViewProps) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [state]);
  const text = useCellText(state, style);

  // Wide tables scroll sideways. Keep the highlighted cell or column in view (it is what the frame
  // is about), and shade whichever edge has more columns past it.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = () => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>('td.hl-cell, th.added-column, th.hl-col-header');
    if (target) {
      // Only scroll a column that is out of view entirely; a partly visible one stays put
      const left = target.offsetLeft;
      const right = left + target.offsetWidth;
      if (left >= el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + 12;
      else if (right <= el.scrollLeft) el.scrollLeft = Math.max(0, left - 12);
    }
    updateEdges();
  }, [state, highlights]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { columns, preview, num_rows } = state;
  const highlightRows = highlights?.rows ?? [];
  const highlightRemoved = highlights?.rows_removed ?? [];
  const highlightColumns = highlights?.columns ?? [];
  const highlightCells = highlights?.cells ?? [];
  const rowColors = highlights?.row_colors ?? [];

  // Never hide a highlighted row behind the cap
  const highlightMax = Math.max(-1, ...highlightRows, ...highlightRemoved, ...highlightCells.map(([r]) => r));
  const cap = Math.max(DEFAULT_VISIBLE_ROWS, highlightMax + 1);
  const visibleCount = expanded ? preview.length : Math.min(preview.length, cap);
  const hiddenInPreview = preview.length - visibleCount;
  const beyondPreview = num_rows - preview.length;
  const numericCols = columns.map((_, j) => isNumericColumn(preview, j));
  const labelColumns = indexCount(state);
  const types = state.column_types;
  // polars and DuckDB print each column's type under its name
  const showTypes = (style === 'polars' || style === 'duckdb') && types?.length === columns.length;

  // A row is known by its values, so one that stays keeps its place and a new one slides in
  const rowKeys = useMemo(() => {
    const seen = new Map<string, number>();
    return preview.map(row => {
      const key = JSON.stringify(row);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return `${key}#${n}`;
    });
  }, [preview]);

  const cellClass = (rowIndex: number, colIndex: number): string => {
    const col = columns[colIndex];
    const classes: string[] = [];
    if (colIndex < labelColumns) classes.push('index-cell');
    if (shownText(preview[rowIndex]?.[colIndex]) !== null) classes.push('shown-value');
    if (numericCols[colIndex]) classes.push('num');
    if (highlightCells.some(([r, c]) => r === rowIndex && c === col)) classes.push('hl-cell');
    else if (highlightColumns.includes(col)) classes.push('hl-col');
    if (removedColumns?.includes(col)) classes.push('removed-cell');
    if (addedColumns?.includes(col)) classes.push('added-cell');
    if (fillColumns?.includes(col)) classes.push('column-fills');
    return classes.join(' ');
  };
  const headerClass = (j: number, col: string) => {
    const classes: string[] = [];
    if (j < labelColumns) classes.push('index-cell');
    if (numericCols[j]) classes.push('num');
    if (highlightColumns.includes(col)) classes.push('hl-col-header');
    if (removedColumns?.includes(col)) classes.push('removed-column');
    if (addedColumns?.includes(col)) classes.push('added-column');
    return classes.join(' ');
  };

  const size = sizeText(num_rows, style === 'polars' ? state.num_columns : columnCount(state), style);
  return (
    <div className={`table-block table-${style}`}>
      {style === 'polars' && <div className="table-size">{size}</div>}
      <div className={`data-table-frame${edges.left ? ' more-left' : ''}${edges.right ? ' more-right' : ''}`}>
        <div className="data-table-wrapper" ref={scrollRef} onScroll={updateEdges}>
          <table className="data-table compact">
            <thead>
              <tr>
                {columns.map((col, j) => (
                  <th key={j} className={headerClass(j, col)}>{col}</th>
                ))}
              </tr>
              {showTypes && (
                <tr className="type-row">
                  {columns.map((col, j) => (
                    <th key={j} className={headerClass(j, col)}>{types![j]}</th>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {preview.slice(0, visibleCount).map((row, i) => {
                const rowClasses: string[] = [];
                if (highlightRows.includes(i)) rowClasses.push('hl-row');
                if (highlightRemoved.includes(i)) rowClasses.push('hl-row-removed');
                const slot = rowColors[i];
                if (slot !== null && slot !== undefined) rowClasses.push('row-keyed', `key-slot-${slot}`);
                if (rowsEnter) rowClasses.push('row-enters');
                return (
                  <tr key={rowKeys[i]} className={rowClasses.join(' ')} style={rowsEnter ? ({ '--row': Math.min(i, 8) } as CSSProperties) : undefined}>
                    {row.map((_, j) => (
                      <td key={j} className={cellClass(i, j)}>{text[j][i]}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hiddenInPreview > 0 && (
            <button className="table-more table-more-button" onClick={() => setExpanded(true)}>
              Show {hiddenInPreview} more row{hiddenInPreview !== 1 ? 's' : ''}
            </button>
          )}
          {hiddenInPreview <= 0 && beyondPreview > 0 && (
            <div className="table-more">… {beyondPreview} more row{beyondPreview !== 1 ? 's' : ''} not shown</div>
          )}
          {expanded && preview.length > DEFAULT_VISIBLE_ROWS && (
            <button className="table-more table-more-button" onClick={() => setExpanded(false)}>
              Show fewer rows
            </button>
          )}
        </div>
      </div>
      {style !== 'polars' && <div className="table-size">{size}</div>}
    </div>
  );
}

function EmptyPlaceholder({ text, subtext }: { text: string; subtext: string }) {
  return (
    <div className="data-table-wrapper centered">
      <div className="empty-table-placeholder">
        <div className="empty-text">{text}</div>
        <div className="empty-subtext">{subtext}</div>
      </div>
    </div>
  );
}

/**
 * A gutter beside a table where Cel stands level with the row (or header) it is at. Rows scrolled
 * out of the table's box leave Cel at the nearest edge.
 */
function CelLane({ pose, children }: { pose: CelPose; children: ReactNode }) {
  const { at } = pose;
  const laneRef = useRef<HTMLDivElement>(null);
  const celRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const lane = laneRef.current;
    const cel = celRef.current;
    if (!lane || !cel) return;
    const wrapper = lane.querySelector<HTMLElement>('.data-table-wrapper');
    const place = () => {
      const header = lane.querySelector('thead tr');
      const row = at === 'header' ? header : lane.querySelectorAll('tbody tr')[at] ?? header;
      if (!row || !wrapper) return;
      const top = lane.getBoundingClientRect().top;
      const box = row.getBoundingClientRect();
      const bounds = wrapper.getBoundingClientRect();
      const height = cel.getBoundingClientRect().height;
      const y = Math.min(Math.max(box.top - top + (box.height - height) / 2, bounds.top - top), bounds.bottom - top - height);
      cel.style.transform = `translateY(${Math.round(y)}px)`;
    };
    place();
    wrapper?.addEventListener('scroll', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(lane);
    return () => {
      wrapper?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [at]);

  return (
    <div className="cel-lane" ref={laneRef}>
      <Cel ref={celRef} state={pose.state} className="cel-guide" />
      {children}
    </div>
  );
}

export default function DataTransformation({
  before,
  after,
  operation,
  title,
  inputHighlights,
  outputHighlights,
  outputOverride,
  auxTable,
  auxOutput,
  outputLabel,
  isSubStep,
  tableStyle = 'datascience',
  cel,
  still = false,
  panel,
}: DataTransformationProps) {
  const [showAnimation, setShowAnimation] = useState(still);
  useEffect(() => {
    if (still) return;
    const timer = setTimeout(() => setShowAnimation(true), 60);
    return () => clearTimeout(timer);
  }, [still]);

  const output = outputOverride ?? after;
  const outputIsBuilding = outputOverride !== undefined;

  // A column worked out for every row at once (a condition's True/False, a new column) fills in
  // all together when the frame arrives, while Cel watches from the header
  const fillColumns = cel?.fills && !still ? (outputHighlights?.columns ?? []) : undefined;

  // Legacy column diffing only applies when the frame has no sub-step visuals
  const hasSubStepVisuals = Boolean(isSubStep || inputHighlights || outputHighlights || outputOverride || auxTable || auxOutput);
  const columnsRemoved = hasSubStepVisuals ? [] : dataColumns(before).filter(col => !dataColumns(after).includes(col));
  const columnsAdded = hasSubStepVisuals ? [] : dataColumns(after).filter(col => !dataColumns(before).includes(col));
  const rowsChanged = before.num_rows !== after.num_rows;

  // Table initialization (empty table → table with data)
  const isInitialization = before.num_rows === 0 && after.num_rows > 0 && (operation === 'with_columns' || operation === 'with_column');
  const isArray = after.kind === 'array';
  const resultHeading = outputLabel ?? (panel ? null : outputIsBuilding ? 'Result (building…)' : isArray ? 'Result array' : 'After');
  // A stage with a picture of its own shows it in place of the result, with a table under it only
  // when the stage has one
  const showOutputTable = !panel || outputIsBuilding;

  const beforeTable = <TableView state={before} style={tableStyle} highlights={inputHighlights} removedColumns={columnsRemoved} />;

  return (
    <div className={`data-transformation style-${tableStyle}${cel ? ' has-cel' : ''}${showAnimation ? ' animated' : ''}${still ? ' is-still' : ''}`}>
      <section className="transform-section before">
        <div className="section-header">
          <span className="section-title">Before</span>
        </div>
        {isInitialization ? (
          <EmptyPlaceholder text="Empty Table" subtext="No columns, no rows yet" />
        ) : cel ? (
          <CelLane pose={cel}>{beforeTable}</CelLane>
        ) : (
          beforeTable
        )}
        {auxTable && (
          <>
            <div className="section-header aux-header">
              <span className="section-title">{auxTable.label}</span>
            </div>
            <TableView state={auxTable.state} style={tableStyle} highlights={auxTable.highlights} />
          </>
        )}
      </section>

      <div className="transform-arrow-container">
        <div className="transform-arrow-label">{title ?? `${operation}()`}</div>
        <div className="transform-arrow" aria-hidden="true">→</div>
        <div className="transform-changes">
          {columnsRemoved.length > 0 && <div className="change-badge removed">-{columnsRemoved.length} cols</div>}
          {columnsAdded.length > 0 && <div className="change-badge added">+{columnsAdded.length} cols</div>}
          {!hasSubStepVisuals && rowsChanged && (
            <div className="change-badge">
              {after.num_rows > before.num_rows ? '+' : ''}
              {after.num_rows - before.num_rows} rows
            </div>
          )}
        </div>
      </div>

      <section className={`transform-section after${isInitialization ? ' initialization-result' : ''}`}>
        {resultHeading && (
          <div className="section-header">
            <span className="section-title">{resultHeading}</span>
          </div>
        )}
        {panel && <StagePanel panel={panel} style={tableStyle} />}
        {!showOutputTable ? null : isArray ? (
          <ArrayView state={output} highlights={outputHighlights} caption={output.columns[0]} />
        ) : output.preview.length === 0 && output.columns.length === 0 ? (
          <EmptyPlaceholder text="Empty Table" subtext="Nothing here yet" />
        ) : (
          <TableView
            state={output}
            style={tableStyle}
            highlights={outputHighlights}
            addedColumns={columnsAdded}
            rowsEnter={!still}
            fillColumns={fillColumns}
          />
        )}
        {auxOutput && (
          <>
            <div className="section-header aux-header">
              <span className="section-title">{auxOutput.label}</span>
            </div>
            {auxOutput.state.preview.length === 0 ? (
              <EmptyPlaceholder text="Not filled yet" subtext="Rows arrive in a later step" />
            ) : (
              <TableView state={auxOutput.state} style={tableStyle} highlights={auxOutput.highlights} rowsEnter={!still} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
