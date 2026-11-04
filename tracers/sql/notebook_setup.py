# Run once in the notebook namespace after the packages and tracer are installed. Loaded by
# apps/sql (as the runtime's setup code) and by contract_test.py.

# Cells are SQL; the tracer opens the notebook's DuckDB connection on first use. Importing duckdb
# here only makes the first cell quicker.
import duckdb
