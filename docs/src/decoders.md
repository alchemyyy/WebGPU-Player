# WebAssembly build

The repository holds two kinds of WebAssembly.
`wasm/` holds the engine's own modules: the Dolby Vision RPU parser and the decoded audio output stage.
`wgpud/` holds the decoder projects, each of which builds one [decoder package](decoder-packages.md); its name marks them as this player's own module type, as `wgpup/` marks the [bundled passes](bundled-passes.md).
The engine never loads a decoder project's output by itself: a host supplies packages at runtime, and the engine names no project.
Both builds write into `bin/`, which is ignored like everything in `bin/` but `bin/codec_vector_assets/`.

## You need

- GNU Make, Git, and a POSIX shell (Git Bash on Windows).
  No container is involved.
- Node.js: the Makefiles read the engine's folders from `tools/constants.json`.
- Emscripten 4.0.13 (revision `2659582941bef14008476903f48941909db1b196`), from the emsdk that `EMSDK` names, which `emsdk_env` sets.
  Without `EMSDK`, the Makefiles use the engine's own emsdk in `bin/emsdk/`, and with neither, `emcc` from `PATH`.
  `make -C wasm emsdk` installs the engine's emsdk: a clone of emsdk at the release tag of the pinned version, replaced when the pin moves, whose installer needs Python 3.
  The audio output stage and the C decoder projects need it.
- rustup, for `libdovi` and the Rust decoder projects.
  Their `rust-toolchain.toml` files select the same Rust, 1.96.1, with the `wasm32-unknown-unknown` target.

## The engine's modules

