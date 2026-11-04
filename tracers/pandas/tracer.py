"""Tracer for pandas, by rewriting the cell's code before it runs.

pandas has too many ways to reach the same result to patch methods one by one, so this tracer
rewrites the cell instead: transform() turns `x.method(...)` into `_dstutor_method(x, 'method',
line)(...)`, `x[key]` into `_dstutor_getitem(x, key, ...)` and `df[key] = value` into
`_dstutor_setitem(...)`. At run time those helpers do exactly what the original code did, and when
the object is a DataFrame (or a groupby of one) they record the step. Records follow
@dstutor/trace-schema; every DataFrame is shown with its index as the first column, the way
pandas prints it, so filtering and sorting show where each row went.

Traced: boolean filtering (df[mask], df.loc[mask], df.query), sort_values, groupby followed by an
aggregation, merge (method and pd.merge), assign and df[col] = value, and pivot_table.

The rewriting, the step log and the formatting are shared with the polars tracer
(tracers/shared/dstutor_rewriting.py, loaded by the runtime before this module).

The runtime (@dstutor/runtime-pyodide) loads this file as a module and calls install(),
reset(), get_trace(), is_trace_truncated(), set_cell_statements() and transform(); run(code)
runs code on its own, for tests and use outside the notebook.
"""
import ast
import builtins
import math
import types

from dstutor_rewriting import (
    MAX_GROUP_STEPS, MAX_ROWS_PREVIEW, Log, Rewriter, group_stages, join_stages, table_name,
    columns_in as _columns_in, display as _display, fmt_list as _fmt_list, fmt_val as _fmt_val,
    like as _like, make_state as _make_state, plural as _plural, truncation_note as _truncation_note,
)

_log = Log()
_enabled = False

# Methods that become steps when called on a DataFrame
DATAFRAME_METHODS = {'sort_values', 'merge', 'assign', 'pivot_table', 'query'}
# Aggregations that end a groupby
GROUPBY_AGGREGATIONS = {'mean', 'sum', 'count', 'size', 'min', 'max', 'median', 'agg', 'aggregate', 'nunique',
                        'first', 'last', 'std', 'var', 'prod'}
# Every attribute call worth rewriting; groupby itself is not a step, but remembers its table
REWRITTEN_METHODS = DATAFRAME_METHODS | GROUPBY_AGGREGATIONS | {'groupby'}


# ---------------------------------------------------------------------------------------------
# The interface every tracer exposes

def install():
    """Make the rewritten code's helpers available and start recording. Idempotent."""
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
    """Statements of the cell being run, as (start_line, end_line, assigned_name_or_None), so each
    step can say which line and which variable it belongs to."""
    _log.set_cell_statements(statements)


def transform(tree):
    """Rewrite a parsed cell so the operations it runs are traced. Returns the new tree."""
    return Rewriter(REWRITTEN_METHODS).rewrite(tree)


def run(code):
    """Run code as a fresh notebook cell and return the TraceRecord dicts it produced."""
    install()
    reset()
    tree = ast.parse(code, '<cell>')
    set_cell_statements([])
    import pandas as pd
    import numpy as np
    exec(compile(transform(tree), '<cell>', 'exec'), {'__name__': '__main__', 'pd': pd, 'np': np})
    return get_trace()


# ---------------------------------------------------------------------------------------------
# The helpers the rewritten code calls. Each does what the original code did; recording never
# changes the result, and a failure while recording is swallowed so student code still runs.

def _pandas():
    import pandas as pd
    return pd


def _is_frame(obj):
    return isinstance(obj, _pandas().DataFrame)


def _is_groupby(obj):
    from pandas.core.groupby import DataFrameGroupBy, SeriesGroupBy
    return isinstance(obj, (DataFrameGroupBy, SeriesGroupBy))


