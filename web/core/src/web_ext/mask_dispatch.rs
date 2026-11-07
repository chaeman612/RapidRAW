// Spliced into `upstream/mask_generation.rs` by extract.py.
//
// Web counterpart of desktop `generate_sub_mask_bitmap` / `generate_mask_bitmap`.
// Geometric (radial, linear, brush, flow) and parametric (color, luminance) masks
// use RapidRAW's own generators unchanged. AI-based masks need ONNX models that the
// web build does not ship yet, so they are skipped.

fn web_sub_mask_bitmap(
    sub_mask: &SubMask,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    if !sub_mask.visible {
        return None;
    }
    match sub_mask.mask_type.as_str() {
        "radial" => Some(generate_radial_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "linear" => Some(generate_linear_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "brush" | "clone" | "heal" | "liquify" | "retouch" => Some(generate_brush_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "flow" => Some(generate_flow_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
        )),
        "color" => generate_color_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "luminance" => generate_luminance_bitmap(
            &sub_mask.parameters,
            width,
            height,
            scale,
            crop_offset,
            warped_image,
        ),
        "all" => Some(generate_all_bitmap(width, height)),
        _ => None,
    }
}

pub fn generate_mask_bitmap(
    mask_def: &MaskDefinition,
    width: u32,
    height: u32,
    scale: f32,
    crop_offset: (f32, f32),
    warped_image: Option<&DynamicImage>,
) -> Option<GrayImage> {
    if !mask_def.visible || mask_def.sub_masks.is_empty() {
        return None;
    }

    let mut final_mask = GrayImage::new(width, height);

    for sub_mask in &mask_def.sub_masks {
        if let Some(mut sub_bitmap) =
            web_sub_mask_bitmap(sub_mask, width, height, scale, crop_offset, warped_image)
        {
            let invert = sub_mask.invert;
            let opacity_multiplier = (sub_mask.opacity / 100.0).clamp(0.0, 1.0);
            let mode = sub_mask.mode;
            final_mask
                .iter_mut()
                .zip(sub_bitmap.iter_mut())
                .for_each(|(pixel, sub_pixel)| {
                    if invert {
                        *sub_pixel = 255 - *sub_pixel;
                    }
                    if opacity_multiplier < 1.0 {
                        *sub_pixel = (*sub_pixel as f32 * opacity_multiplier) as u8;
                    }
                    *pixel = match mode {
                        SubMaskMode::Additive => (*pixel).max(*sub_pixel),
                        SubMaskMode::Subtractive => pixel.saturating_sub(*sub_pixel),
                        SubMaskMode::Intersect => (*pixel).min(*sub_pixel),
                    };
                });
        }
    }

    let invert = mask_def.invert;
    let opacity_multiplier = (mask_def.opacity / 100.0).clamp(0.0, 1.0);
    if invert || opacity_multiplier < 1.0 {
        final_mask.iter_mut().for_each(|pixel| {
            if invert {
                *pixel = 255 - *pixel;
            }
            if opacity_multiplier < 1.0 {
                *pixel = (*pixel as f32 * opacity_multiplier) as u8;
            }
        });
    }

    Some(final_mask)
}
