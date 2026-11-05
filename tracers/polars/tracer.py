"""Tracer for polars, by rewriting the cell's code before it runs, like the pandas tracer.

transform() turns `x.method(...)` into `_dstutor_method(x, 'method', line, {keyword: source},
[argument sources])(...)` (tracers/shared/dstutor_rewriting.py, loaded by the runtime before
this module). At run time the helper does exactly what the original code did, and when x is a
DataFrame, a GroupBy of one or a LazyFrame it records the step. Expressions such as
pl.col('Price') > 4 are shown as written. polars has no index, so rows are shown in order, and
values JSON cannot hold are shown the way polars prints them (null, NaN, inf).

Eager steps: filter, with_columns, select, sort, group_by(...) with agg() or a shortcut (sum,
mean, len, ...), join and pivot; and the rest of Data 100's reference sheet that returns a table or
a Series: head, tail, slice and df[...] by position, df['col'] and get_column, drop, rename,
null_count, drop_nulls, fill_null, unique, group_by(...).head/tail, and the Series methods
value_counts, is_in, is_null, sort, unique, fill_null and cast. Lazy: every method called on a LazyFrame is remembered on the
LazyFrame it returns; collect() runs the chain one step at a time to get the table after each
step and records those as steps, then a collect() step with polars' optimized plan.
docs/visualizing-steps.md has the design.

The runtime (@dstutor/runtime-pyodide) loads this file as a module and calls install(),
reset(), get_trace(), is_trace_truncated(), set_cell_statements() and transform(); run(code)
runs code on its own, for tests and use outside the notebook.
"""
import builtins
import datetime
import decimal
import math
import re

from dstutor_rewriting import (
    MAX_GROUP_STEPS, MAX_ROWS_PREVIEW, Log, Rewriter, color_slots, group_stages, join_stages, key_of, table_name,
    display as _display, fmt_list as _fmt_list, fmt_val as _fmt_val, like as _like,
    make_state as _make_state, plural as _plural, truncation_note as _truncation_note,
)

# A lazy chain longer than this is shown as its collect() alone
MAX_LAZY_STEPS = 12

# Rows by position, columns left out or renamed, nulls and repeats: what Data 100's reference
# sheet lists besides the operations above
ROW_AND_COLUMN_METHODS = {'head', 'tail', 'slice', 'drop', 'rename', 'unique', 'null_count', 'drop_nulls',
                          'fill_null'}
DATAFRAME_METHODS = {'filter', 'with_columns', 'select', 'sort', 'join', 'pivot', 'get_column'} | ROW_AND_COLUMN_METHODS
GROUPBY_AGGREGATIONS = {'agg', 'sum', 'mean', 'median', 'min', 'max', 'len', 'count', 'first', 'last',
                        'n_unique', 'std', 'var'}
# group_by(...).head(n) keeps rows rather than combining them
GROUPBY_ROWS = {'head', 'tail'}
SERIES_METHODS = {'value_counts', 'sort', 'unique', 'is_in', 'is_null', 'fill_null', 'cast'}
LAZY_METHODS = ({'filter', 'with_columns', 'select', 'sort', 'join', 'group_by'} | ROW_AND_COLUMN_METHODS
                | GROUPBY_AGGREGATIONS | GROUPBY_ROWS)
REWRITTEN_METHODS = DATAFRAME_METHODS | GROUPBY_AGGREGATIONS | GROUPBY_ROWS | SERIES_METHODS | {'group_by', 'collect'}

_log = Log()
_enabled = False


# ---------------------------------------------------------------------------------------------
# The interface every tracer exposes

def install():
    """Make the rewritten code's helper available and start recording. Idempotent."""
    global _enabled
    builtins._dstutor_method = _method
    builtins._dstutor_getitem = _getitem
    builtins._dstutor_setitem = _setitem
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
    """Statements of the cell being run, as (start_line, end_line, assigned_name_or_None)."""
    _log.set_cell_statements(statements)


def transform(tree):
    """Rewrite a parsed cell so the operations it runs are traced. Returns the new tree."""
    # Subscripts too: df[1:3, ['Flavor', 'Price']] takes rows and columns by position
    return Rewriter(REWRITTEN_METHODS).rewrite(tree)


def run(code):
    """Run code as a fresh notebook cell and return the TraceRecord dicts it produced."""
    import ast
    install()
    reset()
    set_cell_statements([])
    import polars as pl
    exec(compile(transform(ast.parse(code, '<cell>')), '<cell>', 'exec'), {'__name__': '__main__', 'pl': pl})
    return get_trace()


# ---------------------------------------------------------------------------------------------
# The helper the rewritten code calls. It does what the original code did; recording never
# changes the result, and a failure while recording is swallowed so student code still runs.

def _polars():
    import polars as pl
    return pl


def _is_frame(obj):
    return isinstance(obj, _polars().DataFrame)


def _is_lazy(obj):
    pl = _polars()
    return isinstance(obj, pl.LazyFrame) or type(obj).__name__ == 'LazyGroupBy'


def _is_groupby(obj):
    return type(obj).__name__ == 'GroupBy' and _is_frame(getattr(obj, 'df', None))


def _is_series(obj):
    return isinstance(obj, _polars().Series)


def _method(receiver, name, line, sources=None, arg_sources=None, receiver_source=''):
    bound = getattr(receiver, name)
    if not _enabled:
        return bound
    sources, arg_sources = sources or {}, arg_sources or []
    if _is_lazy(receiver):
        return _lazy_method(receiver, name, bound, line, sources, arg_sources)
    if not ((name in DATAFRAME_METHODS and _is_frame(receiver))
            or (name in GROUPBY_AGGREGATIONS | GROUPBY_ROWS and _is_groupby(receiver))
            or (name in SERIES_METHODS and _is_series(receiver))):
        return bound

    def traced(*args, **kwargs):
        input_state = (_state(receiver.df) if _is_groupby(receiver) else
                       _series_state(receiver) if _is_series(receiver) else _state(receiver))
        result = bound(*args, **kwargs)
        try:
            names = {'left': table_name(receiver_source, 'left'),
                     'right': table_name(arg_sources[0] if arg_sources else '', 'right'),
                     'receiver': receiver_source}
            record = _describe(name, receiver, args, kwargs, arg_sources, sources, input_state, result, names)
            # None: nothing to show, as for a head() that keeps every row
            if record is not None:
                record["site"] = _log.site(line)
                _log.add(record)
        except Exception:
            pass
        return result
    return traced


def _getitem(container, key, key_source, line, receiver_source=''):
    result = container[key]
    if not (_enabled and _is_frame(container)):
        return result
    try:
        record = _subscript(container, key, key_source, receiver_source, result)
        if record is not None:
            record["site"] = _log.site(line)
            _log.add(record)
    except Exception:
        pass
    return result


def _setitem(container, key, value, key_source, line, value_source=''):
    # polars has no column assignment to show (with_columns is the way); do exactly what it does
    container[key] = value


# ---------------------------------------------------------------------------------------------
# Lazy queries: remembered as they are built, shown when collect() runs them

def _lazy_method(receiver, name, bound, line, sources, arg_sources):
    if name == 'collect':
        def collect(*args, **kwargs):
            result = bound(*args, **kwargs)
            try:
                _record_lazy(receiver, result, line)
            except Exception:
                pass
            return result
        return collect
    if name not in LAZY_METHODS:
        return bound

    def traced(*args, **kwargs):
        result = bound(*args, **kwargs)
        try:
            # The step this call adds, on the LazyFrame (or LazyGroupBy) it returns
            result._dstutor_root = getattr(receiver, '_dstutor_root', receiver)
            result._dstutor_chain = list(getattr(receiver, '_dstutor_chain', ())) + [
                (name, args, kwargs, arg_sources, sources, line)]
        except Exception:
            pass
        return result
    return traced


