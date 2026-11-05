# Data Science Tutor

Step-by-step visualizations of how data science code transforms data. You write code in
notebook cells, run them, and step through each operation as before-and-after tables.
Python runs in the browser through Pyodide, so there is no server.

**Live:** https://dstutor.org/

| Tutor | Library | URL |
|---|---|---|
| datascience | UC Berkeley's intro data science library (`Table`) | [/datascience/](https://dstutor.org/datascience/) |
| pandas | pandas DataFrames | [/pandas/](https://dstutor.org/pandas/) |
| polars | polars DataFrames and lazy queries | [/polars/](https://dstutor.org/polars/) |
| SQL | SQL queries, one clause at a time | [/sql/](https://dstutor.org/sql/) |

Unlike [Pandas Tutor](https://pandastutor.com/), which shows one snippet, each tutor is a
whole notebook. Cells share state as they do in Jupyter. Notebooks open and save as
`.ipynb`, and a share link carries the notebook in the URL. Present mode fills the screen
for lecture.

## View the site locally

You need Node 24.21.0 (see `.nvmrc`). The tracer tests also need Python 3.14,
the version Pyodide 314.0.7 runs.

```bash
npm install
npm run dev
```

`dev` serves the whole site at http://localhost:5173 with hot reload, laid out as it is
deployed: the hub at `/` and each tutor at `/<lib>/` (`/datascience/`, `/pandas/`, `/polars/`,
`/sql/`). Each app
runs its own Vite dev server behind that one address ([scripts/dev.mjs](scripts/dev.mjs)).

To see the production build instead, `npm run preview` builds every app, assembles them the
way GitHub Pages serves them, and serves the result at http://localhost:4173.

The hub's feature cards play short clips of the tutor, recorded from the real site by
[scripts/record-demos.mjs](scripts/record-demos.mjs). After a change to the tutor's look, record
them again with `npm run record:demos` (needs Chrome and `ffmpeg`).

## Check and build

```bash
npm run check      # lint, type-check every workspace, run unit tests and the tracer tests
npm run build      # build every app and assemble the site into site/
npm run test:e2e   # the built site in Chrome (after build)
```

The tracer tests run under CPython without Pyodide, and need the tracers' packages installed
first, pinned to the versions the apps load in Pyodide:

```bash
pip install $(printf -- '-r %s ' tracers/*/requirements-test.txt)
```

Point them at a specific interpreter with `PYTHON=/path/to/python npm run check`. Each
tracer's `contract_test.py` runs its gallery and a set of edge cases and holds every record to
the trace contract.

`npm run test:e2e` ([scripts/e2e.mjs](scripts/e2e.mjs)) opens the built site in Chrome. In each
tutor it loads Pyodide, opens every gallery example from the Examples gallery and runs it, and
checks there is no error, that Cel is beside the tables, and that the step count is what the
same example gives under CPython. Then it checks that Stop interrupts a cell that never ends, and
that the hub's library toggle and Tutors menu work. `E2E_ONLY=polars` limits it to one tutor.
CI runs it after the build.

`tracers/datascience/snapshot_test.py` runs every gallery example through the tracer and
checks the trace against `tracers/datascience/snapshots/`, which were generated from the old
app's tracer. With a checkout of the old app, compare against it directly, or regenerate the
snapshots after a deliberate tracer change:

```bash
cd tracers/datascience
OLD_TRACER=/path/to/table-function-visualizer/apps/web/src/lib/tracer.py python -m unittest snapshot_test
python snapshot_test.py --update /path/to/tracer.py
```

## How it's organized

```
packages/
  brand/             Cel, the bracket mascot, in each of its states
  trace-schema/      JSON Schema and TS types for TraceRecord, SubStep and TableState
  viz/               StepSlideshow, DataTransformation, Cel beside the tables, PDF and PNG
                     exports; standalone.css for pages without the tutor's CSS
  notebook-ui/       TutorApp (the shell every tutor renders), cells, Monaco editor,
                     examples gallery, .ipynb open/save, share links
  runtime-pyodide/   Pyodide in a Web Worker, the notebook cell runner, the service worker
tracers/
  datascience/       method patching on Table
  pandas/            AST rewriting: each cell is rewritten so its DataFrame steps are recorded
  polars/            the same rewriting, for DataFrames, GroupBys and LazyFrames
  sql/               SQL cells on DuckDB, each query rebuilt clause by clause from DuckDB's parse
  shared/            what the pandas, polars and SQL tracers share: the rewriting, the step
                     log and the formatting (loaded by the runtime as dstutor_rewriting)
apps/
  hub/               this landing page; loads no runtime
  datascience/       one thin app per library: a TutorConfig with its runtime, tracer,
                     examples, completions and wording
  pandas/, polars/,  the same for pandas, polars and SQL
  sql/
scripts/
  dev.mjs            the whole site in development, one dev server per app behind one address
  assemble.mjs       puts every app's build into one site/ for GitHub Pages
  e2e.mjs            the built site in Chrome (npm run test:e2e)
  test-tracers.mjs   every tracer's Python tests (npm run test:tracers)
docs/
  visualizing-steps.md   how steps show columnar, large, lazy and SQL data, and where Cel stands
```

Each tracer is Python and exposes the same three functions: `install()`, `run(code)`, which
returns a list of `TraceRecord`s, and `reset()`. The notebook runner in `runtime-pyodide`
loads the tracer as a module of its own and also reads `get_trace()`, `is_trace_truncated()`
and `set_cell_statements()`, so steps can point back at the line and variable they came from.
A tracer that rewrites code also defines `transform(tree)`, which gets each cell's parsed AST
before it runs. A tracer for another language defines `source_to_python(code)`, which turns a
cell into the Python that runs it, and `format_error(error)`, which gives the library's own
error message. Modules a tracer imports (such as `dstutor_rewriting`) are passed to
`createRuntime()` as `modules` and loaded before it.
The runner itself is Python too ([runner.py](packages/runtime-pyodide/src/runner.py)), so the
tracer tests run cells exactly the way the app does.
Every record a tracer emits is held to the trace contract: the JSON Schema generated from the
types, plus the rules the visualization relies on. See
[packages/trace-schema/README.md](packages/trace-schema/README.md).
The visualization reads only the trace schema and knows nothing about Python or any library,
so a new library needs a tracer and a thin app (packages, tracer and setup code passed to
`createRuntime()`, and a `TutorConfig` passed to `TutorApp`), with no changes to the
visualization or the notebook. Tutors share one origin, so each saves its notebook under its
own `localStorage` key (`datascience:notebook`, `pandas:notebook`, `polars:notebook`,
`sql:notebook`).

Each tutor takes `?example=<id>` to open a gallery example, and `?embed=1` for a read-only
notebook without the header, for iframes in a textbook or course site. The examples live in
each app's `src/data/examples.json`, such as
[apps/pandas/src/data/examples.json](apps/pandas/src/data/examples.json).

### The pandas tutor

pandas has many ways to reach the same result, so its tracer does not patch methods. It
rewrites each cell before it runs: method calls, `df[...]` and `df[col] = ...` go through
small helpers that do exactly what the original code did and record a step when the object is
a DataFrame. It traces filtering (`df[mask]`, `df.loc[mask]`, `df.query`), `sort_values`,
`groupby` followed by an aggregation, `merge`, `assign` and `df[col] = ...`, and
`pivot_table`. Tables show their index as the first column, so you can see which labels a
filter keeps and where a sort moves each row. A filter is titled "keep rows where True", and
its first frame shows the condition as a column of True and False.

### The polars tutor

The polars tracer rewrites cells the same way, with the same shared code. It traces `filter`,
`with_columns`, `select`, `sort`, `group_by` with `agg` or a shortcut such as `len()`, `join`
and `pivot`, and shows each expression as written (`pl.col('Price') > 4`). polars has no index,
so rows are shown in order. A LazyFrame only records a plan, so nothing is shown until
`collect()`. Then the tracer runs the chain one step at a time, shows the table after each
step, and ends with a `collect()` step that shows polars' optimized plan.

### The SQL tutor

Cells are SQL, run on DuckDB, and each query is shown clause by clause in the order SQL runs
them: FROM (and JOIN), WHERE, GROUP BY, HAVING, SELECT, DISTINCT, ORDER BY, LIMIT. The tracer
reads DuckDB's own parse of the query (`json_serialize_sql`). For each step it rebuilds the
query with only the clauses so far, turns it back into SQL (`json_deserialize_sql`) and runs it.
Each step is labelled with its clause as written, and the notebook marks that clause while you
are on its step. Errors are DuckDB's own messages, with the line and a caret.

How each tutor turns columnar, large and lazy data into frames, and where Cel stands in each
frame, is in [docs/visualizing-steps.md](docs/visualizing-steps.md).

Python runs in a Web Worker, so the page stays responsive while the runtime loads and while
cells run, and Stop can interrupt any cell (even `while True`) by replacing the worker.
Packages are pre-resolved: the Pyodide-built ones load from Pyodide's lockfile, and the
pure-Python rest are pinned exactly and installed with micropip `deps=False`. Every tutor
shares one pinned Pyodide version, so the service worker downloads the runtime once for the
whole site.

## Deploy

GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs
`npm run check`, `npm run build` and `npm run test:e2e` on every push and pull request to
`main`, and deploys `site/` to GitHub Pages from `main`.

## Credits

Built by [Edwin Vargas Navarro](https://www.linkedin.com/in/edwin-vargas-navarro-423014237/).

Inspired by [Python Tutor](https://pythontutor.com/) and [Pandas Tutor](https://pandastutor.com/).
Successor to the [Data 8 Table Tutor](https://data-8.github.io/table-function-visualizer/).

BSD 3-Clause License. See [LICENSE](LICENSE).