def _method(receiver, name, line, sources=None, arg_sources=None, receiver_source=''):
    bound = getattr(receiver, name)
    if not _enabled:
        return bound
    if name == 'groupby' and _is_frame(receiver):
        def groupby(*args, **kwargs):
            result = bound(*args, **kwargs)
            _remember_source(result, receiver)
            return result
        return groupby
    is_pd_merge = name == 'merge' and isinstance(receiver, types.ModuleType) and receiver.__name__ == 'pandas'
    if not ((name in DATAFRAME_METHODS and _is_frame(receiver)) or is_pd_merge
            or (name in GROUPBY_AGGREGATIONS and _is_groupby(receiver))):
        return bound

    # A groupby made from a Series (s.groupby(...)) has no table to show; leave it untraced
    if _is_groupby(receiver) and not _is_frame(getattr(receiver, '_dstutor_source', None)):
        return bound

    def traced(*args, **kwargs):
        if is_pd_merge:
            left, rest = (args[0], args[1:]) if args else (kwargs.get('left'), args)
        else:
            left, rest = receiver, args
        # Capture before running, in case the call changes the table in place
        input_state = _state(left._dstutor_source if _is_groupby(left) else left)
        if name == 'query':
            # query finds @variables a set number of frames up the stack; this wrapper is one more
            kwargs['level'] = kwargs.get('level', 0) + 1
        result = bound(*args, **kwargs)
        try:
            output = left if (result is None and kwargs.get('inplace')) else result
            # The tables' names as written, for the stages (cones.merge(stock) or pd.merge(cones, stock))
            written = list(arg_sources or [])
            names = ({'left': table_name(written[0] if written else '', 'left'),
                      'right': table_name(written[1] if len(written) > 1 else '', 'right')} if is_pd_merge else
                     {'left': table_name(receiver_source, 'left'), 'right': table_name(written[0] if written else '', 'right')})
            _record_call(name, left, rest, kwargs, input_state, output, line, sources or {}, names)
        except Exception:
            pass
        return result
    return traced


def _remember_source(groupby, frame):
    try:
        groupby._dstutor_source = frame
    except Exception:
        pass


def _getitem(container, key, key_source, line):
    result = container[key]
    if not _enabled:
        return result
    try:
        if _is_groupby(container) and _is_groupby(result):
            # df.groupby('k')['col']: the selection keeps the original table for the step
            _remember_source(result, getattr(container, '_dstutor_source', None))
        elif _is_frame(container) and _is_frame(result) and _is_row_mask(key, container):
            _record_filter(container, result, key_source, line, via='[]')
        elif type(container).__name__ == '_LocIndexer' and _is_frame(getattr(container, 'obj', None)):
            frame = container.obj
            row_key = key[0] if isinstance(key, tuple) else key
            if _is_frame(result) and _is_row_mask(row_key, frame):
                _record_filter(frame, result, key_source, line, via='loc')
    except Exception:
        pass
    return result


def _setitem(container, key, value, key_source, line, value_source=''):
    if not (_enabled and _is_frame(container) and isinstance(key, str)):
        container[key] = value
        return
    input_state = _state(container)
    existed = key in container.columns
    container[key] = value
    try:
        _record_assign(container, [key], input_state, container, line, replaced=[key] if existed else [],
                       in_place=True, sources={key: value_source})
    except Exception:
        pass


def _is_row_mask(key, frame):
    """A boolean Series, array or list with one value per row: the key of a row filter."""
    import numpy as np
    pd = _pandas()
    if isinstance(key, pd.Series):
        return key.dtype == bool and len(key) == len(frame)
    if isinstance(key, np.ndarray):
        return key.dtype == bool and key.shape == (len(frame),)
    if isinstance(key, list):
        return len(key) == len(frame) and len(key) > 0 and all(isinstance(v, (bool, np.bool_)) for v in key)
    return False


# ---------------------------------------------------------------------------------------------
# Recording

_record = _log.add
_site = _log.site


def _json_safe(value):
    pd = _pandas()
    if isinstance(value, pd.DataFrame):
        return f"DataFrame ({len(value)} rows × {len(value.columns)} columns)"
    if isinstance(value, pd.Series):
        return f"Series '{value.name}' ({len(value)} values)"
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if callable(value):
        return getattr(value, '__name__', None) or str(value)
    if hasattr(value, 'tolist'):
        return _json_safe(value.tolist())
    if hasattr(value, 'item'):
        try:
            value = value.item()
        except Exception:
            return str(value)
    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    return str(value)


