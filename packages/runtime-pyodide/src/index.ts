// Pyodide for every tutor: one pinned Pyodide version, a notebook-style cell runner, and a tracer
// loaded as its own module, all in a Web Worker (./worker.ts) so the page stays responsive while
// Python loads and runs. Each app supplies its packages, tracer and setup through createRuntime().
import * as Comlink from 'comlink';
import type { RunOutput } from '@dstutor/trace-schema';
import type { WorkerApi } from './worker';
import { PYODIDE_VERSION } from './version';

export { PYODIDE_VERSION };

export interface RuntimeConfig {
  /**
   * Packages built for Pyodide, loaded with loadPackage. Versions come from the lockfile of the
   * pinned Pyodide release, and their dependencies are resolved from it, with no network lookup.
   */
  pyodidePackages: string[];
  /**
   * Pure-Python packages from PyPI, each pinned exactly ('name==version'), installed with
   * micropip deps=False. List every dependency they need that pyodidePackages does not cover.
   */
  pypiPackages: string[];
  /**
   * Source of the tracer module. It must define install() (start recording; called before
   * every traced run, so it must be idempotent), reset() (forget recorded steps), get_trace(),
   * is_trace_truncated() and set_cell_statements(statements). A tracer that rewrites code also
   * defines transform(tree), which gets each cell's parsed AST and returns the tree to run. A
   * tracer for another language (SQL) defines source_to_python(code), which turns a cell into
   * the Python that runs it, and may define format_error(error), which returns the message to
   * show for an error (or None for a Python traceback).
   */
  tracer: string;
  /**
   * Modules the tracer imports, by name (e.g. dstutor_rewriting, the rewriting the pandas and
   * polars tracers share), loaded before it and hidden from tracebacks like it.
   */
  modules?: Record<string, string>;
  /** Python run once in the notebook namespace after install, e.g. `from datascience import *` */
  setup?: string;
}

export interface RunOptions {
  enableTracing?: boolean;
  /** Start a fresh trace (true) or append to the trace of earlier cells in a Run-all (false) */
  resetTrace?: boolean;
  /** Notebook cell being run; stamped on the trace records it produces so steps can point back at it */
  cellId?: string;
}

export interface Runtime {
  /** Start the worker and load Python and the packages; resolves once cells can run. Safe to call repeatedly. */
  init(): Promise<void>;
  /** Run one cell in the shared namespace, like a notebook */
  runCell(code: string, options?: RunOptions): Promise<RunOutput>;
  /**
   * Restart the kernel without reloading Python: every name defined by cells is forgotten and
   * the trace is cleared, but the interpreter and installed packages stay (so it is instant).
   */
  restart(): Promise<void>;
  /**
   * Interrupt: terminate the worker, even mid-cell (a `while True` loop included). Pending calls
   * reject with an InterruptedError; the next init() starts a fresh worker, with the downloads
   * served from the service worker's cache.
   */
  stop(): void;
}

export class InterruptedError extends Error {
  constructor() {
    super('The Python runtime was stopped');
    this.name = 'InterruptedError';
  }
}

export function createRuntime(config: RuntimeConfig): Runtime {
  let worker: Worker | null = null;
  let api: Comlink.Remote<WorkerApi> | null = null;
  let loading: Promise<void> | null = null;
  /** Rejecters for calls in flight, so stop() can settle them instead of leaving them hanging */
  const pending = new Set<(error: Error) => void>();

  /** Settle `promise` normally, or reject it if stop() is called first */
  function interruptible<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.add(reject);
      promise.then(resolve, reject).finally(() => pending.delete(reject));
    });
  }

  function teardown(): void {
    worker?.terminate();
    worker = null;
    api = null;
    loading = null;
  }

  function stop(): void {
    teardown();
    const rejecters = [...pending];
    pending.clear();
    for (const reject of rejecters) reject(new InterruptedError());
  }

  function init(): Promise<void> {
    if (!loading) {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'python' });
      api = Comlink.wrap<WorkerApi>(worker);
      const started = api.init(config);
      loading = started;
      started.catch((error: unknown) => {
        console.error('Failed to load Pyodide:', error);
        // Let the next init() try again with a fresh worker; callers get the real error
        if (loading === started) teardown();
      });
    }
    return interruptible(loading);
  }

  async function runCell(code: string, options: RunOptions = {}): Promise<RunOutput> {
    await init();
    return interruptible(api!.runCell(code, options));
  }

  async function restart(): Promise<void> {
    await init();
    return interruptible(api!.restart());
  }

  return { init, runCell, restart, stop };
}

export { registerServiceWorker } from './registerServiceWorker';
