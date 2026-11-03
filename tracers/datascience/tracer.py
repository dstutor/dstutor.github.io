"""Tracer for the datascience (Data 8) library.

Patches Table methods so each call made from a notebook cell records the table before and
after, an explanation, and for operations with moving parts the sub-steps the frontend plays
as frames. Records follow @dstutor/trace-schema.

The runtime (@dstutor/runtime-pyodide) loads this file as a module and calls install(),
reset(), get_trace(), is_trace_truncated() and set_cell_statements(); run(code) runs code on
its own, for tests and use outside the notebook.
"""
import math

_trace_enabled = False
_trace_log = []
_step_counter = 0
# Only calls made directly from these code filenames are recorded; calls datascience makes
# internally (hist -> select, shuffle -> sample, ...) are not steps a student wrote.
_USER_FILENAMES = {'<cell>'}
# Simulation loops can call sample() thousands of times; keep the trace bounded
MAX_TRACE_RECORDS = 200
_trace_truncated = False
_original_methods = {}
_generating = False  # guards against recursive tracing while building sub-steps
_depth = 0  # suppresses tracing of Table methods called internally by other methods

MAX_ROWS_PREVIEW = 20
MAX_GROUP_STEPS = 8

def enable():
    global _trace_enabled
    if _trace_enabled:
        return
    _trace_enabled = True
    _patch_table_methods()

def disable():
    global _trace_enabled
    _trace_enabled = False

def get_trace():
    return _trace_log.copy()

def clear_trace():
    global _trace_log, _step_counter, _trace_truncated
    _trace_log = []
    _step_counter = 0
    _trace_truncated = False

def is_trace_truncated():
    return _trace_truncated

def _called_from_user_code(depth=2):
    """True when the traced method was invoked from the notebook cell (or a function defined in it)."""
    import sys
    try:
        return sys._getframe(depth).f_code.co_filename in _USER_FILENAMES
    except ValueError:
        return False

# Statements of the cell being run, as (start_line, end_line, assigned_name_or_None); set by
# the runner from the cell's AST so each step can say which line and which variable it belongs to
_cell_statements = []

def set_cell_statements(statements):
    global _cell_statements
    # innermost statement first, so a call inside a loop body maps to the body's assignment
    _cell_statements = sorted(((int(a), int(b), t) for a, b, t in statements), key=lambda x: x[1] - x[0])

def _user_call_site():
    """Where in the cell the traced call was made: its line, the enclosing statement and its target."""
    import sys
    frame = sys._getframe(1)
    while frame is not None and frame.f_code.co_filename not in _USER_FILENAMES:
        frame = frame.f_back
    if frame is None:
        return None
    line = frame.f_lineno
    for start, end, target in _cell_statements:
        if start <= line <= end:
            return {"line": line, "stmt_start": start, "stmt_end": end, "target": target}
    return {"line": line, "stmt_start": line, "stmt_end": line, "target": None}

def _record(trace_record):
    global _trace_truncated
    if len(_trace_log) >= MAX_TRACE_RECORDS:
        _trace_truncated = True
        return
    _trace_log.append(trace_record)

def _json_safe(value):
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if hasattr(value, 'tolist'):
        return _json_safe(value.tolist())
    if hasattr(value, 'item'):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    return str(value)

def _raw_column(table, label):
    """Read a column without going through the (possibly traced) Table.column."""
    original = _original_methods.get('column')
    return original(table, label) if original else table.column(label)

def _capture_table_state(table, max_rows=MAX_ROWS_PREVIEW):
    try:
        num_rows = table.num_rows
        columns = list(table.labels)
        preview_rows = min(num_rows, max_rows)
        preview_data = []

        if preview_rows > 0:
            values = {}
            for col in columns:
                try:
                    values[col] = _raw_column(table, col)
                except Exception:
                    values[col] = None
            for i in range(preview_rows):
                row = []
                for col in columns:
                    try:
                        row.append(_json_safe(values[col][i]))
                    except Exception:
                        row.append(None)
                preview_data.append(row)

        return {
            "num_rows": num_rows,
            "num_columns": len(columns),
            "columns": columns,
            "preview": preview_data,
        }
    except Exception as e:
        return {"error": str(e), "num_rows": 0, "num_columns": 0, "columns": [], "preview": []}

def _make_state(columns, preview):
    """Synthetic TableState for intermediate result tables (no real Table objects)."""
    return {
        "num_rows": len(preview),
        "num_columns": len(columns),
        "columns": list(columns),
        "preview": [list(row) for row in preview],
    }

def _fmt_val(v):
    if isinstance(v, str):
        return repr(v)
    if isinstance(v, float):
        rounded = round(v, 4)
        return str(int(rounded)) if rounded == int(rounded) and abs(rounded) < 1e15 else str(rounded)
    if isinstance(v, list):
        return '[' + ', '.join(_fmt_val(x) for x in v) + ']'
    return str(v)

def _fmt_list(vals, max_items=12):
    shown = ', '.join(_fmt_val(v) for v in vals[:max_items])
    if len(vals) > max_items:
        shown += f', … (+{len(vals) - max_items} more)'
    return '[' + shown + ']'

def _fn_name(fn, fallback='function'):
    return getattr(fn, '__name__', None) or fallback

def _describe_predicate(fn):
    """Best-effort readable form of a datascience predicate, e.g. are.above(90)."""
    inner = getattr(fn, 'f', fn)
    qn = getattr(inner, '__qualname__', '') or ''
    if qn.startswith('are.') and '.<locals>' in qn:
        base = qn.split('.<locals>')[0]
        try:
            cells = [c.cell_contents for c in (inner.__closure__ or [])]
            return f"{base}({', '.join(_fmt_val(_json_safe(c)) for c in cells)})"
        except Exception:
            return base + '(…)'
    name = getattr(fn, '__name__', None)
    return name if name and name != '<lambda>' else None

