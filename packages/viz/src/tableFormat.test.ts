// Expected text comes from each library's own output (pandas 3.0.2 to_html, polars 1.33.1
// _repr_html_, DuckDB 1.5.1's table) for the same values.
import { describe, it, expect } from 'vitest';
import { formatColumn, polarsFloat, pythonFloat, pandasFloats, sizeText } from './tableFormat';

const MIXED = [3.55, 4.5, 4.2749999999999995, 5.0, 1234567.891, 0.000012, -2.0, 100.0];

describe('polars', () => {
  it('prints floats with fmt_float', () => {
    expect(MIXED.map(polarsFloat)).toEqual(['3.55', '4.5', '4.275', '5.0', '1.2346e6', '0.000012', '-2.0', '100.0']);
    expect([999999.5, 1e6, 0.0000012, 0.00012, 123456.789].map(polarsFloat)).toEqual(['999999.5', '1e6', '0.0000012', '0.00012', '123456.789']);
    expect([0.1 + 0.2, 12345678.0, -0.5, 1.5e-7, 2 ** 60].map(polarsFloat)).toEqual(['0.3', '1.2345678e7', '-0.5', '1.5000e-7', '1.1529e18']);
  });

  it('quotes strings and spells null and booleans its way', () => {
    expect(formatColumn(['strawberry', { shown: 'null' }], 'polars', 'str')).toEqual(['"strawberry"', 'null']);
    expect(formatColumn([true, false, { shown: 'null' }], 'polars', 'bool')).toEqual(['true', 'false', 'null']);
    expect(formatColumn([[1.5, 2], []], 'polars', 'list[f64]')).toEqual(['[1.5, 2.0]', '[]']);
    expect(formatColumn([['a', 'b']], 'polars', 'list[str]')).toEqual(['["a", "b"]']);
    expect(formatColumn([1, 2], 'polars', 'i64')).toEqual(['1', '2']);
  });
});

describe('DuckDB', () => {
  it('prints doubles like Python repr', () => {
    expect(MIXED.map(pythonFloat)).toEqual(['3.55', '4.5', '4.2749999999999995', '5.0', '1234567.891', '1.2e-05', '-2.0', '100.0']);
  });

  it('prints decimals to their scale, text unquoted, NULL and true', () => {
    expect(formatColumn([4.275, 1.5], 'duckdb', 'decimal(5,3)')).toEqual(['4.275', '1.500']);
    expect(formatColumn(['pink', { shown: 'NULL' }], 'duckdb', 'varchar')).toEqual(['pink', 'NULL']);
    expect(formatColumn([true, false], 'duckdb', 'boolean')).toEqual(['true', 'false']);
    expect(formatColumn([[3.55, 3.95]], 'duckdb', 'double[]')).toEqual(['[3.55, 3.95]']);
  });
});

describe('pandas', () => {
  it('gives every float in a column the same decimals', () => {
    expect(pandasFloats([3.55, 4.5, 5.0])).toEqual(['3.55', '4.50', '5.00']);
    expect(pandasFloats([3.55, 4.2749999999999995])).toEqual(['3.550', '4.275']);
    expect(pandasFloats([3.0000001, 2.0])).toEqual(['3.0', '2.0']);
    expect(pandasFloats([1000000.0, 2.0])).toEqual(['1000000.0', '2.0']);
    expect(pandasFloats([0.1 + 0.2, 1.0])).toEqual(['0.3', '1.0']);
  });

  it('switches the whole column to exponents for very large or small values', () => {
    expect(pandasFloats(MIXED).slice(0, 2)).toEqual(['3.550000e+00', '4.500000e+00']);
    expect(pandasFloats([0.0000001, 2.0])).toEqual(['1.000000e-07', '2.000000e+00']);
  });

  it('leaves NaN as NaN and keeps the rest of the column together', () => {
    expect(formatColumn([4.5, { shown: 'NaN' }, 3.55], 'pandas', 'float64')).toEqual(['4.50', 'NaN', '3.55']);
    expect(formatColumn([5, 6], 'pandas', 'float64')).toEqual(['5.0', '6.0']);
    expect(formatColumn([5, 6], 'pandas', 'int64')).toEqual(['5', '6']);
    expect(formatColumn([true, 'a'], 'pandas', 'object')).toEqual(['True', 'a']);
  });
});

describe('sizes', () => {
  it('in each library’s words', () => {
    expect(sizeText(6, 3, 'polars')).toBe('shape: (6, 3)');
    expect(sizeText(1, 1, 'pandas')).toBe('1 row × 1 column');
    expect(sizeText(6, 3, 'duckdb')).toBe('6 rows  3 columns');
  });
});
