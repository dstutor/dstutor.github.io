import { describe, it, expect } from 'vitest';
import { examples, categories, getExampleById } from './examples';

describe('examples.json', () => {
  it('loads every example with a known category and unique id', () => {
    expect(examples.length).toBeGreaterThan(20);
    const ids = examples.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(categories.map(c => c.id));
    for (const e of examples) {
      expect(cats.has(e.category), `${e.id} has unknown category ${e.category}`).toBe(true);
      expect(e.cells.length).toBeGreaterThan(0);
      expect(e.cells[0]).toContain('from datascience import *');
      expect(e.markdown.startsWith('## ')).toBe(true);
    }
  });

  it('finds examples by id', () => {
    expect(getExampleById('filter-rows')?.title).toBe('Filtering Rows');
    expect(getExampleById('nope')).toBeUndefined();
  });
});
