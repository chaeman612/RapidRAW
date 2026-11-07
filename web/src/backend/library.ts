/** Library side of the backend: folder trees, image lists, thumbnails, EXIF. */
import { libraryCore, type DecodedImage } from '../core/client';
import type { SourceImage } from '../gpu/renderer';
import * as db from './db';
import { emit } from './events';
import { encodePixels, getRenderer, renderTarget, sessionTargetFor, type RenderTarget } from './editor';
import { coreDefaults, settingsJson } from './settings';
import { isEdited, loadSidecar, parseVirtualPath } from './sidecars';
import * as vfs from './vfs';

// ---- file types -----------------------------------------------------------------

function ext(name: string) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function isRawName(name: string) {
  return (coreDefaults()?.fileTypes.raw ?? []).includes(ext(name));
}

export function isImageName(name: string) {
  const types = coreDefaults()?.fileTypes;
  const e = ext(name);
  return !!types && (types.raw.includes(e) || types.nonRaw.includes(e));
}

// ---- folders ----------------------------------------------------------------------

export interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  is_dir: boolean;
  image_count: number;
  has_subdirs: boolean;
  modified: number;
  created: number;
}

async function folderNode(path: string, expanded: Set<string>, counts: boolean, depth = 0): Promise<FolderNode> {
  const entries = await vfs.list(path);
  const dirs = entries.filter((e) => e.kind === 'dir').sort((a, b) => a.name.localeCompare(b.name));
  const node: FolderNode = {
    name: vfs.basename(path) || path,
    path,
    children: [],
    is_dir: true,
    image_count: counts ? entries.filter((e) => e.kind === 'file' && isImageName(e.name)).length : 0,
    has_subdirs: dirs.length > 0,
    modified: 0,
    created: 0,
  };
  if (depth === 0 || expanded.has(path)) {
    for (const d of dirs) {
      node.children.push(
        expanded.has(d.path) && depth < 32
          ? await folderNode(d.path, expanded, counts, depth + 1)
          : {
              name: d.name,
              path: d.path,
              children: [],
              is_dir: true,
              image_count: 0,
              has_subdirs: true,
              modified: 0,
              created: 0,
            },
      );
    }
  }
  return node;
}

export function getFolderTree(path: string, expandedFolders: string[] = [], showImageCounts = false) {
  return folderNode(vfs.normalize(path), new Set((expandedFolders || []).map(vfs.normalize)), !!showImageCounts);
}

export async function getFolderChildren(path: string, showImageCounts = false) {
  return (await folderNode(vfs.normalize(path), new Set([vfs.normalize(path)]), !!showImageCounts)).children;
}

// ---- image lists ----------------------------------------------------------------------

export async function listImages(path: string, recursive = false): Promise<any[]> {
  const entries = await vfs.list(path);
  const out: any[] = [];
  const sidecarNames = new Set(entries.filter((e) => e.name.endsWith('.rrdata')).map((e) => e.name));
  for (const entry of entries) {
    if (entry.kind === 'dir') {
      if (recursive) out.push(...(await listImages(entry.path, true)));
      continue;
    }
    if (!isImageName(entry.name)) continue;
    const paths = [entry.path];
    // virtual copies: "<name>.<id>.rrdata"
    for (const sc of sidecarNames) {
      const m = sc.match(new RegExp(`^${entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.([^.]+)\\.rrdata$`));
      if (m) paths.push(`${entry.path}?vc=${m[1]}`);
    }
    for (const p of paths) {
      const meta = await loadSidecar(p);
      out.push({
        path: p,
        modified: entry.modified || entry.file?.lastModified || 0,
        is_edited: isEdited(meta, coreDefaults()?.adjustments ?? null),
        rating: meta.rating || 0,
        flag: meta.flag ?? null,
        tags: meta.tags ?? null,
        exif: meta.exif ?? null,
        is_virtual_copy: p.includes('?vc='),
        is_cloud_placeholder: false,
        is_raw: isRawName(entry.name),
        group_id: null,
        needs_ai: false,
      });
    }
  }
  return out;
}

// ---- EXIF (read via the WASM core's decoder, cached in IndexedDB) --------------------

export async function readExif(paths: string[]): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  for (const path of paths) {
    const cached = await db.get<Record<string, string>>('kv', `exif:${parseVirtualPath(path).source}`);
    if (cached) out[path] = cached;
  }
  return out;
}

// ---- thumbnails -----------------------------------------------------------------------

