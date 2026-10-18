#!/usr/bin/env bash
# Builds every engine output: the Mediabunny fork, the WebAssembly modules, the decoder packages, and the served assets.
#
# Checks the tools, the pinned Emscripten, and the npm dependencies before it removes or builds anything.
# Without EMSDK, and without the engine's own emsdk at the pinned version, it installs that emsdk with make -C wasm emsdk.
# With --clean, which build_clean.sh passes, it then removes every build tree and build output.
# Fetches the Mediabunny fork submodule when it is missing, and builds the fork in the background with
# scripts/mediabunny.mjs, which skips it while its build is of the checked-out commit.
# Builds the decoder packages in the background too (make -C wgpud sources, then scripts/decoder-packages.mjs, which
# builds every project's module at once), while make -C wasm all builds the engine's WebAssembly modules; then
# `npm run build` assembles bin/libraries/ and bin/wgpup/ once the fork is built.
# Works in Git Bash on Windows and in bash on Linux and macOS.

set -euo pipefail

engine_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly engine_directory

# The layout keys of the outputs and build trees --clean removes, from tools/constants.json
readonly cleaned_layout_keys=(
    wasmOutputDirectory
    libraryOutputDirectory
    buildInfoFile
    decoderOutputDirectory
    passOutputDirectory
    sandboxOutputDirectory
    decoderBuildDirectory
)
# The cargo target folder a direct cargo run in the libdovi crate leaves, relative to the wasm directory
readonly libdovi_crate_target='libdovi/target'

clean=false
production=false
rebuild_mediabunny=false

print_usage() {
    cat <<'USAGE'
Usage: ./build.sh [options]

Builds the Mediabunny fork, the WebAssembly modules into bin/wasm/, the decoder packages into bin/wgpud/, and the
served assets into bin/libraries/, bin/build-info.json, and bin/wgpup/.

Options:
  --clean                Remove every build tree and build output first, and rebuild the Mediabunny fork too.
                         Keeps bin/codec_vector_assets/, bin/playback_smoke_media/, bin/plantuml/, bin/emsdk/, the
                         codec source submodules, and node_modules. ./build_clean.sh runs ./build.sh --clean.
  --production           Minify the workers, as npm run build -- --production does.
  --rebuild-mediabunny   Rebuild the Mediabunny fork even when its build is of the checked-out commit.
  -h, --help             Show this help.

The builds need GNU Make, rustup, CMake, Perl, GNU patch, and the pinned Emscripten; see docs/src/setup.md and
docs/src/decoders.md. They are checked before anything is removed or built.
Emscripten comes from the emsdk that EMSDK names, as emsdk_env sets it. Without EMSDK, the build installs the pinned
version into the engine's own emsdk in bin/emsdk/ once, about 2 GB with Python 3 to run the installer, and the
Makefiles use it from then on.

Examples:
  ./build.sh
  ./build.sh --clean --production
  EMSDK=~/emsdk ./build.sh
USAGE
}

fail() {
    # Background builds finish first, so none outlives this script and this message prints last
    wait
    printf 'build.sh: %s\n' "$*" >&2
    exit 1
}

# Native Windows tools (node, make) need Windows paths when this runs under Git Bash
native_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
        return
    fi
    printf '%s\n' "$1"
}

# Reads an engine folder from tools/constants.json, the one place that names them
engine_layout() {
    node -p 'require(process.argv[1])[process.argv[2]]' "$(native_path "$engine_directory/tools/constants.json")" "$1"
}

remove_path() {
    if [ -e "$1" ]; then
        printf 'Removing %s\n' "$1"
        rm -rf -- "$1"
    fi
}

# Runs the Emscripten check each Makefile pins; a failed check prints the version it needs
check_emscripten() {
    local makefile_path
    for makefile_path in "$wasm_path" "$decoders_path"; do
        make --no-print-directory -C "$(native_path "$engine_directory/$makefile_path")" toolchain || return 1
    done
}

# Options
while [ "$#" -gt 0 ]; do
    case "$1" in
        --clean)
            clean=true
            shift
            ;;
        --production)
            production=true
            shift
            ;;
        --rebuild-mediabunny)
            rebuild_mediabunny=true
            shift
            ;;
        -h | --help)
            print_usage
            exit 0
            ;;
        *)
            fail "Unknown option: $1 (see --help)"
            ;;
    esac
done

# Every tool the builds run by name, checked before anything is removed or built; make reads CARGO and CMAKE as overrides
for required_command in node npm git make "${CARGO:-cargo}" "${CMAKE:-cmake}" perl patch; do
    command -v "$required_command" >/dev/null 2>&1 || fail "$required_command is required; see docs/src/setup.md"
done
cd "$engine_directory"

# Every package the engine declares, looked up as Node does: upward from the engine, which covers a host workspace's node_modules
missing_packages="$(node -e '
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const manifest = require("./package.json");
const packageNames = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
const isInstalled = packageName => require.resolve.paths(packageName)
    .some(directory => existsSync(join(directory, packageName, "package.json")));
