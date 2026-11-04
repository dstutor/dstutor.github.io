"""Tracer for SQL on DuckDB: each query shown clause by clause, in the order SQL runs them.

A cell holds SQL. source_to_python() turns it into `_dstutor_sql(cell, globals())`, which runs
each statement on the notebook's DuckDB connection (made on first use and kept in the notebook
namespace as _dstutor_db, so Restart forgets every table) and returns the last query's result
for the cell to show. For each SELECT the tracer reads DuckDB's own parse of the query
(json_serialize_sql) and builds the query as it stands after each clause, in SQL's logical
order rather than the order it is written:

    FROM (and JOIN) -> WHERE -> GROUP BY -> HAVING -> SELECT -> DISTINCT -> ORDER BY -> LIMIT

json_deserialize_sql turns each back into SQL and DuckDB runs it; the tables in between become
the steps. Each step is labelled with its clause as the student wrote it, found with DuckDB's
tokenizer, and its site spans that clause's lines (not the whole query), so the notebook marks
the clause the step is about. docs/visualizing-steps.md has the design.

The runtime (@dstutor/runtime-pyodide) loads this file as a module (after the shared
dstutor_rewriting, for the step log and formatting) and calls install(), reset(), get_trace(),
is_trace_truncated(), set_cell_statements(), source_to_python() and format_error(); run(code)
runs SQL on its own, for tests.
"""
import builtins
import copy
import datetime
import decimal
import json
import math
import re

from dstutor_rewriting import (
    MAX_GROUP_STEPS, MAX_ROWS_PREVIEW, Log, group_stages, join_stages, table_name,
    display as _display, fmt_list as _fmt_list, fmt_val as _fmt_val, like as _like,
    make_state as _make_state, plural as _plural, truncation_note as _truncation_note,
)

CONNECTION = '_dstutor_db'
LABEL_LENGTH = 72
# Functions that combine a group's values into one
AGGREGATES = {'avg', 'mean', 'sum', 'min', 'max', 'count', 'count_star', 'median', 'first', 'last', 'list',
              'string_agg', 'any_value', 'stddev', 'stddev_samp', 'stddev_pop', 'variance', 'var_samp', 'var_pop',
              'arg_min', 'arg_max', 'bool_and', 'bool_or', 'mode', 'product', 'array_agg', 'group_concat'}
# Keywords that start a clause of a SELECT (outside parentheses)
CLAUSE_WORDS = {'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET'}

_log = Log()
_enabled = False


# ---------------------------------------------------------------------------------------------
# The interface every tracer exposes

def install():
    """Make the cell's runner available and start recording. Idempotent."""
    global _enabled
    builtins._dstutor_sql = _run_sql
    _enabled = True


def disable():
    global _enabled
    _enabled = False


def reset():
    """Forget every recorded step."""
    _log.reset()


def get_trace():
    return _log.records.copy()


def is_trace_truncated():
    return _log.truncated


def set_cell_statements(statements):
    """The runner's Python statements; a SQL cell's steps find their lines in the SQL instead."""


def source_to_python(code):
    """The Python that runs a SQL cell."""
    return f"_dstutor_sql({code!r}, globals())"


def format_error(error):
    """DuckDB's own message (it names the line and points at the spot), or None for Python's."""
    import duckdb
    return str(error).rstrip() + '\n' if isinstance(error, duckdb.Error) else None


def run(code, namespace=None):
    """Run SQL as a fresh notebook cell and return the TraceRecord dicts it produced."""
    install()
    reset()
    _run_sql(code, {} if namespace is None else namespace)
    return get_trace()


# ---------------------------------------------------------------------------------------------
# Running a cell

def _connection(namespace):
    import duckdb
    con = namespace.get(CONNECTION)
    if con is None:
        con = duckdb.connect()
        # One thread, so each step's query returns its rows in the same order every time; and no
        # Python variables as tables (DuckDB's replacement scans), or FROM text would find the
        # tracer's own variable instead of saying there is no table called text
        for setting in ('SET threads TO 1', 'SET python_enable_replacements = false'):
            try:
                con.execute(setting)
            except Exception:
                pass
        namespace[CONNECTION] = con
    return con


