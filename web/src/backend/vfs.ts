/**
 * Virtual file system for the web build.
 *
 * Desktop RapidRAW works on real paths. In the browser we expose folders the user
 * picked as virtual absolute paths ("/<folder name>/sub/IMG_0001.CR3"):
 *  - Chromium: File System Access API directory handles (read + write, persisted
 *    in IndexedDB so "Continue session" works after a reload).
 *  - Other browsers: <input webkitdirectory> uploads (read-only, session only).
 */
import * as db from './db';

export interface VNode {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  handle?: FileSystemDirectoryHandle | FileSystemFileHandle;
  file?: File;
  children?: Map<string, VNode>;
  loaded?: boolean;
  /** In-memory folder that accepts writes (library fallback without OPFS). */
  memory?: boolean;
  modified: number;
  created: number;
}

const roots = new Map<string, VNode>();
const UPLOADS = '/Uploads';

export const supportsDirectoryHandles = typeof (window as any).showDirectoryPicker === 'function';

export function normalize(path: string) {
  let p = path.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function basename(path: string) {
  return normalize(path).split('/').pop() || '';
}

export function dirname(path: string) {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function join(...parts: string[]) {
  return normalize(parts.filter(Boolean).join('/'));
}

function uniqueRootPath(name: string) {
  let path = `/${name}`;
  for (let i = 2; roots.has(path); i++) path = `/${name} (${i})`;
  return path;
}

function dirNode(name: string, path: string, handle?: FileSystemDirectoryHandle): VNode {
  return {
    name,
    path,
    kind: 'dir',
    handle,
    children: new Map(),
    loaded: !handle,
    modified: Date.now(),
    created: Date.now(),
  };
}

async function persistRoots() {
  const handles: Record<string, FileSystemDirectoryHandle> = {};
  for (const [path, node] of roots) {
    if (node.handle && node.kind === 'dir') handles[path] = node.handle as FileSystemDirectoryHandle;
  }
  await db.set('handles', 'roots', handles);
}

/** Re-attaches folders picked in a previous session (Chromium only). */
export async function restoreRoots(): Promise<string[]> {
  const handles = (await db.get<Record<string, FileSystemDirectoryHandle>>('handles', 'roots')) || {};
  for (const [path, handle] of Object.entries(handles)) {
    if (!roots.has(path)) roots.set(path, dirNode(handle.name, path, handle));
  }
  return Object.keys(handles);
}

export function rootPaths() {
  return [...roots.keys()].filter((p) => p !== UPLOADS);
}

async function ensurePermission(handle: FileSystemHandle, mode: 'read' | 'readwrite' = 'read') {
  const h = handle as any;
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode })) === 'granted') return true;
  try {
    return (await h.requestPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

/** Shows a folder picker and registers the folder. Returns its virtual path. */
export async function pickDirectory(): Promise<string | null> {
  if (supportsDirectoryHandles) {
    try {
      const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
        mode: 'readwrite',
        id: 'rapidraw',
      });
      for (const [path, node] of roots) {
        if (node.handle && (await (node.handle as any).isSameEntry?.(handle))) return path;
      }
      const path = uniqueRootPath(handle.name);
      roots.set(path, dirNode(handle.name, path, handle));
      await persistRoots();
      return path;
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      console.warn('showDirectoryPicker failed, falling back to upload', e);
    }
  }
  const files = await chooseFiles({ directory: true, multiple: true });
  if (!files.length) return null;
  const top = (files[0] as any).webkitRelativePath?.split('/')[0] || 'Folder';
  const path = uniqueRootPath(top);
  const root = dirNode(top, path);
  roots.set(path, root);
  for (const file of files) {
    const rel: string = (file as any).webkitRelativePath || file.name;
    const parts = rel.split('/').slice(1);
    addFileNode(root, parts, file);
  }
  return path;
}

