#!/usr/bin/env bash
# Builds the WebAssembly core into web/core/pkg (consumed by the Vite web build).
#   requirements: rustup toolchain from src-tauri/rust-toolchain.toml with the
#   wasm32-unknown-unknown target, and wasm-bindgen-cli matching Cargo.lock.
set -euo pipefail
cd "$(dirname "$0")"
./scripts/prepare-rawler.sh
toolchain="$(sed -n 's/^channel = "\(.*\)"/\1/p' ../../src-tauri/rust-toolchain.toml)"
export RUSTFLAGS="${RUSTFLAGS:-} --cfg getrandom_backend=\"wasm_js\""
cargo +"$toolchain" build --release --target wasm32-unknown-unknown
target_dir="${CARGO_TARGET_DIR:-target}"
wasm-bindgen --target web --out-dir pkg --out-name rapidraw_core \
  "$target_dir/wasm32-unknown-unknown/release/rapidraw_web_core.wasm"
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int pkg/rapidraw_core_bg.wasm -o pkg/rapidraw_core_bg.wasm
fi
ls -lh pkg/rapidraw_core_bg.wasm
