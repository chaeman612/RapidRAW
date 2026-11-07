//! JavaScript-facing API (wasm-bindgen).

use std::collections::HashMap;
use std::io::Cursor;

use exif::{Reader as ExifReader, Tag};
use image::{DynamicImage, GenericImageView, ImageReader, imageops};
use rawler::decoders::Orientation;
use serde::Serialize;
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::app_settings::{AppSettings, resolve_tonemapper_override};
use crate::as_shot::AsShot;
use crate::baseline_exposure::BaselineOptions;
use crate::image_processing::{
    AllAdjustments, AnalyticsFrame, AutoAdjustMode, MAX_MASKS, MaskAdjustments, RenderOptions,
    apply_cpu_default_raw_processing, apply_orientation, auto_results_to_json, calculate_histogram,
    calculate_waveform, effective_baseline_exposure, encode_analytics_packet,
    get_all_adjustments_from_json, perform_auto_analysis, remove_raw_artifacts_and_enhance,
};
use crate::mask_generation::{MaskDefinition, generate_mask_bitmap};
use crate::shims::AnalyticsPixels;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn parse_settings(settings_json: &str) -> AppSettings {
    serde_json::from_str(settings_json).unwrap_or_default()
}

fn render_options(settings: &AppSettings, is_raw: bool) -> RenderOptions {
    RenderOptions {
        tonemapper_override: resolve_tonemapper_override(settings, is_raw),
        non_raw_tonemapper_override: resolve_tonemapper_override(settings, false),
        baseline: BaselineOptions::from_settings(settings),
    }
}

/// A decoded source image kept in WebAssembly memory (linear-light RGB f32 for
/// RAW files, display-referred RGB f32 for everything else, as on desktop).
///
/// `logical` is the image's real (oriented) size; all coordinates in adjustments
/// (crop, masks) refer to it, exactly as on desktop. `image` may be stored at a
/// reduced working resolution to fit mobile memory limits.
#[wasm_bindgen]
pub struct WebImage {
    image: DynamicImage,
    logical: (u32, u32),
    is_raw: bool,
    as_shot: AsShot,
    exif: HashMap<String, String>,
    scaled: Option<DynamicImage>,
    /// Full-resolution reference for color/luminance masks (desktop
    /// `build_full_warped_image` without geometry warps), built on demand.
    mask_reference: Option<DynamicImage>,
}

