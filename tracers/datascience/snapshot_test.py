"""Every gallery example must produce the same trace as the old app (table-function-visualizer).

    python snapshot_test.py --update OLD_TRACER   regenerate snapshots/ from the old app's tracer
    python -m unittest snapshot_test              compare this tracer with snapshots/ (and with
                                                  the old tracer too, when OLD_TRACER is set)

Each example runs like a Run-all in the app: the cells in order in one namespace, through the
same runner the worker uses (packages/runtime-pyodide/src/runner.py) after the same setup
(notebook_setup.py). Each tracer patches Table's methods, so every run gets its own subprocess.
"""
import json
import os
import subprocess
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
EXAMPLES = os.path.join(ROOT, 'apps', 'datascience', 'src', 'data', 'examples.json')
RUNNER = os.path.join(ROOT, 'packages', 'runtime-pyodide', 'src', 'runner.py')
SETUP = os.path.join(HERE, 'notebook_setup.py')
TRACER = os.path.join(HERE, 'tracer.py')
SNAPSHOTS = os.path.join(HERE, 'snapshots')
OLD_TRACER = os.environ.get('OLD_TRACER')


def _module(name, path, filename):
    mod = types.ModuleType(name)
    with open(path, encoding='utf-8') as f:
        exec(compile(f.read(), filename, 'exec'), mod.__dict__)
    sys.modules[name] = mod
    return mod


def emit(tracer_path):
    """Run every example with the tracer at tracer_path; print {id: {trace, error}} as JSON."""
    import matplotlib
    matplotlib.use('agg')
    tracer = _module('dstutor_tracer', tracer_path, '<tracer>')
    runner = _module('dstutor_runner', RUNNER, '<runner>')
    # The old tracer predates the install/reset interface
    install = getattr(tracer, 'install', None) or tracer.enable
    reset = getattr(tracer, 'reset', None) or tracer.clear_trace
    with open(EXAMPLES, encoding='utf-8') as f:
        examples = json.load(f)['examples']
    install()
    out = {}
    for example in examples:
        namespace = {'__name__': '__main__'}
        with open(SETUP, encoding='utf-8') as f:
            exec(compile(f.read(), '<exec>', 'exec'), namespace)
        reset()
        error = None
        for cell in example['cells']:
            if not cell.strip():
                continue
            install()
            result = runner.run_cell(cell, tracer, namespace)
            if result['error']:
                error = result['error'].strip().splitlines()[-1]
                break
        out[example['id']] = {'trace': tracer.get_trace(), 'error': error}
    print(json.dumps(out, sort_keys=True))


def run(tracer_path):
    proc = subprocess.run(
        [sys.executable, os.path.abspath(__file__), '--emit', tracer_path],
        capture_output=True, text=True, encoding='utf-8', cwd=HERE,
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
    )
    if proc.returncode != 0:
        raise RuntimeError(f'running examples with {tracer_path} failed:\n{proc.stderr}')
    # The last line is the JSON; anything before it is the tracer's own prints
    return json.loads(proc.stdout.strip().splitlines()[-1])


def snapshot_path(example_id):
    return os.path.join(SNAPSHOTS, f'{example_id}.json')


def update(old_tracer):
    os.makedirs(SNAPSHOTS, exist_ok=True)
    for example_id, result in run(old_tracer).items():
        with open(snapshot_path(example_id), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(result, f, indent=1, sort_keys=True)
            f.write('\n')
        print(f'wrote snapshots/{example_id}.json ({len(result["trace"])} steps)')


class SnapshotTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.current = run(TRACER)

    def test_every_example_has_a_snapshot(self):
        with open(EXAMPLES, encoding='utf-8') as f:
            ids = [e['id'] for e in json.load(f)['examples']]
        missing = [i for i in ids if not os.path.exists(snapshot_path(i))]
        self.assertEqual(missing, [], 'run: python snapshot_test.py --update OLD_TRACER')

    def test_traces_match_the_old_app(self):
        for example_id, result in self.current.items():
            with self.subTest(example=example_id):
                with open(snapshot_path(example_id), encoding='utf-8') as f:
                    expected = json.load(f)
                self.assertIsNone(result['error'], f'{example_id} raised {result["error"]}')
                self.assertEqual(result, expected)

    @unittest.skipUnless(OLD_TRACER, 'set OLD_TRACER to the old app tracer.py to compare directly')
    def test_traces_match_the_old_tracer_run_now(self):
        old = run(OLD_TRACER)
        for example_id, result in self.current.items():
            with self.subTest(example=example_id):
                self.assertEqual(result, old[example_id])


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--emit':
        emit(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == '--update':
        update(sys.argv[2])
    else:
        unittest.main()
