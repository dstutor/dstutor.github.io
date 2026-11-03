# Example gallery

`examples.json` is the whole Examples gallery. Edit it to add, remove or reorder examples;
no code change is needed. Each entry is a small notebook:

```json
{
  "id": "filter-rows",                  // unique, letters/digits/dashes; used in ?example= links
  "title": "Filtering Rows",
  "description": "Keep only rows that match a condition",
  "category": "filtering",              // must be one of the ids in "categories"
  "operations": ["where"],              // Table methods shown as badges on the card
  "markdown": "## Filtering rows ...",  // the note above the code (Markdown)
  "cells": [                            // one string per code cell, run top to bottom
    "from datascience import *",
    "students = Table().with_columns(...)\nstudents",
    "cs_students = students.where('Major', 'CS')\ncs_students"
  ]
}
```

Conventions that make examples read well in the tool:

- Start with the import cell (`from datascience import *`, plus `import numpy as np` and the
  matplotlib setup when the example plots), exactly as lecture notebooks do.
- End a cell with the bare table name (`students`) rather than `print` or `.show()`; the value
  of a trailing expression is shown under the cell, as in Jupyter.
- Keep tables to about 4 to 8 rows so every row fits in the visualization.
- For anything random (`sample`, `shuffle`, `split`) seed numpy in the import cell so the
  walkthrough matches what students see.
- Do not use em dashes in notes.

`npm test` validates the file (unique ids, known categories, non-empty cells).