#[wasm_bindgen]
impl WebImage {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.logical.0
    }

    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.logical.1
    }

    /// Width of the stored pixels (smaller than `width` when decoded with a cap).
    #[wasm_bindgen(getter, js_name = pixelWidth)]
    pub fn pixel_width(&self) -> u32 {
        self.image.width()
    }

    #[wasm_bindgen(getter, js_name = pixelHeight)]
    pub fn pixel_height(&self) -> u32 {
        self.image.height()
    }

    #[wasm_bindgen(getter, js_name = isRaw)]
    pub fn is_raw(&self) -> bool {
        self.is_raw
    }

    #[wasm_bindgen(js_name = exifJson)]
    pub fn exif_json(&self) -> String {
        serde_json::to_string(&self.exif).unwrap_or_else(|_| "{}".into())
    }

    #[wasm_bindgen(js_name = asShotWhiteBalanceJson)]
    pub fn as_shot_white_balance_json(&self) -> String {
        serde_json::to_string(&self.as_shot.white_balance).unwrap_or_else(|_| "null".into())
    }

    /// Returns RGBA16F texels (as raw f16 bits) of the stored image resized to
    /// exactly `width` x `height` (pass the pixel size for no resampling).
    #[wasm_bindgen(js_name = rgbaHalves)]
    pub fn rgba_halves(&mut self, width: u32, height: u32) -> Vec<u16> {
        let full = (width, height) == self.image.dimensions();
        let scaled = if full {
            self.scaled = None;
            &self.image
        } else {
            let needs = self
                .scaled
                .as_ref()
                .is_none_or(|s| s.dimensions() != (width, height));
            if needs {
                // Release the previous scaled copy first so peak memory stays low.
                self.scaled = None;
                self.scaled = Some(resize_f32(&self.image, width, height));
            }
            self.scaled.as_ref().unwrap()
        };
        rgba_halves(scaled)
    }

    /// Generates the per-mask 8-bit bitmaps (concatenated layers, `width*height` each)
    /// for the visible masks in `adjustments_json`, in output (cropped) space.
    #[wasm_bindgen(js_name = maskBitmaps)]
    pub fn mask_bitmaps(
        &mut self,
        adjustments_json: &str,
        width: u32,
        height: u32,
        scale: f32,
        crop_x: f32,
        crop_y: f32,
    ) -> Result<Vec<u8>, JsError> {
        let adjustments: Value = serde_json::from_str(adjustments_json).map_err(err)?;
        let definitions: Vec<MaskDefinition> = adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();
        let needs_reference = definitions.iter().any(|m| {
            m.sub_masks
                .iter()
                .any(|s| matches!(s.mask_type.as_str(), "color" | "luminance"))
        });
        if needs_reference && self.mask_reference.is_none() {
            let mut reference = self.image.clone();
            if self.is_raw {
                apply_cpu_default_raw_processing(&mut reference);
            }
            self.mask_reference = Some(reference);
        }
        let reference = self.mask_reference.as_ref();
        let reference_ratio = self.image.width() as f32 / self.logical.0.max(1) as f32;
        let mut out = Vec::new();
        for def in definitions
            .iter()
            .filter(|m| m.visible && !m.sub_masks.is_empty())
            .take(MAX_MASKS)
        {
            let bitmap = generate_mask_bitmap(
                def,
                width,
                height,
                scale,
                (crop_x, crop_y),
                reference,
                reference_ratio,
            )
            .unwrap_or_else(|| image::GrayImage::new(width, height));
            out.extend_from_slice(bitmap.as_raw());
        }
        Ok(out)
    }

    /// Packs the adjustments JSON into the `AllAdjustments` uniform layout used by
    /// `shader.wgsl`, plus the derived flags the render pipeline needs.
    #[wasm_bindgen(js_name = packAdjustments)]
    pub fn pack_adjustments(
        &self,
        adjustments_json: &str,
        settings_json: &str,
    ) -> Result<JsValue, JsError> {
        let adjustments: Value = serde_json::from_str(adjustments_json).map_err(err)?;
        let settings = parse_settings(settings_json);
        let all = get_all_adjustments_from_json(
            &adjustments,
            self.is_raw,
            self.as_shot,
            render_options(&settings, self.is_raw),
        );
        Ok(packed(all).serialize(&serde_wasm_bindgen::Serializer::json_compatible())?)
    }

    #[wasm_bindgen(js_name = autoAdjustments)]
    pub fn auto_adjustments(
        &self,
        adjustments_json: &str,
        mode: &str,
        settings_json: &str,
    ) -> Result<String, JsError> {
        let adjustments: Value = serde_json::from_str(adjustments_json).map_err(err)?;
        let settings = parse_settings(settings_json);
        let exposure = effective_baseline_exposure(
            &adjustments,
            self.as_shot,
            BaselineOptions::from_settings(&settings),
        );
        let analysis_source = self.scaled.as_ref().unwrap_or(&self.image);
        let results = perform_auto_analysis(analysis_source, exposure);
        let mode = match mode {
            "subtle" => AutoAdjustMode::Subtle,
            "strong" => AutoAdjustMode::Strong,
            _ => AutoAdjustMode::Normal,
        };
        Ok(auto_results_to_json(&results, mode).to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Packed {
    #[serde(with = "serde_bytes_compat")]
    bytes: Vec<u8>,
    features: u32,
    mask_count: u32,
    need_sharpen: bool,
    need_halation: bool,
    need_structure: bool,
    flare_amount: f32,
    is_raw: u32,
    exposure: f32,
    brightness: f32,
    contrast: f32,
    whites: f32,
}

mod serde_bytes_compat {
    pub fn serialize<S: serde::Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bytes(v)
    }
}

// Mirrors `shader_features` in src-tauri/src/gpu_processing.rs.
const F_NOISE_REDUCTION: u32 = 1;
const F_HSL: u32 = 2;
const F_MASKS: u32 = 4;
const F_SHARPEN: u32 = 8;
const F_DEHAZE: u32 = 16;
const F_GLOW_HALATION_FLARE: u32 = 32;
const F_GRAIN: u32 = 64;
const F_VIGNETTE: u32 = 128;
const F_LUT: u32 = 256;
const F_CA: u32 = 512;
const F_AGX: u32 = 1024;
const F_MONOCHROME: u32 = 2048;

fn packed(all: AllAdjustments) -> Packed {
    let g = &all.global;
    let masks = &all.mask_adjustments[..(all.mask_count as usize).min(MAX_MASKS)];
    let any = |global: f32, pick: fn(&MaskAdjustments) -> f32| {
        global != 0.0 || masks.iter().any(|m| pick(m) != 0.0)
    };
    let any_pos = |global: f32, pick: fn(&MaskAdjustments) -> f32| {
        global > 0.0 || masks.iter().any(|m| pick(m) > 0.0)
    };
    let hsl_nonzero = |hsl: &[crate::image_processing::HslColor; 8]| {
        bytemuck::cast_slice::<_, f32>(hsl)
            .iter()
            .any(|&v| v != 0.0)
    };
    let mut features = 0;
    let mut set = |flag: u32, on: bool| {
        if on {
            features |= flag;
        }
    };
    set(
        F_NOISE_REDUCTION,
        any(g.luma_noise_reduction, |m| m.luma_noise_reduction)
            || any(g.color_noise_reduction, |m| m.color_noise_reduction),
    );
    set(
        F_HSL,
        hsl_nonzero(&g.hsl) || masks.iter().any(|m| hsl_nonzero(&m.hsl)),
    );
    set(F_MASKS, all.mask_count > 0);
    set(F_SHARPEN, any(g.sharpness, |m| m.sharpness));
    set(F_DEHAZE, any(g.dehaze, |m| m.dehaze));
    set(
        F_GLOW_HALATION_FLARE,
        any(g.glow_amount, |m| m.glow_amount)
            || any(g.halation_amount, |m| m.halation_amount)
            || any(g.flare_amount, |m| m.flare_amount),
    );
    set(F_GRAIN, g.grain_amount > 0.0);
    set(F_VIGNETTE, g.vignette_amount != 0.0);
    set(F_LUT, g.has_lut == 1);
    set(
        F_CA,
        g.chromatic_aberration_red_cyan.abs() > 0.000001
            || g.chromatic_aberration_blue_yellow.abs() > 0.000001,
    );
    set(F_AGX, g.tonemapper_mode == 1);
    set(F_MONOCHROME, g.monochrome.enabled == 1);

    Packed {
        features,
        mask_count: all.mask_count,
        need_sharpen: any(g.sharpness, |m| m.sharpness),
        need_halation: any_pos(g.halation_amount, |m| m.halation_amount),
        need_structure: any_pos(g.glow_amount, |m| m.glow_amount),
        flare_amount: g.flare_amount,
        is_raw: g.is_raw_image,
        exposure: g.exposure,
        brightness: g.brightness,
        contrast: g.contrast,
        whites: g.whites,
        bytes: bytemuck::bytes_of(&all).to_vec(),
    }
}

/// Size in bytes of the `AllAdjustments` uniform (for allocating GPU buffers).
#[wasm_bindgen(js_name = adjustmentsByteLength)]
pub fn adjustments_byte_length() -> usize {
    std::mem::size_of::<AllAdjustments>()
}

#[wasm_bindgen(js_name = isRawFile)]
pub fn is_raw_file(name: &str) -> bool {
    crate::formats::is_raw_file(name)
}

#[wasm_bindgen(js_name = isSupportedImageFile)]
pub fn is_supported_image_file(name: &str) -> bool {
    crate::formats::is_supported_image_file(name)
}

#[wasm_bindgen(js_name = supportedFileTypes)]
pub fn supported_file_types() -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    struct Types {
        raw: Vec<&'static str>,
        nonRaw: Vec<&'static str>,
    }
    let types = Types {
        raw: crate::formats::RAW_EXTENSIONS
            .iter()
            .map(|(ext, _)| *ext)
            .collect(),
        nonRaw: crate::formats::NON_RAW_EXTENSIONS.to_vec(),
    };
    Ok(types.serialize(&serde_wasm_bindgen::Serializer::json_compatible())?)
}

