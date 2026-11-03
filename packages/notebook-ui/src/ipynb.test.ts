import { describe, it, expect } from 'vitest';
import { buildIpynb, toNbformatId } from './ipynb';
import type { NotebookCell } from './NotebookCells';

const cells: NotebookCell[] = [
  { id: 'cell-abc-1', type: 'markdown', source: '## Title\n\nSome *text*', rendered: true },
  { id: 'cell-abc-2', type: 'code', source: 'from datascience import *', execCount: 1, output: { stdout: '', stderr: '' } },
  {
    id: 'cell-abc-3',
    type: 'code',
    source: 't = Table().with_columns("A", make_array(1, 2))\nprint("hi")\nt',
    execCount: 2,
    output: { stdout: 'hi\n', stderr: '', result: 'A\n1\n2', images: [{ png: 'iVBORw0KGgo=', width: 576 }] },
  },
  {
    id: 'cell-abc-4',
    type: 'code',
    source: 'nope',
    execCount: 3,
    output: { stdout: '', stderr: '', error: 'Traceback (most recent call last):\n  File "<cell>", line 1, in <module>\n    nope\nNameError: name \'nope\' is not defined\n' },
  },
  { id: 'cell-abc-5', type: 'code', source: '' },
];

describe('buildIpynb', () => {
  const nb = buildIpynb(cells) as { cells: Array<Record<string, unknown>>; nbformat: number; nbformat_minor: number; metadata: Record<string, unknown> };

  it('declares nbformat 4.5 with a python kernelspec', () => {
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect((nb.metadata.kernelspec as { name: string }).name).toBe('python3');
  });

  it('gives every cell a schema-valid, unique id', () => {
    const ids = nb.cells.map(c => c.id as string);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9\-_]{1,64}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(toNbformatId('weird id!!/with spaces')).toBe('weird-id---with-spaces');
    expect(toNbformatId('x'.repeat(100))).toHaveLength(64);
  });

  it('writes source as newline-terminated lines', () => {
    expect(nb.cells[0].source).toEqual(['## Title\n', '\n', 'Some *text*']);
    expect(nb.cells[1].source).toEqual(['from datascience import *']);
    expect(nb.cells[4].source).toEqual([]);
  });

  it('maps outputs to stream, display_data, execute_result and error', () => {
    const outputs = nb.cells[2].outputs as Array<Record<string, unknown>>;
    expect(outputs.map(o => o.output_type)).toEqual(['stream', 'display_data', 'execute_result']);
    expect(outputs[0]).toMatchObject({ name: 'stdout', text: ['hi\n'] });
    expect((outputs[1].data as Record<string, string>)['image/png']).toBe('iVBORw0KGgo=');
    expect(outputs[2]).toMatchObject({ execution_count: 2, data: { 'text/plain': ['A\n', '1\n', '2'] } });

    const err = (nb.cells[3].outputs as Array<Record<string, unknown>>)[0];
    expect(err).toMatchObject({ output_type: 'error', ename: 'NameError', evalue: "name 'nope' is not defined" });
    expect((err.traceback as string[]).length).toBe(4);
  });

  it('leaves execution_count null for cells that never ran', () => {
    expect(nb.cells[4].execution_count).toBeNull();
    expect(nb.cells[4].outputs).toEqual([]);
  });
});