def _run_sql(code, namespace):
    import duckdb
    con = _connection(namespace)
    result = None
    offset = 0
    for statement in duckdb.extract_statements(code):
        text = statement.query
        start = code.find(text, offset)
        start = offset if start < 0 else start
        offset = start + len(text)
        if statement.type == duckdb.StatementType.SELECT:
            # Run it first, so an error stops the cell before any step is recorded
            con.execute(text).fetchall()
            if _enabled:
                try:
                    _trace_select(con, text, code.count('\n', 0, start) + 1)
                except Exception:
                    pass
            result = con.sql(text)
        else:
            con.execute(text)
            result = None
    return result


# ---------------------------------------------------------------------------------------------
# Tables

def _cell(value):
    """A value as JSON; NULL, NaN and the infinities as {"shown": text}, as DuckDB prints them."""
    if value is None:
        return {"shown": "NULL"}
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return {"shown": "nan"}
        if math.isinf(value):
            return {"shown": "inf" if value > 0 else "-inf"}
        return value
    if isinstance(value, (int, str)):
        return value
    if isinstance(value, decimal.Decimal):
        return _cell(float(value))
    if isinstance(value, (list, tuple)):
        return [_cell(v) for v in value]
    if isinstance(value, (datetime.date, datetime.time, datetime.timedelta)):
        return str(value)
    if isinstance(value, dict):
        return '{' + ', '.join(f"{k}: {_fmt_val(_cell(v))}" for k, v in value.items()) + '}'
    return str(value)


class _Columns(list):
    """A table's column names, carrying each one's type as DuckDB prints it (varchar, double)."""

    def __init__(self, names, types):
        super().__init__(names)
        self.types = list(types)


# DuckDB's tables print these types by their sizes; every other type is printed in lower case
_TYPE_NAMES = {'TINYINT': 'int8', 'SMALLINT': 'int16', 'INTEGER': 'int32', 'BIGINT': 'int64', 'HUGEINT': 'int128',
               'UTINYINT': 'uint8', 'USMALLINT': 'uint16', 'UINTEGER': 'uint32', 'UBIGINT': 'uint64',
               'UHUGEINT': 'uint128', 'FLOAT': 'float'}


def _type_name(duckdb_type):
    text = str(duckdb_type)
    base = text.rstrip('[]')
    return _TYPE_NAMES.get(base, base.lower()) + text[len(base):]


def _state(columns, rows):
    state = {"num_rows": len(rows), "num_columns": len(columns), "columns": list(columns),
             "preview": [[_cell(v) for v in row] for row in rows[:MAX_ROWS_PREVIEW]]}
    if isinstance(columns, _Columns):
        state["column_types"] = list(columns.types)
    return state


def _index_of(name, columns):
    """A column's position, matched without case as DuckDB matches names, or None."""
    lowered = [c.lower() for c in columns]
    return lowered.index(name.lower()) if name.lower() in lowered else None


def _refs(expr):
    """Names of the columns an expression reads."""
    found = []

    def walk(x):
        if isinstance(x, dict):
            if x.get('class') == 'COLUMN_REF' and x.get('column_names'):
                found.append(x['column_names'][-1])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    walk(expr)
    return found


def _used(exprs, columns):
    """The table's columns that the expressions read, in the table's order."""
    names = {n.lower() for e in exprs for n in _refs(e)}
    return list(dict.fromkeys(c for c in columns if c.lower() in names))


def _aggregate_of(expr):
    """(FUNCTION, column it combines or None) when expr is an aggregate, else None."""
    if expr.get('class') != 'FUNCTION' or expr.get('function_name', '').lower() not in AGGREGATES:
        return None
    children = expr.get('children') or []
    column = children[0]['column_names'][-1] if (len(children) == 1 and children[0].get('class') == 'COLUMN_REF'
                                                 and not expr.get('distinct')) else None
    name = 'COUNT' if expr['function_name'].lower() == 'count_star' else expr['function_name'].upper()
    return name, column


def _has_aggregate(expr):
    if isinstance(expr, dict):
        if _aggregate_of(expr) is not None:
            return True
        return any(_has_aggregate(v) for k, v in expr.items() if k != 'order_bys')
    if isinstance(expr, list):
        return any(_has_aggregate(v) for v in expr)
    return False


# ---------------------------------------------------------------------------------------------
# The query, clause by clause

