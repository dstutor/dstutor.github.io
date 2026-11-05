"""Tests for the polars tracer, under CPython (no Pyodide).

    python -m unittest tracer_test
"""
import os
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
# The rewriting the pandas and polars tracers share; the runtime loads it as its own module
sys.path.insert(0, os.path.join(HERE, '..', 'shared'))


def load_tracer():
    """Load tracer.py the way the runtime does: as its own module, compiled as <tracer>."""
    module = types.ModuleType('dstutor_tracer')
    with open(os.path.join(HERE, 'tracer.py'), encoding='utf-8') as f:
        exec(compile(f.read(), '<tracer>', 'exec'), module.__dict__)
    sys.modules['dstutor_tracer'] = module
    return module


tracer = load_tracer()

CONES = """import polars as pl
cones = pl.DataFrame({
    'Flavor': ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
    'Color': ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
    'Price': [3.55, 4.75, 4.25, 5.25, 3.95, 4.50],
})
"""


def trace(code):
    return tracer.run(CONES + code)


def one(code):
    records = trace(code)
    assert len(records) == 1, [r['operation'] for r in records]
    return records[0]


class FilterTest(unittest.TestCase):
    def test_condition_column_then_kept_rows(self):
        record = one("cones.filter(pl.col('Flavor') == 'chocolate')")
        self.assertEqual(record['operation'], 'filter')
        self.assertEqual(record['explanation'], 'Filtered rows. Kept 2, removed 4.')
        check, keep = record['sub_steps']
        # The condition as a column of True and False, next to the column it tests
        self.assertEqual(check['output_state']['columns'], ['Flavor', "pl.col('Flavor') == 'chocolate'"])
        self.assertEqual([row[1] for row in check['output_state']['preview']], [False, True, False, True, False, False])
        self.assertEqual(check['input_highlights'], {'columns': ['Flavor']})
        self.assertEqual(keep['input_highlights']['rows'], [1, 3])
        self.assertEqual(keep['input_highlights']['rows_removed'], [0, 2, 4, 5])
        # polars has no index
        self.assertNotIn('index_columns', record['output'])

    def test_tables_carry_polars_type_names(self):
        record = one("cones.filter(pl.col('Flavor') == 'chocolate')")
        self.assertEqual(record['input']['column_types'], ['str', 'str', 'f64'])
        self.assertEqual(record['sub_steps'][0]['output_state']['column_types'], ['str', 'bool'])
        group = one("cones.group_by('Flavor', maintain_order=True).agg(pl.col('Price').mean())")
        self.assertEqual(group['output']['column_types'], ['str', 'f64'])
        pivot = one("cones.pivot(on='Color', index='Flavor', values='Price', aggregate_function='mean')")
        self.assertEqual(pivot['sub_steps'][1]['output_state']['column_types'][1], 'list[f64]')

    def test_several_predicates_are_anded(self):
        record = one("cones.filter(pl.col('Price') > 4, pl.col('Flavor') != 'mint')")
        check = record['sub_steps'][0]
        self.assertEqual(check['output_state']['columns'][-1], "(pl.col('Price') > 4) & (pl.col('Flavor') != 'mint')")
        self.assertEqual(record['output']['num_rows'], 3)

    def test_keyword_predicate(self):
        record = one("cones.filter(Flavor='mint')")
        self.assertEqual(record['sub_steps'][0]['output_state']['columns'][-1], "pl.col('Flavor') == 'mint'")
        self.assertEqual(record['sub_steps'][1]['input_highlights']['rows'], [5])

    def test_null_in_the_condition_removes_the_row(self):
        records = tracer.run("import polars as pl\nt = pl.DataFrame({'x': [1, None, 3]})\nt.filter(pl.col('x') > 1)")
        check, keep = records[0]['sub_steps']
        self.assertEqual([row[-1] for row in check['output_state']['preview']], [False, {'shown': 'null'}, True])
        self.assertIn('null counts as not True', keep['message'])
        self.assertEqual(keep['input_highlights']['rows_removed'], [0, 1])


