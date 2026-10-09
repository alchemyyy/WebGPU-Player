# Embedding the engine

A host imports the engine's TypeScript, serves its prebuilt workers and decoders, and configures it once at startup.
Read the engine's folders from `tools/constants.json` (`sourceDirectory`, `scriptsDirectory`, `libraryOutputDirectory`, `buildInfoFile`) rather than restating them.

## You need

- The engine as a git submodule of the host.
- A bundler that reads a package's `imports` field: webpack 5, Vite, and esbuild do, without configuration.
- The decoder toolchain from [Set up a checkout](setup.md), for the first build of each checkout.

## Steps

1. Make the sources resolvable.
   Map `webgpu-player/*` to the engine's `src/*` in the host's TypeScript `paths` and in its bundler alias.
2. Resolve the engine's own imports.
   The engine imports its decoder builds as `#wasm/*` and two generated vector modules as `#codec_vector_assets/*`, through the `imports` field of its `package.json`:
   - `#wasm/*` points TypeScript (the `types` condition) at the declarations in `wasm/*`, so type checks need no decoder build, and points bundlers at the builds in `bin/wasm/*`.
   - `#codec_vector_assets/*` points at `bin/codec_vector_assets/*.ts`.

   TypeScript reads that field under `bundler`, `node16`, or `nodenext` module resolution.
   A host on `node` resolution must map each entry in `paths`, using the `types` target where there is one: `#wasm/*` to `<engine>/wasm/*`, and `#codec_vector_assets/*` to `<engine>/bin/codec_vector_assets/*.ts`.
   The host's TypeScript loader must transpile `bin/codec_vector_assets/` as well as `src/`.
3. Install the engine's dependencies.
   Add the engine to the host's npm `workspaces`, so npm installs them, `esbuild` for the asset build included.
   Without a workspace, install the engine's `dependencies` and `esbuild` in the host.
4. Build the decoders once per checkout, and again after a decoder source changes: `make -C <engine>/wasm sources all`.
   The asset build and the decoder tests read them from `<engine>/bin/wasm/`, and the asset build stops when that folder is missing.
5. Build the served assets before bundling: `node <engine>/scripts/build.mjs`, with `--production` for a production build.
   It bundles the six engine workers with esbuild as classic workers, because the decoder glue loads through `importScripts`.
   It copies the decoders, their licenses, and the qualification streams into `<engine>/bin/libraries/`.
   It also writes `<engine>/bin/build-info.json`, whose `assetKey` hashes every served file.
6. Serve `<engine>/bin/libraries/` unmodified, and do not minify it again.
   The default asset base is `libraries/` beside the page.
   Workers live in its `webgpu-player/` folder and resolve the other assets relative to their own URL, so keep the layout intact.
7. Configure the engine at startup:

   ```ts
   import { configureEngineAssets } from 'webgpu-player/EngineAssets';
   import { configureEngineFeatureFlags } from 'webgpu-player/EngineConfiguration';
   import 'webgpu-player/style.scss';

   // assetKey comes from <engine>/bin/build-info.json, written by the asset build
   configureEngineAssets({ cacheKey: assetKey });
   configureEngineFeatureFlags({ isHDRToneMappingEnabled: () => Promise.resolve(true) });
   ```

   Pass `baseURL` to serve the assets from somewhere other than `libraries/`.

## How assets are named and served

- `src/EngineAssets.ts` names every runtime asset, `scripts/library-assets.mjs` maps each served file to its source, and the `EngineAssets` test keeps the two in agreement.
  `scripts/build.mjs` fails when an asset it maps is missing, which also stops a host build that runs it.
- Asset URLs are stable.
  The cache key is appended as `?v=`, so a browser never mixes files from two builds.
- Engine workers are served at `libraries/webgpu-player/<Name>.worker.js`, not as host bundler chunks.
- Qualification streams are served with a `.bin` extension, because Jellyfin's static file provider rejects unknown extensions.
  The generated ones come from `bin/codec_vector_assets/`, the hand-made ones from `src/capability/vectors/qualification/`.
- The served folder holds each decoder's license beside it.
  The LGPL decoders' corresponding source is published with each release; see [WebAssembly decoders](decoders.md#licenses).

## Gotchas

- Reload the page fully after deploying a new build.
  Open pages keep their old bundles; engine workers and decoders change their `?v=` key with every build.
- A bundler dev server that runs the asset build at configuration load must be restarted after an engine worker changes.
- WebGPU needs a secure context.
  Over plain HTTP on a LAN address, a host that still selects the WebGPU player plays HTML pass-through only, which proves nothing.