def _sorted_unique(values):
    uniq = []
    seen = set()
    for v in values:
        key = (type(v).__name__, v)
        if key not in seen:
            seen.add(key)
            uniq.append(v)
    try:
        return sorted(uniq)
    except TypeError:
        return uniq

def _copy_grid(grid):
    return [[cell[:] if isinstance(cell, list) else cell for cell in row] for row in grid]

def _make_explanation(operation, args, kwargs, input_state, output_state):
    # Check if this is table initialization
    is_init = input_state.get("num_rows", 0) == 0 and output_state.get("num_rows", 0) > 0

    if operation == "with_columns" and is_init:
        cols = output_state.get("num_columns", 0)
        rows = output_state.get("num_rows", 0)
        return f"Created table with {cols} columns and {rows} rows"
    elif operation == "with_column" and is_init:
        col_name = args[0] if args else "?"
        return f"Initialized table with column '{col_name}'"
    elif operation == "select":
        selected = list(args) if args else []
        total = input_state.get("num_columns", 0)
        return f"Selected {len(selected)} of {total} columns: {', '.join(str(s) for s in selected)}"
    elif operation == "drop":
        dropped = list(args) if args else []
        remaining = output_state.get("num_columns", 0)
        return f"Dropped {len(dropped)} columns. {remaining} remain."
    elif operation == "with_column":
        col_name = args[0] if args else "?"
        return f"Added column '{col_name}'. Now {output_state.get('num_columns', 0)} columns."
    elif operation == "with_columns":
        num_added = len(args) // 2 if args else 0
        return f"Added {num_added} columns. Now {output_state.get('num_columns', 0)} columns."
    elif operation == "where":
        removed = input_state.get("num_rows", 0) - output_state.get("num_rows", 0)
        kept = output_state.get("num_rows", 0)
        return f"Filtered rows. Kept {kept}, removed {removed}."
    elif operation == "sort":
        col = args[0] if args else "?"
        return f"Sorted by '{col}'."
    elif operation == "group":
        col = args[0] if args else "?"
        num_groups = output_state.get("num_rows", 0)
        return f"Grouped by '{col}'. Created {num_groups} groups."
    elif operation == "join":
        col = args[0] if args else "?"
        return f"Joined on '{col}'."
    elif operation == "pivot":
        pivot_col = args[0] if args else "?"
        rows_col = args[1] if len(args) > 1 else kwargs.get('rows', "?")
        return f"Pivoted table: unique '{pivot_col}' values become columns, unique '{rows_col}' values become rows."
    elif operation == "take":
        n = output_state.get("num_rows", 0)
        return f"Took {n} row{'s' if n != 1 else ''} by position."
    elif operation == "with_row" and is_init:
        return "Initialized table with 1 row."
    elif operation == "with_row":
        return f"Added 1 row. Now {output_state.get('num_rows', 0)} rows."
    elif operation == "with_rows" and is_init:
        n = output_state.get("num_rows", 0)
        return f"Initialized table with {n} row{'s' if n != 1 else ''}."
    elif operation == "with_rows":
        added = output_state.get("num_rows", 0) - input_state.get("num_rows", 0)
        return f"Added {added} row{'s' if added != 1 else ''}. Now {output_state.get('num_rows', 0)} rows."
    elif operation == "apply":
        fname = _fn_display(args[0]) if args else "the function"
        cols = [str(c) for c in args[1:]]
        target = f"the '{cols[0]}' value" if len(cols) == 1 else (f"the values in {', '.join(repr(c) for c in cols)}" if cols else "the whole row")
        n = output_state.get("num_rows", 0)
        return f"Called {fname} on {target} of each of the {n} rows and collected the results in an array."
    elif operation == "column":
        label = output_state.get("columns", ["?"])[0]
        n = output_state.get("num_rows", 0)
        return f"Took the {n} values of column '{label}' as an array."
    elif operation == "sample":
        n = output_state.get("num_rows", 0)
        replace = kwargs.get('with_replacement', args[1] if len(args) > 1 else True)
        how = "with replacement, so a row can appear more than once" if replace else "without replacement"
        return f"Drew {n} row{'s' if n != 1 else ''} at random {how}."
    elif operation == "shuffle":
        return "Put all the rows in a random order."
    elif operation == "split":
        k = args[0] if args else kwargs.get('k', '?')
        rest = input_state.get("num_rows", 0) - output_state.get("num_rows", 0)
        return f"Shuffled the rows, then split them: {k} in the first table, {rest} in the second."
    else:
        return f"Applied {operation}."

def _serialize_args(args):
    if isinstance(args, dict):
        return {k: _serialize_args(v) for k, v in args.items()}
    elif isinstance(args, (list, tuple)):
        return [_serialize_args(item) for item in args]
    elif callable(args):
        return _describe_predicate(args) or _fn_name(args, '<function>')
    else:
        return _json_safe(args)

# ---------------------------------------------------------------------------
# Sub-step generation: pedagogical walkthrough frames per operation.
# Generators read tables via _raw_column()/.labels so they never re-enter the tracer
# (Table.column itself is traced).
# ---------------------------------------------------------------------------

def _column_values(table, label):
    return [_json_safe(v) for v in _raw_column(table, label)]

def _preview_len(state):
    return len(state.get("preview", []))

def _truncation_note(state):
    total = state.get("num_rows", 0)
    shown = _preview_len(state)
    return f" (showing first {shown} of {total} rows)" if total > shown else ""