class _Query:
    """One SELECT, parsed by DuckDB, rebuilt with only some of its clauses."""

    def __init__(self, con, text):
        self.con = con
        self.parsed = json.loads(con.execute("SELECT json_serialize_sql(?)", [text]).fetchone()[0])
        self.node = self.parsed['statements'][0]['node'] if not self.parsed.get('error') else None
        star = json.loads(con.execute("SELECT json_serialize_sql('SELECT * FROM t')").fetchone()[0])
        self.star = star['statements'][0]['node']['select_list'][0]

    def sql(self, select=None, where=False, group=False, having=False, modifiers=(), from_table=None):
        node = copy.deepcopy(self.node)
        node['select_list'] = select if select is not None else [self.star]
        if not where:
            node['where_clause'] = None
        if not group:
            node['group_expressions'] = []
            node['group_sets'] = []
        if not having:
            node['having'] = None
        node['modifiers'] = [m for m in node['modifiers'] if m['type'] in modifiers]
        if from_table is not None:
            node['from_table'] = from_table
        envelope = copy.deepcopy(self.parsed)
        envelope['statements'][0]['node'] = node
        return self.con.execute("SELECT json_deserialize_sql(?)", [json.dumps(envelope)]).fetchone()[0]

    def run(self, sql):
        cursor = self.con.execute(sql)
        names = _Columns([d[0] for d in cursor.description], [_type_name(d[1]) for d in cursor.description])
        return names, cursor.fetchall()


def _aliased(expr, alias):
    expr = copy.deepcopy(expr)
    expr['alias'] = alias
    return expr


def _clauses(text):
    """Where each clause of the outermost SELECT starts and ends in text: {'WHERE': (start, end)}."""
    import duckdb
    tokens = duckdb.tokenize(text)
    # Each token's text runs to the next token (operators like ( and ) can be back to back)
    ends = [pos for pos, _ in tokens[1:]] + [len(text)]
    words = [re.match(r'\S*', text[pos:end]).group(0) for (pos, _), end in zip(tokens, ends)]
    starts = []
    depth = 0
    for i, (pos, kind) in enumerate(tokens):
        word = words[i]
        if kind == duckdb.token_type.operator:
            depth += word.count('(') - word.count(')')
        elif kind == duckdb.token_type.keyword and depth == 0:
            upper = word.upper()
            following = words[i + 1].upper() if i + 1 < len(words) else ''
            # GROUP and ORDER start a clause only as GROUP BY and ORDER BY (not WITHIN GROUP)
            if upper in CLAUSE_WORDS and (upper not in ('GROUP', 'ORDER') or following == 'BY'):
                starts.append(({'GROUP': 'GROUP BY', 'ORDER': 'ORDER BY'}.get(upper, upper), pos))
    end_of_text = len(text.rstrip().rstrip(';'))
    spans = {}
    for j, (name, pos) in enumerate(starts):
        end = starts[j + 1][1] if j + 1 < len(starts) else end_of_text
        spans.setdefault(name, (pos, end))
    return spans


def _clause_text(text, span, keyword=None):
    """A clause as written, on one line and without comments; without its keyword if given."""
    code = re.sub(r'--[^\n]*|/\*.*?\*/', ' ', text[span[0]:span[1]], flags=re.S)
    code = ' '.join(code.split()).rstrip(';').strip()
    if keyword and code.upper().startswith(keyword):
        code = code[len(keyword):].strip()
    return code


def _label(code):
    return code if len(code) <= LABEL_LENGTH else code[:LABEL_LENGTH - 1].rstrip() + '…'


