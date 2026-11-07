/**
 * WebGPU port of RapidRAW's desktop render path (src-tauri/src/gpu_processing.rs
 * and render_source.rs). The WGSL shaders are imported unchanged from
 * src-tauri/src/shaders, and the pass structure, texture formats, radii and
 * dispatch sizes mirror the Rust code so that web and desktop renders match.
 */
import blurWgsl from '../../../src-tauri/src/shaders/blur.wgsl?raw';
import commonWgsl from '../../../src-tauri/src/shaders/compute_common.wgsl?raw';
import flareWgsl from '../../../src-tauri/src/shaders/flare.wgsl?raw';
import guidedWgsl from '../../../src-tauri/src/shaders/guided.wgsl?raw';
import mainWgsl from '../../../src-tauri/src/shaders/shader.wgsl?raw';
import transformWgsl from '../../../src-tauri/src/shaders/transform.wgsl?raw';

// ---- constants mirrored from gpu_processing.rs --------------------------------
const BLUR_H_GROUP_WIDTH = 256;
const BLUR_V_GROUP_SIZE: [number, number] = [8, 64];
const DIRECT_BLUR_MAX_RADIUS = 8;
const GF_SHORT_EDGE = 1080;
const GF_CLARITY_RADIUS = 8.0;
const GF_STRUCTURE_RADIUS = 40.0;
const GF_CLARITY_EPS = 0.25;
const GF_STRUCTURE_EPS = 0.5;
const GF_COARSE_DIV = 4;
const GF_TONAL_RADIUS = 10.0;
const GF_TONAL_EPS = 0.25;
const HZ_DIV = 2;
const HZ_PATCH_RADIUS = 12.0;
const HZ_GF_RADIUS = 48.0;
const HZ_GF_EPS = 1.0e-3;
const FLARE_MAP_SIZE = 512;
const TILE_SIZE = 2048;
const TILE_OVERLAP = 128;
const MAX_MASKS = 32;
const FRAME_ROTATE = 1;

const TB = GPUTextureUsage.TEXTURE_BINDING;
const SB = GPUTextureUsage.STORAGE_BINDING;

/** Output of the WASM core's `packAdjustments`. */
export interface PackedAdjustments {
  bytes: Uint8Array;
  features: number;
  maskCount: number;
  needSharpen: boolean;
  needHalation: boolean;
  needStructure: boolean;
  flareAmount: number;
  isRaw: number;
  exposure: number;
  brightness: number;
  contrast: number;
  whites: number;
}

/** Orientation / flip / straighten / crop, as in render_source.rs `Frame`. */
export interface Frame {
  orientation: number; // 0..3 quarter turns
  flipHorizontal: boolean;
  flipVertical: boolean;
  rotation: number; // degrees
  crop: { x: number; y: number; width: number; height: number } | null; // in source pixels
}

export interface SourceImage {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  texture: GPUTexture;
}

export interface RenderResult {
  width: number;
  height: number;
  pixels: Uint8Array; // RGBA8, tightly packed
}

interface PreparedInput {
  key: string;
  width: number;
  height: number;
  texture: GPUTexture;
  view: GPUTextureView;
  gfCoeffs: GPUTextureView;
  gfStructure: GPUTextureView;
  haze: GPUTextureView;
  airlight: GPUTextureView;
  owned: GPUTexture[];
}

let nextSourceId = 1;

export function frameOrientedSize(frame: Frame, w: number, h: number): [number, number] {
  return frame.orientation % 2 === 1 ? [h, w] : [w, h];
}

/** render_source.rs `Frame::crop_rect` / image_processing.rs `crop_rect`. */
export function frameCropRect(frame: Frame, w: number, h: number): [number, number, number, number] {
  const [ow, oh] = frameOrientedSize(frame, w, h);
  const c = frame.crop;
  if (c) {
    const x = Math.max(0, Math.round(c.x));
    const y = Math.max(0, Math.round(c.y));
    const cw = Math.round(c.width);
    const ch = Math.round(c.height);
    if (cw > 0 && ch > 0 && x < ow && y < oh) {
      return [x, y, Math.min(ow - x, cw), Math.min(oh - y, ch)];
    }
  }
  return [0, 0, ow, oh];
}