def _sub_steps_group(table, args, kwargs, input_state, output_state):
    label = args[0] if args else kwargs.get('label')
    if not isinstance(label, str) or label not in input_state["columns"]:
        return None
    collect = args[1] if len(args) > 1 else kwargs.get('collect')
    count_mode = collect is None
    fname = None if count_mode else _fn_name(collect)

    col_vals = _column_values(table, label)
    uniq = _sorted_unique(col_vals)
    out_cols = output_state["columns"]
    out_first = [row[0] for row in output_state["preview"]]
    # Our computed groups must match what datascience actually produced,
    # otherwise (NaN keys, dtype surprises) fall back to plain before/after.
    if len(uniq) != output_state["num_rows"] or uniq[:len(out_first)] != out_first:
        return None

    # Map each result column back to the source column it aggregates.
    other_cols = [c for c in input_state["columns"] if c != label]
    if count_mode:
        if out_cols != [label, 'count']:
            return None
        sources = []
    else:
        sources = []
        for oc in out_cols[1:]:
            src = next((c for c in other_cols if oc == c or oc.startswith(c + ' ')), None)
            if src is None:
                return None
            sources.append(src)
    source_vals = {c: _column_values(table, c) for c in sources}

    note = _truncation_note(input_state)
    n_preview = _preview_len(input_state)
    steps = []

    if count_mode:
        intro = (f"group('{label}') collapses rows that share the same value in '{label}'. "
                 f"With no function given, it counts the rows in each group.")
    else:
        intro = (f"group('{label}', {fname}) collapses rows that share the same value in '{label}', "
                 f"then applies {fname} to the other columns. Each result column is named after "
                 f"its source column and the function.")
    steps.append({
        "message": intro,
        "input_highlights": {"columns": [label]},
        "output_state": _make_state(out_cols, []),
    })

    steps.append({
        "message": f"Find the unique values in '{label}'. Each one becomes exactly one row of the result.",
        "detail": f"Unique values (sorted): {_fmt_list(uniq)}",
        "input_highlights": {"columns": [label]},
        "output_state": _make_state(out_cols, []),
    })

    show_all = len(uniq) <= MAX_GROUP_STEPS + 1
    shown_groups = len(uniq) if show_all else MAX_GROUP_STEPS
    partial = []
    for gi, gv in enumerate(uniq):
        match_rows = [i for i in range(n_preview) if col_vals[i] == gv]
        total_matches = sum(1 for v in col_vals if v == gv)
        if count_mode:
            partial.append([gv, total_matches])
        else:
            all_rows = [i for i, v in enumerate(col_vals) if v == gv]
            partial.append([gv] + [[source_vals[c][i] for i in all_rows] for c in sources])
        if gi < shown_groups:
            if count_mode:
                msg = (f"{_fmt_val(gv)}: {total_matches} matching row{'s' if total_matches != 1 else ''} "
                       f"→ count = {total_matches}.{note}")
            else:
                msg = (f"{_fmt_val(gv)}: collect the values from each matching row into an array, "
                       f"one array per column.{note}")
            steps.append({
                "message": msg,
                "input_highlights": {"rows": match_rows, "columns": [label]},
                "output_state": _make_state(out_cols, partial),
                "output_highlights": {"rows": [gi]},
            })
    if not show_all:
        remaining = len(uniq) - shown_groups
        steps.append({
            "message": f"…and the remaining {remaining} group{'s' if remaining != 1 else ''} are filled the same way.",
            "output_state": _make_state(out_cols, partial),
            "output_highlights": {"rows": list(range(shown_groups, len(uniq)))},
        })

    if not count_mode:
        steps.append({
            "message": f"Finally, apply {fname} to each array. Every array collapses to a single value.",
            "detail": _apply_example(fname, partial, output_state, len(out_cols)),
        })

    return steps

def _apply_example(fname, grid, output_state, num_cols):
    """Pick an example "fname([...]) = result" line, preferring a numeric result."""
    best = None
    for gi in range(min(len(grid), len(output_state["preview"]))):
        for ci in range(1, num_cols):
            arr = grid[gi][ci]
            if not isinstance(arr, list) or not arr:
                continue
            final_val = output_state["preview"][gi][ci]
            if isinstance(final_val, (int, float)) and not isinstance(final_val, bool):
                return f"{fname}({_fmt_val(arr)}) = {_fmt_val(final_val)}"
            if best is None:
                best = f"{fname}({_fmt_val(arr)}) = {_fmt_val(final_val)}"
    return best

