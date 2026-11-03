// The hero cell's tiny interpreter: enough of Python and datascience to run
// `name = cones.where(column, value_or_predicate)` on the six-row cones table, with the
// datascience 0.18.1 semantics and error messages. Anything else is handed to the real tutor.

export type Py = string | number | boolean;

export interface Column {
  label: string;
  values: Py[];
  /** How each value is shown in the table, e.g. 4.50 */
  shown: string[];
}

export interface Predicate {
  name: string;
  args: Py[];
}

export interface Query {
  /** The name the result is assigned to, or null for a bare expression */
  target: string | null;
  label: string;
  /** A value to compare with ==, or an are.* predicate */
  condition: { value: Py } | { predicate: Predicate };
}

export type Parsed =
  | { kind: 'query'; query: Query }
  | { kind: 'error'; message: string }
  /** Valid-looking code this preview does not run; the tutor can */
  | { kind: 'unsupported' }
  /** Only comments, blank lines or the import */
  | { kind: 'empty' };

export interface Evaluated {
  keep: boolean[];
  /** Per row, e.g. "4.75 is above 4.5" or "vanilla ≠ chocolate" */
  reasons: string[];
}

const pyType = (v: Py): string =>
  typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : Number.isInteger(v) ? 'int' : 'float';

const show = (v: Py): string => (typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v));

const isNumberLike = (v: Py) => typeof v !== 'string';

class PyError extends Error {}

function compare(op: '>' | '<' | '>=' | '<=', x: Py, y: Py, xType: string): boolean {
  if (isNumberLike(x) !== isNumberLike(y)) {
    // A float column against a string fails inside numpy before Python's own comparison
    if (xType === 'numpy.float64') {
      const ufunc = { '>': 'greater', '<': 'less', '>=': 'greater_equal', '<=': 'less_equal' }[op];
      throw new PyError(
        `UFuncTypeError: ufunc '${ufunc}' did not contain a loop with signature matching types ` +
          "(<class 'numpy.dtypes.Float64DType'>, <class 'numpy.dtypes.StrDType'>) -> None",
      );
    }
    throw new PyError(`TypeError: '${op}' not supported between instances of '${xType}' and '${pyType(y)}'`);
  }
  const a = typeof x === 'boolean' ? Number(x) : x;
  const b = typeof y === 'boolean' ? Number(y) : y;
  return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
}

function equal(x: Py, y: Py): boolean {
  if (isNumberLike(x) && isNumberLike(y)) return Math.abs(Number(x) - Number(y)) < 1e-9;
  return x === y;
}

function contains(container: Py, item: Py, containerType: string, itemType: string): boolean {
  if (typeof container !== 'string') {
    throw new PyError(`TypeError: argument of type '${containerType}' is not a container or iterable`);
  }
  if (typeof item !== 'string') {
    throw new PyError(`TypeError: 'in <string>' requires string as left operand, not ${itemType}`);
  }
  return container.includes(item);
}

interface PredicateSpec {
  arity: number;
  test: (x: Py, a: Py[], xType: string) => boolean;
  /** What a kept row satisfies, and what a removed row does not */
  yes: (a: string[]) => string;
  no: (a: string[]) => string;
}

