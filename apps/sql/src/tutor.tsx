// Everything that makes the shared TutorApp the SQL tutor: SQL cells, run on DuckDB.
import type { TutorConfig } from '@dstutor/notebook-ui';
import { runtime } from './runtime';
import { gallery } from './examples';

const DEFAULT_MARKDOWN = `## How to use this notebook

- **Cells:** Click a cell's margin to select it, press **Enter** to edit and **Esc** to get back. In this mode single keys act on the selected cell, like Jupyter: **a**/**b** add a cell above/below, **d d** deletes, **m**/**y** switch it to markdown/SQL, **z** undoes a delete.
- **Running:** Cells are SQL, run on DuckDB. **Ctrl+Enter** (**Cmd+Enter** on Mac) runs a cell; **Shift+Enter** runs it and moves on. The result of a cell's last query is shown beneath it. **Run all** runs every cell top to bottom; **Restart** forgets every table.
- **Visualize:** **Run all & visualize** runs everything and shows each query clause by clause, in the order SQL runs them: FROM, WHERE, GROUP BY, HAVING, SELECT, ORDER BY, LIMIT. Use the arrows to step through, **Export** to save a PDF, or **Share** to copy a permanent link.`;

const CONES = `-- An ice cream shop's menu
CREATE OR REPLACE TABLE cones (Flavor VARCHAR, Color VARCHAR, Price DOUBLE);
INSERT INTO cones VALUES
    ('strawberry', 'pink', 3.55),
    ('chocolate', 'light brown', 4.75),
    ('vanilla', 'white', 4.25),
    ('chocolate', 'dark brown', 5.25),
    ('strawberry', 'pink', 3.95),
    ('mint', 'green', 4.50);
SELECT * FROM cones;`;

export const tutor: TutorConfig = {
  library: 'SQL',
  productName: 'Query Tutor',
  dataNoun: 'query',
  language: 'sql',
  engine: 'DuckDB',
  engineNote: 'DuckDB runs on Python in your browser (Pyodide): the first visit downloads about 20 MB, kept for next time.',
  kernel: runtime,
  // Step tables print the way DuckDB prints a table
  tableStyle: 'duckdb',
  defaultCells: [
    { type: 'markdown', source: DEFAULT_MARKDOWN },
    { type: 'code', source: CONES },
    // Showing a table is not a step, so the starter needs a query to visualize
    { type: 'code', source: "-- Only the chocolate cones\nSELECT * FROM cones WHERE Flavor = 'chocolate';" },
  ],
  gallery,
  tracedNote: (
    <>
      Each <code>SELECT</code> is shown clause by clause: <code>FROM</code> and <code>JOIN</code>, <code>WHERE</code>,{' '}
      <code>GROUP BY</code>, <code>HAVING</code>, <code>SELECT</code>, <code>DISTINCT</code>, <code>ORDER BY</code> and{' '}
      <code>LIMIT</code>.
    </>
  ),
  tryThis: `${CONES}\n\nSELECT * FROM cones WHERE Flavor = 'chocolate';`,
  errorHint: (
    <li>
      Text goes in single quotes (<code>{"'chocolate'"}</code>); double quotes name a column
    </li>
  ),
  notebookStorageKey: 'sql:notebook',
};
