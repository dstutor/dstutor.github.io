// The datascience tutor's runtime: the shared Pyodide worker, with datascience installed and
// its method-patching tracer.
import { createRuntime } from '@dstutor/runtime-pyodide';
import tracer from '../../../tracers/datascience/tracer.py?raw';
import setup from '../../../tracers/datascience/notebook_setup.py?raw';

/** Pinned so an upstream release cannot change behaviour under us; bump deliberately */
export const DATASCIENCE_VERSION = '0.18.1';

export const runtime = createRuntime({
  // datascience's dependencies that Pyodide builds; loadPackage pulls in their own
  // dependencies (pillow, pyparsing, pytz, ...) from Pyodide's lockfile.
  // narwhals is plotly's dependency.
  pyodidePackages: ['numpy', 'pandas', 'matplotlib', 'scipy', 'ipython', 'jinja2', 'requests', 'xyzservices', 'packaging', 'setuptools', 'narwhals'],
  // The pure-Python rest, each pinned: datascience, and the dependencies Pyodide does not build
  // (folium and plotly for maps and interactive charts, and what they need).
  pypiPackages: [
    `datascience==${DATASCIENCE_VERSION}`,
    'folium==0.20.0',
    'branca==0.8.2',
    'plotly==7.1.0',
  ],
  tracer,
  setup,
});
