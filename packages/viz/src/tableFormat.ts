// Values the way each library prints them in a notebook, so a step's tables read like the
// library's own output. A tracer sends plain JSON (and {shown: text} for NaN, null and the
// like); this turns a column of it into the text pandas, polars or DuckDB would show. The style
// comes from the tutor (TutorConfig.tableStyle); column types come from the trace.

export type TableStyle = 'datascience' | 'pandas' | 'polars' | 'duckdb';

/** The text a tracer sent for a value JSON cannot hold (NaN, null, NaT), or null */
export function shownText(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const shown = (value as { shown?: unknown }).shown;
  return typeof shown === 'string' ? shown : null;
}

/** The datascience tutor's own rules (and the fallback): Python's spelling, numbers trimmed */
export function formatValue(value: unknown): string {
  const shown = shownText(value);
  if (shown !== null) return shown;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return '[' + value.map(formatValue).join(', ') + ']';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toString();
    if (Math.abs(value) >= 1e15 || (value !== 0 && Math.abs(value) < 1e-4)) return value.toPrecision(4);
    return parseFloat(value.toFixed(4)).toString();
  }
  return String(value);
}

/** x as a plain decimal with no exponent, shortest digits (what Rust's {} prints for an f64) */
function plainDecimal(x: number): string {
  const s = String(x);
  if (!/e/i.test(s)) return s;
  const [mantissa, exp] = s.split(/e/i);
  const e = Number(exp);
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const point = mantissa.replace('-', '').indexOf('.') === -1 ? mantissa.replace('-', '').length : mantissa.replace('-', '').indexOf('.');
  const at = point + e;
  const body = at <= 0 ? `0.${'0'.repeat(-at)}${digits}` : at >= digits.length ? digits + '0'.repeat(at - digits.length) : `${digits.slice(0, at)}.${digits.slice(at)}`;
  return (negative ? '-' : '') + body;
}

/** Rust's {:e} / {:.Ne}: no plus sign, no padding (1.2346e6, 1.5000e-7) */
const rustExp = (x: number, decimals?: number) => (decimals === undefined ? x.toExponential() : x.toExponential(decimals)).replace('e+', 'e');

/** polars' fmt_float (polars-core, "mixed" float format), as its tables print an f64 */
export function polarsFloat(x: number): string {
  const abs = Math.abs(x);
  if (Number.isInteger(x) && abs < 999999) return x.toFixed(1);
  const plain = plainDecimal(x);
  if (plain.length > 9) {
    if (!(abs >= 0.000001 && abs < 999999) || abs > 999999) return rustExp(x, 4);
    const fixed = x.toFixed(6);
    if (!fixed.endsWith('0')) return fixed;
    const trimmed = fixed.replace(/0+$/, '');
    return trimmed.endsWith('.') ? `${trimmed}0` : trimmed;
  }
  if (!Number.isInteger(x)) return plain;
  return rustExp(x);
}

/** Python's repr of a float, which DuckDB's tables follow: 5.0, 4.2749999999999995, 1.2e-05 */
export function pythonFloat(x: number): string {
  const abs = Math.abs(x);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mantissa, exp] = x.toExponential().split('e');
    const sign = exp.startsWith('-') ? '-' : '+';
    return `${mantissa}e${sign}${exp.replace(/^[-+]/, '').padStart(2, '0')}`;
  }
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

/** pandas' float column format: '%.6f' trimmed of zeros all values share, or '%.6e' for all */
export function pandasFloats(values: number[]): string[] {
  const abs = values.map(Math.abs);
  if (abs.some((a) => a > 1e6) || abs.some((a) => a > 0 && a < 1e-6)) {
    return values.map((x) => {
      const [mantissa, exp] = x.toExponential(6).split('e');
      const sign = exp.startsWith('-') ? '-' : '+';
      return `${mantissa}e${sign}${exp.replace(/^[-+]/, '').padStart(2, '0')}`;
    });
  }
  let out = values.map((x) => x.toFixed(6));
  while (out.length > 0 && out.every((s) => s.endsWith('0'))) out = out.map((s) => s.slice(0, -1));
  return out.map((s) => (s.endsWith('.') ? `${s}0` : s));
}

