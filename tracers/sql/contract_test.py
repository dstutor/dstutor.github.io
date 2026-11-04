"""Every record this tracer emits must hold to the trace contract (packages/trace-schema).

Runs every gallery example (apps/sql/src/data/examples.json), plus notebooks that reach what the
gallery does not (empty results, NULL, NaN, dates, decimals and lists, tables longer than the
preview, every join, queries shown without a walkthrough, an error part way through), the way the
app does: cells in order in one namespace, through the shared runner, after notebook_setup.py.

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

EXAMPLES = os.path.join(ROOT, 'apps', 'sql', 'src', 'data', 'examples.json')
RUNNER = os.path.join(ROOT, 'packages', 'runtime-pyodide', 'src', 'runner.py')
SETUP = os.path.join(HERE, 'notebook_setup.py')

TABLES = """CREATE TABLE cones (Flavor VARCHAR, Color VARCHAR, Price DOUBLE);
INSERT INTO cones VALUES ('strawberry', 'pink', 3.55), ('chocolate', 'light brown', 4.75), ('vanilla', 'white', 4.25),
    ('chocolate', 'dark brown', 5.25), ('strawberry', 'pink', 3.95), ('mint', 'green', 4.50);
CREATE TABLE stock (Flavor VARCHAR, Tubs INTEGER);
INSERT INTO stock VALUES ('chocolate', 3), ('mint', 1), ('rocky road', 2);"""

# name -> (cells, whether the last cell is expected to raise)
EDGE_NOTEBOOKS = {
    'empty-results': ([
        TABLES,
        "SELECT * FROM cones WHERE Price > 100",
        "SELECT Flavor, COUNT(*) FROM cones WHERE Price > 100 GROUP BY Flavor",
        "SELECT * FROM cones WHERE Price > 100 ORDER BY Price LIMIT 3",
        "SELECT COUNT(*) FROM cones WHERE Price > 100",
    ], False),
    'nulls-and-types': ([
        "CREATE TABLE t AS SELECT * FROM (VALUES (1.5::DECIMAL(4,2), DATE '2026-01-01', [1, 2], 'nan'::DOUBLE, TRUE),"
        " (NULL, NULL, NULL, 'inf'::DOUBLE, NULL), (2.25, DATE '2026-02-01', [], 3.0, FALSE)) v(d, day, xs, f, ok)",
        "SELECT * FROM t WHERE d > 1",
        "SELECT * FROM t ORDER BY day",
        "SELECT ok, AVG(f) AS mean FROM t GROUP BY ok",
        "SELECT d * 2 AS twice, len(xs) AS n FROM t",
        "SELECT {'a': d, 'b': day} AS s FROM t WHERE ok",
    ], False),
    'longer-than-preview': ([
        "CREATE TABLE big AS SELECT range AS n, range % 7 AS m FROM range(200)",
        "SELECT * FROM big WHERE m = 3",
        "SELECT * FROM big ORDER BY n DESC",
        "SELECT m, SUM(n) AS total FROM big GROUP BY m",
        "SELECT DISTINCT m FROM big",
        "SELECT * FROM big LIMIT 5 OFFSET 30",
    ], False),
    'every-join': ([
        TABLES,
        "SELECT * FROM cones JOIN stock ON cones.Flavor = stock.Flavor",
        "SELECT * FROM cones c LEFT JOIN stock s ON c.Flavor = s.Flavor",
        "SELECT * FROM cones c RIGHT JOIN stock s ON c.Flavor = s.Flavor",
        "SELECT * FROM cones FULL JOIN stock USING (Flavor)",
        "SELECT * FROM cones SEMI JOIN stock USING (Flavor)",
        "SELECT * FROM cones ANTI JOIN stock USING (Flavor)",
        "SELECT * FROM cones CROSS JOIN stock",
        "SELECT * FROM cones JOIN stock ON cones.Flavor = stock.Flavor AND Tubs > 1",
        "SELECT * FROM cones a JOIN cones b ON a.Price < b.Price",
        "SELECT * FROM cones JOIN stock USING (Flavor) JOIN stock s2 USING (Flavor)",
    ], False),
    'not-walked-through': ([
        TABLES,
        "WITH cheap AS (SELECT * FROM cones WHERE Price < 4) SELECT * FROM cheap",
        "SELECT Flavor FROM cones UNION SELECT Flavor FROM stock",
        "SELECT * FROM (SELECT * FROM cones WHERE Price > 4) t WHERE Flavor <> 'mint'",
        "SELECT Flavor, Price, rank() OVER (ORDER BY Price) AS r FROM cones",
        "SELECT 1 + 1 AS two",
        "SELECT Flavor, percentile_cont(0.5) WITHIN GROUP (ORDER BY Price) AS mid FROM cones GROUP BY Flavor",
        "DESCRIBE cones",
        "FROM cones WHERE Price < 4 -- FROM first\n",
    ], False),
    'error-part-way': ([
        TABLES,
        "SELECT * FROM cones WHERE Price > 5;\nSELECT * FROM cones WHERE Flavr = 'x';",
    ], True),
}

TRACED_OPERATIONS = {'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'SELECT', 'DISTINCT', 'ORDER BY', 'LIMIT'}


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
                error = result['error'].strip().splitlines()[0]
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

    def test_an_error_is_duckdbs_message(self):
        self.assertEqual(self.results['edge error-part-way']['error'],
                         'Binder Error: Referenced column "Flavr" not found in FROM clause!')

    def test_every_example_shows_steps(self):
        for name, result in self.results.items():
            if name.startswith('example'):
                with self.subTest(notebook=name):
                    self.assertGreater(len(result['trace']), 0)

    def test_every_walkthrough_keeps_to_its_frame_budget(self):
        for name, result in self.results.items():
            for record in result['trace']:
                with self.subTest(notebook=name, operation=record['operation']):
                    self.assertLessEqual(len(record.get('sub_steps', [])), 8)

    def test_every_table_says_its_column_types(self):
        # DuckDB prints a type under each column name; every table it shows does too
        for name, result in self.results.items():
            for record in result['trace']:
                with self.subTest(notebook=name, operation=record['operation']):
                    for state in [record['input'], record['output']] + [
                            s['output_state'] for s in record.get('sub_steps', []) if 'output_state' in s]:
                        self.assertIn('column_types', state)

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
