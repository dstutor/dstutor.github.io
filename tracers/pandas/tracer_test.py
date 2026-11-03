"""Tests for the pandas tracer, under CPython (no Pyodide).

    python -m unittest tracer_test
"""
import ast
import os
import sys
import traceback
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def load_tracer():
    """Load tracer.py the way the runtime does: as its own module, compiled as <tracer>."""
    module = types.ModuleType('dstutor_tracer')
    with open(os.path.join(HERE, 'tracer.py'), encoding='utf-8') as f:
        exec(compile(f.read(), '<tracer>', 'exec'), module.__dict__)
    sys.modules['dstutor_tracer'] = module
    return module


tracer = load_tracer()

CONES = """import pandas as pd
cones = pd.DataFrame({
    'Flavor': ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
    'Color': ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
    'Price': [3.55, 4.75, 4.25, 5.25, 3.95, 4.50],
})
"""


def trace(code):
    return tracer.run(CONES + code)


class FilterTest(unittest.TestCase):
    def test_boolean_mask_keeps_matching_rows_with_their_index(self):
        [step] = trace("chocolate = cones[cones['Flavor'] == 'chocolate']")
        self.assertEqual(step['operation'], 'filter')
        self.assertEqual(step['explanation'], 'Filtered rows. Kept 2, removed 4.')
        # The index is the first column, so the kept rows show their original labels 1 and 3
        self.assertEqual(step['output']['columns'], ['', 'Flavor', 'Color', 'Price'])
        # The index is the first column but not one of pandas' columns: cones.shape is (6, 3)
        self.assertEqual(step['input']['index_columns'], 1)
        self.assertEqual(step['input']['num_columns'] - step['input']['index_columns'], 3)
        self.assertEqual([row[0] for row in step['output']['preview']], [1, 3])
        # cones[...] calls no method, so the step is titled in plain words, not filter()
        self.assertEqual(step['label'], 'keep rows where True')
        frames = step['sub_steps']
        # First frame: the condition as a column of True and False beside the rows
        checked = frames[0]['output_state']
        self.assertEqual(checked['columns'][-1], "cones['Flavor'] == 'chocolate'")
        self.assertEqual([row[-1] for row in checked['preview']], [False, True, False, True, False, False])
        self.assertEqual(frames[1]['input_highlights']['rows'], [1, 3])
        self.assertEqual(frames[1]['input_highlights']['rows_removed'], [0, 2, 4, 5])
        self.assertEqual(frames[0]['input_highlights']['columns'], ['Flavor'])

    def test_loc_and_query_filter_too(self):
        loc, query = trace("a = cones.loc[cones['Price'] > 4, ['Flavor', 'Price']]\nb = cones.query('Price < 4')")
        self.assertEqual((loc['operation'], loc['output']['columns']), ('filter', ['', 'Flavor', 'Price']))
        self.assertEqual((query['operation'], query['output']['num_rows']), ('query', 2))
        # query is a real method, so it keeps its own name
        self.assertNotIn('label', query)

    def test_query_still_sees_the_cells_variables(self):
        # query looks @limit up in the caller's frame; the tracer's wrapper must not hide it
        [step] = trace("limit = 4.5\ncones.query('Price > @limit')")
        self.assertEqual(step['output']['num_rows'], 2)
        [step] = trace("def above(t, limit):\n    return t.query('Price > @limit')\nabove(cones, 5)")
        self.assertEqual(step['output']['num_rows'], 1)

    def test_selecting_a_column_is_not_a_step(self):
        self.assertEqual(trace("prices = cones['Price']\nfirst = cones.loc[0]"), [])


