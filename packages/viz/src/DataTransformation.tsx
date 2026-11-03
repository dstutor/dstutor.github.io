import { useState, useEffect } from 'react';
import type { TableState, Highlights } from '@dstutor/trace-schema';
import './DataTransformation.css';

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
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(formatValue).join(', ') + ']';
  }
  // Booleans arrive as JSON true/false; show them the way Python (and the table) spells them
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return value.toString();
    }
    if (Math.abs(value) >= 1e15 || (value !== 0 && Math.abs(value) < 1e-4)) {
      return value.toPrecision(4);
    }
    return parseFloat(value.toFixed(4)).toString();
  }
  return String(value);
}

export function isNumericColumn(preview: unknown[][], colIndex: number): boolean {
  let sawNumber = false;
  for (const row of preview) {
    const v = row[colIndex];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number') return false;
    sawNumber = true;
  }
  return sawNumber;
}

interface ArrayViewProps {
  state: TableState;
  highlights?: Highlights;
  /** Where the values came from, shown as the strip's caption (e.g. the column label) */
  caption?: string;
}

/**
 * An array drawn the way Data 8 draws one: a horizontal strip of item blocks with their
 * 0-based positions, not a one-column table. `state.preview` holds one value per row.
 */
export function ArrayView({ state, highlights, caption }: ArrayViewProps) {
  const items = state.preview.map(row => row[0]);
  const more = state.num_rows - items.length;
  const lit = new Set<number>([
    ...(highlights?.rows ?? []),
    ...((highlights?.cells ?? []).map(([r]) => r)),
  ]);
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

interface TableViewProps {
  state: TableState;
  highlights?: Highlights;
  /** Legacy column diffing (select/drop/with_column); suppressed when sub-step highlights exist */
  addedColumns?: string[];
  removedColumns?: string[];
}

function TableView({ state, highlights, addedColumns, removedColumns }: TableViewProps) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [state]);

  const { columns, preview, num_rows } = state;
  const highlightRows = highlights?.rows ?? [];
  const highlightRemoved = highlights?.rows_removed ?? [];
  const highlightColumns = highlights?.columns ?? [];
  const highlightCells = highlights?.cells ?? [];

  // Never hide a highlighted row behind the cap
  const highlightMax = Math.max(
    -1,
    ...highlightRows,
    ...highlightRemoved,
    ...highlightCells.map(([r]) => r)
  );
  const cap = Math.max(DEFAULT_VISIBLE_ROWS, highlightMax + 1);
  const visibleCount = expanded ? preview.length : Math.min(preview.length, cap);
  const hiddenInPreview = preview.length - visibleCount;
  const beyondPreview = num_rows - preview.length;
  const numericCols = columns.map((_, j) => isNumericColumn(preview, j));

  const labelColumns = indexCount(state);

  const cellClass = (rowIndex: number, colIndex: number): string => {
    const col = columns[colIndex];
    const classes: string[] = [];
    if (colIndex < labelColumns) classes.push('index-cell');
    if (numericCols[colIndex]) classes.push('num');
    if (highlightCells.some(([r, c]) => r === rowIndex && c === col)) classes.push('hl-cell');
    else if (highlightColumns.includes(col)) classes.push('hl-col');
    if (removedColumns?.includes(col)) classes.push('removed-cell');
    if (addedColumns?.includes(col)) classes.push('added-cell');
    return classes.join(' ');
  };

  return (
    <div className="data-table-wrapper">
      <table className="data-table compact">
        <thead>
          <tr>
            {columns.map((col, j) => {
              const classes: string[] = [];
              if (j < labelColumns) classes.push('index-cell');
              if (numericCols[j]) classes.push('num');
              if (highlightColumns.includes(col)) classes.push('hl-col-header');
              if (removedColumns?.includes(col)) classes.push('removed-column');
              if (addedColumns?.includes(col)) classes.push('added-column');
              return (
                <th key={j} className={classes.join(' ')}>
                  {col}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {preview.slice(0, visibleCount).map((row, i) => {
            const rowClasses: string[] = [];
            if (highlightRows.includes(i)) rowClasses.push('hl-row');
            if (highlightRemoved.includes(i)) rowClasses.push('hl-row-removed');
            return (
              <tr key={i} className={rowClasses.join(' ')}>
                {row.map((cell, j) => (
                  <td key={j} className={cellClass(i, j)}>
                    {formatValue(cell)}
                  </td>
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
  );
}

function EmptyPlaceholder({ text, subtext }: { text: string; subtext: string }) {
  return (
    <div className="data-table-wrapper centered">
      <div className="empty-table-placeholder">
        <div className="empty-icon">📄</div>
        <div className="empty-text">{text}</div>
        <div className="empty-subtext">{subtext}</div>
      </div>
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
}: DataTransformationProps) {
  const [showAnimation, setShowAnimation] = useState(false);

  useEffect(() => {
    // Trigger animation after mount
    const timer = setTimeout(() => setShowAnimation(true), 100);
    return () => clearTimeout(timer);
  }, []);

  // Legacy column diffing only applies when the frame has no sub-step visuals
  // The change badges and column diff describe the result, so they are suppressed while it is hidden
  const hasSubStepVisuals = Boolean(isSubStep || inputHighlights || outputHighlights || outputOverride || auxTable || auxOutput);
  const columnsRemoved = hasSubStepVisuals ? [] : dataColumns(before).filter(col => !dataColumns(after).includes(col));
  const columnsAdded = hasSubStepVisuals ? [] : dataColumns(after).filter(col => !dataColumns(before).includes(col));
  const rowsChanged = before.num_rows !== after.num_rows;

  // Check if this is table initialization (empty table → table with data)
  const isInitialization = before.num_rows === 0 && after.num_rows > 0 &&
                           (operation === 'with_columns' || operation === 'with_column');

  const output = outputOverride ?? after;
  const outputIsBuilding = outputOverride !== undefined;
  const isArray = after.kind === 'array';
  const sizeInfo = (state: TableState) =>
    state.kind === 'array' || (isArray && state === output)
      ? `${state.num_rows} value${state.num_rows !== 1 ? 's' : ''}`
      : `${state.num_rows} row${state.num_rows !== 1 ? 's' : ''} × ${columnCount(state)} col${columnCount(state) !== 1 ? 's' : ''}`;
  const resultHeading = outputLabel ?? (outputIsBuilding ? 'Result (building…)' : isArray ? 'Result array' : 'After');

  return (
    <div className={`data-transformation ${showAnimation ? 'animated' : ''}`}>
      {/* Before State */}
      <div className="transform-section before">
        <div className="section-header">
          <span className="section-title">Before</span>
          <span className="section-info">
            {isInitialization ? 'Empty Table' : `${before.num_rows} rows × ${columnCount(before)} cols`}
          </span>
        </div>

        {isInitialization ? (
          <EmptyPlaceholder text="Empty Table" subtext="No columns, no rows yet" />
        ) : (
          <TableView state={before} highlights={inputHighlights} removedColumns={columnsRemoved} />
        )}

        {auxTable && (
          <>
            <div className="section-header aux-header">
              <span className="section-title">{auxTable.label}</span>
              <span className="section-info">
                {auxTable.state.num_rows} rows × {columnCount(auxTable.state)} cols
              </span>
            </div>
            <TableView state={auxTable.state} highlights={auxTable.highlights} />
          </>
        )}
      </div>

      {/* Transformation Arrow */}
      <div className="transform-arrow-container">
        <div className="transform-arrow-label">{title ?? `${operation}()`}</div>
        <div className="transform-arrow">→</div>
        <div className="transform-changes">
          {columnsRemoved.length > 0 && (
            <div className="change-badge removed">-{columnsRemoved.length} cols</div>
          )}
          {columnsAdded.length > 0 && (
            <div className="change-badge added">+{columnsAdded.length} cols</div>
          )}
          {!hasSubStepVisuals && rowsChanged && (
            <div className="change-badge">
              {after.num_rows > before.num_rows ? '+' : ''}
              {after.num_rows - before.num_rows} rows
            </div>
          )}
        </div>
      </div>

      {/* After State */}
      <div className={`transform-section after${isInitialization ? ' initialization-result' : ''}`}>
        <div className="section-header">
          <span className="section-title">{resultHeading}</span>
          <span className="section-info">{sizeInfo(output)}</span>
        </div>

        {isArray ? (
          <ArrayView state={output} highlights={outputHighlights} caption={output.columns[0]} />
        ) : output.preview.length === 0 && output.columns.length === 0 ? (
          <EmptyPlaceholder text="Empty Table" subtext="Nothing here yet" />
        ) : (
          <TableView state={output} highlights={outputHighlights} addedColumns={columnsAdded} />
        )}

        {auxOutput && (
          <>
            <div className="section-header aux-header">
              <span className="section-title">{auxOutput.label}</span>
              <span className="section-info">{sizeInfo(auxOutput.state)}</span>
            </div>
            {auxOutput.state.preview.length === 0 ? (
              <EmptyPlaceholder text="Not filled yet" subtext="Rows arrive in a later step" />
            ) : (
              <TableView state={auxOutput.state} highlights={auxOutput.highlights} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