class ColumnsTest(unittest.TestCase):
    def test_with_columns_shows_the_expression_without_its_alias(self):
        record = one("cones.with_columns((pl.col('Price') * 0.9).alias('Sale'))")
        first = record['sub_steps'][0]
        self.assertEqual(first['message'], "Sale = pl.col('Price') * 0.9")
        self.assertEqual(first['input_highlights'], {'columns': ['Price']})
        self.assertEqual(first['output_state']['columns'], ['Flavor', 'Color', 'Price', 'Sale'])
        self.assertEqual(record['explanation'], "Added column 'Sale'.")

    def test_with_columns_replacing_a_column(self):
        record = one("cones.with_columns(pl.col('Price').round(0))")
        self.assertEqual(record['explanation'], "Replaced column 'Price'.")
        # Before the expression runs the old values are there; after, the new ones
        self.assertEqual(record['sub_steps'][0]['output_state']['preview'][0], ['strawberry', 'pink', 4.0])

    def test_keyword_columns(self):
        record = one("cones.with_columns(Cents=pl.col('Price') * 100)")
        self.assertEqual(record['sub_steps'][0]['message'], "Cents = pl.col('Price') * 100")

    def test_select(self):
        record = one("cones.select('Flavor', (pl.col('Price') * 100).alias('Cents'))")
        first = record['sub_steps'][0]
        self.assertEqual(first['input_highlights'], {'columns': ['Flavor', 'Price']})
        self.assertEqual(first['output_highlights'], {'columns': ['Cents']})
        self.assertEqual(record['output']['columns'], ['Flavor', 'Cents'])


class SortTest(unittest.TestCase):
    def test_works_out_the_new_order_then_moves_every_row(self):
        record = one("cones.sort('Price', descending=True)")
        self.assertEqual(record['explanation'], "Sorted 6 rows by 'Price', largest first.")
        self.assertEqual([f['stage'] for f in record['sub_steps']], ['Read the sort key', 'Work out the new order', 'Move every row at once'])
        # 5.25 was row 3, 4.75 row 1, 4.50 row 5, ...
        self.assertEqual(record['sub_steps'][1]['panel']['from'], [3, 1, 5, 2, 4, 0])
        self.assertIn('nulls first', record['sub_steps'][1]['note'])

    def test_ties_are_bracketed(self):
        record = one("cones.sort('Flavor')")
        # chocolate twice, then strawberry twice
        self.assertEqual(record['sub_steps'][1]['panel']['ties'], [[0, 1], [3, 4]])

    def test_two_columns(self):
        record = one("cones.sort('Flavor', 'Price')")
        self.assertIn("Rows with the same 'Flavor' are ordered by 'Price'", record['sub_steps'][0]['message'])


class GroupByTest(unittest.TestCase):
    def test_sorts_rows_into_groups_then_combines_each(self):
        record = one("cones.group_by('Flavor', maintain_order=True).agg(pl.col('Price').mean())")
        self.assertEqual(record['operation'], 'group_by')
        self.assertEqual(record['label'], 'group_by().agg()')
        sort_into, combine, result = record['sub_steps']
        strawberry = sort_into['panel']['groups'][0]
        self.assertEqual((strawberry['key'], strawberry['rows'], strawberry['values'][0]['values']), (['strawberry'], 2, [3.55, 3.95]))
        # Rows coloured by group, in the order groups first appear
        self.assertEqual(sort_into['input_highlights']['row_colors'], [0, 1, 2, 1, 0, 3])
        self.assertEqual(combine['panel']['groups'][0]['values'][0]['formula'], 'mean(3.55, 3.95) = 3.75')
        self.assertIn('list of its rows', combine['note'])
        self.assertIn('first appears', result['message'])

    def test_without_maintain_order_says_the_order_may_change(self):
        record = one("cones.group_by('Flavor').agg(pl.col('Price').max())")
        self.assertIn('no particular order', record['sub_steps'][-1]['message'])

    def test_len_counts_without_values(self):
        record = one("cones.group_by('Flavor', maintain_order=True).len()")
        self.assertEqual(record['label'], 'group_by().len()')
        self.assertEqual(record['sub_steps'][1]['panel']['groups'][0]['values'][0]['formula'], 'len() = 2')

    def test_shortcut_on_every_other_column(self):
        record = trace("cones.select('Flavor', 'Price').group_by('Flavor', maintain_order=True).sum()")[-1]
        self.assertEqual(record['sub_steps'][1]['panel']['groups'][0]['values'][0]['formula'], 'sum(3.55, 3.95) = 7.5')


