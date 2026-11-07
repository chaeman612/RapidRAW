/**
 * Browser implementation of the Tauri commands the RapidRAW frontend invokes.
 * Command names and argument/return shapes follow src-tauri/src.
 * Desktop-only features (AI models, tethering, Immich, panorama/HDR/focus stacking,
 * external editors) resolve to inert defaults so the UI keeps working.
 */
import * as db from './db';
import * as editor from './editor';
import { emit } from './events';
import { exportImages, cancelExport, estimateExportSize } from './export';
import * as library from './library';
import { coreDefaults, initDefaults, loadSettings, saveSettings } from './settings';
import {
  COLOR_TAG_PREFIX,
  deleteSidecar,
  loadSidecar,
  parseVirtualPath,
  saveSidecar,
  updateSidecars,
  type ImageMetadata,
} from './sidecars';
import * as vfs from './vfs';

type Handler = (args: any) => any;

const kv = {
  get: async <T>(key: string, fallback: T): Promise<T> => (await db.get<T>('kv', key)) ?? fallback,
  set: (key: string, value: any) => db.set('kv', key, value),
};

function defaultsAdjustments() {
  return structuredClone(coreDefaults()?.adjustments ?? {});
}

async function refreshThumbnail(path: string) {
  await library.generateThumbnail(path, true).catch((e) => console.warn('thumbnail refresh failed', e));
}

