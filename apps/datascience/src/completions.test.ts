import { describe, it, expect } from 'vitest';
import { extractUserNames } from './completions';

describe('extractUserNames', () => {
  it('finds assignments, defs and loop variables across cells, once each, in order', () => {
    const names = extractUserNames([
      'from datascience import *',
      "students = Table().with_columns('Name', make_array('A'))\nstudents",
      'def double(x):\n    return 2 * x\nfor row in students.rows:\n    total = total + 1',
      'students = students.select("Name")  # reassignment\nx == 3',
    ]);
    expect(names).toEqual(['students', 'double', 'row', 'total']);
  });
});
