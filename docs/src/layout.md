# Repository layout

| Path | Holds |
| --- | --- |
| `src/` | The engine's TypeScript, by domain. See [Module map](module-map.md) |
| `src/EngineAssets.ts` | The typed names of every file the engine fetches at runtime, and their URL resolution |
| `src/EngineConfiguration.ts` | The feature flags a host can set |
| `src/capability/vectors/` | Hand-made vectors: embedded TypeScript vectors, qualification streams fetched at runtime (`qualification/`), and inputs that only tests and generators read (`test/`) |
| `test/` | The Vitest suites, mirroring `src/`, and shared helpers in `test/helpers/` |
| `wasm/` | The decoder sources and build: C bridges and their TypeScript declarations, the `libdovi` crate, license texts, and the Makefile. See [WebAssembly decoders](decoders.md) |
| `vendor/` | The FFmpeg and dcadec submodules, fetched only by `make -C wasm sources` |
| `scripts/` | `build.mjs` (the served assets), `library-assets.mjs` (which file is served from where), and the codec vector generators. See [Codec vectors](codec-vectors.md) |
| `tools/` | Development tooling that never ships, and `constants.json`. See [Tools](tools.md) |
| `docs/` | This book |
| `bin/` | Generated files, all ignored except `bin/codec_vector_assets/`. See below |

`bin/` holds:

- `bin/wasm/`: the decoder builds from `make -C wasm`.
- `bin/libraries/` and `bin/build-info.json`: the served assets from
  `npm run build`.
- `bin/playback_smoke_media/`: local playback media from the smoke media
  generators.
- `bin/codec_vector_assets/`: the generated codec vectors. This is the one
  committed folder, so every change to a vector shows in review.

## Folder names live in one file

`tools/constants.json` names every engine folder. Read a path from it instead
of spelling it out, so moving a folder is a one-line change.

| Reader | Reads it through |
| --- | --- |
| Node scripts, tools, and `eslint.config.mjs` | `tools/constants.mjs` |
| Python tools and `scripts/generate_all_codec_vector_assets.py` | `tools/constants.py` |
| `scripts/codec_vector_assets/` | `engine_layout.py`, which re-exports `tools/constants.py` |
| Tests | `test/helpers/enginePaths.ts` |
| `vitest.config.ts` | A JSON import |
| `wasm/Makefile` | `node -p`, which is why decoder builds need Node.js |
| Hosts | The file itself, at `<engine>/tools/constants.json` |

Some files cannot read it. [Recipes](recipes.md#move-an-engine-folder) lists
them.
