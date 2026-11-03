#!/usr/bin/env bash
# Builds every engine output: the Mediabunny fork, the WebAssembly modules, and the served assets, beside the pinned
# releases of the decoder packages and the pass files.
#
# Checks the tools, the pinned Emscripten, and the npm dependencies before it removes or builds anything.
# Without EMSDK, and without the engine's own emsdk at the pinned version, it installs that emsdk with make -C wasm emsdk.
# With --clean, which build_clean.sh passes, it then removes every build tree and build output.
# Then it installs the pinned decoder packages and pass files into bin/wgpud/ and bin/wgpup/ with
# scripts/pinned-releases.mjs, which keeps the files already there: the pinned ones, and local builds.
# Fetches the Mediabunny fork submodule when it is missing, and builds the fork in the background with
# scripts/mediabunny.mjs, which skips it while its build is of the checked-out commit, while make -C wasm all builds the
# engine's WebAssembly modules; then `npm run build` assembles bin/libraries/ once the fork is built.
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
    installedReleasesFile
    sandboxOutputDirectory
)
# The cargo target folder a direct cargo run in the libdovi crate leaves, relative to the wasm directory
readonly libdovi_crate_target='libdovi/target'

clean=false
production=false
rebuild_mediabunny=false

print_usage() {
    cat <<'USAGE'
Usage: ./build.sh [options]

Installs the pinned decoder packages into bin/wgpud/ and pass files into bin/wgpup/, and builds the Mediabunny fork,
the WebAssembly modules into bin/wasm/, and the served assets into bin/libraries/ and bin/build-info.json.

Options:
  --clean                Remove every build tree and build output first, the installed releases included, and rebuild
                         the Mediabunny fork too. Keeps bin/codec_vector_assets/, bin/playback_smoke_media/,
                         bin/plantuml/, bin/emsdk/, the submodules, and node_modules. ./build_clean.sh runs
                         ./build.sh --clean.
  --production           Minify the workers, as npm run build -- --production does.
  --rebuild-mediabunny   Rebuild the Mediabunny fork even when its build is of the checked-out commit.
  -h, --help             Show this help.

The builds need GNU Make, rustup, and the pinned Emscripten; see docs/src/setup.md and docs/src/decoders.md. They are
checked before anything is removed or built.
Emscripten comes from the emsdk that EMSDK names, as emsdk_env sets it. Without EMSDK, the build installs the pinned
version into the engine's own emsdk in bin/emsdk/ once, about 2 GB with Python 3 to run the installer, and the
Makefiles use it from then on.
tools/pinned-releases.json pins the decoder package and pass file releases, which download from GitHub when a pinned
file is missing. Files already in place stay: the pinned ones, and the local builds of npm run decoders and
npm run passes; node scripts/pinned-releases.mjs --force installs the pinned files over local builds.

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

# Runs the Emscripten check the WebAssembly Makefile pins; a failed check prints the version it needs
check_emscripten() {
    make --no-print-directory -C "$(native_path "$engine_directory/$wasm_path")" toolchain
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

# Every tool the builds run by name, checked before anything is removed or built; make reads CARGO as an override
for required_command in node npm git make "${CARGO:-cargo}"; do
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

# Clean build: every build tree and output goes, so each step below rebuilds or reinstalls it
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
    rebuild_mediabunny=true
fi

# Decoder packages and pass files, which no build here reads: the pinned releases, unless they or local builds are in place
printf 'Installing the pinned decoder package and pass file releases\n'
node "$scripts_path/pinned-releases.mjs" \
    || fail 'The pinned releases did not install; see docs/src/setup.md'

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

# Engine WebAssembly modules, which npm run build copies into the served assets
printf 'Building the engine WebAssembly modules\n'
make -C "$(native_path "$engine_directory/$wasm_path")" -j2 all \
    || fail 'The engine WebAssembly build failed; see docs/src/decoders.md for the toolchain'

# Served assets, which bundle the Mediabunny fork's build
wait "$mediabunny_build_process_id" || fail 'The Mediabunny fork build failed'
build_arguments=()
if [ "$production" = true ]; then
    build_arguments+=('--production')
fi
node "$scripts_path/build.mjs" ${build_arguments[@]+"${build_arguments[@]}"} || fail 'The asset build failed'
printf 'build.sh: done\n'