def _sub_steps_pivot(table, args, kwargs, input_state, output_state):
    columns_label = args[0] if args else kwargs.get('columns')
    rows_label = args[1] if len(args) > 1 else kwargs.get('rows')
    values_label = args[2] if len(args) > 2 else kwargs.get('values')
    collect = args[3] if len(args) > 3 else kwargs.get('collect')
    if not isinstance(columns_label, str) or not isinstance(rows_label, str):
        return None
    if columns_label not in input_state["columns"] or rows_label not in input_state["columns"]:
        return None
    count_mode = values_label is None
    if not count_mode and (not isinstance(values_label, str) or values_label not in input_state["columns"]):
        return None
    fname = None if count_mode else _fn_name(collect)

    pivot_vals = _sorted_unique(_column_values(table, columns_label))
    row_vals = _sorted_unique(_column_values(table, rows_label))
    out_cols = output_state["columns"]
    # datascience stringifies pivot values into column labels
    if out_cols[1:] != [str(pv) for pv in pivot_vals]:
        return None
    out_first = [row[0] for row in output_state["preview"]]
    if len(row_vals) != output_state["num_rows"] or row_vals[:len(out_first)] != out_first:
        return None

    cols_data = _column_values(table, columns_label)
    rows_data = _column_values(table, rows_label)
    vals_data = None if count_mode else _column_values(table, values_label)
    n_preview = _preview_len(input_state)
    note = _truncation_note(input_state)

    steps = [
        {
            "message": (f"pivot builds a grid: the unique values of '{columns_label}' become "
                        f"the result's column headers."),
            "detail": f"Unique values in '{columns_label}' (sorted): {_fmt_list(pivot_vals)}",
            "input_highlights": {"columns": [columns_label]},
            "output_state": _make_state(out_cols, []),
        },
    ]

    empty_cell = 0 if count_mode else []
    grid = [[rv] + [empty_cell if count_mode else [] for _ in pivot_vals] for rv in row_vals]
    fill_desc = ("each cell will count how many rows have that (row, column) pair"
                 if count_mode else
                 f"each cell will collect '{values_label}' values, then {fname} combines them")
    steps.append({
        "message": (f"The unique values of '{rows_label}' become the row labels; "
                    f"{fill_desc}. Cells start {'at 0' if count_mode else 'empty'}."),
        "detail": f"Unique values in '{rows_label}' (sorted): {_fmt_list(row_vals)}",
        "input_highlights": {"columns": [rows_label]},
        "output_state": _make_state(out_cols, grid),
    })

    if input_state["num_rows"] <= 10:
        # Spec-faithful: one sub-step per original row
        for i in range(n_preview):
            ri = row_vals.index(rows_data[i])
            ci = 1 + pivot_vals.index(cols_data[i])
            if count_mode:
                grid[ri][ci] += 1
                action = f"increment the count in cell ({_fmt_val(rows_data[i])}, {_fmt_val(cols_data[i])}) to {grid[ri][ci]}"
            else:
                grid[ri][ci] = grid[ri][ci] + [vals_data[i]]
                action = (f"add its '{values_label}' value {_fmt_val(vals_data[i])} to "
                          f"cell ({_fmt_val(rows_data[i])}, {_fmt_val(cols_data[i])})")
            input_hl = {"rows": [i]}
            if not count_mode:
                input_hl["cells"] = [[i, values_label]]
            steps.append({
                "message": f"Row {i} has ({rows_label}={_fmt_val(rows_data[i])}, {columns_label}={_fmt_val(cols_data[i])}) → {action}.",
                "input_highlights": input_hl,
                "output_highlights": {"cells": [[ri, out_cols[ci]]]},
                "output_state": _make_state(out_cols, _copy_grid(grid)),
            })
    else:
        # Consolidated: one sub-step per result row, capped
        show_all = len(row_vals) <= MAX_GROUP_STEPS + 1
        shown = len(row_vals) if show_all else MAX_GROUP_STEPS
        for ri, rv in enumerate(row_vals):
            match_rows = [i for i in range(n_preview) if rows_data[i] == rv]
            for ci, pv in enumerate(pivot_vals):
                matches = [i for i in range(len(rows_data)) if rows_data[i] == rv and cols_data[i] == pv]
                grid[ri][1 + ci] = len(matches) if count_mode else [vals_data[i] for i in matches]
            if ri < shown:
                if count_mode:
                    msg = f"Fill the {_fmt_val(rv)} row: count the rows with each '{columns_label}' value.{note}"
                else:
                    msg = (f"Fill the {_fmt_val(rv)} row: collect the '{values_label}' values of its rows "
                           f"into one array per '{columns_label}' value.{note}")
                steps.append({
                    "message": msg,
                    "input_highlights": {"rows": match_rows, "columns": [rows_label]},
                    "output_highlights": {"rows": [ri]},
                    "output_state": _make_state(out_cols, _copy_grid(grid)),
                })
        if not show_all:
            remaining = len(row_vals) - shown
            steps.append({
                "message": f"…and the remaining {remaining} row{'s' if remaining != 1 else ''} are filled the same way.",
                "output_state": _make_state(out_cols, _copy_grid(grid)),
                "output_highlights": {"rows": list(range(shown, len(row_vals)))},
            })

    if not count_mode:
        steps.append({
            "message": f"Finally, apply {fname} to the array in each cell. Empty cells get a default value.",
            "detail": _apply_example(fname, grid, output_state, len(out_cols)),
        })

    return steps

def _sub_steps_where(table, args, kwargs, input_state, output_state):
    label = args[0] if args else kwargs.get('column_or_label')
    if not isinstance(label, str) or label not in input_state["columns"]:
        return None
    if len(args) > 1:
        condition = args[1]
    elif 'value_or_predicate' in kwargs:
        condition = kwargs['value_or_predicate']
    else:
        return None

    col_vals = _column_values(table, label)
    try:
        if callable(condition):
            mask = [bool(condition(v)) for v in col_vals]
            desc = _describe_predicate(condition)
            cond_desc = (f"the value satisfies {desc}" if desc
                         else "the condition is True for the value")
        else:
            cond = _json_safe(condition)
            mask = [v == cond for v in col_vals]
            cond_desc = f"value == {_fmt_val(cond)}"
    except Exception:
        return None
    if sum(mask) != output_state["num_rows"]:
        return None

    n_preview = _preview_len(input_state)
    kept = [i for i in range(n_preview) if mask[i]]
    removed = [i for i in range(n_preview) if not mask[i]]
    note = _truncation_note(input_state)

    return [
        {
            "message": f"where checks every row's '{label}' value against the condition.",
            "detail": f"Keep rows where {cond_desc}",
            "input_highlights": {"columns": [label]},
            "output_state": _make_state(input_state["columns"], []),
        },
        {
            "message": (f"Keep the {sum(mask)} row{'s' if sum(mask) != 1 else ''} that satisfy the condition; "
                        f"the other {len(mask) - sum(mask)} (struck through) are removed.{note}"),
            "input_highlights": {"rows": kept, "rows_removed": removed, "columns": [label]},
        },
    ]

