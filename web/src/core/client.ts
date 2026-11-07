/** Promise-based RPC to the WASM core workers. */
import CoreWorker from './worker.ts?worker';
import type { PackedAdjustments } from '../gpu/renderer';
import { isMobileUi } from '../platform';

/**
 * Phones give a browser tab far less memory than desktops (iOS Safari reloads
 * the page above roughly 1.5 GB). There, images are kept at most this large on
 * the long edge; crop/mask coordinates still use the full size, so sidecars
 * stay compatible with the desktop app. 0 = no limit.
 */
export const MOBILE_MAX_DIM = isMobileUi ? 4096 : 0;

export interface DecodedImage {
  handle: number;
  /** Real (logical) size; all adjustment coordinates refer to it. */
  width: number;
  height: number;
  /** Size of the pixels kept in memory (smaller on phones, see MOBILE_MAX_DIM). */
  pixelWidth: number;
  pixelHeight: number;
  isRaw: boolean;
  exif: Record<string, string>;
  asShotWhiteBalance: { temperature: number; tint: number } | null;
}

export interface CoreDefaults {
  settings: Record<string, any>;
  adjustments: Record<string, any>;
  fileTypes: { raw: string[]; nonRaw: string[] };
  adjustmentsByteLength: number;
}

class CoreClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

  constructor(private readonly name: string) {}

  private ensure() {
    if (!this.worker) {
      this.worker = new CoreWorker({ name: this.name });
      this.worker.onmessage = (event) => {
        const { id, result, error } = event.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (error !== undefined) p.reject(error);
        else p.resolve(result);
      };
      this.worker.onerror = (event) => {
        console.error(`[${this.name}] worker error`, event.message);
      };
    }
    return this.worker;
  }

  call<T>(method: string, args: any[] = [], transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ensure().postMessage({ id, method, args }, transfer);
    });
  }

  defaults() {
    return this.call<CoreDefaults>('defaults');
  }
  decode(bytes: Uint8Array, name: string, settingsJson: string) {
    return this.call<DecodedImage>('decode', [bytes, name, settingsJson, MOBILE_MAX_DIM], [bytes.buffer]);
  }
  release(handle: number) {
    return this.call<void>('release', [handle]);
  }
  halves(handle: number, width: number, height: number) {
    return this.call<Uint16Array>('halves', [handle, width, height]);
  }
  masks(
    handle: number,
    adjustmentsJson: string,
    width: number,
    height: number,
    scale: number,
    cropX: number,
    cropY: number,
  ) {
    return this.call<Uint8Array>('masks', [handle, adjustmentsJson, width, height, scale, cropX, cropY]);
  }
  pack(handle: number, adjustmentsJson: string, settingsJson: string) {
    return this.call<PackedAdjustments>('pack', [handle, adjustmentsJson, settingsJson]);
  }
  auto(handle: number, adjustmentsJson: string, mode: string, settingsJson: string) {
    return this.call<Record<string, any>>('auto', [handle, adjustmentsJson, mode, settingsJson]);
  }
  thumbnail(bytes: Uint8Array, name: string, maxDim: number) {
    return this.call<Uint8Array | null>('thumbnail', [bytes, name, maxDim], [bytes.buffer]);
  }
  analytics(path: string, rgba: Uint8Array, width: number, height: number, waveform: boolean, channel: string | null) {
    return this.call<Uint8Array>('analytics', [path, rgba, width, height, waveform, channel], [rgba.buffer]);
  }
}

/** Editing session: decode of the open image, uniforms, masks, analytics. */
export const editorCore = new CoreClient('rapidraw-editor');
/**
 * Library: thumbnails and full decodes for batch jobs (export, edited thumbnails).
 * Phones share the editor's worker so only one WebAssembly heap exists.
 */
export const libraryCore = isMobileUi ? editorCore : new CoreClient('rapidraw-library');
