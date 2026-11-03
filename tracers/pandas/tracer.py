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

The runtime (@dstutor/runtime-pyodide) loads this file as a module and calls install(),
reset(), get_trace(), is_trace_truncated(), set_cell_statements() and transform(); run(code)
runs code on its own, for tests and use outside the notebook.
"""
import ast
import builtins
import math
import types

MAX_TRACE_RECORDS = 200
MAX_ROWS_PREVIEW = 20
# Groups walked through one by one before the rest are summarised
MAX_GROUP_STEPS = 4

_trace_log = []
_step_counter = 0
_trace_truncated = False
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
    global _trace_log, _step_counter, _trace_truncated
    _trace_log = []
    _step_counter = 0
    _trace_truncated = False


def get_trace():
    return _trace_log.copy()


def is_trace_truncated():
    return _trace_truncated


# Statements of the cell being run, as (start_line, end_line, assigned_name_or_None); set by
# the runner from the cell's AST so each step can say which line and which variable it belongs to
_cell_statements = []


def set_cell_statements(statements):
    global _cell_statements
    # innermost statement first, so a call inside a loop body maps to the body's assignment
    _cell_statements = sorted(((int(a), int(b), t) for a, b, t in statements), key=lambda x: x[1] - x[0])


def transform(tree):
    """Rewrite a parsed cell so the operations it runs are traced. Returns the new tree."""
    return ast.fix_missing_locations(_Rewriter().visit(tree))


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
# Rewriting

def _helper(name, args, node):
    call = ast.Call(func=ast.Name(name, ast.Load()), args=args, keywords=[])
    return ast.copy_location(call, node)


def _as_expression(node):
    """A subscript's slice as an expression: `a:b` is only valid inside [], so spell it slice(a, b)."""
    if isinstance(node, ast.Slice):
        none = ast.Constant(None)
        return ast.copy_location(
            ast.Call(func=ast.Name('slice', ast.Load()),
                     args=[node.lower or none, node.upper or none, node.step or none], keywords=[]),
            node)
    if isinstance(node, ast.Tuple):
        return ast.copy_location(ast.Tuple([_as_expression(e) for e in node.elts], ast.Load()), node)
    return node


def _source(node):
    try:
        return ast.unparse(node)
    except Exception:
        return ''


class _Rewriter(ast.NodeTransformer):
    def visit_Call(self, node):
        func = node.func
        # assign(Sale=cones['Price'] * 0.9): each new column's expression as written, for its step
        sources = ast.Dict(keys=[ast.Constant(k.arg) for k in node.keywords if k.arg],
                           values=[ast.Constant(_source(k.value)) for k in node.keywords if k.arg])
        self.generic_visit(node)
        if isinstance(func, ast.Attribute) and func.attr in REWRITTEN_METHODS:
            # The line of `.method`, which is where it sits in a chain split over lines
            line = getattr(func, 'end_lineno', None) or node.lineno
            node.func = _helper('_dstutor_method', [func.value, ast.Constant(func.attr), ast.Constant(line), sources], func)
        return node

    def visit_Subscript(self, node):
        # The key as the student wrote it, before anything inside it is rewritten
        key_source = _source(node.slice)
        self.generic_visit(node)
        if not isinstance(node.ctx, ast.Load):
            return node
        return _helper('_dstutor_getitem', [node.value, _as_expression(node.slice),
                                            ast.Constant(key_source), ast.Constant(node.lineno)], node)

    def visit_Assign(self, node):
        # df['col'] = value: a column added or replaced in place
        if len(node.targets) == 1 and isinstance(node.targets[0], ast.Subscript):
            target = node.targets[0]
            key_source = _source(target.slice)
            value_source = _source(node.value)
            self.generic_visit(node)
            call = _helper('_dstutor_setitem', [target.value, _as_expression(target.slice), node.value,
                                                ast.Constant(key_source), ast.Constant(node.lineno),
                                                ast.Constant(value_source)], node)
            return ast.copy_location(ast.Expr(call), node)
        self.generic_visit(node)
        return node


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