def _cell(value):
    """A table value as JSON. NaN, infinities, NaT, <NA> and None have no JSON of their own, so they
    are sent as {"shown": text}: the text pandas prints for them, which the table shows as is."""
    pd = _pandas()
    if value is None:
        return {"shown": "None"}
    if value is pd.NA:
        return {"shown": "<NA>"}
    if value is pd.NaT:
        return {"shown": "NaT"}
    if hasattr(value, 'item') and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except Exception:
            pass
    if isinstance(value, float) and not math.isfinite(value):
        return {"shown": "NaN" if math.isnan(value) else ("inf" if value > 0 else "-inf")}
    return _json_safe(value)


def _label(value):
    if isinstance(value, tuple):
        return ' / '.join(str(v) for v in value if v != '')
    return str(value)


def _index_labels(index, columns):
    """Names for the index column(s): the index's own name, blank when it has none."""
    names = []
    for i, name in enumerate(index.names):
        label = '' if name is None else _label(name)
        if label == '' and len(index.names) > 1:
            label = f'level_{i}'
        if label in columns:
            label = f'{label} (index)'
        names.append(label)
    return names


def _state(obj):
    """A DataFrame or Series as a TableState, its index shown as the first column(s)."""
    pd = _pandas()
    if obj is None:
        return {"error": "no table", "num_rows": 0, "num_columns": 0, "columns": [], "preview": []}
    try:
        if isinstance(obj, pd.Series):
            obj = obj.to_frame(name='' if obj.name is None else obj.name)
        columns = [_label(c) for c in obj.columns]
        index_columns = _index_labels(obj.index, columns)
        head = obj.head(MAX_ROWS_PREVIEW)
        preview = []
        for label, row in zip(head.index, head.itertuples(index=False, name=None)):
            labels = list(label) if isinstance(label, tuple) else [label]
            preview.append([_cell(v) for v in labels] + [_cell(v) for v in row])
        # pandas does not print types, but they decide how it prints a float column (4.50)
        types = [str(obj.index.get_level_values(i).dtype) for i in range(obj.index.nlevels)] + [str(t) for t in obj.dtypes]
        return {
            "num_rows": len(obj),
            "num_columns": len(index_columns) + len(columns),
            "columns": index_columns + columns,
            "preview": preview,
            # The index is shown as the first column(s), but pandas does not count it as one
            "index_columns": len(index_columns),
            "column_types": types,
        }
    except Exception as e:
        return {"error": str(e), "num_rows": 0, "num_columns": 0, "columns": [], "preview": []}


def _record_filter(frame, result, condition, line, via):
    input_state = _state(frame)
    output_state = _state(result)
    kept_labels = set(result.index)
    n_preview = len(input_state["preview"])
    labels = list(frame.index[:n_preview])
    kept = [i for i in range(n_preview) if labels[i] in kept_labels]
    removed = [i for i in range(n_preview) if labels[i] not in kept_labels]
    n_kept, n_removed = len(result), len(frame) - len(result)
    columns = _columns_in(condition, input_state)
    steps = None
    # Our kept rows must match what pandas produced (duplicate index labels can blur them)
    if sum(1 for label in frame.index if label in kept_labels) == n_kept:
        note = _truncation_note(input_state)
        # The condition as its own column of True and False, next to the index and the columns it
        # tests (just those, so the new column stays in view)
        shown = list(range(frame.index.nlevels)) + [input_state["columns"].index(c) for c in columns]
        checked_columns = [input_state["columns"][c] for c in shown] + [condition]
        checked = [[row[c] for c in shown] + [i in kept] for i, row in enumerate(input_state["preview"])]
        steps = [
            {
                "stage": "Ask every row",
                "message": "First the condition is checked for every row at once, giving True or False.",
                "detail": f"Condition: {condition}",
                "input_highlights": {"columns": columns},
                "output_state": {**_make_state(checked_columns, checked, frame.index.nlevels), "num_rows": input_state["num_rows"]},
                "output_label": "True or False for each row",
                "output_highlights": {"columns": [condition]},
            },
            {
                "stage": "Keep the True rows",
                "message": (f"Keep the rows where it is True: {n_kept} kept, {n_removed} (struck through) "
                            f"removed. Kept rows keep their index labels.{note}"),
                "input_highlights": {"rows": kept, "rows_removed": removed, "columns": columns},
            },
        ]
    record = {
        "operation": 'query' if via == 'query' else 'filter',
        "args": [condition],
        "kwargs": {},
        "input": input_state,
        "output": output_state,
        "explanation": f"Filtered rows. Kept {n_kept}, removed {n_removed}.",
        "sub_steps": steps,
        "site": _site(line),
    }
    # cones[...] and cones.loc[...] call no method, so filter() would be a made-up name
    if via != 'query':
        record["label"] = "keep rows where True"
    _record(record)


