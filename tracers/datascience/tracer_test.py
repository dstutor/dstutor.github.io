"""
Regression tests for tracer.py, run under CPython (much faster than Pyodide): npm run test:tracers.

Needs the packages in requirements-test.txt (pip install -r requirements-test.txt). The tracer
is loaded the way the runtime loads it: exec'd into a namespace of its own, then install()ed.
"""
import inspect
import json
import os
import unittest

import matplotlib
matplotlib.use('agg')

import numpy as np
from datascience import Table, make_array, are

HERE = os.path.dirname(os.path.abspath(__file__))
TRACER = os.path.join(HERE, 'tracer.py')


def load_tracer():
    ns = {}
    with open(TRACER, encoding='utf-8') as f:
        exec(f.read(), ns)
    # Calls from this test file count as "user code", like calls from a notebook cell
    ns['_USER_FILENAMES'].add(__file__)
    ns['install']()
    ns['reset']()
    return ns


def students():
    return Table().with_columns(
        'Name', make_array('Ana', 'Ben', 'Cy', 'Di'),
        'Age', make_array(19, 20, 21, 22),
        'Major', make_array('CS', 'Math', 'CS', 'Physics'),
    )


class TracerTest(unittest.TestCase):
    def setUp(self):
        self.ns = load_tracer()

    def ops(self):
        return [r['operation'] for r in self.ns['get_trace']()]

    def last(self):
        return self.ns['get_trace']()[-1]

    def test_every_operation_is_recorded_once_and_serialises(self):
        t = students()
        np.random.seed(0)
        t.select('Name'); t.drop('Age'); t.where('Major', 'CS'); t.where('Age', are.above(20))
        t.sort('Age', descending=True); t.group('Major'); t.group('Major', max)
        t.pivot('Major', 'Name'); t.join('Name', t); t.take(2); t.take[0:2]
        t.with_column('X', make_array(1, 2, 3, 4)); t.with_row(['Ed', 23, 'CS'])
        t.apply(len, 'Name'); t.column('Age'); t.sample(3); t.shuffle(); t.split(2)
        self.assertEqual(self.ops(), [
            'with_columns', 'select', 'drop', 'where', 'where', 'sort', 'group', 'group', 'pivot',
            'join', 'take', 'take', 'with_column', 'with_row', 'apply', 'column', 'sample', 'shuffle', 'split',
        ])
        json.dumps(self.ns['get_trace']())  # must be JSON safe

    def test_internal_calls_are_not_recorded(self):
        t = students()
        numeric = t.select('Name', 'Age')
        self.ns['clear_trace']()
        t.hist('Age', bins=3); t.scatter('Age', 'Age'); numeric.barh('Name')
        self.assertEqual(self.ops(), [], 'plotting methods call select internally; that is not a step')
        t.split(2)
        self.assertEqual(self.ops(), ['split'], "split's internal take must not appear")

    def test_where_frames_mark_kept_and_removed_rows(self):
        t = students()
        t.where('Major', 'CS')
        steps = self.last()['sub_steps']
        self.assertEqual(steps[-1]['input_highlights']['rows'], [0, 2])
        self.assertEqual(steps[-1]['input_highlights']['rows_removed'], [1, 3])

    def test_apply_shows_one_frame_per_row_with_the_call(self):
        t = students()
        def double(x):
            return 2 * x
        t.apply(double, 'Age')
        rec = self.last()
        self.assertEqual(rec['output']['kind'], 'array')
        self.assertEqual(rec['output']['columns'], ['double(Age)'])
        self.assertEqual([row[0] for row in rec['output']['preview']], [38, 40, 42, 44])
        details = [s.get('detail') for s in rec['sub_steps'] if s.get('detail')]
        self.assertEqual(details, ['double(19) = 38', 'double(20) = 40', 'double(21) = 42', 'double(22) = 44'])
        self.assertEqual(rec['sub_steps'][1]['input_highlights'], {'rows': [0], 'columns': ['Age']})
        self.assertTrue(rec['sub_steps'][1]['message'].startswith('Row 0:'), 'rows are numbered from 0, like take() and row()')
        self.assertEqual(rec['sub_steps'][1]['output_highlights'], {'cells': [[0, 'double(Age)']]})

    def test_apply_with_two_columns_and_with_whole_row(self):
        t = students()
        t.apply(lambda n, a: f'{n}:{a}', 'Name', 'Age')
        self.assertEqual(self.last()['output']['columns'], ['f(Name, Age)'])
        self.assertIn("called with 'Ana', 19", self.last()['sub_steps'][1]['message'])
        t.apply(lambda row: row.item('Age') + 1)
        self.assertEqual(self.last()['output']['columns'], ['f(row)'])
        self.assertIn("whole row (Name='Ana', Age=19, Major='CS')", self.last()['sub_steps'][1]['message'])

    def test_column_by_label_and_by_index(self):
        t = students()
        t.column('Age'); t.column(1)
        for rec in self.ns['get_trace']()[-2:]:
            self.assertEqual(rec['output']['columns'], ['Age'])
            self.assertEqual(rec['output']['kind'], 'array')
            self.assertEqual(rec['output']['num_rows'], 4)

    def test_sample_frames_follow_the_actual_draws(self):
        t = students()
        np.random.seed(4)
        result = t.sample(3)
        rec = self.last()
        draws = [s['input_highlights']['rows'][0] for s in rec['sub_steps'] if 'input_highlights' in s and s['message'].startswith('Draw')]
        self.assertEqual(len(draws), 3)
        # each drawn row must be the row that actually appears in the sample at that position
        names = t.column('Name')
        self.assertEqual([names[i] for i in draws], list(result.column('Name')))

    def test_split_reports_both_tables(self):
        t = students()
        np.random.seed(1)
        first, rest = t.split(3)
        rec = self.last()
        self.assertEqual(rec['output']['num_rows'], 3)
        aux = rec['sub_steps'][-1]['aux_output']
        self.assertEqual(aux['state']['num_rows'], 1)
        self.assertEqual(aux['state']['preview'][0][0], rest.column('Name')[0])

    def test_group_frames_match_datascience_result(self):
        t = students()
        t.group('Major', max)
        rec = self.last()
        self.assertEqual(rec['output']['columns'], ['Major', 'Name max', 'Age max'])
        self.assertTrue(rec.get('sub_steps'), 'group should have a walkthrough')

    def test_trace_is_capped(self):
        t = students()
        self.ns['clear_trace']()
        for _ in range(self.ns['MAX_TRACE_RECORDS'] + 50):
            t.sample(1)
        self.assertEqual(len(self.ns['get_trace']()), self.ns['MAX_TRACE_RECORDS'])
        self.assertTrue(self.ns['is_trace_truncated']())
        self.ns['clear_trace']()
        self.assertFalse(self.ns['is_trace_truncated']())

    def test_nan_and_inf_values_are_json_safe(self):
        t = Table().with_columns('x', make_array(1.0, float('nan'), float('inf')))
        t.sort('x')
        json.dumps(self.ns['get_trace']())