class OperationTest(unittest.TestCase):
    def test_sort_values_shows_the_new_order_of_labels(self):
        [step] = trace("cones.sort_values('Price', ascending=False)")
        self.assertEqual(step['explanation'], "Sorted 6 rows by 'Price', largest first.")
        self.assertEqual([row[0] for row in step['output']['preview']], [3, 1, 5, 2, 4, 0])

    def test_groupby_aggregation_walks_through_each_group(self):
        [step] = trace("cones.groupby('Flavor')['Price'].mean()")
        self.assertEqual(step['operation'], 'groupby')
        self.assertEqual(step['explanation'], "Grouped by 'Flavor' into 4 groups and took the mean.")
        # The input is the whole table, not just the Price column the mean was taken of
        self.assertEqual(step['input']['columns'], ['', 'Flavor', 'Color', 'Price'])
        self.assertEqual(step['output']['columns'], ['Flavor', 'Price'])
        # The group keys became the index: one data column, Price
        self.assertEqual(step['output']['index_columns'], 1)
        chocolate = next(f for f in step['sub_steps'] if f['message'].startswith("Group 'chocolate'"))
        self.assertEqual(chocolate['input_highlights']['rows'], [1, 3])

    def test_merge_shows_the_right_table(self):
        merged, function = trace("r = pd.DataFrame({'Flavor': ['chocolate', 'mint'], 'Stars': [5, 3]})\n"
                                 "cones.merge(r, on='Flavor', how='left')\npd.merge(cones, r, on='Flavor')")
        self.assertEqual(merged['explanation'], "Merged (left) on 'Flavor': 6 rows.")
        self.assertEqual(merged['sub_steps'][0]['aux_table']['state']['columns'], ['', 'Flavor', 'Stars'])
        self.assertEqual(function['output']['num_rows'], 3)

    def test_assign_and_setitem(self):
        assign, setitem = trace("sale = cones.assign(Sale=cones['Price'] * 0.9)\ncones['Price'] = cones['Price'] + 1")
        self.assertEqual(assign['explanation'], "Added column 'Sale'.")
        self.assertEqual(setitem['explanation'], "Replaced column 'Price'.")
        # setitem changes the table in place: the step's input is the table before the change
        self.assertEqual(setitem['input']['preview'][0][3], 3.55)
        self.assertEqual(setitem['output']['preview'][0][3], 4.55)

    def test_two_level_index(self):
        [step] = trace("cones.groupby(['Flavor', 'Color'])['Price'].mean()")
        self.assertEqual(step['output']['columns'][:3], ['Flavor', 'Color', 'Price'])
        self.assertEqual(step['output']['index_columns'], 2)

    def test_pivot_table(self):
        [step] = trace("cones.pivot_table(index='Flavor', columns='Color', values='Price', aggfunc='mean')")
        self.assertEqual(step['output']['columns'][0], 'Flavor')
        self.assertEqual(len(step['sub_steps']), 2)

    def test_chains_record_each_step_in_order(self):
        steps = trace("(cones[cones['Price'] > 4]\n    .sort_values('Price')\n    .groupby('Flavor')\n    .size())")
        self.assertEqual([s['operation'] for s in steps], ['filter', 'sort_values', 'groupby'])
        # Each step points at the line of its own method in the chain
        self.assertEqual([s['site']['line'] for s in steps], [7, 8, 10])

    def test_calls_inside_functions_defined_in_the_cell(self):
        steps = trace("def cheap(t):\n    return t[t['Price'] < 4]\ncheap(cones)")
        self.assertEqual([s['operation'] for s in steps], ['filter'])

    def test_nan_becomes_null(self):
        [step] = trace("r = pd.DataFrame({'Flavor': ['mint'], 'Stars': [3]})\ncones.merge(r, on='Flavor', how='left')")
        self.assertIsNone(step['output']['preview'][0][4])


class RewritingKeepsMeaningTest(unittest.TestCase):
    """The rewritten cell must compute exactly what the original does."""

    CODE = """
import numpy as np
xs = [10, 20, 30, 40]
d = {'a': 1, ('b', 2): 3}
s = 'hello'
arr = np.arange(12).reshape(3, 4)
out = [xs[1:3], xs[::-1], xs[-1], d['a'], d['b', 2], s[1:-1], arr[1:, ::2].tolist(), arr[arr > 5].tolist()]
xs[0] = 99
d['c'] = xs[0]
xs[1] += 1
del xs[-1]
out.append(f"{xs[0]} {d['c']}")
out.append([row[1] for row in [[1, 2], [3, 4]]])
class Box:
    def __init__(self):
        self.items = {'k': [1, 2]}
    def get(self):
        return self.items['k'][-1]
out.append(Box().get())
a = b = [0, 0]
a[0] = 5
out.append(b)
"""

    def run_code(self, rewrite):
        tree = ast.parse(self.CODE)
        if rewrite:
            tracer.install()
            tree = tracer.transform(tree)
        namespace = {}
        exec(compile(tree, '<cell>', 'exec'), namespace)
        return namespace['out'], namespace['xs'], namespace['d']

    def test_same_results(self):
        self.assertEqual(self.run_code(rewrite=True), self.run_code(rewrite=False))

    def test_errors_point_at_the_cell_line(self):
        tracer.install()
        tree = tracer.transform(ast.parse(CONES + "x = 1\ncones['Nope']"))
        # Caught by hand: assertRaises drops the traceback this test is about
        try:
            exec(compile(tree, '<cell>', 'exec'), {})
            self.fail('expected a KeyError')
        except KeyError as error:
            frames = traceback.extract_tb(error.__traceback__)
        self.assertEqual([f.lineno for f in frames if f.filename == '<cell>'], [8])

    def test_helpers_stay_out_of_the_notebook_namespace(self):
        tracer.install()
        namespace = {}
        exec(compile(tracer.transform(ast.parse("y = [1, 2][0]")), '<cell>', 'exec'), namespace)
        self.assertEqual([k for k in namespace if k.startswith('_dstutor')], [])


if __name__ == '__main__':
    unittest.main()
