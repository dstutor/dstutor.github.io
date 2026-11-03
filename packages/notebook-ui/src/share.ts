import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import type { CellType } from './NotebookCells';

/**
 * Share links carry the notebook in the URL. The payload is deflated and base64url-encoded
 * so a whole lab notebook stays a pasteable length (roughly a third of the raw JSON).
 */

export interface SharedCell {
  type: CellType;
  source: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeNotebook(cells: SharedCell[]): string {
  const json = JSON.stringify(cells.map(c => [c.type === 'markdown' ? 'm' : 'c', c.source]));
  return toBase64Url(deflateSync(strToU8(json), { level: 9 }));
}

export function decodeNotebook(param: string): SharedCell[] | null {
  try {
    const json = strFromU8(inflateSync(fromBase64Url(param)));
    const rows = JSON.parse(json) as unknown;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const cells: SharedCell[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || typeof row[1] !== 'string') return null;
      cells.push({ type: row[0] === 'm' ? 'markdown' : 'code', source: row[1] });
    }
    return cells;
  } catch {
    return null;
  }
}