def _eager(value):
    """An argument as the eager call needs it: a LazyFrame (the other side of a join) collected."""
    return value.collect() if isinstance(value, _polars().LazyFrame) else value


def _record_lazy(lazy, result, line):
    root = getattr(lazy, '_dstutor_root', None)
    chain = list(getattr(lazy, '_dstutor_chain', ()))
    # A LazyFrame made directly (pl.LazyFrame(...)) has no steps to show; its table is the result
    start = root.collect() if root is not None else result
    written = ran = ''
    try:
        written, ran = lazy.explain(optimized=False), lazy.explain()
    except Exception:
        pass
    shown = 0
    if root is not None and 0 < len(chain) <= MAX_LAZY_STEPS:
        current = start
        i = 0
        while i < len(chain):
            name, args, kwargs, arg_sources, sources, step_line = chain[i]
            try:
                args = [_eager(a) for a in args]
                kwargs = {k: _eager(v) for k, v in kwargs.items()}
                if (name == 'group_by' and i + 1 < len(chain)
                        and chain[i + 1][0] in GROUPBY_AGGREGATIONS | GROUPBY_ROWS):
                    # group_by(...).agg(...) is one step, as it is when eager
                    agg, agg_args, agg_kwargs, agg_arg_sources, agg_sources, step_line = chain[i + 1]
                    receiver = current.group_by(*args, **kwargs)
                    output = getattr(receiver, agg)(*agg_args, **agg_kwargs)
                    record = _describe(agg, receiver, agg_args, agg_kwargs, agg_arg_sources, agg_sources,
                                       _state(current), output)
                    i += 2
                elif name in DATAFRAME_METHODS:
                    output = getattr(current, name)(*args, **kwargs)
                    record = _describe(name, current, args, kwargs, arg_sources, sources, _state(current), output)
                    i += 1
                else:
                    break
            except Exception:
                break
            if record is None:
                # A step that changed nothing (a head() that keeps every row)
                current = output
                continue
            record["explanation"] += " (Worked out when collect() ran.)"
            record["site"] = _log.site(step_line)
            _log.add(record)
            current = output
            shown += 1
    steps_text = f"the {_plural(shown, 'step')} above" if shown else "the whole query"
    as_written, as_run = _plan_steps(written), _plan_steps(ran)
    changes = []
    if len(as_run) < len(as_written):
        changes.append("it dropped steps nothing needed")
    if '*/' in written and 'PROJECT[' in ran:
        changes.append("it reads only the columns the query uses")
    if any(st['name'] == 'FILTER' for st in as_run) and [st['name'] for st in as_run].index('FILTER') < \
            next((k for k, st in enumerate(as_written) if st['name'] == 'FILTER'), 0):
        changes.append("it moved the filter earlier")
    message = (f"A LazyFrame only records a plan. collect() hands it to polars, which optimizes it and runs "
               f"{steps_text} in one go; the tables in between existed only while it ran."
               + (" Optimizing changed the plan: " + "; ".join(changes) + "." if changes else ""))
    sub = {"stage": "How polars runs it", "message": message}
    if as_written and as_run:
        sub["panel"] = {"kind": "plan", "plans": [{"title": "As written", "steps": as_written},
                                                   {"title": "As polars runs it", "steps": as_run}]}
        sub["output_label"] = "The plan"
    _log.add({
        "operation": 'collect',
        "args": [],
        "kwargs": {},
        "input": _state(start),
        "output": _state(result),
        "explanation": f"Ran the lazy query: {_plural(result.height, 'row')}.",
        "sub_steps": [sub],
        "site": _log.site(line),
    })


def _plan_steps(text):
    """A polars plan (explain()) as steps from first to last: polars prints it last step first."""
    steps = []
    for line in text.splitlines():
        t = line.strip()
        if not t or t == 'FROM':
            continue
        node = re.match(r'^([A-Z][A-Z_]*(?: BY)?)\b:?\s*(.*)$', t)
        if node:
            steps.append({"name": node.group(1), **({"detail": node.group(2)} if node.group(2) else {})})
        elif steps:
            # A line that belongs to the step above it, like AGGREGATE's [col(...)] BY [col(...)]
            steps[-1]["detail"] = (steps[-1].get("detail", "") + " " + t).strip()
    return list(reversed(steps))


# ---------------------------------------------------------------------------------------------
# Tables

def _cell(value):
    """A table value as JSON. null, NaN and the infinities have no JSON of their own, so they are
    sent as {"shown": text}: the text polars prints for them, which the table shows as is."""
    if value is None:
        return {"shown": "null"}
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return {"shown": "NaN"}
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
        return '{' + ','.join(_fmt_val(_cell(v)) for v in value.values()) + '}'
    return str(value)


def _state(df):
    """A DataFrame as a TableState: its columns and the first rows."""
    try:
        head = df.head(MAX_ROWS_PREVIEW)
        return {
            "num_rows": df.height,
            "num_columns": df.width,
            "columns": list(df.columns),
            "preview": [[_cell(v) for v in row] for row in head.rows()],
            "column_types": _types(df),
        }
    except Exception as e:
        return {"error": str(e), "num_rows": 0, "num_columns": 0, "columns": [], "preview": []}


def _series_state(s):
    """A Series as a one-column TableState: polars prints it as a column with its name and type."""
    try:
        return {
            "num_rows": s.len(),
            "num_columns": 1,
            "columns": [s.name],
            "preview": [[_cell(v)] for v in s.head(MAX_ROWS_PREVIEW).to_list()],
            "column_types": [_type_name(s.dtype)],
        }
    except Exception as e:
        return {"error": str(e), "num_rows": 0, "num_columns": 0, "columns": [], "preview": []}


def _any_state(value):
    return _series_state(value) if _is_series(value) else _state(value)


def _types(df):
    """Each column's type the way polars prints it under the column name: str, f64, list[f64]."""
    return [_type_name(t) for t in df.dtypes]


def _type_name(dtype):
    try:
        return dtype._string_repr()
    except Exception:
        return str(dtype).lower()


def _expr_name(expr):
    """The column an expression produces (pl.col('Price') * 2 makes 'Price'), or None."""
    if isinstance(expr, str):
        return expr
    try:
        return expr.meta.output_name()
    except Exception:
        return getattr(expr, 'name', None)


def _roots(expr, columns):
    """The input columns an expression reads, in the table's order."""
    try:
        names = set(expr.meta.root_names())
    except Exception:
        names = {expr} if isinstance(expr, str) else set()
    return [c for c in columns if c in names]


def _flatten(args, arg_sources):
    """Arguments given as a list (select([a, b])) count as if given one by one."""
    out = []
    for i, arg in enumerate(args):
        source = arg_sources[i] if i < len(arg_sources) else ''
        if isinstance(arg, (list, tuple)) and not (arg and isinstance(arg[0], bool)):
            out.extend((a, _expr_name(a) or '') for a in arg)
        else:
            out.append((arg, source))
    return out