class JoinTest(unittest.TestCase):
    STOCK = "stock = pl.DataFrame({'Flavor': ['chocolate', 'mint', 'rocky road'], 'Tubs': [3, 1, 2]})\n"

    def test_inner_join_keys_then_pairs_then_result(self):
        record = one(self.STOCK + "cones.join(stock, on='Flavor')")
        keys, pairs, result = record['sub_steps']
        self.assertEqual([f['stage'] for f in record['sub_steps']], ['Which keys match', 'How rows pair', 'Result'])
        self.assertEqual(([c['value'] for c in keys['panel']['both']], keys['panel']['keeps']), (['chocolate', 'mint'], ['both']))
        self.assertEqual((keys['panel']['left'], keys['panel']['right']), ('cones', 'stock'))
        chocolate = next(p for p in pairs['panel']['pairs'] if p['key']['value'] == 'chocolate')
        self.assertEqual((chocolate['left'], chocolate['right'], chocolate['rows']), (2, 1, 2))
        self.assertEqual(pairs['input_highlights']['rows_removed'], [0, 2, 4])
        self.assertEqual(pairs['aux_table']['highlights']['rows_removed'], [2])
        self.assertIn('hash table', pairs['note'])
        self.assertIn('no row order', result['message'])

    def test_left_join_fills_null(self):
        record = one(self.STOCK + "cones.join(stock, on='Flavor', how='left')")
        self.assertEqual(record['sub_steps'][0]['panel']['keeps'], ['left_only', 'both'])
        self.assertIn('null where a side had no match', record['sub_steps'][2]['message'])
        self.assertIn({'shown': 'null'}, record['output']['preview'][0])

    def test_anti_join_strikes_matches(self):
        record = one(self.STOCK + "cones.join(stock, on='Flavor', how='anti')")
        self.assertEqual(record['sub_steps'][1]['input_highlights']['rows_removed'], [1, 3, 5])

    def test_different_key_names(self):
        record = one("names = pl.DataFrame({'Name': ['mint'], 'Tubs': [1]})\ncones.join(names, left_on='Flavor', right_on='Name')")
        self.assertEqual(record['explanation'], "Joined (inner) on 'Flavor = Name': 1 row.")


class PivotTest(unittest.TestCase):
    def test_lays_out_the_grid_gathers_then_combines(self):
        record = one("cones.pivot(on='Color', index='Flavor', values='Price', aggregate_function='mean')")
        steps = record['sub_steps']
        self.assertEqual([f['stage'] for f in steps], ['Lay out the grid', "Gather each cell's values", 'Combine each cell', 'Empty cells'])
        self.assertEqual(steps[1]['output_state']['preview'][0][1], [3.55, 3.95])
        self.assertEqual(steps[-2]['detail'], 'mean([3.55, 3.95]) = 3.75')
        self.assertIn('null', steps[-1]['message'])


class LazyTest(unittest.TestCase):
    def test_collect_shows_each_step_then_the_plan(self):
        records = trace("(cones.lazy()\n  .filter(pl.col('Price') > 4)\n  .group_by('Flavor', maintain_order=True)\n"
                        "  .agg(pl.col('Price').max())\n  .sort('Price')\n  .collect())")
        self.assertEqual([r['operation'] for r in records], ['filter', 'group_by', 'sort', 'collect'])
        self.assertTrue(records[0]['explanation'].endswith('(Worked out when collect() ran.)'))
        # Each step points at its own line of the chain (the cell's line 7 is `(cones.lazy()`)
        self.assertEqual([r['site']['line'] for r in records], [8, 10, 11, 12])
        self.assertEqual(records[1]['input']['num_rows'], 4)
        collect = records[-1]
        self.assertEqual(collect['input']['num_rows'], 6)
        self.assertEqual(collect['output']['num_rows'], 3)
        written, ran = collect['sub_steps'][0]['panel']['plans']
        self.assertEqual((written['title'], ran['title']), ('As written', 'As polars runs it'))
        # Read first step to last: the table, then the filter, ..., the sort
        self.assertEqual(ran['steps'][0]['name'], 'DF')
        self.assertEqual(ran['steps'][-1]['name'], 'SORT BY')
        self.assertIn('only the columns', collect['sub_steps'][0]['message'])

    def test_nothing_is_recorded_until_collect(self):
        self.assertEqual(trace("plan = cones.lazy().filter(pl.col('Price') > 4)"), [])

    def test_a_lazy_join_collects_the_other_side(self):
        records = trace("stock = pl.LazyFrame({'Flavor': ['mint'], 'Tubs': [1]})\ncones.lazy().join(stock, on='Flavor').collect()")
        self.assertEqual([r['operation'] for r in records], ['join', 'collect'])
        self.assertEqual(records[0]['output']['num_rows'], 1)

    def test_a_branch_keeps_its_own_steps(self):
        records = trace("base = cones.lazy().filter(pl.col('Price') > 4)\n"
                        "a = base.sort('Price').collect()\nb = base.select('Flavor').collect()")
        self.assertEqual([r['operation'] for r in records], ['filter', 'sort', 'collect', 'filter', 'select', 'collect'])


