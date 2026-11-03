import type * as Monaco from 'monaco-editor';

/**
 * Autocomplete for the notebook's Python cells.
 *
 * There is no language server in the browser, and Monaco's fallback is to offer every word
 * it can see (which is how comment text like "Select" ends up in the list). Instead we
 * complete from the datascience API used in Data 8, a few numpy and builtin names, and the
 * names the notebook's own cells assign. As in Jupyter, the list only opens on Tab.
 *
 * Signatures and one-line docs were extracted from datascience with inspect.signature.
 */

interface Entry {
  label: string;
  detail: string;
  doc?: string;
  /** Attribute rather than a call: inserted without parentheses */
  property?: boolean;
}

const TABLE_METHODS: Entry[] = [
  { label: 'apply', detail: 'apply(fn, *column_or_columns)', doc: 'Apply fn to each element or elements of column_or_columns.' },
  { label: 'append', detail: 'append(row_or_table)', doc: 'Append a row or all rows of a table in place.' },
  { label: 'append_column', detail: 'append_column(label, values, formatter=None)', doc: 'Appends a column to the table or replaces a column.' },
  { label: 'bar', detail: 'bar(column_for_categories=None, select=None, overlay=True, ...)', doc: 'Plot bar charts for the table.' },
  { label: 'barh', detail: 'barh(column_for_categories=None, select=None, overlay=True, ...)', doc: 'Plot horizontal bar charts for the table.' },
  { label: 'bin', detail: 'bin(*columns, **vargs)', doc: 'Group values by bin and compute counts per bin by column.' },
  { label: 'boxplot', detail: 'boxplot(**vargs)', doc: 'Plots a boxplot for the table.' },
  { label: 'column', detail: 'column(index_or_label)', doc: 'Return the values of a column as an array.' },
  { label: 'column_index', detail: 'column_index(label)', doc: 'Return the index of a column by looking up its label.' },
  { label: 'columns', detail: 'columns', doc: 'A tuple of columns, each with the values in that column.', property: true },
  { label: 'copy', detail: 'copy(*, shallow=False)', doc: 'Return a copy of a table.' },
  { label: 'drop', detail: 'drop(*column_or_columns)', doc: 'Return a Table with only columns other than the selected labels.' },
  { label: 'exclude', detail: 'exclude(row_indices)', doc: 'Return a new Table without a sequence of rows excluded by number.' },
  { label: 'first', detail: 'first(label)', doc: 'Return the zeroth item in a column.' },
  { label: 'group', detail: 'group(column_or_label, collect=None)', doc: 'Group rows by unique values in a column; count or aggregate others.' },
  { label: 'group_bar', detail: 'group_bar(column_label, **vargs)', doc: 'Plot a bar chart for the table.' },
  { label: 'group_barh', detail: 'group_barh(column_label, **vargs)', doc: 'Plot a horizontal bar chart for the table.' },
  { label: 'groups', detail: 'groups(labels, collect=None)', doc: 'Group rows by multiple columns, count or aggregate others.' },
  { label: 'hist', detail: 'hist(*columns, overlay=True, bins=None, bin_column=None, unit=None, counts=None, group=None, ...)', doc: 'Plots one histogram for each column in columns.' },
  { label: 'hist_of_counts', detail: 'hist_of_counts(*columns, overlay=True, bins=None, bin_column=None, group=None, ...)', doc: 'Plots one count-based histogram for each column in columns.' },
  { label: 'index_by', detail: 'index_by(column_or_label)', doc: 'Return a dict keyed by values in a column that contains lists of rows.' },
  { label: 'join', detail: 'join(column_label, other, other_label=None)', doc: 'Creates a new table with the columns of self and other, containing rows for all values of a column that appear in both tables.' },
  { label: 'labels', detail: 'labels', doc: 'A tuple of column labels.', property: true },
  { label: 'last', detail: 'last(label)', doc: 'Return the last item in a column.' },
  { label: 'move_column', detail: 'move_column(label, index)', doc: 'Returns a new table with the specified column moved to the specified column index.' },
  { label: 'move_to_end', detail: 'move_to_end(column_label)', doc: 'Move a column to be the last column.' },
  { label: 'move_to_start', detail: 'move_to_start(column_label)', doc: 'Move a column to be the first column.' },
  { label: 'num_columns', detail: 'num_columns', doc: 'Number of columns.', property: true },
  { label: 'num_rows', detail: 'num_rows', doc: 'Number of rows.', property: true },
  { label: 'percentile', detail: 'percentile(p)', doc: 'Return a new table with one row containing the pth percentile for each column.' },
  { label: 'pivot', detail: 'pivot(columns, rows, values=None, collect=None, zero=None)', doc: 'Generate a table with a column for each unique value in columns, with rows for each unique value in rows.' },
  { label: 'pivot_bin', detail: 'pivot_bin(pivot_columns, value_column, bins=None, **vargs)', doc: 'Form a table with columns formed by the unique tuples in pivot_columns.' },
  { label: 'plot', detail: 'plot(column_for_xticks=None, select=None, overlay=True, width=None, height=None, **vargs)', doc: 'Plot line charts for the table.' },
  { label: 'read_table', detail: 'read_table(filepath_or_buffer, *args, **vargs)', doc: 'Read a table from a file or web address.' },
  { label: 'relabel', detail: 'relabel(column_label, new_label)', doc: 'Changes the label(s) of column(s) in place.' },
  { label: 'relabeled', detail: 'relabeled(label, new_label)', doc: 'Return a new table with label(s) renamed.' },
  { label: 'remove', detail: 'remove(row_or_row_indices)', doc: 'Removes a row or multiple rows of a table in place (0 indexed).' },
  { label: 'row', detail: 'row(index)', doc: 'Return a row.' },
  { label: 'rows', detail: 'rows', doc: 'A view of all rows.', property: true },
  { label: 'sample', detail: 'sample(k=None, with_replacement=True, weights=None)', doc: 'Return a new table where k rows are randomly sampled from the original table.' },
  { label: 'sample_from_distribution', detail: 'sample_from_distribution(distribution, k, proportions=False)', doc: 'Return a new table with the same number of rows and a new column of sampled counts.' },
  { label: 'scatter', detail: 'scatter(column_for_x, select=None, overlay=True, fit_line=False, group=None, labels=None, ...)', doc: 'Creates scatterplots, optionally adding a line of best fit.' },
  { label: 'select', detail: 'select(*column_or_columns)', doc: 'Return a table with only the columns in column_or_columns.' },
  { label: 'set_format', detail: 'set_format(column_or_columns, formatter)', doc: 'Set the pretty print format of a column(s) and/or convert its values.' },
  { label: 'show', detail: 'show(max_rows=0)', doc: 'Display the table.' },
  { label: 'shuffle', detail: 'shuffle()', doc: 'Return a new table where all the rows are randomly shuffled.' },
  { label: 'sort', detail: 'sort(column_or_label, descending=False, distinct=False)', doc: 'Return a Table of rows sorted according to the values in a column.' },
  { label: 'split', detail: 'split(k)', doc: 'Return a tuple of two tables: the first with k rows, the second with the rest.' },
  { label: 'stack', detail: 'stack(key, labels=None)', doc: 'Takes k original columns and returns two columns: the label and the value.' },
  { label: 'stats', detail: 'stats(ops=(min, max, np.median, sum))', doc: 'Compute statistics for each column and place them in a table.' },
  { label: 'take', detail: 'take(row_indices)', doc: 'Return a new Table with selected rows taken by index.' },
  { label: 'to_array', detail: 'to_array()', doc: 'Convert the table to a structured NumPy array.' },
  { label: 'to_csv', detail: 'to_csv(filename)', doc: 'Creates a CSV file with the provided filename.' },
  { label: 'to_df', detail: 'to_df()', doc: 'Convert the table to a Pandas DataFrame.' },
  { label: 'values', detail: 'values', doc: 'Data in the table as a numpy array.', property: true },
  { label: 'where', detail: 'where(column_or_label, value_or_predicate=None, other=None)', doc: 'Return a new Table containing rows where value_or_predicate returns True for values in the column.' },
  { label: 'with_column', detail: 'with_column(label, values, formatter=None)', doc: 'Return a new table with an additional or replaced column.' },
  { label: 'with_columns', detail: 'with_columns(*labels_and_values, **formatter)', doc: 'Return a table with additional or replaced columns.' },
  { label: 'with_row', detail: 'with_row(row)', doc: 'Return a table with an additional row.' },
  { label: 'with_rows', detail: 'with_rows(rows)', doc: 'Return a table with additional rows.' },
];