def _named(args, kwargs, arg_sources, sources):
    """(output column, source text, expression) for each expression given positionally or by name."""
    pl = _polars()
    out = [(_expr_name(a), s or _expr_name(a) or '', a) for a, s in _flatten(args, arg_sources)]
    for name, value in kwargs.items():
        expr = value if isinstance(value, pl.Expr) else pl.lit(value)
        out.append((name, sources.get(name) or repr(value), expr))
    return out


def _record(operation, args, kwargs, arg_sources, sources, input_state, output, explanation, steps, label=None):
    record = {
        "operation": operation,
        "args": list(arg_sources[:len(args)]) or [_fmt_val(a) for a in args if isinstance(a, (str, int, float))],
        "kwargs": {k: sources.get(k) or _fmt_val(v) if isinstance(v, (str, int, float, bool)) else sources.get(k, '')
                   for k, v in kwargs.items()},
        "input": input_state,
        "output": _any_state(output),
        "explanation": explanation,
        "sub_steps": steps,
    }
    if label:
        record["label"] = label
    return record


def _describe(name, receiver, args, kwargs, arg_sources, sources, input_state, output, names=None):
    """The record for one call (without its site), walkthrough included when there is one; None
    when the call changed nothing worth a step."""
    if _is_groupby(receiver):
        if name in GROUPBY_ROWS:
            return _group_rows(receiver, name, args, kwargs, arg_sources, sources, input_state, output)
        return _group_by(receiver, name, args, kwargs, arg_sources, sources, input_state, output)
    if _is_series(receiver):
        return _series_step(name, receiver, args, kwargs, arg_sources, sources, input_state, output,
                            (names or {}).get('receiver', ''))
    if name == 'join':
        names = names or {'left': 'left', 'right': table_name(arg_sources[0] if arg_sources else '', 'right')}
        return _join(receiver, args, kwargs, arg_sources, sources, input_state, output, names)
    if name in ('head', 'tail', 'slice'):
        return _by_position(name, receiver, args, kwargs, arg_sources, sources, input_state, output)
    walk = {'filter': _filter, 'with_columns': _with_columns, 'select': _select, 'sort': _sort,
            'pivot': _pivot, 'drop': _drop, 'rename': _rename, 'unique': _unique, 'null_count': _null_count,
            'drop_nulls': _drop_nulls, 'fill_null': _fill_null, 'get_column': _get_column}[name]
    return walk(receiver, args, kwargs, arg_sources, sources, input_state, output)


# ---------------------------------------------------------------------------------------------
# Walkthroughs, one per operation. Each works on the preview and counts the whole table.