def _sub_steps_sort(table, args, kwargs, input_state, output_state):
    label = args[0] if args else kwargs.get('column_or_label')
    if not isinstance(label, str) or label not in input_state["columns"]:
        return None
    if kwargs.get('distinct'):
        return None
    descending = kwargs.get('descending', args[1] if len(args) > 1 else False)

    direction = "largest first" if descending else "smallest first"
    steps = [{
        "message": f"sort reorders all rows by their '{label}' value, {direction}. No rows are added or removed.",
        "input_highlights": {"columns": [label]},
    }]
    try:
        import numpy as np
        order = list(np.argsort(_raw_column(table, label), kind='stable'))
        if descending:
            order = order[::-1]
        steps.append({
            "message": "Rows keep all their values. Only their order changes.",
            "detail": f"New order of original row positions (starting at 0): {_fmt_list([int(i) for i in order])}",
            "output_highlights": {"columns": [label]},
        })
    except Exception:
        steps.append({
            "message": "Rows keep all their values. Only their order changes.",
            "output_highlights": {"columns": [label]},
        })
    return steps

def _sub_steps_join(table, args, kwargs, input_state, output_state):
    label = args[0] if args else kwargs.get('column_label')
    other = args[1] if len(args) > 1 else kwargs.get('other')
    other_label = args[2] if len(args) > 2 else kwargs.get('other_label', label)
    if not isinstance(label, str) or label not in input_state["columns"] or other is None:
        return None
    if not (hasattr(other, 'labels') and hasattr(other, 'num_rows')):
        return None
    if not isinstance(other_label, str):
        return None

    aux_state = _capture_table_state(other)
    if other_label not in aux_state["columns"]:
        return None
    left_keys = _column_values(table, label)
    right_keys = _column_values(other, other_label)
    shared = [v for v in _sorted_unique(left_keys) if v in set(right_keys)]

    n_left = _preview_len(input_state)
    n_right = len(aux_state["preview"])
    shared_set = set(shared)
    left_match = [i for i in range(n_left) if left_keys[i] in shared_set]
    right_match = [i for i in range(n_right) if right_keys[i] in shared_set]

    key_desc = (f"'{label}'" if label == other_label
                else f"'{label}' (left) and '{other_label}' (right)")
    return [
        {
            "message": f"join combines two tables: it matches rows whose key columns {key_desc} hold the same value.",
            "input_highlights": {"columns": [label]},
            "aux_table": {"label": "Second table", "state": aux_state,
                          "highlights": {"columns": [other_label]}},
            "output_state": _make_state(output_state["columns"], []),
        },
        {
            "message": "Find the key values that appear in BOTH tables. Only those rows will be joined.",
            "detail": f"Keys found in both tables: {_fmt_list(shared)}",
            "input_highlights": {"rows": left_match, "columns": [label]},
            "aux_table": {"label": "Second table", "state": aux_state,
                          "highlights": {"rows": right_match, "columns": [other_label]}},
            "output_state": _make_state(output_state["columns"], []),
        },
        {
            "message": ("Each pair of rows with equal keys becomes one combined row "
                        "(all columns from both tables). Rows whose key has no match are dropped."),
            "aux_table": {"label": "Second table", "state": aux_state,
                          "highlights": {"rows": right_match, "columns": [other_label]}},
        },
    ]

def _sub_steps_take(table, args, kwargs, input_state, output_state):
    if not args:
        return None
    indices = args[0]
    try:
        if hasattr(indices, 'tolist'):
            indices = indices.tolist()
        if isinstance(indices, range):
            indices = list(indices)
        if isinstance(indices, int):
            indices = [indices]
        indices = [int(i) for i in indices]
    except Exception:
        return None
    if len(indices) != output_state["num_rows"]:
        return None

    n_preview = _preview_len(input_state)
    visible = [i for i in indices if 0 <= i < n_preview]
    return [{
        "message": (f"take picks rows by their position (starting at 0): "
                    f"{_fmt_list(indices)}. The highlighted rows form the new table."),
        "input_highlights": {"rows": visible},
    }]

def _sub_steps_with_rows(table, args, kwargs, input_state, output_state):
    is_init = input_state.get("num_rows", 0) == 0
    added = output_state["num_rows"] - input_state["num_rows"]
    if added <= 0:
        return None
    new_rows = list(range(_preview_len(output_state) - added, _preview_len(output_state)))
    if not new_rows:
        return None
    return [{
        "message": ("Each new row is appended to the table, keeping the same columns."
                    if not is_init else
                    "Each row fills in the column labels given when the table was created."),
        "output_highlights": {"rows": new_rows},
    }]

def _fn_display(fn):
    """How to refer to fn in prose: its name, or 'the function' for a lambda."""
    name = _fn_name(fn)
    return "the function" if name in ("<lambda>", "function") else name

def _apply_label(fn, cols):
    """Column label for apply's result array, e.g. double(Age) or f(Name, Age) for a lambda."""
    name = _fn_name(fn)
    fname = "f" if name in ("<lambda>", "function") else name
    return f"{fname}({', '.join(str(c) for c in cols)})" if cols else f"{fname}(row)"

# Per-row walkthroughs show every row for small tables, otherwise the first few and a summary
MAX_ROW_FRAMES = 6

