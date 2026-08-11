#!/usr/bin/env bash
# Fetch the two ONNX files the browser needs. They must be byte-identical to the
# ones insightface loads in CI — that is the entire basis of embedding parity.
set -euo pipefail

DEST="apps/web/public/models"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Parity is a claim about BYTES, so pin them.
#
# The header above says these must be byte-identical to the ones insightface loads
# in CI, and nothing checked it. public/_headers then freezes /models/* as
# `immutable, max-age=31536000`, so anything that lands here reaches every visitor
# and stays in their cache for a year. A silently re-cut upstream release asset
# would produce embeddings that disagree with the index for everyone — the exact
# failure tools/golden exists to catch, arriving through the one door golden does
# not watch, because golden verifies whatever bytes are already on disk.
#
# Regenerate after a DELIBERATE model change (and rename the files — see _headers):
#   shasum -a 256 apps/web/public/models/*.onnx
DET_SHA256="5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a"
REC_SHA256="9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1
  fi
}

install_verified() {   # install_verified <filename> <expected-sha256>
  local name="$1" want="$2" src got
  src="$(find "$TMP/x" -name "$name" -print -quit)"
  [ -n "$src" ] || { echo "FAIL: $name is not in the release archive" >&2; exit 1; }
  got="$(sha256_of "$src")"
  if [ "$got" != "$want" ]; then
    echo "FAIL: $name checksum mismatch" >&2
    echo "        expected $want" >&2
    echo "        got      $got" >&2
    echo "      The upstream asset changed. Do NOT ship this: /models/* is cached" >&2
    echo "      immutable for a year, so every visitor would keep producing" >&2
    echo "      embeddings that disagree with the index." >&2
    exit 1
  fi
  cp "$src" "$DEST/"
  echo "  ok  $name  ($got)"
}

mkdir -p "$DEST"
echo "Downloading buffalo_s…"
curl -fsSL -o "$TMP/buffalo_s.zip" \
  "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_s.zip"
unzip -oq "$TMP/buffalo_s.zip" -d "$TMP/x"

install_verified det_500m.onnx  "$DET_SHA256"
install_verified w600k_mbf.onnx "$REC_SHA256"

ls -lh "$DEST"/*.onnx
echo "Done. These are gitignored — re-run this after a fresh clone."