def _trace_select(con, text, first_line):
    query = _Query(con, text)
    node = query.node
    if (node is None or node.get('type') != 'SELECT_NODE' or node['cte_map']['map'] or node.get('qualify')
            or node.get('sample') or node['from_table'].get('type') == 'EMPTY'):
        return
    spans = _clauses(text)
    if 'FROM' not in spans:
        return
    lines_of = lambda pos: first_line + text.count('\n', 0, pos)

    def last_line(span):
        # The clause's last line with code on it (not the blank or comment lines before the next)
        code = re.sub(r'--[^\n]*', '', text[span[0]:span[1]]).rstrip()
        return lines_of(span[0] + len(code) - 1) if code else lines_of(span[0])

    def record(operation, clause, input_state, output_state, explanation, steps, keyword=None, label=None):
        span = spans.get(clause) or spans['SELECT' if 'SELECT' in spans else 'FROM']
        _log.add({
            "operation": operation,
            "label": _label(label or _clause_text(text, span)),
            "args": [],
            "kwargs": {},
            "input": input_state,
            "output": output_state,
            "explanation": explanation,
            "sub_steps": steps,
            # The clause's own lines, so the notebook marks the clause each step is about
            "site": {"line": lines_of(span[0]), "stmt_start": lines_of(span[0]), "stmt_end": last_line(span), "target": None},
        })

    first_record = len(_log.records)
    modifiers = {m['type']: m for m in node['modifiers']}
    distinct = 'DISTINCT_MODIFIER' in modifiers and not modifiers['DISTINCT_MODIFIER'].get('distinct_on_targets')
    grouped = bool(node['group_expressions'])
    select_list = node['select_list']
    is_star = (len(select_list) == 1 and select_list[0].get('class') == 'STAR'
               and not select_list[0].get('exclude_list') and not select_list[0].get('replace_list'))
    whole = not grouped and not is_star and any(_has_aggregate(e) for e in select_list)

    # FROM: the starting table, or the join of two
    columns, rows = query.run(query.sql())
    if node['from_table'].get('type') == 'JOIN':
        _join_step(query, node['from_table'], columns, rows, record)

    # WHERE
    if node['where_clause'] is not None:
        out_columns, out_rows = query.run(query.sql(where=True))
        _, mask_rows = query.run(query.sql(select=[_aliased(node['where_clause'], '__dstutor_mask')]))
        condition = _clause_text(text, spans['WHERE'], 'WHERE') if 'WHERE' in spans else 'the condition'
        steps = _condition_steps(columns, rows, [r[0] for r in mask_rows], len(out_rows), condition,
                                 _used([node['where_clause']], columns), 'row')
        if steps and node['from_table'].get('type') == 'BASE_TABLE':
            steps[0]["note"] = ("DuckDB never builds this column: it checks the condition while it scans the table "
                                "and keeps only the positions of the rows that pass.")
        record('WHERE', 'WHERE', _state(columns, rows), _state(out_columns, out_rows),
               f"Kept {len(out_rows)} of {_plural(len(rows), 'row')}.", steps)
        columns, rows = out_columns, out_rows

    # GROUP BY (with the SELECT's aggregates, worked out for each group), then HAVING
    if grouped:
        columns, rows = _group_steps(query, node, text, spans, columns, rows, record)
    elif whole or not is_star:
        out_columns, out_rows = query.run(query.sql(select=select_list, where=True))
        if whole:
            steps = _whole_table_steps(select_list, columns, rows, out_columns, out_rows)
            explanation = f"Combined all {_plural(len(rows), 'row')} into one."
        else:
            steps = [
                {
                    "stage": "Work out the columns",
                    "message": "SELECT makes the result's columns: each one listed is kept or worked out for every row.",
                    "input_highlights": {"columns": _used(select_list, columns)},
                    "output_state": _state(out_columns, out_rows),
                    "output_label": "Result (building…)",
                    "output_highlights": {"columns": [c for c in out_columns if _index_of(c, columns) is None]},
                },
                {"stage": "Result", "message": f"Only the listed columns are left, and every row is kept: {_plural(len(out_columns), 'column')}."},
            ]
            explanation = f"Selected {_plural(len(out_columns), 'column')}."
        record('SELECT', 'SELECT', _state(columns, rows), _state(out_columns, out_rows), explanation, steps)
        columns, rows = out_columns, out_rows

    keep = ('DISTINCT_MODIFIER',) if distinct else ()
    query_select = dict(select=select_list, where=True, group=True, having=True)
    if distinct:
        out_columns, out_rows = query.run(query.sql(modifiers=keep, **query_select))
        seen, kept, removed = set(), [], []
        for i, row in enumerate(rows[:MAX_ROWS_PREVIEW]):
            # repr, since a row can hold lists, which a set cannot
            (removed if repr(row) in seen else kept).append(i)
            seen.add(repr(row))
        steps = [{
            "stage": "Drop repeated rows",
            "message": (f"DISTINCT keeps one of each different row: {len(out_rows)} kept, "
                        f"{len(rows) - len(out_rows)} repeats (struck through) removed.{_truncation_note(_state(columns, rows))}"),
            "input_highlights": {"rows": kept, "rows_removed": removed},
        }]
        record('DISTINCT', 'SELECT', _state(columns, rows), _state(out_columns, out_rows),
               f"Removed {_plural(len(rows) - len(out_rows), 'repeated row')}.", steps, label='DISTINCT')
        columns, rows = out_columns, out_rows

    if 'ORDER_MODIFIER' in modifiers:
        keep += ('ORDER_MODIFIER',)
        out_columns, out_rows = query.run(query.sql(modifiers=keep, **query_select))
        orders = modifiers['ORDER_MODIFIER']['orders']
        steps = _order_steps(orders, columns, rows, out_columns, out_rows)
        record('ORDER BY', 'ORDER BY', _state(columns, rows), _state(out_columns, out_rows),
               f"Sorted {_plural(len(rows), 'row')}.", steps)
        columns, rows = out_columns, out_rows

    if 'LIMIT_MODIFIER' in modifiers or 'LIMIT_PERCENT_MODIFIER' in modifiers:
        out_columns, out_rows = query.run(text)
        start = next((i for i in range(len(rows) - len(out_rows) + 1) if rows[i:i + len(out_rows)] == out_rows), None)
        clause = 'LIMIT' if 'LIMIT' in spans else 'OFFSET'
        n_preview = min(len(rows), MAX_ROWS_PREVIEW)
        steps = [{
            "stage": "Keep the first rows",
            "message": (f"{_clause_text(text, spans[clause]).split()[0].upper()} keeps "
                        f"{_plural(len(out_rows), 'row')}, in order; the other {len(rows) - len(out_rows)} "
                        f"(struck through) {'is' if len(rows) - len(out_rows) == 1 else 'are'} left out."),
            "input_highlights": ({"rows": [i for i in range(n_preview) if start <= i < start + len(out_rows)],
                                  "rows_removed": [i for i in range(n_preview) if not start <= i < start + len(out_rows)]}
                                 if start is not None else {}),
        }]
        label = ' '.join(_clause_text(text, spans[c]) for c in ('LIMIT', 'OFFSET') if c in spans)
        record('LIMIT', clause, _state(columns, rows), _state(out_columns, out_rows),
               f"Kept {_plural(len(out_rows), 'row')}.", steps, label=label)
        columns, rows = out_columns, out_rows

    # The clauses above are what the query means; DuckDB's own plan is how it ran
    if len(_log.records) > first_record:
        try:
            _add_plan(con, text, _log.records[-1])
        except Exception:
            pass