function addFileNode(root: VNode, parts: string[], file: File) {
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    let child = dir.children!.get(part);
    if (!child) {
      child = dirNode(part, `${dir.path}/${part}`);
      dir.children!.set(part, child);
    }
    dir = child;
  }
  const name = parts[parts.length - 1];
  dir.children!.set(name, {
    name,
    path: `${dir.path}/${name}`,
    kind: 'file',
    file,
    modified: file.lastModified,
    created: file.lastModified,
  });
}

/** Opens a file picker; selected files are registered under /Uploads. */
export async function pickFiles(options: { multiple?: boolean; accept?: string[] } = {}): Promise<string[]> {
  const files = await chooseFiles({ multiple: options.multiple, accept: options.accept });
  if (!files.length) return [];
  let uploads = roots.get(UPLOADS);
  if (!uploads) {
    uploads = dirNode('Uploads', UPLOADS);
    roots.set(UPLOADS, uploads);
  }
  return files.map((file) => {
    addFileNode(uploads!, [file.name], file);
    return `${UPLOADS}/${file.name}`;
  });
}

function chooseFiles(options: { directory?: boolean; multiple?: boolean; accept?: string[] }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!options.multiple;
    if (options.directory) (input as any).webkitdirectory = true;
    if (options.accept?.length) input.accept = options.accept.map((e) => (e.startsWith('.') ? e : `.${e}`)).join(',');
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => finish([...(input.files || [])]);
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });
}

async function loadChildren(node: VNode) {
  if (node.kind !== 'dir' || node.loaded || !node.handle) return;
  const handle = node.handle as FileSystemDirectoryHandle;
  if (!(await ensurePermission(handle))) throw new Error(`Permission to read "${node.name}" was not granted.`);
  const children = new Map<string, VNode>();
  for await (const [name, entry] of (handle as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith('.')) continue;
    if (entry.kind === 'directory') {
      children.set(name, dirNode(name, `${node.path}/${name}`, entry as FileSystemDirectoryHandle));
    } else {
      children.set(name, {
        name,
        path: `${node.path}/${name}`,
        kind: 'file',
        handle: entry as FileSystemFileHandle,
        modified: 0,
        created: 0,
      });
    }
  }
  node.children = children;
  node.loaded = true;
}

/** Resolves a virtual path to its node, loading directories on the way. */
export async function resolve(path: string): Promise<VNode | null> {
  const p = normalize(path);
  let rootPath = '';
  for (const r of roots.keys()) {
    if ((p === r || p.startsWith(`${r}/`)) && r.length > rootPath.length) rootPath = r;
  }
  if (!rootPath) return null;
  let node = roots.get(rootPath)!;
  const rest = p.slice(rootPath.length).split('/').filter(Boolean);
  for (const part of rest) {
    await loadChildren(node);
    const next = node.children?.get(part);
    if (!next) return null;
    node = next;
  }
  return node;
}

export async function list(path: string): Promise<VNode[]> {
  const node = await resolve(path);
  if (!node || node.kind !== 'dir') throw new Error(`Folder not found: ${path}`);
  await loadChildren(node);
  return [...node.children!.values()];
}

export async function readFile(path: string): Promise<File> {
  const node = await resolve(path);
  if (!node || node.kind !== 'file') throw new Error(`File not found: ${path}`);
  if (node.file) return node.file;
  const file = await (node.handle as FileSystemFileHandle).getFile();
  node.modified = file.lastModified;
  node.created = node.created || file.lastModified;
  return file;
}

export async function exists(path: string) {
  return !!(await resolve(path));
}

/** Writes into a picked folder when it is writable. Returns false otherwise. */
export async function writeFile(path: string, data: Blob | string): Promise<boolean> {
  const dir = await resolve(dirname(path));
  if (dir && dir.kind === 'dir' && !dir.handle && dir.memory) {
    const name = basename(path);
    const file = new File([data], name, { lastModified: Date.now() });
    dir.children!.set(name, {
      name,
      path: `${dir.path}/${name}`,
      kind: 'file',
      file,
      modified: Date.now(),
      created: Date.now(),
    });
    return true;
  }
  if (!dir || dir.kind !== 'dir' || !dir.handle) return false;
  const handle = dir.handle as FileSystemDirectoryHandle;
  if (!(await ensurePermission(handle, 'readwrite'))) return false;
  try {
    const name = basename(path);
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await (fileHandle as any).createWritable();
    await writable.write(data);
    await writable.close();
    if (dir.loaded) {
      dir.children!.set(name, {
        name,
        path: `${dir.path}/${name}`,
        kind: 'file',
        handle: fileHandle,
        modified: Date.now(),
        created: Date.now(),
      });
    }
    return true;
  } catch (e) {
    console.warn('writeFile failed', path, e);
    return false;
  }
}