def _record_call(name, left, args, kwargs, input_state, output, line, sources, names=None):
    if name == 'query':
        condition = args[0] if args else kwargs.get('expr', '')
        _record_filter(left, output, repr(condition), line, via='query')
        return
    if name == 'assign':
        _record_assign(left, list(kwargs), input_state, output, line,
                       replaced=[k for k in kwargs if k in left.columns], in_place=False, sources=sources)
        return
    output_state = _state(output)
    if name == 'sort_values':
        steps, explanation = _sort(left, args, kwargs, input_state, output, output_state)
    elif name == 'merge':
        steps, explanation = _merge(left, args, kwargs, input_state, output, output_state, names or {})
    elif name == 'pivot_table':
        steps, explanation = _pivot_table(left, args, kwargs, input_state, output, output_state)
    else:
        steps, explanation = _groupby(left, name, args, kwargs, input_state, output, output_state)
        name = 'groupby'
    _record({
        "operation": name,
        "args": _json_safe(list(args)),
        "kwargs": _json_safe(kwargs),
        "input": input_state,
        "output": output_state,
        "explanation": explanation,
        "sub_steps": steps,
        "site": _site(line),
    })


def _positions(frame, n_preview):
    """Index label -> preview row position, for the rows the input table shows."""
    return {label: i for i, label in enumerate(frame.index[:n_preview])}


def _record_assign(frame, names, input_state, output, line, replaced, in_place, sources):
    output_state = _state(output)
    added = [n for n in names if n not in replaced]
    parts = []
    if added:
        parts.append(f"Added {'column' if len(added) == 1 else 'columns'} {', '.join(repr(n) for n in added)}")
    if replaced:
        parts.append(f"Replaced {'column' if len(replaced) == 1 else 'columns'} {', '.join(repr(n) for n in replaced)}")
    where = (" This changes the DataFrame itself." if in_place else
             " assign returns a new DataFrame; the original is unchanged.")
    steps = None
    name = names[0] if names else None
    columns = output_state["columns"]
    if name in columns:
        source = sources.get(name) or ''
        uses = _columns_in(' '.join(sources.get(n) or '' for n in names), input_state)
        work = [{
            "stage": "Work out the column",
            "message": (f"{name} = {source}" if source and len(names) == 1 else
                        f"The new {'column' if len(names) == 1 else 'columns'} {', '.join(map(repr, names))}, "
                        f"one value per row."),
            "detail": "Worked out for every row at once, each row from its own values.",
            "input_highlights": {"columns": uses},
            "output_highlights": {"columns": list(names)},
        }]
        if len(names) > 1 and not in_place:
            work[0]["note"] = ("assign works its columns out in the order written, so a later one can use "
                               "a column made earlier in the same call.")
        steps = work + [{
            "stage": "Result",
            "message": f"The table keeps the same rows and index.{where}",
            "output_highlights": {"columns": list(names)},
        }]
    _record({
        "operation": 'assign',
        # df[col] = ... is not a call to assign, so say what it is instead
        **({"label": f"set column {name!r}"} if in_place and name else {}),
        "args": [],
        "kwargs": {n: sources.get(n) or f"column {n!r}" for n in names},
        "input": input_state,
        "output": output_state,
        "explanation": '; '.join(parts) + '.',
        "sub_steps": steps,
        "site": _site(line),
    })