/// Decodes a RAW or regular image file, matching desktop `load_base_image_from_bytes`.
///
/// `max_dim` > 0 caps the stored working resolution (long edge) while keeping
/// the logical size; used on phones, whose browsers allow far less memory.
#[wasm_bindgen(js_name = decodeImage)]
pub fn decode_image(
    bytes: &[u8],
    file_name: &str,
    settings_json: &str,
    max_dim: u32,
) -> Result<WebImage, JsError> {
    let settings = parse_settings(settings_json);
    let is_raw = crate::formats::is_raw_file(file_name);
    let exif = crate::exif_processing::extract_metadata(bytes).unwrap_or_default();

    let (image, logical) = if is_raw {
        let developed = std::panic::catch_unwind(|| {
            crate::raw_processing::develop_raw_image(
                bytes,
                false,
                settings.raw_highlight_compression.unwrap_or(2.5),
                settings.linear_raw_mode.clone(),
                None,
            )
        });
        match developed {
            Ok(Ok(mut image)) => {
                let color_nr = settings
                    .raw_preprocessing_color_nr
                    .unwrap_or(0.5)
                    .clamp(0.0, 1.0);
                let sharpening = settings.raw_preprocessing_sharpening.unwrap_or(0.35);
                if color_nr > 0.0 || sharpening > 0.0 {
                    remove_raw_artifacts_and_enhance(&mut image, color_nr, sharpening);
                }
                let logical = image.dimensions();
                match capped_size(logical, max_dim) {
                    Some((w, h)) => {
                        let reduced = resize_f32(&image, w, h);
                        drop(image);
                        (reduced, logical)
                    }
                    None => (image, logical),
                }
            }
            Ok(Err(e)) => return Err(err(format!("Failed to develop RAW file: {e}"))),
            Err(_) => return Err(err("The RAW decoder crashed while reading this file.")),
        }
    } else {
        load_image_with_orientation(bytes, max_dim).map_err(err)?
    };

    let as_shot = if is_raw {
        crate::raw_processing::read_as_shot(bytes).unwrap_or_else(AsShot::reference)
    } else {
        AsShot::reference()
    };

    Ok(WebImage {
        image,
        logical,
        is_raw,
        as_shot,
        exif,
        scaled: None,
        mask_reference: None,
    })
}

