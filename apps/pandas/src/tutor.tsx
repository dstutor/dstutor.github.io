// Everything that makes the shared TutorApp the pandas tutor.
import type { TutorConfig } from '@dstutor/notebook-ui';
import { runtime } from './runtime';
import { gallery } from './examples';

const DEFAULT_MARKDOWN = `## How to use this notebook

- **Cells:** Click a cell's margin to select it, press **Enter** to edit and **Esc** to get back. In this mode single keys act on the selected cell, like Jupyter: **a**/**b** add a cell above/below, **d d** deletes, **m**/**y** switch it to markdown/code, **z** undoes a delete.
- **Running:** **Ctrl+Enter** (**Cmd+Enter** on Mac) runs a cell; **Shift+Enter** runs it and moves on. A DataFrame named on the last line of a cell is shown beneath it. **Run all** runs every cell top to bottom; **Restart** forgets everything the cells defined.
- **Visualize:** **Run all & visualize** runs everything and shows each DataFrame operation step by step on the right. **Visualize** on its own shows the operations from whichever cells you have run so far. Use the arrows to step through, **Export** to save a PDF, or **Share** to copy a permanent link.`;

const CONES = `cones = pd.DataFrame({
    'Flavor': ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
    'Color': ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
    'Price': [3.55, 4.75, 4.25, 5.25, 3.95, 4.50],
})`;

export const tutor: TutorConfig = {
  library: 'pandas',
  productName: 'DataFrame Tutor',
  dataNoun: 'DataFrame',
  kernel: runtime,
  defaultCells: [
    { type: 'markdown', source: DEFAULT_MARKDOWN },
    { type: 'code', source: 'import pandas as pd' },
    { type: 'code', source: `${CONES}\ncones` },
    // Making a DataFrame is not a step, so the starter needs an operation to visualize
    { type: 'code', source: "# Only the chocolate cones\nchocolate = cones[cones['Flavor'] == 'chocolate']\nchocolate" },
  ],
  gallery,
  tracedNote: (
    <>
      Filtering, <code>sort_values</code>, <code>groupby</code> with an aggregation, <code>merge</code>, <code>assign</code> and{' '}
      <code>pivot_table</code> are visualized.
    </>
  ),
  tryThis: `import pandas as pd\n\n${CONES}\n\ncones[cones['Flavor'] == 'chocolate']`,
  errorHint: (
    <li>
      Column names are case-sensitive: <code>df.columns</code> lists them
    </li>
  ),
  notebookStorageKey: 'pandas:notebook',
};
