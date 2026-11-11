#!/bin/bash
# Builds the key holder for OutLayer and checks the artefact before it's uploaded: the manifest is
# embedded, the signing-keys interface is imported, and it fits FastFS. Prints the SHA256 that names
# the version on OutLayer, which anyone can compare with the attestation of a run.
set -euo pipefail
cd "$(dirname "$0")"

WASM="target/wasm32-wasip2/release/covenant-key-holder.wasm"
MAX_SIZE=$((2 * 1024 * 1024))

rustup target add wasm32-wasip2 >/dev/null 2>&1 || true
cargo build --release --target wasm32-wasip2 --quiet

grep -qa 'outlayer.manifest' "$WASM" || { echo "ERROR: the outlayer.manifest section is missing"; exit 1; }
grep -qa 'outlayer:signing-keys/api' "$WASM" || { echo "ERROR: outlayer:signing-keys isn't imported"; exit 1; }
SIZE=$(wc -c < "$WASM" | tr -d ' ')
[ "$SIZE" -le "$MAX_SIZE" ] || { echo "ERROR: $SIZE bytes is over FastFS's 2 MB"; exit 1; }

echo "Built $WASM ($((SIZE / 1024)) KB)"
echo "SHA256: $(shasum -a 256 "$WASM" | cut -d' ' -f1)"
