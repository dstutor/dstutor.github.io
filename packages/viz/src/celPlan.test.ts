import { describe, it, expect } from 'vitest';
import type { SubStep, TableState, TraceRecord } from '@dstutor/trace-schema';
import { celFor } from './celPlan';
import { flattenTrace } from './frames';

const table = (rows: number): TableState => ({
  num_rows: rows,
  num_columns: 2,
  columns: ['Flavor', 'Price'],
  preview: Array.from({ length: rows }, (_, i) => [`f${i}`, i]),
});

/** The frames of one operation whose walkthrough is subSteps */
const frames = (subSteps?: SubStep[]) => {
  const record: TraceRecord = {
    step_id: 0,
    operation: 'filter',
    args: [],
    kwargs: {},
    input: table(4),
    output: table(2),
    explanation: '',
    ...(subSteps ? { sub_steps: subSteps } : {}),
  };
  return flattenTrace([record]);
};

describe('celFor', () => {
  it('is done at the header when the operation has no walkthrough', () => {
    expect(celFor(frames()[0])).toEqual({ state: 'done', at: 'header', fills: false });
  });

  it('watches a column fill in from the header, then is done on the last frame', () => {
    // pandas' filter: the condition as a True/False column, then the kept rows
    const [check, keep] = frames([
      { message: 'check', input_highlights: { columns: ['Price'] }, output_state: table(4) },
      { message: 'keep', input_highlights: { rows: [1, 3], rows_removed: [0, 2], columns: ['Price'] } },
    ]);
    expect(celFor(check)).toEqual({ state: 'running', at: 'header', fills: true });
    expect(celFor(keep)).toEqual({ state: 'done', at: 'header', fills: false });
  });

  it('stands beside the one row a frame is about, crossed out when it is removed', () => {
    const [placed, dropped] = frames([
      { message: 'place row 2', input_highlights: { rows: [2] } },
      { message: 'no match', input_highlights: { rows_removed: [3] } },
      { message: 'result' },
    ]);
    expect(celFor(placed)).toEqual({ state: 'running', at: 2, fills: false });
    expect(celFor(dropped)).toEqual({ state: 'removed', at: 3, fills: false });
  });

  it('counts a highlighted cell as its row', () => {
    const [cell] = frames([{ message: 'one cell', input_highlights: { cells: [[1, 'Price']] } }, { message: 'end' }]);
    expect(celFor(cell)).toMatchObject({ state: 'running', at: 1 });
  });

  it('gathers rows when some are kept and others removed before the last frame', () => {
    const [keep] = frames([
      { message: 'keep', input_highlights: { rows: [0, 1], rows_removed: [2, 3] } },
      { message: 'result' },
    ]);
    expect(celFor(keep)).toEqual({ state: 'grouped', at: 'header', fills: false });
  });

  it('gathers a group into a result that is still building', () => {
    const [group] = frames([
      { message: 'group', input_highlights: { rows: [0, 2] }, output_state: table(1) },
      { message: 'result' },
    ]);
    expect(celFor(group)).toEqual({ state: 'grouped', at: 'header', fills: false });
  });

  it('waits at the header for a frame with nothing highlighted', () => {
    const [intro] = frames([{ message: 'intro' }, { message: 'result' }]);
    expect(celFor(intro)).toEqual({ state: 'running', at: 'header', fills: false });
  });
});