def _sub_steps_apply(table, args, kwargs, input_state, output_state):
    if not args or not callable(args[0]):
        return None
    fn = args[0]
    cols = list(args[1:])
    if len(cols) == 1 and isinstance(cols[0], (list, tuple)):
        cols = list(cols[0])
    labels = input_state["columns"]
    for c in cols:
        if isinstance(c, int) and 0 <= c < len(labels):
            continue
        if c not in labels:
            return None
    cols = [labels[c] if isinstance(c, int) else c for c in cols]
    label = _apply_label(fn, cols)
    fname = _fn_display(fn)
    results = [row[0] for row in output_state["preview"]]
    n_preview = min(_preview_len(input_state), len(results))
    if n_preview == 0:
        return None
    col_vals = {c: _column_values(table, c) for c in cols}
    n_total = output_state["num_rows"]

    if cols:
        what = f"the '{cols[0]}' value" if len(cols) == 1 else f"the {', '.join(repr(c) for c in cols)} values"
        intro = (f"apply calls {fname} once per row, passing in {what}. "
                 f"The {n_total} results are collected into an array, in row order.")
    else:
        intro = (f"apply calls {fname} once per row, passing in the whole row. "
                 f"The {n_total} results are collected into an array, in row order.")
    steps = [{
        "message": intro,
        "input_highlights": {"columns": cols},
        "output_state": _make_state([label], []),
        "output_label": "Result array",
    }]

    per_row = n_preview if n_preview <= MAX_ROW_FRAMES else MAX_ROW_FRAMES - 1
    all_vals = {c: _column_values(table, c) for c in labels} if not cols else {}
    for i in range(per_row):
        if cols:
            arg_text = ", ".join(_fmt_val(col_vals[c][i]) for c in cols)
            message = f"Row {i}: {fname} is called with {arg_text} and returns {_fmt_val(results[i])}."
            detail = f"{label.split('(')[0]}({arg_text}) = {_fmt_val(results[i])}"
        else:
            row_text = ", ".join(f"{c}={_fmt_val(all_vals[c][i])}" for c in labels)
            message = f"Row {i}: {fname} is called with the whole row ({row_text}) and returns {_fmt_val(results[i])}."
            detail = f"{label.split('(')[0]}(row {i}) = {_fmt_val(results[i])}"
        steps.append({
            "message": message,
            "detail": detail,
            "input_highlights": {"rows": [i], "columns": cols},
            "output_state": _make_state([label], [[results[k]] for k in range(i + 1)]),
            "output_highlights": {"cells": [[i, label]]},
            "output_label": "Result array (building)",
        })
    if per_row < n_preview:
        steps.append({
            "message": f"The same happens for the remaining {n_total - per_row} rows.",
            "input_highlights": {"rows": list(range(per_row, n_preview)), "columns": cols},
            "output_state": _make_state([label], [[results[k]] for k in range(n_preview)]),
            "output_highlights": {"rows": list(range(per_row, n_preview))},
            "output_label": "Result array (building)",
        })
    steps.append({
        "message": (f"The result is an array of {n_total} values, one per row. It is not a table: to keep it, "
                    f"assign it to a name or pass it to with_column."),
        "output_label": "Result array",
    })
    return steps

def _first_column_summary(input_state, idx):
    """Short description of a row for messages, e.g. row 3 (Bob)."""
    preview = input_state.get("preview", [])
    if 0 <= idx < len(preview) and preview[idx]:
        return f"row {idx} ({_fmt_val(preview[idx][0])})"
    return f"row {idx}"

def _sub_steps_sample(table, args, kwargs, input_state, output_state):
    indices = _last_random.get("choice")
    if indices is None:
        return None
    indices = [int(i) for i in (indices.tolist() if hasattr(indices, 'tolist') else indices)]
    if len(indices) != output_state["num_rows"]:
        return None
    k = len(indices)
    replace = kwargs.get('with_replacement', args[1] if len(args) > 1 else True)
    weights = kwargs.get('weights', args[2] if len(args) > 2 else None)
    n_in = _preview_len(input_state)
    n_out = _preview_len(output_state)
    cols = output_state["columns"]

    how = ("with replacement: after each draw the row goes back, so the same row can be drawn again"
           if replace else "without replacement: each row can be drawn at most once")
    weighted = " Rows are drawn with the given weights, not equally." if weights is not None else ""
    steps = [{
        "message": f"sample draws {k} row{'s' if k != 1 else ''} at random, {how}.{weighted}",
        "output_state": _make_state(cols, []),
        "output_label": "Sample (building)",
    }]
    per_draw = n_out if n_out <= MAX_ROW_FRAMES else MAX_ROW_FRAMES - 1
    for i in range(per_draw):
        src = indices[i]
        again = ""
        if replace and src in indices[:i]:
            again = " This row was drawn before."
        steps.append({
            "message": f"Draw {i + 1}: {_first_column_summary(input_state, src)} is chosen and copied into the sample.{again}",
            "input_highlights": {"rows": [src] if src < n_in else []},
            "output_state": _make_state(cols, output_state["preview"][:i + 1]),
            "output_highlights": {"rows": [i]},
            "output_label": "Sample (building)",
        })
    if per_draw < n_out:
        steps.append({
            "message": f"The remaining {k - per_draw} draws work the same way.",
            "input_highlights": {"rows": sorted({j for j in indices[per_draw:] if j < n_in})},
            "output_highlights": {"rows": list(range(per_draw, n_out))},
            "output_label": "Sample",
        })
    steps.append({
        "message": f"The sample is a new table of {k} row{'s' if k != 1 else ''} with the same columns.",
        "detail": f"Original row positions drawn (starting at 0): {_fmt_list(indices)}",
        "output_label": "Sample",
    })
    return steps

def _sub_steps_shuffle(table, args, kwargs, input_state, output_state):
    order = _last_random.get("choice")
    if order is None:
        return None
    order = [int(i) for i in (order.tolist() if hasattr(order, 'tolist') else order)]
    if len(order) != output_state["num_rows"]:
        return None
    n_in = _preview_len(input_state)
    return [
        {
            "message": "shuffle draws every row exactly once, in a random order. No row is added, removed or changed.",
            "output_state": _make_state(output_state["columns"], []),
        },
        {
            "message": "The rows land in the order they were drawn.",
            "detail": f"New order of original row positions (starting at 0): {_fmt_list(order)}",
            "input_highlights": {"rows": [i for i in order[:_preview_len(output_state)] if i < n_in]},
        },
    ]

