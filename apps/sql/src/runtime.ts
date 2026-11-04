// The SQL tutor's runtime: the shared Pyodide worker with DuckDB, and the tracer that runs each
// SQL cell and shows every query clause by clause. The tracer uses the step log and formatting
// the pandas and polars tracers share (tracers/shared/dstutor_rewriting.py).
import { createRuntime } from '@dstutor/runtime-pyodide';
import tracer from '../../../tracers/sql/tracer.py?raw';
import rewriting from '../../../tracers/shared/dstutor_rewriting.py?raw';
import setup from '../../../tracers/sql/notebook_setup.py?raw';

export const runtime = createRuntime({
  // Built by Pyodide, with no dependencies of its own
  pyodidePackages: ['duckdb'],
  pypiPackages: [],
  tracer,
  modules: { dstutor_rewriting: rewriting },
  setup,
});
