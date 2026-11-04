// The libraries the hero cell can run, each with its own code, interpreter and step wording.
// The wording is each tutor's own (tracers/<library>/tracer.py).
import { evaluate, parseCell, type Column, type Evaluated } from './whereDemo';
import { evaluatePandas, parsePandas } from './pandasDemo';
import { evaluatePolars, parsePolars } from './polarsDemo';
import { evaluateSql, parseSql } from './sqlDemo';

export type Outcome = Evaluated | { error: string };

export type Run =
  | { kind: 'query'; target: string | null; label: string; evaluate: (column: Column) => Outcome }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }
  | { kind: 'empty' };

export interface DemoLibrary {
  id: string;
  name: string;
  /** Where its tutor lives */
  href: string;
  /** What the cell starts with */
  code: string;
  /** How the cell's code is highlighted */
  language: 'python' | 'sql';
  /** pandas shows the index as the first column; datascience tables have none */
  showIndex: boolean;
  parse(code: string, labels: string[]): Run;
  checking(label: string): string;
  keeping(kept: number, removed: number): string;
  done(kept: number, removed: number): string;
  /** Shown when the code is something this preview does not run (HTML) */
  unsupported: string;
}

const plural = (n: number) => (n === 1 ? 'row' : 'rows');

const datascience: DemoLibrary = {
  id: 'datascience',
  name: 'datascience',
  href: '/datascience/',
  code: "# UC Berkeley's datascience library\nchocolate = cones.where('Flavor', 'chocolate')",
  language: 'python',
  showIndex: false,
  parse(code, labels) {
    const parsed = parseCell(code, labels);
    if (parsed.kind !== 'query') return parsed;
    const { query } = parsed;
    return { kind: 'query', target: query.target, label: query.label, evaluate: (column) => evaluate(query, column) };
  },
  checking: (label) => `where checks every row's '${label}' value against the condition.`,
  keeping: (kept, removed) =>
    `Keep the ${kept} ${plural(kept)} that satisfy the condition; the other ${removed} (struck through) are removed.`,
  done: (kept, removed) => `Filtered rows. Kept ${kept}, removed ${removed}.`,
  unsupported: 'This preview runs one <code>cones.where(...)</code> on the <code>cones</code> table.',
};

const pandas: DemoLibrary = {
  id: 'pandas',
  name: 'pandas',
  href: '/pandas/',
  code: "# pandas\nchocolate = cones[cones['Flavor'] == 'chocolate']",
  language: 'python',
  showIndex: true,
  parse(code, labels) {
    const parsed = parsePandas(code, labels);
    if (parsed.kind !== 'query') return parsed;
    const { op, value } = parsed;
    return { kind: 'query', target: parsed.target, label: parsed.label, evaluate: (column) => evaluatePandas(op, value, column) };
  },
  checking: () => 'First the condition is checked for every row, giving True or False.',
  keeping: (kept, removed) =>
    `Keep the rows where it is True: ${kept} kept, ${removed} (struck through) removed. Kept rows keep their index labels.`,
  done: (kept, removed) => `Filtered rows. Kept ${kept}, removed ${removed}.`,
  unsupported: "This preview runs one filter like <code>cones[cones['Price'] &gt; 4]</code> on the <code>cones</code> table.",
};

const polars: DemoLibrary = {
  id: 'polars',
  name: 'polars',
  href: '/polars/',
  code: "# polars\nchocolate = cones.filter(pl.col('Flavor') == 'chocolate')",
  language: 'python',
  showIndex: false,
  parse(code, labels) {
    const parsed = parsePolars(code, labels);
    if (parsed.kind !== 'query') return parsed;
    const { op, value } = parsed;
    return { kind: 'query', target: parsed.target, label: parsed.label, evaluate: (column) => evaluatePolars(op, value, column) };
  },
  checking: () => 'First the condition is worked out for every row, giving a column of True and False.',
  keeping: (kept, removed) => `Keep the rows where it is True: ${kept} kept, ${removed} (struck through) removed.`,
  done: (kept, removed) => `Filtered rows. Kept ${kept}, removed ${removed}.`,
  unsupported: "This preview runs one filter like <code>cones.filter(pl.col('Price') &gt; 4)</code> on the <code>cones</code> table.",
};

const sql: DemoLibrary = {
  id: 'sql',
  name: 'SQL',
  href: '/sql/',
  code: "-- DuckDB SQL\nSELECT * FROM cones WHERE Flavor = 'chocolate'",
  language: 'sql',
  showIndex: false,
  parse(code, labels) {
    const parsed = parseSql(code, labels);
    if (parsed.kind !== 'query') return parsed;
    const { op, value, where } = parsed;
    return { kind: 'query', target: null, label: parsed.label, evaluate: (column) => evaluateSql(op, value, column, where) };
  },
  checking: () => 'First the condition is worked out for every row, giving a column of true and false.',
  keeping: (kept, removed) => `Keep the rows where it is true: ${kept} kept, ${removed} (struck through) removed.`,
  done: (kept, removed) => `Kept ${kept} of ${kept + removed} rows.`,
  unsupported: "This preview runs one <code>SELECT * FROM cones WHERE ...</code> with a single condition on the <code>cones</code> table.",
};

export const LIBRARIES: Record<string, DemoLibrary> = { datascience, pandas, polars, sql };
