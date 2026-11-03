import type { NotebookCell } from './NotebookCells';

/**
 * Serialize the notebook as Jupyter nbformat 4.5 (https://nbformat.readthedocs.io).
 * Cell outputs are included so the file opens with results in place, like a saved notebook.
 */

/** nbformat splits multi-line text into a list of lines, each keeping its trailing newline */
function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line)).filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

/** Cell ids must match ^[a-zA-Z0-9-_]+$ and be at most 64 characters (nbformat 4.5) */
export function toNbformatId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9\-_]/g, '-').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'cell';
}

interface NbOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  [key: string]: unknown;
}

function cellOutputs(cell: NotebookCell): NbOutput[] {
  const out = cell.output;
  if (!out) return [];
  const outputs: NbOutput[] = [];
  if (out.stdout) {
    outputs.push({ output_type: 'stream', name: 'stdout', text: toLines(out.stdout) });
  }
  if (out.stderr) {
    outputs.push({ output_type: 'stream', name: 'stderr', text: toLines(out.stderr) });
  }
  for (const image of out.images ?? []) {
    outputs.push({
      output_type: 'display_data',
      data: { 'image/png': image.png },
      metadata: { 'image/png': { width: image.width } },
    });
  }
  if (out.result !== undefined) {
    outputs.push({
      output_type: 'execute_result',
      execution_count: cell.execCount ?? null,
      data: { 'text/plain': toLines(out.result) },
      metadata: {},
    });
  }
  if (out.error) {
    const lines = out.error.replace(/\n$/, '').split('\n');
    const last = lines[lines.length - 1] ?? '';
    const sep = last.indexOf(': ');
    outputs.push({
      output_type: 'error',
      ename: sep === -1 ? last : last.slice(0, sep),
      evalue: sep === -1 ? '' : last.slice(sep + 2),
      traceback: lines,
    });
  }
  return outputs;
}

export function buildIpynb(cells: NotebookCell[]): Record<string, unknown> {
  const usedIds = new Set<string>();
  const uniqueId = (raw: string) => {
    let id = toNbformatId(raw);
    let n = 1;
    while (usedIds.has(id)) id = `${toNbformatId(raw).slice(0, 60)}-${n++}`;
    usedIds.add(id);
    return id;
  };

  return {
    cells: cells.map(cell =>
      cell.type === 'markdown'
        ? {
            cell_type: 'markdown',
            id: uniqueId(cell.id),
            metadata: {},
            source: toLines(cell.source),
          }
        : {
            cell_type: 'code',
            id: uniqueId(cell.id),
            metadata: {},
            execution_count: cell.execCount ?? null,
            outputs: cellOutputs(cell),
            source: toLines(cell.source),
          }
    ),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

export function ipynbToJson(cells: NotebookCell[]): string {
  return JSON.stringify(buildIpynb(cells), null, 1) + '\n';
}

/** Text fields in nbformat may be a string or a list of lines */
function joinText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(x => typeof x === 'string').join('');
  return '';
}

/** Jupyter stores tracebacks with ANSI colour codes (ESC [ ... m); the notebook shows plain text */
const ANSI_CODES = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/**
 * Read a Jupyter notebook (nbformat 4) into cells. Code and markdown cells are kept, with
 * any text outputs, plots and errors, so a saved lab opens looking the way it was left.
 * Raw cells are skipped. Throws on anything that is not a notebook.
 */
export function parseIpynb(json: string, makeId: () => string): NotebookCell[] {
  const nb = JSON.parse(json) as { nbformat?: number; cells?: unknown };
  if (!nb || nb.nbformat !== 4 || !Array.isArray(nb.cells)) {
    throw new Error('Not a Jupyter notebook (nbformat 4)');
  }
  const cells: NotebookCell[] = [];
  for (const raw of nb.cells as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') continue;
    const source = joinText(raw.source);
    if (raw.cell_type === 'markdown') {
      cells.push({ id: makeId(), type: 'markdown', source, rendered: true });
      continue;
    }
    if (raw.cell_type !== 'code') continue;
    const cell: NotebookCell = { id: makeId(), type: 'code', source };
    if (typeof raw.execution_count === 'number') cell.execCount = raw.execution_count;
    const outputs = Array.isArray(raw.outputs) ? (raw.outputs as Array<Record<string, unknown>>) : [];
    if (outputs.length > 0) {
      const out: NonNullable<NotebookCell['output']> = { stdout: '', stderr: '' };
      for (const o of outputs) {
        const data = (o.data ?? {}) as Record<string, unknown>;
        switch (o.output_type) {
          case 'stream':
            if (o.name === 'stderr') out.stderr += joinText(o.text);
            else out.stdout += joinText(o.text);
            break;
          case 'execute_result':
            if (data['text/plain'] !== undefined) out.result = joinText(data['text/plain']);
            break;
          case 'display_data':
            if (typeof data['image/png'] === 'string') {
              const meta = (o.metadata as Record<string, unknown> | undefined)?.['image/png'] as { width?: number } | undefined;
              (out.images ??= []).push({ png: data['image/png'].replace(/\s/g, ''), width: meta?.width ?? 576 });
            } else if (data['text/plain'] !== undefined) {
              out.stdout += joinText(data['text/plain']) + '\n';
            }
            break;
          case 'error': {
            const tb = Array.isArray(o.traceback) ? (o.traceback as string[]) : [];
            const clean = tb.map(l => l.replace(ANSI_CODES, '')).join('\n');
            out.error = clean || `${o.ename ?? 'Error'}: ${o.evalue ?? ''}`;
            break;
          }
        }
      }
      if (out.stdout || out.stderr || out.result !== undefined || out.error || out.images) cell.output = out;
    }
    cells.push(cell);
  }
  if (cells.length === 0) throw new Error('The notebook has no code or markdown cells');
  return cells;
}
