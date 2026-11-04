import { describe, it, expect } from 'vitest';
import { examples, categories, getExampleById } from './examples';

describe('examples.json', () => {
  it('loads every example with a known category and unique id', () => {
    expect(examples.length).toBeGreaterThanOrEqual(10);
    const ids = examples.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = new Set(categories.map(c => c.id));
    for (const e of examples) {
      expect(cats.has(e.category), `${e.id} has unknown category ${e.category}`).toBe(true);
      // Every notebook starts by making the cones table, in a cell that can run again
      expect(e.cells[0]).toMatch(/^-- An ice cream shop's menu\nCREATE OR REPLACE TABLE cones/);
      for (const cell of e.cells) expect(cell, `${e.id}: re-running a cell must not fail`).not.toMatch(/CREATE TABLE/);
      expect(e.markdown.startsWith('## ')).toBe(true);
    }
  });

  it('finds examples by id', () => {
    expect(getExampleById('filter-rows')?.title).toBe('Filtering Rows');
    expect(getExampleById('nope')).toBeUndefined();
  });
});