def _sort(frame, args, kwargs, input_state, output, output_state):
    by = args[0] if args else kwargs.get('by')
    by = [by] if isinstance(by, str) else list(by or [])
    ascending = kwargs.get('ascending', args[1] if len(args) > 1 else True)
    direction = "smallest first" if ascending in (True, None) else "largest first"
    if isinstance(ascending, (list, tuple)):
        direction = "in the directions given"
    named = ', '.join(repr(b) for b in by)
    explanation = f"Sorted {_plural(len(frame), 'row')} by {named}, {direction}."
    in_by = [b for b in by if b in input_state["columns"]]
    tie = f" Rows with the same {by[0]!r} are ordered by {', '.join(repr(b) for b in by[1:])}." if len(by) > 1 else ""
    rows = output_state["preview"]
    labels = [_json_safe(v) for v in output.index[:len(rows)]]
    # Runs of result rows that tie on the first key
    ties = []
    if in_by and by[0] in output.columns:
        first = list(output[by[0]].iloc[:len(rows)])
        start = 0
        for i in range(1, len(first) + 1):
            if i == len(first) or not (first[i] == first[start] or (first[i] != first[i] and first[start] != first[start])):
                if i - start > 1:
                    ties.append([start, i - 1])
                start = i
    stable = len(by) > 1 or kwargs.get('kind') in ('stable', 'mergesort')
    steps = [
        {
            "stage": "Read the sort key",
            "message": f"sort_values orders the rows by {named}, {direction}.{tie} No rows are added or removed.",
            "input_highlights": {"columns": in_by},
            "output_state": _like(output_state, []),
        },
        {
            "stage": "Work out the new order",
            "message": "First pandas works out the new order: which row goes first, second, and so on.",
            "detail": f"New order of index labels: {_fmt_list(labels)}",
            "input_highlights": {"columns": in_by},
            "panel": {"kind": "order", "from": labels, **({"ties": ties} if ties else {}),
                      **({"values": [_cell(v) for v in output[by[0]].iloc[:len(labels)]]} if in_by and by[0] in output.columns else {}),
                      **({"more": output_state["num_rows"] - len(labels)} if output_state["num_rows"] > len(labels) else {})},
            "output_label": "New order",
            "note": ("pandas works out the order with numpy's argsort "
                     + ("(a stable sort, so rows that tie keep their order)" if stable else
                        "(quicksort for one key, so rows that tie may swap places in a long table)")
                     + ", puts NaN last whichever the direction, then moves every row in one go."),
        },
        {
            "stage": "Move every row at once",
            "message": "Then every row moves to its new place at once, keeping its index label, so you can see where each one went.",
            "output_highlights": {"columns": output_state["columns"][:output_state.get("index_columns", 0)] + in_by},
        },
    ]
    return steps, explanation


def _merge(left, args, kwargs, input_state, output, output_state, names):
    right = args[0] if args else kwargs.get('right')
    if not _is_frame(right):
        return None, f"Merged into {_plural(len(output), 'row')}."
    how = kwargs.get('how', 'inner')
    on = kwargs.get('on')
    left_on = kwargs.get('left_on', on)
    right_on = kwargs.get('right_on', on)
    if left_on is None and right_on is None:
        shared = [c for c in left.columns if c in right.columns]
        left_on = right_on = shared
    left_keys = [left_on] if isinstance(left_on, str) else list(left_on or [])
    right_keys = [right_on] if isinstance(right_on, str) else list(right_on or [])
    if len(left_keys) != 1 or len(right_keys) != 1 or how not in ('inner', 'left', 'right', 'outer'):
        return None, f"Merged on {', '.join(map(repr, left_keys))} into {_plural(len(output), 'row')}."
    lk, rk = left_keys[0], right_keys[0]
    if lk not in left.columns or rk not in right.columns:
        return None, f"Merged into {_plural(len(output), 'row')}."
    key_desc = lk if lk == rk else f"{lk} = {rk}"
    explanation = f"Merged ({how}) on {key_desc!r}: {_plural(len(output), 'row')}."
    head = output.head(MAX_ROWS_PREVIEW)
    lvals = list(head[lk]) if lk in output.columns else [None] * len(head)
    rvals = list(head[rk]) if rk in output.columns and rk != lk else [None] * len(head)
    is_missing = lambda v: v is None or (isinstance(v, float) and v != v)
    out_keys = [l if not is_missing(l) else r for l, r in zip(lvals, rvals)]
    keeps = {'inner': ['both'], 'left': ['left_only', 'both'], 'right': ['both', 'right_only'],
             'outer': ['left_only', 'both', 'right_only']}[how]
    order = {'inner': "Rows follow the left table's order.", 'left': "Rows follow the left table's order.",
             'right': "Rows follow the right table's order.", 'outer': "how='outer' sorts the rows by key."}[how]
    steps = join_stages(
        left_keys=list(left[lk]), right_keys=list(right[rk]), null_matches=True, keeps=keeps, mode='pairs',
        left_name=names.get('left', 'left'), right_name=names.get('right', 'right'), key_desc=key_desc,
        left_state=input_state, right_state=_state(right), left_col=lk, right_col=rk,
        out_state=output_state, out_keys=out_keys, missing='NaN',
        note=("pandas gives each key a number shared by both tables, sorts each side's rows by that number, "
              "then writes out every left × right pair. NaN keys match each other."),
        order_note=order, cell=_cell)
    return steps, explanation


