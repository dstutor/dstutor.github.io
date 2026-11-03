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
        self.generic_visit(node)
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in REWRITTEN_METHODS:
            # The line of `.method`, which is where it sits in a chain split over lines
            line = getattr(func, 'end_lineno', None) or node.lineno
            node.func = _helper('_dstutor_method', [func.value, ast.Constant(func.attr), ast.Constant(line)], func)
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
            self.generic_visit(node)
            call = _helper('_dstutor_setitem', [target.value, _as_expression(target.slice), node.value,
                                                ast.Constant(key_source), ast.Constant(node.lineno)], node)
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


def _method(receiver, name, line):
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
            _record_call(name, left, rest, kwargs, input_state, output, line)
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


def _setitem(container, key, value, key_source, line):
    if not (_enabled and _is_frame(container) and isinstance(key, str)):
        container[key] = value
        return
    input_state = _state(container)
    existed = key in container.columns
    container[key] = value
    try:
        _record_assign(container, [key], input_state, container, line, replaced=[key] if existed else [],
                       how=f"[{key_source}] = …")
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
            preview.append([_json_safe(v) for v in labels] + [_json_safe(v) for v in row])
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


def _record_call(name, left, args, kwargs, input_state, output, line):
    if name == 'query':
        condition = args[0] if args else kwargs.get('expr', '')
        _record_filter(left, output, repr(condition), line, via='query')
        return
    if name == 'assign':
        _record_assign(left, list(kwargs), input_state, output, line,
                       replaced=[k for k in kwargs if k in left.columns], how='assign')
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