def _filter(df, args, kwargs, arg_sources, sources, input_state, output):
    pl = _polars()
    predicates = _flatten(args, arg_sources)
    texts = [s for _, s in predicates] + [f"pl.col({k!r}) == {sources.get(k) or repr(v)}" for k, v in kwargs.items()]
    condition = texts[0] if len(texts) == 1 else ' & '.join(f'({t})' for t in texts)
    n_kept, n_removed = output.height, df.height - output.height
    explanation = f"Filtered rows. Kept {n_kept}, removed {n_removed}."
    exprs = [p if isinstance(p, pl.Expr) else pl.lit(pl.Series(list(p))) for p, _ in predicates]
    exprs += [pl.col(k) == v for k, v in kwargs.items()]
    mask_expr = exprs[0] if len(exprs) == 1 else pl.all_horizontal(exprs)
    mask = df.select(mask_expr.alias('__dstutor_mask'))['__dstutor_mask'].to_list()
    steps = None
    if sum(1 for m in mask if m is True) == n_kept:
        n_preview = len(input_state["preview"])
        kept = [i for i in range(n_preview) if mask[i] is True]
        removed = [i for i in range(n_preview) if mask[i] is not True]
        used = sorted({c for e in exprs for c in _roots(e, df.columns)}, key=df.columns.index)
        shown = [df.columns.index(c) for c in used] or list(range(min(df.width, 2)))
        columns = [df.columns[c] for c in shown] + [condition]
        types = [input_state["column_types"][c] for c in shown] + ['bool']
        rows = [[row[c] for c in shown] + [_cell(mask[i])] for i, row in enumerate(input_state["preview"])]
        nulls = any(m is None for m in mask)
        steps = [
            {
                "stage": "Ask every row",
                "message": "First the condition is worked out for every row at once, giving a column of True and False.",
                "detail": f"Condition: {condition}",
                "input_highlights": {"columns": used},
                "output_state": {**_make_state(columns, rows, column_types=types), "num_rows": input_state["num_rows"]},
                "output_label": "True or False for each row",
                "output_highlights": {"columns": [condition]},
            },
            {
                "stage": "Keep the True rows",
                "message": (f"Keep the rows where it is True: {n_kept} kept, {n_removed} (struck through) removed."
                            + (" A null counts as not True, so its row is removed too." if nulls else "")
                            + _truncation_note(input_state)),
                "input_highlights": {"rows": kept, "rows_removed": removed, "columns": used},
            },
        ]
    return _record('filter', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _with_columns(df, args, kwargs, arg_sources, sources, input_state, output):
    named = [n for n in _named(args, kwargs, arg_sources, sources) if n[0]]
    added = [n for n, _, _ in named if n not in df.columns]
    replaced = [n for n, _, _ in named if n in df.columns]
    parts = []
    if added:
        parts.append(f"Added {'column' if len(added) == 1 else 'columns'} {', '.join(map(repr, added))}")
    if replaced:
        parts.append(f"Replaced {'column' if len(replaced) == 1 else 'columns'} {', '.join(map(repr, replaced))}")
    explanation = ('; '.join(parts) or 'Computed columns') + '.'
    if output.height != df.height or not named:
        return _record('with_columns', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    out_state = _state(output)
    before = {c: [row[i] for row in input_state["preview"]] for i, c in enumerate(df.columns)}
    after = {c: [row[i] for row in out_state["preview"]] for i, c in enumerate(output.columns)}
    in_types, out_types = dict(zip(df.columns, _types(df))), dict(zip(output.columns, _types(output)))

    def partial(done):
        # The input's columns, with the expressions worked out so far
        cols = [c for c in output.columns if c in df.columns or c in done]
        rows = [[(after[c] if c in done else before[c])[r] for c in cols] for r in range(len(out_state["preview"]))]
        types = [(out_types[c] if c in done else in_types[c]) for c in cols]
        return {**_make_state(cols, rows, column_types=types), "num_rows": output.height}

    steps = []
    shown = named if len(named) <= MAX_GROUP_STEPS + 1 else named[:MAX_GROUP_STEPS]
    done = []
    for name, text, expr in shown:
        done.append(name)
        text = _without_alias(text, name)
        steps.append({
            "stage": "Work out the columns",
            "message": f"{name} = {text}" if text and text != name else f"The column {name!r}, worked out for every row.",
            "detail": "polars works the expression out for the whole column at once.",
            "input_highlights": {"columns": _roots(expr, df.columns)},
            "output_state": partial(done),
            "output_highlights": {"columns": [name]},
        })
    if len(shown) < len(named):
        steps.append({"stage": "Work out the columns", "message": f"…and {_plural(len(named) - len(shown), 'more column')} the same way.",
                      "output_state": partial([n for n, _, _ in named])})
    if len(named) > 1:
        steps[0]["note"] = ("with_columns works every expression out from the same input table, all at once, so "
                            "one cannot use a column made in the same call (pandas' assign can).")
    steps.append({
        "stage": "Result",
        "message": f"Every row is kept. with_columns returns a new DataFrame; {df.width} columns became {output.width}.",
        "output_highlights": {"columns": [n for n, _, _ in named]},
    })
    return _record('with_columns', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _without_alias(text, name):
    """(pl.col('Price') * 0.9).alias('Sale') reads better as Sale = pl.col('Price') * 0.9."""
    for quote in ("'", '"'):
        suffix = f".alias({quote}{name}{quote})"
        if text.endswith(suffix):
            text = text[:-len(suffix)]
            if text.startswith('(') and text.endswith(')'):
                inner = text[1:-1]
                depth = 0
                for ch in inner:
                    depth += {'(': 1, ')': -1}.get(ch, 0)
                    if depth < 0:
                        break
                else:
                    text = inner
    return text


def _select(df, args, kwargs, arg_sources, sources, input_state, output):
    named = _named(args, kwargs, arg_sources, sources)
    used = sorted({c for _, _, e in named for c in _roots(e, df.columns)}, key=df.columns.index)
    explanation = f"Selected {_plural(output.width, 'column')}."
    texts = ', '.join(t for _, t, _ in named if t)
    computed = [n for n, t, _ in named if n and t not in (n, f"pl.col({n!r})", f'pl.col("{n}")', repr(n))]
    steps = [
        {
            "stage": "Work out the columns",
            "message": (f"select builds a new table from {_plural(len(named), 'expression')}: {texts}."
                        + (" Columns named on their own are kept as they are; the others are worked out for the whole column."
                           if computed else "")),
            "input_highlights": {"columns": used},
            "output_state": _state(output),
            "output_label": "Result (building…)",
            "output_highlights": {"columns": [c for c in output.columns if c in computed]},
        },
        {
            "stage": "Result",
            "message": (f"Only the selected columns are left, and every row is kept."
                        if output.height == df.height else
                        f"The expressions combine rows, so the result has {_plural(output.height, 'row')}."),
        },
    ]
    return _record('select', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _sort(df, args, kwargs, arg_sources, sources, input_state, output):
    by = [_expr_name(b) for b, _ in _flatten(args, arg_sources)]
    if 'by' in kwargs:
        by = [_expr_name(b) for b in (kwargs['by'] if isinstance(kwargs['by'], (list, tuple)) else [kwargs['by']])]
    by = [b for b in by if b in df.columns]
    descending = kwargs.get('descending', False)
    direction = ("largest first" if descending is True else "smallest first" if not descending
                 else "in the directions given")
    named = ', '.join(map(repr, by)) or 'the expressions given'
    explanation = f"Sorted {_plural(df.height, 'row')} by {named}, {direction}."
    # Where each row came from: the same sort, with each row's original position along for the ride
    try:
        ordered = df.with_row_index('__dstutor_row').sort(*args, **kwargs)
        positions = ordered['__dstutor_row'].to_list() if ordered.drop('__dstutor_row').equals(output) else None
    except Exception:
        positions = None
    tie = f" Rows with the same {by[0]!r} are ordered by {', '.join(map(repr, by[1:]))}." if len(by) > 1 else ""
    out_state = _state(output)
    steps = [{
        "stage": "Read the sort key",
        "message": f"sort orders the rows by {named}, {direction}.{tie} No rows are added or removed.",
        "input_highlights": {"columns": by},
        "output_state": _like(out_state, []),
    }]
    if positions is not None:
        shown = positions[:len(out_state["preview"])]
        ties = []
        if by:
            first = output[by[0]].to_list()[:len(shown)]
            start = 0
            for i in range(1, len(first) + 1):
                if i == len(first) or first[i] != first[start]:
                    if i - start > 1:
                        ties.append([start, i - 1])
                    start = i
        stable = len(by) <= 1 or kwargs.get('maintain_order')
        steps.append({
            "stage": "Work out the new order",
            "message": "First polars works out the new order: the position each row comes from, counting from 0.",
            "detail": f"New order of positions: {_fmt_list(shown)}",
            "input_highlights": {"columns": by},
            "panel": {"kind": "order", "from": shown, **({"ties": ties} if ties else {}),
                      **({"values": [_cell(v) for v in output[by[0]].to_list()[:len(shown)]]} if by else {}),
                      **({"more": output.height - len(shown)} if output.height > len(shown) else {})},
            "output_label": "New order",
            "note": ("polars sorts the row positions by the key "
                     + ("(a stable sort, so rows that tie keep their order)" if stable else
                        "(rows that tie may swap places unless maintain_order=True)")
                     + ", puts nulls first unless nulls_last=True, then gathers every row in one go."),
        })
    steps.append({
        "stage": "Move every row at once",
        "message": "Then every row moves to its new place at once. polars has no index, so a row's position is its only label.",
        "output_highlights": {"columns": by},
    })
    return _record('sort', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _agg_items(groupby, name, args, kwargs, arg_sources, sources, keys):
    """(output column, input column whose values are combined or None, how) for each aggregation."""
    columns = groupby.df.columns
    if name == 'agg':
        items = []
        for out, text, expr in _named(args, kwargs, arg_sources, sources):
            roots = _roots(expr, columns)
            items.append((out, roots[0] if len(roots) == 1 else None, text))
        return items
    if name in ('len',):
        return [('len', None, 'len()')]
    return [(c, c, f"{name}()") for c in columns if c not in keys]


def _group_by(groupby, name, args, kwargs, arg_sources, sources, input_state, output):
    df = groupby.df
    by = list(groupby.by) + list(getattr(groupby, 'named_by', {}) or {})
    keys = [_expr_name(b) if not isinstance(b, str) else b for b in by]
    named_keys = ', '.join(map(repr, keys))
    label = f"group_by().{name}()"
    n_groups = output.height
    explanation = f"Grouped by {named_keys} into {_plural(n_groups, 'group')} and combined each with {name}()."
    if getattr(groupby, 'named_by', None) or not keys or not all(k in df.columns for k in keys):
        return _record('group_by', args, kwargs, arg_sources, sources, input_state, output, explanation, None, label)
    items = _agg_items(groupby, name, args, kwargs, arg_sources, sources, keys)
    out_state = _state(output)
    out_cols = output.columns
    key_rows = df.select(keys).rows()
    out_keys = output.select(keys).rows()
    sources_of = {out: (src, text) for out, src, text in items if out in out_cols}

    def fn_of(text):
        # pl.col('Price').mean() -> mean; len() -> len
        match = re.search(r'\.?(\w+)\(\)\s*$', _without_alias(text or '', '') or '')
        return match.group(1) if match else name
    groups = []
    for gi, row in enumerate(out_state["preview"]):
        members = [i for i, k in enumerate(key_rows) if k == out_keys[gi]]
        values = []
        for c, value in zip(out_cols, row):
            if c in keys:
                continue
            src, text = sources_of.get(c, (None, name))
            values.append({"column": c, "values": [_cell(v) for v in df[src].gather(members).to_list()] if src else [],
                           "result": value, "fn": fn_of(text)})
        groups.append({"key": [row[out_cols.index(k)] for k in keys], "members": members, "size": len(members),
                       "values": values})
    note = ("polars keeps a hash table from each key to the list of its rows' positions, then runs the "
            "aggregation on each group's list, many groups at once.")
    order = ("Groups come out in the order each first appears (maintain_order=True)." if groupby.maintain_order else
             "Without maintain_order=True, polars returns the groups in no particular order, and it can change from run to run.")
    steps = group_stages(key_names=keys, groups=groups, input_state=input_state, out_state=out_state,
                         key_columns=keys, value_columns=[src for src, _ in sources_of.values() if src],
                         note=note, order_note=order)
    return _record('group_by', args, kwargs, arg_sources, sources, input_state, output, explanation, steps, label)


def _key_name(value):
    if isinstance(value, (list, tuple)):
        return [_expr_name(v) for v in value]
    return [_expr_name(value)] if value is not None else []


def _join(df, args, kwargs, arg_sources, sources, input_state, output, names):
    other = args[0] if args else kwargs.get('other')
    how = kwargs.get('how', args[2] if len(args) > 2 else 'inner')
    on = kwargs.get('on', args[1] if len(args) > 1 else None)
    left_keys = _key_name(kwargs.get('left_on', on))
    right_keys = _key_name(kwargs.get('right_on', on))
    explanation = f"Joined ({how}): {_plural(output.height, 'row')}."
    if how == 'cross' and _is_frame(other):
        left, right = names.get('left', 'left'), names.get('right', 'right')
        steps = [{
            "stage": "Pair every row with every row",
            "message": (f"A cross join has no key: each of the {_plural(df.height, 'row')} of {left} pairs with each of "
                        f"the {_plural(other.height, 'row')} of {right}, so {df.height} × {other.height} = "
                        f"{_plural(output.height, 'row')}."),
            "aux_table": {"label": right, "state": _state(other)},
        }]
        explanation = f"Cross join: {df.height} × {other.height} = {_plural(output.height, 'row')}."
        return _record('join', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)
    if (not _is_frame(other) or len(left_keys) != 1 or len(right_keys) != 1
            or left_keys[0] not in df.columns or right_keys[0] not in other.columns
            or how not in ('inner', 'left', 'right', 'full', 'semi', 'anti')):
        return _record('join', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    lk, rk = left_keys[0], right_keys[0]
    key_desc = lk if lk == rk else f"{lk} = {rk}"
    explanation = f"Joined ({how}) on {key_desc!r}: {_plural(output.height, 'row')}."
    out_state = _state(output)
    out_cols = output.columns
    key_cols = [c for c in (lk, rk if rk != lk else None, f"{rk}_right") if c and c in out_cols]

    def row_key(row):
        for c in key_cols:
            value = row[out_cols.index(c)]
            if value is not None:
                return value
        return None
    out_keys = [row_key(r) for r in output.head(MAX_ROWS_PREVIEW).rows()]
    keeps = {'inner': ['both'], 'left': ['left_only', 'both'], 'right': ['both', 'right_only'],
             'full': ['left_only', 'both', 'right_only'], 'semi': ['both'], 'anti': ['left_only']}[how]
    nulls = bool(kwargs.get('nulls_equal', kwargs.get('join_nulls', False)))
    steps = join_stages(
        left_keys=df[lk].to_list(), right_keys=other[rk].to_list(), null_matches=nulls, keeps=keeps,
        mode=how if how in ('semi', 'anti') else 'pairs',
        left_name=names.get('left', 'left'), right_name=names.get('right', 'right'), key_desc=key_desc,
        left_state=input_state, right_state=_state(other), left_col=lk, right_col=rk,
        out_state=out_state, out_keys=out_keys, missing='null',
        note=("polars builds a hash table from the smaller table (each key to the positions of its rows), "
              "then looks up every row of the other table in it" + ("" if nulls else "; null keys never match") + "."),
        order_note=("" if kwargs.get('maintain_order') not in (None, 'none') else
                    "polars promises no row order unless you pass maintain_order."),
        cell=_cell)
    return _record('join', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _pivot(df, args, kwargs, arg_sources, sources, input_state, output):
    def one(value):
        names = _key_name(value)
        return names[0] if len(names) == 1 else None
    on = one(kwargs.get('on', args[0] if args else None))
    index = one(kwargs.get('index'))
    values = one(kwargs.get('values'))
    agg = kwargs.get('aggregate_function')
    agg_name = agg if isinstance(agg, str) else 'first' if agg is None else 'the expression given'
    explanation = f"Pivoted into {_plural(output.height, 'row')} × {_plural(output.width - 1, 'column')} of values."
    if not (on and index and values) or not all(c in df.columns for c in (on, index, values)):
        return _record('pivot', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    out_state = _state(output)
    out_cols = output.columns
    row_keys = output[index].to_list()[:len(out_state["preview"])]
    col_names = [c for c in out_cols if c != index]
    grid = [[row[0]] + [[] for _ in col_names] for row in out_state["preview"]]
    value_type = dict(zip(df.columns, _types(df)))[values] if values in df.columns else 'null'
    grid_types = [out_state["column_types"][0]] + [f"list[{value_type}]"] * len(col_names)
    steps = [{
        "stage": "Lay out the grid",
        "message": (f"pivot builds a grid: each unique {index!r} becomes a row and each unique {on!r} becomes "
                    f"a column. Every cell starts empty."),
        "detail": f"Rows: {_fmt_list([_cell(k) for k in row_keys])}   Columns: {_fmt_list(col_names)}",
        "input_highlights": {"columns": [index, on]},
        "output_state": _like(out_state, [list(r) for r in grid], grid_types),
    }]
    rows_data, cols_data, vals_data = df[index].to_list(), df[on].to_list(), df[values].to_list()

    def place(i):
        name = str(cols_data[i])
        if rows_data[i] not in row_keys or name not in col_names:
            return None
        r, c = row_keys.index(rows_data[i]), col_names.index(name)
        grid[r][1 + c] = grid[r][1 + c] + [_cell(vals_data[i])]
        return r, name
    # Every row's value lands in its cell at once: each cell gathers the values of its group
    for i in range(df.height):
        place(i)
    steps.append({
        "stage": "Gather each cell's values",
        "message": f"Every row's {values!r} goes into the cell for its {index!r} and {on!r}.",
        "input_highlights": {"columns": [index, on, values]},
        "output_state": _like(out_state, [list(r) for r in grid], grid_types),
        "note": ("polars groups the rows by the row and column keys, combines each group, and places the "
                 "results in a grid; rows and columns come out in the order they first appear (pandas sorts them)."),
    })
    example = next(((cell, out_state["preview"][r][1 + c]) for r, row in enumerate(grid)
                    for c, cell in enumerate(row[1:]) if cell), None)
    step = {"stage": "Combine each cell", "message": f"Then {agg_name} combines each cell's list into one value."}
    if example:
        step["detail"] = f"{agg_name}({_fmt_val(example[0])}) = {_fmt_val(_display(example[1]))}"
    steps.append(step)
    empty = [[r, col_names[c]] for r, row in enumerate(grid) for c, cell in enumerate(row[1:]) if not cell]
    if empty:
        steps.append({
            "stage": "Empty cells",
            "message": "Cells that no row fell into have nothing to combine, so polars leaves them null.",
            "output_highlights": {"cells": empty},
        })
    return _record('pivot', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


# ---------------------------------------------------------------------------------------------
# Rows by position, columns left out or renamed, nulls and repeats, and Series: the rest of what
# Data 100's reference sheet lists. Each is a frame or two: they choose rows and columns, or
# fill and count, rather than work values out.

NULL = {"shown": "null"}


def _call(name, args, kwargs, arg_sources, sources):
    """The call as written: head(3), unique(subset='Flavor')."""
    parts = [arg_sources[i] if i < len(arg_sources) and arg_sources[i] else _fmt_val(a) for i, a in enumerate(args)]
    parts += [f"{k}={sources.get(k) or _fmt_val(v)}" for k, v in kwargs.items()]
    return f"{name}({', '.join(parts)})"


def _positions(df, take):
    """The input positions of the rows take() keeps, in the order it returns them, or None."""
    try:
        return take(df.with_row_index('__dstutor_row'))['__dstutor_row'].to_list()
    except Exception:
        return None


def _positions_text(positions):
    if not positions:
        return "no rows"
    if len(positions) == 1:
        return f"the row at position {positions[0]}"
    if positions == list(range(positions[0], positions[0] + len(positions))):
        return f"the rows at positions {positions[0]} to {positions[-1]}"
    return f"the rows at positions {_fmt_list(positions)}"


def _names_text(names, word='column'):
    quoted = [repr(n) for n in names]
    joined = quoted[0] if len(quoted) == 1 else ', '.join(quoted[:-1]) + ' and ' + quoted[-1]
    return f"the {word}{'' if len(names) == 1 else 's'} {joined}"


def _row_highlights(input_state, kept):
    n_preview = len(input_state["preview"])
    kept = set(kept)
    return {"rows": [i for i in range(n_preview) if i in kept],
            "rows_removed": [i for i in range(n_preview) if i not in kept]}


def _by_position(name, df, args, kwargs, arg_sources, sources, input_state, output):
    """head(n), tail(n), slice(offset, length): the rows kept by their position."""
    if output.height == df.height:
        # Every row kept: nothing happened, just as showing the table is not a step
        return None
    left_out = df.height - output.height
    n = output.height
    what = (_plural(n, 'row') if name == 'slice' else
            f"the {'first' if name == 'head' else 'last'} {'row' if n == 1 else _plural(n, 'row')}")
    explanation = f"Kept {what}; left out {left_out}."
    kept = _positions(df, lambda d: getattr(d, name)(*args, **kwargs))
    if kept is None:
        return _record(name, args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    steps = [{
        "stage": "Take rows by position",
        "message": (f"{_call(name, args, kwargs, arg_sources, sources)} keeps {what}: {_positions_text(kept)}, "
                    f"counting from 0. The other {_plural(left_out, 'row')} (struck through) "
                    f"{'is' if left_out == 1 else 'are'} left out."
                    + _truncation_note(input_state)),
        "input_highlights": _row_highlights(input_state, kept),
    }]
    return _record(name, args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _all_rows(rows_key):
    return rows_key is None or (isinstance(rows_key, slice) and rows_key == slice(None))


def _names_columns(key):
    return isinstance(key, str) or (isinstance(key, (list, tuple)) and bool(key) and all(isinstance(k, str) for k in key))


def _subscript(df, key, key_source, receiver_source, result):
    """df[...]: one column as a Series, or rows and columns by position. A single value is no step."""
    if not (_is_frame(result) or _is_series(result)):
        return None
    label = f"{receiver_source}[{key_source}]" if receiver_source.isidentifier() else f"[{key_source}]"
    input_state = _state(df)
    if isinstance(key, tuple) and len(key) == 2 and not _names_columns(key):
        rows_key, cols_key = key
    elif _names_columns(key):
        rows_key, cols_key = None, key
    else:
        rows_key, cols_key = key, None
    if _is_series(result) and isinstance(cols_key, str) and _all_rows(rows_key):
        return _take_column(df, result.name, label, input_state, result, operation='[]')
    columns = list(result.columns) if _is_frame(result) else [result.name]
    chosen = columns if columns != list(df.columns) else []
    kept = None if _all_rows(rows_key) else _positions(df, lambda d: d[rows_key])
    if not _all_rows(rows_key) and kept is None:
        return None
    n_rows = result.height if _is_frame(result) else result.len()
    parts = []
    if kept is not None:
        parts.append(f"{_positions_text(kept)} (counting from 0)")
    if chosen:
        parts.append(_names_text(chosen))
    if not parts:
        return None
    message = f"{label} takes {' and '.join(parts)}."
    if isinstance(rows_key, slice) and rows_key.stop is not None:
        message += " As in a Python slice, the row at the end position is left out."
    if kept is not None and not chosen:
        left_out = df.height - n_rows
        message += (f" Every column is kept; the other {_plural(left_out, 'row')} (struck through) "
                    f"{'is' if left_out == 1 else 'are'} left out.")
    elif chosen and kept is None:
        message += " Every row is kept."
    highlights = _row_highlights(input_state, kept) if kept is not None else {}
    if chosen:
        highlights["columns"] = chosen
    stage = ("Take rows and columns" if kept is not None and chosen else
             "Take rows by position" if kept is not None else "Take columns")
    steps = [{"stage": stage, "message": message + _truncation_note(input_state), "input_highlights": highlights}]
    explanation = f"Took {_plural(n_rows, 'row')} and {_plural(len(columns), 'column')}."
    record = _record('[]', [], {}, [], {}, input_state, result, explanation, steps, label=label)
    record["args"] = [key_source]
    return record


def _take_column(df, column, label, input_state, result, operation):
    steps = [{
        "stage": "Take one column",
        "message": (f"{label} is the column {column!r} on its own: a Series of {_plural(result.len(), 'value')}. "
                    "A DataFrame is a table of Series, one per column."),
        "input_highlights": {"columns": [column]},
        "output_label": "Series",
    }]
    explanation = f"Took the column {column!r} as a Series."
    return _record(operation, [], {}, [], {}, input_state, result, explanation, steps, label=label)


def _get_column(df, args, kwargs, arg_sources, sources, input_state, output):
    column = output.name
    record = _take_column(df, column, _call('get_column', args, kwargs, arg_sources, sources), input_state, output,
                          operation='get_column')
    record.pop("label", None)
    return record


def _drop(df, args, kwargs, arg_sources, sources, input_state, output):
    dropped = [c for c in df.columns if c not in output.columns]
    if not dropped:
        return None
    explanation = f"Dropped {_plural(len(dropped), 'column')}."
    steps = [{
        "stage": "Leave columns out",
        "message": (f"drop leaves out {_names_text(dropped)}. The other {_plural(output.width, 'column')} "
                    f"and all {_plural(df.height, 'row')} stay as they are."),
        "input_highlights": {"columns": dropped},
    }]
    return _record('drop', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _rename(df, args, kwargs, arg_sources, sources, input_state, output):
    pairs = [(a, b) for a, b in zip(df.columns, output.columns) if a != b]
    if not pairs:
        return None
    changes = ', '.join(f"{a!r} → {b!r}" for a, b in pairs)
    explanation = f"Renamed {_plural(len(pairs), 'column')}: {changes}."
    steps = [{
        "stage": "Rename columns",
        "message": f"rename changes {'a name' if len(pairs) == 1 else 'names'}: {changes}. The values and the rows stay as they are.",
        "input_highlights": {"columns": [a for a, _ in pairs]},
        "output_highlights": {"columns": [b for _, b in pairs]},
    }]
    return _record('rename', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _null_cells(state, columns=None):
    """[row, column] of each null in the preview (NaN is a float value, not null)."""
    return [[r, c] for r, row in enumerate(state["preview"]) for c, v in zip(state["columns"], row)
            if v == NULL and (columns is None or c in columns)]


def _nan_note(state):
    has_nan = any(v == {"shown": "NaN"} for row in state["preview"] for v in row)
    return " NaN is a number (not a number, from a calculation), not a missing value, so it is not a null." if has_nan else ""


def _find_nulls(state, columns=None, prefix=""):
    cells = _null_cells(state, columns)
    where = f" in {_names_text(columns)}" if columns and len(columns) < len(state["columns"]) else ""
    return {
        "stage": "Find the nulls",
        "message": (prefix + f"First every value{where} is checked for null, the missing-value marker: "
                    f"{_plural(len(cells), 'null')} in the rows shown." + _nan_note(state) + _truncation_note(state)),
        "input_highlights": {"cells": cells, **({"columns": list(columns)} if where else {})},
    }


def _null_count(df, args, kwargs, arg_sources, sources, input_state, output):
    counts = list(output.row(0)) if output.height else []
    total = sum(counts)
    explanation = f"Counted the nulls in each column: {_plural(total, 'null')} in all."
    per_column = ', '.join(f"{c} {n}" for c, n in zip(output.columns, counts))
    steps = [
        _find_nulls(input_state),
        {
            "stage": "Count each column",
            "message": f"Then they are counted column by column, giving a one-row table: {per_column}.",
            "output_highlights": {"columns": [c for c, n in zip(output.columns, counts) if n]},
        },
    ]
    return _record('null_count', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _subset(df, args, kwargs):
    subset = kwargs.get('subset', args[0] if args else None)
    if subset is None:
        return list(df.columns)
    names = [subset] if isinstance(subset, str) else list(subset) if isinstance(subset, (list, tuple)) else None
    return names if names and all(isinstance(n, str) and n in df.columns for n in names) else None


def _drop_nulls(df, args, kwargs, arg_sources, sources, input_state, output):
    pl = _polars()
    removed = df.height - output.height
    explanation = f"Dropped {_plural(removed, 'row')} with a null; kept {output.height}."
    columns = _subset(df, args, kwargs)
    if columns is None:
        return _record('drop_nulls', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    has_null = df.select(pl.any_horizontal([pl.col(c).is_null() for c in columns]).alias('__dstutor_null'))[
        '__dstutor_null'].to_list()
    if sum(has_null) != removed:
        return _record('drop_nulls', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    kept = [i for i, n in enumerate(has_null) if not n]
    cells = _null_cells(input_state, columns)
    steps = [
        _find_nulls(input_state, columns),
        {
            "stage": "Drop rows with a null",
            "message": (f"Then every row with a null{'' if len(columns) == df.width else ' there'} is dropped: "
                        f"{output.height} kept, {removed} (struck through) dropped." + _truncation_note(input_state)),
            "input_highlights": {**_row_highlights(input_state, kept), "cells": cells},
        },
    ]
    return _record('drop_nulls', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


FILL_STRATEGIES = {'forward': "the nearest value above it", 'backward': "the nearest value below it",
                   'mean': "its column's mean", 'min': "its column's smallest value", 'max': "its column's largest value",
                   'zero': "0", 'one': "1"}


def _fill_with(args, kwargs, arg_sources, sources):
    strategy = kwargs.get('strategy', args[1] if len(args) > 1 else None)
    if strategy is not None:
        return FILL_STRATEGIES.get(strategy, f"the {strategy} strategy")
    if 'value' in kwargs:
        return sources.get('value') or _fmt_val(kwargs['value'])
    if args:
        return arg_sources[0] if arg_sources and arg_sources[0] else _fmt_val(args[0])
    return "the value given"


def _filled(input_state, out_state, cells):
    out_columns = out_state["columns"]
    return [[r, c] for r, c in cells
            if c in out_columns and r < len(out_state["preview"]) and out_state["preview"][r][out_columns.index(c)] != NULL]


def _fill_null(df, args, kwargs, arg_sources, sources, input_state, output):
    with_what = _fill_with(args, kwargs, arg_sources, sources)
    before = df.null_count().row(0)
    after = output.null_count().row(0)
    filled_total = sum(before) - sum(after)
    explanation = f"Filled {_plural(filled_total, 'null')} with {with_what}."
    out_state = _state(output)
    cells = _null_cells(input_state)
    filled = _filled(input_state, out_state, cells)
    stayed = [c for c, n in zip(df.columns, after) if n]
    stay_note = ""
    if stayed and not kwargs.get('strategy') and not (len(args) > 1 and args[1]):
        stay_note = (f" The nulls in {_names_text(stayed)} stay: {with_what} does not fit "
                     f"{'its type' if len(stayed) == 1 else 'their types'}, so fill_null leaves "
                     f"{'that column' if len(stayed) == 1 else 'those columns'} alone.")
    steps = [
        _find_nulls(input_state),
        {
            "stage": "Fill them in",
            "message": (f"Then each null is replaced by {with_what}, every column at once: "
                        f"{_plural(filled_total, 'null')} filled.{stay_note}"),
            "input_highlights": {"cells": cells},
            "output_highlights": {"cells": filled},
        },
    ]
    return _record('fill_null', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _row_keys(df, columns):
    """Each row's values in columns, as a hashable key (null and NaN included)."""
    return [tuple(key_of(_cell(v)) for v in row) for row in df.select(columns).rows()]


def _unique(df, args, kwargs, arg_sources, sources, input_state, output):
    removed = df.height - output.height
    explanation = f"Kept {_plural(output.height, 'distinct row')}; dropped {removed} repeated."
    columns = _subset(df, args, kwargs)
    keep = kwargs.get('keep', 'any')
    if columns is None or keep not in ('any', 'first', 'last', 'none'):
        return _record('unique', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    keys = _row_keys(df, columns)
    counts = {}
    for k in keys:
        counts[k] = counts.get(k, 0) + 1
    # Which input row each result row is: the same values in every column, earliest first
    whole = _row_keys(df, list(df.columns))
    where = {}
    for i, k in enumerate(whole):
        where.setdefault(k, []).append(i)
    kept = []
    for k in _row_keys(output, list(df.columns)):
        if where.get(k):
            kept.append(where[k].pop(0 if keep != 'last' else -1))
    if len(kept) != output.height:
        return _record('unique', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    repeated = [k for k in dict.fromkeys(keys) if counts[k] > 1]
    slots = color_slots(repeated)
    n_preview = len(input_state["preview"])
    row_colors = [slots.get(keys[i]) for i in range(n_preview)]
    over = f" in {_names_text(columns)}" if len(columns) < df.width else ""
    which = {'any': "one of each (any one: polars does not promise which)", 'first': "the first of each",
             'last': "the last of each", 'none': "only the rows that have no copy"}[keep]
    order = ("" if kwargs.get('maintain_order') else
             " Without maintain_order=True, polars may return the rows in any order.")
    steps = [
        {
            "stage": "Find repeated rows",
            "message": (f"Rows with the same values{over} are copies; each set of copies shares a colour: "
                        f"{_plural(len(repeated), 'set')} of copies." + _truncation_note(input_state)),
            "input_highlights": {"row_colors": row_colors, **({"columns": columns} if over else {})},
        },
        {
            "stage": "Keep one of each",
            "message": f"unique keeps {which}: {output.height} kept, {removed} (struck through) dropped.{order}",
            "input_highlights": {**_row_highlights(input_state, kept), "row_colors": row_colors},
            "note": "polars puts each row's values in a hash table and keeps a row only the first time its values come up.",
        },
    ]
    return _record('unique', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _group_rows(groupby, name, args, kwargs, arg_sources, sources, input_state, output):
    """group_by(...).head(n) / .tail(n): the first or last rows of each group, not combined."""
    df = groupby.df
    by = list(groupby.by)
    keys = [_expr_name(b) if not isinstance(b, str) else b for b in by]
    n = kwargs.get('n', args[0] if args else 5)
    first = 'first' if name == 'head' else 'last'
    rows_text = f"{first} row" if n == 1 else f"{first} {_plural(n, 'row')}"
    label = f"group_by().{name}()"
    explanation = f"Kept the {rows_text} of each group: {_plural(output.height, 'row')}."
    if getattr(groupby, 'named_by', None) or not keys or not all(k in df.columns for k in keys):
        return _record('group_by', args, kwargs, arg_sources, sources, input_state, output, explanation, None, label)
    kept = _positions(df, lambda d: getattr(d.group_by(*by, maintain_order=True), name)(*args, **kwargs))
    if kept is None or len(kept) != output.height:
        return _record('group_by', args, kwargs, arg_sources, sources, input_state, output, explanation, None, label)
    key_rows = _row_keys(df, keys)
    out_keys = _row_keys(output, keys)
    slots = color_slots(list(dict.fromkeys(out_keys)))
    n_preview = len(input_state["preview"])
    row_colors = [slots.get(key_rows[i]) for i in range(n_preview)]
    n_groups = len(set(key_rows))
    named = ', '.join(map(repr, keys))
    order = ("Groups come out in the order each first appears (maintain_order=True)." if groupby.maintain_order else
             "Without maintain_order=True, the groups come out in no particular order.")
    steps = [
        {
            "stage": "Sort rows into groups",
            "message": (f"Rows with the same {named} go into one group, one colour each: {_plural(n_groups, 'group')}."
                        + _truncation_note(input_state)),
            "input_highlights": {"columns": keys, "row_colors": row_colors},
        },
        {
            "stage": f"Keep the {first} rows of each",
            "message": (f"{name}({n}) keeps each group's {rows_text}, in the order the rows came; "
                        f"a group with fewer keeps them all. Each group's rows come out together. {order}"),
            "input_highlights": {**_row_highlights(input_state, kept), "columns": keys, "row_colors": row_colors},
            "output_highlights": {"row_colors": [slots.get(k) for k in out_keys[:len(_state(output)["preview"])]]},
        },
    ]
    return _record('group_by', args, kwargs, arg_sources, sources, input_state, output, explanation, steps, label)


def _on(receiver, call):
    """The call with what it is called on, when that is short: df['score'].is_null()."""
    return f"{receiver}.{call}" if receiver and len(receiver) <= 30 else call


def _series_step(name, s, args, kwargs, arg_sources, sources, input_state, output, receiver=''):
    """A Series method: the Series is shown as a one-column table."""
    if name == 'value_counts':
        return _value_counts(s, args, kwargs, arg_sources, sources, input_state, output)
    if name in ('is_in', 'is_null'):
        return _ask_values(name, s, args, kwargs, arg_sources, sources, input_state, output, receiver)
    if name == 'fill_null':
        with_what = _fill_with(args, kwargs, arg_sources, sources)
        cells = _null_cells(input_state)
        filled = _filled(input_state, _series_state(output), cells)
        n = s.null_count() - output.null_count()
        steps = [_find_nulls(input_state), {
            "stage": "Fill them in",
            "message": f"Then each null is replaced by {with_what}: {_plural(n, 'null')} filled.",
            "input_highlights": {"cells": cells}, "output_highlights": {"cells": filled}}]
        return _record('fill_null', args, kwargs, arg_sources, sources, input_state, output,
                       f"Filled {_plural(n, 'null')} with {with_what}.", steps)
    if not _is_series(output):
        return None
    call = _on(receiver, _call(name, args, kwargs, arg_sources, sources))
    if name == 'sort':
        descending = kwargs.get('descending', args[0] if args else False)
        message = (f"{call} returns the values {'largest' if descending else 'smallest'} first"
                   f"{'' if kwargs.get('nulls_last') else ', nulls first'}. Nothing is added or removed.")
        explanation = f"Sorted {_plural(s.len(), 'value')}."
    elif name == 'unique':
        message = (f"{call} keeps one of each value: {_plural(s.len(), 'value')} became {output.len()}."
                   + ("" if kwargs.get('maintain_order') else
                      " Without maintain_order=True, polars may return them in any order."))
        explanation = f"Kept {_plural(output.len(), 'distinct value')}."
    else:
        message = (f"{call} turns every value into {_type_name(output.dtype)}, all at once "
                   f"({_type_name(s.dtype)} → {_type_name(output.dtype)}). A value that does not fit raises an "
                   "error, unless strict=False makes it null.")
        explanation = f"Cast {_type_name(s.dtype)} to {_type_name(output.dtype)}."
    steps = [{"stage": "Work out the Series", "message": message, "input_highlights": {"columns": [s.name]},
              "output_highlights": {"columns": [output.name]}, "output_label": "Series"}]
    return _record(name, args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _ask_values(name, s, args, kwargs, arg_sources, sources, input_state, output, receiver=''):
    mask = output.to_list()
    question = (f"is in {arg_sources[0] if arg_sources and arg_sources[0] else _fmt_val(args[0]) if args else 'the values given'}"
                if name == 'is_in' else "is null")
    condition = _on(receiver, _call(name, args, kwargs, arg_sources, sources))
    n_true = sum(1 for m in mask if m is True)
    explanation = f"{n_true} of {_plural(len(mask), 'value')} {'are' if n_true != 1 else 'is'} True."
    rows = [[row[0], _cell(mask[i])] for i, row in enumerate(input_state["preview"])]
    nulls = name == 'is_in' and any(m is None for m in mask)
    steps = [{
        "stage": "Ask every value",
        "message": (f"{condition} asks every value at once whether it {question}, giving a Series of True and False: "
                    f"{n_true} True." + (" A null is neither in nor out, so it gives null." if nulls else "")),
        "input_highlights": {"columns": [s.name]},
        "output_state": {**_make_state([s.name, condition], rows,
                                       column_types=[input_state["column_types"][0], 'bool']),
                         "num_rows": input_state["num_rows"]},
        "output_label": "True or False for each value",
        "output_highlights": {"columns": [condition]},
    }]
    return _record(name, args, kwargs, arg_sources, sources, input_state, output, explanation, steps)


def _value_counts(s, args, kwargs, arg_sources, sources, input_state, output):
    explanation = f"Counted {_plural(output.height, 'distinct value')} in {_plural(s.len(), 'value')}."
    if not _is_frame(output) or output.width != 2:
        return _record('value_counts', args, kwargs, arg_sources, sources, input_state, output, explanation, None)
    value_col, count_col = output.columns
    keys = [key_of(_cell(v)) for v in s.to_list()]
    out_state = _state(output)
    groups = []
    for row in out_state["preview"]:
        members = [i for i, k in enumerate(keys) if k == key_of(row[0])]
        groups.append({"key": [row[0]], "members": members, "size": len(members),
                       "values": [{"column": count_col, "values": [], "result": row[1], "fn": "count()"}]})
    sort = kwargs.get('sort', args[0] if args else False)
    order = ("The most common value comes first (sort=True)." if sort else
             "With sort=False (the default), polars returns the values in no particular order; sort=True puts the most common first.")
    steps = group_stages(key_names=[s.name], groups=groups, input_state=input_state, out_state=out_state,
                         key_columns=[s.name], value_columns=[],
                         note=("value_counts is a group by on the values, then a count of each group: polars "
                               "keeps one counter per distinct value in a hash table, in one pass."),
                         order_note=order)
    return _record('value_counts', args, kwargs, arg_sources, sources, input_state, output, explanation, steps)
