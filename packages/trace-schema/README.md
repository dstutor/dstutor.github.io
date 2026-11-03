# @dstutor/trace-schema

The trace format: what every tracer emits and the visualization reads. It is the only thing the
two sides share, so a new library needs a tracer that emits this and nothing else in the
frontend changes.

| File | What it is |
| --- | --- |
| `src/index.ts` | The types, with a comment on every field. The source of truth. |
| `schema/trace.schema.json` | JSON Schema generated from the types (`npm run schema -w @dstutor/trace-schema`, which runs `scripts/schema.mjs`). |
| `check_trace.py` | Holds a trace to the schema and to the rules below. Every tracer's tests use it. |

## The format

A **trace** is a list of records, one per traced operation, in the order they ran.

**TraceRecord**

| Field | Type | Meaning |
| --- | --- | --- |
| `step_id` | integer ≥ 0 | Unique in the trace and increasing |
| `operation` | string | The method or function called, e.g. `where` |
| `label` | string, optional | The step's title when `operation()` would not describe the code, e.g. `keep rows where True` for `cones[cones['Price'] > 4]`. Without it the title is `operation()` |
| `args`, `kwargs` | JSON | The arguments. A predicate is sent as its name or description |
| `input`, `output` | TableState | The table before and after |
| `explanation` | string | One sentence, e.g. `Filtered rows. Kept 2, removed 4.` |
| `sub_steps` | SubStep[], optional | Frames that walk through the operation. Without them the step is one before/after frame |
| `site` | optional | Where in the cell the call was: `line`, `stmt_start`, `stmt_end` (1-based) and the assigned `target` |
| `cell`, `assigns` | optional | Added by the runtime, not the tracer: the notebook cell, and the name the statement's result goes to |

**TableState**: `num_rows` (the whole table), `num_columns`, `columns`, and `preview`, the first
rows with one value per column. `index_columns` says how many of the leading columns are row
labels, such as a pandas index: they are shown, but not counted as columns. `error` is set when the table could not be read. `kind: 'array'`
marks a single array shown as one column.

**SubStep**: a `message` replacing the explanation for that frame, an optional monospace
`detail`, `input_highlights` and `output_highlights`, and optionally an `output_state` (an
intermediate result shown instead of `output`), an `output_label`, and secondary tables
`aux_table` (another input, such as the right side of a join) and `aux_output`.

**Highlights**: `rows` and `rows_removed` (preview row indices), `columns` (labels) and `cells`
(`[row, label]` pairs).

**Values** are plain JSON. NaN, infinities and the like are not JSON, so a tracer sends `null`
for them, or, in a table's preview, `{"shown": "NaN"}`: the text its library prints for the
value, which the table shows as is (pandas sends `NaN`, `inf`, `NaT`, `<NA>` and `None` this
way). Anything else that is not JSON, such as a function, is sent as its string form.

## Rules the schema cannot express

`check_trace.py` checks these too, because the visualization relies on them:

- `num_columns` equals the number of `columns`, and every preview row has one value per column.
- A preview never has more rows than `num_rows`.
- Highlights point at preview rows and columns that exist, in the table they highlight. A frame's
  `output_highlights` refer to its `output_state`, or to the record's `output` when it has none.
- `step_id` increases through the trace.
- `site` lines are in order: `1 <= stmt_start <= line <= stmt_end`.
- The whole trace survives strict JSON (`json.dumps(trace, allow_nan=False)`).

## Checking a tracer

```python
import sys
sys.path.insert(0, 'packages/trace-schema')
from check_trace import trace_problems

assert trace_problems(tracer.trace()) == []
```

`tracers/datascience/contract_test.py` runs every gallery example, plus notebooks that reach every
traced method and the edge cases (empty results, NaN, long tables, list values, an error part way
through a cell), and checks every record. A new tracer should do the same.

## Changing the format

Change the types, the schema and every tracer together, in one change:

1. Edit `src/index.ts`, with a comment on the new field.
2. Run `npm run schema -w @dstutor/trace-schema` to regenerate the schema.
3. Update the tracers that emit it and their snapshots.

`npm run check` fails if the schema is out of date with the types, or if any tracer emits a
record the contract rejects.