const PREDICATES: Entry[] = [
  { label: 'above', detail: 'are.above(y)', doc: 'Greater than y.' },
  { label: 'above_or_equal_to', detail: 'are.above_or_equal_to(y)', doc: 'Greater than or equal to y.' },
  { label: 'below', detail: 'are.below(y)', doc: 'Less than y.' },
  { label: 'below_or_equal_to', detail: 'are.below_or_equal_to(y)', doc: 'Less than or equal to y.' },
  { label: 'between', detail: 'are.between(y, z)', doc: 'Greater than or equal to y and less than z.' },
  { label: 'between_or_equal_to', detail: 'are.between_or_equal_to(y, z)', doc: 'Greater than or equal to y and less than or equal to z.' },
  { label: 'contained_in', detail: 'are.contained_in(superstring)', doc: 'A string that is part of the given superstring.' },
  { label: 'containing', detail: 'are.containing(substring)', doc: 'A string that contains within it the given substring.' },
  { label: 'equal_to', detail: 'are.equal_to(y)', doc: 'Equal to y.' },
  { label: 'not_above', detail: 'are.not_above(y)', doc: 'Is not above y.' },
  { label: 'not_above_or_equal_to', detail: 'are.not_above_or_equal_to(y)', doc: 'Is neither above y nor equal to y.' },
  { label: 'not_below', detail: 'are.not_below(y)', doc: 'Is not below y.' },
  { label: 'not_below_or_equal_to', detail: 'are.not_below_or_equal_to(y)', doc: 'Is neither below y nor equal to y.' },
  { label: 'not_between', detail: 'are.not_between(y, z)', doc: 'Is equal to y or less than y or greater than z.' },
  { label: 'not_between_or_equal_to', detail: 'are.not_between_or_equal_to(y, z)', doc: 'Is less than y or greater than z.' },
  { label: 'not_contained_in', detail: 'are.not_contained_in(superstring)', doc: 'A string that is not contained within the superstring.' },
  { label: 'not_containing', detail: 'are.not_containing(substring)', doc: 'A string that does not contain substring.' },
  { label: 'not_equal_to', detail: 'are.not_equal_to(y)', doc: 'Is not equal to y.' },
  { label: 'not_strictly_between', detail: 'are.not_strictly_between(y, z)', doc: 'Is equal to y or equal to z or less than y or greater than z.' },
  { label: 'strictly_between', detail: 'are.strictly_between(y, z)', doc: 'Greater than y and less than z.' },
];

