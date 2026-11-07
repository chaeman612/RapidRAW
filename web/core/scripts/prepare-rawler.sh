#!/usr/bin/env bash
# Vendors the exact rawler revision the desktop app uses and patches the few
# spots that call std::time::Instant (which panics on wasm32-unknown-unknown)
# to use the `web-time` crate instead.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
rev="$(grep -A3 'name = "rawler"' "$root/src-tauri/Cargo.lock" | sed -n 's/.*#\([0-9a-f]\{40\}\)".*/\1/p' | head -1)"
dest="$here/.vendor/dnglab"
stamp="$dest/.prepared-$rev"
[ -f "$stamp" ] && exit 0
rm -rf "$dest"
git clone --quiet --filter=blob:none https://github.com/CyberTimon/RapidRAW-DngLab "$dest"
git -C "$dest" checkout --quiet "$rev"
rawler="$dest/rawler"
for f in src/decompressors/crx/decoder.rs src/imgop/sensor/bayer/ppg.rs src/dng/writer.rs; do
  sed -i -E 's/\bInstant::now\(\)/web_time::Instant::now()/g' "$rawler/$f"
done
# add web-time dependency
sed -i 's/^\[dependencies\]$/[dependencies]\nweb-time = "1"/' "$rawler/Cargo.toml"
# (the `use std::time::Instant` lines stay; only the panicking now() calls change)
touch "$stamp"
echo "rawler $rev prepared in $rawler"
