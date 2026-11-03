// The libraries the hero cell can run, each with its own code, interpreter and step wording.
// The wording is each tutor's own (tracers/datascience/tracer.py and tracers/pandas/tracer.py).
import { evaluate, parseCell, type Column, type Evaluated } from './whereDemo';
import { evaluatePandas, parsePandas } from './pandasDemo';

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

export const LIBRARIES: Record<string, DemoLibrary> = { datascience, pandas };
