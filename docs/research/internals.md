# What pandas 3.0.2, polars 1.33.1 and DuckDB 1.5.1 actually do

Research for the step redesign (docs/visualizing-steps.md), November 2026, checked against
the source and by experiments under CPython 3.14 (numpy 2.4.6, arm64). Source links:
PD = github.com/pandas-dev/pandas/blob/v3.0.2/pandas/, PL =
github.com/pola-rs/polars/blob/py-1.33.1/crates/, DK = github.com/duckdb/duckdb/blob/v1.5.1/src/.

**Rule for drawing results: take row order from the real result** (tag rows with their position
before the operation); never re-simulate. Many orders depend on platform, thread count or a
random hash seed.

## Filtering

- pandas: `_getitem_bool_array` → `check_bool_indexer` → `key.nonzero()[0]` → `take`
  (PD core/frame.py#L4406); `.loc` the same (core/indexing.py#L1222); `.query` = `eval` +
  `loc`. NaN > 55 is False; a nullable `<NA>` in a mask counts as False.
- polars: the predicate becomes a Boolean column, then `df.filter(mask)`; "Treat null mask
  values as false" (PL polars-compute/src/filter/mod.rs#L18-28). **NaN > 55 is True** (NaN
  sorts above every number).
- DuckDB: no mask column — `SelectExpression` writes passing row indices into a
  SelectionVector, then slices (DK execution/operator/filter/physical_filter.cpp#L44-52); AND
  terms run on survivors and are adaptively reordered; on a table, WHERE is pushed into
  SEQ_SCAN (`Filters: ...`). NULL compares drop the row; NaN > 55 is TRUE.
- Framing "True/False column, then keep rows" is fine; show null as a third state and the NaN
  difference between pandas and polars/DuckDB.
- Kept rows keep their relative order in all three.

## Sorting

- pandas one key: `nargsort` removes NaN, `argsort(kind='quicksort')`, NaN appended last for
  both directions (PD core/sorting.py#L372); several keys: `lexsort_indexer` (codes, then stable
  `np.lexsort`); then one `take`.
- polars one key: stable sort of (index, value); several keys: unstable unless
  `maintain_order=True` (PL polars-core/src/chunked_array/ops/sort/).
- DuckDB: keys packed into one byte-comparable key, vergesort/radix runs merged
  (DK common/sort/); ORDER BY + LIMIT becomes TOP_N.
- **Framing "place rows one by one" is wrong**: all three compute a permutation of row
  positions from the keys, then gather every row in one pass.
- Ties: pandas single-key quicksort reorders ties for n ≥ 17 (stable for n ≤ 16 and for several
  keys or `kind="stable"`); polars multi-key reorders ties at larger n; DuckDB not guaranteed.
  Pyodide's numpy uses a different sort than native arm64, so pandas tie order can differ
  between the browser and CPython tests.
- Nulls: pandas NaN last either direction; polars null **first** by default; DuckDB NULL last.
- Permutation: pandas `df.reset_index(drop=True).sort_values(by).index`; polars
  `with_row_index("_i").sort(by)["_i"]`; DuckDB keep a rowid column.

## Group by + aggregate

- pandas: keys factorized to integer codes (`algorithms.factorize(sort=...)`, PD
  core/groupby/grouper.py#L621); `group_sum`/`group_mean` make **one pass over rows in original
  order adding into a per-group slot** (PD _libs/groupby.pyx#L702, #L1193) — no lists;
  `group_median` sorts rows by group and works on contiguous slices.
- polars: hash map from key to `(first, all=[row indices])` (PL
  polars-core/src/frame/group_by/hashing.rs#L75-110), then each aggregation runs per group's
  index list — lists of rows really exist.
- DuckDB: hash table of aggregate states updated per 2048-row vector (DK
  execution/aggregate_hashtable.cpp); small key domains use PERFECT_HASH_GROUP_BY.
- Framing "collect each group's values into lists, then combine" is accurate for polars and
  pandas median/apply; for pandas sum/mean/count/min/max and DuckDB it is a running total per
  group.
- Order: pandas sorted keys by default (NaN group dropped, or last with dropna=False);
  polars arbitrary unless `maintain_order=True` (random per-process seed); DuckDB arbitrary
  without ORDER BY. Null keys form their own group in polars and DuckDB.
- Intermediates: pandas `pd.factorize(col, sort=True)`, `g.indices`, `g[c].agg(list)`;
  polars `with_row_index().group_by(k, maintain_order=True).agg(pl.col("index"), pl.col(c))`;
  DuckDB `SELECT k, list(v), sum(v) ... GROUP BY k`.

## Joins

- pandas: `_factorize_keys` puts both sides' keys in one hash table (shared codes; **NaN
  matches NaN**); libjoin counting-sorts each side by code and emits `left × right` pairs per
  code; `sort=False` re-sorts pairs into left order; `how="outer"` forces sorting;
  `indicator=True` maps 1/2/3 to left_only/right_only/both (PD core/reshape/merge.py).
- polars: the shorter side builds `PlHashMap<key, IdxVec>`, the other probes and emits one pair
  per stored index, in parallel partitions; `maintain_order` default "none" (stable sort of the
  pairs otherwise); nulls don't match by default; full joins keep `k` and `k_right`.
- DuckDB: the optimizer picks the cheaper build side; duplicate build rows are chained newest
  first; probing emits matches in rounds (every row's first match, then every second...), so one
  row's duplicates interleave with others'. IN → SEMI/MARK join; NOT IN against a NULL returns
  nothing.
- "For each key, pair left rows × right rows" is pandas' inner loop, but output is not grouped
  by key; show each left row repeated once per match, then each library's real output order.
- Verified orders (L keys [b, a, c, b, None], R keys [b, d, b, a, None]): pandas inner/left in
  left order with each row's matches in right order; right in right order; outer keys sorted,
  NaN last. polars default inner followed probe order; full join put unmatched left rows last.
- Intermediates: pandas `L.assign(_l=...).merge(R.assign(_r=...), indicator=True)`; polars
  `with_row_index` both sides + `maintain_order="left_right"`; DuckDB carry rowid.

## Pivot

- pandas `pivot_table` = `groupby(index+columns).agg()` → `unstack(columns)` (verified equal;
  PD core/reshape/pivot.py#L284-410); `pivot` = `set_index` + `unstack`, raises on duplicates;
  rows and columns sorted.
- polars: `group_by_stable(index+[on])`, aggregate, scatter into a grid; rows and columns in
  **first-appearance order** (pandas sorts); no aggregate function → error on duplicates.
- DuckDB PIVOT: distinct values first (an ENUM, sorted), then ≤ 20 values as one GROUP BY with
  `FILTER (WHERE q IS NOT DISTINCT FROM ...)` aggregates per column; row order unspecified.

## Column expressions

- pandas `assign` evaluates keyword arguments in order: a later callable sees earlier results.
- polars `with_columns` evaluates every expression against the **same input frame**, in
  parallel; a column created in the same call is not visible (ColumnNotFoundError).
  `with_columns(x=col.x+10, y=col.x*100)` gives y = 100, 200; pandas `assign` gives 1100, 1200.
- DuckDB SELECT can reuse an earlier alias (`x*2 AS d, d+1 AS e`), but an alias shadowing an
  input column loses to the input column.

## Lazy plans and SQL plans

- polars optimizer passes (all on by default): type coercion/check, expression simplification,
  common subplan / subexpression elimination, projection and predicate pushdown, slice
  pushdown, join collapsing, cluster_with_columns, ... `explain(optimized=False)` shows the
  chain as written; `lf.profile()[1]` lists the nodes that ran. The in-memory engine
  materializes at each node of the **optimized** plan, so the table after a written step often
  never exists; streaming never holds whole intermediates.
- DuckDB: `PRAGMA explain_output='all'` shows logical, optimized and physical plans. The
  logical plan follows clause order (SEQ_SCAN → FILTER → AGGREGATE → FILTER(HAVING) → PROJECTION
  → ORDER_BY → LIMIT); the physical plan pushes WHERE into the scan, uses
  PERFECT_HASH_GROUP_BY, TOP_N. Row counts per operator:
  `json.loads(con.sql("EXPLAIN (ANALYZE, FORMAT JSON) " + q).fetchall()[0][1])` → `children`,
  `operator_name`, `operator_cardinality`, `extra_info`.
- Our prefix and clause-by-clause steps give correct **logical** results, not what ran; label
  them so, and optionally show the optimized plan beside them. Without ORDER BY, prefix results
  have no guaranteed order (threads=1 keeps them repeatable).