const commands: Record<string, Handler> = {
  // ---- app lifecycle / settings -------------------------------------------------
  frontend_ready: () => null,
  // The frontend log bridge already printed the message to the console; desktop
  // forwards it to a log file. Logging again here would loop through the bridge.
  frontend_log: () => null,
  load_settings: () => loadSettings(),
  save_settings: ({ settings }) => saveSettings(settings),
  set_ui_scale: () => null,
  get_supported_file_types: async () => (await initDefaults()).fileTypes,
  get_log_file_path: () => 'Browser developer console',
  is_tethering_supported: () => false,
  is_wgpu_renderer_supported: () => false,
  subscribe_analytics: ({ channel }) => editor.setAnalyticsChannel(channel),
  get_storage_usage: async () => ({
    thumbnails: 0,
    aiDenoise: 0,
    aiMaps: 0,
    metadata: 0,
    immich: 0,
    models: 0,
    logs: 0,
  }),
  clear_thumbnail_cache: () => db.clear('thumbs'),
  clear_metadata_cache: () => null,
  clear_session_caches: () => null,
  clear_image_caches: () => null,
  release_original_preview: () => null,
  update_wgpu_transform: () => null,
  preload_images: () => null,
  is_image_cached: () => false,

  // ---- folders & library -------------------------------------------------------------
  get_folder_tree: ({ path, expandedFolders, showImageCounts }) =>
    library.getFolderTree(path, expandedFolders, showImageCounts),
  get_folder_children: ({ path, showImageCounts }) => library.getFolderChildren(path, showImageCounts),
  get_pinned_folder_trees: async ({ paths, expandedFolders, showImageCounts }) => {
    const out = [];
    for (const p of paths || []) {
      try {
        out.push(await library.getFolderTree(p, expandedFolders, showImageCounts));
      } catch (e) {
        console.warn('pinned folder unavailable', p, e);
      }
    }
    return out;
  },
  list_images_in_dir: ({ path }) => library.listImages(path, false),
  list_images_recursive: ({ path }) => library.listImages(path, true),
  start_background_indexing: () => null,
  update_thumbnail_queue: ({ paths }) => library.updateThumbnailQueue(paths || []),
  cancel_thumbnail_generation: () => library.cancelThumbnails(),
  read_exif_for_paths: ({ paths }) => library.readExif(paths || []),
  create_folder: ({ path }) => vfs.createDir(path),
  show_in_finder: () => null,
  get_or_create_internal_library_root: () => vfs.libraryRoot(),
  resolve_android_content_uri_name: ({ uriStr }) => vfs.basename(uriStr),
  import_files: (args) => importFiles(args),
  delete_files_from_disk: ({ paths }) => deleteFiles(paths || [], false),
  delete_files_with_associated: ({ paths }) => deleteFiles(paths || [], true),
  copy_files: ({ sourcePaths, destinationFolder }) => transferFiles(sourcePaths || [], destinationFolder, false),
  move_files: ({ sourcePaths, destinationFolder }) => transferFiles(sourcePaths || [], destinationFolder, true),
  duplicate_file: async ({ path }) => {
    const { source } = parseVirtualPath(path);
    const copy = await vfs.copyFile(source, vfs.dirname(source));
    if (!copy) throw 'This folder is read-only in the browser.';
    await saveSidecar(copy, structuredClone(await loadSidecar(path)));
    return copy;
  },
  rename_files: async ({ paths, nameTemplate }) => {
    const out: string[] = [];
    let seq = 1;
    for (const path of paths || []) {
      const { source } = parseVirtualPath(path);
      const name = vfs.basename(source);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      const newName = `${String(nameTemplate || '{original_filename}')
        .replace(/\{original_filename\}/g, stem)
        .replace(/\{sequence\}/g, String(seq++))}${ext}`;
      const moved = await vfs.copyFile(source, vfs.dirname(source), newName);
      if (!moved) throw 'This folder is read-only in the browser.';
      await saveSidecar(moved, structuredClone(await loadSidecar(source)));
      await vfs.removeFile(source);
      await deleteSidecar(source);
      out.push(moved);
    }
    return out;
  },
  delete_folder: async ({ path }) => {
    if (!(await vfs.removeDir(path))) throw 'This folder cannot be deleted from the browser.';
  },
  rename_folder: async ({ path, newName }) => {
    const node: any = await vfs.resolve(path);
    if (node?.handle?.move) {
      await node.handle.move(newName);
      const parent: any = await vfs.resolve(vfs.dirname(path));
      if (parent) parent.loaded = !parent.handle;
      return;
    }
    throw 'Renaming folders is not supported in this browser.';
  },

  // ---- metadata --------------------------------------------------------------------------
  load_metadata: ({ path }) => loadSidecar(path),
  save_metadata_and_update_thumbnail: async ({ path, adjustments }) => {
    const meta = structuredClone(await loadSidecar(path));
    meta.adjustments = adjustments;
    if (typeof adjustments?.rating === 'number') meta.rating = adjustments.rating;
    await saveSidecar(path, meta);
    refreshThumbnail(path);
  },
  apply_adjustments_to_paths: async ({ paths, adjustments }) => {
    await updateSidecars(paths, (meta) => {
      const base = meta.adjustments && !meta.adjustments.is_null ? meta.adjustments : defaultsAdjustments();
      meta.adjustments = { ...base, ...adjustments };
    });
    paths.forEach(refreshThumbnail);
  },
  reset_adjustments_for_paths: async ({ paths }) => {
    await updateSidecars(paths, (meta) => {
      meta.adjustments = { ...defaultsAdjustments(), rating: meta.rating };
    });
    paths.forEach(refreshThumbnail);
  },
  set_rating_for_paths: ({ paths, rating }) =>
    updateSidecars(paths, (meta) => {
      meta.rating = rating;
      if (meta.adjustments && typeof meta.adjustments === 'object') meta.adjustments.rating = rating;
    }),
  set_flag_for_paths: ({ paths, flag }) =>
    updateSidecars(paths, (meta) => {
      meta.flag = flag || null;
    }),
  set_color_label_for_paths: ({ paths, color }) =>
    updateSidecars(paths, (meta) => {
      const tags = (meta.tags || []).filter((t) => !t.startsWith(COLOR_TAG_PREFIX));
      if (color) tags.push(`${COLOR_TAG_PREFIX}${color}`);
      meta.tags = tags.length ? tags : null;
    }),
  add_tag_for_paths: ({ paths, tag }) =>
    updateSidecars(paths, (meta) => {
      const tags = new Set(meta.tags || []);
      tags.add(tag);
      meta.tags = [...tags];
    }),
  remove_tag_for_paths: ({ paths, tag }) =>
    updateSidecars(paths, (meta) => {
      meta.tags = (meta.tags || []).filter((t) => t !== tag);
    }),
  clear_all_tags: ({ paths }) =>
    updateSidecars(paths || [], (meta) => {
      meta.tags = (meta.tags || []).filter((t) => t.startsWith(COLOR_TAG_PREFIX));
    }),
  clear_ai_tags: () => null,
  clear_all_sidecars: async ({ rootPath }) => {
    for (const key of await db.keys('sidecars')) if (!rootPath || key.startsWith(rootPath)) await deleteSidecar(key);
  },
  create_virtual_copy: async ({ sourceVirtualPath }) => {
    const { source } = parseVirtualPath(sourceVirtualPath);
    const id = Math.random().toString(36).slice(2, 8);
    const copy = `${source}?vc=${id}`;
    const meta = structuredClone(await loadSidecar(sourceVirtualPath));
    await saveSidecar(copy, meta);
    return copy;
  },

  // ---- editor ------------------------------------------------------------------------------
  load_image: ({ path }) => editor.loadImage(path),
  apply_adjustments: (args) => editor.applyAdjustments(args),
  generate_uncropped_preview: (args) => editor.generateUncroppedPreview(args),
  generate_preset_preview: (args) => editor.generatePresetPreview(args),
  generate_mask_overlay: (args) => editor.generateMaskOverlay(args),
  calculate_auto_adjustments: (args) => editor.calculateAutoAdjustments(args),
  generate_preview_for_path: async ({ path, jsAdjustments }) =>
    new Uint8Array(
      await (await library.renderPathToBlob(path, jsAdjustments || {}, 1280, 'image/jpeg', 0.85)).arrayBuffer(),
    ),
  get_image_dimensions: async ({ path }) => {
    const s = editor.currentImage();
    if (s && s.path === path) return { width: s.image.width, height: s.image.height };
    const r = await library.renderPath(path, {}, 64);
    return { width: r.width, height: r.height };
  },
  apply_auto_adjustments_to_paths: () => {
    throw new Error('Batch auto adjustments are not available in RapidRAW Web yet.');
  },

  // ---- export -----------------------------------------------------------------------------
  export_images: (args) => exportImages(args),
  cancel_export: () => cancelExport(),
  estimate_export_sizes: (args) => estimateExportSize(args),

  // ---- presets ------------------------------------------------------------------------------
  load_presets: () => kv.get('presets', []),
  save_presets: ({ presets }) => kv.set('presets', presets),
  handle_export_presets_to_file: async ({ presetsToExport, filePath }) => {
    const json = JSON.stringify({ creator: 'Anonymous', presets: presetsToExport }, null, 2);
    if (!(await vfs.writeFile(filePath, json)))
      vfs.download(vfs.basename(filePath), new Blob([json], { type: 'application/json' }));
  },
  handle_import_presets_from_file: async ({ filePath }) => importPresets([filePath]).then((r) => r.presets),
  handle_import_legacy_presets_from_file: async ({ filePath }) => importPresets([filePath]).then((r) => r.presets),
  handle_import_presets_from_files: ({ filePaths }) => importPresets(filePaths || []),
  fetch_community_presets: async () => {
    const res = await fetch('https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/manifest.json');
    if (!res.ok) throw new Error(`Failed to fetch community presets (${res.status})`);
    return res.json();
  },
  save_community_preset: async ({ name, adjustments, folderName }) => {
    const presets: any[] = await kv.get('presets', []);
    const preset = { preset: { id: crypto.randomUUID(), name, adjustments } };
    const folder = folderName && presets.find((p) => p.folder?.name === folderName);
    if (folder) folder.folder.children.push(preset.preset);
    else presets.push(preset);
    await kv.set('presets', presets);
  },
  generate_all_community_previews: () => ({}),

  // ---- albums ----------------------------------------------------------------------------------
  get_albums: () => kv.get('albums', []),
  save_albums: ({ tree }) => kv.set('albums', tree),
  add_to_album: async ({ albumId, paths }) => {
    const albums: any[] = await kv.get('albums', []);
    const visit = (items: any[]) => {
      for (const item of items) {
        if (item.album?.id === albumId) item.album.images = [...new Set([...(item.album.images || []), ...paths])];
        if (item.folder?.children) visit(item.folder.children);
      }
    };
    visit(albums);
    await kv.set('albums', albums);
  },
  get_album_images: async ({ paths }) => {
    const out = [];
    for (const p of paths || []) {
      try {
        const dir = vfs.dirname(parseVirtualPath(p).source);
        const all = await library.listImages(dir);
        const hit = all.find((f) => f.path === p);
        if (hit) out.push(hit);
      } catch {
        /* missing */
      }
    }
    return out;
  },

  // ---- inert desktop-only features ---------------------------------------------------------------
  get_ai_jobs_status: () => ({ current: null, queued: 0, completed: 0, paused: false, failed: [] }),
  get_pending_ai_paths: () => [],
  check_ai_connector_status: () => false,
  list_luts: () => [],
  tether_list_cameras: () => [],
  get_lensfun_makers: () => [],
  get_lensfun_lenses_for_maker: () => [],
  get_lens_correction_info: () => null,
};

