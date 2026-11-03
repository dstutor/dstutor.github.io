"""Notebook cell runner, shared by every tutor.

The worker loads this file as its own module (so none of these names land in the notebook) and
calls run_cell() once per cell. The tracer snapshot tests load the same file under CPython, so
they exercise exactly the code the app runs.
"""
import ast
import contextlib
import io
import linecache
import traceback

CELL_FILENAME = '<cell>'
# Frames from these files are the runtime's own (this runner, the tracer, the worker's glue);
# they are hidden from tracebacks shown to the student.
HIDDEN_FILENAMES = ('<exec>', '<runner>', '<tracer>')

# Plots draw off-screen; figures left open after a cell are captured as PNGs (like
# %matplotlib inline).
try:
    import matplotlib
    matplotlib.use('agg')
    import matplotlib.pyplot as plt
    plt.show = lambda *a, **k: None
    import warnings
    warnings.filterwarnings('ignore', message='.*non-interactive.*')
except ImportError:
    plt = None


def capture_figures():
    if plt is None:
        return []
    import base64
    out = []
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', dpi=144, bbox_inches='tight', facecolor=fig.get_facecolor())
        out.append({"png": base64.b64encode(buf.getvalue()).decode('ascii'), "width": int(fig.get_figwidth() * 96)})
    plt.close('all')
    return out


def close_figures():
    if plt is not None:
        plt.close('all')


def _target_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Tuple):
        return ', '.join(_target_name(e) or '_' for e in node.elts)
    try:
        return ast.unparse(node)
    except Exception:
        return None


def cell_statements(tree):
    """Where each statement is and what it assigns, so steps can point back at the code."""
    stmts = []
    for n in ast.walk(tree):
        if isinstance(n, ast.Assign) and n.targets:
            stmts.append((n.lineno, getattr(n, 'end_lineno', n.lineno), _target_name(n.targets[0])))
        elif isinstance(n, (ast.AnnAssign, ast.AugAssign)):
            stmts.append((n.lineno, getattr(n, 'end_lineno', n.lineno), _target_name(n.target)))
        elif isinstance(n, (ast.Expr, ast.Return)):
            stmts.append((n.lineno, getattr(n, 'end_lineno', n.lineno), None))
    return stmts


def run_cell(code, tracer, namespace):
    """Run code like a notebook cell in namespace: every statement, then the value of a trailing
    bare expression (so a cell ending in `t` or `t.where(...)` shows its table).

    Returns {stdout, stderr, error, result, images}. Errors are formatted here, keeping any
    output and traced steps from before the failure.
    """
    # Register the cell source so tracebacks can quote the offending line
    linecache.cache[CELL_FILENAME] = (len(code), None, code.splitlines(True), CELL_FILENAME)
    stdout, stderr = io.StringIO(), io.StringIO()
    error = None
    result = None
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        try:
            # IPython line magics (%matplotlib inline, %%time, ...) have no meaning here; blank
            # them out but keep the line count so tracebacks still point at the right line
            code = '\n'.join('' if line.lstrip().startswith('%') else line for line in code.split('\n'))
            tree = ast.parse(code, CELL_FILENAME)
            tracer.set_cell_statements(cell_statements(tree))
            # A tracer that rewrites code (pandas) wraps the calls it traces before the cell runs;
            # one that patches its library (datascience) has no transform
            transform = getattr(tracer, 'transform', None)
            if transform is not None:
                tree = transform(tree)
            last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, CELL_FILENAME, 'exec'), namespace)
            if last is not None:
                value = eval(compile(ast.Expression(last.value), CELL_FILENAME, 'eval'), namespace)
                if value is not None:
                    result = repr(value)
        except BaseException as e:
            te = traceback.TracebackException.from_exception(e)
            te.stack = traceback.StackSummary.from_list([f for f in te.stack if f.filename not in HIDDEN_FILENAMES])
            error = ''.join(te.format())
    return {
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "error": error,
        "result": result,
        "images": capture_figures(),
    }
