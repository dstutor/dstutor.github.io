"""Tests for the SQL tracer, under CPython (no Pyodide).

    python -m unittest tracer_test
"""
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# The step log and formatting the tracers share; the runtime loads it as its own module
sys.path.insert(0, os.path.join(HERE, '..', 'shared'))


def load_tracer():
    """Load tracer.py the way the runtime does: as its own module, compiled as <tracer>."""
    module = types.ModuleType('dstutor_tracer')
    with open(os.path.join(HERE, 'tracer.py'), encoding='utf-8') as f:
        exec(compile(f.read(), '<tracer>', 'exec'), module.__dict__)
    sys.modules['dstutor_tracer'] = module
    return module


tracer = load_tracer()

TABLES = """CREATE TABLE cones (Flavor VARCHAR, Color VARCHAR, Price DOUBLE);
INSERT INTO cones VALUES ('strawberry', 'pink', 3.55), ('chocolate', 'light brown', 4.75), ('vanilla', 'white', 4.25),
    ('chocolate', 'dark brown', 5.25), ('strawberry', 'pink', 3.95), ('mint', 'green', 4.50);
CREATE TABLE stock (Flavor VARCHAR, Tubs INTEGER);
INSERT INTO stock VALUES ('chocolate', 3), ('mint', 1), ('rocky road', 2);"""


def trace(query):
    """The steps of query, in a notebook whose earlier cell made the tables."""
    namespace = {}
    tracer.run(TABLES, namespace)
    return tracer.run(query, namespace)


def operations(records):
    return [r['operation'] for r in records]


class OrderTest(unittest.TestCase):
    def test_clauses_run_in_logical_order_each_pointing_at_its_line(self):
        records = trace("SELECT Flavor, AVG(Price) AS avg_price\nFROM cones\nWHERE Price > 4\nGROUP BY Flavor\n"
                        "HAVING COUNT(*) >= 1\nORDER BY avg_price DESC\nLIMIT 2")
        self.assertEqual(operations(records), ['WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT'])
        self.assertEqual([r['label'] for r in records],
                         ['WHERE Price > 4', 'GROUP BY Flavor', 'HAVING COUNT(*) >= 1', 'ORDER BY avg_price DESC', 'LIMIT 2'])
        # Each step marks its own clause in the notebook
        self.assertEqual([(r['site']['stmt_start'], r['site']['stmt_end']) for r in records],
                         [(3, 3), (4, 4), (5, 5), (6, 6), (7, 7)])
        # Each step starts from the one before
        for before, after in zip(records, records[1:]):
            self.assertEqual(before['output'], after['input'])

    def test_select_comes_after_where(self):
        records = trace("SELECT Flavor, Price * 100 AS cents FROM cones WHERE Price < 4 ORDER BY cents")
        self.assertEqual(operations(records), ['WHERE', 'SELECT', 'ORDER BY'])
        self.assertEqual(records[1]['output']['columns'], ['Flavor', 'cents'])

    def test_showing_a_table_is_not_a_step(self):
        self.assertEqual(trace("SELECT * FROM cones"), [])

    def test_several_statements_in_one_cell(self):
        records = trace("SELECT * FROM cones WHERE Price > 5;\nSELECT * FROM stock ORDER BY Tubs;")
        self.assertEqual(operations(records), ['WHERE', 'ORDER BY'])
        self.assertEqual([r['site']['line'] for r in records], [1, 2])


    def test_a_clause_over_several_lines_is_marked_whole(self):
        [where] = trace("SELECT *\nFROM cones\nWHERE Price > 4\n  AND Flavor <> 'mint' -- not mint\n\nORDER BY Price")[:1]
        self.assertEqual((where['site']['stmt_start'], where['site']['line'], where['site']['stmt_end']), (3, 3, 4))


