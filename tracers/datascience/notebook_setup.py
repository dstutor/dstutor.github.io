# Run once in the notebook namespace after the packages and tracer are installed. Loaded by
# apps/datascience (as the runtime's setup code) and by snapshot_test.py.

# Course materials conventionally assume `from datascience import *`, so code that only does
# `from datascience import Table` (like every built-in example) still has make_array/are.
from datascience import *

# Table.show() calls IPython.display, which has no front end here and just prints
# "<IPython.core.display.HTML object>". Print the text rendering instead, like print(t).
import datascience.tables as __ds_tables
def __show_as_text(self, max_rows=0):
    print(self.as_text(max_rows))
__show_as_text.__doc__ = __ds_tables.Table.show.__doc__
__ds_tables.Table.show = __show_as_text
