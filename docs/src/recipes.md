# Recipes

Short procedures for the changes that come up most.
Each assumes a checkout set up as in [Set up a checkout](setup.md).

## Add or change a codec route

1. Capability.
   Add an exact-output probe to `src/capability/CustomDecodeCapabilities.ts`.
   Give a video probe an identifier in `CustomDecodeVideoProbe` and `CUSTOM_DECODE_VIDEO_PROBES`, and select it in `selectItemVideoProbes` for the streams that need it, or no item runs it.
   For an HEVC range extension:
   - add its definition to `src/capability/HEVCRangeExtensionCapabilities.ts`;
   - add its vector to `scripts/codec_vector_assets/generate_HEVC_range_extension_vectors.py` and generate it into `bin/codec_vector_assets/hevc-range-extension/`;
   - add its served path to `src/EngineAssets.ts`.
     The asset build serves every vector in that folder, and the `EngineAssets` test checks that the two agree.
2. Presentation:
   - add the route key to `src/validation/RawHDRPresentationAuthorization.ts`, or to the external or Dolby Vision authorization beside it;
   - add the route's built-in signal to `src/presentation/passes/builtin/BuiltinSignals.ts` and its chain to `BuiltinChains.ts`;
   - add the plane uploads to `src/presentation/passes/PlaneTextureSource.ts`, and the raw copy to `src/decode/video/RawVideoFrameCopy.ts`;
   - add any new raw format to `src/pipeline/DecodeWorkerProtocol.ts`.
3. Runtime.
   `src/capability/CustomPlaybackEligibility.ts` selects the route, and `src/presentation/PresentationInput.ts` parses the color and Dolby Vision descriptors.
4. Container pairing stays only in `src/capability/CustomContainerCodecSupport.ts`.
   Add no resolution, level, frame rate, or bitrate gate, and no decoder pair blacklist.
5. Tests.
   Cover the route's selection and fallbacks in `test/capability/CustomPlaybackEligibility.test.ts`.
6. Update [HEVC and Dolby Vision support](codec-support.md), and [Eligibility and routes](routes.md) if the route catalog changed.
7. Advertise the route in the host.
   The Jellyfin plugin's book has the recipe for its device profile and its support matrix tests.

Check: the engine checks from [Set up a checkout](setup.md), and the host's checks.

## Add a codec that only a package decodes

1. Name it as FFmpeg does, in `CUSTOM_VIDEO_CODECS` and `CUSTOM_PACKAGE_VIDEO_CODECS` or in the audio codec lists, where its capability reads `no-engine-decoder`.
   Map the names a media server reports for it in both name tables, in `src/capability/CustomPlaybackEligibility.ts` and `CustomDecodeCapabilities.ts`, and give it a case in every switch the type checker names.
2. Pair it with its containers in `src/capability/CustomContainerCodecSupport.ts`.
3. For video, give the worker its frame-pool route in `src/pipeline/CustomDecode.worker.ts`: the container codec IDs it reads, and the codec private data and packets a package receives, with any container reader under `src/demux/`.
   Describe that codec private data in [Decoder packages](decoder-packages.md), since every package of the codec depends on it.
4. Build a decoder project for it in `wgpud/<project>/`, as the next recipe says, whose header accepts the codec's name.
5. Cover the eligibility, the container reach, and the worker's route in `test/`, and the project in its own `test/`.

## Change or add a decoder project

1. Edit, or create, `wgpud/<project>/`: its `decoder.json`, its decoder source, whose header declares the project's name as its `id:`, and, for a module, a `Makefile` that includes `../rules.mk` and builds `module`.
   List its self-test vectors in `decoder.json`, one per output format at most, and run `python scripts/codec_vector_assets/generate_decoder_package_vectors.py` to write its vectors file.
2. Run `npm run decoders -- <project>`, with Emscripten active or `EMSDK=` set for a C module.
3. Run its tests, `npx vitest --watch=false wgpud/<project>`, which load the package from `bin/wgpud/`.
4. Run `npm run decoders -- --check`, which must report every package identical.
   A change that is not reproducible shows up here.