console.log(packageNames.filter(packageName => !isInstalled(packageName)).join(" "));
')" || fail 'Cannot read package.json'
# npm prefix names the host's root when a host lists the engine as a workspace, and the engine root otherwise
[ -z "$missing_packages" ] || fail "Missing npm packages: $missing_packages; run npm ci in $(npm prefix)"

scripts_path="$(engine_layout scriptsDirectory)" || fail 'Cannot read the engine layout'
wasm_path="$(engine_layout wasmDirectory)" || fail 'Cannot read the engine layout'
decoders_path="$(engine_layout decodersDirectory)" || fail 'Cannot read the engine layout'
mediabunny_path="$(engine_layout mediabunnySourceDirectory)" || fail 'Cannot read the engine layout'

# Emscripten. Without EMSDK, the Makefiles use the engine's own emsdk, so a failed check installs it at the pinned version
if [ -z "${EMSDK:-}" ] && ! check_emscripten 2>/dev/null; then
    command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1 \
        || fail 'Python 3 is required to install the engine emsdk'
    printf 'Installing the pinned Emscripten into the engine emsdk\n'
    make --no-print-directory -C "$(native_path "$engine_directory/$wasm_path")" emsdk \
        || fail 'The engine emsdk install failed'
fi
if ! check_emscripten; then
    [ -z "${EMSDK:-}" ] \
        || fail "The Emscripten check failed for EMSDK=$EMSDK; name an emsdk with the pinned version active, or unset EMSDK to use the engine's own"
    fail 'The Emscripten check failed for the engine emsdk; make -C wasm emsdk reinstalls it'
fi

# Clean build: every build tree and output goes, so each step below rebuilds from its sources
if [ "$clean" = true ]; then
    for layout_key in "${cleaned_layout_keys[@]}"; do
        relative_path="$(engine_layout "$layout_key")" || fail "Cannot read $layout_key from the engine layout"
        # An empty path would name the engine root itself
        [ -n "$relative_path" ] && [ "$relative_path" != 'undefined' ] || fail "The engine layout names no $layout_key"
        remove_path "$engine_directory/$relative_path"
    done
    # The WebAssembly Makefile owns its build tree
    make -C "$(native_path "$engine_directory/$wasm_path")" clean || fail "make -C $wasm_path clean failed"
    remove_path "$engine_directory/$wasm_path/$libdovi_crate_target"
    # Cargo target folders of the decoder projects' crates, at <decoders>/<project>/<crate>/target
    for crate_target in "$engine_directory/$decoders_path"/*/*/target; do
        [ -d "$crate_target" ] || continue
        remove_path "$crate_target"
    done
    rebuild_mediabunny=true
fi

# Every crate pins one Rust, which rustup installs on first use; rustup installs are not safe side by side, so this one runs first
(cd "$engine_directory/$wasm_path/libdovi" && "${CARGO:-cargo}" --version >/dev/null) \
    || fail 'The pinned Rust toolchain is not available; see docs/src/decoders.md'

# Mediabunny fork, which only the asset build bundles, so it builds in the background beside the WebAssembly modules
if [ ! -e "$engine_directory/$mediabunny_path/.git" ]; then
    git -C "$engine_directory" submodule update --init --depth 1 -- "$mediabunny_path" \
        || fail "git submodule update --init $mediabunny_path failed"
fi
mediabunny_arguments=()
if [ "$rebuild_mediabunny" = true ]; then
    mediabunny_arguments+=('--force')
fi
printf 'Building the Mediabunny fork\n'
node "$scripts_path/mediabunny.mjs" ${mediabunny_arguments[@]+"${mediabunny_arguments[@]}"} &
mediabunny_build_process_id=$!

# Decoder packages, which nothing else here reads, so they build in the background, every project's module beside the others.
# make -C wgpud sources fetches the pinned codec source submodules only once
printf 'Building the decoder packages\n'
{ make -C "$(native_path "$engine_directory/$decoders_path")" sources && node "$scripts_path/decoder-packages.mjs"; } &
decoder_build_process_id=$!

# Engine WebAssembly modules, which npm run build copies into the served assets
printf 'Building the engine WebAssembly modules\n'
make -C "$(native_path "$engine_directory/$wasm_path")" -j2 all \
    || fail 'The engine WebAssembly build failed; see docs/src/decoders.md for the toolchain'

# Served assets and pass files, which bundle the Mediabunny fork's build
wait "$mediabunny_build_process_id" || fail 'The Mediabunny fork build failed'
build_arguments=()
if [ "$production" = true ]; then
    build_arguments+=('--production')
fi
node "$scripts_path/build.mjs" ${build_arguments[@]+"${build_arguments[@]}"} || fail 'The asset build failed'

wait "$decoder_build_process_id" \
    || fail 'The decoder package build failed; see docs/src/decoder-packages.md for the toolchain'
printf 'build.sh: done\n'
