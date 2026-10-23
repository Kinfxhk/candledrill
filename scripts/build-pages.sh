#!/bin/sh
# Build the GitHub Pages (browser-only) version into $1 (default: dist-pages).
set -eu
out="${1:-dist-pages}"
cd "$(dirname "$0")/../packages/web"
VITE_BACKEND=local PAGES_BASE="${PAGES_BASE:-/candledrill/}" npx vite build --outDir "$out" --emptyOutDir