export async function removeFile(path: string): Promise<boolean> {
  const dir = await resolve(dirname(path));
  if (dir?.memory && !dir.handle) return dir.children!.delete(basename(path));
  if (!dir?.handle) return false;
  try {
    await (dir.handle as FileSystemDirectoryHandle).removeEntry(basename(path));
    dir.children?.delete(basename(path));
    return true;
  } catch {
    return false;
  }
}

export async function createDir(path: string): Promise<boolean> {
  const parent = await resolve(dirname(path));
  if (!parent) return false;
  const name = basename(path);
  if (parent.handle) {
    try {
      const h = await (parent.handle as FileSystemDirectoryHandle).getDirectoryHandle(name, { create: true });
      if (parent.loaded) parent.children!.set(name, dirNode(name, `${parent.path}/${name}`, h));
      return true;
    } catch {
      return false;
    }
  }
  if (!parent.memory) return false;
  parent.children!.set(name, { ...dirNode(name, `${parent.path}/${name}`), memory: true });
  return true;
}

/** Creates `path` and any missing parents. */
export async function createDirs(path: string): Promise<boolean> {
  const p = normalize(path);
  if (await exists(p)) return true;
  if (!(await createDirs(dirname(p)))) return false;
  return createDir(p);
}

export async function removeDir(path: string): Promise<boolean> {
  const parent = await resolve(dirname(path));
  const name = basename(path);
  if (!parent) return false;
  if (parent.handle) {
    try {
      await (parent.handle as FileSystemDirectoryHandle).removeEntry(name, { recursive: true });
    } catch {
      return false;
    }
  }
  parent.children?.delete(name);
  return true;
}

/** Copies a file (any readable path) into a writable folder; returns the new path. */
export async function copyFile(
  source: string,
  destinationFolder: string,
  name = basename(source),
): Promise<string | null> {
  const file = await readFile(source);
  let target = join(destinationFolder, name);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; await exists(target); i++) target = join(destinationFolder, `${stem}_${i}${ext}`);
  return (await writeFile(target, file)) ? target : null;
}

// ---- in-browser photo library (phones/tablets) -------------------------------------

export const LIBRARY = '/Library';

/**
 * Persistent photo library inside the browser's Origin Private File System, used
 * where folders cannot be opened directly (mobile browsers). Mirrors the desktop
 * Android app's internal library.
 */
export async function libraryRoot(): Promise<string> {
  if (roots.has(LIBRARY)) return LIBRARY;
  try {
    const opfs = await navigator.storage.getDirectory();
    const handle = await opfs.getDirectoryHandle('RapidRAW Library', { create: true });
    roots.set(LIBRARY, dirNode('Library', LIBRARY, handle));
    (navigator.storage as any).persist?.().catch(() => {});
  } catch (e) {
    console.warn('OPFS unavailable; the library will only last for this session', e);
    roots.set(LIBRARY, { ...dirNode('Library', LIBRARY), memory: true });
  }
  return LIBRARY;
}

export function forgetRoot(path: string) {
  roots.delete(normalize(path));
  return persistRoots();
}

/** Saves a blob through the browser's download mechanism. */
export function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Paths that live in the virtual "Downloads" location (returned by save dialogs). */
export const DOWNLOADS = '/Downloads';
export function isDownloadPath(path: string) {
  return normalize(path).startsWith(`${DOWNLOADS}/`) || normalize(path) === DOWNLOADS;
}