# ---------------------------------------------------------------------------------------------
# How DuckDB ran it

# Plan details worth showing, and how to say them
_PLAN_DETAILS = ('Table', 'Filters', 'Join Type', 'Conditions', 'Groups', 'Aggregates', 'Expression', 'Top',
                 'Order By', 'Limit')


def _plan_steps(con, text):
    """DuckDB's physical plan for the query, first operator to last, with the rows out of each."""
    tree = json.loads(con.execute("EXPLAIN (ANALYZE, FORMAT JSON) " + text).fetchall()[0][1])
    steps = []

    def say(value):
        value = ', '.join(map(str, value)) if isinstance(value, list) else str(value)
        return value.replace('memory.main.', '')

    def walk(node):
        # A join's second input (the side it builds its hash table from) runs before its first,
        # which streams through; so children are visited last to first
        for child in reversed(node.get('children', [])):
            walk(child)
        name = node.get('operator_name')
        # Projections only move columns around (and compress strings); leave them out
        if not name or name in ('EXPLAIN_ANALYZE', 'PROJECTION', 'RESULT_COLLECTOR'):
            return
        info = node.get('extra_info') or {}
        step = {"name": name}
        detail = ' · '.join(f"{k}: {say(info[k])}" for k in _PLAN_DETAILS
                            if k in info and info[k] not in ('', []) and '#' not in say(info[k]))
        if detail:
            step["detail"] = detail
        if isinstance(node.get('operator_cardinality'), int):
            step["rows"] = node['operator_cardinality']
        steps.append(step)
    walk(tree)
    return steps


def _add_plan(con, text, record):
    steps = _plan_steps(con, text)
    if not steps:
        return
    names = [s['name'] for s in steps]
    points = []
    if any(s['name'] == 'SEQ_SCAN' and 'Filters' in s.get('detail', '') for s in steps):
        points.append("the WHERE ran inside the table scan, so no other rows were ever read in")
    if 'TOP_N' in names:
        points.append("ORDER BY with LIMIT became one TOP_N step that only keeps the top rows")
    if any(n.endswith('GROUP_BY') for n in names):
        points.append("GROUP BY kept a running total per group")
    record.setdefault("sub_steps", []).append({
        "stage": "How DuckDB ran it",
        "message": ("The steps above are what the query means, in SQL's logical order. DuckDB ran it as this "
                    "plan, first step at the top" + (": " + "; ".join(points) + "." if points else ".")),
        "panel": {"kind": "plan", "plans": [{"title": "DuckDB's plan", "steps": steps}]},
        "output_label": "How DuckDB ran it",
    })