const THUMB_DIM = 480;
let queue: string[] = [];
let running = 0;
const MAX_CONCURRENT = 2;
const urls = new Map<string, string>();

function thumbKey(path: string, file: File, meta: any) {
  return `${path}|${file.size}|${file.lastModified}|${JSON.stringify(meta.adjustments ?? null).length}:${hash(JSON.stringify(meta.adjustments ?? null))}`;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function updateThumbnailQueue(paths: string[]) {
  queue = [...paths];
  for (let i = running; i < MAX_CONCURRENT; i++) pumpThumbnails();
}

export function cancelThumbnails() {
  queue = [];
}

async function pumpThumbnails() {
  const path = queue.shift();
  if (!path) return;
  running++;
  try {
    await generateThumbnail(path);
  } catch (e) {
    console.warn('thumbnail failed', path, e);
  } finally {
    running--;
    if (queue.length) pumpThumbnails();
    else if (running === 0) emit('thumbnail-generation-complete', true);
  }
}

function publish(path: string, blob: Blob, meta: any) {
  const old = urls.get(path);
  const url = URL.createObjectURL(blob);
  urls.set(path, url);
  emit('thumbnail-generated', {
    path,
    data: url,
    rating: meta.rating || 0,
    is_edited: isEdited(meta, coreDefaults()?.adjustments ?? null),
  });
  if (old) setTimeout(() => URL.revokeObjectURL(old), 5000);
}

export async function generateThumbnail(path: string, force = false) {
  const { source } = parseVirtualPath(path);
  const file = await vfs.readFile(source);
  const meta = await loadSidecar(path);
  const key = thumbKey(path, file, meta);
  if (!force) {
    const cached = await db.get<{ key: string; blob: Blob }>('thumbs', path);
    if (cached?.key === key) {
      publish(path, cached.blob, meta);
      return;
    }
  }
  const edited = isEdited(meta, coreDefaults()?.adjustments ?? null);
  let blob: Blob | null = null;
  if (edited) {
    blob = await renderPathToBlob(path, meta.adjustments, THUMB_DIM, 'image/jpeg', 0.82).catch((e) => {
      console.warn('edited thumbnail render failed, using embedded preview', e);
      return null;
    });
  }
  if (!blob) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const jpeg = await libraryCore.thumbnail(bytes, vfs.basename(source), THUMB_DIM);
    if (jpeg) blob = new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' });
  }
  if (!blob) {
    // e.g. RAW without embedded preview: develop it.
    blob = await renderPathToBlob(path, meta.adjustments || {}, THUMB_DIM, 'image/jpeg', 0.82);
  }
  await db.set('thumbs', path, { key, blob });
  publish(path, blob, meta);
}

// ---- rendering arbitrary library images ---------------------------------------------

let libraryImage: { source: string; image: DecodedImage; sources: Map<string, SourceImage> } | null = null;
let libraryLock: Promise<any> = Promise.resolve();

/** Decodes `path` in the library worker (one image kept at a time) and renders it. */
export function renderPath(path: string, adjustments: any, maxDim: number) {
  const current = sessionTargetFor(path);
  if (current) return renderTarget(current, adjustments, { maxDim });
  const run = libraryLock.then(async () => {
    const { source } = parseVirtualPath(path);
    if (libraryImage?.source !== source) {
      if (libraryImage) {
        const renderer = await getRenderer();
        libraryImage.sources.forEach((s) => renderer.releaseSource(s));
        await libraryCore.release(libraryImage.image.handle);
        libraryImage = null;
      }
      const file = await vfs.readFile(source);
      const image = await libraryCore.decode(
        new Uint8Array(await file.arrayBuffer()),
        vfs.basename(source),
        settingsJson(),
      );
      libraryImage = { source, image, sources: new Map() };
      db.set('kv', `exif:${source}`, image.exif).catch(() => {});
    }
    const li = libraryImage;
    const target: RenderTarget = {
      core: libraryCore,
      image: li.image,
      sources: li.sources,
      isCurrent: () => libraryImage === li,
    };
    return renderTarget(target, adjustments, { maxDim });
  });
  libraryLock = run.catch(() => {});
  return run;
}

export async function renderPathToBlob(path: string, adjustments: any, maxDim: number, type: string, quality: number) {
  const r = await renderPath(path, adjustments, maxDim);
  return encodePixels(r.pixels, r.width, r.height, type, quality);
}