function frameIsIdentity(frame: Frame, w: number, h: number) {
  const [x, y, cw, ch] = frameCropRect(frame, w, h);
  return (
    frame.orientation === 0 &&
    !frame.flipHorizontal &&
    !frame.flipVertical &&
    frame.rotation % 360 === 0 &&
    x === 0 &&
    y === 0 &&
    cw === w &&
    ch === h
  );
}

export class Renderer {
  readonly device: GPUDevice;
  readonly maxTextureDimension: number;
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  private readonly layouts: Record<string, GPUBindGroupLayout> = {};
  private readonly modules: Record<string, GPUShaderModule> = {};
  private readonly dummy2d: GPUTextureView;
  private readonly dummy3d: GPUTextureView;
  private readonly dummyMask: GPUTextureView;
  private readonly nearestSampler: GPUSampler;
  private readonly linearSampler: GPUSampler;
  private prepared: PreparedInput[] = [];
  private flare: { threshold: GPUTexture; ghosts: GPUTexture; final: GPUTexture } | null = null;
  private lut: { key: string; view: GPUTextureView; sampler: GPUSampler } | null = null;
  lost = false;

  static async create(): Promise<Renderer> {
    if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    const renderer = new Renderer(device);
    device.lost.then((info) => {
      renderer.lost = true;
      console.error('WebGPU device lost:', info.message);
    });
    device.addEventListener('uncapturederror', (e) =>
      console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message),
    );
    await renderer.compileShaders();
    return renderer;
  }

  private constructor(device: GPUDevice) {
    this.device = device;
    this.maxTextureDimension = device.limits.maxTextureDimension2D;
    const tex = (desc: Partial<GPUTextureDescriptor> & { format: GPUTextureFormat }) =>
      device.createTexture({ size: [1, 1, 1], usage: TB, ...desc } as GPUTextureDescriptor);
    this.dummy2d = tex({ format: 'rgba16float' }).createView();
    this.dummy3d = tex({ format: 'rgba16float', dimension: '3d' }).createView();
    this.dummyMask = tex({ format: 'r8unorm', size: [1, 1, 2] }).createView({ dimension: '2d-array' });
    this.nearestSampler = device.createSampler();
    this.linearSampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.createLayouts();
  }

  // ---- pipeline setup ---------------------------------------------------------

  private createLayouts() {
    const d = this.device;
    const C = GPUShaderStage.COMPUTE;
    const tex = (
      binding: number,
      sampleType: GPUTextureSampleType = 'unfilterable-float',
      viewDimension: GPUTextureViewDimension = '2d',
    ): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      texture: { sampleType, viewDimension },
    });
    const store = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      storageTexture: { access: 'write-only', format, viewDimension: '2d' },
    });
    const uniform = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type: 'uniform' },
    });

    this.layouts.blur = d.createBindGroupLayout({ entries: [tex(0), store(1, 'rgba16float'), uniform(2)] });
    this.layouts.flare0 = d.createBindGroupLayout({
      entries: [
        tex(0, 'float'),
        store(1, 'rgba16float'),
        uniform(2),
        { binding: 3, visibility: C, sampler: { type: 'filtering' } },
      ],
    });
    this.layouts.flare1 = d.createBindGroupLayout({ entries: [tex(0), store(1, 'rgba16float')] });
    this.layouts.gf = d.createBindGroupLayout({ entries: [tex(0), tex(1), store(2, 'rgba32float'), uniform(3)] });
    this.layouts.main = d.createBindGroupLayout({
      entries: [
        tex(0),
        store(1, 'rgba8unorm'),
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        tex(3, 'unfilterable-float', '2d-array'),
        tex(4, 'unfilterable-float', '3d'),
        { binding: 5, visibility: C, sampler: { type: 'non-filtering' } },
        tex(6),
        tex(7),
        tex(8),
        tex(9),
        tex(10, 'float'),
        { binding: 11, visibility: C, sampler: { type: 'filtering' } },
        tex(12),
        tex(13),
        tex(14),
        tex(15),
      ],
    });
  }

  private async compileShaders() {
    const d = this.device;
    const sources: Record<string, string> = {
      blur: blurWgsl,
      flare: flareWgsl,
      guided: guidedWgsl,
      main: mainWgsl,
      transform: `${commonWgsl}\n${transformWgsl}`,
    };
    for (const [name, code] of Object.entries(sources)) {
      const module = d.createShaderModule({ label: name, code });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) {
        throw new Error(`WGSL ${name}: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`);
      }
      this.modules[name] = module;
    }
  }

  private pipeline(
    module: string,
    entryPoint: string,
    layouts: string[] | 'auto',
    constants?: Record<string, number>,
  ): GPUComputePipeline {
    const key = `${module}:${entryPoint}:${JSON.stringify(constants ?? {})}`;
    let p = this.pipelines.get(key);
    if (!p) {
      p = this.device.createComputePipeline({
        label: key,
        layout:
          layouts === 'auto'
            ? 'auto'
            : this.device.createPipelineLayout({ bindGroupLayouts: layouts.map((l) => this.layouts[l]) }),
        compute: { module: this.modules[module], entryPoint, constants },
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  // ---- sources ------------------------------------------------------------------

  /** Uploads RGBA16F texels (raw f16 bits) as a source texture. */
  createSource(halves: Uint16Array, width: number, height: number): SourceImage {
    const texture = this.device.createTexture({
      label: 'source',
      size: [width, height],
      format: 'rgba16float',
      usage: TB | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    this.device.queue.writeTexture({ texture }, halves, { bytesPerRow: width * 8, rowsPerImage: height }, [
      width,
      height,
    ]);
    return { id: nextSourceId++, width, height, texture };
  }

  releaseSource(source: SourceImage) {
    this.prepared = this.prepared.filter((p) => {
      if (p.key.startsWith(`${source.id}|`)) {
        p.owned.forEach((t) => t.destroy());
        return false;
      }
      return true;
    });
    source.texture.destroy();
  }

  setLut(key: string | null, size = 0, rgb?: Float32Array) {
    if (!key || !rgb) {
      this.lut = null;
      return;
    }
    if (this.lut?.key === key) return;
    const data = new Float32Array((rgb.length / 3) * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      data[j] = rgb[i];
      data[j + 1] = rgb[i + 1];
      data[j + 2] = rgb[i + 2];
      data[j + 3] = 1;
    }
    const texture = this.device.createTexture({
      size: [size, size, size],
      dimension: '3d',
      format: 'rgba32float',
      usage: TB | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture({ texture }, data, { bytesPerRow: size * 16, rowsPerImage: size }, [
      size,
      size,
      size,
    ]);
    this.lut = {
      key,
      view: texture.createView(),
      sampler: this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }),
    };
  }

  // ---- preparation: reframe + guided filter coefficients -----------------------

  private prepare(source: SourceImage, frame: Frame, isRaw: number): PreparedInput {
    const key = `${source.id}|${JSON.stringify(frame)}|${isRaw}`;
    const hit = this.prepared.findIndex((p) => p.key === key);
    if (hit >= 0) {
      const [p] = this.prepared.splice(hit, 1);
      this.prepared.push(p);
      return p;
    }

    const owned: GPUTexture[] = [];
    let texture = source.texture;
    let [width, height] = [source.width, source.height];
    if (!frameIsIdentity(frame, width, height)) {
      const framed = this.reframe(source, frame);
      owned.push(framed);
      texture = framed;
      width = framed.width;
      height = framed.height;
    }
    const view = texture.createView();
    const guided = this.buildGuidedCoeffs(view, width, height, isRaw, owned);
    const entry: PreparedInput = { key, width, height, texture, view, ...guided, owned };
    this.prepared.push(entry);
    while (this.prepared.length > 3) {
      this.prepared.shift()!.owned.forEach((t) => t.destroy());
    }
    return entry;
  }

  /** render_source.rs `reframe` (transform.wgsl `tf_frame`). */
  private reframe(source: SourceImage, frame: Frame): GPUTexture {
    const [ow, oh] = frameOrientedSize(frame, source.width, source.height);
    const [x, y, w, h] = frameCropRect(frame, source.width, source.height);
    const rad = (frame.rotation * Math.PI) / 180;
    const [sin, cos] = [Math.sin(rad), Math.cos(rad)];
    const center = [ow / 2, oh / 2];

    const buf = new ArrayBuffer(240);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    // Grid { dst, src, radius, channel, flags, eps }
    u32[0] = w;
    u32[1] = h;
    u32[2] = source.width;
    u32[3] = source.height;
    u32[6] = frame.rotation % 360 !== 0 ? FRAME_ROTATE : 0;
    u32[108 / 4] = frame.orientation; // orientation
    f32[176 / 4] = cos; // rotation
    f32[180 / 4] = sin;
    f32[184 / 4] = -sin;
    f32[188 / 4] = cos;
    f32[192 / 4] = center[0] - (cos * center[0] + sin * center[1]); // rotation_offset
    f32[196 / 4] = center[1] - (-sin * center[0] + cos * center[1]);
    u32[200 / 4] = x; // crop_origin
    u32[204 / 4] = y;
    u32[208 / 4] = ow; // oriented_size
    u32[212 / 4] = oh;
    u32[216 / 4] = frame.flipHorizontal ? 1 : 0; // flip
    u32[220 / 4] = frame.flipVertical ? 1 : 0;

    const out = this.device.createTexture({
      label: 'framed',
      size: [w, h],
      format: 'rgba16float',
      usage: TB | SB | GPUTextureUsage.COPY_SRC,
    });
    const params = this.uniform(buf);
    const pipeline = this.pipeline('transform', 'tf_frame', 'auto');
    const bg = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.texture.createView() },
        { binding: 7, resource: { buffer: params } },
        { binding: 9, resource: out.createView() },
      ],
    });
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    return out;
  }

  /** gpu_processing.rs `GpuProcessor::build_guided_coeffs`. */
  private buildGuidedCoeffs(
    inputView: GPUTextureView,
    width: number,
    height: number,
    isRaw: number,
    owned: GPUTexture[],
  ) {
    const short = Math.max(1, Math.min(width, height));
    const k = Math.min(GF_SHORT_EDGE / short, 1.0);
    const lw = Math.max(1, Math.round(width * k));
    const lh = Math.max(1, Math.round(height * k));
    const lowShort = Math.min(lw, lh);
    const cw = Math.max(1, Math.ceil(lw / GF_COARSE_DIV));
    const ch = Math.max(1, Math.ceil(lh / GF_COARSE_DIV));
    const hw = Math.max(1, Math.ceil(lw / HZ_DIV));
    const hh = Math.max(1, Math.ceil(lh / HZ_DIV));
    const hcw = Math.max(1, Math.ceil(hw / GF_COARSE_DIV));
    const hch = Math.max(1, Math.ceil(hh / GF_COARSE_DIV));

    const make = (label: string, w: number, h: number) => {
      const t = this.device.createTexture({ label, size: [w, h], format: 'rgba32float', usage: TB | SB });
      owned.push(t);
      return t.createView();
    };
    const params = (baseRadius: number, eps: number, div: number) => {
      const radius = Math.max(1, Math.ceil((baseRadius * lowShort) / 1080 / div));
      const buf = new ArrayBuffer(16);
      new Uint32Array(buf, 0, 2).set([radius, isRaw]);
      new Float32Array(buf, 8, 2).set([eps, 0]);
      return this.uniform(buf);
    };

    const moments = make('GF Moments', lw, lh);
    const tmp = make('GF Ping Pong', lw, lh);
    const blurred = make('GF Blurred', lw, lh);
    const ab = make('GF Coeffs', lw, lh);
    const abClarity = make('GF Coeffs Clarity', lw, lh);
    const cMoments = make('GF Coarse Moments', cw, ch);
    const cTmp = make('GF Coarse Ping Pong', cw, ch);
    const cBlurred = make('GF Coarse Blurred', cw, ch);
    const cAb = make('GF Coarse Coeffs', cw, ch);
    const hzA = make('Haze Ping', hw, hh);
    const hzB = make('Haze Pong', hw, hh);
    const hzCoarse = make('Haze Coarse', hcw, hch);
    const haze = make('Haze Coeffs', hw, hh);
    const airlight = make('Haze Airlight', 2, 1);

    const pClarity = params(GF_CLARITY_RADIUS, GF_CLARITY_EPS, 1);
    const pTonal = params(GF_TONAL_RADIUS, GF_TONAL_EPS, 1);
    const pCoarse = params(GF_STRUCTURE_RADIUS, GF_STRUCTURE_EPS, GF_COARSE_DIV);
    const pHzPatch = params(HZ_PATCH_RADIUS, HZ_GF_EPS, HZ_DIV);
    const pHzGf = params(HZ_GF_RADIUS, HZ_GF_EPS, HZ_DIV);

    const enc = this.device.createCommandEncoder({ label: 'guided' });
    const pass = (
      entry: string,
      a: GPUTextureView,
      b: GPUTextureView,
      dst: GPUTextureView,
      p: GPUBuffer,
      [w, h]: number[],
    ) => {
      const bg = this.device.createBindGroup({
        layout: this.layouts.gf,
        entries: [
          { binding: 0, resource: a },
          { binding: 1, resource: b },
          { binding: 2, resource: dst },
          { binding: 3, resource: { buffer: p } },
        ],
      });
      const c = enc.beginComputePass();
      c.setPipeline(this.pipeline('guided', entry, ['gf']));
      c.setBindGroup(0, bg);
      c.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
      c.end();
    };
    const fine = [lw, lh];
    const coarse = [cw, ch];
    const half = [hw, hh];

    pass('gf_downsample', inputView, inputView, moments, pClarity, fine);
    pass('gf_box_down', moments, moments, cMoments, pCoarse, coarse);
    pass('gf_blur_h', cMoments, cMoments, cTmp, pCoarse, coarse);
    pass('gf_blur_v', cTmp, cTmp, cBlurred, pCoarse, coarse);
    pass('gf_coeffs', cBlurred, cBlurred, cAb, pCoarse, coarse);
    pass('gf_blur_h', cAb, cAb, cTmp, pCoarse, coarse);
    pass('gf_blur_v', cTmp, cTmp, cMoments, pCoarse, coarse);
    for (const [p, out] of [
      [pClarity, abClarity],
      [pTonal, blurred],
    ] as const) {
      pass('gf_blur_h', moments, moments, tmp, p, fine);
      pass('gf_blur_v', tmp, tmp, blurred, p, fine);
      pass('gf_coeffs', blurred, blurred, ab, p, fine);
      pass('gf_blur_h', ab, ab, tmp, p, fine);
      pass('gf_blur_v', tmp, tmp, out, p, fine);
    }
    pass('gf_pack', abClarity, blurred, ab, pClarity, fine);

    pass('hz_downsample', inputView, inputView, hzA, pHzPatch, half);
    pass('gf_box_down', hzA, hzA, hzCoarse, pHzPatch, [hcw, hch]);
    pass('hz_airlight', hzCoarse, hzCoarse, airlight, pHzPatch, [1, 1]);
    pass('hz_min_h', hzA, airlight, hzB, pHzPatch, half);
    pass('hz_min_v', hzB, hzB, hzA, pHzPatch, half);
    pass('hz_max_h', hzA, hzA, hzB, pHzPatch, half);
    pass('hz_max_v', hzB, hzB, hzA, pHzPatch, half);
    pass('gf_blur_h', hzA, hzA, hzB, pHzGf, half);
    pass('gf_blur_v', hzB, hzB, hzA, pHzGf, half);
    pass('hz_coeffs', hzA, hzA, hzB, pHzGf, half);
    pass('gf_blur_h', hzB, hzB, hzA, pHzGf, half);
    pass('gf_blur_v', hzA, hzA, haze, pHzGf, half);
    this.device.queue.submit([enc.finish()]);

    return { gfCoeffs: ab, gfStructure: cMoments, haze, airlight };
  }

  private uniform(data: ArrayBuffer) {
    const buffer = this.device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  // ---- render -------------------------------------------------------------------

  /**
   * Renders `source` with `adjustments`. `masks` holds `maskCount` concatenated
   * 8-bit bitmaps in output (framed) space.
   */
  async render(
    source: SourceImage,
    frame: Frame,
    adjustments: PackedAdjustments,
    masks: Uint8Array | null,
  ): Promise<RenderResult> {
    const d = this.device;
    const input = this.prepare(source, frame, adjustments.isRaw);
    const { width, height } = input;
    if (width > this.maxTextureDimension || height > this.maxTextureDimension) {
      throw new Error(
        `Image dimensions (${width}x${height}) exceed the GPU texture limit (${this.maxTextureDimension}).`,
      );
    }
    const scale = Math.min(width, height) / 1080.0;
    const owned: GPUTexture[] = [];
    const ownedBuffers: GPUBuffer[] = [];

    // masks
    let maskView = this.dummyMask;
    if (masks && adjustments.maskCount > 0) {
      const layers = Math.min(Math.max(adjustments.maskCount, 2), MAX_MASKS);
      const t = d.createTexture({
        label: 'masks',
        size: [width, height, layers],
        format: 'r8unorm',
        usage: TB | GPUTextureUsage.COPY_DST,
      });
      owned.push(t);
      const data = new Uint8Array(width * height * layers);
      data.set(masks.subarray(0, Math.min(masks.length, data.length)));
      d.queue.writeTexture({ texture: t }, data, { bytesPerRow: width, rowsPerImage: height }, [width, height, layers]);
      maskView = t.createView({ dimension: '2d-array' });
    }

    // flare (gpu_processing.rs run(): flare_amount > 0)
    const useFlare = adjustments.flareAmount > 0;
    if (useFlare) {
      if (!this.flare) {
        const make = () =>
          d.createTexture({ size: [FLARE_MAP_SIZE, FLARE_MAP_SIZE], format: 'rgba16float', usage: TB | SB });
        this.flare = { threshold: make(), ghosts: make(), final: make() };
      }
      const fb = new ArrayBuffer(32);
      const fu = new Uint32Array(fb);
      const ff = new Float32Array(fb);
      ff[0] = adjustments.flareAmount;
      fu[1] = adjustments.isRaw;
      ff[2] = adjustments.exposure;
      ff[3] = adjustments.brightness;
      ff[4] = adjustments.contrast;
      ff[5] = adjustments.whites;
      ff[6] = height > 0 ? width / height : 1;
      const fp = this.uniform(fb);
      ownedBuffers.push(fp);
      const bg0 = (out: GPUTexture) =>
        d.createBindGroup({
          layout: this.layouts.flare0,
          entries: [
            { binding: 0, resource: input.view },
            { binding: 1, resource: out.createView() },
            { binding: 2, resource: { buffer: fp } },
            { binding: 3, resource: this.linearSampler },
          ],
        });
      const enc = d.createCommandEncoder({ label: 'flare' });
      let c = enc.beginComputePass();
      c.setPipeline(this.pipeline('flare', 'threshold_main', ['flare0']));
      c.setBindGroup(0, bg0(this.flare.threshold));
      c.dispatchWorkgroups(FLARE_MAP_SIZE / 16, FLARE_MAP_SIZE / 16);
      c.end();
      c = enc.beginComputePass();
      c.setPipeline(this.pipeline('flare', 'ghosts_main', ['flare0', 'flare1']));
      c.setBindGroup(0, bg0(this.flare.final));
      c.setBindGroup(
        1,
        d.createBindGroup({
          layout: this.layouts.flare1,
          entries: [
            { binding: 0, resource: this.flare.threshold.createView() },
            { binding: 1, resource: this.flare.ghosts.createView() },
          ],
        }),
      );
      c.dispatchWorkgroups(FLARE_MAP_SIZE / 16, FLARE_MAP_SIZE / 16);
      c.end();
      d.queue.submit([enc.finish()]);
    }

    const tileW = Math.min(width, TILE_SIZE + TILE_OVERLAP * 2);
    const tileH = Math.min(height, TILE_SIZE + TILE_OVERLAP * 2);
    const tileTex = (label: string, format: GPUTextureFormat, extra = 0) => {
      const t = d.createTexture({ label, size: [tileW, tileH], format, usage: TB | SB | extra });
      owned.push(t);
      return t;
    };
    const tileOutput = tileTex('tile output', 'rgba8unorm', GPUTextureUsage.COPY_SRC);
    const blurTargets =
      adjustments.needSharpen || adjustments.needHalation || adjustments.needStructure
        ? {
            ping: tileTex('ping pong', 'rgba16float'),
            sharp: adjustments.needSharpen ? tileTex('sharpness blur', 'rgba16float') : null,
            tonal: adjustments.needSharpen ? tileTex('tonal blur', 'rgba16float') : null,
            clarity: adjustments.needHalation ? tileTex('clarity blur', 'rgba16float') : null,
            structure: adjustments.needStructure ? tileTex('structure blur', 'rgba16float') : null,
          }
        : null;

    const adjustmentsBuffer = d.createBuffer({
      size: adjustments.bytes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    ownedBuffers.push(adjustmentsBuffer);
    const tileOffsetIndex = (adjustments.bytes.byteLength - 16) / 4; // mask_count, tile_offset_x, tile_offset_y, mask_atlas_cols
    const adjustmentsData = new Uint32Array(adjustments.bytes.slice().buffer);

    const mainPipeline = this.pipeline('main', 'main', ['main'], {
      HIGH_PRECISION_OUTPUT: 0,
      FEATURES: adjustments.features >>> 0,
      HSL_PROBE: 0,
    });
    const lut = this.lut;

    const pixels = new Uint8Array(width * height * 4);
    const bytesPerRowAligned = Math.ceil((tileW * 4) / 256) * 256;
    const readback = d.createBuffer({
      size: bytesPerRowAligned * tileH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    ownedBuffers.push(readback);

    const tilesX = Math.ceil(width / TILE_SIZE);
    const tilesY = Math.ceil(height / TILE_SIZE);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const xStart = tx * TILE_SIZE;
        const yStart = ty * TILE_SIZE;
        const xEnd = Math.min(xStart + TILE_SIZE, width);
        const yEnd = Math.min(yStart + TILE_SIZE, height);
        const tileWidth = xEnd - xStart;
        const tileHeight = yEnd - yStart;
        const inX = Math.max(0, xStart - TILE_OVERLAP);
        const inY = Math.max(0, yStart - TILE_OVERLAP);
        const inW = Math.min(xEnd + TILE_OVERLAP, width) - inX;
        const inH = Math.min(yEnd + TILE_OVERLAP, height) - inY;

        const enc = d.createCommandEncoder({ label: 'tile' });
        const runBlur = (baseRadius: number, target: GPUTexture | null) => {
          if (!target || !blurTargets) return false;
          const radius = Math.max(1, Math.ceil(baseRadius * scale));
          const pb = new ArrayBuffer(32);
          new Uint32Array(pb).set([radius, inX, inY, inW, inH, 0, 0, 0]);
          const params = this.uniform(pb);
          ownedBuffers.push(params);
          const direct = radius <= DIRECT_BLUR_MAX_RADIUS;
          const bg = (src: GPUTextureView, dst: GPUTextureView) =>
            d.createBindGroup({
              layout: this.layouts.blur,
              entries: [
                { binding: 0, resource: src },
                { binding: 1, resource: dst },
                { binding: 2, resource: { buffer: params } },
              ],
            });
          let c = enc.beginComputePass();
          c.setPipeline(this.pipeline('blur', direct ? 'horizontal_blur_direct' : 'horizontal_blur', ['blur']));
          c.setBindGroup(0, bg(input.view, blurTargets.ping.createView()));
          c.dispatchWorkgroups(Math.ceil(inW / BLUR_H_GROUP_WIDTH), inH);
          c.end();
          c = enc.beginComputePass();
          c.setBindGroup(0, bg(blurTargets.ping.createView(), target.createView()));
          if (direct) {
            c.setPipeline(this.pipeline('blur', 'vertical_blur_direct', ['blur']));
            c.dispatchWorkgroups(inW, Math.ceil(inH / 256));
          } else {
            c.setPipeline(this.pipeline('blur', 'vertical_blur', ['blur']));
            c.dispatchWorkgroups(Math.ceil(inW / BLUR_V_GROUP_SIZE[0]), Math.ceil(inH / BLUR_V_GROUP_SIZE[1]));
          }
          c.end();
          return true;
        };
        const sharp = adjustments.needSharpen && runBlur(1.0, blurTargets?.sharp ?? null);
        const tonal = adjustments.needSharpen && runBlur(3.5, blurTargets?.tonal ?? null);
        const clarity = adjustments.needHalation && runBlur(8.0, blurTargets?.clarity ?? null);
        const structure = adjustments.needStructure && runBlur(40.0, blurTargets?.structure ?? null);

        adjustmentsData[tileOffsetIndex + 1] = inX;
        adjustmentsData[tileOffsetIndex + 2] = inY;
        d.queue.writeBuffer(adjustmentsBuffer, 0, adjustmentsData);

        const view = (t: GPUTexture | null | undefined, on: boolean) => (on && t ? t.createView() : this.dummy2d);
        const bg = d.createBindGroup({
          layout: this.layouts.main,
          entries: [
            { binding: 0, resource: input.view },
            { binding: 1, resource: tileOutput.createView() },
            { binding: 2, resource: { buffer: adjustmentsBuffer } },
            { binding: 3, resource: maskView },
            { binding: 4, resource: lut ? lut.view : this.dummy3d },
            { binding: 5, resource: lut ? lut.sampler : this.nearestSampler },
            { binding: 6, resource: view(blurTargets?.sharp, !!sharp) },
            { binding: 7, resource: view(blurTargets?.tonal, !!tonal) },
            { binding: 8, resource: view(blurTargets?.clarity, !!clarity) },
            { binding: 9, resource: view(blurTargets?.structure, !!structure) },
            { binding: 10, resource: useFlare && this.flare ? this.flare.ghosts.createView() : this.dummy2d },
            { binding: 11, resource: this.linearSampler },
            { binding: 12, resource: input.gfCoeffs },
            { binding: 13, resource: input.gfStructure },
            { binding: 14, resource: input.haze },
            { binding: 15, resource: input.airlight },
          ],
        });
        const c = enc.beginComputePass();
        c.setPipeline(mainPipeline);
        c.setBindGroup(0, bg);
        c.dispatchWorkgroups(Math.ceil(inW / 8), Math.ceil(inH / 8));
        c.end();

        const cropX = xStart - inX;
        const cropY = yStart - inY;
        enc.copyTextureToBuffer(
          { texture: tileOutput, origin: [cropX, cropY] },
          { buffer: readback, bytesPerRow: bytesPerRowAligned, rowsPerImage: tileHeight },
          [tileWidth, tileHeight],
        );
        d.queue.submit([enc.finish()]);

        await readback.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(readback.getMappedRange());
        const rowBytes = tileWidth * 4;
        for (let row = 0; row < tileHeight; row++) {
          const dst = ((yStart + row) * width + xStart) * 4;
          pixels.set(mapped.subarray(row * bytesPerRowAligned, row * bytesPerRowAligned + rowBytes), dst);
        }
        readback.unmap();
      }
    }

    owned.forEach((t) => t.destroy());
    ownedBuffers.forEach((b) => b.destroy());
    return { width, height, pixels };
  }
}