5. Update the project table in [WebAssembly build](decoders.md#decoder-projects).

## Change or add a pass project

1. Edit, or create, `wgpup/<project>/` with its pass files: WGSL files at the project's top level, each of one or more passes in the pass header format, under a file name no other project uses.
   A generated pass keeps its generator and inputs in the project and is committed, so a build needs no generator.
2. Run `npx vitest --watch=false test/presentation/passes`, whose pass rules every pass file must keep.
3. Run `npm run build`, which copies the pass files into `bin/wgpup/`, and pick the pass in the sandbox's shader panel to see it.
4. Update the project table in [Bundled passes](bundled-passes.md).

## Rebuild one engine module

1. Edit `wasm/<kit>/`, `libdovi` or `audio-output-stage`.
2. Run `make -C wasm <kit>`, with Emscripten active or `EMSDK=` set.
3. Run `npm test`.
4. Run `make -C wasm check`, which must report every output identical.

## Change the Dolby Vision parser

1. Edit `wasm/libdovi/src/lib.rs`, or the vendored crate in `wasm/libdovi/vendor/dolby_vision/`.
2. For any change to the vendored crate, add an entry to its `PATCHES.md` naming the file, the change, and the FFmpeg behavior it follows.
3. If the packed snapshot changes, update `src/demux/dolby-vision/DolbyVisionRPUDataLayout.ts`, the decoder in `DolbyVisionRPUParser.ts`, the reshaping in `src/color/DolbyVisionColorTransform.ts`, and the schema version in `lib.rs` and `DolbyVisionRPUParser.ts` together.
   The revision prefix names the vendored dovi_tool commit and changes only when the copy moves to another upstream revision.
4. From `wasm/libdovi/`, run `cargo test --locked` and `cargo clippy --locked --all-targets`.
5. Run `make -C wasm libdovi`, then `make -C wasm check KITS=libdovi`.
6. Run `npm test`.
   The parser tests in `test/demux/dolby-vision/` run the rebuilt `dovi-rpu-parser.wasm`.

## Revise a committed codec vector

1. For an encoder-dependent vector (the TrueHD sources, the JPEG 2000 decoder vectors), delete the committed file.
   A differing encode never replaces one.
2. Run its generator with the pinned FFmpeg on PATH, for example `python scripts/codec_vector_assets/generate_truehd_capability_vectors.py --regenerate-sources`.
   A stream a decoder project's `decoder.json` lists also needs `python scripts/codec_vector_assets/generate_decoder_package_vectors.py <project>`, which rewrites that project's self-test vectors.
3. Run `python scripts/generate_all_codec_vector_assets.py --check` and the generator tests.
4. Review the diff of `bin/codec_vector_assets/` and `wgpud/`, and update any pinned fingerprint or length only after inspecting the decoded output.

## Move an engine folder

1. Change the folder in `tools/constants.json`.
   Every reader in [Repository layout](layout.md#folder-names-live-in-one-file) follows.
2. Edit by hand the files that cannot read it:
   - `.gitignore`, `.gitattributes`, `.gitmodules`, and `tsconfig.json`;
   - `package.json`: its scripts, and its `imports` map, which sends `#codec_vector_assets/*` to the generated modules;
   - each decoder project's `decoder.json`, whose vectors name a layout key and a path under it;
   - this book.
3. Rerun the DTS and TrueHD generators, which embed import paths computed from the constants, then run every `--check` and the full engine checks.

## Capture a timing trace

1. Call `startTimingTrace()` from `webgpu-player/TimingTrace` before the play request, so the decode run the play starts is asked for its events.
   A run started before the trace sends none; the next seek's run does.
2. Play the passage under investigation.
3. Call `exportTimingTrace(metadata)` and save the result as JSON.
   `stopTimingTrace()` stops recording but keeps the events exportable until the next start or `clearTimingTrace()`.
4. Read the events in time order.
   `timeMilliseconds` counts from the trace start, `realm` says whether the page or the decode worker recorded it, and `droppedEventCount` is nonzero when the ring buffer overwrote the oldest events.

## Ship an engine change to the host

Commit the change in the engine repository and push it before the host commits the new submodule pointer, so the host never pins a commit nobody can fetch.

## Update this book

See [Maintaining this book](maintaining.md).
