// The hero cell's pandas: enough to run `name = cones[cones['Column'] <op> value]` (or
// cones.Column) on the six-row cones table, with pandas 3.0.2's results and error messages.
import { cellStatements, literal, pyType, show, type Column, type Evaluated, type Py } from './whereDemo';

export type Op = '==' | '!=' | '>' | '<' | '>=' | '<=';

export type PandasParsed =
  | { kind: 'query'; target: string | null; label: string; op: Op; value: Py }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }
  | { kind: 'empty' };

// Names that exist in a pandas notebook but that this preview cannot run
const KNOWN_NAMES = new Set(['pd', 'np']);

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

export function parsePandas(code: string, labels: string[]): PandasParsed {
  const split = cellStatements(code);
  if ('error' in split) return { kind: 'error', message: split.error };
  const body = split.statements.filter((s) => !/^import\s+(pandas|numpy)\s+as\s+(pd|np)$/.test(s));
  if (body.length === 0) return { kind: 'empty' };
  if (body.length > 1) return { kind: 'unsupported' };

  const m = body[0].match(/^(?:([A-Za-z_]\w*)\s*=(?!=)\s*)?([A-Za-z_]\w*)\s*\[([\s\S]*)\]$/);
  if (!m) return { kind: 'unsupported' };
  const [, target = null, frame, inner] = m;
  if (frame !== 'cones') return KNOWN_NAMES.has(frame) ? { kind: 'unsupported' } : notDefined(frame);

  const c = unwrap(inner).match(
    /^([A-Za-z_]\w*)\s*(?:\[\s*(['"])((?:\\.|(?!\2).)*)\2\s*\]|\.([A-Za-z_]\w*))\s*(==|!=|>=|<=|>|<)\s*([\s\S]+)$/,
  );
  if (!c) return { kind: 'unsupported' };
  const [, innerFrame, , bracketLabel, attrLabel, op, rhs] = c;
  if (innerFrame !== 'cones') return KNOWN_NAMES.has(innerFrame) ? { kind: 'unsupported' } : notDefined(innerFrame);
  // pandas reads the column before it looks at the value
  const label = bracketLabel ?? attrLabel;
  if (!labels.includes(label)) {
    return {
      kind: 'error',
      message: bracketLabel !== undefined ? `KeyError: '${label}'` : `AttributeError: 'DataFrame' object has no attribute '${label}'`,
    };
  }
  const value = literal(unwrap(rhs));
  if (!value.ok) return value.name && !KNOWN_NAMES.has(value.name) ? notDefined(value.name) : { kind: 'unsupported' };
  return { kind: 'query', target, label, op: op as Op, value: value.value };
}

const isNumber = (v: Py) => typeof v !== 'string';

/** Compare every value in the column, the way pandas does element by element */
export function evaluatePandas(op: Op, value: Py, column: Column): Evaluated | { error: string } {
  const numericColumn = column.values.every(isNumber);
  if (op !== '==' && op !== '!=' && numericColumn !== isNumber(value)) {
    return {
      error: numericColumn
        ? `TypeError: Invalid comparison between dtype=float64 and ${pyType(value)}`
        : `TypeError: '${op}' not supported between instances of 'str' and '${pyType(value)}'`,
    };
  }
  const shownValue = typeof value === 'string' ? `'${value}'` : show(value);
  const keep = column.values.map((x) => {
    // A number and a string are never equal, and never unequal enough to compare
    if (numericColumn !== isNumber(value)) return op === '!=';
    const a = typeof x === 'boolean' ? Number(x) : x;
    const b = typeof value === 'boolean' ? Number(value) : value;
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
  });
  const reasons = column.shown.map((x, i) => {
    const left = numericColumn ? x : `'${x}'`;
    return `${left} ${op} ${shownValue} is ${keep[i] ? 'True' : 'False'}`;
  });
  return { keep, reasons };
}
