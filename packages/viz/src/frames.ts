import type { TraceRecord, SubStep } from '@dstutor/trace-schema';

/** One navigable slide: an operation, optionally narrowed to one of its sub-steps. */
export interface Frame {
  record: TraceRecord;
  subStep?: SubStep;
  /** Operation-level position (0-based) */
  opIndex: number;
  opTotal: number;
  /** Position within the operation's sub-steps (0-based); absent when the operation has none */
  subIndex?: number;
  subTotal?: number;
}

/** Expand each trace record into one frame per sub-step (or a single before/after frame). */
export function flattenTrace(trace: TraceRecord[]): Frame[] {
  const frames: Frame[] = [];
  trace.forEach((record, opIndex) => {
    const subs = record.sub_steps;
    if (subs && subs.length > 0) {
      subs.forEach((subStep, subIndex) => {
        frames.push({ record, subStep, opIndex, opTotal: trace.length, subIndex, subTotal: subs.length });
      });
    } else {
      frames.push({ record, opIndex, opTotal: trace.length });
    }
  });
  return frames;
}

/** What a step is called: its label when the tracer gave one, otherwise operation() */
export function stepTitle(record: TraceRecord): string {
  return record.label ?? `${record.operation}()`;
}

/** How much of each operation to show: every walkthrough frame, or just its result */
export type DetailLevel = 'all' | 'results';

/** One frame per operation, without the walkthrough: the plain before/after view. */
export function resultFrames(trace: TraceRecord[]): Frame[] {
  return trace.map((record, opIndex) => ({ record, opIndex, opTotal: trace.length }));
}

export function framesFor(trace: TraceRecord[], detail: DetailLevel): Frame[] {
  return detail === 'results' ? resultFrames(trace) : flattenTrace(trace);
}

/** Index of the first frame belonging to the given operation. */
export function firstFrameOfOperation(frames: Frame[], opIndex: number): number {
  const idx = frames.findIndex(f => f.opIndex === opIndex);
  return idx === -1 ? 0 : idx;
}

/** Index of the last frame (the result) of the given operation. */
export function lastFrameOfOperation(frames: Frame[], opIndex: number): number {
  let last = -1;
  frames.forEach((f, i) => { if (f.opIndex === opIndex) last = i; });
  return last === -1 ? frames.length - 1 : last;
}