const AI_COMMANDS =
  /^(generate_ai_|queue_ai_|precompute_ai|invoke_generative|generate_full_image_depth|generate_relight|cull_images|stitch_|merge_hdr|save_panorama|save_hdr|save_focus_stack|tether_|edit_in_app)/;

/** Mirrors desktop `import_files` (used by the mobile library's Import button). */
async function importFiles({ sourcePaths = [], destinationFolder, settings = {} }: any) {
  const total = sourcePaths.length;
  emit('import-start', { total });
  try {
    for (let i = 0; i < total; i++) {
      const src = sourcePaths[i];
      emit('import-progress', { current: i, total, path: src });
      const file = await vfs.readFile(src);
      let folder = destinationFolder;
      if (settings.organizeByDate) {
        const d = new Date(file.lastModified || Date.now());
        const pad = (n: number) => String(n).padStart(2, '0');
        const sub = String(settings.dateFolderFormat || 'YYYY/MM-DD')
          .replace('YYYY', String(d.getFullYear()))
          .replace('MM', pad(d.getMonth() + 1))
          .replace('DD', pad(d.getDate()));
        folder = vfs.join(destinationFolder, sub);
        await vfs.createDirs(folder);
      }
      const name = vfs.basename(src);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      const target = `${String(settings.filenameTemplate || '{original_filename}')
        .replace(/\{original_filename\}/g, stem)
        .replace(/\{sequence\}/g, String(i + 1))}${ext}`;
      if (!(await vfs.copyFile(src, folder, target))) throw new Error(`Could not save ${name} into the library.`);
    }
    emit('import-progress', { current: total, total, path: '' });
    emit('import-complete');
  } catch (e: any) {
    emit('import-error', String(e?.message ?? e));
    throw String(e?.message ?? e);
  }
}

