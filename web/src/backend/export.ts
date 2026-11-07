/** Export: full-resolution renders written to a picked folder or downloaded. */
import { emit } from './events';
import { encodePixels } from './editor';
import { renderPath } from './library';
import { loadSidecar, parseVirtualPath } from './sidecars';
import * as vfs from './vfs';
import { isMobileUi } from '../platform';
import { offerFiles } from './share';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

let cancelled = false;

export function cancelExport() {
  cancelled = true;
  emit('export-cancelling');
}

/** Mirrors desktop `generate_filename_from_template`. */
function filenameFromTemplate(template: string, path: string, sequence: number, total: number) {
  const name = vfs.basename(parseVirtualPath(path).source);
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const number = (stem.match(/(\d+)$/) || ['', ''])[1];
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const seqWidth = Math.max(String(total).length, 1);
  return template
    .replace(/\{original_filename\}/g, stem)
    .replace(/\{original_filename_number\}/g, number)
    .replace(/\{sequence\}/g, String(sequence).padStart(seqWidth, '0'))
    .replace(/\{YYYY\}/g, String(now.getFullYear()))
    .replace(/\{MM\}/g, pad(now.getMonth() + 1))
    .replace(/\{DD\}/g, pad(now.getDate()))
    .replace(/\{hh\}/g, pad(now.getHours()))
    .replace(/\{mm\}/g, pad(now.getMinutes()));
}

function targetSize(w: number, h: number, resize: any): [number, number] {
  if (!resize || !resize.value) return [w, h];
  const v = resize.value;
  let scale = 1;
  switch (resize.mode) {
    case 'longEdge':
      scale = v / Math.max(w, h);
      break;
    case 'shortEdge':
      scale = v / Math.min(w, h);
      break;
    case 'width':
      scale = v / w;
      break;
    case 'height':
      scale = v / h;
      break;
  }
  if (resize.dontEnlarge) scale = Math.min(scale, 1);
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

async function encodeExport(path: string, adjustments: any, settings: any, format: string): Promise<Blob> {
  const mime = MIME[format];
  if (!mime)
    throw new Error(
      `${format.toUpperCase()} export is not available in RapidRAW Web yet. Please choose JPEG, PNG or WebP.`,
    );
  const r = await renderPath(path, adjustments, Number.POSITIVE_INFINITY);
  const [tw, th] = targetSize(r.width, r.height, settings?.resize);
  const quality = Math.min(1, Math.max(0.01, (settings?.jpegQuality ?? 90) / 100));
  if (tw === r.width && th === r.height) return encodePixels(r.pixels, r.width, r.height, mime, quality);
  const src = new OffscreenCanvas(r.width, r.height);
  src
    .getContext('2d')!
    .putImageData(new ImageData(new Uint8ClampedArray(r.pixels.buffer as ArrayBuffer), r.width, r.height), 0, 0);
  const dst = new OffscreenCanvas(tw, th);
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, tw, th);
  return dst.convertToBlob({ type: mime, quality });
}

async function deliver(path: string, blob: Blob, collected: File[]) {
  if (!vfs.isDownloadPath(path) && (await vfs.writeFile(path, blob))) return;
  if (isMobileUi) collected.push(new File([blob], vfs.basename(path), { type: blob.type }));
  else vfs.download(vfs.basename(path), blob);
}

export async function exportImages(args: any) {
  const {
    paths = [],
    outputFolderOrFile,
    isExplicitFilePath,
    exportSettings = {},
    outputFormat = 'jpg',
    currentEditPath,
    currentEditAdjustments,
  } = args;
  cancelled = false;
  const total = paths.length;
  const collected: File[] = [];
  try {
    for (let i = 0; i < total; i++) {
      if (cancelled) {
        emit('export-cancelled');
        return;
      }
      const path = paths[i];
      emit('batch-export-progress', { current: i, total, path });
      const adjustments =
        path === currentEditPath && currentEditAdjustments
          ? currentEditAdjustments
          : (await loadSidecar(path)).adjustments || {};
      const blob = await encodeExport(path, adjustments, exportSettings, outputFormat);
      const ext = outputFormat === 'jpeg' ? 'jpg' : outputFormat;
      let target: string;
      if (isExplicitFilePath) {
        target = outputFolderOrFile;
      } else {
        const name = `${filenameFromTemplate(exportSettings.filenameTemplate || '{original_filename}_edited', path, i + 1, total)}.${ext}`;
        const folder =
          outputFolderOrFile === 'originalFolderDummy'
            ? vfs.join(vfs.dirname(parseVirtualPath(path).source), exportSettings.subfolder || '')
            : outputFolderOrFile || vfs.DOWNLOADS;
        if (exportSettings.subfolder && outputFolderOrFile === 'originalFolderDummy') await vfs.createDir(folder);
        target = vfs.join(folder, name);
      }
      await deliver(target, blob, collected);
    }
    emit('batch-export-progress', { current: total, total, path: '' });
    emit('export-complete');
    offerFiles(collected);
  } catch (e: any) {
    emit('export-error', String(e?.message ?? e));
    throw String(e?.message ?? e);
  }
}

/** Rough size estimate (desktop renders a sample; JPEG size scales with pixels). */
export async function estimateExportSize(args: any): Promise<number | null> {
  const s = await import('./editor').then((m) => m.currentImage());
  if (!s) return null;
  const [w, h] = targetSize(s.image.width, s.image.height, args?.exportSettings?.resize);
  const fmt = args?.outputFormat || 'jpg';
  const q = (args?.exportSettings?.jpegQuality ?? 90) / 100;
  const bpp = fmt === 'png' ? 2.5 : fmt === 'webp' ? 0.25 + q * 0.6 : 0.3 + q * q * 1.6;
  return Math.round(w * h * bpp);
}
