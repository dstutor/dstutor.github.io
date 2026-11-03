// PDF and PNG exports of a visualization: every step card rasterised at 2x, then laid out one
// per PDF page or zipped as one PNG per step, named to sort in order.
import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';
import { zipSync } from 'fflate';
import type { Frame } from './frames';

/** Rasterise each element (in order) at 2x on a solid background, so it reads on any slide */
export async function renderStepCanvases(cards: HTMLElement[], backgroundColor: string): Promise<HTMLCanvasElement[]> {
  const canvases: HTMLCanvasElement[] = [];
  for (const card of cards) {
    canvases.push(await html2canvas(card, { backgroundColor, scale: 2, useCORS: true, logging: false }));
  }
  return canvases;
}

/** One A4 page per step, each oriented to fit its card; downloads `${filename}` */
export function saveStepsPdf(canvases: HTMLCanvasElement[], filename: string): void {
  let pdf: jsPDF | null = null;
  for (const canvas of canvases) {
    const orientation = canvas.width > canvas.height ? 'landscape' : 'portrait';
    if (!pdf) pdf = new jsPDF({ orientation, unit: 'mm', format: 'a4' });
    else pdf.addPage(undefined, orientation);
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const scale = Math.min(pageW / canvas.width, pageH / canvas.height) * 0.95;
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pageW - w) / 2, (pageH - h) / 2, w, h);
  }
  pdf?.save(filename);
}

/** Zip of one PNG per step, named like 01-with_columns.png, 02-where-part-1-of-3.png */
export async function stepsZip(canvases: HTMLCanvasElement[], frames: Frame[]): Promise<Blob> {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < canvases.length; i++) {
    const frame = frames[i];
    const part = frame?.subTotal && frame.subTotal > 1 ? `-part-${(frame.subIndex ?? 0) + 1}-of-${frame.subTotal}` : '';
    const name = `${String(i + 1).padStart(2, '0')}-${frame?.record.operation ?? 'step'}${part}.png`;
    const blob = await new Promise<Blob | null>(resolve => canvases[i].toBlob(resolve, 'image/png'));
    if (blob) files[name] = new Uint8Array(await blob.arrayBuffer());
  }
  // PNG is already compressed, so store the entries rather than deflating them again
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
