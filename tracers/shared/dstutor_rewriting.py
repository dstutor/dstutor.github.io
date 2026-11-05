"""What the tracers that rewrite each cell share (pandas, polars).

The runtime loads this file as the module dstutor_rewriting before the tracer
(RuntimeConfig.modules); under CPython the tests put tracers/shared on sys.path. It holds:

- Log: the steps recorded since the last reset(), capped, each pointing at its line of the cell;
- Rewriter: the AST rewrite that sends method calls, subscripts and column assignments through the
  tracer's helpers (_dstutor_method, _dstutor_getitem, _dstutor_setitem), which do exactly what
  the original code did and record a step when the object is one the tracer knows;
- the formatting every walkthrough uses: values as Python prints them, plurals, preview tables.
"""
import ast

MAX_TRACE_RECORDS = 200
MAX_ROWS_PREVIEW = 20
# Groups, keys or rows walked through one by one before the rest are summed up
MAX_GROUP_STEPS = 4


# ---------------------------------------------------------------------------------------------
# Recording

class Log:
    """The steps recorded since the last reset(), as TraceRecord dicts (@dstutor/trace-schema)."""

    def __init__(self):
        # (start_line, end_line, assigned_name_or_None) of each statement in the running cell
        self.statements = []
        self.reset()

    def reset(self):
        self.records = []
        self.counter = 0
        self.truncated = False

    def set_cell_statements(self, statements):
        # innermost statement first, so a call inside a loop body maps to the body's assignment
        self.statements = sorted(((int(a), int(b), t) for a, b, t in statements), key=lambda s: s[1] - s[0])

    def site(self, line):
        for start, end, target in self.statements:
            if start <= line <= end:
                return {"line": line, "stmt_start": start, "stmt_end": end, "target": target}
        return {"line": line, "stmt_start": line, "stmt_end": line, "target": None}

    def add(self, record):
        if len(self.records) >= MAX_TRACE_RECORDS:
            self.truncated = True
            return
        record["step_id"] = self.counter
        self.counter += 1
        # No walkthrough means no sub_steps field at all, not null (the contract allows only a list)
        if record.get("sub_steps") is None:
            record.pop("sub_steps", None)
        self.records.append(record)


# ---------------------------------------------------------------------------------------------
# Rewriting

def helper_call(name, args, node):
    call = ast.Call(func=ast.Name(name, ast.Load()), args=args, keywords=[])
    return ast.copy_location(call, node)


def as_expression(node):
    """A subscript's slice as an expression: `a:b` is only valid inside [], so spell it slice(a, b)."""
    if isinstance(node, ast.Slice):
        none = ast.Constant(None)
        return ast.copy_location(
            ast.Call(func=ast.Name('slice', ast.Load()),
                     args=[node.lower or none, node.upper or none, node.step or none], keywords=[]),
            node)
    if isinstance(node, ast.Tuple):
        return ast.copy_location(ast.Tuple([as_expression(e) for e in node.elts], ast.Load()), node)
    return node


def source(node):
    """The code of node, as the student wrote it (normalised by ast.unparse)."""
    try:
        return ast.unparse(node)
    except Exception:
        return ''


def key_source(node):
    """A subscript's key as written: df[1:3, 'a'] has the key 1:3, 'a' (unparse would add parentheses)."""
    if isinstance(node, ast.Tuple) and node.elts:
        return ', '.join(source(e) for e in node.elts)
    return source(node)


