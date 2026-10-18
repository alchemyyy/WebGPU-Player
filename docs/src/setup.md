# Set up a checkout

## You need

- Node.js 24 and npm 11.
- For the WebAssembly: GNU Make, Git, a POSIX shell (Git Bash on Windows), rustup, and Emscripten 4.0.13, which the build can install itself with Python 3.
- For the codec vectors: Python 3.10 or later, and the FFmpeg build named in [Codec vectors](codec-vectors.md).
- To convert mpv shaders: Python 3.10 or later, and naga-cli 30.0.1; see [Migrate an mpv shader to a wgpup](mpv-shaders.md).
- For this book: mdBook 0.5.
- To run the engine: Chrome, Edge, or Firefox with WebGPU and WebCodecs, on a secure context (HTTPS or `localhost`).
  Firefox on Windows has no WebCodecs HEVC, so HEVC plays there only through a GPU decoder package; see [Decisions](decisions.md#firefox).
- On Windows, long path support.
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
3. Build the engine's WebAssembly modules, and the decoder projects' packages, once per checkout and again after their sources change:

   ```sh
   make -C wasm all
   make -C wgpud sources
   npm run decoders
   ```

   Emscripten comes from the emsdk that `EMSDK` names, which `emsdk_env` sets.
   Without `EMSDK`, run `make -C wasm emsdk` first: it installs the pinned Emscripten into the engine's own emsdk in `bin/emsdk/`, about 2 GB, and the Makefiles use that emsdk from then on.
   The builds write `bin/wasm/` and `bin/wgpud/`, which are ignored; `make -C wgpud sources` fetches the pinned FFmpeg and dcadec only once.
   See [WebAssembly build](decoders.md).
4. Run the checks from the engine root:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   npm run decoders -- --check
   python scripts/generate_all_codec_vector_assets.py --check
   ```

   Inside a host workspace, run the npm scripts from the host root with `-w webgpu-player`, for example `npm test -w webgpu-player`.

## What the checks cover

| Command | Covers | Needs |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `test/`, the decoder projects' tests, and `sandbox/src/` | Nothing built |
| `npm run lint` | The engine's ESLint config, adapted from Jellyfin Web's | Nothing built |
| `npm test` | The Vitest suites (jsdom), the decoder projects' tests in `wgpud/*/test/` included, which load the packages in `bin/wgpud/`, and the pass rules every pass file in `wgpup/` keeps; the audio output stage's tests run its build in `bin/wasm/` | `bin/wasm/` and `bin/wgpud/` |
| `npm run build` | The served assets in `bin/libraries/` and `bin/build-info.json`, and the pass files in `bin/wgpup/`. `npm run build -- --production` minifies the workers | `bin/wasm/` |
| `npm run decoders -- --check` | Every decoder project rebuilds into the package in `bin/wgpud/`, byte for byte | The decoder toolchain |
| `generate_all_codec_vector_assets.py --check` | Every committed vector in `bin/codec_vector_assets/` and every decoder project's vectors file matches a fresh run of its generator | Nothing built |

A host may lint the engine with its own ESLint config as well; the Jellyfin add-on does.
Engine changes must then pass both configurations.
