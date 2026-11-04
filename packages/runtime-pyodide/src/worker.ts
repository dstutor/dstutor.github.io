// The Python side of the runtime, in a Web Worker so the 45 MB load and every cell run stay off
// the page's main thread. Driven over Comlink by createRuntime() in ./index.ts; Stop terminates
// this worker outright, which is the only way to interrupt a runaway cell without
// cross-origin isolation (GitHub Pages cannot send the headers SharedArrayBuffer needs).
import * as Comlink from 'comlink';
import { loadPyodide, type PyodideInterface } from 'pyodide';
import type { RunOutput, TraceRecord } from '@dstutor/trace-schema';
import RUNNER from './runner.py?raw';
import { PYODIDE_VERSION } from './version';
import type { RunOptions, RuntimeConfig } from './index';

let pyodide: PyodideInterface | null = null;

// Every run re-reads the whole cumulative trace, so stamps from earlier cells are kept here
// (by step_id) and re-applied; cleared whenever the trace is reset.
const stepStamps = new Map<number, { cell: string; assigns?: string }>();

/** Load the source as a module of its own, compiled under `filename` (hidden from tracebacks) */
async function loadModule(py: PyodideInterface, name: string, filename: string, source: string): Promise<void> {
  py.globals.set('__module_source', source);
  await py.runPythonAsync(`
import sys as __sys, types as __types
__mod = __types.ModuleType('${name}')
exec(compile(__module_source, '${filename}', 'exec'), __mod.__dict__)
__sys.modules['${name}'] = __mod
del __module_source
`);
}

async function init(config: RuntimeConfig): Promise<void> {
  if (pyodide) return;
  const py = await loadPyodide({ indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` });

  // Packages are pre-resolved: the Pyodide-built ones come from Pyodide's own lockfile, and the
  // pure-Python ones are pinned exactly and installed without dependency resolution.
  await py.loadPackage(['micropip', ...config.pyodidePackages]);
  py.globals.set('__requirements', py.toPy(config.pypiPackages));
  await py.runPythonAsync(`
import micropip
await micropip.install(list(__requirements), deps=False)
del __requirements
`);

  for (const [name, source] of Object.entries(config.modules ?? {})) {
    await loadModule(py, name, '<tracer>', source);
  }
  await loadModule(py, 'dstutor_tracer', '<tracer>', config.tracer);
  await loadModule(py, 'dstutor_runner', '<runner>', RUNNER);
  await py.runPythonAsync(`
import dstutor_tracer as __tracer, dstutor_runner as __runner
del __mod
__tracer.install()
`);
  if (config.setup) await py.runPythonAsync(config.setup);
  // Snapshot of the namespace after setup, so a kernel restart can forget everything cells defined
  await py.runPythonAsync(`
__baseline_globals = dict(globals())
__baseline_globals['__baseline_globals'] = __baseline_globals
`);
  pyodide = py;
}

/**
 * Mark the records a cell run produced with the cell id, and name the variable each assignment
 * statement ends up in on that statement's last step (a chained expression like
 * `r = t.where(...).select(...)` is several steps but one assignment).
 */
function stampCellSteps(trace: TraceRecord[], from: number, cellId: string): void {
  const lastOfStatement = new Map<number, TraceRecord>();
  for (let i = from; i < trace.length; i++) {
    const rec = trace[i];
    stepStamps.set(rec.step_id, { cell: cellId });
    if (rec.site) lastOfStatement.set(rec.site.stmt_start, rec);
  }
  for (const rec of lastOfStatement.values()) {
    if (rec.site?.target) stepStamps.set(rec.step_id, { cell: cellId, assigns: rec.site.target });
  }
  for (const rec of trace) {
    const stamp = stepStamps.get(rec.step_id);
    if (stamp) {
      rec.cell = stamp.cell;
      if (stamp.assigns) rec.assigns = stamp.assigns;
    }
  }
}

function ready(): PyodideInterface {
  if (!pyodide) throw new Error('The Python runtime is not loaded yet');
  return pyodide;
}

async function runCell(code: string, options: RunOptions = {}): Promise<RunOutput> {
  const { enableTracing = true, resetTrace = true, cellId } = options;
  const py = ready();
  const output: RunOutput = { stdout: '', stderr: '' };

  try {
    if (enableTracing) {
      try {
        if (resetTrace) stepStamps.clear();
        await py.runPythonAsync(`${resetTrace ? '__tracer.reset()\n' : ''}__tracer.install()`);
      } catch (e) {
        console.error('Failed to enable tracing:', e);
      }
    }

    // Records added by this run start at this index; they get stamped with the cell id below
    const traceStart = enableTracing ? Number(await py.runPythonAsync('len(__tracer.get_trace())')) : 0;

    py.globals.set('__user_code', code);
    const runJson: string = await py.runPythonAsync(`
import json as __json
__json.dumps(__runner.run_cell(__user_code, __tracer, globals()))
`);
    const run = JSON.parse(runJson) as {
      stdout: string;
      stderr: string;
      error: string | null;
      result: string | null;
      images: Array<{ png: string; width: number }>;
    };
    output.stdout = run.stdout;
    output.stderr = run.stderr;
    if (run.result !== null) output.result = run.result;
    if (run.images.length > 0) output.images = run.images;
    if (run.error) output.error = run.error;

    // The trace includes operations that ran before an error
    if (enableTracing) {
      try {
        const traceJson: string = await py.runPythonAsync(
          '__json.dumps({"trace": __tracer.get_trace(), "truncated": __tracer.is_trace_truncated()})',
        );
        const parsed = JSON.parse(traceJson) as { trace: TraceRecord[]; truncated: boolean };
        output.trace = parsed.trace;
        if (parsed.truncated) output.traceTruncated = true;
        if (cellId) stampCellSteps(output.trace, traceStart, cellId);
      } catch (e) {
        console.error('Failed to get trace:', e);
        output.trace = [];
      }
    }
  } catch (error) {
    console.error('Python execution error:', error);
    const message = error instanceof Error ? error.message : String(error);
    output.error = message || 'The code could not be run. See the browser console for details.';
  }

  return output;
}

async function restart(): Promise<void> {
  const py = ready();
  stepStamps.clear();
  await py.runPythonAsync(`
for __k in list(globals()):
    if __k not in __baseline_globals:
        del globals()[__k]
globals().update(__baseline_globals)
__tracer.reset()
__runner.close_figures()
`);
}

const api = { init, runCell, restart };
export type WorkerApi = typeof api;

Comlink.expose(api);
