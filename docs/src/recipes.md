# Recipes

Short procedures for the changes that come up most. Each assumes a checkout set
up as in [Set up a checkout](setup.md).

## Add or change a codec route

1. Capability. Add an exact-output probe to
   `src/capability/CustomDecodeCapabilities.ts`. For an HEVC range extension:
   - add its definition to `src/capability/HEVCRangeExtensionCapabilities.ts`;
   - add its vector to
     `scripts/codec_vector_assets/generate_HEVC_range_extension_vectors.py` and
     generate it into `bin/codec_vector_assets/hevc-range-extension/`;
   - add its served path to `src/EngineAssets.ts`. The asset build serves every
     vector in that folder, and the `EngineAssets` test checks that the two
     agree.
2. Presentation:
   - add the route key to `src/validation/RawHDRPresentationAuthorization.ts`,
     or to the external or Dolby Vision authorization beside it;
   - add the shader to `src/color/ColorPipelineShader.ts`;
   - add the uploads to `src/presentation/RawYUVGPURenderer.ts` and
     `src/video/RawVideoFrameCopy.ts`;
   - add any new raw format to `src/pipeline/DecodeWorkerProtocol.ts`.
3. Runtime. `src/capability/CustomPlaybackEligibility.ts` selects the route, and
   `src/presentation/PresentationInput.ts` parses the color and Dolby Vision
   descriptors.
4. Negotiation. `jellyfin-webgpu-client/src/custom/CustomDeviceProfile.ts`
   (host) turns the evidence into CodecProfile conditions, and
   `jellyfin-webgpu-client/src/WebGPUPlayer.ts` (host) derives the option flags
   and configures the color pipeline. Container pairing stays only in
   `src/capability/CustomContainerCodecSupport.ts`. Add no resolution, level,
   frame rate, or bitrate gate, and no decoder pair blacklist.
5. Tests. Add the row, its expected route, and its fallbacks to
   `jellyfin-webgpu-client.tests/custom/HEVCDirectPlaySupportMatrix.test.ts`
   (host).
6. Update [HEVC and Dolby Vision support](codec-support.md), and
   [Negotiation and routes](negotiation.md) if the route catalog changed.

Check: the engine checks and the host checks from
[The Jellyfin host](jellyfin-host.md#build-and-check).

## Rebuild one decoder

1. Edit the bridge in `wasm/<kit>/`, or move the pinned commit in `vendor/`.
2. Run `make -C wasm <kit>`, with Emscripten active or `EMSDK=` set.
3. Run `npm test`, which exercises the decoders from `bin/wasm/` under Node.
4. Run `make -C wasm check`, which must report every output identical. A
   change that is not reproducible shows up here.

## Change the Dolby Vision parser

1. Edit `wasm/libdovi/src/lib.rs`, or the vendored crate in
   `wasm/libdovi/vendor/dolby_vision/`.
2. For any change to the vendored crate, add an entry to its `PATCHES.md`
   naming the file, the change, and the FFmpeg behavior it follows.
3. If the packed snapshot changes, update
   `src/video/dolby-vision/DolbyVisionRPUDataLayout.ts`, the decoder in
   `DolbyVisionRPUParser.ts`, and its revision prefix together.
4. From `wasm/libdovi/`, run `cargo test --locked` and
   `cargo clippy --locked --all-targets`.
5. Run `make -C wasm libdovi`, then `make -C wasm check KITS=libdovi`.
6. Run `npm test`. The parser tests in `test/video/dolby-vision/` run the
   rebuilt `dovi-rpu-parser.wasm`.

## Revise a committed codec vector

1. For an encoder-dependent vector (JPEG 2000, MPEG-2, the TrueHD sources),
   delete the committed file. A differing encode never replaces one.
2. Run its generator with the pinned FFmpeg on PATH, for example
   `python scripts/codec_vector_assets/generate_mpeg2_capability_vector.py`.
3. Run `python scripts/generate_all_codec_vector_assets.py --check` and the
   generator tests.
4. Review the diff of `bin/codec_vector_assets/`, and update any pinned
   fingerprint or length only after inspecting the decoded output.

## Move an engine folder

1. Change the folder in `tools/constants.json`. Every reader in
   [Repository layout](layout.md#folder-names-live-in-one-file) follows.
2. Edit by hand the files that cannot read it:
   - `.gitignore`, `.gitattributes`, `.gitmodules`, and `tsconfig.json`;
   - `package.json`: its scripts, and its `imports` map, which sends `#wasm/*`
     to `bin/wasm/*` for bundlers and to `wasm/*` for TypeScript, and
     `#codec_vector_assets/*` to the generated modules;
   - this book.
3. Rerun the DTS and TrueHD generators, which embed import paths computed from
   the constants, then run every `--check` and the full engine checks.

## Ship an engine change to the host

1. Commit the change in the engine repository and push it.
2. In the plugin repository, commit the new submodule pointer of
   `jellyfin-webgpu-client/vendor/webgpu-player`.

Push the engine first, so the host never pins a commit nobody can fetch.

## Update this book

See [Maintaining this book](maintaining.md).
