// The hero cell's polars: enough to run `name = cones.filter(pl.col('Column') <op> value)` on the
// six-row cones table, with polars 1.33.1's results and error messages.
import { cellStatements, literal, show, type Column, type Evaluated, type Py } from './whereDemo';

export type Op = '==' | '!=' | '>' | '<' | '>=' | '<=';

export type PolarsParsed =
  | { kind: 'query'; target: string | null; label: string; op: Op; value: Py }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }
  | { kind: 'empty' };

// Names that exist in a polars notebook but that this preview cannot run
const KNOWN_NAMES = new Set(['pl']);

const notDefined = (name: string) => ({ kind: 'error' as const, message: `NameError: name '${name}' is not defined` });

/** Drop one layer of parentheses around the whole expression, as often as there are */
function unwrap(text: string): string {
  let t = text.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) wraps = false;
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

export function parsePolars(code: string, labels: string[]): PolarsParsed {
  const split = cellStatements(code);
  if ('error' in split) return { kind: 'error', message: split.error };
  const body = split.statements.filter((s) => !/^import\s+polars\s+as\s+pl$/.test(s));
  if (body.length === 0) return { kind: 'empty' };
  if (body.length > 1) return { kind: 'unsupported' };

  const m = body[0].match(/^(?:([A-Za-z_]\w*)\s*=(?!=)\s*)?([A-Za-z_]\w*)\s*\.\s*filter\s*\(([\s\S]*)\)$/);
  if (!m) return { kind: 'unsupported' };
  const [, target = null, frame, inner] = m;
  // Python looks up every name before polars runs anything
  if (frame !== 'cones') return KNOWN_NAMES.has(frame) ? { kind: 'unsupported' } : notDefined(frame);

  const c = unwrap(inner).match(/^pl\s*\.\s*col\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)\s*(==|!=|>=|<=|>|<)\s*([\s\S]+)$/);
  if (!c) return { kind: 'unsupported' };
  const [, , label, op, rhs] = c;
  const value = literal(unwrap(rhs));
  if (!value.ok) return value.name && !KNOWN_NAMES.has(value.name) ? notDefined(value.name) : { kind: 'unsupported' };
  // ...then polars finds the column
  if (!labels.includes(label)) {
    const valid = labels.map((l) => `"${l}"`).join(', ');
    return {
      kind: 'error',
      message: `polars.exceptions.ColumnNotFoundError: unable to find column "${label}"; valid columns: [${valid}]`,
    };
  }
  return { kind: 'query', target, label, op: op as Op, value: value.value };
}

/** The polars type a Python number becomes in an expression */
function numericType(value: number): string {
  if (!Number.isInteger(value)) return 'f64';
  return Math.abs(value) < 2 ** 31 ? 'i32' : 'i64';
}

/** Compare the whole column at once, the way polars does */
export function evaluatePolars(op: Op, value: Py, column: Column): Evaluated | { error: string } {
  const numericColumn = column.values.every((v) => typeof v === 'number');
  // A bool joins whichever side it meets: 1.0 or 0.0 against numbers, 'true' or 'false' against strings
  const other: string | number =
    typeof value === 'boolean' ? (numericColumn ? Number(value) : String(value)) : value;
  if (numericColumn !== (typeof other === 'number')) {
    const type = numericColumn ? 'f64' : numericType(other as number);
    return { error: `polars.exceptions.ComputeError: cannot compare string with numeric type (${type})` };
  }
  const shownValue = typeof value === 'string' ? `'${value}'` : show(value);
  const keep = column.values.map((x) => {
    const a = x as string | number;
    switch (op) {
      case '==': return a === other;
      case '!=': return a !== other;
      case '>': return a > other;
      case '<': return a < other;
      case '>=': return a >= other;
      case '<=': return a <= other;
    }
  });
  const reasons = column.shown.map((x, i) => {
    const left = numericColumn ? x : `'${x}'`;
    return `${left} ${op} ${shownValue} is ${keep[i] ? 'True' : 'False'}`;
  });
  return { keep, reasons };
}