def _method(receiver, name, line, sources=None):
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
            _record_call(name, left, rest, kwargs, input_state, output, line, sources or {})
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

def _record(record):
    global _trace_truncated, _step_counter
    if len(_trace_log) >= MAX_TRACE_RECORDS:
        _trace_truncated = True
        return
    record["step_id"] = _step_counter
    _step_counter += 1
    # No walkthrough means no sub_steps field at all, not null (the contract allows only a list)
    if record.get("sub_steps") is None:
        record.pop("sub_steps", None)
    _trace_log.append(record)


def _site(line):
    for start, end, target in _cell_statements:
        if start <= line <= end:
            return {"line": line, "stmt_start": start, "stmt_end": end, "target": target}
    return {"line": line, "stmt_start": line, "stmt_end": line, "target": None}


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
        return {
            "num_rows": len(obj),
            "num_columns": len(index_columns) + len(columns),
            "columns": index_columns + columns,
            "preview": preview,
            # The index is shown as the first column(s), but pandas does not count it as one
            "index_columns": len(index_columns),
        }
    except Exception as e:
        return {"error": str(e), "num_rows": 0, "num_columns": 0, "columns": [], "preview": []}


def _make_state(columns, preview, index_columns=0):
    """Synthetic TableState for intermediate result tables; the first index_columns are the index."""
    state = {"num_rows": len(preview), "num_columns": len(columns), "columns": list(columns),
             "preview": [list(row) for row in preview]}
    if index_columns:
        state["index_columns"] = index_columns
    return state


def _fmt_val(v):
    if isinstance(v, str):
        return repr(v)
    if isinstance(v, float):
        rounded = round(v, 4)
        return str(int(rounded)) if rounded == int(rounded) and abs(rounded) < 1e15 else str(rounded)
    if isinstance(v, (list, tuple)):
        return '[' + ', '.join(_fmt_val(x) for x in v) + ']'
    return str(v)


def _fmt_list(vals, max_items=12):
    shown = ', '.join(_fmt_val(v) for v in vals[:max_items])
    if len(vals) > max_items:
        shown += f', … (+{len(vals) - max_items} more)'
    return '[' + shown + ']'


def _plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def _truncation_note(state):
    shown = len(state["preview"])
    return f" (showing the first {shown} of {state['num_rows']})" if state["num_rows"] > shown else ""