def _sub_steps_split(table, args, kwargs, input_state, output_state):
    perm = _last_random.get("permutation")
    k = args[0] if args else kwargs.get('k')
    if perm is None or not isinstance(k, int):
        return None
    perm = [int(i) for i in (perm.tolist() if hasattr(perm, 'tolist') else perm)]
    if len(perm) != input_state["num_rows"] or output_state["num_rows"] != k:
        return None
    rest_state = _last_extra.get("split_rest")
    if rest_state is None:
        return None
    n_in = _preview_len(input_state)
    first_idx = perm[:k]
    rest_idx = perm[k:]
    n_rest = len(rest_idx)
    rest_aux = {"label": f"Second table ({n_rest} row{'s' if n_rest != 1 else ''})", "state": rest_state}
    return [
        {
            "message": (f"split({k}) shuffles the rows, then puts the first {k} into one table "
                        f"and the remaining {n_rest} into another. Every row ends up in exactly one of them."),
            "output_state": _make_state(output_state["columns"], []),
            "output_label": f"First table ({k} row{'s' if k != 1 else ''})",
            "aux_output": {"label": rest_aux["label"], "state": _make_state(rest_state["columns"], [])},
        },
        {
            "message": f"The first {k} shuffled row{'s' if k != 1 else ''} (highlighted) form the first table.",
            "detail": f"Original row positions (starting at 0): {_fmt_list(first_idx)}",
            "input_highlights": {"rows": [i for i in first_idx if i < n_in]},
            "output_highlights": {"rows": list(range(_preview_len(output_state)))},
            "output_label": f"First table ({k} row{'s' if k != 1 else ''})",
            "aux_output": {"label": rest_aux["label"], "state": _make_state(rest_state["columns"], [])},
        },
        {
            "message": f"The other {n_rest} row{'s' if n_rest != 1 else ''} form{'s' if n_rest == 1 else ''} the second table. Together they cover every original row.",
            "detail": f"Original row positions (starting at 0): {_fmt_list(rest_idx)}",
            "input_highlights": {"rows": [i for i in rest_idx if i < n_in]},
            "output_label": f"First table ({k} row{'s' if k != 1 else ''})",
            "aux_output": {"label": rest_aux["label"], "state": rest_state,
                           "highlights": {"rows": list(range(len(rest_state["preview"])))}},
        },
    ]

# Random draws made inside the most recent traced call (numpy is wrapped while it runs),
# plus extra results such as the second half of a split
_last_random = {}
_last_extra = {}

_RANDOM_CAPTURE = {
    "sample": ["choice"],
    "shuffle": ["choice"],
    "split": ["permutation"],
}

def _call_capturing_random(op_name, call):
    """Run `call`, recording the first result of each numpy.random function the operation uses."""
    _last_random.clear()
    _last_extra.clear()
    names = _RANDOM_CAPTURE.get(op_name)
    if not names:
        return call()
    import numpy as np
    originals = {}
    def recorder(name, original):
        def rec(*a, **k):
            out = original(*a, **k)
            _last_random.setdefault(name, out)
            return out
        return rec
    for name in names:
        originals[name] = getattr(np.random, name)
        setattr(np.random, name, recorder(name, originals[name]))
    try:
        return call()
    finally:
        for name, original in originals.items():
            setattr(np.random, name, original)

def _result_to_state(op_name, args, result):
    """Table results are captured as-is; apply's array becomes a one-column result; split's pair is (first, rest)."""
    if hasattr(result, 'labels') and hasattr(result, 'num_rows'):
        return _capture_table_state(result)
    if op_name == "apply" and args:
        cols = list(args[1:])
        if len(cols) == 1 and isinstance(cols[0], (list, tuple)):
            cols = list(cols[0])
        label = _apply_label(args[0], cols)
        try:
            values = list(result)
        except TypeError:
            values = [result]
        state = _make_state([label], [[_json_safe(v)] for v in values[:MAX_ROWS_PREVIEW]])
        state["num_rows"] = len(values)
        state["kind"] = "array"
        return state
    if op_name == "column" and args:
        label = args[0]
        try:
            values = list(result)
        except TypeError:
            values = [result]
        state = _make_state([str(label)], [[_json_safe(v)] for v in values[:MAX_ROWS_PREVIEW]])
        state["num_rows"] = len(values)
        state["kind"] = "array"
        return state
    if op_name == "split" and isinstance(result, tuple) and len(result) == 2:
        first, rest = result
        if hasattr(first, 'labels') and hasattr(rest, 'labels'):
            _last_extra["split_rest"] = _capture_table_state(rest)
            return _capture_table_state(first)
    return {}

def _sub_steps_column(table, args, kwargs, input_state, output_state):
    if not args:
        return None
    label = args[0]
    labels = input_state["columns"]
    if isinstance(label, int) and 0 <= label < len(labels):
        label = labels[label]
    if label not in labels:
        return None
    n = output_state["num_rows"]
    return [
        {
            "message": (f"column('{label}') reads the '{label}' column top to bottom and returns its "
                        f"{n} value{'s' if n != 1 else ''} as an array."),
            "input_highlights": {"columns": [label]},
            "output_label": "Result array",
        },
        {
            "message": "The values keep their row order. The result is an array, not a table.",
            "input_highlights": {"columns": [label]},
            "output_highlights": {"columns": [str(label)]},
            "output_label": "Result array",
        },
    ]

