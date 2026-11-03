# Set up a checkout

## You need

- Node.js 24 and npm 11.
- For the engine's WebAssembly modules: GNU Make, Git, a POSIX shell (Git Bash on Windows), rustup, and Emscripten 4.0.13, which the build can install itself with Python 3.
- To build the decoder packages from the `wgpud/` submodule instead of installing their pinned release: also CMake, Perl, and GNU patch (see [WebAssembly build](decoders.md#you-need)).
- For the codec vectors: Python 3.10 or later, and the FFmpeg build named in [Codec vectors](codec-vectors.md).
- To convert mpv shaders: Python 3.10 or later, and naga-cli 30.0.1; see [Migrate an mpv shader to a wgpup](mpv-shaders.md).
- For this book: mdBook 0.5.
- To run the engine: Chrome, Edge, or Firefox with WebGPU and WebCodecs, on a secure context (HTTPS or `localhost`).
  Firefox on Windows has no WebCodecs HEVC, so HEVC plays there only through a GPU decoder package; see [Decisions](decisions.md#firefox).
- On Windows, to build the decoder packages: long path support.
  The decoder projects' FFmpeg and cargo trees pass 260 characters in a nested checkout.
  Enable `LongPathsEnabled` and Git's `core.longpaths`; GNU Make and the MSVC linker that cargo uses must accept long paths too.

## Steps

1. Install the dependencies.
   In a standalone checkout, run `npm ci` in the engine root.
   When a host lists the engine as an npm workspace, run `npm ci` in the host root instead; the engine then has no `node_modules` of its own.
   Inside a host, an `npm install` or `npm ci` run in the engine root resolves to the host's workspace and rewrites its lockfile; pass `--workspaces=false` to install the engine standalone there.
2. Fetch the Mediabunny fork, which the engine demuxes with:

   ```sh
   git submodule update --init --depth 1 vendor/mediabunny
   ```

   Nothing installs it from npm: `tsconfig.json` maps `mediabunny` to the folder, and `node scripts/mediabunny.mjs` builds its `dist/` with the fork's own pinned toolchain.
   The typecheck, test, lint, and build scripts run that step first and skip it while `dist/webgpu-player-build.json` names the checked-out commit; `--force` rebuilds.
   See [Decisions](decisions.md#repository) for why it is a fork, and which pull requests it merges.
3. Fetch the decoder projects and the pass projects, which are repositories of their own checked out at `wgpud/` and `wgpup/`, and install their pinned releases:

   ```sh
   git submodule update --init wgpud wgpup
   npm run pinned-releases
   ```

   The checks need both submodules: `npm test` runs the decoder projects' tests and the pass tests that read `wgpup/`, and the typecheck and lint cover `wgpud/*/test/`.
   `npm run pinned-releases` downloads the decoder packages and pass files that `tools/pinned-releases.json` pins into `bin/wgpud/` and `bin/wgpup/`, checking each file's SHA-256; it needs the network only for files it installs (see [WebAssembly build](decoders.md#pinned-releases)).
   To build them from the submodules instead, run `make -C wgpud sources` and `npm run decoders`, which need the decoder toolchain, and `npm run passes`; the installer keeps such local builds unless you pass `--force`.
4. Build the engine's WebAssembly modules, once per checkout and again after their sources change:

   ```sh
   make -C wasm all
   ```

   Emscripten comes from the emsdk that `EMSDK` names, which `emsdk_env` sets.
   Without `EMSDK`, run `make -C wasm emsdk` first: it installs the pinned Emscripten into the engine's own emsdk in `bin/emsdk/`, about 2 GB, and the Makefiles use that emsdk from then on.
   The build writes `bin/wasm/`, which is ignored.
   See [WebAssembly build](decoders.md).

   `./build.sh` runs every build step: after checking its tools (node, npm, git, make, cargo, and the pinned Emscripten, which it checks through `wasm/Makefile`), it installs the pinned releases with `scripts/pinned-releases.mjs`, then builds the Mediabunny fork, runs `make -C wasm all`, and runs `npm run build`; `--production` minifies the workers.
   It checks every tool before it removes or builds anything, and without `EMSDK` it runs `make -C wasm emsdk` itself when the engine's emsdk is missing or of another version.
   It builds no decoder package; build those from the submodule as step 3 says.
   `./build_clean.sh`, which runs `./build.sh --clean`, first removes `bin/wasm/`, `bin/libraries/`, `bin/build-info.json`, `bin/wgpud/`, `bin/wgpup/`, `bin/installed-releases.json`, the sandbox's Vite build, the WebAssembly build tree, and the libdovi crate target, and rebuilds the Mediabunny fork too; it keeps the submodules, and the decoder projects' build trees belong to `make -C wgpud clean`.
   Run both in Git Bash on Windows.
5. Run the checks from the engine root:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   python scripts/generate_all_codec_vector_assets.py --check
   ```

   With the decoder toolchain, `npm run decoders -- --check` also checks that the `wgpud/` submodule at the pinned commit rebuilds the pinned release byte for byte.
   Inside a host workspace, run the npm scripts from the host root with `-w webgpu-player`, for example `npm test -w webgpu-player`.

## What the checks cover

| Command | Covers | Needs |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `test/`, the decoder projects' tests, and `sandbox/src/` | Nothing built |
| `npm run lint` | The engine's ESLint config, adapted from Jellyfin Web's | Nothing built |
| `npm test` | The Vitest suites (jsdom), the decoder projects' tests in `wgpud/*/test/` included, which load the packages in `bin/wgpud/`, and the pass rules every pass file in `wgpup/` keeps; the audio output stage's tests run its build in `bin/wasm/` | The `wgpud` and `wgpup` submodules, `bin/wasm/`, and `bin/wgpud/` |
| `npm run build` | The served assets in `bin/libraries/` and `bin/build-info.json`. `npm run build -- --production` minifies the workers | `bin/wasm/` |
| `npm run decoders -- --check` | Every decoder project of the submodule rebuilds into the package in `bin/wgpud/`, byte for byte; after an install that is the pinned release, so it checks that the submodule reproduces the release | The decoder toolchain |
| `generate_all_codec_vector_assets.py --check` | Every committed vector in `bin/codec_vector_assets/` and every decoder project's vectors file matches a fresh run of its generator | Nothing built |

A host may lint the engine with its own ESLint config as well; the Jellyfin add-on does.
Engine changes must then pass both configurations.
