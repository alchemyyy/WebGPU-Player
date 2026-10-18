#!/usr/bin/env bash
# Runs a clean build of the engine: ./build.sh --clean, with any other build.sh options passed along.
#
# build.sh checks the tools and the pinned Emscripten first, installing the engine's own emsdk when EMSDK is unset, so
# a missing toolchain removes nothing.
# It then removes bin/wasm/, bin/libraries/, bin/build-info.json, bin/wgpud/, bin/wgpup/, the sandbox's Vite build, the
# WebAssembly and decoder build trees, and the cargo target folders a crate's own cargo run leaves beside its sources,
# and rebuilds everything, the Mediabunny fork included.
# Keeps the committed bin/codec_vector_assets/, the generated bin/playback_smoke_media/ and bin/plantuml/, the engine's
# emsdk in bin/emsdk/, the fetched codec source submodules, and node_modules.
# Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

engine_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly engine_directory

exec "$engine_directory/build.sh" --clean "$@"