async function deleteFiles(paths: string[], _withAssociated: boolean) {
  for (const path of paths) {
    const { source, copyId } = parseVirtualPath(path);
    if (!copyId && !(await vfs.removeFile(source))) throw 'This folder is read-only in the browser.';
    await deleteSidecar(path);
    await db.del('thumbs', path);
  }
}

async function transferFiles(paths: string[], destination: string, move: boolean) {
  for (const path of paths) {
    const { source } = parseVirtualPath(path);
    const copy = await vfs.copyFile(source, destination);
    if (!copy) throw 'The destination folder is read-only in the browser.';
    await saveSidecar(copy, structuredClone(await loadSidecar(source)));
    if (move) {
      await vfs.removeFile(source);
      await deleteSidecar(source);
    }
  }
}

async function importPresets(paths: string[]) {
  const presets: any[] = await kv.get('presets', []);
  const failures: any[] = [];
  for (const p of paths) {
    try {
      const data = JSON.parse(await (await vfs.readFile(p)).text());
      const items = Array.isArray(data) ? data : data.presets || [];
      presets.push(...items);
    } catch (e: any) {
      failures.push({ fileName: vfs.basename(p), error: String(e?.message || e) });
    }
  }
  await kv.set('presets', presets);
  return { presets, failures };
}

const warned = new Set<string>();

export async function dispatch(cmd: string, args: any): Promise<any> {
  const handler = commands[cmd];
  if (handler) {
    try {
      return await handler(args || {});
    } catch (e: any) {
      // Tauri rejects with the error string; the frontend often shows it as-is.
      throw typeof e === 'string' ? e : String(e?.message ?? e);
    }
  }
  if (AI_COMMANDS.test(cmd)) throw `This feature is not available in RapidRAW Web yet (${cmd}).`;
  if (!warned.has(cmd)) {
    warned.add(cmd);
    console.debug(`[rapidraw-web] command "${cmd}" is not implemented in the browser; returning null`);
  }
  return null;
}

// Keep the event import used for consumers that want backend-originated events.
export { emit };
export type { ImageMetadata };
