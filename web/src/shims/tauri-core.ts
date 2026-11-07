/** Browser replacement for `@tauri-apps/api/core`. */
import { dispatch } from '../backend/commands';

export async function invoke<T = any>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  return dispatch(cmd, args) as Promise<T>;
}

export class Channel<T = unknown> {
  id = Math.floor(Math.random() * 1e9);
  onmessage: (response: T) => void = () => {};
  constructor(onmessage?: (response: T) => void) {
    if (onmessage) this.onmessage = onmessage;
  }
  toJSON() {
    return `__CHANNEL__:${this.id}`;
  }
}

/** Paths handed to the UI are already blob:/data: URLs in the web build. */
export function convertFileSrc(filePath: string, _protocol = 'asset') {
  return filePath;
}

export function isTauri() {
  return false;
}

export class Resource {
  constructor(public rid: number) {}
  async close() {}
}

export type InvokeArgs = Record<string, unknown>;