NULLS = """
ratings = pl.DataFrame({
    'Flavor': ['mint', 'chocolate', 'vanilla', None, 'chocolate'],
    'Stars': [4.0, None, 5.0, 3.0, None],
})
"""


class RowsByPositionTest(unittest.TestCase):
    def test_head_keeps_the_first_rows(self):
        record = one("cones.head(2)")
        [take] = record['sub_steps']
        self.assertEqual(take['input_highlights'], {'rows': [0, 1], 'rows_removed': [2, 3, 4, 5]})
        self.assertIn('positions 0 to 1', take['message'])

    def test_a_head_that_keeps_every_row_is_not_a_step(self):
        self.assertEqual(trace("cones.head(10)"), [])

    def test_tail_and_slice(self):
        self.assertEqual(one("cones.tail(1)")['sub_steps'][0]['input_highlights']['rows'], [5])
        self.assertIn('the last row', one("cones.tail(1)")['explanation'])
        self.assertEqual(one("cones.slice(2, 3)")['sub_steps'][0]['input_highlights']['rows'], [2, 3, 4])

    def test_rows_and_columns_by_subscript(self):
        record = one("cones[1:3, ['Flavor', 'Price']]")
        self.assertEqual(record['operation'], '[]')
        self.assertEqual(record['label'], "cones[1:3, ['Flavor', 'Price']]")
        self.assertEqual(record['sub_steps'][0]['input_highlights'],
                         {'rows': [1, 2], 'rows_removed': [0, 3, 4, 5], 'columns': ['Flavor', 'Price']})
        self.assertIn('end position is left out', record['sub_steps'][0]['message'])

    def test_a_column_is_a_series(self):
        record = one("cones['Price']")
        self.assertEqual(record['label'], "cones['Price']")
        self.assertEqual(record['output']['columns'], ['Price'])
        self.assertEqual(record['output']['column_types'], ['f64'])
        self.assertEqual(record['sub_steps'][0]['output_label'], 'Series')
        self.assertEqual(one("cones.get_column('Price')")['output']['preview'][0], [3.55])


class DropRenameTest(unittest.TestCase):
    def test_drop_and_rename(self):
        drop = one("cones.drop('Color')")
        self.assertEqual(drop['sub_steps'][0]['input_highlights'], {'columns': ['Color']})
        rename = one("cones.rename({'Price': 'Cost'})")
        self.assertEqual(rename['sub_steps'][0]['output_highlights'], {'columns': ['Cost']})
        self.assertIn("'Price' → 'Cost'", rename['explanation'])


