// The polars tutor's runtime: the shared Pyodide worker with polars, and the tracer that
// rewrites each cell so its DataFrame and LazyFrame operations are recorded. The tracer shares
// its rewriting with the pandas tutor's (tracers/shared/dstutor_rewriting.py).
import { createRuntime } from '@dstutor/runtime-pyodide';
import tracer from '../../../tracers/polars/tracer.py?raw';
import rewriting from '../../../tracers/shared/dstutor_rewriting.py?raw';
import setup from '../../../tracers/polars/notebook_setup.py?raw';

export const runtime = createRuntime({
  // Built by Pyodide, with no dependencies of its own
  pyodidePackages: ['polars'],
  pypiPackages: [],
  tracer,
  modules: { dstutor_rewriting: rewriting },
  setup,
});