const isFloatType = (type: string | undefined) => !!type && /^(f16|f32|f64|float\d*|double|real)$/i.test(type);
const decimalScale = (type: string | undefined) => (type ? Number(type.match(/^decimal\(\d+,\s*(\d+)\)$/i)?.[1] ?? NaN) : NaN);

/** A value inside a list cell, as the library spells items */
function itemText(value: unknown, style: TableStyle, itemType: string | undefined): string {
  const shown = shownText(value);
  if (shown !== null) return shown;
  if (value === null || value === undefined) return style === 'duckdb' ? 'NULL' : style === 'polars' ? 'null' : 'None';
  if (Array.isArray(value)) return `[${value.map((v) => itemText(v, style, undefined)).join(', ')}]`;
  if (typeof value === 'string') return style === 'polars' ? `"${value}"` : style === 'duckdb' ? value : `'${value}'`;
  if (typeof value === 'boolean') return style === 'polars' || style === 'duckdb' ? String(value) : value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (style === 'polars' && isFloatType(itemType)) return polarsFloat(value);
    if (style === 'duckdb' && isFloatType(itemType)) return pythonFloat(value);
    return style === 'datascience' || style === 'pandas' ? formatValue(value) : String(value);
  }
  return String(value);
}

/**
 * Text for every value of one column, as the library prints that column. Columns are formatted
 * together because pandas gives every float in a column the same number of decimals.
 */
export function formatColumn(values: unknown[], style: TableStyle, type?: string): string[] {
  if (style === 'datascience') return values.map(formatValue);
  if (style === 'pandas') {
    const floats = type ? /^float/.test(type) : values.some((v) => typeof v === 'number' && !Number.isInteger(v));
    const numbers = values.filter((v): v is number => typeof v === 'number');
    if (floats && numbers.length === values.filter((v) => shownText(v) === null && v !== null).length && numbers.length > 0) {
      const texts = pandasFloats(numbers);
      let k = 0;
      return values.map((v) => (typeof v === 'number' ? texts[k++] : formatValue(v)));
    }
    return values.map(formatValue);
  }
  // polars and DuckDB: lists of the column's item type, list[f64] or double[]
  const itemType = type?.match(/^list\[(.+)\]$/)?.[1] ?? type?.match(/^(.+)\[\]$/)?.[1];
  const scale = decimalScale(type);
  return values.map((v) => {
    const shown = shownText(v);
    if (shown !== null) return shown;
    if (Array.isArray(v)) return `[${v.map((x) => itemText(x, style, itemType)).join(', ')}]`;
    if (typeof v === 'number' && !Number.isNaN(scale)) return v.toFixed(scale);
    if (typeof v === 'number' && isFloatType(type)) return style === 'polars' ? polarsFloat(v) : pythonFloat(v);
    if (typeof v === 'string' && style === 'duckdb') return v;
    return itemText(v, style, type);
  });
}

/** Where a column's values sit: numbers to the right, as every library prints them */
export function isNumericColumn(preview: unknown[][], colIndex: number): boolean {
  let sawNumber = false;
  for (const row of preview) {
    const v = row[colIndex];
    // A missing value (blank, or NaN as its library prints it) does not decide the column's type
    if (v === null || v === undefined || shownText(v) !== null) continue;
    if (typeof v !== 'number') return false;
    sawNumber = true;
  }
  return sawNumber;
}

/** How big a table is, in its library's words */
export function sizeText(rows: number, columns: number, style: TableStyle): string {
  if (style === 'polars') return `shape: (${rows}, ${columns})`;
  const r = `${rows} row${rows === 1 ? '' : 's'}`;
  const c = `${columns} column${columns === 1 ? '' : 's'}`;
  return style === 'duckdb' ? `${r}  ${c}` : `${r} × ${c}`;
}
