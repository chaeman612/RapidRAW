/**
 * Image metadata ("sidecar") storage.
 *
 * Same format and file name as desktop RapidRAW (`<image>.rrdata` next to the
 * image), so edits round-trip between the web and desktop apps when the folder
 * is writable. A copy is always kept in IndexedDB as a cache / fallback.
 */
import * as db from './db';
import DEFAULT_ADJUSTMENTS from '../../../src/utils/defaultAdjustments.json';
import * as vfs from './vfs';

export interface ImageMetadata {
  version: number;
  rating: number;
  flag?: 'pick' | 'reject' | null;
  adjustments: any;
  tags: string[] | null;
  exif?: Record<string, string>;
}

const cache = new Map<string, ImageMetadata>();

export const COLOR_TAG_PREFIX = 'color:';
export const USER_TAG_PREFIX = 'user:';

/** Mirrors desktop `parse_virtual_path`: "file.ext?vc=id" -> virtual copy. */
export function parseVirtualPath(path: string) {
  const [source, copyId] = path.split('?vc=');
  const name = vfs.basename(source);
  const sidecar = vfs.join(vfs.dirname(source), copyId ? `${name}.${copyId}.rrdata` : `${name}.rrdata`);
  return { source, copyId: copyId || null, sidecar };
}

function blank(): ImageMetadata {
  return { version: 1, rating: 0, adjustments: null, tags: null };
}

export async function loadSidecar(path: string): Promise<ImageMetadata> {
  const hit = cache.get(path);
  if (hit) return hit;
  const { sidecar } = parseVirtualPath(path);
  let meta: ImageMetadata | undefined;
  try {
    if (await vfs.exists(sidecar)) {
      const text = await (await vfs.readFile(sidecar)).text();
      meta = { ...blank(), ...JSON.parse(text) };
    }
  } catch (e) {
    console.warn('Failed to read sidecar', sidecar, e);
  }
  if (!meta) meta = (await db.get<ImageMetadata>('sidecars', path)) || blank();
  cache.set(path, meta);
  return meta;
}

export async function saveSidecar(path: string, meta: ImageMetadata) {
  cache.set(path, meta);
  await db.set('sidecars', path, meta);
  const { sidecar } = parseVirtualPath(path);
  const { exif: _exif, ...persisted } = meta;
  await vfs.writeFile(sidecar, JSON.stringify(persisted, null, 2));
}

export async function updateSidecars(paths: string[], fn: (meta: ImageMetadata) => void) {
  for (const path of paths) {
    const meta = structuredClone(await loadSidecar(path));
    fn(meta);
    await saveSidecar(path, meta);
  }
}

export async function deleteSidecar(path: string) {
  cache.delete(path);
  await db.del('sidecars', path);
  await vfs.removeFile(parseVirtualPath(path).sidecar);
}

const IGNORED_KEYS = new Set([
  'activeTools',
  'sectionVisibility',
  'baselineExposure',
  'rating',
  'aspectRatio',
  'showClipping',
  'is_null',
]);

function jsonEqual(a: any, b: any): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return a === b || ((a === null || a === undefined) && (b === null || b === undefined));
}

/**
 * Library "edited" badge. Follows desktop `is_default_adjustments`: an image is
 * edited when any adjustment differs from src/utils/defaultAdjustments.json.
 */
export function isEdited(meta: ImageMetadata, _unused?: unknown) {
  const adj = meta?.adjustments;
  if (!adj || typeof adj !== 'object' || adj.is_null) return false;
  for (const [key, value] of Object.entries(adj)) {
    if (IGNORED_KEYS.has(key)) continue;
    if (!(key in DEFAULT_ADJUSTMENTS)) continue;
    if (!jsonEqual(value, (DEFAULT_ADJUSTMENTS as any)[key])) return true;
  }
  return false;
}