# ---------------------------------------------------------------------------------------------
# The steps of each clause

def _condition_steps(columns, rows, mask, n_kept, condition, used, noun):
    """WHERE and HAVING: the condition as a column of true and false, then the rows kept."""
    if sum(1 for m in mask if m is True) != n_kept:
        return None
    n_preview = min(len(rows), MAX_ROWS_PREVIEW)
    shown = [columns.index(c) for c in used] or list(range(min(len(columns), 2)))
    check_columns = [columns[c] for c in shown] + [condition]
    if len(set(check_columns)) != len(check_columns):
        check_columns[-1] = f"{condition} (condition)"
    if isinstance(columns, _Columns):
        check_columns = _Columns(check_columns, [columns.types[c] for c in shown] + ['boolean'])
    check_rows = [[row[c] for c in shown] + [mask[i]] for i, row in enumerate(rows[:n_preview])]
    nulls = any(m is None for m in mask)
    return [
        {
            "stage": f"Ask every {noun}",
            "message": f"First the condition is worked out for every {noun}, giving a column of true and false.",
            "detail": f"Condition: {condition}",
            "input_highlights": {"columns": used},
            "output_state": {**_state(check_columns, check_rows), "num_rows": len(rows)},
            "output_label": f"true or false for each {noun}",
            "output_highlights": {"columns": [check_columns[-1]]},
        },
        {
            "stage": f"Keep the true {noun}s",
            "message": (f"Keep the {noun}s where it is true: {n_kept} kept, {len(rows) - n_kept} (struck through) removed."
                        + (" NULL is not true, so its row is removed too." if nulls else "")
                        + _truncation_note(_state(columns, rows))),
            "input_highlights": {"rows": [i for i in range(n_preview) if mask[i] is True],
                                 "rows_removed": [i for i in range(n_preview) if mask[i] is not True],
                                 "columns": used},
        },
    ]


def _a(word):
    """'a LEFT', 'an INNER'."""
    return f"{'an' if word[:1].upper() in 'AEIOU' else 'a'} {word}"


def _side_columns(table, columns):
    """The names a side of a join answers to: its alias or table name."""
    names = {table.get('alias', '').lower(), table.get('table_name', '').lower()} - {''}
    return names


