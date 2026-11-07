/** App settings persisted in IndexedDB, seeded with the desktop defaults. */
import { editorCore, type CoreDefaults } from '../core/client';
import * as db from './db';
import { isMobileUi } from '../platform';

/** Defaults the desktop app uses on Android, applied to phones and tablets. */
const MOBILE_DEFAULTS = {
  editorPreviewResolution: 1280,
  thumbnailSize: 'small',
  highResZoomMultiplier: 0.75,
  imageCacheSize: 2,
  libraryViewMode: 'recursive',
};

let defaults: CoreDefaults | null = null;
let settings: Record<string, any> = {};

export async function initDefaults() {
  if (!defaults) {
    defaults = await editorCore.defaults();
    const stored = (await db.get<Record<string, any>>('kv', 'settings')) || {};
    settings = webOverrides({ ...defaults.settings, ...(isMobileUi ? MOBILE_DEFAULTS : {}), ...stored });
  }
  return defaults;
}

/** Desktop-only features that have no browser equivalent. */
function webOverrides(s: Record<string, any>) {
  return {
    ...s,
    useWgpuRenderer: false,
    decorations: false,
    enableAiTagging: false,
    useAppleRaw9: false,
  };
}

export function currentSettings() {
  return settings;
}

export function settingsJson() {
  return JSON.stringify(settings);
}

export async function loadSettings() {
  await initDefaults();
  return settings;
}

export async function saveSettings(next: Record<string, any>) {
  settings = webOverrides({ ...settings, ...next });
  await db.set('kv', 'settings', settings);
}

export function coreDefaults() {
  return defaults;
}