/// Builds an image from RGBA8 pixels the browser decoded (formats the Rust
/// decoders lack, e.g. HEIC from iPhones in Safari). `rgba` may already be
/// reduced to a working size; `logical_*` is the photo's real size. `source`
/// is the original file, used for EXIF.
#[wasm_bindgen(js_name = decodeRgba)]
pub fn decode_rgba(
    source: &[u8],
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    logical_width: u32,
    logical_height: u32,
) -> Result<WebImage, JsError> {
    let exif = crate::exif_processing::extract_metadata(source).unwrap_or_default();
    let buffer = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| err("Decoded pixel buffer does not match its size"))?;
    let image = DynamicImage::ImageRgb32F(DynamicImage::ImageRgba8(buffer).to_rgb32f());
    Ok(WebImage {
        image,
        logical: (logical_width.max(1), logical_height.max(1)),
        is_raw: false,
        as_shot: AsShot::reference(),
        exif,
        scaled: None,
        mask_reference: None,
    })
}

/// JPEG thumbnail (longest edge `max_dim`) for the library grid. For RAW files the
/// embedded preview is used when available, which is much faster than developing.
#[wasm_bindgen(js_name = quickThumbnail)]
pub fn quick_thumbnail(bytes: &[u8], file_name: &str, max_dim: u32) -> Option<Vec<u8>> {
    let image = if crate::formats::is_raw_file(file_name) {
        crate::raw_processing::extract_embedded_preview(bytes)?
    } else {
        let image = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .ok()?
            .decode()
            .ok()?;
        apply_orientation(image, exif_orientation(bytes))
    };
    let thumb = image.thumbnail(max_dim, max_dim).to_rgb8();
    let mut out = Cursor::new(Vec::new());
    thumb
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut out, 82,
        ))
        .ok()?;
    Some(out.into_inner())
}

/// Histogram (+ optional waveform) packet in the exact binary layout the desktop
/// backend streams to the frontend (`encode_analytics_packet`).
#[wasm_bindgen(js_name = analyticsPacket)]
pub fn analytics_packet(
    path: &str,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    compute_waveform: bool,
    active_channel: Option<String>,
) -> Vec<u8> {
    let frame = AnalyticsFrame {
        data: AnalyticsPixels::Owned(rgba),
        width,
        height,
        row_stride: width as usize * 4,
    };
    let histogram = calculate_histogram(&frame).ok();
    let waveform = compute_waveform
        .then(|| calculate_waveform(&frame, active_channel.as_deref()).ok())
        .flatten();
    encode_analytics_packet(path, histogram.as_ref(), waveform.as_ref())
}

#[wasm_bindgen(js_name = defaultAdjustmentsJson)]
pub fn default_adjustments_json() -> String {
    crate::image_processing::default_adjustments().to_string()
}

fn exif_orientation(bytes: &[u8]) -> Orientation {
    ExifReader::new()
        .read_from_container(&mut Cursor::new(bytes))
        .ok()
        .and_then(|exif| {
            exif.get_field(Tag::Orientation, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
        })
        .map(|o| Orientation::from_u16(o as u16))
        .unwrap_or(Orientation::Normal)
}

/// Same as desktop `image_loader::load_image_with_orientation`, plus an optional
/// working-resolution cap applied before the (4x larger) f32 conversion.
fn load_image_with_orientation(
    bytes: &[u8],
    max_dim: u32,
) -> anyhow::Result<(DynamicImage, (u32, u32))> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    reader.no_limits();
    let image = reader.decode()?;
    let oriented = apply_orientation(image, exif_orientation(bytes));
    let logical = oriented.dimensions();
    let working = match capped_size(logical, max_dim) {
        Some((w, h)) => oriented.thumbnail_exact(w, h),
        None => oriented,
    };
    Ok((DynamicImage::ImageRgb32F(working.to_rgb32f()), logical))
}

