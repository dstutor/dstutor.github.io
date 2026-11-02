"""Tracer for the datascience (Data 8) library.

Every tracer exposes the same three functions. Phase 1 ports the method-patching tracer
from table-function-visualizer (apps/web/src/lib/tracer.py) into this module.
"""


def install():
    """Patch the library so later calls are recorded."""
    raise NotImplementedError("ported in phase 1")


def run(code):
    """Run code and return the list of TraceRecord dicts it produced."""
    raise NotImplementedError("ported in phase 1")


def reset():
    """Clear recorded traces and user state."""
    raise NotImplementedError("ported in phase 1")
