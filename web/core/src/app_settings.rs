//! Subset of the desktop `AppSettings` that the reused modules read.
//! Defaults mirror `src-tauri/src/app_settings.rs`.

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub enable_baseline_exposure: bool,
    pub baseline_exposure: f32,
    pub compensate_highlight_preservation: bool,
    pub raw_highlight_compression: Option<f32>,
    pub linear_raw_mode: String,
    pub raw_preprocessing_color_nr: Option<f32>,
    pub raw_preprocessing_sharpening: Option<f32>,
    pub apply_preprocessing_to_non_raws: Option<bool>,
    pub tonemapper_override_enabled: Option<bool>,
    pub default_raw_tonemapper: Option<String>,
    pub default_non_raw_tonemapper: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            enable_baseline_exposure: false,
            baseline_exposure: 0.7,
            compensate_highlight_preservation: true,
            raw_highlight_compression: Some(2.5),
            linear_raw_mode: "auto".to_string(),
            raw_preprocessing_color_nr: Some(0.5),
            raw_preprocessing_sharpening: Some(0.35),
            apply_preprocessing_to_non_raws: Some(false),
            tonemapper_override_enabled: None,
            default_raw_tonemapper: None,
            default_non_raw_tonemapper: None,
        }
    }
}

/// Mirrors `image_processing::resolve_tonemapper_override` on desktop.
pub fn resolve_tonemapper_override(settings: &AppSettings, is_raw: bool) -> Option<u32> {
    if !settings.tonemapper_override_enabled.unwrap_or(false) {
        return None;
    }
    let tm = if is_raw {
        settings.default_raw_tonemapper.as_deref().unwrap_or("agx")
    } else {
        settings
            .default_non_raw_tonemapper
            .as_deref()
            .unwrap_or("basic")
    };
    Some(if tm == "agx" { 1 } else { 0 })
}
