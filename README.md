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
`.ipynb`, and a share link carries the notebook in the URL. Predict mode hides each result
until you guess its size, and Present mode fills the screen for lecture.

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

The tracer tests run under CPython without Pyodide. Point them at a specific interpreter
with `PYTHON=/path/to/python npm run check`.

## How it's organized

```
packages/
  trace-schema/      JSON Schema and TS types for TraceRecord, SubStep and TableState
  viz/               StepSlideshow, DataTransformation, PDF and PNG exports
  notebook-ui/       cells, Monaco editor, .ipynb open/save, share links
  runtime-pyodide/   Pyodide in a Web Worker, with packages pre-resolved
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
returns a list of `TraceRecord`s, and `reset()`. The visualization reads only the trace
schema and knows nothing about Python or any library, so a new library needs a tracer and a
thin app, with no changes to the visualization.

Every tutor shares one pinned Pyodide version, so the service worker downloads the runtime
once for the whole site.

## Deploy

GitHub Actions ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs
`npm run check` and `npm run build` on every push and pull request to `main`, and deploys
`site/` to GitHub Pages from `main`.

## Credits

Inspired by [Python Tutor](https://pythontutor.com/) and [Pandas Tutor](https://pandastutor.com/).
Successor to the [Data 8 Table Tutor](https://data-8.github.io/table-function-visualizer/).

BSD 3-Clause License. See [LICENSE](LICENSE).
