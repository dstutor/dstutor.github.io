# How steps show columnar, large and lazy data

The datascience tutor and the hub's demo cell grew up on six-row tables: Cel walks down the
rows, checks each one and keeps or removes it. That works as a picture of `where`, but pandas
and polars compute a whole column at once, real tables have thousands of rows, a polars
LazyFrame does nothing until `collect()`, and SQL runs a query as one statement. This note
records how each of those is shown, so every tutor follows the same rules. It is the design
the tracers and packages/viz implement; change it here first.

## Rules for every tutor

1. **A step shows what the library computes, in the order it computes it.** A vectorized filter
   evaluates the condition for every row at once, so its first frame is the condition as a
   column of True and False, the same thing the student would see if they printed
   `cones['Price'] > 4`. Its second frame keeps the rows where it is True. Row by row is not
   how pandas, polars or DuckDB work, so it is never a sequence of frames.

2. **A column is worked out at once, so it appears at once.** In a frame that works a column
   out (a condition's True/False, a new column), Cel stands at the column's header and the
   whole column fills in together; Cel does not visit each row, which would say the opposite
   of "every row at once". The rows a step keeps or removes are the next frame's business.

3. **Frames hold still; motion is short and never hides anything.** A frame arrives complete
   and stays until the student moves on, by Next and Previous or by Play (which steps through
   the frames on a timer, 3 s each by default, and stops at the end). What moves is brief: a
   new column fills in, rows arriving in a result slide in one after another, struck-through
   rows fade, Cel glides to its next place. With reduced motion nothing moves.

4. **Frames are drawn from the preview; counts come from the whole table.** Every table is
   cut to its first 20 rows (`MAX_ROWS_PREVIEW` in each tracer). Highlights point into the
   preview. Messages count all rows ("kept 1,204, removed 8,796") and say when the
   picture is a preview ("showing the first 20 of 10,000"). No frame count grows with the
   number of rows.

5. **A few stages per operation, never one frame per row or per key.** Each operation is two
   to four stages (see Stages above); many keys or groups fit in one stage as cards, the first
   six shown and the rest counted. with_columns shows at most four columns, one per frame. A
   step that cannot be shown this way gets the plain before/after view. The contract tests
   hold every walkthrough to this.

6. **Tables print the way the library prints them** in a notebook (`TutorConfig.tableStyle`):
   pandas as Jupyter shows a DataFrame (right aligned, striped, the index in bold, a float
   column sharing its decimals: 4.50); polars with `shape: (6, 3)` above, each column's type
   under its name (`str`, `f64`), strings in quotes and `true`/`false`; DuckDB as its box,
   with types (`varchar`, `double`) and `NULL`. Tracers send each column's type
   (`column_types`); viz/tableFormat.ts follows each library's own number formatting, tested
   against its output. Values JSON cannot hold are sent as the library prints them:
   `{"shown": "NaN"}`, `{"shown": "null"}`, `{"shown": "NULL"}`, never a blank cell.

## Stages: the thinking from input to output

Research (docs/research/teaching.md, docs/research/internals.md) shows two tables side by side
hide the reasoning. Each operation is shown as a few named **stages** (a rail at the top of the
step: ① → ② → ③), and a stage draws what fits it, not always a table:

| Operation | Stages |
| --- | --- |
| join | **Which keys match**: a Venn of the distinct key values (left only, both, right only), shaded where this join keeps rows; accurate over keys, which is all a Venn can be accurate about. **How rows pair**: one card per key, `2 left × 1 right → 2 rows`, unmatched keys kept with NULL or dropped. **Result**: rows coloured by their key. |
| group by | **Sort rows into groups**: rows coloured by key, one card per group with its values. **Combine each group**: each card shows its arithmetic, `mean(4.75, 5.25) = 5.0`, with a note on how the library really does it (pandas and DuckDB keep a running total per group in one pass; polars keeps a list of row numbers per group). **One row per group**: the result, and its group-order rule. |
| filter | **Ask every row** (the condition as a column, null a third state), **Keep the True rows** with a count. |
| sort | **Read the sort key**, **Work out the new order** (a strip of where each row came from, ties banded), **Move every row at once**. Libraries compute a permutation and gather rows in one pass; they do not place rows one by one. |
| pivot | **Lay out the grid**, **Gather each cell's values**, **Combine each cell**, **Empty cells**. pandas' pivot_table is group by then unstack. |
| SQL | Clause by clause in logical order, labelled as what the query means; a last stage shows **How DuckDB ran it**: its physical plan with the rows out of each operator (WHERE pushed into the scan, TOP_N). |
| lazy polars | Steps as written, then **How polars runs it**: the plan as written next to the optimized plan. |

Colours: rows of one key or group share one of eight colours, the same in every stage and
always shown with the key's label. The trace carries these as `row_colors` in highlights,
`stage` and `note` on sub-steps, and a `panel` (keys, pairs, groups, order, plan) for a stage
that is not a table.

## Per library

### datascience

Unchanged. `where` checks every row's value against the predicate; Data 8 teaches it that
way and the tracer matches the old app. Cel joins the frames (see below).

### pandas

The stages above. The index is shown as the first column(s) (`index_columns`); a sort's new
order is the index labels in their new order, and a merge's result follows pandas' row order
(left order for inner and left, right order for right, sorted keys for outer). Notes say what
pandas does underneath: argsort then one gather for a sort; shared key codes and every
left × right pair for a merge; a running total per group (not lists) for sum, mean and count;
groupby + unstack for pivot_table; assign works its columns out in order.

### polars, eager

The same frames as pandas, without an index (polars has none; row order is the only
label). Expressions are shown as written: the condition column for
`df.filter(pl.col('Price') > 4)` is headed `pl.col('Price') > 4`. Traced:

| Code | Stages |
| --- | --- |
| `filter(expr)` | ask every row (the expression as a True/False column); keep the True rows |
| `with_columns(...)` | work out each new or replaced column as a whole; the result. Note: every expression reads the same input table |
| `select(...)` | work out the columns; the result |
| `sort(...)` | read the sort key; the new order of positions (with each row's key, ties bracketed); move every row at once. Note: nulls first by default |
| `group_by(...).agg(...)` | sort rows into groups; combine each group; one row per group. Note: a hash table of row lists per key |
| `join(...)` | which keys match; how rows pair; the result. Nulls never match unless `nulls_equal=True` |
| `pivot(...)` | lay out the grid; gather each cell's values; combine each cell; empty cells |

`group_by` gets `maintain_order=True` in every example so the groups come out in a stable
order, and the tracer shows groups in the order polars returns them.

### polars, lazy

A LazyFrame only records a plan. The tracer records each method called on it (with its
source text, like any other step) and, at `collect()`, runs each prefix of the chain on its
own to get the table after that step. Those tables become ordinary steps, the same as the
eager ones and pointing at their own line of the chain, followed by a `collect()` step whose
detail is the optimized plan from `explain()`. The explanation says the rows were worked out
when `collect()` ran, not when each line ran. A chain of more than 12 steps shows only its
`collect()`. The chain rides on the LazyFrame each call returns, so two queries built from the
same LazyFrame each show their own steps.

### SQL (DuckDB)

A query is one statement, but SQL runs its clauses in a fixed logical order, which is not
the order they are written. The tracer shows one step per clause, in that order:

    FROM (and JOIN) → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT

The steps come from DuckDB's own parser, not from string slicing: `json_serialize_sql` gives
the query's syntax tree, each step keeps only the clauses so far, `json_deserialize_sql`
turns it back into SQL, and DuckDB runs that. Each step's label is the clause as written in
the cell (`WHERE Price > 4`), found with DuckDB's tokenizer (clause keywords outside
parentheses). Each step's site spans its clause's lines, so the notebook marks the clause
the step is about as you step through.

- WHERE and HAVING get the same two frames as a filter: the condition as a column of true and
  false (the condition added to the select list), then the rows or groups kept.
- GROUP BY gets the groupby frames, with the SELECT's aggregates worked out for each group
  (`AVG(4.75, 5.25) = 5`), so a grouped query has no separate SELECT step. With aggregates
  and no GROUP BY, SELECT treats the whole table as one group.
- A JOIN in FROM walks each key, as a pandas merge does; a join on anything but one column
  each side (or USING one column) gets the plain view.
- A bare `SELECT * FROM cones` is not a step, just as showing a DataFrame is not.
- Queries with WITH, UNION or QUALIFY run and show their result without steps.

The tracer runs DuckDB on one thread, so each step's query returns rows in the same order, and
with Python replacement scans off, so `FROM text` cannot find one of the tracer's own
variables. DuckDB returns `DECIMAL` values as Python `Decimal`; the tracer sends them as
numbers. Names are case-insensitive, as in DuckDB. Errors are DuckDB's own messages, with the
line and a caret, not a Python traceback.

## Cel in the visualization

Cel lives in packages/viz, beside the Before table, the way it walks beside the demo cell's
table on the hub. It is driven only by the frame being shown:

| Frame | Cel |
| --- | --- |
| works a column out (column highlighted, no rows) | running, at the header, while the column fills in |
| highlights exactly one row (sort placing it, a group's row) | running, level with that row |
| highlights exactly one removed row | removed (crossed-out eyes), level with that row |
| keeps some rows and removes others | grouped, at the header |
| collects groups or fills a result that is still building | grouped, at the header |
| the operation's last frame, or a frame with no walkthrough | done, at the header |

With reduced motion, Cel goes straight to its place instead of gliding.
Cel's colors come from @dstutor/brand's `--cel-*` properties, which have light and dark
values. In a PDF export Cel is drawn where the frame leaves it. The step card stays mounted
for all the frames of one operation, so Cel glides from frame to frame instead of starting over.

## Keeping packages/viz portable

The Roadmap's `pip install dstutor` bundles packages/viz as an anywidget, with no tutor
shell around it. So packages/viz:

- imports only React, @dstutor/trace-schema and @dstutor/brand (ESLint's
  `no-restricted-imports` rejects notebook-ui, runtime-pyodide and the hub);
- ships `standalone.css`, the design tokens it uses with light and dark defaults, scoped to
  `.dstutor-standalone`, so it looks right in a notebook that has none of the tutor's CSS. A
  unit test checks that every token the viz's CSS uses has a default there.

## The hub's demo cell

The demo cell still walks row by row: it is six rows long and is the hub's first impression.
That no longer matches the tutors, which work the column out at once (rule 2); see below. Its words say what the tutors'
frames say: datascience checks each row's value; pandas, polars and SQL give each row true or
false. polars and SQL have their own small interpreters (polarsDemo.ts, sqlDemo.ts), tested
against real runs like the others. The SQL one reproduces DuckDB's errors exactly, including
its "Candidate bindings" for a misspelled column (DuckDB's Jaro-Winkler ranking). For a table
name far from `cones`, DuckDB would suggest one of its own system tables, so the demo hands
that to the tutor instead of guessing.

## Decisions to revisit

- The datascience tutor still uses the frames ported from the old app (its tests compare them
  with the old tracer's snapshots). Moving its join, group and sort to the stages means
  regenerating those snapshots on purpose.

- The hub's demo cell walks rows one at a time while the tutors show the column at once.

- The demo cell does not add a True/False column for pandas and polars. If the hub and the
  tutors still feel different once Cel is in the tutors, add it.
- Lazy prefixes rerun the query once per step. That is fine at teaching sizes; if it is
  slow on large inputs, show only `collect()` for tables over a size limit.
- The SQL tutor runs one query per cell. Cells that run several statements show a step per
  query, each with its own clauses.