def _join_step(query, join, columns, rows, record):
    left_columns, left_rows = query.run(query.sql(from_table=join['left']))
    right_columns, right_rows = query.run(query.sql(from_table=join['right']))
    kind = join.get('join_type', 'INNER')
    how = {'INNER': 'inner', 'LEFT': 'left', 'RIGHT': 'right', 'OUTER': 'full', 'FULL': 'full', 'SEMI': 'semi',
           'ANTI': 'anti'}.get(kind) if join.get('ref_type') in (None, 'REGULAR') else None
    explanation = f"Joined into {_plural(len(rows), 'row')}."
    left_state, right_state = _state(left_columns, left_rows), _state(right_columns, right_rows)
    label = "Right table"

    # The key: one column on each side, compared with =, or USING (column)
    li = ri = None
    using = join.get('using_columns') or []
    condition = join.get('condition')
    if len(using) == 1:
        li, ri = _index_of(using[0], left_columns), _index_of(using[0], right_columns)
    elif (condition and condition.get('type') == 'COMPARE_EQUAL' and condition['left'].get('class') == 'COLUMN_REF'
          and condition['right'].get('class') == 'COLUMN_REF'):
        sides = []
        for ref in (condition['left'], condition['right']):
            names = ref['column_names']
            if len(names) > 1:
                side = 'left' if names[-2].lower() in _side_columns(join['left'], left_columns) else (
                    'right' if names[-2].lower() in _side_columns(join['right'], right_columns) else None)
            else:
                in_left, in_right = _index_of(names[-1], left_columns), _index_of(names[-1], right_columns)
                side = 'left' if in_left is not None and in_right is None else (
                    'right' if in_right is not None and in_left is None else None)
            sides.append((side, names[-1]))
        if {s for s, _ in sides} == {'left', 'right'}:
            for side, name in sides:
                if side == 'left':
                    li = _index_of(name, left_columns)
                else:
                    ri = _index_of(name, right_columns)
    if li is None or ri is None or how is None:
        steps = [{
            "message": "The JOIN puts the rows of two tables side by side, wherever its condition is true.",
            "aux_table": {"label": label, "state": right_state},
            "output_state": _like(_state(columns, rows), []),
        }, {"message": f"The joined table has {_plural(len(rows), 'row')}."}]
        record('FROM', 'FROM', left_state, _state(columns, rows), explanation, steps)
        return

    lk, rk = left_columns[li], right_columns[ri]
    out = _state(columns, rows)
    # The key of a joined row: the left key, or the right one where the left side is NULL
    right_key = None if using else len(left_columns) + ri

    def row_key(row):
        if row[li] is not None or right_key is None:
            return row[li]
        return row[right_key]
    keeps = {'inner': ['both'], 'left': ['left_only', 'both'], 'right': ['both', 'right_only'],
             'full': ['left_only', 'both', 'right_only'], 'semi': ['both'], 'anti': ['left_only']}[how]
    key_desc = lk if lk.lower() == rk.lower() else f"{lk} = {rk}"
    steps = join_stages(
        left_keys=[r[li] for r in left_rows], right_keys=[r[ri] for r in right_rows], null_matches=False,
        keeps=keeps, mode=how if how in ('semi', 'anti') else 'pairs',
        left_name=_table_label(join['left'], 'left'), right_name=_table_label(join['right'], 'right'),
        key_desc=key_desc, left_state=left_state, right_state=right_state, left_col=lk, right_col=rk,
        out_state=out, out_keys=[row_key(r) for r in rows[:MAX_ROWS_PREVIEW]], missing='NULL',
        note=("DuckDB builds a hash table from the smaller side's keys, then looks up every row of the other "
              "side in it; NULL keys never match."),
        order_note="Without ORDER BY, SQL promises no row order.", cell=_cell)
    on = lk if lk.lower() == rk.lower() else f"{lk} = {rk}"
    record('FROM', 'FROM', left_state, out, f"Joined ({kind}) on {on}: {_plural(len(rows), 'row')}.", steps)


def _table_label(table, fallback):
    """A side of a join as the query names it: its alias, else its table name."""
    return table.get('alias') or table.get('table_name') or fallback


def _group_steps(query, node, text, spans, columns, rows, record):
    keys = node['group_expressions']
    having = node['having']
    k = len(keys)
    select = ([_aliased(e, f'__dstutor_key{i}') for i, e in enumerate(keys)] + node['select_list']
              + ([_aliased(having, '__dstutor_having')] if having is not None else []))
    all_columns, all_rows = query.run(query.sql(select=select, where=True, group=True))
    h = 1 if having is not None else 0
    out_columns = _Columns(all_columns[k:len(all_columns) - h], all_columns.types[k:len(all_columns) - h])
    out_rows = [tuple(r[k:len(r) - h]) for r in all_rows]
    group_keys = [tuple(r[:k]) for r in all_rows]
    _, key_rows = query.run(query.sql(select=[_aliased(e, f'__dstutor_key{i}') for i, e in enumerate(keys)], where=True))
    row_keys = [tuple(r) for r in key_rows]
    key_names = ', '.join(_clause_text(text, spans['GROUP BY'], 'GROUP BY').split(',')) if 'GROUP BY' in spans else 'the keys'
    key_columns = _used(keys, columns)
    out = _state(out_columns, out_rows)
    # Which input column each result column combines (AVG(Price) combines Price)
    combines = []
    for expr in node['select_list']:
        agg = _aggregate_of(expr)
        combines.append((agg[0], _index_of(agg[1], columns)) if agg and agg[1] else (agg[0], None) if agg else None)
    groups = []
    for gi, row in enumerate(out["preview"]):
        members = [i for i, key in enumerate(row_keys) if key == group_keys[gi]]
        values = []
        for (comb, value, name) in zip(combines, row, out_columns):
            if comb is None:
                continue
            fn, col = comb
            values.append({"column": name, "values": [_cell(rows[m][col]) for m in members] if col is not None else [],
                           "result": value, "fn": fn if col is not None or fn != 'COUNT' else 'COUNT(*)'})
        groups.append({"key": [_cell(v) for v in group_keys[gi]], "members": members, "size": len(members),
                       "values": values})
    steps = group_stages(
        key_names=[_clause_text(text, spans['GROUP BY'], 'GROUP BY')] if 'GROUP BY' in spans else key_columns,
        groups=groups, input_state=_state(columns, rows), out_state=out, key_columns=key_columns,
        value_columns=[columns[c[1]] for c in combines if c and c[1] is not None],
        note=("DuckDB never builds these lists: it keeps one running total per group in a hash table and "
              "updates it as the rows stream past."),
        order_note="Without ORDER BY, SQL returns the groups in no particular order.")
    record('GROUP BY', 'GROUP BY', _state(columns, rows), out,
           f"Grouped {_plural(len(rows), 'row')} into {_plural(len(out_rows), 'group')}.", steps)

    if having is None:
        return out_columns, out_rows
    mask = [r[-1] for r in all_rows]
    kept_rows = [r for r, m in zip(out_rows, mask) if m is True]
    condition = _clause_text(text, spans['HAVING'], 'HAVING') if 'HAVING' in spans else 'the condition'
    steps = _condition_steps(out_columns, out_rows, mask, len(kept_rows), condition, _used([having], out_columns), 'group')
    record('HAVING', 'HAVING', out, _state(out_columns, kept_rows),
           f"Kept {len(kept_rows)} of {_plural(len(out_rows), 'group')}.", steps)
    return out_columns, kept_rows


