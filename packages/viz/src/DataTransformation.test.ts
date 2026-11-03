import { describe, it, expect } from 'vitest';
import { formatValue, isNumericColumn } from './DataTransformation';

describe('formatValue', () => {
  it('renders null/undefined as empty string', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(true)).toBe('True');
    expect(formatValue(false)).toBe('False');
    expect(formatValue([true, 1])).toBe('[True, 1]');
    expect(formatValue(undefined)).toBe('');
  });

  it('keeps integers exact', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue(-7)).toBe('-7');
  });

  it('trims floats to at most 4 decimals without trailing zeros', () => {
    expect(formatValue(3.55)).toBe('3.55');
    expect(formatValue(1 / 3)).toBe('0.3333');
    expect(formatValue(2.5)).toBe('2.5');
  });

  it('keeps huge integers exact and uses precision notation for tiny floats', () => {
    expect(formatValue(1e16)).toBe('10000000000000000');
    expect(formatValue(0.00001)).toBe('0.00001000');
  });

  it('renders arrays like Python lists (intermediate aggregation arrays)', () => {
    expect(formatValue([3.55, 5.25])).toBe('[3.55, 5.25]');
    expect(formatValue(['a', 1])).toBe('[a, 1]');
    expect(formatValue([])).toBe('[]');
  });
});

describe('isNumericColumn', () => {
  const preview = [
    ['x', 1, null],
    ['y', 2.5, null],
    ['z', 3, 4],
  ];

  it('detects numeric columns, ignoring nulls', () => {
    expect(isNumericColumn(preview, 0)).toBe(false);
    expect(isNumericColumn(preview, 1)).toBe(true);
    expect(isNumericColumn(preview, 2)).toBe(true);
  });

  it('returns false for an all-null column', () => {
    expect(isNumericColumn([[null], [null]], 0)).toBe(false);
  });

  it('returns false for an empty preview', () => {
    expect(isNumericColumn([], 0)).toBe(false);
  });
});
