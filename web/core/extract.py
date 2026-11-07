#!/usr/bin/env python3
"""Extract named top-level items from RapidRAW's desktop Rust sources.

The web core reuses RapidRAW's image-processing code verbatim where it can.
Some desktop modules mix pure image math with Tauri/AppState glue, so instead of
forking them by hand this script copies only the named top-level items
(functions, structs, consts, impls...) into ``src/upstream/<module>.rs``.

Re-run it after merging upstream changes:

    python3 web/core/extract.py

Each generated file starts with a header listing its source, so diffs against
upstream stay easy to review.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "src-tauri" / "src"
OUT = Path(__file__).resolve().parent / "src" / "upstream"

ITEM_RE = re.compile(
    r"^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+fn|async\s+fn|unsafe\s+fn|fn|struct|enum|const|static|type|trait|impl(?:<[^>]*>)?)\s+"
)


def top_level_items(text: str):
    """Yield (name_key, start, end) for each top-level item in a Rust file."""
    lines = text.splitlines(keepends=True)
    offsets = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line)

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if line.startswith((" ", "\t", "}", "\n")) or not line.strip():
            i += 1
            continue
        # Collect leading attributes / doc comments.
        start = i
        while i < n and (lines[i].startswith("#[") or lines[i].startswith("///") or lines[i].startswith("//")):
            # multi-line attribute
            if lines[i].startswith("#[") and lines[i].count("[") > lines[i].count("]"):
                depth = lines[i].count("[") - lines[i].count("]")
                i += 1
                while i < n and depth > 0:
                    depth += lines[i].count("[") - lines[i].count("]")
                    i += 1
                continue
            i += 1
        if i >= n:
            break
        header = lines[i]
        if not ITEM_RE.match(header):
            i += 1
            continue
        # Find the end of the item: either `;` at depth 0 or matching `}`.
        depth = 0
        j = i
        end_line = None
        in_str = False
        while j < n:
            l = lines[j]
            k = 0
            while k < len(l):
                c = l[k]
                if in_str:
                    if c == "\\":
                        k += 2
                        continue
                    if c == '"':
                        in_str = False
                elif c == "/" and l[k : k + 2] == "//":
                    break
                elif c == '"':
                    in_str = True
                elif c == "'" and re.match(r"'(\\.|[^\\'])'", l[k:]):
                    k += len(re.match(r"'(\\.|[^\\'])'", l[k:]).group(0))
                    continue
                elif c in "{([":
                    depth += 1
                elif c in "})]":
                    depth -= 1
                    if depth == 0 and c == "}":
                        rest = l[k + 1 :].strip()
                        if not rest.startswith(("else", ".", ")")):
                            end_line = j
                elif c == ";" and depth == 0:
                    end_line = j
                if end_line is not None:
                    break
                k += 1
            if end_line is not None:
                break
            j += 1
        if end_line is None:
            end_line = n - 1
        key = item_key(header)
        yield key, offsets[start], offsets[end_line] + len(lines[end_line])
        i = end_line + 1


def item_key(header: str) -> str:
    h = re.sub(r"^pub(?:\([^)]*\))?\s+", "", header.strip())
    m = re.match(r"impl(?:<[^>]*>)?\s+(.+?)\s*(?:\{|where|$)", h)
    if m:
        return "impl " + re.sub(r"\s+", " ", m.group(1))
    m = re.match(r"(?:const\s+fn|async\s+fn|unsafe\s+fn|fn|struct|enum|const|static|type|trait)\s+([A-Za-z_][A-Za-z0-9_é]*)", h)
    return m.group(1) if m else h


def extract(module: str, names: list[str], prelude: str, epilogue: str = "", out_name: str | None = None) -> None:
    src_path = SRC / f"{module}.rs"
    text = src_path.read_text()
    items = {}
    for key, s, e in top_level_items(text):
        items.setdefault(key, []).append(text[s:e])
    missing = [name for name in names if name not in items]
    if missing:
        sys.exit(f"{module}.rs: items not found: {missing}\navailable: {sorted(items)}")
    body = "\n".join(chunk for name in names for chunk in items[name])
    # Paths in include_str! are relative to src-tauri/src; generated files live
    # three directories deeper relative to the repository root.
    body = body.replace('include_str!("../../src/', 'include_str!("../../../../src/')
    # std::time::Instant::now() panics on wasm32-unknown-unknown.
    body = re.sub(r"\b(?:std::time::)?Instant::now\(\)", "web_time::Instant::now()", body)
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{out_name or module}.rs"
    out.write_text(
        f"// @generated by web/core/extract.py from src-tauri/src/{module}.rs -- do not edit by hand.\n"
        f"// Items: {', '.join(names)}\n"
        "#![allow(dead_code, unused_imports, clippy::all)]\n\n"
        f"{prelude.strip()}\n\n{body}"
        + (f"\n{epilogue.strip()}\n" if epilogue else "")
    )
    print(f"wrote {out.relative_to(ROOT)} ({len(names)} items)")


IMAGE_PROCESSING_PRELUDE = """
use crate::as_shot::AsShot;
use crate::baseline_exposure::BaselineOptions;
use crate::mask_generation::MaskDefinition;
use crate::shims::AnalyticsPixels;
use crate::white_balance::{self, WhiteBalance};
use bytemuck::{Pod, Zeroable};
use glam::{Mat3, Vec2, Vec3};
use image::{DynamicImage, GenericImageView, Rgb32FImage, Rgba};
use rawler::decoders::Orientation;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use serde_json::json;
use std::borrow::Cow;
use std::f32::consts::PI;
use std::sync::{Arc, OnceLock};
"""

IMAGE_PROCESSING_ITEMS = [
    # adjustment defaults / visibility helpers
    "BASELINE_EXPOSURE_KEY",
    "default_adjustments",
    "default_adjustment_values",
    "uses_baseline_exposure",
    "effective_baseline_exposure",
    "mark_baseline_exposure",
    # orientation (used by raw_processing)
    "rgb32f_mut",
    "apply_orientation",
    "orient_rgb32f",
    "oriented_rgb32f",
    "downscale_f32_image",
    "u8_to_f32_lut",
    "fitted_size",
    "downscale_f32_image_if_needed",
    "BoxFilter",
    "impl BoxFilter<'_>",
    "apply_exposure",
    "apply_cpu_default_raw_processing",
    "srgb_channel_to_linear",
    "map_color_channels",
    "apply_srgb_to_linear",
    "apply_linear_to_srgb",
    # GPU uniform structs
    "AutoAdjustmentResults",
    "Point",
    "HslColor",
    "ColorGradeSettings",
    "ColorCalibrationSettings",
    "MonochromeSettings",
    "GpuMat3",
    "impl Default for GpuMat3",
    "GlobalAdjustments",
    "MaskAdjustments",
    "MAX_MASKS",
    "AllAdjustments",
    "AdjustmentScales",
    "SCALES",
    # JSON -> uniform parsing
    "parse_hsl_adjustments",
    "parse_color_grade_settings",
    "hue_to_linear_srgb",
    "oklab_hue_direction",
    "monochrome_film_response",
    "parse_monochrome_settings",
    "convert_points_to_aligned",
    "WP_D65",
    "PRIMARIES_SRGB",
    "PRIMARIES_REC2020",
    "xy_to_xyz",
    "primaries_to_xyz_matrix",
    "rotate_and_scale_primary",
    "mat3_to_gpu_mat3",
    "calculate_agx_matrices_glam",
    "calculate_agx_matrices",
    "RenderOptions",
    "LEGACY_SECTION_TOOLS",
    "is_section_visible",
    "is_tool_active",
    "active_tools",
    "is_effect_enabled",
    "get_global_adjustments_from_json",
    "get_mask_adjustments_from_json",
    "get_all_adjustments_from_json",
    # RAW pre-processing (color NR + detail enhance)
    "into_rgb32f_parallel",
    "remove_raw_artifacts_and_enhance",
    "ChromaPlanes",
    "impl ChromaPlanes",
    "UpsampleRow",
    "UpsampledChunk",
    "upsample_chunk",
    "upsample_taps",
    "reduce_raw_chroma_noise",
    "estimate_noise",
    "sqrt_luma_plane",
    "apply_gentle_detail_enhance",
    # histogram / auto adjust
    "HistogramData",
    "AnalyticsFrame",
    "impl AnalyticsFrame",
    "calculate_histogram",
    "apply_gaussian_smoothing",
    "normalize_histogram_range",
    "WaveformData",
    "encode_analytics_packet",
    "WAVEFORM_W",
    "WAVEFORM_H",
    "WAVEFORM_MAX_BANDS",
    "WaveformBins",
    "impl WaveformBins",
    "calculate_waveform",
    "perform_auto_analysis",
    "AutoAdjustMode",
    "auto_results_to_json",
]


MASK_GENERATION_PRELUDE = """
use crate::image_processing::apply_cpu_default_raw_processing;
use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, GrayImage, Luma, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::f32::consts::PI;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
"""

MASK_GENERATION_ITEMS = [
    "SubMaskMode",
    "SubMask",
    "default_opacity",
    "MaskDefinition",
    "GrowFeatherParameters",
    "RadialMaskParameters",
    "LinearMaskParameters",
    "default_range",
    "impl Default for LinearMaskParameters",
    "Point",
    "BrushLine",
    "default_brush_feather",
    "BrushMaskParameters",
    "FlowLine",
    "default_line_flow",
    "FlowMaskParameters",
    "ParametricMaskParameters",
    "default_tolerance",
    "impl Default for ParametricMaskParameters",
    "grayscale_dilate",
    "grayscale_erode",
    "gaussian_kernel",
    "saturate_u8",
    "gaussian_blur_mask",
    "apply_grow_and_feather",
    "stroke_bounds",
    "render_stroke_layer_parallel",
    "generate_radial_bitmap",
    "generate_linear_bitmap",
    "generate_brush_bitmap",
    "generate_flow_bitmap",
    "generate_color_bitmap",
    "generate_luminance_bitmap",
    "for_each_mask_row",
    "generate_all_bitmap",
]

AS_SHOT_PRELUDE = """
use crate::baseline_exposure::RawExposure;
use crate::white_balance::WhiteBalance;
"""

NEGATIVE_CONVERSION_PRELUDE = """
use serde_json::Value;
"""


EXIF_PRELUDE = """
use chrono::{DateTime, Local, LocalResult, NaiveDateTime, TimeZone, Utc};
use exif::{Exif, In, Value};
use rawler::decoders::RawMetadata;
use rawler::lens::LensDescription;
use std::collections::HashMap;
use std::io::Cursor;
"""

EXIF_ITEMS = [
    "truncate_large_exif",
    "clean_creation_datetime_str",
    "EXIF_DATETIME_FORMAT",
    "format_creation_datetime",
    "fmt_date_str",
    "normalize_creation_datetime",
    "parse_creation_datetime",
    "clean_ascii_value",
    "rational_to_f32_checked",
    "rawler_rational_to_f32_checked",
    "format_min_max",
    "format_lens_spec",
    "format_lens_specification",
    "is_tiff",
    "read_exif",
    "read_raw_metadata",
    "raw_metadata_from_source",
    "insert_missing_lens_fields",
    "extract_metadata",
]


SETTINGS_PRELUDE = """
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
"""

SETTINGS_ITEMS = [
    "SortCriteria", "FilterCriteria", "impl Default for FilterCriteria", "FolderTreeSort",
    "impl Default for FolderTreeSort", "LastFolderState", "MyLens", "CustomAspectRatio",
    "EditInMode", "EditInApp", "PasteMode", "all_available_adjustments",
    "default_included_adjustments", "CopyPasteSettings", "impl Default for CopyPasteSettings",
    "ExportPreset", "default_export_presets", "AdjustmentLayout", "WorkspaceState",
    "impl Default for WorkspaceState", "default_linear_raw_mode", "default_baseline_exposure",
    "default_compensate_highlight_preservation", "default_ai_gpu_acceleration",
    "default_ai_cache_limit_gb", "default_ai_maps_cache_limit_gb",
    "default_thumbnail_cache_limit_gb", "default_tagging_shortcuts_option",
    "default_open_tree_sections", "AppSettings", "impl Default for AppSettings",
]


if __name__ == "__main__":
    extract("image_processing", IMAGE_PROCESSING_ITEMS, IMAGE_PROCESSING_PRELUDE)
    extract(
        "mask_generation",
        MASK_GENERATION_ITEMS,
        MASK_GENERATION_PRELUDE,
        # Web-specific dispatcher (no AI / match-brush masks) needs access to the
        # private generators above, so it is spliced into the same module.
        'include!("../web_ext/mask_dispatch.rs");',
    )
    extract("exif_processing", EXIF_ITEMS, EXIF_PRELUDE)
    extract("app_settings", SETTINGS_ITEMS, SETTINGS_PRELUDE, out_name="desktop_settings")
    extract(
        "immich/config",
        ["ImmichSettings", "impl Default for ImmichSettings"],
        "use serde::{Deserialize, Serialize};",
        out_name="immich_config",
    )
    extract("as_shot", ["AsShot", "impl AsShot"], AS_SHOT_PRELUDE)
    extract("negative_conversion", ["is_enabled", "effective_is_raw"], NEGATIVE_CONVERSION_PRELUDE)