// datascience's are.* predicates (datascience/predicates.py)
const BASE: Record<string, PredicateSpec> = {
  equal_to: { arity: 1, test: (x, [y]) => equal(x, y), yes: ([y]) => `= ${y}`, no: ([y]) => `≠ ${y}` },
  above: { arity: 1, test: (x, [y], t) => compare('>', x, y, t), yes: ([y]) => `is above ${y}`, no: ([y]) => `isn't above ${y}` },
  below: { arity: 1, test: (x, [y], t) => compare('<', x, y, t), yes: ([y]) => `is below ${y}`, no: ([y]) => `isn't below ${y}` },
  above_or_equal_to: {
    arity: 1,
    test: (x, [y], t) => compare('>=', x, y, t) || equal(x, y),
    yes: ([y]) => `is at least ${y}`,
    no: ([y]) => `is under ${y}`,
  },
  below_or_equal_to: {
    arity: 1,
    test: (x, [y], t) => compare('<=', x, y, t) || equal(x, y),
    yes: ([y]) => `is at most ${y}`,
    no: ([y]) => `is over ${y}`,
  },
  strictly_between: {
    arity: 2,
    test: (x, [y, z], t) => compare('<', y, x, pyType(y)) && compare('<', x, z, t),
    yes: ([y, z]) => `is strictly between ${y} and ${z}`,
    no: ([y, z]) => `isn't strictly between ${y} and ${z}`,
  },
  between: {
    arity: 2,
    test: (x, [y, z], t) => (compare('<=', y, x, pyType(y)) && compare('<', x, z, t)) || equal(x, y),
    yes: ([y, z]) => `is between ${y} and ${z}`,
    no: ([y, z]) => `isn't between ${y} and ${z}`,
  },
  between_or_equal_to: {
    arity: 2,
    test: (x, [y, z], t) => (compare('<=', y, x, pyType(y)) && compare('<=', x, z, t)) || equal(x, y) || equal(x, z),
    yes: ([y, z]) => `is between ${y} and ${z}, inclusive`,
    no: ([y, z]) => `isn't between ${y} and ${z}, inclusive`,
  },
  containing: {
    arity: 1,
    test: (x, [s], t) => contains(x, s, t, pyType(s)),
    yes: ([s]) => `contains '${s}'`,
    no: ([s]) => `doesn't contain '${s}'`,
  },
  contained_in: {
    arity: 1,
    test: (x, [s], t) => contains(s, x, pyType(s), t),
    yes: ([s]) => `is in '${s}'`,
    no: ([s]) => `isn't in '${s}'`,
  },
};

const PREDICATES: Record<string, PredicateSpec> = { ...BASE };
for (const [name, spec] of Object.entries(BASE)) {
  if (name === 'containing' || name === 'contained_in' || name.startsWith('equal')) continue;
  PREDICATES[`not_${name}`] = { arity: spec.arity, test: (x, a, t) => !spec.test(x, a, t), yes: spec.no, no: spec.yes };
}
PREDICATES.not_equal_to = { ...BASE.equal_to, test: (x, a, t) => !BASE.equal_to.test(x, a, t), yes: BASE.equal_to.no, no: BASE.equal_to.yes };
PREDICATES.not_containing = { ...BASE.containing, test: (x, a, t) => !BASE.containing.test(x, a, t), yes: BASE.containing.no, no: BASE.containing.yes };
PREDICATES.not_contained_in = { ...BASE.contained_in, test: (x, a, t) => !BASE.contained_in.test(x, a, t), yes: BASE.contained_in.no, no: BASE.contained_in.yes };

/** Drop comments (outside strings) */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

/** Split on commas at the top level (outside strings and brackets) */
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === "'" || c === '"') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  const trimmed = parts.map((p) => p.trim());
  // A trailing comma is allowed in Python
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed.length === 1 && trimmed[0] === '' ? [] : trimmed;
}

type Literal = { ok: true; value: Py } | { ok: false; name?: string };