/// Size that fits `max_dim` on the long edge, or None when no reduction is needed.
fn capped_size((w, h): (u32, u32), max_dim: u32) -> Option<(u32, u32)> {
    if max_dim == 0 || w.max(h) <= max_dim {
        return None;
    }
    let s = max_dim as f64 / w.max(h) as f64;
    Some((
        ((w as f64 * s).round() as u32).max(1),
        ((h as f64 * s).round() as u32).max(1),
    ))
}

/// Area-average downscale straight from the stored f32 pixels into a buffer of
/// exactly `width` x `height` (no full-size temporary copies, which matter for
/// memory on phones). Falls back to Catmull-Rom for upscaling.
fn resize_f32(image: &DynamicImage, width: u32, height: u32) -> DynamicImage {
    let owned;
    let src: &image::Rgb32FImage = match image {
        DynamicImage::ImageRgb32F(buffer) => buffer,
        other => {
            owned = other.to_rgb32f();
            &owned
        }
    };
    let (sw, sh) = src.dimensions();
    if width > sw || height > sh {
        return DynamicImage::ImageRgb32F(imageops::resize(
            src,
            width,
            height,
            imageops::FilterType::CatmullRom,
        ));
    }
    let raw = src.as_raw();
    let fx = sw as f64 / width as f64;
    let fy = sh as f64 / height as f64;
    let mut out = vec![0f32; width as usize * height as usize * 3];
    let mut acc = vec![0f64; width as usize * 3];
    for y in 0..height as usize {
        let y0 = (y as f64 * fy) as usize;
        let y1 = (((y + 1) as f64 * fy) as usize).clamp(y0 + 1, sh as usize);
        acc.iter_mut().for_each(|v| *v = 0.0);
        for sy in y0..y1 {
            let row = &raw[sy * sw as usize * 3..(sy + 1) * sw as usize * 3];
            for x in 0..width as usize {
                let x0 = (x as f64 * fx) as usize;
                let x1 = (((x + 1) as f64 * fx) as usize).clamp(x0 + 1, sw as usize);
                let (mut r, mut g, mut b) = (0f64, 0f64, 0f64);
                for px in row[x0 * 3..x1 * 3].chunks_exact(3) {
                    r += px[0] as f64;
                    g += px[1] as f64;
                    b += px[2] as f64;
                }
                acc[x * 3] += r / (x1 - x0) as f64;
                acc[x * 3 + 1] += g / (x1 - x0) as f64;
                acc[x * 3 + 2] += b / (x1 - x0) as f64;
            }
        }
        let n = (y1 - y0) as f64;
        let dst = &mut out[y * width as usize * 3..(y + 1) * width as usize * 3];
        for (d, a) in dst.iter_mut().zip(acc.iter()) {
            *d = (*a / n) as f32;
        }
    }
    DynamicImage::ImageRgb32F(
        image::Rgb32FImage::from_raw(width, height, out).expect("buffer size matches"),
    )
}

/// Same as desktop `gpu_compute::rgba_halves` (alpha = 1).
fn rgba_halves(image: &DynamicImage) -> Vec<u16> {
    let rgb = match image {
        DynamicImage::ImageRgb32F(buffer) => std::borrow::Cow::Borrowed(buffer),
        other => std::borrow::Cow::Owned(other.to_rgb32f()),
    };
    let mut out = Vec::with_capacity(rgb.len() / 3 * 4);
    let one = half::f16::ONE.to_bits();
    for px in rgb.as_raw().chunks_exact(3) {
        out.push(half::f16::from_f32(px[0]).to_bits());
        out.push(half::f16::from_f32(px[1]).to_bits());
        out.push(half::f16::from_f32(px[2]).to_bits());
        out.push(one);
    }
    out
}

/// Desktop `AppSettings::default()` serialized exactly as the frontend expects it.
#[wasm_bindgen(js_name = defaultSettingsJson)]
pub fn default_settings_json() -> String {
    serde_json::to_string(&crate::desktop_settings::AppSettings::default())
        .unwrap_or_else(|_| "{}".into())
}
