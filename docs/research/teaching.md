# How curricula, docs and research tools teach data transformations

Research for the step redesign (docs/visualizing-steps.md), November 2026. Sources are cited
inline; what follows each operation is the recommendation drawn from them.

## Across operations

- **Decompose into stages.** Effective explanations split an operation into sub-steps
  (split→apply→combine; match keys→pair rows→fill NA; repeat→names become values→unwind).
- **Colour carries provenance.** Pandas Tutor colours rows per group and links matched rows by
  colour; tidyexplain carries key colour into the result (ColorBrewer Set1 keys, grey values,
  white NA: github.com/gadenbuie/tidyexplain).
- **Static frames vs. animation.** Pandas Tutor avoids animation so frames are screenshot-able,
  and caps tables at 12×8, sampling rows per group (Lau, Kross, Wu, Guo, DataEd '23:
  par.nsf.gov/servlets/purl/10485876). Datamations (animated) is the only RCT-tested approach;
  its users asked for pause/replay and bigger tables. Tversky et al. 2002 (animation often
  "too complex or too fast"; people conceive continuous events as discrete steps:
  hci.stanford.edu/courses/cs448b/papers/Tversky_AnimationFacilitate_IJHCS02.pdf); Heer &
  Robertson 2007 (animated transitions help object tracking: idl.uw.edu/papers/animated-transitions).
  So: user-stepped static stages, short optional transitions.
- **Choose example rows for completeness.** Pig's ILLUSTRATE (Olston et al., SIGMOD 2009) picks
  examples so every step shows every case; when truncating, keep filtered-out rows, unmatched
  keys and duplicate keys.

## Joins

Metaphors:
- **Venn**: Atwood shades circle regions (blog.codinghorror.com/a-visual-explanation-of-sql-joins/),
  conceding his diagrams "didn't quite match" SQL and cross joins "can't be expressed".
- **Cartesian product + filter**: Lukas Eder, "a JOIN is really a cartesian product … with a
  filter"; outer joins add back NULL-padded rows (blog.jooq.org/say-no-to-venn-diagrams-when-explaining-joins/).
- **R4DS 2e row-matching grid** (r4ds.hadley.nz/joins.html): x rows across, y rows down, a dot
  where keys match = one output row; outer joins add a "virtual" NA row; a row with 0/1/2 matches
  is dropped/kept/duplicated; semi/anti: "only the existence of a match is important".
- **tidyexplain**: coloured key tile + grey value tile; y rows slide beside matching x rows; NA
  white; left-join-extra duplicates the x row when y has two matches.
- **Pandas Tutor**: inputs side by side, output below, key columns boxed, rows colour-linked.
- Posit dplyr cheatsheet: small x/y/result tables, no Venn; semi_join "to see what will be
  included", anti_join for what won't. pandas `indicator=True` gives left_only/both/right_only
  (pandas.pydata.org/docs/user_guide/merging.html); duplicate keys give a "Cartesian product".

What works / misleads (expert argument; no controlled study found): Wickham, Venn "might jog
your memory about which rows are preserved" but "fails to illustrate what's happening with the
columns". Against Venn: area never exceeds A+B but joins multiply rows; most join bugs are
multiple matches (news.ycombinator.com/item?id=18890893). **Venn is accurate over distinct key
values (and for semi/anti); wrong for row counts and columns.**

Recommendation: (1) key survival: Venn/three bins of distinct keys (left-only / both /
right-only = pandas `_merge`), shading what this join keeps, with counts; (2) row pairing:
one card per key with an m×n mini-grid, duplicates explicit ("1×1 + 2×1 + 1 unmatched = 4");
(3) assemble with NA tiles. Semi/anti: Venn + struck rows, never duplicates. Cross: full grid.

## Group by + aggregate

- Wickham's split-apply-combine (vita.had.co.nz/papers/plyr.pdf); VanderPlas: keyed table →
  sub-tables → sum each → combine, and GroupBy "does no actual computation until the
  aggregation is applied" (jakevdp.github.io/PythonDataScienceHandbook/03.08-aggregation-and-grouping.html).
  pandas docs split apply into aggregation / transformation / filtration (different shapes).
