/**
 * Editing session: the counterpart of the desktop preview worker
 * (lib.rs `apply_adjustments`, `generate_uncropped_preview`, ...).
 */
import { editorCore, type DecodedImage } from '../core/client';
import { Renderer, frameCropRect, type Frame, type PackedAdjustments, type SourceImage } from '../gpu/renderer';
import * as vfs from './vfs';
import { loadSidecar } from './sidecars';
import { currentSettings, settingsJson } from './settings';
import * as db from './db';
import { parseVirtualPath } from './sidecars';

let rendererPromise: Promise<Renderer> | null = null;
export function getRenderer() {
  if (!rendererPromise) rendererPromise = Renderer.create();
  return rendererPromise;
}

interface Session {
  path: string;
  image: DecodedImage;
  sources: Map<string, SourceImage>;
}

let session: Session | null = null;
let loading: Promise<Session> | null = null;
let analyticsChannel: { onmessage?: (data: any) => void } | null = null;

export function setAnalyticsChannel(channel: any) {
  analyticsChannel = channel;
}

export function currentImage() {
  return session;
}

export async function clearSession() {
  if (!session) return;
  const old = session;
  session = null;
  const renderer = await getRenderer().catch(() => null);
  if (renderer) old.sources.forEach((s) => renderer.releaseSource(s));
  editorCore.release(old.image.handle).catch(() => {});
}

export async function loadImage(path: string) {
  if (session?.path === path) return describe(session);
  const run = (async () => {
    await clearSession();
    const file = await vfs.readFile(parseVirtualPath(path).source);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = await editorCore.decode(bytes, vfs.basename(parseVirtualPath(path).source), settingsJson());
    db.set('kv', `exif:${parseVirtualPath(path).source}`, image.exif).catch(() => {});
    const s: Session = { path, image, sources: new Map() };
    session = s;
    return s;
  })();
  loading = run;
  try {
    return describe(await run);
  } finally {
    if (loading === run) loading = null;
  }
}

async function requireSession(): Promise<Session> {
  if (loading) await loading.catch(() => {});
  if (!session) throw new Error('No original image loaded');
  return session;
}

async function describe(s: Session) {
  return {
    width: s.image.width,
    height: s.image.height,
    metadata: await loadSidecar(s.path),
    exif: s.image.exif,
    is_raw: s.image.isRaw,
    as_shot_white_balance: s.image.asShotWhiteBalance,
  };
}

// ---- frames and sizes ------------------------------------------------------------

export function frameFromAdjustments(adj: any, opts: { uncropped?: boolean } = {}): Frame {
  const crop = adj?.crop && adj.crop.width > 0 && adj.crop.height > 0 ? adj.crop : null;
  return {
    orientation: (((adj?.orientationSteps ?? 0) % 4) + 4) % 4,
    flipHorizontal: !!adj?.flipHorizontal,
    flipVertical: !!adj?.flipVertical,
    rotation: opts.uncropped ? 0 : Number(adj?.rotation ?? 0),
    crop: opts.uncropped ? null : crop,
  };
}

function scaleFrame(frame: Frame, scale: number): Frame {
  return {
    ...frame,
    crop: frame.crop
      ? {
          x: frame.crop.x * scale,
          y: frame.crop.y * scale,
          width: frame.crop.width * scale,
          height: frame.crop.height * scale,
        }
      : null,
  };
}

/** Anything that can be rendered: a decoded image in one of the core workers. */
export interface RenderTarget {
  core: typeof editorCore;
  image: DecodedImage;
  sources: Map<string, SourceImage>;
  isCurrent: () => boolean;
}

function sessionTarget(s: Session): RenderTarget {
  return { core: editorCore, image: s.image, sources: s.sources, isCurrent: () => session === s };
}

async function sourceFor(t: RenderTarget, width: number, height: number) {
  const key = `${width}x${height}`;
  let src = t.sources.get(key);
  if (!src) {
    const renderer = await getRenderer();
    const halves = await t.core.halves(t.image.handle, width, height);
    if (!t.isCurrent()) throw new Error('Superseded or worker failed');
    src = renderer.createSource(halves, width, height);
    // keep at most two scales (preview + one other)
    if (t.sources.size >= 2) {
      const [oldKey, old] = t.sources.entries().next().value as [string, SourceImage];
      t.sources.delete(oldKey);
      renderer.releaseSource(old);
    }
    t.sources.set(key, src);
  }
  return src;
}

function lutFree(adj: any) {
  // LUT files are not supported in the web build yet: never ask the shader to
  // sample an unbound LUT.
  if (adj && adj.lutPath) return { ...adj, lutPath: null, lutData: null };
  return adj;
}

export interface RenderOptions {
  maxDim: number;
  uncropped?: boolean;
  withMasks?: boolean;
}

/** Renders a decoded image with `adjustments` and returns RGBA8 pixels. */
export async function renderTarget(t: RenderTarget, adjustments: any, opts: RenderOptions) {
  const renderer = await getRenderer();
  const adj = lutFree(adjustments || {});
  const fullFrame = frameFromAdjustments(adj, { uncropped: opts.uncropped });
  const [, , cropW, cropH] = frameCropRect(fullFrame, t.image.width, t.image.height);
  const gpuLimit = renderer.maxTextureDimension;
  const scale = Math.min(1, opts.maxDim / Math.max(cropW, cropH), gpuLimit / Math.max(t.image.width, t.image.height));
  const srcW = Math.max(1, Math.round(t.image.width * scale));
  const srcH = Math.max(1, Math.round(t.image.height * scale));
  const source = await sourceFor(t, srcW, srcH);
  const frame = scaleFrame(fullFrame, srcW / t.image.width);
  const [cx, cy, outW, outH] = frameCropRect(frame, srcW, srcH);

  const json = JSON.stringify(adj);
  const hasMasks =
    opts.withMasks !== false &&
    Array.isArray(adj.masks) &&
    adj.masks.some((m: any) => m?.visible && m?.subMasks?.length);
  const [packed, masks] = await Promise.all([
    t.core.pack(t.image.handle, json, settingsJson()),
    hasMasks ? t.core.masks(t.image.handle, json, outW, outH, srcW / t.image.width, cx, cy) : Promise.resolve(null),
  ]);
  if (!t.isCurrent()) throw new Error('Superseded or worker failed');
  return renderer.render(source, frame, packed as PackedAdjustments, masks);
}

