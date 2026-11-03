# Run once in the notebook namespace after the packages and tracer are installed. Loaded by
# apps/pandas (as the runtime's setup code) and by contract_test.py.

# pandas notebooks start with `import pandas as pd`; having pd and np ready means a cell that
# forgot still runs, as it would in most course environments.
import pandas as pd
import numpy as np