class TracerInterfaceTest(unittest.TestCase):
    def setUp(self):
        self.ns = load_tracer()

    def test_exposes_install_run_reset(self):
        self.assertEqual(list(inspect.signature(self.ns['install']).parameters), [])
        self.assertEqual(list(inspect.signature(self.ns['run']).parameters), ['code'])
        self.assertEqual(list(inspect.signature(self.ns['reset']).parameters), [])

    def test_run_returns_the_steps_of_the_code(self):
        trace = self.ns['run'](
            "from datascience import Table, make_array\n"
            "t = Table().with_columns('A', make_array(1, 2, 3))\n"
            "t.where('A', 2)\n"
        )
        self.assertEqual([r['operation'] for r in trace], ['with_columns', 'where'])
        self.assertEqual(trace[-1]['output']['num_rows'], 1)
        json.dumps(trace)

    def test_run_starts_a_fresh_trace(self):
        setup = "from datascience import Table, make_array\n"
        self.ns['run'](setup + "Table().with_columns('A', make_array(1))\n")
        trace = self.ns['run'](setup + "Table().with_columns('B', make_array(2))\n")
        self.assertEqual(len(trace), 1)
        self.assertEqual(trace[0]['step_id'], 1)


if __name__ == '__main__':
    unittest.main()