export function renderSession(s: Session, adjustments: any, opts: RenderOptions) {
  return renderTarget(sessionTarget(s), adjustments, opts);
}

/** Target for the image currently open in the editor, if `path` is that image. */
export function sessionTargetFor(path: string): RenderTarget | null {
  return session && session.path === path ? sessionTarget(session) : null;
}

// ---- encoding ---------------------------------------------------------------------

export async function encodePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  type = 'image/jpeg',
  quality = 0.9,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels.buffer as ArrayBuffer, pixels.byteOffset, pixels.byteLength),
      width,
      height,
    ),
    0,
    0,
  );
  return canvas.convertToBlob({ type, quality });
}

// ---- render queue (newest request wins, like the desktop preview worker) ----------

type Job = { run: () => Promise<any>; resolve: (v: any) => void; reject: (e: any) => void };
const lanes = new Map<string, { busy: boolean; pending: Job | null }>();

function enqueue<T>(lane: string, run: () => Promise<T>): Promise<T> {
  let l = lanes.get(lane);
  if (!l) lanes.set(lane, (l = { busy: false, pending: null }));
  return new Promise<T>((resolve, reject) => {
    if (l!.pending) l!.pending.reject('Superseded or worker failed');
    l!.pending = { run, resolve, reject };
    pump(l!);
  });
}

async function pump(l: { busy: boolean; pending: Job | null }) {
  if (l.busy || !l.pending) return;
  const job = l.pending;
  l.pending = null;
  l.busy = true;
  try {
    job.resolve(await job.run());
  } catch (e) {
    job.reject(e);
  } finally {
    l.busy = false;
    pump(l);
  }
}

function previewDim(targetResolution?: number | null) {
  return targetResolution || currentSettings().editorPreviewResolution || 1920;
}

export function applyAdjustments(args: any): Promise<ArrayBuffer> {
  const lane = args.original ? 'original' : 'edited';
  return enqueue(lane, async () => {
    const s = await requireSession();
    const dim = previewDim(args.targetResolution);
    const result = await renderSession(s, args.jsAdjustments, {
      maxDim: args.isInteractive ? Math.min(dim, 1280) : dim,
    });
    if (session !== s) throw new Error('Superseded or worker failed');

    if (args.requestAnalytics && analyticsChannel?.onmessage) {
      const copy = result.pixels.slice();
      editorCore
        .analytics(
          s.path,
          copy,
          result.width,
          result.height,
          !!args.computeWaveform,
          args.activeWaveformChannel || null,
        )
        .then((packet) => analyticsChannel?.onmessage?.(packet.buffer))
        .catch((e) => console.warn('analytics failed', e));
    }

    const jpeg = new Uint8Array(
      await (await encodePixels(result.pixels, result.width, result.height, 'image/jpeg', 0.9)).arrayBuffer(),
    );
    if (!args.isInteractive) return jpeg.buffer;
    // Interactive responses carry a patch header: x, y, w, h, fullW, fullH (u32 LE).
    const out = new Uint8Array(24 + jpeg.byteLength);
    new Uint32Array(out.buffer, 0, 6).set([0, 0, result.width, result.height, result.width, result.height]);
    out.set(jpeg, 24);
    return out.buffer;
  });
}

export function generateUncroppedPreview(args: any): Promise<ArrayBuffer> {
  return enqueue('uncropped', async () => {
    const s = await requireSession();
    const result = await renderSession(s, args.jsAdjustments, {
      maxDim: previewDim(args.targetResolution),
      uncropped: true,
    });
    return (await encodePixels(result.pixels, result.width, result.height, 'image/jpeg', 0.85)).arrayBuffer();
  });
}

export function generatePresetPreview(args: any): Promise<Uint8Array> {
  return enqueue(`preset`, async () => {
    const s = await requireSession();
    const result = await renderSession(s, args.jsAdjustments, { maxDim: 400 });
    return new Uint8Array(
      await (await encodePixels(result.pixels, result.width, result.height, 'image/jpeg', 0.8)).arrayBuffer(),
    );
  });
}

export async function generateMaskOverlay(args: any): Promise<ArrayBuffer> {
  const s = await requireSession();
  const def = { ...args.maskDef, visible: true };
  const { width, height, scale } = args;
  const [ox, oy] = args.cropOffset || [0, 0];
  const bitmap = await editorCore.masks(
    s.image.handle,
    JSON.stringify({ masks: [def] }),
    width,
    height,
    scale,
    ox * scale,
    oy * scale,
  );
  if (!bitmap.length) return new ArrayBuffer(0);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 3] = bitmap[i] >> 1;
  }
  return (await encodePixels(rgba, width, height, 'image/png')).arrayBuffer();
}

export async function calculateAutoAdjustments(args: any) {
  const s = await requireSession();
  return editorCore.auto(
    s.image.handle,
    JSON.stringify(args.jsAdjustments || {}),
    args.mode || 'normal',
    settingsJson(),
  );
}