- Pandas Tutor: grouping column boxed, one colour per group, arrows from group rows to output.
- Datamations (Pu, Kross, Hofman, Goldstein, CHI '21: xiaoyingpu.github.io/files/pu2021datamation.pdf):
  dots coloured by group move into groups, then collapse to the summary; one operation at a
  time, all groups move together, slow-in/slow-out. RCTs (>1,200 people): plot version raised
  "reversal possible" 47%→61% and correct explanation 47%→68%; table version weaker.
- Data 8 (inferentialthinking.com/chapters/08/2/classifying-by-one-variable): does one category
  by hand, then "This is what `group` is doing for each distinct value."

Recommendation: rows sort into coloured group cards; each card collapses to one value with the
arithmetic ("mean(7, 9) = 8"); cards line up as the output (key → index in pandas). transform:
values broadcast back to rows; filter/HAVING: whole cards struck. Phone: vertical cards.

## Pivot / reshape

- R4DS 2e (r4ds.hadley.nz/data-tidy.html) pivot_longer: variable columns "repeated, once for
  each column that is pivoted"; names become values; values "unwound row-by-row".
  pivot_wider (tidyr.tidyverse.org/articles/pivot.html): distinct names → new columns, empty frame
  filled, missing combinations NA, duplicates warn.
- tidyexplain colours header tiles and carries the colour to key and value cells.
- Pandas Tutor: reshaping is hard because "data suddenly moves around in non-intuitive ways".
- Data 8: pivot as a contingency table, "places grouped values into adjacent columns".
- Data Tweening (VLDB '17): interpolate through intermediate states.

Recommendation: colour each source column; pivot = empty grid (row keys × distinct column
values) → drop each value into its cell → mark NAs; pivot_table = group cards on (row, col) →
aggregate → spread; show duplicate collisions in red (why `pivot` raises).

## Filter / WHERE

Pandas Tutor boxes the condition's columns and links kept rows. Recommendation: the True/False
column is right; show the comparison inline ("7 > 5 ✓"), one column per clause for `&`/`|`
plus the combined column, a "kept 4 of 9" counter, and NULL/UNKNOWN as a third state in SQL.

## Adding columns

Datamations highlights the new variable; VanderPlas draws broadcast values as light boxes.
pandas aligns by label (union of indexes, NaN for missing) — a hidden join. polars: separate
expressions in one context are "embarrassingly parallel" and cannot see each other.
Recommendation: formula header over the new column, the scalar as faint repeated cells, then
all rows at once.

## Sort, select

Pandas Tutor: arrows from input rows to new positions, sort column boxed. Recommendation: rows
move to their new places; with several keys, show the bands where the first key ties. Select:
kept columns highlighted, dropped ones faded.

## SQL logical order

Microsoft's documented order: FROM → ON → JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT
→ ORDER BY → TOP; aliases "can't be referenced by preceding clauses"
(learn.microsoft.com/en-us/sql/t-sql/queries/select-transact-sql). Ben-Gan: each phase yields a
virtual table. Julia Evans: engines "don't actually literally run queries in this order"
(jvns.ca/blog/2019/10/03/sql-queries-don-t-start-with-select/). DuckDB: "Logically, the FROM
clause is where the query starts execution". Recommendation: a clause rail in logical order with
numbered badges mapped to the source; SELECT aliases greyed until SELECT; contrast WHERE (rows,
before grouping) with HAVING (groups, after).

## Lazy plans

polars docs: read plans bottom-up, compare `explain(optimized=False)` with the optimized plan,
filter pushed into the scan (docs.pola.rs/user-guide/lazy/query-plan/); projection, slice
pushdown, CSE. Recommendation: "as written" vs "as polars runs it"; data only at `collect()`.

## Research tools

QueryVis (logic diagrams, ~20% faster than SQL, no data: arxiv.org/abs/2004.11375); Somnus
(transformation glyphs, more accurate and faster than text:
content.ieeevis.org/year/2022/paper_v-tvcg-9693232.html); Unravel (per-step shape and
"internal" change summaries: github.com/nischalshrestha/Unravel); SQLVis. Data School and
Corey Schafer videos are screencasts; no distinctive visuals.

## Phone

Stack vertically, use per-key / per-group cards and one-line count summaries ("3 matched ·
1 left-only"), at most ~10 colours always paired with labels, playback under the user's control.
