// The pandas tutor's runtime: the shared Pyodide worker with pandas, and the tracer that
// rewrites each cell so its DataFrame operations are recorded.
import { createRuntime } from '@dstutor/runtime-pyodide';
import tracer from '../../../tracers/pandas/tracer.py?raw';
import setup from '../../../tracers/pandas/notebook_setup.py?raw';

export const runtime = createRuntime({
  // All built by Pyodide; loadPackage pulls in their dependencies from its lockfile.
  // matplotlib is there for df.plot().
  pyodidePackages: ['numpy', 'pandas', 'matplotlib'],
  pypiPackages: [],
  tracer,
  setup,
});
