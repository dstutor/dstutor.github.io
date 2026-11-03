"""Every record this tracer emits must hold to the trace contract (packages/trace-schema).

Runs every gallery example, plus notebooks that reach what the gallery does not (every traced
method, empty results, NaN, tables longer than the preview, list-valued cells, an error part way
through a cell), the way the app does: cells in order in one namespace, through the runner, after
notebook_setup.py. Each notebook runs in a subprocess, since the tracer patches Table.

    python -m unittest contract_test
"""
import json
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'packages', 'trace-schema'))
from check_trace import trace_problems  # noqa: E402

EXAMPLES = os.path.join(ROOT, 'apps', 'datascience', 'src', 'data', 'examples.json')

CONES = """cones = Table().with_columns(
    'Flavor', make_array('strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'),
    'Color', make_array('pink', 'light brown', 'white', 'dark brown', 'pink', 'green'),
    'Price', make_array(3.55, 4.75, 4.25, 5.25, 3.95, 4.50)
)"""

# name -> (cells, whether the last cell is expected to raise)
EDGE_NOTEBOOKS = {
    'rows-added': ([
        "t = Table().with_columns('a', make_array(1, 2), 'b', make_array('x', 'y'))",
        "t.with_row([3, 'z'])",
        "t.with_rows([[4, 'w'], [5, 'v']])",
    ], False),
    'empty-results': ([
        CONES,
        "cones.where('Price', are.above(100))",
        "cones.where('Price', are.above(100)).group('Flavor')",
        "Table().with_columns('a', make_array()).where('a', 1)",
    ], False),
    'nan-and-infinity': ([
        "import numpy as np",
        "t = Table().with_columns('x', make_array(1.0, np.nan, np.inf, -np.inf), 'y', make_array('p', 'q', 'p', 's'))",
        "t.where('x', are.above(0))",
        "t.sort('x')",
        "t.group('y', np.mean)",
        "t.with_column('z', t.column('x') * 2)",
    ], False),
    'longer-than-preview': ([
        "import numpy as np",
        "big = Table().with_columns('n', np.arange(200), 'm', np.arange(200) % 7)",
        "big.where('m', 3)",
        "big.group('m')",
        "big.sort('n', descending=True)",
        "big.take(np.arange(50))",
        "big.apply(lambda n: n * 2, 'n')",
    ], False),
    'grouping': ([
        CONES,
        "cones.group('Flavor', list)",
        "cones.group(['Flavor', 'Color'])",
        "cones.group('Flavor', sum)",
        "cones.pivot('Color', 'Flavor', values='Price', collect=sum)",
        "cones.pivot('Color', 'Flavor')",
    ], False),
    'joining-and-sorting': ([
        CONES,
        "ratings = Table().with_columns('Kind', make_array('chocolate', 'mint'), 'Stars', make_array(5, 3))",
        "cones.join('Flavor', ratings, 'Kind')",
        "cones.sort('Flavor', distinct=True)",
        "cones.sort('Price', descending=True)",
    ], False),
    'selecting-and-columns': ([
        CONES,
        "cones.select(0, 'Price')",
        "cones.drop('Color', 'Price')",
        "cones.with_columns('Price', cones.column('Price') + 1, 'Sale', cones.column('Price') * 0.9)",
        "cones.column('Flavor')",
        "cones.apply(lambda f, p: f + ' ' + str(p), 'Flavor', 'Price')",
    ], False),
    'filters': ([
        CONES,
        "cones.where('Price', are.between(4, 5))",
        "cones.where('Flavor', are.containing('berry'))",
        "cones.where(cones.column('Price') > 4)",
        "cones.where('Flavor', 'chocolate').sort('Price').select('Flavor', 'Price')",
    ], False),
    'random': ([
        CONES,
        "cones.sample(3, with_replacement=False)",
        "cones.shuffle()",
        "first, rest = cones.split(2)",
    ], False),
    'error-part-way': ([
        CONES,
        "kept = cones.where('Flavor', 'chocolate')\nkept.select('Nope')",
    ], True),
}


