# Set up a checkout

## You need

- Node.js 24 and npm 11.
- For the decoders: GNU Make, Git, a POSIX shell (Git Bash on Windows),
  Emscripten 4.0.13, and rustup.
- For the codec vectors: Python 3.10 or later, and the FFmpeg build named in
  [Codec vectors](codec-vectors.md).
- For this book: mdBook 0.5.
- To run the engine: Chrome, Edge, or Firefox with WebGPU and WebCodecs, on a
  secure context (HTTPS or `localhost`). Firefox on Windows decodes HEVC in
  software only; see [Decisions](decisions.md#firefox).
- On Windows, long path support. The decoder build's FFmpeg and cargo trees
  pass 260 characters in a nested checkout. Enable `LongPathsEnabled` and Git's
  `core.longpaths`; GNU Make and the MSVC linker that cargo uses must accept
  long paths too.

## Steps

1. Install the dependencies. In a standalone checkout, run `npm ci` in the
   engine root. When a host lists the engine as an npm workspace, run `npm ci`
   in the host root instead; the engine then has no `node_modules` of its own.
2. Build the decoders, once per checkout and again after a decoder source
   changes:

   ```sh
   make -C wasm sources all
   ```

   Activate Emscripten with `emsdk_env` first, or append
   `EMSDK=/path/to/emsdk`. The build writes `bin/wasm/`, which is ignored. See
   [WebAssembly decoders](decoders.md).
3. Run the checks from the engine root:

   ```sh
   npm run typecheck
   npm run lint
   npm test
   npm run build
   python scripts/generate_all_codec_vector_assets.py --check
   ```

   Inside a host workspace, run the npm scripts from the host root with
   `-w webgpu-player`, for example `npm test -w webgpu-player`.

## What the checks cover

| Command | Covers | Needs `bin/wasm/` |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` | No |
| `npm run lint` | The engine's ESLint config, adapted from Jellyfin Web's | No |
| `npm test` | The Vitest suites (jsdom). Decoder integration tests run the builds in `bin/wasm/` under Node | Yes |
| `npm run build` | The served assets in `bin/libraries/` and `bin/build-info.json`. `npm run build -- --production` minifies the workers | Yes |
| `generate_all_codec_vector_assets.py --check` | Every committed vector in `bin/codec_vector_assets/` matches a fresh run of its generator | No |

A host may lint the engine with its own ESLint config as well; the Jellyfin
add-on does. Engine changes must then pass both configurations.