| Kit | Output in `bin/wasm/<kit>/` | Library and license | Our source (MIT) |
| --- | --- | --- | --- |
| `libdovi` | `dovi-rpu-parser.wasm` | The `dolby_vision` crate from [dovi_tool](https://github.com/quietvoid/dovi_tool), vendored and patched, MIT | `libdovi/` |
| `audio-output-stage` | `audio-output-stage.wasm` | None: the engine's resampler and limiter kernels | `audio-output-stage/audio_output_stage.c` |

Each is served from `libraries/<kit>/` and has no JavaScript glue: the engine instantiates each `.wasm` itself.
The playback worker makes one instance of `libdovi` when its first parser needs it (`demux/dolby-vision/WorkerWASMInstanceCache.ts`), and every later parser creates its own native context in that instance.
The audio decode worker instantiates `audio-output-stage` once, when its first decoded audio attempt starts.

Run from the engine root:

```sh
make -C wasm emsdk                # Install the pinned Emscripten into bin/emsdk, once
make -C wasm all                  # Build both modules into bin/wasm
make -C wasm check                # Rebuild both and compare them with bin/wasm
make -C wasm audio-output-stage   # Rebuild one kit
make -C wasm clean
```

The build sets `SOURCE_DATE_EPOCH`, the locale, the time zone, and the Python hash seed, ignores compiler variables from the calling environment, and refuses any Emscripten other than 4.0.13.
Panics embed source paths, so the `libdovi` build maps the cargo home, crate, and target directories to fixed names.
With the `rust-src` component installed, rustc rewrites the standard library's `/rustc/<commit>` paths to the toolchain's local copy, so the build maps that copy back too.
`make check` rebuilds both modules and compares them byte for byte with the existing `bin/wasm/`; copy another machine's `bin/wasm/` in first to check that two machines build the same bytes.

### The Dolby Vision parser crate

`wasm/libdovi/` is our crate.
`src/lib.rs` wraps the `dolby_vision` crate and packs each RPU into the fixed snapshot layout the engine reads (`demux/dolby-vision/DolbyVisionRPUDataLayout.ts`, schema 2).
It has two entry points over one parser state: `dovi_parser_parse` reads an HEVC RPU NAL unit (type 62), and `dovi_parser_parse_av1_t35` reads an AV1 ITU-T T.35 metadata message, from the country code to the end of its OBU payload.
`dovi_parser_set_container_profile` gives the state the RPU profile the container declares, which an RPU whose header reveals none takes.
The playback worker loads `dovi-rpu-parser.wasm` only for an owned HEVC or AV1 attempt on a Dolby Vision route; any other route removes the RPUs without parsing them.

The `dolby_vision` crate is not fetched from GitHub.
It is copied from dovi_tool rev `38adec0` into `wasm/libdovi/vendor/dolby_vision/` and built as a path dependency, because the parser follows FFmpeg's `libavcodec/dovi_rpudec.c` where upstream is stricter.
`vendor/dolby_vision/PATCHES.md` lists every deviation from upstream; update it with any change to the copy.
The [Recipes](recipes.md#change-the-dolby-vision-parser) cover a change.

From `wasm/libdovi/`:

```sh
cargo test --locked
cargo clippy --locked --all-targets
```

### The audio output stage

`wasm/audio-output-stage/audio_output_stage.c` holds the decoded audio output stage's two kernels: the resampler's source history and windowed-sinc rendering, and the lookahead limiter's history, attack envelope, and gain.
Timeline reconciliation, timestamps, output chunking, and the downmix stay in TypeScript, in `audio/processing/`.
Each kernel keeps its history in a ring, so a push copies only its own frames, and its SIMD (simd128) vectors hold channel pairs or neighboring frames, never neighboring taps.
The kernels produce the same bytes as `StreamingAudioResampler` and `StreamingAudioLookaheadLimiter`, which stay as the reference and the fallback (see [Decisions](decisions.md#audio)).
Three rules keep them exact:

- `-ffp-contract=off`, so no multiply and add fuse.
- The filter table is built in JavaScript and copied in, because V8's `Math.sin` and `Math.cos` need not match a C library's.
- The limiter's constants from `Math.pow` and `Math.exp` arrive as numbers, and its attack length reads the engine's `Math.log10` through the module's one import, `math.log10`.

The kit links with `-sSTANDALONE_WASM` and emcc's own `--no-entry`, so it has no JavaScript glue.
It is a WASI reactor: `_initialize` runs the constructors that set up emmalloc's heap, before any other export.
It defines `emscripten_notify_memory_growth` itself, so `math.log10` is its only import.
`audio/processing/AudioOutputStageModule.ts` instantiates it, refuses a module whose `audio_output_stage_abi_version` differs from its own, and wraps each kernel; raise the version with any change to an export's meaning.

After a change, rebuild the kit and run the equivalence suite, which compares both implementations byte for byte, from the engine root:

```sh
make -C wasm audio-output-stage
npx vitest --watch=false test/audio/processing/AudioOutputStageModule.integration.test.ts
```

## Decoder projects

A decoder project is a folder of `wgpud/` with a `decoder.json`.
It is a minimal project that builds one package and runs nowhere on its own.

| Project | Decodes | Module | Self-test vectors | Library and license |
| --- | --- | --- | --- | --- |
| `av1` | AV1 Main, High, and Professional at 8 to 12 bits, 4:0:0 to 4:4:4, on the GPU | libaom's decoder, running its parse-only pass, and the C bridge in `parser/` | One stream per output format in `vectors/`, from FFmpeg's libaom encoder | [libaom](https://aomedia.googlesource.com/aom), BSD-2-Clause with the Alliance for Open Media patent license |
| `hevc` | HEVC Main, Main 10, and the range extensions, on the GPU | The Rust parser in `parser/` | The nine HEVC range extension vectors | None, MIT |
| `jpeg2000` | JPEG 2000 YUV pictures at 4:2:0, 4:2:2, and 4:4:4, 8 to 12 bits, on the GPU | The Rust parser in `parser/` | One stream per output format in `vectors/`, from FFmpeg's and OpenJPEG's encoders | None, MIT |
| `mpeg2` | MPEG-1 and MPEG-2 Video at 4:2:0, 4:2:2, and 4:4:4, on the GPU | The Rust parser in `parser/`, which reads sequence headers | One stream per chroma format in `vectors/`, from its own syntax exerciser | None, MIT |
| `mpeg4` | MPEG-4 Part 2, H.263, and MS-MPEG4 versions 1 to 3 at 8-bit 4:2:0, on the GPU | The Rust parser in `parser/` | One Xvid stream with GMC, quarter-sample motion, and B-VOPs in `vectors/`, beside the media of every codec and container its routes take | None, MIT |
| `vc1` | VC-1 Advanced and WMV3 (Simple, Main, and Complex), on the GPU | The Rust parser in `parser/` | The VC-1 Advanced stream in `src/capability/vectors/qualification/vc1/` | None, MIT |
| `uncompressed` | Uncompressed planar packets, on the GPU | None | None | None, MIT; the template of a WGSL-only decoder |
| `eac3` | AC-3 and E-AC-3, and the Dolby Atmos objects of E-AC-3 with joint object coding | FFmpeg's AC-3 and E-AC-3 decoders, our JOC decoder, and the shared object renderer in `wgpud/atmos/` | None; its tests decode the media in `vectors/`, two to FFmpeg's known answers | FFmpeg, LGPL-2.1-or-later; our JOC decoder, MIT |
| `truehd` | MLP and TrueHD, and the objects of TrueHD Dolby Atmos | FFmpeg's MLP and TrueHD decoders, our decoder of the 16-channel presentation, and the object renderer in `wgpud/atmos/` | None; its tests decode the Atmos streams in `vectors/` | FFmpeg, LGPL-2.1-or-later, which `truehd_presentation.c`, a port of FFmpeg's MLP decoder, is too |
| `wma` | WMA 1, WMA 2, WMA Pro, WMA Lossless, and WMA Voice | FFmpeg's `wmav1`, `wmav2`, `wmapro`, `wmalossless`, and `wmavoice` decoders | None; its tests decode the media in `vectors/` to FFmpeg's known answers | FFmpeg, LGPL-2.1-or-later |
| `dts` | DTS core, DTS-HD High Resolution, and DTS-HD Master Audio | libdcadec | None | [dcadec](https://github.com/foo86/dcadec), LGPL-2.1-or-later |

`decoder.json` names the project's decoder source, the WGSL file or audio manifest the package carries, under `decoder`.
Each project's header declares the project's name as its package id, such as `//! id: hevc`, so a rebuilt package replaces the one a host stored before.
A WGSL decoder may name a list of files instead, which the build joins in order into the one source the package carries: each later file follows a `// Decoder source: <file>` line, so a compile message leads back to its file, and only the first file may hold header lines.
A video project lists its self-test vectors under `vectors`, each with its output `format`, the layout key of its `root` folder in `tools/constants.json`, its `path` there, optionally the FFmpeg `decoderOptions` of the reference decode, and optionally `codecPrivate`, the layout of the codec private data the vector passes the decoder.
That is the stream's extradata, or with `bitmap-info-header` a 40-byte BITMAPINFOHEADER of the stream's size and FourCC before it, as the engine passes the `mpeg4` package (see [Codec private data](decoder-packages.md#codec-private-data)).
A project with a `Makefile` builds its module with `make module`, which writes `wgpud/build/<project>/module.wasm`; a project without one packs an empty module, as a decoder without a parser does.
Each `Makefile` includes `wgpud/rules.mk`, which pins the toolchain, FFmpeg, dcadec, and libaom, and holds the rules to build an FFmpeg audio module, a libdcadec module, libaom, and a Rust module.
`wgpud/include/audio_decoder_interface.h` declares the [audio decoder interface](decoder-packages.md#the-audio-decoder-interface) for C modules.

Run from the engine root:

```sh
make -C wgpud sources                     # Fetch the pinned FFmpeg, dcadec, and libaom, once, for the audio and AV1 projects
npm run decoders                          # Build every project into bin/wgpud/<project>.wasm
npm run decoders -- hevc vc1              # Build some projects
npm run decoders -- --check               # Rebuild every project into a scratch folder and compare it with bin/wgpud
make -C wgpud source-archives             # Write the corresponding source of the LGPL projects
make -C wgpud clean
```

`scripts/decoder-packages.mjs` iterates over the projects without naming any.
It builds every project's module at once, since each build spends most of its time in one serial chain such as a configure script's compiler probes, and prefixes each output line with the project's name.
Then, in project order, it packs each module, the decoder source, and the project's vectors file with `tools/decoder-package-format.mjs`, and loads the result with the engine's own loader, as any host would, before it writes the package.
A failed build or load check fails the run after the other packages are written.
`tools/pack-decoder-package.mjs` packs one package by hand from the same parts.

### How the build works

- Pinned sources.
  FFmpeg, dcadec, and libaom are git submodules in the engine's `vendor/`, pinned to exact commits.
  They are shallow and marked `update = none`, so a recursive clone of the engine, or of a host that embeds it, skips them until `make -C wgpud sources` fetches them.
  It fetches only each recorded commit, at depth 1, because `git submodule update --depth 1` would first clone the tip of the default branch.
- Fresh source trees.
  An FFmpeg project extracts a fresh copy of the pinned tree into `wgpud/build/<project>/source/` with `git archive`, then configures and builds it there with only that project's decoders and FFmpeg's portable C.
  Building outside a git checkout keeps FFmpeg's embedded version string and source paths stable.
  The AV1 project extracts and builds libaom the same way, after applying its patches (see [The AV1 parser](#the-av1-parser)).
- Configuration checks.
  The build fails unless configure enabled exactly the whitelisted decoders and kept the LGPL scope: no GPL, nonfree, or version 3 components.
- A fixed environment, as for the engine's modules, and Rust panic paths mapped to fixed names.
- Audio modules link as standalone reactors with `-sIMPORTED_MEMORY`, so each imports its memory and exports version 1 of the audio decoder interface.

### Self-test vectors

`scripts/codec_vector_assets/generate_decoder_package_vectors.py` reads the vectors each `decoder.json` lists and writes `wgpud/<project>/<project>.vectors`, the set the package carries in its vectors section (see [Self-test vectors](decoder-packages.md#self-test-vectors)).
A project whose streams no script elsewhere writes keeps them in its own `vectors/`, from a generator of its own: `generate_mpeg2_decoder_vectors.py`, `generate_jpeg2000_decoder_vectors.py`, `generate_av1_decoder_vectors.py`, and `generate_mpeg4_decoder_vectors.py`, and for the `wma` project, whose audio package carries no vectors section, `generate_wma_decoder_vectors.py`, which writes its media and FFmpeg's known answers for its tests.
The files are committed, byte for byte (`.gitattributes` marks them `-text`), and `--check` fails unless they match what the generators write.
`scripts/generate_all_codec_vector_assets.py` runs them with the other generators, a project's own media first.

### The HEVC parser

`wgpud/hevc/parser/` is our crate: the CPU half of the HEVC package, whose WGSL back end is `wgpud/hevc/hevc.wgsl`.
It parses each packet into one GPU record: the picture's parameters and slices, and per CTB its SAO, its prediction units with their motion, its transform jobs and coefficients, its deblocking edges, and its PCM samples.
The WGSL expands the record and reconstructs and filters the picture on the GPU (see [Decisions](decisions.md#gpu-decode)).
It implements version 2 of the engine's [parser interface](decoder-packages.md#the-parser-interface): `plan`, `parse`, and `finish`, with `decode` running all three on one instance.
Every packet is one picture, so `plan_next` and `decode_next` report no more pictures, and a picture reports no visible size, repeat counts, or declared maximum of its own.
A 4:0:0 picture decodes into the 4:2:0 format of its depth with neutral chroma, so the header declares `monochrome: yes`.

`hevc.wgsl` declares the record's layout and the error codes once, as `const RECORD_<NAME>: u32` and `const ERROR_<NAME>: u32` lines.
`build.rs` reads them into Rust constants and fails unless the header's `//! error:` lines name exactly the error codes the WGSL declares, so the module and the WGSL of one package always agree.
A failed check reports one of the decoder's error codes and its failing value, as a failure on the GPU does.

After a change, from the engine root:

```sh
npm run decoders -- hevc
cd wgpud/hevc/parser && cargo test --locked
npx vitest --watch=false wgpud/hevc
```

### The JPEG 2000 parser

`wgpud/jpeg2000/parser/` is our crate: the CPU half of the JPEG 2000 package, whose WGSL back end is `wgpud/jpeg2000/jpeg2000.wgsl`.
It reads a JP2 file, a `jp2c` box, or a bare codestream, picks the pixel format as FFmpeg does, runs tier-2, and writes one GPU record per picture: the code blocks with their bytes, terminations, and dequantization, the wavelet tables, and the output planes.
One parse unit is one tile, so the parse workers split a picture by its tiles.
The WGSL decodes each code block in one 32-lane workgroup, runs the inverse wavelet, and writes the output planes.
As for HEVC, the WGSL declares the record's layout and the error codes once, and `build.rs` generates the Rust constants from them and fails unless the two agree, and every packet is one picture of version 2 of the parser interface.
The parser bounds what a crafted codestream can make it allocate and parse, and fails such a stream as `resourceLimit`.
It fails greyscale pictures as `colourSpace`, so the header declares no `monochrome`, and eligibility never offers the package a 4:0:0 stream.

After a change, from the engine root:

```sh
npm run decoders -- jpeg2000
cd wgpud/jpeg2000/parser && cargo test --locked
npx vitest --watch=false wgpud/jpeg2000
```

### The MPEG-2 parser

`wgpud/mpeg2/parser/` is our crate: the CPU half of the MPEG-2 package, whose WGSL `wgpud/mpeg2/mpeg2.wgsl` decodes everything, its headers included.
The parser reads only what the engine needs before a picture decodes: the size and chroma format of each picture's sequence.
It reads them as the WGSL's header stage does, from the sequence headers and sequence extensions before a packet's first picture start code, and ignores a damaged sequence header where the WGSL and FFmpeg ignore it.
`configure` reads the codec private data the same way and reports its sequence's size as the largest picture.
Every packet is one picture of version 2 of the parser interface, without parse units, and its record is the packet, byte for byte, so the WGSL decodes, conceals, and reports fields as it did without a parser.
A picture reports its sequence's size as its visible size and its largest picture, and its sequence's chroma format at 8 bits as its format, so a larger sequence, or one of another chroma format, moves the engine to a session of its own (see [Stream changes](decoder-packages.md#stream-changes)).
A sequence its pool holds, such as a smaller one, decodes in the session it is in: the WGSL drops its references and starts the new geometry, as FFmpeg reinitializes, and each frame presents at its own picture's visible size.
The parser decides no output events, so frames present in timestamp order as a decoder without a parser's do, and reports no picture fields, so the WGSL's own report stands.
MPEG-1 has no sequence extension, so its sequences are 4:2:0.
The WGSL declares the error codes, and `build.rs` generates the Rust constants from them and fails unless the header's `//! error:` lines name exactly those; the parser's only failure is `recordInvalid`, a call the engine never makes.

After a change, from the engine root:

```sh
npm run decoders -- mpeg2
cd wgpud/mpeg2/parser && cargo test --locked
npx vitest --watch=false wgpud/mpeg2
```

### The VC-1 parser

`wgpud/vc1/parser/` is our crate: the CPU half of the VC-1 package, whose WGSL back end is `wgpud/vc1/vc1.wgsl`.
It parses each packet's picture as FFmpeg's `vc1` decoder does: the segments and their escapes, entry points, the frame, field, and slice headers, bitplanes, the intensity compensation lookups, and the macroblock layer, with motion vector prediction, coefficients, and intra DC and AC prediction, scan, and dequantization.
`configure` takes the codec private data the engine passes for `vc1` and `wmv3` (see [Codec private data](decoder-packages.md#codec-private-data)) and reports the Advanced profile's `MAX_CODED_WIDTH` and `MAX_CODED_HEIGHT`, or the Simple and Main profiles' coded size, as the largest picture.
One parse unit is one slice or one field, so the parse workers split a picture by its slices and fields; a picture without slices parses on one worker.
Each picture's record holds its header, each field's parameter block, the lookup sets those read, and per macroblock its flags, transform types, motion compensation operations, and dequantized coefficients at their raster positions.
`expandRecord` writes them into the buffers the reconstruction, overlap smoothing, and loop filter passes read, one workgroup per macroblock.
An IntraX8 picture decodes entirely in the parser, its prediction, transform, and loop filter included, and its record carries the picture's samples, which `copyPicture` writes.
A B picture's direct mode reads the next anchor's motion, which only that anchor's parse yields, so its plan reports `blocked` until every earlier anchor finished, then carries that motion.
Output events follow FFmpeg's: a B or BI picture, and any picture of a low-delay stream, presents at once, and an anchor presents the anchor before it, so the header declares `reorder: 1`.
An entry point that changes the coded size drops the anchor waiting to present and every reference, as FFmpeg's decoder does when it reinitializes, and the next record tells the WGSL to release its anchors.
A picture reports its coded size as its visible size, and `parser_picture_fields` reports its fields from FCM, TFF, and RFF.
As for HEVC, the WGSL declares the record's layout and the error codes once, and `build.rs` generates the Rust constants from them and fails unless the two agree, and every packet is one picture of version 2 of the parser interface.
The damage of a packet, `pictureHeader`, `bitplane`, `startCodes`, `macroblockLayer`, `bitsExhausted`, and `pictureTooShort` (a field picture of one macroblock row, FFmpeg's "image too short"), resyncs.
The configuration, the sequence header, an unsupported feature, an invalid record, and `pictureSize`, a size beyond the pool or the package's 16384 macroblocks, end the attempt, since the pictures after it would fail the same way and a resync would hold the last good frame for good.

After a change, from the engine root:

```sh
npm run decoders -- vc1
cd wgpud/vc1/parser && cargo test --locked
npx vitest --watch=false wgpud/vc1
```

### The MPEG-4 parser

`wgpud/mpeg4/parser/` is our crate: the CPU half of the package that decodes MPEG-4 Part 2, H.263, and MS-MPEG4 v1 to v3, whose WGSL back end is `wgpud/mpeg4/mpeg4.wgsl`.
It is a port of FFmpeg's decoders: `mpeg4videodec.c` for MPEG-4 Part 2 (`mpeg4/`), `ituh263dec.c` for H.263 and the H.263+ annexes FFmpeg decodes (`h263.rs`), `msmpeg4dec.c` for MS-MPEG4 (`msmpeg4.rs`), the slice loop and resync of `h263dec.c` (`h263dec.rs`), the macroblock state and dequantization of `mpegvideo.c` (`mpv.rs`), and the operation geometry of `mpegvideo_motion.c` (`motion.rs`).
`configure` reads the BITMAPINFOHEADER the engine passes for every codec of the package (see [Codec private data](decoder-packages.md#codec-private-data)), picks the codec from its FourCC as FFmpeg's `riff.c` classes it, reads an MPEG-4 Part 2 track's VOL from the extradata after it, and reports the coded size as the largest picture.
FFmpeg's encoder detection runs on the FourCC and the user data as in FFmpeg, and sets the same bug workarounds and IDCT, the Xvid IDCT included.
One parse unit is one picture, so the parse workers decode pictures at once, each from a fresh copy of the stream's tables, as FFmpeg's decoder holds no state between pictures besides the headers and the anchors.
A DivX packed packet's second VOP, which the fork's AVI demuxer unpacks but a Matroska track can still carry, plans as a second picture of the same packet.
FFmpeg's decoder keeps that VOP and decodes it with the next packet instead, so in Matroska the two pictures share one packet's time, and a stream's last such VOP, which FFmpeg never decodes, presents.
Each picture's record holds per macroblock its flags, the H.263 loop filter's quantizers, the motion operations FFmpeg would run (half-pel, quarter-pel, one-point and general global motion compensation, and overlapped block motion compensation, each with its source position, fraction, and rounding), and its dequantized IDCT blocks, dense or as sparse entries.
The WGSL runs a picture's operations in order, then the simple or Xvid IDCT, then the H.263 loop filter over all horizontal and then all vertical edges.
A B-VOP's direct mode reads the next anchor's motion, which only that anchor's parse yields, so its plan reports `blocked` until every earlier anchor finished, then carries that motion.
Output events follow FFmpeg's: a B picture, and any picture of a low-delay stream, presents at once, and an anchor presents the anchor before it, so the header declares `reorder: 1`.
An H.263 picture of another size starts new anchors, as FFmpeg reinitializes, and reports its size as its visible size and the largest so far; `parser_picture_fields` reports an MPEG-4 Part 2 VOP's interlacing and top field first.
As for HEVC, the WGSL declares the record's layout and the error codes once, and `build.rs` generates the Rust constants from them and fails unless the two agree, and every packet is one picture of version 2 of the parser interface.
The damage of a packet, `sequenceHeader`, `pictureHeader`, `macroblockLayer`, and `bitsExhausted`, resyncs; the configuration, an unsupported feature, `pictureSize`, and an invalid record end the attempt.
The parser's reference is FFmpeg's bit-exact, single-threaded decode (see [decisions](decisions.md)).

After a change, from the engine root:

```sh
npm run decoders -- mpeg4
cd wgpud/mpeg4/parser && cargo test --locked
npx vitest --watch=false wgpud/mpeg4
```

### The AV1 parser

`wgpud/av1/` decodes AV1 with libaom's decoder as its parser and WGSL for everything after the syntax.
libaom v3.15.2 is the git submodule `vendor/aom`, pinned in `wgpud/rules.mk` (`AOM_COMMIT`), shallow and marked `update = none`, as FFmpeg and dcadec are.
The build extracts the pinned tree with `git archive`, applies the patches in `wgpud/av1/parser/patches/` in order with `patch --fuzz=0`, and builds the decoder alone with libaom's CMake and Emscripten's toolchain file: generic C, one thread, and WebAssembly exception handling for libaom's `longjmp` error path (`-sSUPPORT_LONGJMP=wasm`), so the module needs no JavaScript glue.
The patches turn the decoder into a parser:

- `0001-parse-only-decoding.patch` parses every tile with libaom's parse-only flag, so the decoder reads modes, motion, palettes, transform sizes, coefficients, CDEF indices, and restoration units, and runs no prediction, reconstruction, or filter; hooks hand each transform block, block, frame, and missing reference to the bridge.
- `0002-intra-edge-parameters.patch` exports the edge sample counts and the edge filter type that intra prediction derives.
- `0003-cfl-store-extent.patch` keeps the extent of the chroma-from-luma buffer the decoder would have stored, and exports CfL's alpha.
- `0004-filter-level.patch` exports a block's deblocking level.

libaom's frame buffers point at an address no module memory maps, so the parser holds no samples, and a stray sample access traps.
libaom refuses a frame buffer past an eighth of `AOM_MAX_ALLOCABLE_MEMORY`, 2 GiB on 32-bit targets, which a level 6 4:4:4 frame with a scaled reference's borders passes, so the build raises it to 4 GiB less 64 KiB; the 1 GiB instance memory still bounds every allocation that maps memory.

`parser/av1_parser.c` implements version 2 of the [parser interface](decoder-packages.md#the-parser-interface).
`plan` parses a temporal unit's frames, one picture per frame, hidden frames and `show_existing_frame` included, and `plan_next` hands out the rest.
The unit's last shown frame presents and the others drop, as libaom and FFmpeg's libdav1d output one frame per temporal unit at operating point 0.
A picture reports its visible size, the upscaled width and the frame height, its intra wave pairs, its output format, and its sequence header's maximum frame size, and `configure` reports the configured sequence header's maximum.
So a picture of a new sequence that changes the bit depth or the chroma format, or raises the maximum past the pool, moves the engine to a new session, from that sequence's key frame on.
After a start or a reset, temporal units before the first key frame make no picture.
`parser/av1_record.c` writes each frame's GPU record: the blocks with their motion, warps, transform partitions, and palettes; each superblock's intra jobs per plane in decode order, with their edges; transform jobs with libaom's dequantized coefficients, dense or sparse, those with a 64-point side last; and the restoration units, CDEF indices, deblocking levels, references with their scale factors, global motion, and film grain.
`av1.wgsl` declares the record's layout and the error codes once, as `const RECORD_<NAME>: u32` and `const ERROR_<NAME>: u32` lines, and `parser/record_layout.mjs` turns them into the bridge's C header, and fails unless the `//! error:` lines name exactly the error codes the WGSL declares and the `//! packet:` line is the bound the `RECORD_PACKET_` constants describe.
That bound is a record's worst case for its pool, between 64 MiB and the engine's 512 MiB: per 4x4 luma unit the words of a 4x4 block and its side data, and per 4x4 unit of each plane an intra job, a transform job, and 16 coefficients of the bit depth plus 8 bits, libaom's dequantized range.
The parser judges each record against the bound of its frame's upscaled size rounded up to 64, which never passes its session's, and fails it as `recordSize` beyond.
The package takes pictures up to AV1's level 6.x, 16384x8704 and 35,651,584 samples, 8K included; its record fields hold mode info coordinates up to 16384 samples.

`decoder.json` lists `av1.wgsl` first, with the header, which declares `id: av1`, the record layout, the frame store, and the entry points, then the four family files: `wgsl/transform.wgsl` (inverse transforms, film grain, and the output copy), `wgsl/intra.wgsl`, `wgsl/inter.wgsl`, and `wgsl/filters.wgsl` (deblocking, CDEF, super-resolution, and loop restoration).
Each record runs validation, inter prediction per 16x16 tile, the transforms in two passes, the transforms with a 64-point side in a kernel of their own, an intra wavefront over superblocks for intra, inter-intra, and IntraBC blocks, deblocking, CDEF, super-resolution, loop restoration, and the output copy with film grain.
References stay in the package's own frame store, ten 16-bit frame buffers the parser assigns, so the header declares `references: 0`, and only shown frames reach the frame pool.
The store spans two buffers, `frames` with frame buffers 0 to 4 and `framesHigh` with the rest, so a device whose largest binding holds half of it decodes: 1.07 GB at 8192x4352 4:2:0 becomes two of 535 MB, and the 2.14 GB of 4:4:4 two of 1.07 GB.
A 4:0:0 stream decodes into the 4:2:0 format of its depth with neutral chroma, so the header declares `monochrome: yes`.

After a change, from the engine root:

```sh
npm run decoders -- av1      # About 3 minutes
npx vitest --watch=false wgpud/av1
```

### The WMA bridge

`wgpud/wma/ffmpeg_wma_bridge.c` puts FFmpeg's five WMA decoders behind the audio decoder interface.
Every one of them needs the track's WAVEFORMATEX, so a decoder opens only when `audio_decoder_configure` reads it, and refuses packets as `unconfigured` until then.
It reads the header as FFmpeg's `ff_get_wav_header` does: the sample rate, channels, bit rate, block alignment, bits per sample, a WAVE_FORMAT_EXTENSIBLE header's channel mask when it describes that many channels, and the bytes after the header as extradata.
A header shorter than 18 bytes or than its `cbSize`, an extensible one without its 22 bytes, or one without channels or a sample rate fails as `waveFormat`; a format tag, or an extensible SubFormat's, of another codec as `formatTag`; and a header the decoder refuses as `open`.
Each configure after the first opens a fresh decoder.
The decoders hold frames back until the end of the stream, WMA 1 and 2 their last overlap and WMA Lossless the frames it buffered, so the module exports the interface's optional `audio_decoder_drain`, which its `Makefile` names as the second argument of `link_ffmpeg_audio_module`.
A drain before a configure fails as `unconfigured`, a second drain outputs nothing, and `audio_decoder_clear` starts a new stream after one.
Blocks are planar float: WMA Lossless's 16-bit and 24-bit integers are scaled by the exact power of two of full scale, and WMA Voice's packed mono float is copied.
A layout without a channel mask reports the mask of FFmpeg's default layout of its channel count.
FFmpeg's C decode, `-cpuflags 0`, is the reference, and the module decodes every vector to the same bytes, as [WMA decoder vectors](codec-vectors.md#wma-decoder-vectors) describes.

After a change, from the engine root:

```sh
npm run decoders -- wma
npx vitest --watch=false wgpud/wma
```

### The TrueHD bridge

`wgpud/truehd/ffmpeg_truehd_bridge.c` puts FFmpeg's MLP and TrueHD decoders behind the audio decoder interface, and adds Dolby Atmos object rendering for TrueHD.
FFmpeg decodes every packet, and its decode is the output unless the render target needs objects, as the `renderChannelMask` and `renderBinaural` options of [the audio decoder interface](decoder-packages.md#the-audio-decoder-interface) set it: a stream FFmpeg reports as `Dolby TrueHD + Dolby Atmos`, with binaural rendering on, or with a target mask that has a speaker FFmpeg's output layout lacks.
FFmpeg stops at the 8-channel presentation: it decodes at most three substreams, holds 8 channels, and refuses the `0x31EC` restart sync word of the fourth substream, which carries the 16-channel presentation.
So MLP, TrueHD without Atmos, and an Atmos stream at a target its 7.1 or 5.1 presentation covers, such as 5.1, 7.1, or stereo without binaural, output FFmpeg's decode unchanged, and report `objectCount` 0.

When the target needs objects, three sources of ours take over, packet by packet:

- `truehd_presentation.c` decodes one presentation of a TrueHD stream, here the 16-channel one, to 24-bit samples in the presentation's channel order.
  It is a port of FFmpeg's `mlpdec.c`, `mlpdsp.c`, `mlp.c`, and `mlp_parse.c` (major sync, restart headers, decoding parameters, prediction filters, Huffman residuals, primitive matrices and their noise, output shifts, and channel assignment), generalized from 8 channels and 3 decoded substreams to 16 channels and 4.
  It adds what FFmpeg lacks: the `0x31EC` substream's matrix syntax (a coefficient mask and shift per matrix, bypassed LSBs of up to 3 bits, and coefficient deltas that interpolate across each access unit), the substreams each presentation is built from (the 16-channel one is substream 3 together with the lower substreams that `extended_substream_info` names), the extra channel meaning of the major sync, and the extra data after the substreams, whose Evolution frame carries object audio metadata as payload 11 in the EMDF payload syntax.
  Those layouts are documented only by the truehd crate of [truehdd](https://github.com/truehdd/truehdd) (Apache-2.0), which we read to learn them; the code is our own, and the file's header cites both.
  It also checks each restart header's lossless check against the samples it decoded.
- `truehd_objects.c` hands the presentation to the renderer: its channels are the metadata's objects in payload order, beds first, and a presentation without metadata is the channel bed its major sync's 16-channel channel assignment names (L R, C, LFE, Ls Rs, Lb Rb, Tfl Tfr, Tsl Tsr, Tbl Tbr, Lw Rw, LFE2).
  Each access unit's payloads are parsed by `atmos_parse_oamd` and queued at their Evolution sample offset before the access unit renders.
- The renderer in `wgpud/atmos/` renders the bed and the dynamic objects into the target, or binaural stereo.

A packet renders only when every access unit in it decoded and rendered; otherwise it outputs FFmpeg's decode, so rendering starts at the first packet after a major sync and the first object metadata, and a switch back to a covered target returns to FFmpeg's decode at once.
A packet whose access units could hold more than 16,384 frames, the engine's bound on a block, plays FFmpeg's decode too.
Any packet the object decoder does not read, because FFmpeg dropped it or the target needed no objects, resets that decoder, so it resumes at the next major sync rather than with stale filter and matrix state.
A rendered packet is one block at the packet's timestamp, with the target's mask and `objectCount`, the scene's dynamic objects; FFmpeg's frames of that packet are discarded.
Binaural rendering delays its output by 128 frames, so the module exports `audio_decoder_drain`, which renders that tail after the last packet; a stock decode drains nothing.
`audio_decoder_clear` resets both decoders and the renderer.

`truehd_presentation.c` decodes every presentation of the eight TrueHD streams among the truehd crate's test assets and of the engine's three TrueHD vectors bit for bit as truehdd (commit `77ddc52`) does, the three 16-channel presentations included, and presentations 0 to 2 bit for bit as FFmpeg does wherever FFmpeg's `downmix` option can select them, with every lossless check passing.
To repeat that, build truehdd natively, decode with `truehdd decode --presentation <n>`, and compare its 24-bit samples with a native build of `truehd_presentation.c`; neither the oracle nor the harness enters the repository.
The `wgpud/truehd/vectors/` streams, copied from the truehd crate's test assets, carry that crate's Apache-2.0 license and `PROVENANCE.txt`.

After a change, from the engine root:

```sh
npm run decoders -- truehd
npx vitest --watch=false wgpud/truehd
```

### The E-AC-3 bridge

`wgpud/eac3/ffmpeg_eac3_bridge.c` puts FFmpeg's AC-3 and E-AC-3 decoders behind the audio decoder interface, and adds Dolby Atmos object rendering for E-AC-3 with joint object coding (JOC, ETSI TS 103 420).
FFmpeg decodes every packet, and its decode is the output unless the render target needs objects: binaural rendering on, or a target mask with a speaker the decoded core lacks, such as 7.1 or any height layout from a 5.1 core.
A stream without JOC, AC-3, and a JOC stream at a target its core covers, such as 5.1 or stereo without binaural, output FFmpeg's decode unchanged and report `objectCount` 0.

When the target needs objects, our sources take over, frame by frame, on FFmpeg's decoded channels:

- `eac3_emdf.c` finds the EMDF container (ETSI TS 102 366 Annex H) in the access unit's last syncframe, as TS 103 420 clause 8.2 places it, and copies out its OAMD (payload 11) and JOC (payload 14) payloads.
  The container is in the frame-end auxiliary data, which `auxdatal` locates, or in an audio block's skip field, as Dolby's encoder writes it.
  Reaching a skip field exactly takes the audio block syntax up to it, so the search takes an EMDF syncword whose preceding ten bits read as a set `skiple` and a `skipl` that holds the container, and whose container parses completely within it.
  FFmpeg's `avpriv_ac3_parse_header` splits a packet into access units as FFmpeg's decoder takes them.
- `eac3_joc.c` parses the JOC payload (clause 6.2) and decodes it: the Huffman trees of Annex A.1, differential decoding, dequantization, the parameter band mapping of table 54, interpolation between data points, and the upmix of the 5 or 7 downmix channels to up to 16 objects in the filter bank domain.
- `eac3_qmf.c` is the 64-band complex filter bank of clause 7, computed through a 128-point FFT; analysis and synthesis delay the objects by 577 samples.
  `eac3_joc_tables.c` holds the Huffman trees and the 640-coefficient window from the specification's companion archive `ts_103420v010201p0.zip`.
- The renderer in `wgpud/atmos/` renders the objects with the OAMD: each LFE bed object takes the core's LFE, and the other scene objects, beds then dynamic objects, take the JOC objects in order.

Object blocks keep their packets' timestamps exactly: the module holds each block until the frames after it fill the filter bank delay and the binaural latency, so the first packet after a start, a clear, or a switch from FFmpeg's decode outputs no block, and `audio_decoder_drain` outputs the last one.
A switch back to a covered target outputs the held block and FFmpeg's block of the same packet, the later frames of a packet keep their access units' timestamps, and a change of speaker layout or binaural rendering finishes the held blocks in the old target and restarts the pipeline.
Objects start only at a frame whose OAMD scene the renderer takes; a scene it refuses, such as one with intermediate spatial format objects, plays FFmpeg's decode.
A damaged JOC payload keeps the last matrices, and a damaged OAMD payload the objects' properties.
`objectCount` is the scene's dynamic objects that have a JOC object.

The JOC decoder rebuilds the same objects as the JOC decoder of [OpenJOC](https://github.com/chyinan/OpenJOC) (Apache-2.0, commit `e3e330a`), run natively on the same FFmpeg downmix and payloads: within 6e-8 of full scale (129 dB or more per object) on Dolby's `sample_eac3joc.ec3` from androidx/media, and within 4e-10 on OpenJOC's synthetic fixtures; both extract the same payload bytes from all 64 access units of the Dolby stream.
Neither the oracle nor the temporary harness enters the repository.
The `wgpud/eac3/vectors/` media, and how to repeat their generation, are in [E-AC-3 Atmos vectors](codec-vectors.md#e-ac-3-atmos-vectors).

After a change, from the engine root:

```sh
npm run decoders -- eac3
npx vitest --watch=false wgpud/eac3
```

### The object audio sources

`wgpud/atmos/` holds our own object audio code, which the `eac3` and `truehd` modules compile with their bridges; it has no `decoder.json`, so it is no project and builds no package.
`atmos.h` is the interface those bridges code against: `atmos_parse_oamd` decodes one object audio metadata (OAMD) payload, and an `AtmosRenderer` renders a scene's object planes with that metadata into a target layout.
A package's `Makefile` passes `$(ATMOS_MODULE_SOURCES)` from `wgpud/rules.mk`, the four sources and their include flag, as the third argument of `link_ffmpeg_audio_module`, whose first argument lists the project's own sources.
The code depends on no other Atmos library; ETSI TS 103 420 V1.2.1 and Recommendations ITU-R BS.2051 and BS.2127 are its references.

- `atmos_oamd.c` decodes an `object_audio_metadata_payload` as TS 103 420 clause 5 defines it: the program assignment, whose bed objects come first and are named by FFmpeg's channel bits (the LFE of a dynamic-object program is a bed object), then ISF objects, then dynamic objects; and the object element's updates, each with its start (`sample_offset` plus 32 times `block_offset_factor`) and ramp duration, and per object its activity, gain, priority, room-anchored position (differential coding, extended precision, and a position outside the room projected onto its walls), zones, elevation, size, screen factors, and channel lock.
  Other elements, such as trim, are skipped by their declared size.
  A payload holds at most 32 objects and 8 updates; every read is bounded, and a truncated payload, an element that overruns its size, a version other than 0, counts that do not add up, or a reserved ISF index returns an error code.
  Where the clause's pseudo-code and its tables disagree on which bit of a flag array is which, which happens only for `obj_render_info[]`, the tables win: element `[k]` of an array is the k-th bit the payload carries, as real streams confirm for `content_description[]` and the bed assignments.
- `atmos_renderer.c` renders to every layout the engine qualifies: stereo, 5.1 (back or side), 7.1, 5.1.2, 5.1.4, 7.1.2, and 7.1.4, in WAVE channel order.
  Speakers stand on the room's walls as TS 103 420 Table B.10 places them, a 5.1 layout's surround pair in the back corners.
  The panner is separable and room-centric: an object pans between the floor and the heights, then between the rows of speakers in front of and behind it, then between the speakers left and right of it in each row, each step with the sine and cosine law, so its gains' squares sum to 1 and an object at a speaker plays from that speaker alone.
  An object with a size averages that power over a 3 by 3 by 3 grid across its extent; zone constraints and elevation take the excluded speakers (TS 103 420 Annex A.2) out of the panner, falling back to all of them when none remain; channel lock plays an object from its nearest speaker within 0.4 in ADM units.
  A bed channel plays on its own speaker, or folds as the engine folds layouts: a side or back channel onto the other of its side's pair, a top front or top back channel onto the floor channel under it (folding on from there), a wide channel onto its side's front, and LFE2 onto the LFE; a top side channel, which the engine's layouts lack, splits over its side's top front and top back at sqrt(1/2) each, or plays from the top front of a layout with only that pair, or else from the side under it.
  Every bed channel that lands whole on a speaker, its own included, takes 1/sqrt(n) of the n channels landing there, as the engine's layout routing does, so a 5.1 surround with Ls, Lb, and Tsl takes each at sqrt(1/3) and one alone keeps unit gain; a split channel takes sqrt(1/2) on each of its two.
  Stereo takes that fold into 7.1 and mixes it with the engine's default Lo/Ro matrix: fronts at 1, center, sides, and backs at sqrt(1/2), the LFE dropped.
  ISF objects are parsed but not rendered: a scene with them fails as unsupported.
  Updates queue at their start sample, at most 32 at once; an update's properties ramp linearly from the ones the object has when it starts, gain vectors computed every 32 samples and the gains moving linearly in between, so they reach the update's values at its start plus its ramp duration whatever the render calls' lengths.
  A target changes between render calls: objects keep their properties and ramps and move to the new layout's gains at once.
  Nothing allocates after `atmos_renderer_create`.
- `atmos_binaural.c` renders binaural stereo at 48 kHz: the scene renders to a virtual 7.1.4 layout, and each of its 11 speakers is convolved with its pair of head-related impulse responses by uniformly partitioned overlap-save convolution, 128-sample partitions in 256-point transforms, with two real signals sharing each complex transform, so a block of 128 samples costs six forward transforms, one inverse, and the products of two partitions.
  The output is 128 samples late, which `atmos_renderer_latency` reports; the LFE joins both ears at 0.5 without HRIRs, delayed the same.
- `atmos_hrir.c` holds the 11 virtual speakers' responses, 160 taps per ear at 48 kHz, which `node scripts/generate-atmos-hrir.mjs [diffuse.zip]` writes.
  The source is the diffuse-field equalized set of Bill Gardner and Keith Martin, "HRTF Measurements of a KEMAR Dummy-Head Microphone", MIT Media Lab, 1994 (`diffuse.zip` from <https://sound.media.mit.edu/resources/KEMAR.html>, SHA-256 `a48e73137390626ef1e45d1de6a4d98530c6aa570e71b40f7c4442241ed5fa22`, which the script checks).
  The directions follow BS.2051's 4+7+0 layout: the floor speakers at azimuths 0, 30, 90, and 135 at elevation 0, the heights at azimuths 45 and 135 at KEMAR's 40 degree elevation, the left speakers taking their mirror images with the ears swapped, as the set's symmetric responses intend.
  The script resamples each 128-tap 44.1 kHz response with a Kaiser-windowed sinc, fades its last 16 taps, and scales the set to a mean energy of 0.5 per ear, a stereo pan's level for one channel.

A test module of these sources and `test/atmos_test_exports.c`, which adds exports to build scenes and read parsed metadata, backs `test/Atmos.test.ts`.
The tests parse hand-built payloads and real ones from TrueHD and E-AC-3 streams, pan objects onto every layout's speakers, check power, fold-down, zones, ramps, and retargeting, and compare the binaural output with a direct convolution by the table's taps.
The parser decodes the object metadata of the truehd crate's Atmos test assets as truehdd does, positions within 3.2e-7 in ADM units.

After a change, from the engine root:

```sh
make -C wgpud/atmos module                # Builds wgpud/build/atmos/module.wasm, the tests' module
npx vitest --watch=false wgpud/atmos
npm run decoders -- eac3 truehd            # The packages that compile these sources
```

### Licenses

- The engine's modules, the bridges, the object audio sources in `wgpud/atmos/`, the HEVC, JPEG 2000, MPEG-2, and VC-1 parsers, the decoder sources, and the `libdovi` crate are MIT, like the rest of the engine.
  The vendored `dolby_vision` crate is MIT too and keeps its own `LICENSE`.
- FFmpeg and libdcadec are LGPL-2.1-or-later, and only the `eac3`, `truehd`, `wma`, and `dts` packages contain them.
  `wgpud/licenses/` holds their license texts.
  `wgpud/truehd/truehd_presentation.c` and its header, a port of FFmpeg's MLP decoder, are LGPL-2.1-or-later too.
  The `eac3` package's JOC sources (`eac3_emdf.c`, `eac3_joc.c`, `eac3_qmf.c`, `eac3_joc_tables.c`) are our own code, MIT; the tables are facts of ETSI TS 103 420.
- libaom is BSD-2-Clause with the Alliance for Open Media Patent License 1.0, and only the `av1` package contains it.
  `wgpud/licenses/` holds its `LICENSE` and `PATENTS` as `libaom-LICENSE` and `libaom-PATENTS`.
- The HRIR table in `wgpud/atmos/atmos_hrir.c`, which the `eac3` and `truehd` packages contain, comes from the MIT KEMAR measurements, "Copyright 1994 by the MIT Media Laboratory", "provided free with no restrictions on use, provided the authors are cited when the data is used in any research or commercial application"; the file's header cites them, as whoever distributes those packages must.
- The engine ships no decoder package.
  Whoever distributes the LGPL packages must offer their corresponding source: `make -C wgpud source-archives` writes the exact FFmpeg and dcadec trees, and the engine's `wgpud/` sources, to `wgpud/build/source-archives/`.

## Layout

| Path | Holds |
| --- | --- |
| `wasm/Makefile` | The engine modules' build |
| `wasm/libdovi/` | The Rust crate that wraps the `dolby_vision` RPU parser, and its vendored, patched copy of that crate |
| `wasm/audio-output-stage/` | The audio output stage's kernels |
| `wasm/build/` | The engine modules' build trees, ignored |
| `wgpud/Makefile` | The decoder projects' shared jobs: the pinned sources, the source archives, and clean |
| `wgpud/rules.mk` | The rules every decoder project's `Makefile` includes |
| `wgpud/<project>/` | One decoder project: its `decoder.json`, decoder source, vectors file, module sources, and tests in `test/` |
| `wgpud/atmos/` | The object audio sources the `eac3` and `truehd` modules compile, and their tests' module |
| `wgpud/include/` | The audio decoder interface for C modules |
| `wgpud/licenses/` | Upstream license texts |
| `wgpud/build/` | The decoder projects' build trees and source archives, ignored |