class WhereTest(unittest.TestCase):
    def test_condition_column_then_kept_rows(self):
        [where] = trace("SELECT * FROM cones WHERE Flavor = 'chocolate'")
        check, keep, plan = where['sub_steps']
        self.assertEqual([f['stage'] for f in where['sub_steps']], ['Ask every row', 'Keep the true rows', 'How DuckDB ran it'])
        self.assertIn('scans the table', check['note'])
        self.assertEqual(check['output_state']['columns'], ['Flavor', "Flavor = 'chocolate'"])
        self.assertEqual([row[1] for row in check['output_state']['preview']], [False, True, False, True, False, False])
        self.assertEqual(keep['input_highlights']['rows'], [1, 3])
        self.assertEqual(keep['input_highlights']['rows_removed'], [0, 2, 4, 5])
        self.assertEqual(where['explanation'], 'Kept 2 of 6 rows.')

    def test_tables_carry_duckdbs_type_names(self):
        [where] = trace("SELECT * FROM cones WHERE Flavor = 'chocolate'")
        self.assertEqual(where['input']['column_types'], ['varchar', 'varchar', 'double'])
        self.assertEqual(where['sub_steps'][0]['output_state']['column_types'], ['varchar', 'boolean'])
        [group] = trace("SELECT Flavor, AVG(Price) AS a, COUNT(*)::INTEGER AS n FROM cones GROUP BY Flavor")
        self.assertEqual(group['output']['column_types'], ['varchar', 'double', 'int32'])

    def test_case_does_not_matter_for_names(self):
        [where] = trace("select * from CONES where flavor = 'mint'")
        self.assertEqual(where['sub_steps'][0]['input_highlights'], {'columns': ['Flavor']})
        self.assertEqual(where['output']['num_rows'], 1)

    def test_null_is_not_true(self):
        namespace = {}
        tracer.run("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (NULL), (3);", namespace)
        [where] = tracer.run("SELECT * FROM t WHERE x > 1", namespace)
        check, keep, _ = where['sub_steps']
        self.assertEqual([row[1] for row in check['output_state']['preview']], [False, {'shown': 'NULL'}, True])
        self.assertIn('NULL is not true', keep['message'])


class GroupTest(unittest.TestCase):
    def test_sorts_rows_into_groups_then_combines_each(self):
        [group] = trace("SELECT Flavor, AVG(Price) AS avg_price FROM cones GROUP BY Flavor")
        sort_into, combine, result, plan = group['sub_steps']
        strawberry = sort_into['panel']['groups'][0]
        self.assertEqual((strawberry['key'], strawberry['rows'], strawberry['values'][0]['values']), (['strawberry'], 2, [3.55, 3.95]))
        self.assertEqual(combine['panel']['groups'][0]['values'][0]['formula'], 'AVG(3.55, 3.95) = 3.75')
        self.assertIn('running total', combine['note'])
        self.assertIn('no particular order', result['message'])
        self.assertTrue(any(s['name'].endswith('GROUP_BY') for s in plan['panel']['plans'][0]['steps']))

    def test_count_star_shows_the_count(self):
        [group] = trace("SELECT Flavor, COUNT(*) AS n FROM cones GROUP BY Flavor")
        self.assertEqual(group['sub_steps'][1]['panel']['groups'][0]['values'][0]['formula'], 'COUNT(*) = 2')

    def test_having_filters_groups(self):
        records = trace("SELECT Flavor, COUNT(*) AS n FROM cones GROUP BY Flavor HAVING COUNT(*) > 1")
        having = records[-1]
        self.assertEqual(having['operation'], 'HAVING')
        self.assertEqual(having['output']['num_rows'], 2)
        self.assertEqual(having['sub_steps'][1]['message'], 'Keep the groups where it is true: 2 kept, 2 (struck through) removed.')

    def test_aggregates_without_group_by(self):
        [select] = trace("SELECT COUNT(*) AS n, AVG(Price) AS mean FROM cones")
        self.assertEqual(select['operation'], 'SELECT')
        self.assertEqual(select['sub_steps'][1]['detail'], 'AVG(3.55, 4.75, 4.25, 5.25, 3.95, 4.5) = 4.375')


class JoinTest(unittest.TestCase):
    def test_inner_join_walks_each_key(self):
        [join] = trace("SELECT * FROM cones JOIN stock ON cones.Flavor = stock.Flavor")
        self.assertEqual(join['label'], 'FROM cones JOIN stock ON cones.Flavor = stock.Flavor')
        keys, pairs, result, plan = join['sub_steps']
        self.assertEqual((keys['panel']['left'], keys['panel']['right']), ('cones', 'stock'))
        self.assertEqual([c['value'] for c in keys['panel']['right_only']], ['rocky road'])
        chocolate = next(p for p in pairs['panel']['pairs'] if p['key']['value'] == 'chocolate')
        self.assertEqual((chocolate['left'], chocolate['right'], chocolate['rows']), (2, 1, 2))
        self.assertEqual(pairs['input_highlights']['rows_removed'], [0, 2, 4])
        self.assertEqual(pairs['aux_table']['highlights']['rows_removed'], [2])
        self.assertTrue(any('JOIN' in s['name'] for s in plan['panel']['plans'][0]['steps']))

    def test_left_join_using(self):
        [join, select] = trace("SELECT Flavor, Price, Tubs FROM cones LEFT JOIN stock USING (Flavor)")
        self.assertEqual(join['sub_steps'][0]['panel']['keeps'], ['left_only', 'both'])
        self.assertIn('NULL where a side had no match', join['sub_steps'][2]['message'])
        self.assertEqual(join['output']['num_rows'], 6)
        self.assertEqual(select['output']['columns'], ['Flavor', 'Price', 'Tubs'])