def _record_assign(frame, names, input_state, output, line, replaced, how):
    output_state = _state(output)
    added = [n for n in names if n not in replaced]
    parts = []
    if added:
        parts.append(f"Added {'column' if len(added) == 1 else 'columns'} {', '.join(repr(n) for n in added)}")
    if replaced:
        parts.append(f"Replaced {'column' if len(replaced) == 1 else 'columns'} {', '.join(repr(n) for n in replaced)}")
    in_place = how != 'assign'
    steps = [{
        "message": ("Each new value is computed row by row from the other columns, so the table keeps "
                    "the same rows and index." + (" This changes the DataFrame itself." if in_place else
                                                  " assign returns a new DataFrame; the original is unchanged.")),
        "output_highlights": {"columns": [n for n in names if n in output_state["columns"]]},
    }]
    _record({
        "operation": 'assign',
        "args": [],
        "kwargs": {n: f"column {n!r}" for n in names},
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
    index_column = output_state["columns"][:1]
    steps = [
        {
            "message": f"sort_values reorders all rows by {named}, {direction}. No rows are added or removed.",
            "input_highlights": {"columns": [b for b in by if b in input_state["columns"]]},
        },
        {
            "message": "Each row keeps its index label, so you can see where every row moved.",
            "detail": f"New order of index labels: {_fmt_list([_json_safe(v) for v in output.index])}",
            "output_highlights": {"columns": index_column + [b for b in by if b in output_state["columns"]]},
        },
    ]
    return steps, f"Sorted {_plural(len(frame), 'row')} by {named}, {direction}."


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
    shared_keys = set(left[lk]) & set(right[rk])
    n_left, n_right = len(input_state["preview"]), len(aux_state["preview"])
    left_match = [i for i in range(n_left) if left[lk].iloc[i] in shared_keys]
    right_match = [i for i in range(n_right) if right[rk].iloc[i] in shared_keys]
    key_desc = repr(lk) if lk == rk else f"{lk!r} (left) and {rk!r} (right)"
    kept = {
        'inner': "Rows whose key has no match are dropped.",
        'left': "Every left row is kept; where the right table has no match, its columns are NaN (shown blank).",
        'right': "Every right row is kept; where the left table has no match, its columns are NaN (shown blank).",
        'outer': "Every row from both tables is kept; missing matches are NaN (shown blank).",
    }.get(how, "")
    right_label = "Right table"
    steps = [
        {
            "message": f"merge combines two tables, matching rows whose {key_desc} values are equal.",
            "input_highlights": {"columns": [lk]},
            "aux_table": {"label": right_label, "state": aux_state, "highlights": {"columns": [rk]}},
            "output_state": _make_state(output_state["columns"], [], output_state.get("index_columns", 0)),
        },
        {
            "message": "Find the key values that appear in both tables.",
            "detail": f"Keys in both: {_fmt_list(sorted((_json_safe(k) for k in shared_keys), key=str))}",
            "input_highlights": {"rows": left_match, "columns": [lk]},
            "aux_table": {"label": right_label, "state": aux_state,
                          "highlights": {"rows": right_match, "columns": [rk]}},
            "output_state": _make_state(output_state["columns"], [], output_state.get("index_columns", 0)),
        },
        {
            "message": f"Each matching pair of rows becomes one row with the columns of both tables. {kept}".strip(),
            "aux_table": {"label": right_label, "state": aux_state,
                          "highlights": {"rows": right_match, "columns": [rk]}},
        },
    ]
    return steps, f"Merged ({how}) on {key_desc}: {_plural(len(output), 'row')}."


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
    what = "counts the rows" if name == 'size' else f"takes the {agg} of {', '.join(repr(v) for v in values)}"
    steps = [{
        "message": (f"groupby({key!r}) puts rows with the same {key!r} into one group; then {name}() {what} "
                    f"in each group, so every group becomes one row."),
        "input_highlights": {"columns": [key]},
        "output_state": _make_state(output_state["columns"], [], output_state.get("index_columns", 0)),
    }]
    n_preview = len(input_state["preview"])
    key_values = list(source[key])
    # Each result row is one group, labelled by its key in the index
    group_keys = list(output.index) if output is not None else []
    note = _truncation_note(input_state)
    shown = group_keys if len(group_keys) <= MAX_GROUP_STEPS + 1 else group_keys[:MAX_GROUP_STEPS]
    for gi, gv in enumerate(shown):
        rows = [i for i in range(n_preview) if key_values[i] == gv]
        total = sum(1 for v in key_values if v == gv)
        steps.append({
            "message": f"Group {_fmt_val(_json_safe(gv))}: {_plural(total, 'row')} become{'s' if total == 1 else ''} one row.{note}",
            "input_highlights": {"rows": rows, "columns": [key] + [v for v in values if v in input_state["columns"]]},
            "output_state": _make_state(output_state["columns"], output_state["preview"][:gi + 1], output_state.get("index_columns", 0)),
            "output_highlights": {"rows": [gi]},
        })
    if len(shown) < len(group_keys):
        rest = len(group_keys) - len(shown)
        steps.append({
            "message": f"…and the remaining {_plural(rest, 'group')} are combined the same way.",
            "output_highlights": {"rows": list(range(len(shown), min(len(group_keys), len(output_state["preview"]))))},
        })
    steps.append({
        "message": f"The group keys become the result's index, so {key!r} is now the row label, not a column.",
        "output_highlights": {"columns": output_state["columns"][:1]},
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
    grid = (f"the unique values of {', '.join(map(repr, index_cols))} become the rows"
            + (f", and the unique values of {', '.join(map(repr, column_cols))} become the columns" if column_cols else ""))
    steps = [
        {
            "message": f"pivot_table builds a grid: {grid}.",
            "input_highlights": {"columns": index_cols + column_cols},
            "output_state": _make_state(output_state["columns"], [], output_state.get("index_columns", 0)),
        },
        {
            "message": (f"Each cell combines the {', '.join(map(repr, value_cols)) or 'values'} of the rows that "
                        f"fall into it, using {agg}. A cell with no rows is NaN (shown blank)."),
            "input_highlights": {"columns": value_cols},
        },
    ]
    return steps, explanation