class NullsTest(unittest.TestCase):
    def test_null_count_finds_then_counts(self):
        record = tracer.run(CONES + NULLS + "ratings.null_count()")[0]
        find, count = record['sub_steps']
        self.assertEqual(find['input_highlights']['cells'], [[1, 'Stars'], [3, 'Flavor'], [4, 'Stars']])
        self.assertEqual(record['output']['preview'], [[1, 2]])
        self.assertEqual(count['output_highlights'], {'columns': ['Flavor', 'Stars']})

    def test_drop_nulls_strikes_rows_with_a_null(self):
        record = tracer.run(CONES + NULLS + "ratings.drop_nulls()")[0]
        self.assertEqual(record['sub_steps'][1]['input_highlights']['rows_removed'], [1, 3, 4])
        subset = tracer.run(CONES + NULLS + "ratings.drop_nulls(subset='Flavor')")[0]
        self.assertEqual(subset['sub_steps'][1]['input_highlights']['rows_removed'], [3])

    def test_fill_null_says_which_nulls_stay(self):
        record = tracer.run(CONES + NULLS + "ratings.fill_null(0)")[0]
        fill = record['sub_steps'][1]
        self.assertEqual(fill['output_highlights'], {'cells': [[1, 'Stars'], [4, 'Stars']]})
        self.assertIn("The nulls in the column 'Flavor' stay", fill['message'])

    def test_nan_is_not_null(self):
        record = tracer.run(CONES + "pl.DataFrame({'x': [1.0, float('nan'), None]}).null_count()")[0]
        self.assertIn('NaN', record['sub_steps'][0]['message'])
        self.assertEqual(record['output']['preview'], [[1]])


class RepeatsTest(unittest.TestCase):
    def test_unique_colours_copies_then_keeps_one(self):
        record = one("cones.unique(subset='Flavor', keep='first', maintain_order=True)")
        find, keep = record['sub_steps']
        self.assertEqual(find['input_highlights']['row_colors'], [0, 1, None, 1, 0, None])
        self.assertEqual(keep['input_highlights']['rows_removed'], [3, 4])

    def test_without_maintain_order_says_so(self):
        record = one("cones.unique()")
        self.assertIn('any order', record['sub_steps'][1]['message'])

    def test_group_head_keeps_the_first_rows_of_each(self):
        record = one("cones.group_by('Flavor', maintain_order=True).head(1)")
        self.assertEqual(record['label'], 'group_by().head()')
        group, keep = record['sub_steps']
        self.assertEqual(keep['input_highlights']['rows'], [0, 1, 2, 5])
        self.assertEqual(keep['output_highlights']['row_colors'], [0, 1, 2, 3])


class SeriesTest(unittest.TestCase):
    def test_value_counts_groups_then_counts(self):
        column, counts = trace("cones['Flavor'].value_counts(sort=True)")
        self.assertEqual([s['stage'] for s in counts['sub_steps']],
                         ['Sort rows into groups', 'Combine each group', 'One row per group'])
        cards = counts['sub_steps'][1]['panel']['groups']
        self.assertEqual(cards[0]['values'][0]['formula'], 'count() = 2')

    def test_is_in_asks_every_value(self):
        column, ask = trace("cones['Flavor'].is_in(['mint', 'vanilla'])")
        table = ask['sub_steps'][0]['output_state']
        self.assertEqual(table['columns'], ['Flavor', "cones['Flavor'].is_in(['mint', 'vanilla'])"])
        self.assertEqual([r[1] for r in table['preview']], [False, False, True, False, False, True])

    def test_one_frame_series_methods(self):
        for code, operation in [("cones['Price'].sort()", 'sort'), ("cones['Flavor'].unique(maintain_order=True)", 'unique'),
                                ("cones['Price'].cast(pl.Int64)", 'cast')]:
            with self.subTest(code=code):
                self.assertEqual(trace(code)[-1]['operation'], operation)
        self.assertEqual(trace("cones['Price'].cast(pl.Int64)")[-1]['output']['column_types'], ['i64'])


class SafetyTest(unittest.TestCase):
    def test_other_objects_with_the_same_method_names_are_untouched(self):
        self.assertEqual(trace("x = ', '.join(['a', 'b'])\ny = [1, 1].count(1)\nz = sorted([2, 1])"), [])

    def test_untraced_methods_still_run(self):
        records = trace("cones.clone().filter(pl.col('Price') > 4)")
        self.assertEqual([r['operation'] for r in records], ['filter'])

    def test_subscripts_on_anything_else_are_untouched(self):
        self.assertEqual(trace("x = [1, 2, 3][1:]\ny = {'a': 1}['a']\nz = cones.columns[0]"), [])

    def test_a_single_value_is_not_a_step(self):
        self.assertEqual(trace("v = cones[0, 'Flavor']\nr = cones.row(0)\nn = cones['Price'].arg_max()")[1:], [])

    def test_errors_reach_the_student_unchanged(self):
        with self.assertRaises(Exception) as caught:
            trace("cones.filter(pl.col('Nope') > 1)")
        self.assertIn('Nope', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