class Rewriter(ast.NodeTransformer):
    """Routes the cell's operations through the tracer's helpers.

    `x.m(...)`, for each m in methods, becomes `_dstutor_method(x, 'm', line, {keyword: source},
    [argument sources], 'x')(...)`, so a step can show each argument (and name each table) as written (an expression
    like pl.col('Price') > 4 is an object by the time it runs). With subscripts=True, `x[key]`
    becomes `_dstutor_getitem(x, key, key_source, line, 'x')` and `df[k] = v` becomes
    `_dstutor_setitem(df, k, v, key_source, line, value_source)`. Sources are captured before
    anything inside them is rewritten, so no _dstutor_* name ever reaches a step.
    """

    def __init__(self, methods, subscripts=True):
        self.methods = set(methods)
        self.subscripts = subscripts

    def visit_Call(self, node):
        func = node.func
        keyword_sources = ast.Dict(keys=[ast.Constant(k.arg) for k in node.keywords if k.arg],
                                   values=[ast.Constant(source(k.value)) for k in node.keywords if k.arg])
        arg_sources = ast.List([ast.Constant(source(a)) for a in node.args], ast.Load())
        # What the method is called on, as written (cones in cones.merge(...)), for naming tables
        receiver_source = source(func.value) if isinstance(func, ast.Attribute) else ''
        self.generic_visit(node)
        if isinstance(func, ast.Attribute) and func.attr in self.methods:
            # The line of `.method`, which is where it sits in a chain split over lines
            line = getattr(func, 'end_lineno', None) or node.lineno
            node.func = helper_call('_dstutor_method', [func.value, ast.Constant(func.attr), ast.Constant(line),
                                                        keyword_sources, arg_sources,
                                                        ast.Constant(receiver_source)], func)
        return node

    def visit_Subscript(self, node):
        if not self.subscripts:
            return self.generic_visit(node)
        key_text = key_source(node.slice)
        # What is indexed, as written (df in df[1:3]), for the step's title
        receiver_source = source(node.value)
        self.generic_visit(node)
        if not isinstance(node.ctx, ast.Load):
            return node
        return helper_call('_dstutor_getitem', [node.value, as_expression(node.slice),
                                                ast.Constant(key_text), ast.Constant(node.lineno),
                                                ast.Constant(receiver_source)], node)

    def visit_Assign(self, node):
        # df['col'] = value: a column added or replaced in place
        if self.subscripts and len(node.targets) == 1 and isinstance(node.targets[0], ast.Subscript):
            target = node.targets[0]
            key_text = key_source(target.slice)
            value_source = source(node.value)
            self.generic_visit(node)
            call = helper_call('_dstutor_setitem', [target.value, as_expression(target.slice), node.value,
                                                    ast.Constant(key_text), ast.Constant(node.lineno),
                                                    ast.Constant(value_source)], node)
            return ast.copy_location(ast.Expr(call), node)
        self.generic_visit(node)
        return node

    def rewrite(self, tree):
        return ast.fix_missing_locations(self.visit(tree))


# ---------------------------------------------------------------------------------------------
# Formatting

def fmt_val(v):
    """A value the way a message prints it: strings quoted, floats without noise digits."""
    if isinstance(v, dict) and "shown" in v:
        return v["shown"]
    if isinstance(v, str):
        return repr(v)
    if isinstance(v, float):
        rounded = round(v, 4)
        return str(int(rounded)) if rounded == int(rounded) and abs(rounded) < 1e15 else str(rounded)
    if isinstance(v, (list, tuple)):
        return '[' + ', '.join(fmt_val(x) for x in v) + ']'
    return str(v)


def fmt_list(vals, max_items=12):
    shown = ', '.join(fmt_val(v) for v in vals[:max_items])
    if len(vals) > max_items:
        shown += f', … (+{len(vals) - max_items} more)'
    return '[' + shown + ']'


def plural(n, word):
    return f"{n} {word}{'' if n == 1 else 's'}"


def display(value):
    """A cell's value as a message prints it: the library's text for NaN, null and friends."""
    return value["shown"] if isinstance(value, dict) and "shown" in value else value


def truncation_note(state):
    shown = len(state["preview"])
    return f" (showing the first {shown} of {state['num_rows']})" if state["num_rows"] > shown else ""


def make_state(columns, preview, index_columns=0, column_types=None):
    """A TableState for an intermediate table; its first index_columns columns are row labels,
    and column_types (when the library shows them) gives each column's type."""
    state = {"num_rows": len(preview), "num_columns": len(columns), "columns": list(columns),
             "preview": [list(row) for row in preview]}
    if index_columns:
        state["index_columns"] = index_columns
    if column_types is not None:
        state["column_types"] = list(column_types)
    return state


def like(state, preview, column_types=None):
    """An intermediate table with state's columns (row labels and types too), holding preview.
    column_types replaces the types, for a table whose cells hold lists for a while."""
    return make_state(state["columns"], preview, state.get("index_columns", 0),
                      column_types if column_types is not None else state.get("column_types"))


def columns_in(code, state):
    """Columns of state that the code mentions by name, e.g. in cones['Price'] > 4 or pl.col('Price')."""
    return [c for c in state["columns"] if c and (f"'{c}'" in code or f'"{c}"' in code or f'.{c}' in code)]


# ---------------------------------------------------------------------------------------------
# Stages shared by every library (docs/visualizing-steps.md, Stages). Each tracer works out the
# facts (which rows have which key, what each group combined to) the way its library does, then
# these turn them into the same stages, so a join or a group by reads alike in every tutor.

COLOR_SLOTS = 8
MAX_CARDS = 6

_NULL = ('<null>',)


def key_of(value):
    """A cell value as a dictionary key: {"shown": ...} dicts and lists become hashable."""
    if isinstance(value, dict):
        return ('shown', value.get('shown'))
    if isinstance(value, list):
        return ('list', tuple(key_of(v) for v in value))
    return value


