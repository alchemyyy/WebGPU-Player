# WebGPU Player

A WebGPU and WebCodecs media playback engine for the browser. It plays formats
that browsers cannot play natively:

- **Demux:** [Mediabunny](https://github.com/Vanilagy/mediabunny), in a worker.
- **Decode:** WebCodecs, or bundled WebAssembly decoders built from FFmpeg,
  libdcadec, hevc.js, and OpenJPEG.
- **Present:** WebGPU, including HDR10, HDR10+, HLG, and Dolby Vision profiles
  5, 7, and 8 tone mapping.
- **Audio:** an AudioWorklet output with a client-owned clock.

Every route is qualified in the running browser, by decoding a known stream and
checking the exact output, before a host may advertise it.

The engine is host-agnostic.
[Jellyfin Web with WebGPU Player](https://github.com/alchemyyy/jellyfin-web)
embeds it as a git submodule. That fork adds the Jellyfin integration: the
player plugin, device profile, settings UI, and same-session HTML fallback.

## Requirements

- **Browser:** Chrome or Edge with WebGPU and WebCodecs.
- **Secure context:** HTTPS or `localhost`.
- **Development:** Node.js 24 and npm 11.

## Layout

| Path | Contents |
| --- | --- |
| `.agents/` | Project map for contributors and coding agents: architecture, negotiation, codec support, module map, host integration, and settled decisions. Start with [.agents/README.md](.agents/README.md) |
| `src/` | Engine TypeScript: presenter and color pipeline, the custom decode pipeline in `custom/`, and presentation validation in `validation/` |
| `src/EngineAssets.ts` | Typed names of every file the engine fetches at runtime, and their URL resolution |
| `src/EngineConfiguration.ts` | Feature flags a host can set |
| `test/` | Vitest suites. Decoder integration tests run the committed WebAssembly in Node |
| `codecs/` | C bridges, the libdovi crate, licenses, the codec Makefile, and the committed build outputs in `codecs/dist/`. See [codecs/README.md](codecs/README.md) |
| `fixtures/capability/` | Qualification streams that browsers fetch at runtime |
| `fixtures/test/` | Inputs used only by tests |
| `scripts/` | `build.mjs` assembles `dist/libraries/`. `library-assets.mjs` maps every served file to its source |
| `tools/` | Development and validation tooling, never shipped. See [tools/README.md](tools/README.md) |

## Embedding the engine

1. **Make the sources resolvable.** Add this repository as a git submodule.
   Then map `webgpu-player/*` to its `src/*`:
   - in the host's TypeScript `paths`;
   - in the host's bundler alias.

   Install the engine's `dependencies` in the host, plus `esbuild` for the
   asset build.
2. **Build the served assets** before bundling, with
   `node <engine>/scripts/build.mjs [--production]`:
   - It bundles the workers with esbuild and copies decoders, licenses, and
     qualification streams into `<engine>/dist/libraries/`.
   - Serve that directory unmodified, and do not minify it again.
   - The default asset base is `libraries/` beside the page.
   - Workers live in its `webgpu-player/` subdirectory and resolve the other
     assets relative to their own URL, so keep the layout intact.
3. **Configure the engine at startup:**

   ```ts
   import { configureEngineAssets } from 'webgpu-player/EngineAssets';
   import { configureEngineFeatureFlags } from 'webgpu-player/EngineConfiguration';
   import 'webgpu-player/style.scss';

   // assetKey comes from <engine>/dist/build-info.json, written by the asset build
   configureEngineAssets({ cacheKey: assetKey });
   configureEngineFeatureFlags({ isHDRToneMappingEnabled: () => Promise.resolve(true) });
   ```

   The asset URLs are stable. The cache key, a hash of every served file, is
   appended as `?v=` so a browser never mixes files from two builds. Pass
   `baseURL` to serve the assets from somewhere else.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

When the engine is checked out as a submodule, its tests can also run from the
host's root against the host's `node_modules`:
`npx vitest run --root webgpu-player`. The host's ESLint configuration lints
`src/` and `test/` too, so changes must pass both configurations.

The codec builds are committed, so nothing above needs Emscripten. Rebuilding a
decoder needs Emscripten 4.0.13, GNU Make, and cargo, without Docker. See
[codecs/README.md](codecs/README.md).

## Credits

- [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) demuxes media
  and remuxes audio to fragmented MP4 for native playback. Its
  [`@mediabunny/ac3`](https://www.npmjs.com/package/@mediabunny/ac3) extension
  supplies the AC-3 decoder.
- [FFmpeg](https://ffmpeg.org/) (LGPL-2.1-or-later) supplies the E-AC-3,
  TrueHD/MLP, MPEG-2 Video, and VC-1 decoders, compiled to WebAssembly from a
  pinned revision.
- [libdcadec](https://github.com/foo86/dcadec) (LGPL-2.1-or-later) supplies
  the DTS decoder, including DTS-HD MA.
- [hevc.js](https://github.com/privaloops/hevc.js) (MIT) supplies the software
  HEVC decoder.
- [OpenJPEG](https://www.openjpeg.org/) (BSD-2-Clause), through
  `@cornerstonejs/codec-openjpeg` (MIT), supplies the JPEG 2000 decoder.
- The `dolby_vision` crate from
  [dovi_tool](https://github.com/quietvoid/dovi_tool) (MIT) parses Dolby Vision
  RPUs.

## License

The engine's own code is MIT; see [LICENSE](LICENSE). Bundled third-party
decoders keep their own licenses, and the license texts ship beside each
decoder in `dist/libraries/`. The corresponding source for the LGPL decoders is
published with each release; see [codecs/README.md](codecs/README.md).
