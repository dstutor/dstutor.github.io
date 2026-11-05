"""Every record this tracer emits must hold to the trace contract (packages/trace-schema).

Runs every gallery example (apps/polars/src/data/examples.json), plus notebooks that reach what the
gallery does not (empty results, null, NaN and dates, tables longer than the preview, every join,
lazy chains, an error part way through a cell), the way the app does: cells in order in one
namespace, through the shared runner, after notebook_setup.py.

    python -m unittest contract_test
    python contract_test.py --emit 'example filter-rows' ...   (traces as JSON, for scripts/e2e.mjs)
"""
import json
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'packages', 'trace-schema'))
sys.path.insert(0, os.path.join(ROOT, 'tracers', 'shared'))
from check_trace import trace_problems  # noqa: E402

EXAMPLES = os.path.join(ROOT, 'apps', 'polars', 'src', 'data', 'examples.json')
RUNNER = os.path.join(ROOT, 'packages', 'runtime-pyodide', 'src', 'runner.py')
SETUP = os.path.join(HERE, 'notebook_setup.py')

CONES = """cones = pl.DataFrame({
    'Flavor': ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
    'Color': ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
    'Price': [3.55, 4.75, 4.25, 5.25, 3.95, 4.50],
})"""
STOCK = "stock = pl.DataFrame({'Flavor': ['chocolate', 'mint', 'rocky road'], 'Tubs': [3, 1, 2]})"

# name -> (cells, whether the last cell is expected to raise)
EDGE_NOTEBOOKS = {
    'empty-results': ([
        CONES,
        "cones.filter(pl.col('Price') > 100)",
        "cones.filter(pl.col('Price') > 100).group_by('Flavor').len()",
        "cones.filter(pl.col('Price') > 100).sort('Price')",
        "pl.DataFrame({'a': []}, schema={'a': pl.Int64}).filter(pl.col('a') > 1)",
    ], False),
    'null-nan-and-types': ([
        "import datetime as dt",
        "t = pl.DataFrame({'x': [1.0, None, float('nan'), float('inf')], 'when': [dt.date(2026, 1, 1), None, dt.date(2026, 2, 1), dt.date(2026, 3, 1)],"
        " 'ok': [True, False, None, True], 'tags': [['a'], [], None, ['b', 'c']]})",
        "t.filter(pl.col('x') > 0)",
        "t.sort('when')",
        "t.group_by('ok', maintain_order=True).agg(pl.col('x').mean())",
        "t.with_columns((pl.col('x') * 2).alias('y'))",
        "t.select(pl.col('tags').list.len())",
    ], False),
    'longer-than-preview': ([
        "big = pl.DataFrame({'n': range(200), 'm': [i % 7 for i in range(200)]})",
        "big.filter(pl.col('m') == 3)",
        "big.sort('n', descending=True)",
        "big.group_by('m', maintain_order=True).agg(pl.col('n').sum())",
        "big.with_columns(pl.col('n') * 2, half=pl.col('n') / 2, third=pl.col('n') / 3, fourth=pl.col('n') / 4, fifth=pl.col('n') / 5, sixth=pl.col('n') / 6)",
        "big.pivot(on='m', index='n', values='n', aggregate_function='sum')",
    ], False),
    'grouping-shapes': ([
        CONES,
        "cones.group_by('Flavor', 'Color', maintain_order=True).agg(pl.col('Price').mean())",
        "cones.group_by('Flavor').agg(pl.col('Price').min().alias('lo'), pl.col('Price').max().alias('hi'), pl.len())",
        "cones.group_by(pl.col('Flavor'), maintain_order=True).first()",
        "cones.group_by(kind=pl.col('Flavor').str.len_chars()).len()",
        "cones.group_by('Flavor', maintain_order=True).agg(pl.col('Price').sort().first(), pl.col('Color'))",
    ], False),
    'every-join': ([
        CONES,
        STOCK,
        "cones.join(stock, on='Flavor')",
        "cones.join(stock, on='Flavor', how='left')",
        "cones.join(stock, on='Flavor', how='right')",
        "cones.join(stock, on='Flavor', how='full')",
        "cones.join(stock, on='Flavor', how='semi')",
        "cones.join(stock, on='Flavor', how='anti')",
        "cones.join(stock, how='cross')",
        "cones.join(stock.rename({'Flavor': 'Name'}), left_on='Flavor', right_on='Name')",
        "cones.join(cones, on=['Flavor', 'Color'])",
    ], False),
    'lazy': ([
        CONES,
        STOCK,
        "cones.lazy().filter(pl.col('Price') > 4).with_columns(Sale=pl.col('Price') * 0.9).sort('Sale').collect()",
        "cones.lazy().join(stock.lazy(), on='Flavor').group_by('Flavor', maintain_order=True).agg(pl.col('Tubs').sum()).collect()",
        "pl.LazyFrame({'a': [1, 2]}).collect()",
        "q = cones.lazy()\nfor _ in range(14):\n    q = q.filter(pl.col('Price') > 0)\nq.collect()",
        "cones.lazy().select(pl.col('Price').sum()).collect()",
    ], False),
    'error-part-way': ([
        CONES,
        "kept = cones.filter(pl.col('Flavor') == 'chocolate')\nkept.select('Nope')",
    ], True),
    # Everything else on Data 100's polars reference sheet that returns a table or a Series
    'reference-sheet': ([
        CONES,
        "cones.head(3)", "cones.tail(2)", "cones.slice(1, 2)", "cones[1:3, ['Flavor', 'Price']]", "cones[0]",
        "cones[[0, 5]]", "cones[:, ['Flavor']]", "cones['Price']", "cones.get_column('Flavor')",
        "cones.drop('Color')", "cones.rename({'Price': 'Cost'})",
        "t = pl.DataFrame({'a': [1, None, 1, 4], 'b': ['x', 'y', 'x', None], 'c': [0.5, float('nan'), 0.5, None]})",
        "t.null_count()", "t.drop_nulls()", "t.drop_nulls('a')", "t.fill_null(0)", "t.fill_null(strategy='forward')",
        "t.unique(maintain_order=True)", "t.unique(subset='a', keep='last', maintain_order=True)", "t.unique(keep='none')",
        "cones.group_by('Flavor', maintain_order=True).head(1)", "cones.group_by('Flavor').tail(1)",
        "cones['Flavor'].value_counts(sort=True)", "cones['Flavor'].value_counts(normalize=True)",
        "cones['Flavor'].is_in(['mint'])", "t['b'].is_in(['x'])", "t['a'].is_null()",
        "cones['Price'].sort(descending=True)", "cones['Flavor'].unique(maintain_order=True)", "t['a'].fill_null(0)",
        "cones['Price'].cast(pl.Int64)", "cones.join(cones.select('Color').head(2), how='cross')",
        "cones.lazy().drop('Color').unique(maintain_order=True).head(3).collect()",
        "cones.lazy().group_by('Flavor', maintain_order=True).head(1).collect()",
        "big = pl.DataFrame({'n': range(100), 'm': [i % 3 for i in range(100)]})\nbig.tail(3)",
        "big[50:60]", "big.unique(subset='m', maintain_order=True)", "big['m'].value_counts(sort=True)",
    ], False),
}

