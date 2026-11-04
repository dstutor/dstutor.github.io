// Where Cel stands in a frame, and how it looks, worked out from the frame alone (its
// highlights and where it falls in its operation). docs/visualizing-steps.md has the table
// this follows.
import type { CelState } from '@dstutor/brand';
import type { Frame } from './frames';

export interface CelPose {
  state: CelState;
  /** The Before table's header row, or a row of its preview (0-based) */
  at: 'header' | number;
  /** The frame works a column out for every row at once: Cel watches it fill in from the header */
  fills: boolean;
}

const HEADER = 'header' as const;

export function celFor(frame: Frame): CelPose {
  const { subStep, subIndex, subTotal } = frame;
  const isLast = subStep === undefined || subTotal === undefined || subIndex === subTotal - 1;
  if (isLast) return { state: 'done', at: HEADER, fills: false };

  const highlights = subStep.input_highlights ?? {};
  const kept = highlights.rows ?? [];
  const removed = highlights.rows_removed ?? [];
  const rows = new Set([...kept, ...removed, ...(highlights.cells ?? []).map(([r]) => r)]);
  const columns = highlights.columns ?? [];
  const building = Boolean(subStep.output_state || subStep.aux_output);

  if (rows.size === 1) {
    const [row] = rows;
    const onlyRemoved = removed.includes(row) && !kept.includes(row);
    return { state: onlyRemoved ? 'removed' : 'running', at: row, fills: false };
  }
  if (removed.length > 0) return { state: 'grouped', at: HEADER, fills: false };
  if (rows.size === 0 && columns.length > 0) return { state: 'running', at: HEADER, fills: true };
  if (rows.size > 1 && building) return { state: 'grouped', at: HEADER, fills: false };
  return { state: 'running', at: HEADER, fills: false };
}