def notebooks():
    with open(EXAMPLES, encoding='utf-8') as f:
        examples = json.load(f)['examples']
    books = {f'example {e["id"]}': (e['cells'], False) for e in examples}
    books.update({f'edge {name}': (['from datascience import *', *cells], raises) for name, (cells, raises) in EDGE_NOTEBOOKS.items()})
    return books


def emit(names):
    """In a subprocess: run each named notebook; print {name: {trace, error}} as JSON."""
    import matplotlib
    matplotlib.use('agg')
    import snapshot_test as s
    tracer = s._module('dstutor_tracer', s.TRACER, '<tracer>')
    runner = s._module('dstutor_runner', s.RUNNER, '<runner>')
    books = notebooks()
    tracer.install()
    out = {}
    for name in names:
        cells, _ = books[name]
        namespace = {'__name__': '__main__'}
        with open(s.SETUP, encoding='utf-8') as f:
            exec(compile(f.read(), '<exec>', 'exec'), namespace)
        tracer.reset()
        error = None
        for cell in cells:
            tracer.install()
            result = runner.run_cell(cell, tracer, namespace)
            if result['error']:
                error = result['error'].strip().splitlines()[-1]
                break
        out[name] = {'trace': tracer.get_trace(), 'error': error}
    # The trace exactly as the runner sends it; NaN would not survive this
    print(json.dumps(out, allow_nan=True))


class ContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.books = notebooks()
        proc = subprocess.run(
            [sys.executable, os.path.abspath(__file__), '--emit', *cls.books],
            capture_output=True, text=True, encoding='utf-8', cwd=HERE,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
        )
        if proc.returncode != 0:
            raise RuntimeError(f'running the notebooks failed:\n{proc.stderr}')
        cls.results = json.loads(proc.stdout.strip().splitlines()[-1])

    def test_every_record_holds_to_the_contract(self):
        for name, result in self.results.items():
            with self.subTest(notebook=name):
                self.assertEqual(trace_problems(result['trace']), [])

    def test_notebooks_run_as_expected(self):
        for name, result in self.results.items():
            with self.subTest(notebook=name):
                raises = self.books[name][1]
                if raises:
                    self.assertIsNotNone(result['error'], f'{name} should raise')
                    self.assertGreater(len(result['trace']), 0, 'steps before the error are kept')
                else:
                    self.assertIsNone(result['error'], f'{name} raised {result["error"]}')

    def test_every_traced_method_is_covered(self):
        import re
        with open(os.path.join(HERE, 'tracer.py'), encoding='utf-8') as f:
            source = f.read()
        listed = re.search(r'operations = \[([^\]]*)\]', source).group(1)
        traced = set(re.findall(r'"(\w+)"', listed))
        seen = {r['operation'] for result in self.results.values() for r in result['trace']}
        self.assertEqual(traced - seen, set(), 'add a notebook that calls these')

    def test_the_checker_catches_breakage(self):
        """The contract is only worth something if a broken trace fails it."""
        # A one-record trace whose input has rows to break
        good = next([r] for result in self.results.values() for r in result['trace'] if r['input']['preview'])
        broken = json.loads(json.dumps(good))
        broken[0]['input']['preview'][0].append('one too many')
        self.assertTrue(any('preview row 0' in p for p in trace_problems(broken)))
        broken = json.loads(json.dumps(good))
        broken[0]['surprise'] = 1
        self.assertTrue(any('surprise' in p for p in trace_problems(broken)))
        broken = json.loads(json.dumps(good))
        broken[0]['input']['preview'][0][0] = float('nan')
        self.assertEqual(trace_problems(broken)[0][:15], 'not strict JSON')


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--emit':
        emit(sys.argv[2:])
    else:
        unittest.main()
