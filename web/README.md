# RapidRAW Web

RapidRAW running entirely in the browser — desktop and phone — with the same
image pipeline as the desktop app.

> **한국어 요약** — RapidRAW 데스크톱 앱의 React UI를 그대로 쓰고, Tauri(Rust) 백엔드를
> 브라우저용으로 바꾼 웹 버전입니다. RAW 현상과 보정값 계산은 RapidRAW의 Rust 코드를
> WebAssembly로 컴파일해 사용하고, 렌더링은 원본 WGSL 셰이더를 WebGPU로 실행합니다.
> PC에서는 실제 폴더를 열어 편집하고(데스크톱 앱과 `.rrdata` 사이드카 호환),
> 휴대폰에서는 브라우저 내부 라이브러리에 사진을 가져와 편집한 뒤 공유 시트로 저장합니다.

## How it works

| Layer                                                                         | Desktop app                           | Web build                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| UI                                                                            | `src/` (React)                        | **same code**, unchanged except one responsive header fix         |
| Tauri APIs (`invoke`, events, dialogs, window)                                | Tauri                                 | `web/src/shims/*` (Vite aliases)                                  |
| Commands (`load_image`, `apply_adjustments`, …)                               | `src-tauri/src`                       | `web/src/backend/*`                                               |
| RAW decoding, adjustment → GPU uniform packing, masks, histogram, auto adjust | Rust                                  | **same Rust code** compiled to WebAssembly (`web/core`)           |
| Rendering                                                                     | wgpu + `src-tauri/src/shaders/*.wgsl` | WebGPU + **the same WGSL files** (`web/src/gpu/renderer.ts`)      |
| Files                                                                         | file system                           | File System Access API (desktop Chromium) / OPFS library (phones) |

`web/core` reuses the desktop sources in two ways:

- modules without Tauri dependencies are included verbatim with `#[path]`
  (`raw_processing.rs`, `white_balance.rs`, `highlight_reconstruction.rs`, …);
- modules that mix image code with Tauri glue are copied item-by-item by
  [`web/core/extract.py`](core/extract.py) into `web/core/src/upstream/` —
  re-run it after merging upstream changes.

`web/core/scripts/prepare-rawler.sh` vendors the exact `rawler` revision used by
the desktop app and patches its three `Instant::now()` calls (they panic in
WebAssembly).

## Using it

### On a computer (Chrome / Edge)

1. **Open Folder** and pick a photo folder. The browser asks for read/write access.
2. Edit as in the desktop app. Edits are saved as `<photo>.rrdata` next to the
   photo — the same sidecar format as desktop RapidRAW, so both apps see the same edits.
3. **Export** writes into a folder you choose (or downloads, for single images).

### On a phone or tablet

The web build switches to RapidRAW's touch layout (the one used by the Android app).

1. **Open Library**, then tap the import button to add photos. They are copied
   into the browser's private storage (OPFS) and stay there between visits.
2. Double-tap a photo to edit.
3. After **Export**, use **Save / Share** to save the result to your gallery.
4. _Add to Home Screen_ installs it like an app (PWA, works offline after the first load).

Force a layout with `?ui=mobile` or `?ui=desktop` (`?ui=auto` resets).

### Browser support

WebGPU is required: Chrome/Edge 113+ (desktop), Chrome 121+ on Android 12+,
Safari 26+ (macOS/iOS/iPadOS). HEIC photos are decoded by the browser where it
supports them (Safari).

## Development

Requirements: Node 22, the Rust toolchain from `src-tauri/rust-toolchain.toml`
with the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` matching
`web/core/Cargo.lock`.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127 --locked
npm ci
npm run web:core      # build the WebAssembly core into web/core/pkg
npm run web:dev       # http://localhost:1430
npm run web:build     # production build in web/dist
npm run web:typecheck
```

WebGPU needs a secure context: use `localhost` or HTTPS.

### Deployment

`.github/workflows/web-deploy.yml` builds and publishes to GitHub Pages on pushes
to `main` / `web-version`. Enable it once under **Settings → Pages → Source:
GitHub Actions**. Any static host works; set `RAPIDRAW_WEB_BASE` when serving
from a sub-path.

## Status

Working: library (folders, ratings, flags, color labels, tags, albums, virtual
copies), RAW + JPEG/PNG/TIFF/WebP… decoding, every adjustment in the Adjust panel
(tone, curves, HSL, color grading/calibration, detail, dehaze, clarity/structure,
vignette, grain, glow/halation/flare, AgX, B&W), crop/rotate/flip, radial/linear/
brush/color/luminance masks, presets (incl. import/export and community presets),
auto adjust, histogram/waveform, JPEG/PNG/WebP export with resize.

Not available yet in the browser: AI features (masks, denoise, generative edits,
culling, tagging), LUT files, lens-profile correction, panorama/HDR/focus
stacking, TIFF/JPEG XL/AVIF export, camera tethering, Immich, cloud sign-in.

Notes:

- RAW development runs single-threaded in WebAssembly (≈6 s for a 12 MP NEF on a
  laptop CPU); it happens in a Web Worker so the UI stays responsive.
- Phones keep images at most 4096 px on the long edge in memory (iOS Safari
  reloads a tab above roughly 1.5 GB and limits canvases to ~16.7 MP). Crop and
  mask coordinates still refer to the full-size photo, so sidecars stay
  compatible with desktop; exports from a phone are at most 4096 px.
- Very large RAW files (e.g. 48 MP ProRAW DNG) are developed at full size before
  being reduced and may still exceed a phone browser's memory; HEIC/JPEG work best.
- Full-resolution export is limited to the GPU's maximum texture size
  (usually 8192 or 16384 px), like the desktop app.

## License

AGPL-3.0, same as RapidRAW. If you host a modified version publicly, the AGPL
requires offering its source to your users.