def color_slots(keys):
    """A colour slot per distinct key, in first-appearance order; keys past the eighth get none."""
    slots = {}
    for k in keys:
        if k not in slots:
            slots[k] = len(slots) if len(slots) < COLOR_SLOTS else None
    return slots


def chip(value, slot):
    out = {"value": value}
    if slot is not None:
        out["color"] = slot
    return out


def _short_list(values, max_items=6):
    shown = ', '.join(fmt_val(v) for v in values[:max_items])
    return shown + (f', … (+{len(values) - max_items})' if len(values) > max_items else '')


def join_stages(*, left_keys, right_keys, null_matches, keeps, mode, left_name, right_name, key_desc,
                left_state, right_state, left_col, right_col, out_state, out_keys, missing, note,
                order_note, cell):
    """The three stages of a join: which keys match, how rows pair, the result.

    left_keys / right_keys: every row's key (whole tables, raw values); out_keys: the key of each
    output preview row; keeps: the regions kept ('left_only', 'both', 'right_only'); mode is
    'pairs' (inner/left/right/full: rows multiply) or 'semi' / 'anti' (left rows kept or not).
    """
    def norm(v):
        if v is None or (isinstance(v, float) and v != v):
            return _NULL
        return key_of(v)
    lk, rk = [norm(v) for v in left_keys], [norm(v) for v in right_keys]
    # Null keys match each other only where the library says so (pandas: NaN matches NaN)
    matchable = lambda k: k != _NULL or null_matches
    left_set = {k for k in lk if matchable(k)}
    right_set = {k for k in rk if matchable(k)}
    shared = left_set & right_set
    first_cell = {}
    for raw, k in list(zip(left_keys, lk)) + list(zip(right_keys, rk)):
        first_cell.setdefault(k, cell(raw))
    order = list(dict.fromkeys(lk + rk))
    slots = color_slots(order)

    def region(k, side):
        if k in shared:
            return 'both'
        return 'left_only' if side == 'left' else 'right_only'
    left_only = [k for k in dict.fromkeys(lk) if k not in shared]
    right_only = [k for k in dict.fromkeys(rk) if k not in shared]
    both = [k for k in order if k in shared]
    chips = lambda ks: [chip(first_cell[k], slots[k]) for k in ks]
    left_colors = [slots[k] for k in lk[:len(left_state["preview"])]]
    right_colors = [slots[k] for k in rk[:len(right_state["preview"])]]
    aux = lambda highlights: {"label": right_name, "state": right_state, "highlights": highlights}

    counts_l, counts_r = {}, {}
    for k in lk:
        counts_l[k] = counts_l.get(k, 0) + 1
    for k in rk:
        counts_r[k] = counts_r.get(k, 0) + 1

    def rows_of(k):
        l, r = counts_l.get(k, 0), counts_r.get(k, 0)
        if mode == 'semi':
            return l if k in shared else 0
        if mode == 'anti':
            return l if k not in shared else 0
        if k in shared:
            return l * r
        if l and 'left_only' in keeps:
            return l
        if r and 'right_only' in keeps:
            return r
        return 0
    if mode in ('semi', 'anti'):
        keeps = ['both'] if mode == 'semi' else ['left_only']
        pair_keys = list(dict.fromkeys(lk))
    else:
        pair_keys = list(dict.fromkeys([k for k in map(norm, out_keys)] + both + left_only + right_only))
    total = out_state["num_rows"]
    pairs = [{"key": chip(first_cell[k], slots[k]), "left": counts_l.get(k, 0), "right": counts_r.get(k, 0),
              "rows": rows_of(k)} for k in pair_keys if k in first_cell]
    shown = pairs[:MAX_CARDS]
    dropped_left = [i for i, k in enumerate(lk[:len(left_state["preview"])]) if rows_of(k) == 0]
    dropped_right = ([i for i, k in enumerate(rk[:len(right_state["preview"])]) if region(k, 'right') not in keeps]
                     if mode == 'pairs' else [])
    kept_regions = ', '.join({'left_only': f'keys only in {left_name}', 'both': 'keys in both',
                              'right_only': f'keys only in {right_name}'}[r] for r in keeps)
    out_slots = [slots.get(norm(k)) for k in out_keys]

    steps = [
        {
            "stage": "Which keys match",
            "message": (f"First, which values of {key_desc} are in which table: {plural(len(both), 'key')} "
                        f"in both, {len(left_only)} only in {left_name}, {len(right_only)} only in {right_name}. "
                        f"This join keeps rows for {kept_regions}."),
            "input_highlights": {"columns": [left_col], "row_colors": left_colors},
            "aux_table": aux({"columns": [right_col], "row_colors": right_colors}),
            "panel": {"kind": "keys", "key": key_desc, "left": left_name, "right": right_name,
                      "left_only": chips(left_only), "both": chips(both), "right_only": chips(right_only),
                      "keeps": list(keeps)},
            "output_label": "Keys on each side",
        },
        {
            "stage": "How rows pair",
            "message": ("Each kept row stays once; a join like this never repeats a row." if mode in ('semi', 'anti') else
                        "Each key pairs every one of its rows on the left with every one on the right, so a key on "
                        "2 left rows and 1 right row makes 2 rows. Keys with no match are kept on their own, or "
                        "dropped (struck through)."),
            "input_highlights": {"columns": [left_col], "row_colors": left_colors, "rows_removed": dropped_left},
            "aux_table": aux({"columns": [right_col], "row_colors": right_colors, "rows_removed": dropped_right}),
            "panel": {"kind": "pairs", "pairs": shown, "total": total,
                      **({"more": len(pairs) - len(shown)} if len(pairs) > len(shown) else {})},
            "output_label": "Rows each key makes",
        },
        {
            "stage": "Result",
            "message": (f"The result: {plural(total, 'row')}, coloured by key"
                        + (f", {missing} where a side had no match." if mode == 'pairs' and len(keeps) > 1 else ".")
                        + (f" {order_note}" if order_note else "")),
            "input_highlights": {"columns": [left_col], "row_colors": left_colors},
            "aux_table": aux({"columns": [right_col], "row_colors": right_colors}),
            "output_highlights": {"row_colors": out_slots},
        },
    ]
    if note:
        steps[1]["note"] = note
    return steps