def _whole_table_steps(select_list, columns, rows, out_columns, out_rows):
    """SELECT with aggregates and no GROUP BY: the whole table is one group."""
    detail = None
    for expr, value in zip(select_list, out_rows[0] if out_rows else []):
        agg = _aggregate_of(expr)
        c = _index_of(agg[1], columns) if agg and agg[1] else None
        if c is not None:
            values = [_cell(r[c]) for r in rows]
            detail = f"{agg[0]}({_fmt_list(values)[1:-1]}) = {_fmt_val(_cell(value))}"
            break
    first = {
        "message": "With no GROUP BY, the aggregates treat the whole table as one group.",
        "input_highlights": {"columns": _used(select_list, columns)},
        "output_state": _like(_state(out_columns, []), []),
    }
    last = {"message": f"All {_plural(len(rows), 'row')} are combined into one row."}
    if detail:
        last["detail"] = detail
    return [first, last]


def _order_steps(orders, columns, rows, out_columns, out_rows):
    by = _used([o['expression'] for o in orders], columns)
    descending = [o.get('type') in ('DESCENDING', 'ORDER_DESCENDING') for o in orders]
    direction = ("largest first" if all(descending) else "smallest first" if not any(descending)
                 else "in the directions given")
    named = ', '.join(by) or 'the expressions given'
    # Where each sorted row was before
    unused = {}
    for i, row in enumerate(rows):
        unused.setdefault(repr(row), []).append(i)
    positions = [unused[repr(r)].pop(0) if unused.get(repr(r)) else None for r in out_rows]
    out = _state(out_columns, out_rows)
    shown = positions[:len(out["preview"])]
    ties = []
    first = next((c for c in by if c in out_columns), None)
    if first is not None:
        vals = [r[out_columns.index(first)] for r in out_rows[:len(shown)]]
        start = 0
        for i in range(1, len(vals) + 1):
            if i == len(vals) or vals[i] != vals[start]:
                if i - start > 1:
                    ties.append([start, i - 1])
                start = i
    steps = [{
        "stage": "Read the sort key",
        "message": f"ORDER BY puts every row in order of {named}, {direction}. No rows are added or removed.",
        "input_highlights": {"columns": by},
        "output_state": _like(out, []),
    }]
    if all(p is not None for p in shown):
        steps.append({
            "stage": "Work out the new order",
            "message": "First DuckDB works out the new order: the position each row comes from, counting from 0.",
            "input_highlights": {"columns": by},
            "panel": {"kind": "order", "from": shown, **({"ties": ties} if ties else {}),
                      **({"values": [_cell(r[out_columns.index(first)]) for r in out_rows[:len(shown)]]} if first is not None else {}),
                      **({"more": len(out_rows) - len(shown)} if len(out_rows) > len(shown) else {})},
            "output_label": "New order",
            "note": ("DuckDB packs the ORDER BY columns into one sort key per row, sorts those keys, and puts NULLs "
                     "last; rows that tie can come out in any order."),
        })
    steps.append({
        "stage": "Move every row at once",
        "message": "Then every row moves to its new place at once.",
        "output_highlights": {"columns": [b for b in by if b in out_columns]},
    })
    return steps