function literal(text: string): Literal {
  const str = text.match(/^(['"])((?:\\.|(?!\1).)*)\1$/s);
  if (str) return { ok: true, value: str[2].replace(/\\(.)/g, '$1') };
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return { ok: true, value: Number(text) };
  if (text === 'True' || text === 'False') return { ok: true, value: text === 'True' };
  if (/^[A-Za-z_]\w*$/.test(text)) return { ok: false, name: text };
  return { ok: false };
}

const notDefined = (name: string) => ({ kind: 'error' as const, message: `NameError: name '${name}' is not defined` });

// Names that exist after `from datascience import *` but that this preview cannot run
const DATASCIENCE_NAMES = new Set(['Table', 'make_array', 'are', 'np', 'plots', 'percentile', 'sample_proportions', 'proportions_from_distribution']);

export function parseCell(code: string, labels: string[]): Parsed {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  for (const raw of code.split('\n')) {
    const line = stripComment(raw);
    current += (current ? '\n' : '') + line;
    for (const c of line.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '')) {
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
    }
    if (depth <= 0) {
      if (current.trim()) statements.push(current.trim());
      current = '';
      depth = 0;
    }
  }
  if (current.trim()) return { kind: 'error', message: "SyntaxError: '(' was never closed" };

  const body = statements.filter((s) => !/^from\s+datascience\s+import\s+\*$/.test(s));
  if (body.length === 0) return { kind: 'empty' };
  if (body.length > 1) return { kind: 'unsupported' };

  const m = body[0].match(/^(?:([A-Za-z_]\w*)\s*=(?!=)\s*)?([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
  if (!m) return { kind: 'unsupported' };
  const [, target = null, object, method, argText] = m;
  if (object !== 'cones') return DATASCIENCE_NAMES.has(object) ? { kind: 'unsupported' } : notDefined(object);
  if (method !== 'where') return { kind: 'unsupported' };

  const positional: string[] = [];
  const keyword: Record<string, string> = {};
  for (const arg of splitArgs(argText)) {
    const kw = arg.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/);
    if (kw) keyword[kw[1]] = kw[2];
    else positional.push(arg);
  }
  const labelText = positional[0] ?? keyword.column_or_label;
  const conditionText = positional[1] ?? keyword.value_or_predicate;
  if (labelText === undefined) {
    return { kind: 'error', message: "TypeError: Table.where() missing 1 required positional argument: 'column_or_label'" };
  }
  // where(label) on a column of booleans, or where(..., other=): real datascience, not this preview
  if (conditionText === undefined || positional.length > 2 || 'other' in keyword) return { kind: 'unsupported' };

  const labelLit = literal(labelText);
  if (!labelLit.ok) return labelLit.name && !DATASCIENCE_NAMES.has(labelLit.name) ? notDefined(labelLit.name) : { kind: 'unsupported' };
  let label: string;
  if (typeof labelLit.value === 'number' && Number.isInteger(labelLit.value) && labelLit.value >= 0 && labelLit.value < labels.length) {
    label = labels[labelLit.value];
  } else if (typeof labelLit.value === 'string' && labels.includes(labelLit.value)) {
    label = labelLit.value;
  } else {
    const shown = typeof labelLit.value === 'string' ? labelLit.value : show(labelLit.value);
    return { kind: 'error', message: `ValueError: label "${shown}" not in labels (${labels.map((l) => `'${l}'`).join(', ')})` };
  }

  const pred = conditionText.match(/^are\s*\.\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
  if (pred) {
    const [, name, predArgs] = pred;
    const spec = PREDICATES[name];
    if (!spec) return { kind: 'error', message: `AttributeError: type object 'are' has no attribute '${name}'` };
    const args: Py[] = [];
    for (const a of splitArgs(predArgs)) {
      const lit = literal(a);
      if (!lit.ok) return lit.name && !DATASCIENCE_NAMES.has(lit.name) ? notDefined(lit.name) : { kind: 'unsupported' };
      args.push(lit.value);
    }
    if (args.length !== spec.arity) {
      const want = spec.arity === 1 ? '1 positional argument' : `${spec.arity} positional arguments`;
      return { kind: 'error', message: `TypeError: are.${name}() takes ${want} but ${args.length} ${args.length === 1 ? 'was' : 'were'} given` };
    }
    return { kind: 'query', query: { target, label, condition: { predicate: { name, args } } } };
  }

  const value = literal(conditionText);
  if (!value.ok) return value.name && !DATASCIENCE_NAMES.has(value.name) ? notDefined(value.name) : { kind: 'unsupported' };
  return { kind: 'query', query: { target, label, condition: { value: value.value } } };
}

/** Run the query over the column; a Python error comes back as its message */
export function evaluate(query: Query, column: Column): Evaluated | { error: string } {
  const keep: boolean[] = [];
  const reasons: string[] = [];
  try {
    column.values.forEach((x, i) => {
      // Table columns are numpy arrays, so their values are numpy scalars
      const xType = typeof x === 'string' ? 'numpy.str_' : 'numpy.float64';
      const shown = column.shown[i];
      if ('value' in query.condition) {
        const ok = equal(x, query.condition.value);
        keep.push(ok);
        reasons.push(`${shown} ${ok ? '=' : '≠'} ${show(query.condition.value)}`);
      } else {
        const { name, args } = query.condition.predicate;
        const spec = PREDICATES[name];
        const ok = spec.test(x, args, xType);
        keep.push(ok);
        reasons.push(`${shown} ${(ok ? spec.yes : spec.no)(args.map(show))}`);
      }
    });
  } catch (error) {
    if (error instanceof PyError) return { error: error.message };
    throw error;
  }
  return { keep, reasons };
}
