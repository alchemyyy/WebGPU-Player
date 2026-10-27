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
| `vc1` | VC-1 Advanced and WMV3 (Simple, Main, and Complex), on the GPU | The Rust parser in `parser/` | The VC-1 Advanced stream in `src/capability/vectors/qualification/vc1/` | None, MIT |
| `uncompressed` | Uncompressed planar packets, on the GPU | None | None | None, MIT; the template of a WGSL-only decoder |
| `eac3` | AC-3 and E-AC-3 | FFmpeg's AC-3 and E-AC-3 decoders | None | FFmpeg, LGPL-2.1-or-later |
| `truehd` | MLP and TrueHD | FFmpeg's MLP and TrueHD decoders | None | FFmpeg, LGPL-2.1-or-later |
| `dts` | DTS core, DTS-HD High Resolution, and DTS-HD Master Audio | libdcadec | None | [dcadec](https://github.com/foo86/dcadec), LGPL-2.1-or-later |

`decoder.json` names the project's decoder source, the WGSL file or audio manifest the package carries, under `decoder`.
Each project's header declares the project's name as its package id, such as `//! id: hevc`, so a rebuilt package replaces the one a host stored before.
A WGSL decoder may name a list of files instead, which the build joins in order into the one source the package carries: each later file follows a `// Decoder source: <file>` line, so a compile message leads back to its file, and only the first file may hold header lines.
A video project lists its self-test vectors under `vectors`, each with its output `format`, the layout key of its `root` folder in `tools/constants.json`, its `path` there, and optionally the FFmpeg `decoderOptions` of the reference decode.
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
A project whose streams no script elsewhere writes keeps them in its own `vectors/`, from a generator of its own: `generate_mpeg2_decoder_vectors.py`, `generate_jpeg2000_decoder_vectors.py`, and `generate_av1_decoder_vectors.py`.
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
A DivX packed packet's second VOP plans as a second picture of the same packet, as FFmpeg's decoder decodes it from the packet's remaining bytes.
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

### Licenses

- The engine's modules, the bridges, the HEVC, JPEG 2000, MPEG-2, and VC-1 parsers, the decoder sources, and the `libdovi` crate are MIT, like the rest of the engine.
  The vendored `dolby_vision` crate is MIT too and keeps its own `LICENSE`.
- FFmpeg and libdcadec are LGPL-2.1-or-later, and only the `eac3`, `truehd`, and `dts` packages contain them.
  `wgpud/licenses/` holds their license texts.
- libaom is BSD-2-Clause with the Alliance for Open Media Patent License 1.0, and only the `av1` package contains it.
  `wgpud/licenses/` holds its `LICENSE` and `PATENTS` as `libaom-LICENSE` and `libaom-PATENTS`.
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
| `wgpud/include/` | The audio decoder interface for C modules |
| `wgpud/licenses/` | Upstream license texts |
| `wgpud/build/` | The decoder projects' build trees and source archives, ignored |
