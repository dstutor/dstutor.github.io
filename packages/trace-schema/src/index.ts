// The trace format tracers emit and the frontend reads. Library-agnostic: nothing here knows
// about Python or any particular library, so a new tutor needs only a tracer that emits these.
// These types are the source of truth: schema/trace.schema.json is generated from them
// (npm run schema), and check_trace.py holds every tracer to both. See README.md.

/**
 * A value as tracers send it: plain JSON. NaN, infinities and similar values are not JSON: a
 * tracer sends null for them, or, in a table's preview, {"shown": "NaN"}, the text its library
 * prints for that value, which the table shows as is. Anything else that is not JSON (a function,
 * an object) is sent as its string form.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Everything a run recorded, in order: what a tracer's trace() returns */
export type Trace = TraceRecord[];

export interface Highlights {
  /** Preview row indices (0-based) to emphasize */
  rows?: number[];
  /** Preview row indices shown struck-through (e.g. rows removed by where) */
  rows_removed?: number[];
  /** Column names to emphasize */
  columns?: string[];
  /** Individual cells as [previewRowIndex, columnName] pairs */
  cells?: [number, string][];
  /**
   * A colour slot (0-7) for each preview row, or null: rows of the same join key or group share a
   * slot, and the stage's panel labels each slot with its key
   */
  row_colors?: (ColorSlot | null)[];
}

/**
 * One of eight colours the visualization gives keys and groups, always shown with a label
 * @asType integer
 * @minimum 0
 * @maximum 7
 */
export type ColorSlot = number;

/** A key or group value as a labelled chip in its colour */
export interface KeyChip {
  value: JsonValue;
  color?: ColorSlot;
}

/** A join's first stage: the distinct key values on each side, as a Venn of keys */
export interface KeysPanel {
  kind: 'keys';
  /** What is compared, e.g. "Flavor" or "Flavor = Name" */
  key: string;
  /** The two tables' names */
  left: string;
  right: string;
  left_only: KeyChip[];
  both: KeyChip[];
  right_only: KeyChip[];
  /** The regions this join keeps rows from */
  keeps: ('left_only' | 'both' | 'right_only')[];
}

/** How rows pair up: for each key, how many rows each side has and how many rows it makes */
export interface PairsPanel {
  kind: 'pairs';
  pairs: {
    key: KeyChip;
    /**
     * Rows with this key on the left (whole table)
     * @asType integer
     * @minimum 0
     */
    left: number;
    /**
     * Rows with this key on the right (whole table)
     * @asType integer
     * @minimum 0
     */
    right: number;
    /**
     * Rows this key puts in the result
     * @asType integer
     * @minimum 0
     */
    rows: number;
  }[];
  /**
   * Keys not shown
   * @asType integer
   * @minimum 0
   */
  more?: number;
  /**
   * Rows in the result
   * @asType integer
   * @minimum 0
   */
  total: number;
}

/** Rows sorted into groups: one card per group with its values and, once combined, the result */
export interface GroupsPanel {
  kind: 'groups';
  /** The key columns */
  keys: string[];
  groups: {
    key: JsonValue[];
    color?: ColorSlot;
    /**
     * Rows in the group (whole table)
     * @asType integer
     * @minimum 0
     */
    rows: number;
    /** Each aggregated column: the group's values, and its result once combined */
    values: { column: string; values: JsonValue[]; result?: JsonValue; formula?: string }[];
  }[];
  /**
   * Groups not shown
   * @asType integer
   * @minimum 0
   */
  more?: number;
}

/** A sort's new order: where each result row was in the input */
export interface OrderPanel {
  kind: 'order';
  /** For each result row in order, its row label or position in the input */
  from: JsonValue[];
  /** For each result row, its value of the first sort key */
  values?: JsonValue[];
  /** Runs of result rows that tie on the first sort key, as [first, last] positions */
  ties?: [number, number][];
  /**
   * Result rows not shown
   * @asType integer
   * @minimum 0
   */
  more?: number;
}

/** How the library actually ran it: one or more lists of plan steps, first to last */
export interface PlanPanel {
  kind: 'plan';
  plans: {
    title: string;
    steps: {
      name: string;
      detail?: string;
      /**
       * Rows out of this step, when the library reports them
       * @asType integer
       * @minimum 0
       */
      rows?: number;
    }[];
  }[];
}

/** A stage's picture when it is not a table */
export type Panel = KeysPanel | PairsPanel | GroupsPanel | OrderPanel | PlanPanel;

export interface SubStep {
  /**
   * The stage this frame belongs to, in a few words ("Which keys match"); the step shows its
   * stages as a rail. Frames of one stage share the name.
   */
  stage?: string;
  /** Replaces record.explanation for this frame */
  message: string;
  /** How the library actually does this, when that differs from the picture (one sentence) */
  note?: string;
  /** A picture for this stage other than a table, shown where the result table would be */
  panel?: Panel;
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
  /**
   * Unique within a trace, increasing in the order the operations ran
   * @asType integer
   * @minimum 0
   */
  step_id: number;
  /** The method or function called, e.g. "where" */
  operation: string;
  /**
   * The step's title when `operation()` would not describe what the code did, e.g. "keep rows
   * where True" for cones[cones['Price'] > 4], which calls no method. Without it the step is
   * titled operation().
   */
  label?: string;
  /** Positional arguments, as JSON (a predicate shows as its name or description) */
  args: JsonValue[];
  /** Keyword arguments, as JSON */
  kwargs: Record<string, JsonValue>;
  /** The table the operation was called on */
  input: TableState;
  /** What it returned */
  output: TableState;
  /** One sentence on what happened, e.g. "Filtered rows. Kept 2, removed 4." */
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
  /**
   * Rows in the whole table, which can be more than preview shows
   * @asType integer
   * @minimum 0
   */
  num_rows: number;
  /**
   * Always columns.length
   * @asType integer
   * @minimum 0
   */
  num_columns: number;
  columns: string[];
  /** The first rows (all of them for small tables), one value per column */
  preview: JsonValue[][];
  /**
   * How many of the leading columns are row labels rather than data: a pandas DataFrame's
   * index (two for a two-level index). They are shown, but not counted as columns. Absent: 0.
   * @asType integer
   * @minimum 0
   */
  index_columns?: number;
  /**
   * Each column's type as its library names it, one per column: polars' `str` and `f64`,
   * DuckDB's `varchar` and `double`, pandas' `float64`. Tables of libraries that print types
   * (polars, DuckDB) show them; for the others they only decide how values print (pandas gives
   * a float64 column one number of decimals).
   */
  column_types?: string[];
  /** Set when the table could not be read; the rest is then best effort */
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