_SUB_STEP_GENERATORS = {
    "column": _sub_steps_column,
    "apply": _sub_steps_apply,
    "sample": _sub_steps_sample,
    "shuffle": _sub_steps_shuffle,
    "split": _sub_steps_split,
    "group": _sub_steps_group,
    "pivot": _sub_steps_pivot,
    "where": _sub_steps_where,
    "sort": _sub_steps_sort,
    "join": _sub_steps_join,
    "take": _sub_steps_take,
    "with_rows": _sub_steps_with_rows,
}

def _make_sub_steps(operation, table, args, kwargs, input_state, output_state):
    generator = _SUB_STEP_GENERATORS.get(operation)
    if generator is None or not output_state or output_state.get("error"):
        return None
    global _generating
    _generating = True
    try:
        steps = generator(table, args, kwargs, input_state, output_state)
        return steps if steps else None
    except Exception:
        return None
    finally:
        _generating = False

def _trace_operation(operation_name):
    def decorator(original_method):
        def wrapper(self, *args, **kwargs):
            global _step_counter, _depth

            if _generating or not _trace_enabled or _depth > 0 or not _called_from_user_code():
                return original_method(self, *args, **kwargs)

            input_state = _capture_table_state(self)
            is_empty_before = input_state.get("num_rows", 0) == 0

            _depth += 1
            try:
                result = _call_capturing_random(operation_name, lambda: original_method(self, *args, **kwargs))
            finally:
                _depth -= 1
            state_args = args
            if operation_name == "column" and args and isinstance(args[0], int) and 0 <= args[0] < len(input_state["columns"]):
                state_args = (input_state["columns"][args[0]],) + tuple(args[1:])
            output_state = _result_to_state(operation_name, state_args, result)

            # SKIP with_column entirely when starting from empty table
            # (it's always part of with_columns initialization)
            should_skip = operation_name == "with_column" and is_empty_before

            # If this is with_columns on empty table, clean up any leaked traces
            if operation_name == "with_columns" and is_empty_before:
                # Remove ALL with_column traces from initialization
                _trace_log[:] = [t for t in _trace_log if t.get("operation") != "with_column"]
                # Reset counter since we removed traces
                _step_counter = len(_trace_log)

            explanation = _make_explanation(operation_name, args, kwargs, input_state, output_state)

            if not should_skip:
                _step_counter += 1
                trace_record = {
                    "step_id": _step_counter,
                    "operation": operation_name,
                    "args": _serialize_args(args),
                    "kwargs": _serialize_args(kwargs),
                    "input": input_state,
                    "output": output_state,
                    "explanation": explanation,
                    "site": _user_call_site(),
                }
                sub_steps = _make_sub_steps(operation_name, self, args, kwargs, input_state, output_state)
                if sub_steps:
                    trace_record["sub_steps"] = sub_steps
                _record(trace_record)

            return result
        return wrapper
    return decorator

def _patch_take():
    # Instances shadow Table.take with a _RowTaker set in __init__, so the
    # class-level patch never fires; trace the selector's __getitem__ instead.
    try:
        from datascience.tables import _RowTaker
    except ImportError:
        return
    if '_row_taker_getitem' in _original_methods:
        return
    original = _RowTaker.__getitem__
    _original_methods['_row_taker_getitem'] = original

    def _take_called_from_user_code():
        # t.take(3) reaches __getitem__ via _RowTaker.__call__, t.take[0:3] reaches it directly
        import sys
        try:
            caller = sys._getframe(2)
        except ValueError:
            return False
        if caller.f_code.co_filename in _USER_FILENAMES:
            return True
        if caller.f_code.co_name == '__call__' and caller.f_back is not None:
            return caller.f_back.f_code.co_filename in _USER_FILENAMES
        return False

    def traced_getitem(selector, row_indices):
        global _step_counter, _depth
        if _generating or not _trace_enabled or _depth > 0 or not _take_called_from_user_code():
            return original(selector, row_indices)
        table = selector._table
        input_state = _capture_table_state(table)
        _depth += 1
        try:
            result = original(selector, row_indices)
        finally:
            _depth -= 1
        output_state = {}
        if hasattr(result, 'labels') and hasattr(result, 'num_rows'):
            output_state = _capture_table_state(result)
        args = (row_indices,)
        _step_counter += 1
        trace_record = {
            "step_id": _step_counter,
            "operation": "take",
            "args": _serialize_args(args),
            "kwargs": {},
            "input": input_state,
            "output": output_state,
            "explanation": _make_explanation("take", args, {}, input_state, output_state),
            "site": _user_call_site(),
        }
        sub_steps = _make_sub_steps("take", table, args, {}, input_state, output_state)
        if sub_steps:
            trace_record["sub_steps"] = sub_steps
        _record(trace_record)
        return result

    _RowTaker.__getitem__ = traced_getitem

def _patch_table_methods():
    try:
        from datascience import Table
    except ImportError:
        print("⚠️ datascience not found")
        return
    operations = ["select", "drop", "with_column", "with_columns", "with_row", "with_rows", "where", "sort", "group", "join", "pivot",
                  "apply", "sample", "shuffle", "split", "column"]
    for op_name in operations:
        if hasattr(Table, op_name):
            original = getattr(Table, op_name)
            if op_name not in _original_methods:
                _original_methods[op_name] = original
            traced = _trace_operation(op_name)(original)
            setattr(Table, op_name, traced)
    _patch_take()
    print("✓ Table methods patched for tracing")


# The interface every tracer exposes

def install():
    """Patch the library so later calls from user code are recorded. Idempotent."""
    enable()


def reset():
    """Forget every recorded step."""
    clear_trace()


def run(code):
    """Run code as a fresh notebook cell and return the TraceRecord dicts it produced."""
    install()
    reset()
    set_cell_statements([])
    exec(compile(code, '<cell>', 'exec'), {'__name__': '__main__'})
    return get_trace()
