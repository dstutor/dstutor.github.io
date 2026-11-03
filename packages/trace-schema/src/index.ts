// The trace format tracers emit and the frontend reads. Library-agnostic: nothing here knows
// about Python or any particular library, so a new tutor needs only a tracer that emits these.

export interface Highlights {
  /** Preview row indices (0-based) to emphasize */
  rows?: number[];
  /** Preview row indices shown struck-through (e.g. rows removed by where) */
  rows_removed?: number[];
  /** Column names to emphasize */
  columns?: string[];
  /** Individual cells as [previewRowIndex, columnName] pairs */
  cells?: [number, string][];
}

export interface SubStep {
  /** Replaces record.explanation for this frame */
  message: string;
  /** Monospace detail line, e.g. "sum([3.55, 5.25]) = 8.8" */
  detail?: string;
  input_highlights?: Highlights;
  output_highlights?: Highlights;
  /** Intermediate result table; absent => render record.output */
  output_state?: TableState;
  /** Secondary input table (e.g. the right table of a join) */
  aux_table?: { label: string; state: TableState; highlights?: Highlights };
  /** Heading for the result panel, e.g. "Result array" or "First table (3 rows)"; defaults to After */
  output_label?: string;
  /** Secondary result table shown under the main one (e.g. the second half of a split) */
  aux_output?: { label: string; state: TableState; highlights?: Highlights };
}

export interface TraceRecord {
  step_id: number;
  operation: string;
  args: unknown[];
  kwargs: Record<string, unknown>;
  input: TableState;
  output: TableState;
  explanation: string;
  /** Pedagogical walkthrough frames; absent => single before/after frame */
  sub_steps?: SubStep[];
  /** Where in the cell the call was made (1-based lines) and the variable the statement assigns */
  site?: { line: number; stmt_start: number; stmt_end: number; target: string | null } | null;
  /** Id of the notebook cell that produced this step (stamped by the runner) */
  cell?: string;
  /** Set on the last step of an assignment statement: the name that receives the result */
  assigns?: string;
}

export interface TableState {
  num_rows: number;
  num_columns: number;
  columns: string[];
  preview: unknown[][];
  error?: string;
  /** 'array' when the result is an array shown as one column (apply), not a real table */
  kind?: 'array';
}

/** What running one cell returns: its notebook output, plus the trace when tracing was on */
export interface RunOutput {
  stdout: string;
  stderr: string;
  /** repr() of a trailing bare expression, shown as the cell's Out[n] like a notebook */
  result?: string;
  /** Figures drawn during the run, as PNGs (base64) with their display width in CSS px */
  images?: Array<{ png: string; width: number }>;
  error?: string;
  trace?: TraceRecord[];
  /** True when the run produced more operations than the tracer keeps */
  traceTruncated?: boolean;
}