const NUMPY: Entry[] = [
  { label: 'arange', detail: 'np.arange([start,] stop[, step])', doc: 'Evenly spaced values within a given interval.' },
  { label: 'array', detail: 'np.array(object)', doc: 'Create an array.' },
  { label: 'mean', detail: 'np.mean(a)', doc: 'Compute the arithmetic mean.' },
  { label: 'median', detail: 'np.median(a)', doc: 'Compute the median.' },
  { label: 'std', detail: 'np.std(a)', doc: 'Compute the standard deviation.' },
  { label: 'average', detail: 'np.average(a, weights=None)', doc: 'Compute the weighted average.' },
  { label: 'sum', detail: 'np.sum(a)', doc: 'Sum of array elements.' },
  { label: 'min', detail: 'np.min(a)', doc: 'Minimum of an array.' },
  { label: 'max', detail: 'np.max(a)', doc: 'Maximum of an array.' },
  { label: 'abs', detail: 'np.abs(x)', doc: 'Absolute value, element-wise.' },
  { label: 'round', detail: 'np.round(a, decimals=0)', doc: 'Round to the given number of decimals.' },
  { label: 'sqrt', detail: 'np.sqrt(x)', doc: 'Square root, element-wise.' },
  { label: 'log', detail: 'np.log(x)', doc: 'Natural logarithm, element-wise.' },
  { label: 'exp', detail: 'np.exp(x)', doc: 'Exponential, element-wise.' },
  { label: 'count_nonzero', detail: 'np.count_nonzero(a)', doc: 'Counts the number of non-zero (or True) values.' },
  { label: 'append', detail: 'np.append(arr, values)', doc: 'Append values to the end of an array.' },
  { label: 'cumsum', detail: 'np.cumsum(a)', doc: 'Cumulative sum of the elements.' },
  { label: 'diff', detail: 'np.diff(a)', doc: 'Differences between consecutive elements.' },
  { label: 'sort', detail: 'np.sort(a)', doc: 'Return a sorted copy of an array.' },
  { label: 'unique', detail: 'np.unique(ar)', doc: 'Find the unique elements of an array.' },
  { label: 'percentile', detail: 'np.percentile(a, q)', doc: 'Compute the q-th percentile of the data.' },
  { label: 'linspace', detail: 'np.linspace(start, stop, num=50)', doc: 'Evenly spaced numbers over an interval.' },
  { label: 'ones', detail: 'np.ones(shape)', doc: 'Array filled with ones.' },
  { label: 'zeros', detail: 'np.zeros(shape)', doc: 'Array filled with zeros.' },
  { label: 'random.choice', detail: 'np.random.choice(a, size=None, replace=True)', doc: 'Random sample from a given array.' },
  { label: 'where', detail: 'np.where(condition, x, y)', doc: 'Elements chosen from x or y depending on condition.' },
];