def group_stages(*, key_names, groups, input_state, out_state, key_columns, value_columns, note, order_note):
    """The three stages of a group by: sort rows into groups, combine each, one row per group.

    groups: one per output preview row, in output order: {"key": [cells], "members": [input row
    positions], "size": rows in the group, "values": [{"column", "values": [cells], "result": cell,
    "fn": name}]}. value_columns: the input columns whose values are gathered.
    """
    slots = color_slots(range(len(groups)))
    member_slot = {}
    for gi, g in enumerate(groups):
        for m in g["members"]:
            member_slot[m] = slots[gi]
    n_preview = len(input_state["preview"])
    row_colors = [member_slot.get(i) for i in range(n_preview)]
    shown = groups[:MAX_CARDS]
    more = {"more": out_state["num_rows"] - len(shown)} if out_state["num_rows"] > len(shown) else {}

    def cards(combined):
        out = []
        for gi, g in enumerate(shown):
            values = []
            for v in g["values"]:
                entry = {"column": v["column"], "values": v["values"]}
                if combined:
                    entry["result"] = v["result"]
                    args = _short_list(v["values"]) if v["values"] else ''
                    # COUNT(*) is already a whole call; mean becomes mean(4.75, 5.25)
                    call = v['fn'] if v['fn'].endswith(')') else f"{v['fn']}({args})"
                    entry["formula"] = f"{call} = {fmt_val(display(v['result']))}"
                values.append(entry)
            card = {"key": g["key"], "rows": g["size"], "values": values}
            if slots[gi] is not None:
                card["color"] = slots[gi]
            out.append(card)
        return out
    named = ', '.join(map(repr, key_names))
    used = [c for c in key_columns + value_columns if c in input_state["columns"]]
    steps = [
        {
            "stage": "Sort rows into groups",
            "message": (f"Rows with the same {named} go into one group, one colour each: "
                        f"{plural(out_state['num_rows'], 'group')}." + truncation_note(input_state)),
            "input_highlights": {"columns": used, "row_colors": row_colors},
            "panel": {"kind": "groups", "keys": list(key_names), "groups": cards(False), **more},
            "output_label": "Groups",
        },
        {
            "stage": "Combine each group",
            "message": "Each group's values are combined into one value, one group at a time.",
            "input_highlights": {"columns": used, "row_colors": row_colors},
            "panel": {"kind": "groups", "keys": list(key_names), "groups": cards(True), **more},
            "output_label": "Each group combined",
        },
        {
            "stage": "One row per group",
            "message": f"Each group is now one row of the result.{(' ' + order_note) if order_note else ''}",
            "input_highlights": {"columns": used, "row_colors": row_colors},
            "output_highlights": {"row_colors": [slots[i] if i < len(groups) else None
                                                 for i in range(len(out_state["preview"]))]},
        },
    ]
    if note:
        steps[1]["note"] = note
    return steps


def table_name(code, fallback):
    """A table's name for a stage: the variable it was written as (cones), else fallback."""
    return code if code and code.isidentifier() else fallback