TRACED_OPERATIONS = {'filter', 'with_columns', 'select', 'sort', 'group_by', 'join', 'pivot', 'collect',
                     'head', 'tail', 'slice', '[]', 'get_column', 'drop', 'rename', 'null_count', 'drop_nulls',
                     'fill_null', 'unique', 'value_counts', 'is_in', 'is_null', 'cast'}


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


def run_notebooks(names=None):
    tracer = _module('dstutor_tracer', os.path.join(HERE, 'tracer.py'), '<tracer>')
    runner = _module('dstutor_runner', RUNNER, '<runner>')
    tracer.install()
    results = {}
    for name, (cells, _) in notebooks().items():
        if names is not None and name not in names:
            continue
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

    def test_every_walkthrough_keeps_to_its_frame_budget(self):
        # docs/visualizing-steps.md: a handful of frames per operation, never one per row of a big table
        for name, result in self.results.items():
            for record in result['trace']:
                with self.subTest(notebook=name, operation=record['operation']):
                    self.assertLessEqual(len(record.get('sub_steps', [])), 13)

    def test_a_long_lazy_chain_shows_only_collect(self):
        operations = [r['operation'] for r in self.results['edge lazy']['trace']]
        # The chain of 14 filters is over the limit, so its collect() stands alone
        self.assertIn(['collect', 'collect'], [operations[i:i + 2] for i in range(len(operations) - 1)])

    def test_every_table_says_its_column_types(self):
        # polars prints a type under each column name; every table it shows does too
        for name, result in self.results.items():
            for record in result['trace']:
                with self.subTest(notebook=name, operation=record['operation']):
                    for state in [record['input'], record['output']] + [
                            s['output_state'] for s in record.get('sub_steps', []) if 'output_state' in s]:
                        self.assertIn('column_types', state)

    def test_the_checker_catches_wrong_column_types(self):
        record = json.loads(json.dumps(self.results['example filter-rows']['trace'][0]))
        record['input']['column_types'] = record['input']['column_types'][:-1]
        self.assertTrue(any('column_types for' in p for p in trace_problems([record])))

    def test_the_checker_catches_wrong_row_colors(self):
        record = json.loads(json.dumps(self.results['example join-inner']['trace'][0]))
        record['sub_steps'][0]['input_highlights']['row_colors'].append(0)
        self.assertTrue(any('row_colors for' in p for p in trace_problems([record])))

    def test_joins_and_groups_show_their_stages(self):
        joins = [[s.get('stage') for s in r.get('sub_steps', [])] for result in self.results.values()
                 for r in result['trace'] if r['operation'] == 'join']
        groups = {r.get('label'): [s.get('stage') for s in r.get('sub_steps', [])]
                  for result in self.results.values() for r in result['trace'] if r['operation'] == 'group_by'}
        self.assertIn(['Which keys match', 'How rows pair', 'Result'], joins)
        self.assertIn(['Pair every row with every row'], joins)
        self.assertEqual(groups['group_by().agg()'], ['Sort rows into groups', 'Combine each group', 'One row per group'])
        self.assertEqual(groups['group_by().head()'], ['Sort rows into groups', 'Keep the first rows of each'])

    def test_every_operation_on_the_reference_sheet_shows_a_walkthrough(self):
        for record in self.results['edge reference-sheet']['trace']:
            with self.subTest(step=record.get('label') or record['operation']):
                self.assertGreater(len(record.get('sub_steps', [])), 0)

    def test_students_never_see_the_rewriting(self):
        for name, result in self.results.items():
            with self.subTest(notebook=name):
                self.assertNotIn('_dstutor', json.dumps(result['trace']))

    def test_every_traced_operation_is_covered(self):
        seen = {r['operation'] for result in self.results.values() for r in result['trace']}
        self.assertEqual(TRACED_OPERATIONS - seen, set(), 'add a notebook that runs these')


def emit(names):
    """Print {name: {trace, error}} as JSON for the named notebooks (scripts/e2e.mjs compares the
    browser's step counts with these)."""
    print(json.dumps(run_notebooks(set(names)), allow_nan=True))


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--emit':
        emit(sys.argv[2:])
    else:
        unittest.main()