def _agg_name(name, args, kwargs):
    if name in ('agg', 'aggregate'):
        func = args[0] if args else (kwargs if kwargs else None)
        if isinstance(func, str):
            return func
        if callable(func):
            return getattr(func, '__name__', 'the function')
        return 'the functions given'
    return name


def _groupby(groupby, name, args, kwargs, input_state, output, output_state):
    source = getattr(groupby, '_dstutor_source', None)
    keys = groupby.keys
    keys = [keys] if isinstance(keys, str) else list(keys) if isinstance(keys, (list, tuple)) else []
    agg = _agg_name(name, args, kwargs)
    selection = getattr(groupby, '_selection', None)
    named = ', '.join(repr(k) for k in keys)
    n_groups = len(output) if output is not None else 0
    explanation = f"Grouped by {named} into {_plural(n_groups, 'group')} and took the {agg}."
    if name == 'size':
        explanation = f"Grouped by {named} into {_plural(n_groups, 'group')} and counted the rows in each."
    if source is None or not keys or not all(isinstance(k, str) and k in source.columns for k in keys):
        return None, explanation
    out_cols = output_state["columns"]
    n_index = output_state.get("index_columns", 0)
    if n_index != len(keys) or output is None or not hasattr(output, 'index'):
        return None, explanation
    data_cols = out_cols[n_index:]
    key_rows = list(source[keys].itertuples(index=False, name=None))
    groups = []
    for gi, row in enumerate(output_state["preview"]):
        label = output.index[gi]
        label = label if isinstance(label, tuple) else (label,)
        members = [i for i, k in enumerate(key_rows) if k == label]
        values = []
        for ci, col in enumerate(data_cols):
            # The column each result combines: the same name in the table (not for size)
            src = col if (col in source.columns and name != 'size') else None
            values.append({
                "column": col or name,
                "values": [_cell(source[src].iloc[i]) for i in members] if src else [],
                "result": row[n_index + ci],
                "fn": agg,
            })
        groups.append({"key": row[:n_index], "members": members, "size": len(members), "values": values})
    value_columns = [v for v in ([selection] if isinstance(selection, str) else list(selection or []))]
    if not value_columns:
        value_columns = [c for c in data_cols if c in source.columns]
    if agg in ('median', 'quantile'):
        note = "For a median, pandas sorts the rows by group and takes the middle value of each group's run."
    elif name in ('agg', 'aggregate', 'apply') and agg not in ('sum', 'mean', 'count', 'min', 'max', 'size'):
        note = "pandas calls the function once for each group's values."
    else:
        note = ("pandas never builds these lists for a " + agg + ": it numbers the groups, then goes through the "
                "rows once, adding each value into its group's running total" +
                (" and count, and divides at the end." if agg == 'mean' else "."))
    sort = getattr(groupby, '_sort', True)
    order = ("Groups come out sorted by key (groupby sorts them unless sort=False)." if sort else
             "Groups come out in the order each first appears (sort=False).")
    steps = group_stages(key_names=keys, groups=groups, input_state=input_state, out_state=output_state,
                         key_columns=keys, value_columns=value_columns, note=note, order_note=order)
    steps[-1]["message"] += f" The group keys become the result's index, so {named} {'is' if len(keys) == 1 else 'are'} now row labels."
    return steps, explanation


