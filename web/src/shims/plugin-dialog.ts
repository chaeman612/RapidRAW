/** Browser replacement for `@tauri-apps/plugin-dialog`. */
import * as vfs from '../backend/vfs';

interface Filter {
  name: string;
  extensions: string[];
}
interface OpenOptions {
  directory?: boolean;
  multiple?: boolean;
  filters?: Filter[];
  defaultPath?: string;
  title?: string;
}

export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  if (options.directory) {
    // Without the File System Access API a picked folder can only be read
    // (uploaded); destinations such as export folders become browser downloads.
    if (!vfs.supportsDirectoryHandles && options.title) return vfs.DOWNLOADS;
    return vfs.pickDirectory();
  }
  const accept = (options.filters || []).flatMap((f) => f.extensions).filter((e) => e && e !== '*');
  const paths = await vfs.pickFiles({ multiple: options.multiple, accept });
  if (!paths.length) return null;
  return options.multiple ? paths : paths[0];
}

export async function save(
  options: { defaultPath?: string; filters?: Filter[]; title?: string } = {},
): Promise<string | null> {
  const name = vfs.basename(options.defaultPath || 'export');
  return `${vfs.DOWNLOADS}/${name}`;
}

export async function ask(message: string, _options?: unknown) {
  return window.confirm(message);
}
export async function confirm(message: string, _options?: unknown) {
  return window.confirm(message);
}
export async function message(msg: string, _options?: unknown) {
  window.alert(msg);
}
