#!/usr/bin/env bash
# Fetch the two ONNX files the browser needs. They must be byte-identical to the
# ones insightface loads in CI — that is the entire basis of embedding parity.
set -euo pipefail

DEST="apps/web/public/models"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DEST"
echo "Downloading buffalo_s…"
curl -fsSL -o "$TMP/buffalo_s.zip" \
  "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip"
unzip -oq "$TMP/buffalo_s.zip" -d "$TMP/x"

find "$TMP/x" -name 'det_500m.onnx'  -exec cp {} "$DEST/" \;
find "$TMP/x" -name 'w600k_mbf.onnx' -exec cp {} "$DEST/" \;

ls -lh "$DEST"/*.onnx
echo "Done. These are gitignored — re-run this after a fresh clone."
