# Data Science Tutor

Step-by-step visualizations of how data science code transforms data. You write code in
notebook cells, run them, and step through each operation as before-and-after tables.
Python runs in the browser through Pyodide, so there is no server.

**Live:** https://dstutor.github.io/

| Tutor | Library | URL |
|---|---|---|
| datascience | Data 8 `Table` | [/datascience/](https://dstutor.github.io/datascience/) |
| pandas | pandas DataFrames | [/pandas/](https://dstutor.github.io/pandas/) |
| polars | polars DataFrames and lazy queries | [/polars/](https://dstutor.github.io/polars/) |
| SQL | SQL queries, one clause at a time | [/sql/](https://dstutor.github.io/sql/) |

Unlike [Pandas Tutor](https://pandastutor.com/), which shows one snippet, each tutor is a
whole notebook. Cells share state as they do in Jupyter. Notebooks open and save as
`.ipynb`, and a share link carries the notebook in the URL. Present mode fills the screen
for lecture.

## View the site locally

You need Node 24.21.0 (see `.nvmrc`). The tracer tests also need Python 3.12.

```bash
npm install
npm run preview
```

`preview` builds every app, assembles them the way GitHub Pages serves them, and opens the
site at http://localhost:4173: the hub at `/` and each tutor at `/<lib>/`.

To work on one app with hot reload:

```bash
npm run dev:hub                        # hub at http://localhost:5173/
npm run dev -w @dstutor/datascience    # tutor at http://localhost:5173/datascience/
```

## Check and build

```bash
npm run check   # type-check every workspace, run unit tests and the tracer tests
npm run build   # build every app and assemble the site into site/
```

The tracer tests run under CPython without Pyodide, and need the tracer's packages installed
first: `pip install -r tracers/datascience/requirements-test.txt` (pinned to the versions the
app loads in Pyodide). Point them at a specific interpreter with
`PYTHON=/path/to/python npm run check`.

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
  viz/               StepSlideshow, DataTransformation, PDF and PNG exports
  notebook-ui/       cells, Monaco editor, .ipynb open/save, share links
  runtime-pyodide/   Pyodide in a Web Worker, the notebook cell runner, the service worker
tracers/
  datascience/       method patching on Table
  pandas/            AST rewriting
apps/
  hub/               this landing page; loads no runtime
  datascience/       one thin app per library: picks a tracer and runtime config
scripts/
  assemble.mjs       puts every app's build into one site/ for GitHub Pages
```

Each tracer is Python and exposes the same three functions: `install()`, `run(code)`, which
returns a list of `TraceRecord`s, and `reset()`. The notebook runner in `runtime-pyodide`
loads the tracer as a module of its own and also reads `get_trace()`, `is_trace_truncated()`
and `set_cell_statements()`, so steps can point back at the line and variable they came from.
The runner itself is Python too ([runner.py](packages/runtime-pyodide/src/runner.py)), so the
tracer tests run cells exactly the way the app does.
The visualization reads only the trace schema and knows nothing about Python or any library,
so a new library needs a tracer and a thin app (packages, tracer and setup code passed to
`createRuntime()`), with no changes to the visualization.

The datascience tutor also takes `?example=<id>` to open a gallery example, and `?embed=1`
for a read-only notebook without the header, for iframes in a textbook or course site. Its
examples live in [apps/datascience/src/data/examples.json](apps/datascience/src/data/examples.json).

Python runs in a Web Worker, so the page stays responsive while the runtime loads and while
cells run, and Stop can interrupt any cell (even `while True`) by replacing the worker.
Packages are pre-resolved: the Pyodide-built ones load from Pyodide's lockfile, and the
pure-Python rest are pinned exactly and installed with micropip `deps=False`. Every tutor
shares one pinned Pyodide version, so the service worker downloads the runtime once for the
whole site.

## Deploy

GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs
`npm run check` and `npm run build` on every push and pull request to `main`, and deploys
`site/` to GitHub Pages from `main`.

## Credits

Inspired by [Python Tutor](https://pythontutor.com/) and [Pandas Tutor](https://pandastutor.com/).
Successor to the [Data 8 Table Tutor](https://data-8.github.io/table-function-visualizer/).

BSD 3-Clause License. See [LICENSE](LICENSE).
