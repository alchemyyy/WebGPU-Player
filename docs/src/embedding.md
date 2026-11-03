# Embedding the engine

A host imports the engine's TypeScript, serves its prebuilt workers and WebAssembly modules, and configures it once at startup.
Decoders are not among them: a host hands the engine the [decoder packages](decoder-packages.md) it loads, at runtime.
Read the engine's folders from `tools/constants.json` (`sourceDirectory`, `scriptsDirectory`, `libraryOutputDirectory`, `buildInfoFile`) rather than restating them.

## You need

- The engine as a git submodule of the host.
- The toolchain of the engine's modules from [WebAssembly build](decoders.md#you-need), for the first build of each checkout: Emscripten and rustup.

## Steps

1. Make the sources resolvable.
   Map `webgpu-player/*` to the engine's `src/*` in the host's TypeScript `paths` and in its bundler alias.
   The sources import nothing through the `imports` field of the engine's `package.json`; only the decoder projects' tests do.
2. Install the engine's dependencies.
   Add the engine to the host's npm `workspaces`, so npm installs them, `esbuild` for the asset build included.
   Without a workspace, install the engine's `dependencies` and `esbuild` in the host.
3. Build the engine's modules once per checkout, and again after their sources change: `make -C <engine>/wasm all`.
   The asset build reads them from `<engine>/bin/wasm/` and stops when that folder is missing.
4. Build the served assets before bundling: `node <engine>/scripts/build.mjs`, with `--production` for a production build.
   It bundles the four engine workers with esbuild as classic workers.
   It copies the engine's modules, their licenses, and the native range extension probes' streams into `<engine>/bin/libraries/`.
   It also writes `<engine>/bin/build-info.json`, whose `assetKey` hashes every served file.
5. Serve `<engine>/bin/libraries/` unmodified, and do not minify it again.
   The default asset base is `libraries/` beside the page.
   Workers live in its `webgpu-player/` folder and resolve the other assets relative to their own URL, so keep the layout intact.
6. Configure the engine at startup:

   ```ts
   import { configureEngineAssets } from 'webgpu-player/EngineAssets';
   import { configureEngineFeatureFlags } from 'webgpu-player/EngineConfiguration';
   import 'webgpu-player/style.css';

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
- The range extension probes' streams are served with a `.bin` extension, because some static file servers reject unknown extensions.
  They come from `bin/codec_vector_assets/`.
- The served folder holds each module's license beside it.
  The engine serves no LGPL code; whoever distributes the LGPL decoder packages offers their source (see [WebAssembly build](decoders.md#licenses)).

## Gotchas

- Reload the page fully after deploying a new build.
  Open pages keep their old bundles; engine workers and modules change their `?v=` key with every build.
- A bundler dev server that runs the asset build at configuration load must be restarted after an engine worker changes.
- WebGPU needs a secure context.
  Over plain HTTP on a LAN address, a host that still selects the WebGPU player plays HTML pass-through only, which proves nothing.
- The presenter places its canvas over the surface's video element and fits frames by that element's CSS `object-fit`, so the element needs a layout box.
  Hide it with `visibility: hidden` or cover it, but never with `display: none` or the `hidden` attribute, which leave every frame undrawn as `surface-empty`.
