# Repository layout

| Path | Holds |
| --- | --- |
| `src/` | The engine's TypeScript, by stage: `demux/`, `decode/`, then `presentation/` and the audio output in `audio/`, beside `capability/`, `color/`, `validation/`, and the orchestration in `pipeline/`. See [Module map](module-map.md) |
| `src/EngineAssets.ts` | The typed names of every file the engine fetches at runtime, and their URL resolution |
| `src/EngineConfiguration.ts` | The feature flags a host can set |
| `src/capability/vectors/` | Hand-made vectors: embedded TypeScript vectors, streams no script generates (`qualification/`), and inputs that only tests and generators read (`test/`) |
| `test/` | The Vitest suites, mirroring `src/`, and shared helpers in `test/helpers/` |
| `sandbox/` | The testing sandbox, a local web app that plays media from a picked folder through the engine: its Vite config, page, and sources in `src/`. See [Sandbox](sandbox.md) |
| `wasm/` | The engine's own WebAssembly modules and their build: the `libdovi` crate, the audio output stage, license texts, and the Makefile. See [WebAssembly build](decoders.md) |
| `wgpud/` | The decoder projects, each of which builds one [decoder package](decoder-packages.md), with its tests in `test/`, and their shared build rules. See [WebAssembly build](decoders.md#decoder-projects) |
| `wgpup/` | The pass projects, whose WGSL pass files a host offers as optional passes, and the license texts of their upstream sources. See [Bundled passes](bundled-passes.md) |
| `vendor/` | The FFmpeg and dcadec submodules, fetched only by `make -C wgpud sources`, and the Mediabunny fork in `vendor/mediabunny/`, which every checkout needs (see [Set up a checkout](setup.md)) |
| `scripts/` | `build.mjs` (the served assets), `library-assets.mjs` (which file is served from where), `decoder-packages.mjs` (the decoder projects' build), and the codec vector generators. See [Codec vectors](codec-vectors.md) |
| `tools/` | Development tooling that never ships, and `constants.json`. See [Tools](tools.md) |
| `docs/` | This book: chapters in `src/`, PlantUML sources in `diagrams/` and their SVGs in `src/diagrams/`, stylesheets, scripts, and the favicon in `theme/`, and the built book in `book/` |
| `images/` | The project logo, `webgpu-player-logo.svg`, the Inkscape source of the favicon |
| `bin/` | Generated files, all ignored except `bin/codec_vector_assets/`. See below |

`bin/` holds:

- `bin/wasm/`: the engine modules' builds from `make -C wasm`.
- `bin/wgpud/`: the decoder packages from `npm run decoders`.
- `bin/libraries/` and `bin/build-info.json`: the served assets from `npm run build`.
- `bin/wgpup/`: the pass files of every pass project, which `npm run build` copies there.
- `bin/playback_smoke_media/`: local playback media from the smoke media generators.
- `bin/plantuml/`: the pinned PlantUML jar that `tools/render-diagrams.mjs` downloads.
- `bin/codec_vector_assets/`: the generated codec vectors.
  This is the one committed folder, so every change to a vector shows in review.

## Folder names live in one file

`tools/constants.json` names every engine folder.
Read a path from it instead of spelling it out, so moving a folder is a one-line change.

| Reader | Reads it through |
| --- | --- |
| Node scripts, tools, and `eslint.config.mjs` | `tools/constants.mjs` |
| Python tools and `scripts/generate_all_codec_vector_assets.py` | `tools/constants.py` |
| `scripts/codec_vector_assets/` | `engine_layout.py`, which re-exports `tools/constants.py` |
| Tests | `test/helpers/enginePaths.ts` |
| `vitest.config.ts` | A JSON import |
| `sandbox/vite.config.ts` and `sandbox/src/main.ts` | A JSON import |
| `wasm/Makefile`, `wgpud/Makefile`, and `wgpud/rules.mk` | `node -p`, which is why WebAssembly builds need Node.js |
| Hosts | The file itself, at `<engine>/tools/constants.json` |

Some files cannot read it.
[Recipes](recipes.md#move-an-engine-folder) lists them.
