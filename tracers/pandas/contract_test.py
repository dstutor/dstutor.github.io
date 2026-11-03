"""Every record this tracer emits must hold to the trace contract (packages/trace-schema).

Runs every gallery example (apps/pandas/src/data/examples.json), plus notebooks that reach what the
gallery does not (empty results, NaN and dates, tables longer than the preview, two-key groups,
named and repeated index labels, in-place sorts, an error part way through a cell), the way the
app does: cells in order in one namespace, through the shared runner, after notebook_setup.py.
This tracer patches nothing, so the notebooks run in this process.

    python -m unittest contract_test
"""
import json
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'packages', 'trace-schema'))
from check_trace import trace_problems  # noqa: E402

EXAMPLES = os.path.join(ROOT, 'apps', 'pandas', 'src', 'data', 'examples.json')
RUNNER = os.path.join(ROOT, 'packages', 'runtime-pyodide', 'src', 'runner.py')
SETUP = os.path.join(HERE, 'notebook_setup.py')

CONES = """cones = pd.DataFrame({
    'Flavor': ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
    'Color': ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
    'Price': [3.55, 4.75, 4.25, 5.25, 3.95, 4.50],
})"""

# name -> (cells, whether the last cell is expected to raise)
EDGE_NOTEBOOKS = {
    'empty-results': ([
        CONES,
        "cones[cones['Price'] > 100]",
        "cones[cones['Price'] > 100].groupby('Flavor').size()",
        "pd.DataFrame({'a': []})[pd.DataFrame({'a': []})['a'] > 1]",
    ], False),
    'nan-dates-and-types': ([
        "t = pd.DataFrame({'x': [1.0, np.nan, np.inf, -np.inf], 'when': pd.to_datetime(['2026-01-01', '2026-02-01', None, '2026-03-01']),"
        " 'ok': [True, False, True, None], 'kind': pd.Categorical(['a', 'b', 'a', 'b'])})",
        "t[t['x'] > 0]",
        "t.sort_values('when')",
        "t.groupby('kind', observed=True)['x'].mean()",
        "t.assign(y=t['x'] * 2)",
    ], False),
    'longer-than-preview': ([
        "big = pd.DataFrame({'n': np.arange(200), 'm': np.arange(200) % 7})",
        "big[big['m'] == 3]",
        "big.sort_values('n', ascending=False)",
        "big.groupby('m')['n'].sum()",
        "big.loc[[i % 2 == 0 for i in range(200)], ['n']]",
    ], False),
    'grouping-shapes': ([
        CONES,
        "cones.groupby(['Flavor', 'Color'])['Price'].mean()",
        "cones.groupby('Flavor').agg({'Price': ['min', 'max']})",
        "cones.groupby('Flavor').agg(total=('Price', 'sum'))",
        "cones.groupby('Flavor')[['Price']].count()",
        "cones['Price'].groupby(cones['Flavor']).mean()",
        "cones.pivot_table(index='Flavor', values='Price', aggfunc='max')",
        "cones.pivot_table(index=['Flavor', 'Color'], values='Price')",
    ], False),
    'index-labels': ([
        CONES,
        "named = cones.set_index('Flavor')",
        "named[named['Price'] > 4]",
        "named.sort_values('Price')",
        "twice = pd.concat([cones, cones])",
        "twice[twice['Price'] > 5]",
        "clash = cones.set_index('Color', drop=False)",
        "clash[clash['Price'] < 4]",
    ], False),
    'merging-and-in-place': ([
        CONES,
        "stock = pd.DataFrame({'Name': ['chocolate', 'mint'], 'Price': [1, 2]})",
        "cones.merge(stock, left_on='Flavor', right_on='Name', how='outer')",
        "pd.merge(cones, stock, left_on='Flavor', right_on='Name')",
        "limit = 4\ncones.query('Price > @limit')",
        "cones.sort_values('Price', inplace=True)",
        "cones['Discount'] = 0.1",
    ], False),
    'error-part-way': ([
        CONES,
        "kept = cones[cones['Flavor'] == 'chocolate']\nkept['Nope']",
    ], True),
}

TRACED_OPERATIONS = {'filter', 'query', 'sort_values', 'groupby', 'merge', 'assign', 'pivot_table'}


def _module(name, path, filename):
    module = types.ModuleType(name)
    with open(path, encoding='utf-8') as f:
        exec(compile(f.read(), filename, 'exec'), module.__dict__)
    sys.modules[name] = module
    return module


def notebooks():
    with open(EXAMPLES, encoding='utf-8') as f:
        examples = json.load(f)['examples']
    books = {f'example {e["id"]}': (e['cells'], False) for e in examples}
    books.update({f'edge {name}': (cells, raises) for name, (cells, raises) in EDGE_NOTEBOOKS.items()})
    return books


def run_notebooks():
    tracer = _module('dstutor_tracer', os.path.join(HERE, 'tracer.py'), '<tracer>')
    runner = _module('dstutor_runner', RUNNER, '<runner>')
    tracer.install()
    results = {}
    for name, (cells, _) in notebooks().items():
        namespace = {'__name__': '__main__'}
        with open(SETUP, encoding='utf-8') as f:
            exec(compile(f.read(), '<exec>', 'exec'), namespace)
        tracer.reset()
        error = None
        for cell in cells:
            result = runner.run_cell(cell, tracer, namespace)
            if result['error']:
                error = result['error'].strip().splitlines()[-1]
                break
        # The trace as the runtime sends it to the browser
        results[name] = {'trace': json.loads(json.dumps(tracer.get_trace(), allow_nan=True)), 'error': error}
    return results


class ContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.books = notebooks()
        cls.results = run_notebooks()

    def test_every_record_holds_to_the_contract(self):
        for name, result in self.results.items():
            with self.subTest(notebook=name):
                self.assertEqual(trace_problems(result['trace']), [])

    def test_notebooks_run_as_expected(self):
        for name, result in self.results.items():
            with self.subTest(notebook=name):
                if self.books[name][1]:
                    self.assertIsNotNone(result['error'], f'{name} should raise')
                    self.assertGreater(len(result['trace']), 0, 'steps before the error are kept')
                else:
                    self.assertIsNone(result['error'], f'{name} raised {result["error"]}')

    def test_every_example_shows_steps(self):
        for name, result in self.results.items():
            if name.startswith('example'):
                with self.subTest(notebook=name):
                    self.assertGreater(len(result['trace']), 0)

    def test_students_never_see_the_rewriting(self):
        # The rewritten cell calls _dstutor_* helpers; none of that may reach a step's text
        for name, result in self.results.items():
            with self.subTest(notebook=name):
                self.assertNotIn('_dstutor', json.dumps(result['trace']))

    def test_every_traced_operation_is_covered(self):
        seen = {r['operation'] for result in self.results.values() for r in result['trace']}
        self.assertEqual(TRACED_OPERATIONS - seen, set(), 'add a notebook that runs these')


if __name__ == '__main__':
    unittest.main()