def _pivot_table(frame, args, kwargs, input_state, output, output_state):
    index = kwargs.get('index', args[1] if len(args) > 1 else None)
    columns = kwargs.get('columns', args[2] if len(args) > 2 else None)
    values = kwargs.get('values', args[0] if args else None)
    aggfunc = kwargs.get('aggfunc', 'mean')
    agg = aggfunc if isinstance(aggfunc, str) else getattr(aggfunc, '__name__', 'the function')
    explanation = f"Built a pivot table of {_plural(len(output), 'row')} using {agg}."
    as_list = lambda v: [v] if isinstance(v, str) else list(v or [])
    index_cols, column_cols, value_cols = as_list(index), as_list(columns), as_list(values)
    if not index_cols or not all(c in frame.columns for c in index_cols + column_cols + value_cols):
        return None, explanation
    grid_text = (f"each unique {', '.join(map(repr, index_cols))} becomes a row"
                 + (f", and each unique {', '.join(map(repr, column_cols))} becomes a column" if column_cols else ""))
    simple = len(index_cols) == 1 and len(column_cols) <= 1 and len(value_cols) == 1
    if not simple:
        return [
            {
                "message": f"pivot_table builds a grid: {grid_text}.",
                "input_highlights": {"columns": index_cols + column_cols},
                "output_state": _like(output_state, []),
            },
            {
                "message": (f"Each cell combines the {', '.join(map(repr, value_cols)) or 'values'} of the rows that "
                            f"fall into it, using {agg}. A cell with no rows is NaN."),
                "input_highlights": {"columns": value_cols},
            },
        ], explanation

    # pandas groups the rows by each (index, column) pair, combines each group with aggfunc, then
    # spreads the column values out into columns (pandas/core/reshape/pivot.py). Shown as the grid
    # filling up row by row, the way datascience's pivot is shown.
    rk, vk = index_cols[0], value_cols[0]
    ck = column_cols[0] if column_cols else None
    n_index = output_state.get("index_columns", 0)
    out_cols = output_state["columns"]
    shown_rows = len(output_state["preview"])
    row_keys = list(output.index[:shown_rows])
    col_keys = list(output.columns) if ck else [vk]
    grid = [output_state["preview"][r][:n_index] + [[] for _ in col_keys] for r in range(shown_rows)]
    steps = [{
        "stage": "Lay out the grid",
        "message": f"pivot_table builds a grid: {grid_text}. Every cell starts empty.",
        "detail": (f"Rows: {_fmt_list([_json_safe(k) for k in row_keys])}"
                   + (f"   Columns: {_fmt_list([_json_safe(k) for k in col_keys])}" if ck else "")),
        "input_highlights": {"columns": index_cols + column_cols},
        "output_state": _like(output_state, [list(r) for r in grid]),
    }]
    n_preview = len(input_state["preview"])
    rows_data, vals_data = list(frame[rk]), list(frame[vk])
    cols_data = list(frame[ck]) if ck else [vk] * len(frame)
    def place(i):
        if rows_data[i] not in row_keys or cols_data[i] not in col_keys:
            return None  # a missing key, which pivot_table leaves out
        ri, cj = row_keys.index(rows_data[i]), col_keys.index(cols_data[i])
        grid[ri][n_index + cj] = grid[ri][n_index + cj] + [_json_safe(vals_data[i])]
        return ri, out_cols[n_index + cj]
    # Every row's value lands in its cell at once: each cell gathers the values of its group
    for i in range(len(frame)):
        place(i)
    steps.append({
        "stage": "Gather each cell's values",
        "message": f"Every row's {vk!r} goes into the cell for its {rk!r}" + (f" and {ck!r}." if ck else "."),
        "input_highlights": {"columns": [rk, vk] + ([ck] if ck else [])},
        "output_state": _like(output_state, [list(r) for r in grid]),
        "note": ("pivot_table is a groupby on the row and column keys followed by unstack: each cell is "
                 "one group, combined, then spread into the grid."),
    })
    example = next(((cell, output_state["preview"][r][n_index + c]) for r, row in enumerate(grid)
                    for c, cell in enumerate(row[n_index:]) if cell), None)
    step = {"stage": "Combine each cell", "message": f"Then {agg} combines each cell's list into one value."}
    if example:
        step["detail"] = f"{agg}({_fmt_val(example[0])}) = {_fmt_val(_display(example[1]))}"
    steps.append(step)
    empty = [[r, out_cols[n_index + c]] for r, row in enumerate(grid) for c, cell in enumerate(row[n_index:]) if not cell]
    if empty:
        steps.append({
            "stage": "Empty cells",
            "message": ("Cells that no row fell into have nothing to combine, so pandas marks them NaN "
                        "(missing)."),
            "output_highlights": {"cells": empty},
        })
    return steps, explanation
