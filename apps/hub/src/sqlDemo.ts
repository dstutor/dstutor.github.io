// The hero cell's SQL: enough to run `SELECT * FROM cones WHERE <column> <op> <value>` on the
// six-row cones table, with DuckDB 1.5.1's results and error messages, line and caret included.
// Names are matched without regard to case, as DuckDB does; a misspelled column gets DuckDB's own
// "Candidate bindings" (its Jaro-Winkler ranking, reproduced below).
import type { Column, Evaluated, Py } from './whereDemo';

export type SqlOp = '=' | '==' | '!=' | '<>' | '>' | '<' | '>=' | '<=';

/** A value as written: its kind, its value, and the DuckDB type of the literal */
type Literal =
  | { kind: 'string'; value: string }
  | { kind: 'integer'; value: number; type: 'INT32' | 'INT64' }
  | { kind: 'decimal'; value: number; type: string }
  | { kind: 'double'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' };

export type SqlParsed =
  | { kind: 'query'; target: null; label: string; op: SqlOp; value: Literal; where: Where }
  | { kind: 'error'; message: string }
  | { kind: 'unsupported' }
  | { kind: 'empty' };

/** Where things are in the cell, for the LINE n: and ^ of DuckDB's errors */
interface Where {
  code: string;
  column: number;
  op: number;
  value: number;
}

const TABLE = 'cones';
/** The cones table's column types */
const TYPES: Record<string, 'VARCHAR' | 'DOUBLE'> = { Flavor: 'VARCHAR', Color: 'VARCHAR', Price: 'DOUBLE' };
/**
 * The order DuckDB lists the cones table's columns in when their scores tie (its hash map's
 * order, the same in CPython and Pyodide): x gets Candidate bindings: "Color".
 */
const BINDING_ORDER = ['Color', 'Flavor', 'Price'];

/** DuckDB's error text: the message, then the line it is on and a caret under the spot */
export function duckdbError(message: string, code: string, position: number): string {
  const before = code.slice(0, position);
  const line = before.split('\n').length;
  const start = before.lastIndexOf('\n') + 1;
  const end = code.indexOf('\n', position);
  const text = code.slice(start, end === -1 ? undefined : end);
  const prefix = `LINE ${line}: `;
  return `${message}\n\n${prefix}${text}\n${' '.repeat(prefix.length + position - start)}^`;
}

/**
 * Jaro-Winkler similarity as DuckDB computes it (third_party/jaro_winkler): case-sensitive, a
 * window of half the longer string, and the prefix bonus only above 0.7. a is the candidate.
 */
export function jaroWinkler(a: string, b: string): number {
  let p = a;
  let t = b;
  if (!p.length || !t.length) return 0;
  if (p.length === 1 && t.length === 1) return p === t ? 1 : 0;
  let bound: number;
  if (t.length > p.length) {
    bound = Math.floor(t.length / 2) - 1;
    if (t.length > p.length + bound) t = t.slice(0, p.length + bound);
  } else {
    bound = Math.floor(p.length / 2) - 1;
    if (p.length > t.length + bound) p = p.slice(0, t.length + bound);
  }
  const pFlag = new Array<boolean>(p.length).fill(false);
  const tFlag = new Array<boolean>(t.length).fill(false);
  let matches = 0;
  for (let j = 0; j < t.length; j++) {
    for (let i = Math.max(0, j - bound); i < Math.min(p.length, j + bound + 1); i++) {
      if (!pFlag[i] && p[i] === t[j]) {
        pFlag[i] = tFlag[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  for (let j = 0, i = 0; j < t.length; j++) {
    if (!tFlag[j]) continue;
    while (!pFlag[i]) i++;
    if (p[i] !== t[j]) transpositions++;
    i++;
  }
  const m = matches;
  let sim = (m / a.length + m / b.length + (m - Math.floor(transpositions / 2)) / m) / 3;
  if (sim > 0.7) {
    let prefix = 0;
    while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
    sim += prefix * 0.1 * (1 - sim);
  }
  return sim;
}

/** DuckDB's "Candidate bindings": the best match, then up to four more scoring at least 0.5 */
export function candidateBindings(name: string): string[] {
  const scored = BINDING_ORDER.map((c) => ({ c, s: jaroWinkler(c, name) })).sort((x, y) => y.s - x.s);
  const out = [scored[0].c];
  for (const { c, s } of scored.slice(1, 5)) {
    if (s < 0.5) break;
    out.push(c);
  }
  return out;
}

/** One token of the cell, and where it starts */
interface Token {
  text: string;
  at: number;
}

/** Split SQL into words, quoted names, strings, numbers and operators, without its -- comments */
function tokenize(code: string): Token[] | null {
  const tokens: Token[] = [];
  const pattern = /\s+|--[^\n]*|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|(==|!=|<>|<=|>=|[=<>*;-])/y;
  let at = 0;
  while (at < code.length) {
    pattern.lastIndex = at;
    const m = pattern.exec(code);
    if (!m) return null;
    if (m[1] || m[2] || m[3] || m[4] || m[5]) tokens.push({ text: m[0], at });
    at = pattern.lastIndex;
  }
  return tokens;
}

const keyword = (token: Token | undefined, word: string) => token?.text.toUpperCase() === word;
const isName = (token: Token | undefined) => !!token && /^([A-Za-z_]\w*|"(?:[^"]|"")*")$/.test(token.text);
const nameOf = (token: Token) => (token.text.startsWith('"') ? token.text.slice(1, -1).replace(/""/g, '"') : token.text);
const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'GROUP', 'ORDER', 'BY', 'LIMIT']);

function literal(tokens: Token[]): Literal | null {
  if (tokens.length !== 1) return null;
  const { text } = tokens[0];
  if (text.startsWith("'")) return { kind: 'string', value: text.slice(1, -1).replace(/''/g, "'") };
  const upper = text.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'boolean', value: upper === 'TRUE' };
  if (upper === 'NULL') return { kind: 'null' };
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return { kind: 'integer', value, type: value < 2 ** 31 ? 'INT32' : 'INT64' };
  }
  // 1.5 is a DECIMAL(2,1); other spellings (4., .5, 1e2) only compare with numbers here
  const decimal = text.match(/^([1-9]\d*)\.(\d+)$/);
  if (decimal) return { kind: 'decimal', value: Number(text), type: `DECIMAL(${decimal[1].length + decimal[2].length},${decimal[2].length})` };
  if (/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return { kind: 'double', value: Number(text) };
  return null;
}

export function parseSql(code: string, labels: string[]): SqlParsed {
  const tokens = tokenize(code);
  if (!tokens) return { kind: 'unsupported' };
  if (tokens.at(-1)?.text === ';') tokens.pop();
  if (tokens.length === 0) return { kind: 'empty' };
  if (tokens.some((t) => t.text === ';')) return { kind: 'unsupported' };

  // SELECT * FROM <table> WHERE <column> <op> <value>
  const [select, star, from, table, where, column, op, ...value] = tokens;
  if (!keyword(select, 'SELECT') || star?.text !== '*' || !keyword(from, 'FROM') || !isName(table) || !keyword(where, 'WHERE')) {
    return { kind: 'unsupported' };
  }
  if (!isName(column) || RESERVED.has(column.text.toUpperCase()) || !op || !/^(==|!=|<>|<=|>=|[=<>])$/.test(op.text)) {
    return { kind: 'unsupported' };
  }
  // DuckDB finds the table first; a near miss of cones gets its suggestion, anything else the tutor
  if (nameOf(table).toLowerCase() !== TABLE) {
    if (jaroWinkler(TABLE, nameOf(table)) < 0.8) return { kind: 'unsupported' };
    return {
      kind: 'error',
      message: duckdbError(`Catalog Error: Table with name ${nameOf(table)} does not exist!\nDid you mean "${TABLE}"?`, code, table.at),
    };
  }
  // A name where the value goes is another column: only a misspelled one is shown here
  if (value.length === 1 && isName(value[0]) && !RESERVED.has(value[0].text.toUpperCase())) {
    const other = nameOf(value[0]);
    if (labels.some((l) => l.toLowerCase() === other.toLowerCase())) return { kind: 'unsupported' };
    return unknownColumn(other, code, value[0].at, labels, column);
  }
  const lit = literal(value);
  if (!lit) return { kind: 'unsupported' };
  const label = labels.find((l) => l.toLowerCase() === nameOf(column).toLowerCase());
  if (!label) return unknownColumn(nameOf(column), code, column.at, labels, null);
  // Text compared with 4., .5 or 1e2: not worked out here
  if (TYPES[label] !== 'DOUBLE' && lit.kind === 'double') return { kind: 'unsupported' };
  return {
    kind: 'query',
    target: null,
    label,
    op: op.text as SqlOp,
    value: lit,
    where: { code, column: column.at, op: op.at, value: value[0].at },
  };
}

/** DuckDB binds the column first, so an unknown one on the left is reported before the right */
function unknownColumn(name: string, code: string, at: number, labels: string[], left: Token | null): SqlParsed {
  if (left && !labels.some((l) => l.toLowerCase() === nameOf(left).toLowerCase())) {
    return unknownColumn(nameOf(left), code, left.at, labels, null);
  }
  const candidates = candidateBindings(name).map((c) => `"${c}"`).join(', ');
  return {
    kind: 'error',
    message: duckdbError(`Binder Error: Referenced column "${name}" not found in FROM clause!\nCandidate bindings: ${candidates}`, code, at),
  };
}

const cannotCompare = (left: string, right: string, where: Where) => ({
  error: duckdbError(`Binder Error: Cannot compare values of type ${left} and type ${right} - an explicit cast is required`, where.code, where.op),
});

const cannotConvertColumn = (first: string, type: string, label: string, where: Where, quote = "'") => ({
  error: duckdbError(
    `Conversion Error: Could not convert string ${quote}${first}${quote} to ${type} when casting from source column ${label}`,
    where.code,
    where.column,
  ),
});

/** Compare the whole column with the value at once, the way DuckDB's WHERE does */
export function evaluateSql(op: SqlOp, value: Literal, column: Column, where: Where): Evaluated | { error: string } {
  const type = TYPES[column.label] ?? (column.values.every((v) => typeof v === 'number') ? 'DOUBLE' : 'VARCHAR');
  const equality = op === '=' || op === '==' || op === '!=' || op === '<>';
  let other: Py | null;
  if (value.kind === 'null') {
    other = null;
  } else if (type === 'DOUBLE') {
    if (value.kind === 'string') {
      // The text is cast to a number, spaces and all
      if (!/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(value.value)) {
        return { error: duckdbError(`Conversion Error: Could not convert string '${value.value}' to DOUBLE`, where.code, where.value) };
      }
      other = Number(value.value);
    } else if (value.kind === 'boolean') {
      if (!equality) return cannotCompare('DOUBLE', 'BOOLEAN', where);
      other = Number(value.value);
    } else {
      other = value.value;
    }
  } else {
    const first = String(column.values[0]);
    if (value.kind === 'string') other = value.value;
    else if (value.kind === 'boolean') {
      if (!equality) return cannotCompare('VARCHAR', 'BOOLEAN', where);
      return cannotConvertColumn(first, 'BOOL', column.label, where);
    } else if (value.kind === 'integer') {
      if (!equality) return cannotCompare('VARCHAR', 'INTEGER_LITERAL', where);
      return cannotConvertColumn(first, value.type, column.label, where);
    } else if (value.kind === 'decimal') {
      if (!equality) return cannotCompare('VARCHAR', value.type, where);
      return cannotConvertColumn(first, value.type, column.label, where, '"');
    } else {
      // parseSql hands text compared with other number spellings to the tutor
      other = value.value;
    }
  }
  const shownValue = other === null ? 'NULL' : typeof other === 'string' ? `'${other}'` : String(value.kind === 'string' ? value.value : other);
  const keep = column.values.map((x) => {
    if (other === null) return false;
    const a = x as string | number;
    const b = other as string | number;
    switch (op) {
      case '=':
      case '==': return a === b;
      case '!=':
      case '<>': return a !== b;
      case '>': return a > b;
      case '<': return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
    }
  });
  const reasons = column.shown.map((x, i) => {
    const left = type === 'DOUBLE' ? x : `'${x}'`;
    const answer = other === null ? 'NULL' : keep[i] ? 'true' : 'false';
    return `${left} ${op} ${shownValue} is ${answer}`;
  });
  return { keep, reasons };
}
