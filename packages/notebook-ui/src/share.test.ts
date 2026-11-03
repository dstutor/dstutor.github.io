import { describe, it, expect } from 'vitest';
import { encodeNotebook, decodeNotebook } from './share';
import { parseIpynb, buildIpynb } from './ipynb';
import type { NotebookCell } from './NotebookCells';

describe('share links', () => {
  const cells = [
    { type: 'markdown' as const, source: '## Notes\n\nSome *text* with unicode: café, 数据' },
    { type: 'code' as const, source: "from datascience import *\nt = Table().with_columns('A', make_array(1, 2))\nt" },
    { type: 'code' as const, source: '' },
  ];

  it('round-trips cells through the compressed parameter', () => {
    const param = encodeNotebook(cells);
    expect(param).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(decodeNotebook(param)).toEqual(cells);
  });

  it('is much shorter than the raw JSON for a real notebook', () => {
    const big = Array.from({ length: 12 }, (_, i) => ({
      type: 'code' as const,
      source: `# Step ${i}\nstudents = students.where('Major', 'CS').select('Name', 'GPA').sort('GPA', descending=True)\nstudents`,
    }));
    const raw = encodeURIComponent(JSON.stringify(big)).length;
    expect(encodeNotebook(big).length).toBeLessThan(raw / 3);
  });

  it('rejects garbage', () => {
    expect(decodeNotebook('not-a-payload')).toBeNull();
    expect(decodeNotebook('')).toBeNull();
  });
});

describe('parseIpynb', () => {
  let n = 0;
  const makeId = () => `c${++n}`;
  const ESC = String.fromCharCode(27);

  it('reads a notebook produced by buildIpynb, outputs included', () => {
    const original: NotebookCell[] = [
      { id: 'a', type: 'markdown', source: '# Title', rendered: true },
      { id: 'b', type: 'code', source: 'print("hi")\n42', execCount: 3,
        output: { stdout: 'hi\n', stderr: '', result: '42', images: [{ png: 'iVBORw0KGgo=', width: 500 }] } },
      { id: 'c', type: 'code', source: 'nope', execCount: 4,
        output: { stdout: '', stderr: '', error: "Traceback (most recent call last):\nNameError: name 'nope' is not defined" } },
    ];
    const cells = parseIpynb(JSON.stringify(buildIpynb(original)), makeId);
    expect(cells.map(c => c.type)).toEqual(['markdown', 'code', 'code']);
    expect(cells[0].source).toBe('# Title');
    expect(cells[1].source).toBe('print("hi")\n42');
    expect(cells[1].execCount).toBe(3);
    expect(cells[1].output).toMatchObject({ stdout: 'hi\n', result: '42', images: [{ png: 'iVBORw0KGgo=', width: 500 }] });
    expect(cells[2].output?.error).toContain("NameError: name 'nope' is not defined");
  });

  it('accepts string sources, skips raw cells, strips ANSI from tracebacks', () => {
    const nb = {
      nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [
        { cell_type: 'raw', source: 'ignored' },
        { cell_type: 'code', source: 'x = 1', execution_count: null, outputs: [
          { output_type: 'error', ename: 'E', evalue: 'v', traceback: [`${ESC}[0;31mE${ESC}[0m: v`] },
        ] },
      ],
    };
    const cells = parseIpynb(JSON.stringify(nb), makeId);
    expect(cells).toHaveLength(1);
    expect(cells[0].output?.error).toBe('E: v');
  });

  it('rejects non-notebooks', () => {
    expect(() => parseIpynb('{"hello": 1}', makeId)).toThrow();
    expect(() => parseIpynb('[]', makeId)).toThrow();
  });
});