def _columns_in(source, state):
    """Columns of state that the code mentions by name, e.g. in cones['Price'] > 4."""
    return [c for c in state["columns"] if c and (f"'{c}'" in source or f'"{c}"' in source or f'.{c}' in source)]


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
                "message": "First the condition is checked for every row, giving True or False.",
                "detail": f"Condition: {condition}",
                "input_highlights": {"columns": columns},
                "output_state": {**_make_state(checked_columns, checked, frame.index.nlevels), "num_rows": input_state["num_rows"]},
                "output_label": "True or False for each row",
                "output_highlights": {"columns": [condition]},
            },
            {
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


def _record_call(name, left, args, kwargs, input_state, output, line, sources):
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
        steps, explanation = _merge(left, args, kwargs, input_state, output, output_state)
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


def _like(state, preview):
    """An intermediate table with state's columns and index, holding preview."""
    return _make_state(state["columns"], preview, state.get("index_columns", 0))


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
    if name in columns and len(names) == 1:
        c = columns.index(name)
        source = sources.get(name) or ''
        uses = [col for col in _columns_in(source, input_state)]
        rows = output_state["preview"]
        # The new column, blank until each row's value is computed
        def partial(filled):
            return [row[:c] + [row[c] if i < filled else None] + row[c + 1:] for i, row in enumerate(rows)]
        steps = [{
            "message": f"{name} = {source}" if source else f"The new column {name!r} gets one value per row.",
            "detail": "The expression is worked out for every row, using that row's values.",
            "input_highlights": {"columns": uses},
            "output_state": _like(output_state, partial(0)),
            "output_highlights": {"columns": [name]},
        }]
        shown = min(len(rows), 3)
        for i in range(shown):
            steps.append({
                "message": f"Row {_fmt_val(rows[i][0]) if output_state.get('index_columns') else i}: {name} = {_fmt_val(_display(rows[i][c]))}",
                "input_highlights": {"rows": [i], "columns": uses},
                "output_state": _like(output_state, partial(i + 1)),
                "output_highlights": {"cells": [[i, name]]},
            })
        rest = output_state["num_rows"] - shown
        steps.append({
            "message": (f"…the same for the remaining {_plural(rest, 'row')}. The table keeps the same rows "
                        f"and index.{where}" if rest > 0 else f"The table keeps the same rows and index.{where}"),
            "output_highlights": {"columns": [name]},
        })
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


def _display(value):
    """A cell's value as the message should print it: pandas' text for NaN and friends."""
    return value["shown"] if isinstance(value, dict) and "shown" in value else value


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
    steps = [{
        "message": f"sort_values reorders all rows by {named}, {direction}.{tie} No rows are added or removed.",
        "input_highlights": {"columns": in_by},
        "output_state": _like(output_state, []),
    }]
    positions = _positions(frame, len(input_state["preview"]))
    rows = output_state["preview"]
    shown = min(len(rows), 3)
    for k in range(shown):
        label = output.index[k]
        values = ', '.join(f"{b} = {_fmt_val(_display(rows[k][output_state['columns'].index(b)]))}"
                           for b in in_by if b in output_state["columns"])
        place = ['first', 'second', 'third'][k]
        steps.append({
            "message": f"Row {_fmt_val(_json_safe(label))} comes {place}: {values}.",
            "input_highlights": {"rows": [positions[label]] if label in positions else [], "columns": in_by},
            "output_state": _like(output_state, rows[:k + 1]),
            "output_highlights": {"rows": [k]},
        })
    rest = output_state["num_rows"] - shown
    steps.append({
        "message": (f"…and the other {_plural(rest, 'row')} follow in the same order. " if rest > 0 else "")
                   + "Each row keeps its index label, so you can see where every row moved.",
        "detail": f"New order of index labels: {_fmt_list([_json_safe(v) for v in output.index])}",
        "output_highlights": {"columns": output_state["columns"][:output_state.get("index_columns", 0)] + in_by},
    })
    return steps, explanation


def _merge(left, args, kwargs, input_state, output, output_state):
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
    aux_state = _state(right)
    if len(left_keys) != 1 or len(right_keys) != 1:
        return None, f"Merged on {', '.join(map(repr, left_keys))} into {_plural(len(output), 'row')}."
    lk, rk = left_keys[0], right_keys[0]
    if lk not in left.columns or rk not in right.columns:
        return None, f"Merged into {_plural(len(output), 'row')}."
    key_desc = repr(lk) if lk == rk else f"{lk!r} (left) and {rk!r} (right)"
    explanation = f"Merged ({how}) on {key_desc}: {_plural(len(output), 'row')}."
    right_label = "Right table"
    n_left, n_right = len(input_state["preview"]), len(aux_state["preview"])
    left_vals, right_vals = list(left[lk]), list(right[rk])
    out_rows = output_state["preview"]
    out_cols = output_state["columns"]
    # Which key each result row came from: the left key column, or the right one for right-only rows
    lk_col = out_cols.index(lk) if lk in out_cols else None
    rk_col = out_cols.index(rk) if rk in out_cols else None
    def row_key(row):
        for c in (lk_col, rk_col):
            if c is not None and not isinstance(row[c], dict):
                return row[c]
        return None
    keys = []
    for row in out_rows:
        k = row_key(row)
        if k not in keys:
            keys.append(k)
    shared = set(left_vals) & set(right_vals)
    steps = [{
        "message": f"merge combines two tables, matching rows whose {key_desc} values are equal.",
        "input_highlights": {"columns": [lk]},
        "aux_table": {"label": right_label, "state": aux_state, "highlights": {"columns": [rk]}},
        "output_state": _like(output_state, []),
    }]
    done = []
    shown = keys if len(keys) <= MAX_GROUP_STEPS + 1 else keys[:MAX_GROUP_STEPS]
    for k in shown:
        done.append(k)
        lrows = [i for i in range(n_left) if left_vals[i] == k]
        rrows = [i for i in range(n_right) if right_vals[i] == k]
        a, b = sum(1 for v in left_vals if v == k), sum(1 for v in right_vals if v == k)
        if k in shared:
            message = (f"Key {_fmt_val(_json_safe(k))}: {_plural(a, 'left row')} × {_plural(b, 'right row')} "
                       f"→ {_plural(a * b, 'row')}, each with the columns of both tables.")
        elif a:
            message = (f"Key {_fmt_val(_json_safe(k))} has no match on the right; how={how!r} keeps it, "
                       f"with NaN for the right table's columns.")
        else:
            message = (f"Key {_fmt_val(_json_safe(k))} has no match on the left; how={how!r} keeps it, "
                       f"with NaN for the left table's columns.")
        partial = [row for row in out_rows if row_key(row) in done]
        steps.append({
            "message": message,
            "input_highlights": {"rows": lrows, "columns": [lk]},
            "aux_table": {"label": right_label, "state": aux_state, "highlights": {"rows": rrows, "columns": [rk]}},
            "output_state": _like(output_state, partial),
            "output_highlights": {"rows": list(range(len(partial) - sum(1 for r in out_rows if row_key(r) == k), len(partial)))},
        })
    if len(shown) < len(keys):
        rest = len(keys) - len(shown)
        steps.append({
            "message": f"…and the remaining {_plural(rest, 'key')} are matched the same way.",
            "aux_table": {"label": right_label, "state": aux_state},
        })
    # With an inner merge, keys found on one side only leave no row at all
    dropped_left = [i for i in range(n_left) if left_vals[i] not in shared] if how in ('inner', 'right') else []
    dropped_right = [i for i in range(n_right) if right_vals[i] not in shared] if how in ('inner', 'left') else []
    if dropped_left or dropped_right:
        gone = sorted({_json_safe(left_vals[i]) for i in dropped_left} | {_json_safe(right_vals[i]) for i in dropped_right}, key=str)
        steps.append({
            "message": (f"Rows whose key has no match on the other side are left out (struck through): "
                        f"how={how!r} only keeps {'matches' if how == 'inner' else ('every left row' if how == 'left' else 'every right row')}."),
            "detail": f"Keys with no match: {_fmt_list(gone)}",
            "input_highlights": {"rows_removed": dropped_left, "columns": [lk]},
            "aux_table": {"label": right_label, "state": aux_state,
                          "highlights": {"rows_removed": dropped_right, "columns": [rk]}},
        })
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
    if source is None or len(keys) != 1 or keys[0] not in source.columns:
        return None, explanation
    key = keys[0]
    values = [selection] if isinstance(selection, str) else list(selection) if selection else \
        [c for c in source.columns if c != key]
    counting = name in ('size', 'count')
    what = "counts the rows" if name == 'size' else f"takes the {agg} of {', '.join(repr(v) for v in values)}"
    out_cols = output_state["columns"]
    n_index = output_state.get("index_columns", 0)
    data_cols = out_cols[n_index:]
    steps = [{
        "message": (f"groupby({key!r}) puts rows with the same {key!r} into one group; then {name}() {what} "
                    f"in each group, so every group becomes one row."),
        "input_highlights": {"columns": [key]},
        "output_state": _like(output_state, []),
    }]
    n_preview = len(input_state["preview"])
    key_values = list(source[key])
    group_keys = list(output.index) if output is not None else []
    note = _truncation_note(input_state)
    # Before the aggregation, each group's cell holds the values it will combine (as datascience's
    # group shows them); counting shows the count straight away
    collect = not counting and all(c in source.columns for c in data_cols) and len(data_cols) > 0
    grid = []
    shown = group_keys if len(group_keys) <= MAX_GROUP_STEPS + 1 else group_keys[:MAX_GROUP_STEPS]
    for gi, gv in enumerate(group_keys[:len(output_state["preview"])]):
        members = [i for i, v in enumerate(key_values) if v == gv]
        if collect:
            grid.append(output_state["preview"][gi][:n_index] + [[_json_safe(source[c].iloc[i]) for i in members] for c in data_cols])
        else:
            grid.append(output_state["preview"][gi])
        if gi < len(shown):
            total = len(members)
            verb = 'collects' if total == 1 else 'collect'
            collected = f" {verb} into one list per column" if collect else f" become{'s' if total == 1 else ''} one row"
            steps.append({
                "message": f"Group {_fmt_val(_json_safe(gv))}: {_plural(total, 'row')}{collected}.{note}",
                "input_highlights": {"rows": [i for i in members if i < n_preview],
                                     "columns": [key] + [v for v in values if v in input_state["columns"]]},
                "output_state": _like(output_state, list(grid)),
                "output_highlights": {"rows": [gi]},
            })
    if len(shown) < len(group_keys):
        rest = len(group_keys) - len(shown)
        steps.append({
            "message": f"…and the remaining {_plural(rest, 'group')} are gathered the same way.",
            "output_state": _like(output_state, grid),
            "output_highlights": {"rows": list(range(len(shown), len(grid)))},
        })
    if collect and grid:
        example = next(((cell, output_state["preview"][gi][n_index + ci]) for gi, row in enumerate(grid)
                        for ci, cell in enumerate(row[n_index:]) if isinstance(cell, list) and cell), None)
        steps.append({
            "message": f"Then {name}() combines each list into one value.",
            "detail": f"{agg}({_fmt_val(example[0])}) = {_fmt_val(_display(example[1]))}" if example else None,
        })
        if steps[-1]["detail"] is None:
            del steps[-1]["detail"]
    steps.append({
        "message": f"The group keys become the result's index, so {key!r} is now the row label, not a column.",
        "output_highlights": {"columns": out_cols[:n_index]},
    })
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
    if len(frame) <= 10:
        for i in range(n_preview):
            spot = place(i)
            if spot is None:
                continue
            where = f"({_fmt_val(_json_safe(rows_data[i]))}, {_fmt_val(_json_safe(cols_data[i]))})" if ck else _fmt_val(_json_safe(rows_data[i]))
            steps.append({
                "message": f"Row {_fmt_val(_json_safe(frame.index[i]))}: its {vk} {_fmt_val(_json_safe(vals_data[i]))} goes into cell {where}.",
                "input_highlights": {"rows": [i], "cells": [[i, vk]], "columns": [rk] + ([ck] if ck else [])},
                "output_state": _like(output_state, [list(r) for r in grid]),
                "output_highlights": {"cells": [[spot[0], spot[1]]]},
            })
    else:
        for i in range(len(frame)):
            place(i)
        steps.append({
            "message": f"Every row's {vk!r} goes into the cell for its {rk!r}" + (f" and {ck!r}." if ck else "."),
            "output_state": _like(output_state, [list(r) for r in grid]),
        })
    example = next(((cell, output_state["preview"][r][n_index + c]) for r, row in enumerate(grid)
                    for c, cell in enumerate(row[n_index:]) if cell), None)
    step = {"message": f"Then {agg} combines each cell's list into one value."}
    if example:
        step["detail"] = f"{agg}({_fmt_val(example[0])}) = {_fmt_val(_display(example[1]))}"
    steps.append(step)
    empty = [[r, out_cols[n_index + c]] for r, row in enumerate(grid) for c, cell in enumerate(row[n_index:]) if not cell]
    if empty:
        steps.append({
            "message": ("Cells that no row fell into have nothing to combine, so pandas marks them NaN "
                        "(missing)."),
            "output_highlights": {"cells": empty},
        })
    return steps, explanation