const DATASCIENCE_GLOBALS: Entry[] = [
  { label: 'Table', detail: 'Table(labels=None)', doc: 'A sequence of string-labeled columns.' },
  { label: 'make_array', detail: 'make_array(*elements)', doc: 'Returns an array containing all the arguments passed to this function.' },
  { label: 'are', detail: 'are', doc: 'Predicate functions for where, e.g. are.above(3).', property: true },
  { label: 'percentile', detail: 'percentile(p, arr=None)', doc: 'Returns the pth percentile of the input array.' },
  { label: 'sample_proportions', detail: 'sample_proportions(sample_size, probabilities)', doc: 'Return the proportion of random draws for each outcome in a distribution.' },
  { label: 'proportions_from_distribution', detail: 'proportions_from_distribution(table, label, sample_size)', doc: 'Adds a column containing the proportions of a random draw from a distribution.' },
  { label: 'minimize', detail: 'minimize(f, start=None, smooth=False)', doc: 'Minimize a function f of one or more arguments.' },
  { label: 'plot_normal_cdf', detail: 'plot_normal_cdf(rbound=None, lbound=None, mean=0, sd=1)', doc: 'Plots a normal curve with the area below the curve shaded.' },
  { label: 'np', detail: 'np', doc: 'numpy', property: true },
  { label: 'plots', detail: 'plots', doc: 'matplotlib.pyplot', property: true },
  { label: 'plt', detail: 'plt', doc: 'matplotlib.pyplot', property: true },
];

const PYTHON_NAMES: Entry[] = [
  ...['print', 'len', 'range', 'sum', 'max', 'min', 'abs', 'round', 'sorted', 'int', 'float', 'str', 'list', 'type'].map(
    n => ({ label: n, detail: `${n}(...)`, doc: 'Python builtin' })
  ),
  ...['for', 'in', 'if', 'elif', 'else', 'def', 'return', 'import', 'from', 'as', 'and', 'or', 'not', 'True', 'False', 'None', 'lambda', 'while'].map(
    n => ({ label: n, detail: n, doc: 'keyword', property: true })
  ),
];

let registered = false;
let userNamesProvider: () => string[] = () => [];

/** Supplies the names defined in the notebook (assignments, defs, loop variables) for completion */
export function setUserNamesProvider(fn: () => string[]): void {
  userNamesProvider = fn;
}

/** Collect identifiers the given sources define, in order of first appearance */
export function extractUserNames(sources: string[]): string[] {
  const seen = new Set<string>();
  const re = /^\s*(?:def\s+([A-Za-z_]\w*)|for\s+([A-Za-z_]\w*)\s+in\b|([A-Za-z_]\w*)\s*=[^=])/gm;
  for (const src of sources) {
    for (const m of src.matchAll(re)) {
      const name = m[1] ?? m[2] ?? m[3];
      if (name && !name.startsWith('__')) seen.add(name);
    }
  }
  return [...seen];
}

export function registerPythonCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  const K = monaco.languages.CompletionItemKind;
  const toItem = (
    e: Entry,
    range: Monaco.IRange,
    kind: Monaco.languages.CompletionItemKind,
    sortPrefix: string
  ): Monaco.languages.CompletionItem => ({
    label: e.label,
    kind,
    detail: e.detail,
    documentation: e.doc,
    range,
    sortText: sortPrefix + e.label,
    insertText: e.property ? e.label : `${e.label}($0)`,
    insertTextRules: e.property ? undefined : monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    // A callable's signature help is the detail; keep the cursor inside the parentheses
    command: e.property ? undefined : { id: 'editor.action.triggerParameterHints', title: '' },
  });

  monaco.languages.registerCompletionItemProvider('python', {
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      // Inside a string or comment: nothing useful to offer
      const quotes = (line.match(/['"]/g) ?? []).length;
      if (line.includes('#') || quotes % 2 === 1) return { suggestions: [] };

      if (/\bare\.\w*$/.test(line)) {
        return { suggestions: PREDICATES.map(e => toItem(e, range, K.Function, '0')) };
      }
      if (/\bnp\.\w*$/.test(line)) {
        return { suggestions: NUMPY.map(e => toItem(e, range, K.Function, '0')) };
      }
      if (/\.\w*$/.test(line)) {
        return {
          suggestions: TABLE_METHODS.map(e => toItem(e, range, e.property ? K.Property : K.Method, '0')),
        };
      }

      const userNames = userNamesProvider().map<Entry>(n => ({ label: n, detail: n, doc: 'defined in this notebook', property: true }));
      return {
        suggestions: [
          ...userNames.map(e => toItem(e, range, K.Variable, '0')),
          ...DATASCIENCE_GLOBALS.map(e => toItem(e, range, e.label === 'Table' ? K.Class : e.property ? K.Module : K.Function, '1')),
          ...PYTHON_NAMES.map(e => toItem(e, range, e.property ? K.Keyword : K.Function, '2')),
        ],
      };
    },
  });
}
