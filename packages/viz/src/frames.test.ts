import { describe, it, expect } from 'vitest';
import { flattenTrace, firstFrameOfOperation, lastFrameOfOperation, framesFor } from './frames';
import type { TraceRecord, TableState } from '@dstutor/trace-schema';

const state = (rows: number): TableState => ({
  num_rows: rows,
  num_columns: 1,
  columns: ['A'],
  preview: Array.from({ length: rows }, (_, i) => [i]),
});

const record = (operation: string, subSteps?: { message: string }[]): TraceRecord => ({
  step_id: 1,
  operation,
  args: [],
  kwargs: {},
  input: state(3),
  output: state(2),
  explanation: `${operation} explanation`,
  ...(subSteps ? { sub_steps: subSteps } : {}),
});

describe('flattenTrace', () => {
  it('returns one frame per record when no sub_steps', () => {
    const trace = [record('select'), record('drop')];
    const frames = flattenTrace(trace);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ opIndex: 0, opTotal: 2 });
    expect(frames[0].subStep).toBeUndefined();
    expect(frames[0].subIndex).toBeUndefined();
    expect(frames[1]).toMatchObject({ opIndex: 1, opTotal: 2 });
  });

  it('expands sub_steps into one frame each with sub indices', () => {
    const trace = [
      record('where'),
      record('group', [{ message: 'a' }, { message: 'b' }, { message: 'c' }]),
      record('sort'),
    ];
    const frames = flattenTrace(trace);
    expect(frames).toHaveLength(5);
    expect(frames.map(f => f.opIndex)).toEqual([0, 1, 1, 1, 2]);
    expect(frames[1]).toMatchObject({ subIndex: 0, subTotal: 3 });
    expect(frames[3]).toMatchObject({ subIndex: 2, subTotal: 3 });
    expect(frames[3].subStep?.message).toBe('c');
    expect(frames[4].subStep).toBeUndefined();
  });

  it('treats an empty sub_steps array as no sub-steps', () => {
    const frames = flattenTrace([record('take', [])]);
    expect(frames).toHaveLength(1);
    expect(frames[0].subStep).toBeUndefined();
  });

  it('handles an empty trace', () => {
    expect(flattenTrace([])).toEqual([]);
  });
});

describe('firstFrameOfOperation', () => {
  it('finds the first frame of an operation with sub-steps', () => {
    const trace = [
      record('where'),
      record('group', [{ message: 'a' }, { message: 'b' }]),
      record('sort'),
    ];
    const frames = flattenTrace(trace);
    expect(firstFrameOfOperation(frames, 0)).toBe(0);
    expect(firstFrameOfOperation(frames, 1)).toBe(1);
    expect(firstFrameOfOperation(frames, 2)).toBe(3);
  });

  it('falls back to 0 for an unknown operation index', () => {
    const frames = flattenTrace([record('where')]);
    expect(firstFrameOfOperation(frames, 99)).toBe(0);
  });
});

describe('lastFrameOfOperation', () => {
  it('finds the result frame of an operation with sub-steps', () => {
    const frames = flattenTrace([
      record('where'),
      record('group', [{ message: 'a' }, { message: 'b' }, { message: 'c' }]),
      record('sort'),
    ]);
    expect(lastFrameOfOperation(frames, 0)).toBe(0);
    expect(lastFrameOfOperation(frames, 1)).toBe(3);
    expect(lastFrameOfOperation(frames, 2)).toBe(4);
  });

  it('falls back to the final frame for an unknown operation index', () => {
    const frames = flattenTrace([record('where'), record('sort')]);
    expect(lastFrameOfOperation(frames, 99)).toBe(1);
  });
});

describe('framesFor', () => {
  const trace = [record('where'), record('group', [{ message: 'a' }, { message: 'b' }]), record('sort')];

  it('gives every walkthrough frame at the "all" level', () => {
    expect(framesFor(trace, 'all')).toHaveLength(4);
  });

  it('gives one result frame per operation at the "results" level, without sub-step positions', () => {
    const frames = framesFor(trace, 'results');
    expect(frames).toHaveLength(3);
    expect(frames.map(f => f.opIndex)).toEqual([0, 1, 2]);
    expect(frames.every(f => f.subStep === undefined && f.subIndex === undefined)).toBe(true);
  });
});