class ModifierTest(unittest.TestCase):
    def test_distinct_strikes_repeats(self):
        records = trace("SELECT DISTINCT Flavor, Color FROM cones")
        self.assertEqual(operations(records), ['SELECT', 'DISTINCT'])
        self.assertEqual(records[1]['sub_steps'][0]['input_highlights']['rows_removed'], [4])

    def test_order_by_works_out_the_new_order(self):
        [order] = trace("SELECT * FROM cones ORDER BY Price DESC")
        self.assertIn('largest first', order['sub_steps'][0]['message'])
        self.assertEqual(order['sub_steps'][1]['panel']['from'], [3, 1, 5, 2, 4, 0])

    def test_the_plan_shows_what_duckdb_really_did(self):
        records = trace("SELECT * FROM cones WHERE Price > 4 ORDER BY Price DESC LIMIT 2")
        plan = records[-1]['sub_steps'][-1]
        steps = plan['panel']['plans'][0]['steps']
        # The WHERE ran inside the scan, and ORDER BY + LIMIT became one TOP_N; no FILTER, no ORDER BY + LIMIT
        self.assertEqual(steps[0]['name'], 'SEQ_SCAN')
        self.assertIn('Filters: Price>4.0', steps[0]['detail'])
        self.assertIn('TOP_N', [s['name'] for s in steps])
        self.assertNotIn('FILTER', [s['name'] for s in steps])
        self.assertIn('TOP_N', plan['message'])

    def test_limit_keeps_the_first_rows(self):
        [order, limit] = trace("SELECT * FROM cones ORDER BY Price LIMIT 2 OFFSET 1")
        self.assertEqual(limit['label'], 'LIMIT 2 OFFSET 1')
        self.assertEqual(limit['sub_steps'][0]['input_highlights']['rows'], [1, 2])


class CellTest(unittest.TestCase):
    def test_the_cell_shows_the_last_query(self):
        namespace = {}
        tracer.install()
        result = tracer._run_sql(TABLES + "\nSELECT Flavor FROM cones LIMIT 1;", namespace)
        self.assertIn('strawberry', repr(result))
        self.assertIsNone(tracer._run_sql("CREATE TABLE empty (a INTEGER);", namespace))

    def test_errors_are_duckdbs_own_messages(self):
        namespace = {}
        tracer.run(TABLES, namespace)
        with self.assertRaises(Exception) as caught:
            tracer.run("SELECT * FROM cones WHERE Flavr = 'x'", namespace)
        message = tracer.format_error(caught.exception)
        self.assertTrue(message.startswith('Binder Error: Referenced column "Flavr" not found in FROM clause!'))
        self.assertIn('LINE 1:', message)
        self.assertIsNone(tracer.format_error(ValueError('python')))

    def test_the_gallery_setup_cell_runs_again(self):
        # Running a notebook twice (Run all, then Run all) must not fail or duplicate rows
        with open(os.path.join(HERE, '..', '..', 'apps', 'sql', 'src', 'data', 'examples.json'), encoding='utf-8') as f:
            setup = __import__('json').load(f)['examples'][0]['cells'][0]
        namespace = {}
        tracer.install()
        tracer._run_sql(setup, namespace)
        result = tracer._run_sql(setup, namespace)
        self.assertEqual(len(result.fetchall()), 6)

    def test_restart_forgets_tables(self):
        namespace = {}
        tracer.run(TABLES, namespace)
        del namespace[tracer.CONNECTION]
        with self.assertRaises(Exception):
            tracer.run("SELECT * FROM cones", namespace)

    def test_python_variables_are_not_tables(self):
        with self.assertRaises(Exception) as caught:
            trace("SELECT * FROM text")
        self.assertIn('Table with name text does not exist', str(caught.exception))

    def test_the_cell_becomes_python(self):
        self.assertEqual(tracer.source_to_python("SELECT 'it''s'"), "_dstutor_sql(\"SELECT 'it''s'\", globals())")


if __name__ == '__main__':
    unittest.main()
