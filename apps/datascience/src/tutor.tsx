// Everything that makes the shared TutorApp the datascience tutor.
import type { TutorConfig } from '@dstutor/notebook-ui';
import { runtime } from './runtime';
import { gallery } from './examples';
import { registerPythonCompletions, setUserNamesProvider, extractUserNames } from './completions';

const DEFAULT_MARKDOWN = `## How to use this notebook

- **Cells:** Click a cell's margin to select it, press **Enter** to edit and **Esc** to get back. In this mode single keys act on the selected cell, like Jupyter: **a**/**b** add a cell above/below, **d d** deletes, **m**/**y** switch it to markdown/code, **z** undoes a delete.
- **Running:** **Ctrl+Enter** (**Cmd+Enter** on Mac) runs a cell; **Shift+Enter** runs it and moves on. A table named on the last line of a cell is shown beneath it. **Run all** runs every cell top to bottom; **Restart** forgets everything the cells defined.
- **Visualize:** **Run all & visualize** runs everything and shows each Table operation step by step on the right. **Visualize** on its own shows the operations from whichever cells you have run so far. Use the arrows to step through, **Export** to save a PDF, or **Share** to copy a permanent link.`;

const CONES = `cones = Table().with_columns(
    'Flavor', make_array('strawberry', 'chocolate', 'vanilla'),
    'Price', make_array(3.55, 4.75, 4.25)
)`;

export const tutor: TutorConfig = {
  library: 'datascience',
  productName: 'Table Tutor',
  dataNoun: 'Table',
  kernel: runtime,
  defaultCells: [
    { type: 'markdown', source: DEFAULT_MARKDOWN },
    { type: 'code', source: `from datascience import *` },
    { type: 'code', source: `${CONES}\ncones` },
  ],
  gallery,
  tracedNote: <>Only <code>datascience.Table</code> methods are visualized.</>,
  tryThis: `from datascience import *\n\n${CONES}\n\ncones.where('Flavor', 'chocolate')`,
  errorHint: (
    <li>Start with <code>from datascience import *</code> so <code>Table</code>, <code>make_array</code> and <code>are</code> are available</li>
  ),
  registerCompletions(monaco, userCode) {
    // Completions see the names defined anywhere in the notebook
    setUserNamesProvider(() => extractUserNames(userCode()));
    registerPythonCompletions(monaco);
  },
  notebookStorageKey: 'datascience:notebook',
  // Saved before tutors had their own keys
  legacyNotebookStorageKey: 'notebook',
};
