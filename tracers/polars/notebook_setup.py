# Run once in the notebook namespace after the packages and tracer are installed. Loaded by
# apps/polars (as the runtime's setup code) and by contract_test.py.

# polars notebooks start with `import polars as pl`; having pl ready means a cell that forgot
# still runs, as it would in most course environments.
import polars as pl
