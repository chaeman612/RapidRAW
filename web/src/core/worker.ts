/// <reference lib="webworker" />
/**
 * Hosts the RapidRAW WebAssembly core off the main thread. RAW development takes
 * seconds, so every decode/encode runs here and the UI stays responsive.
 */
import init, * as core from '../../core/pkg/rapidraw_core.js';
import wasmUrl from '../../core/pkg/rapidraw_core_bg.wasm?url';

const ready = init({ module_or_path: wasmUrl });
const images = new Map<number, core.WebImage>();
let nextHandle = 1;

type Handler = (...args: any[]) => any;

const handlers: Record<string, Handler> = {
  defaults() {
    const fileTypes = core.supportedFileTypes();
    // Decoded by the browser (see browserTranscode); support varies by browser.
    fileTypes.nonRaw = [...fileTypes.nonRaw, 'heic', 'heif', 'avif'];
    return {
      settings: JSON.parse(core.defaultSettingsJson()),
      adjustments: JSON.parse(core.defaultAdjustmentsJson()),
      fileTypes,
      adjustmentsByteLength: core.adjustmentsByteLength(),
    };
  },
  async decode(bytes: Uint8Array, name: string, settingsJson: string) {
    let image: core.WebImage;
    try {
      image = core.decodeImage(bytes, name, settingsJson);
    } catch (error) {
      // Formats the Rust decoders do not handle (e.g. HEIC from iPhones on Safari)
      // are decoded by the browser and handed over losslessly as PNG.
      const png = await browserTranscode(bytes, 'image/png');
      if (!png) throw error;
      image = core.decodeImage(png, name.replace(/\.[^.]+$/, '') + '.png', settingsJson);
    }
    const handle = nextHandle++;
    images.set(handle, image);
    return {
      handle,
      width: image.width,
      height: image.height,
      isRaw: image.isRaw,
      exif: JSON.parse(image.exifJson()),
      asShotWhiteBalance: JSON.parse(image.asShotWhiteBalanceJson()),
    };
  },
  release(handle: number) {
    images.get(handle)?.free();
    images.delete(handle);
  },
  halves(handle: number, width: number, height: number) {
    return image(handle).rgbaHalves(width, height);
  },
  masks(
    handle: number,
    adjustmentsJson: string,
    width: number,
    height: number,
    scale: number,
    cropX: number,
    cropY: number,
  ) {
    return image(handle).maskBitmaps(adjustmentsJson, width, height, scale, cropX, cropY);
  },
  pack(handle: number, adjustmentsJson: string, settingsJson: string) {
    const packed = image(handle).packAdjustments(adjustmentsJson, settingsJson);
    // serde-wasm-bindgen's JSON-compatible serializer emits bytes as a plain array.
    packed.bytes = Uint8Array.from(packed.bytes);
    return packed;
  },
  auto(handle: number, adjustmentsJson: string, mode: string, settingsJson: string) {
    return JSON.parse(image(handle).autoAdjustments(adjustmentsJson, mode, settingsJson));
  },
  async thumbnail(bytes: Uint8Array, name: string, maxDim: number) {
    return core.quickThumbnail(bytes, name, maxDim) ?? (await browserTranscode(bytes, 'image/jpeg', maxDim));
  },
  analytics(path: string, rgba: Uint8Array, width: number, height: number, waveform: boolean, channel: string | null) {
    return core.analyticsPacket(path, rgba, width, height, waveform, channel ?? undefined);
  },
};

async function browserTranscode(bytes: Uint8Array, type: string, maxDim?: number): Promise<Uint8Array | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
    const scale = maxDim ? Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height)) : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type, quality: 0.85 });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

function image(handle: number) {
  const img = images.get(handle);
  if (!img) throw new Error('Image is no longer loaded.');
  return img;
}

function transferables(value: any): Transferable[] {
  if (value instanceof Uint8Array || value instanceof Uint16Array) return [value.buffer];
  if (value && typeof value === 'object' && value.bytes instanceof Uint8Array) return [value.bytes.buffer];
  return [];
}

self.onmessage = async (event: MessageEvent) => {
  const { id, method, args } = event.data;
  try {
    await ready;
    const result = await handlers[method](...args);
    self.postMessage({ id, result }, transferables(result));
  } catch (error: any) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
};
