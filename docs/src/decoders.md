# WebAssembly decoders

`wasm/` holds the sources and the build of the engine's WebAssembly decoders.
The build writes them to `bin/wasm/`, which is ignored like everything in `bin/` but `bin/codec_vector_assets/`.

| Kit | Output in `bin/wasm/<kit>/` | Library and license | Our source (MIT) |
| --- | --- | --- | --- |
| `ffmpeg-eac3` | `ffmpeg-eac3.mjs`, `ffmpeg-eac3.wasm` | FFmpeg E-AC-3 and AC-3, LGPL-2.1-or-later | `ffmpeg-eac3/ffmpeg_eac3_bridge.c` |
| `ffmpeg-truehd` | `ffmpeg-truehd.mjs`, `ffmpeg-truehd.wasm` | FFmpeg TrueHD and MLP, LGPL-2.1-or-later | `ffmpeg-truehd/ffmpeg_truehd_bridge.c` |
| `ffmpeg-mpeg2-vc1` | `ffmpeg-mpeg2-vc1.js`, `ffmpeg-mpeg2-vc1.wasm` | FFmpeg MPEG-2 Video and VC-1, LGPL-2.1-or-later | `ffmpeg-mpeg2-vc1/ffmpeg_mpeg2_vc1_bridge.c` |
| `libdcadec-dts` | `libdcadec-dts.mjs`, `libdcadec-dts.wasm` | [dcadec](https://github.com/foo86/dcadec) DTS, DTS-HD High Resolution, and DTS-HD Master Audio, LGPL-2.1-or-later | `libdcadec-dts/libdcadec_dts_bridge.c` |
| `libdovi` | `dovi-rpu-parser.wasm` | The `dolby_vision` crate from [dovi_tool](https://github.com/quietvoid/dovi_tool), vendored and patched, MIT | `libdovi/` |

The `.mjs` outputs are the audio kits' ES module glue, which esbuild bundles into each worker that imports it.
Their hand-written TypeScript declarations sit beside the bridges as `<kit>/<kit>.d.mts`, and the engine imports them as `#wasm/<kit>/<kit>.mjs` (see [Embedding the engine](embedding.md)).
Every `.wasm` file, and the `ffmpeg-mpeg2-vc1` glue, is served from `libraries/<kit>/`.
An audio binary is fetched only when a worker creates its first decoder of that kit, and a probe worker and the playback worker fetch the same URL, so the browser caches it once.
`src/DecoderWASMSource.ts` always passes the glue `locateFile`, because a bundled glue cannot resolve its own URL, or `wasmBinary` with bytes a caller already fetched.
The OpenJPEG and hevc.js decoders come from npm packages, which `scripts/build.mjs` copies; nothing here builds them.

## You need

- GNU Make, Git, and a POSIX shell (Git Bash on Windows).
  No container is involved.
- Node.js: the Makefile reads the engine's folders from `tools/constants.json`.
- Emscripten 4.0.13 (revision `2659582941bef14008476903f48941909db1b196`), activated with `emsdk_env` or named with `EMSDK=/path/to/emsdk`.
- rustup, for `libdovi`.
  Its `rust-toolchain.toml` selects Rust 1.96.1 with the `wasm32-unknown-unknown` target.

## Commands

Run from the engine root:

```sh
make -C wasm sources            # Fetch the pinned FFmpeg and dcadec, once
make -C wasm all                # Build every decoder into bin/wasm
make -C wasm check              # Rebuild every decoder and compare it with bin/wasm
make -C wasm ffmpeg-eac3        # Rebuild one kit
make -C wasm source-archives    # Write the release source tarballs to wasm/build/source-archives
make -C wasm clean
```

`-j5` builds the kits in parallel, and `JOBS` sets the parallelism inside each FFmpeg build.
A full `check` takes several minutes.

## How the build works

- Pinned sources.
  FFmpeg and dcadec are git submodules in the engine's `vendor/`, pinned to exact commits.
  They are shallow and marked `update = none`, so a recursive clone of the engine, or of a host that embeds it, skips them until `make sources` fetches them.
- Fresh source trees.
  Each FFmpeg kit extracts a fresh copy of the pinned tree into `wasm/build/<kit>/` with `git archive`, then configures and builds it there with only that kit's decoders.
  Building outside a git checkout keeps FFmpeg's embedded version string and source paths stable.
- Configuration checks.
  The build fails unless configure enabled exactly the whitelisted decoders and kept the LGPL scope: no GPL, nonfree, or version 3 components.
- A fixed environment.
  The build sets `SOURCE_DATE_EPOCH`, the locale, the time zone, and the Python hash seed, ignores compiler variables from the calling environment, and refuses any Emscripten other than 4.0.13.
- Line endings.
  Emscripten on Windows writes CRLF into its JavaScript glue; the build converts it to LF, so the output does not depend on the host.
- Rust panic paths.
  Panics embed source paths, so the `libdovi` build maps the cargo home, crate, and target directories to fixed names.
  With the `rust-src` component installed, rustc rewrites the standard library's `/rustc/<commit>` paths to the toolchain's local copy, so the build maps that copy back too.
- `make check` rebuilds everything and compares it byte for byte with the existing `bin/wasm/`.
  Copy another machine's `bin/wasm/` in first to check that two machines build the same bytes.

## The Dolby Vision parser crate

`wasm/libdovi/` is our crate.
`src/lib.rs` wraps the `dolby_vision` crate and packs each RPU into the fixed snapshot layout the engine reads (`video/dolby-vision/DolbyVisionRPUDataLayout.ts`, schema 2).
It has two entry points over one parser state: `dovi_parser_parse` reads an HEVC RPU NAL unit (type 62), and `dovi_parser_parse_av1_t35` reads an AV1 ITU-T T.35 metadata message, from the country code to the end of its OBU payload.
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

## Licenses

- The bridges and the `libdovi` crate are MIT, like the rest of the engine.
  The vendored `dolby_vision` crate is MIT too and keeps its own `LICENSE`.
- FFmpeg and libdcadec are LGPL-2.1-or-later.
  `wasm/licenses/` holds their license texts.
- `scripts/build.mjs` serves each LGPL decoder with its license, the bridge source, and the bridge license.
  The Makefile pins the exact upstream commits.
- Attach the tarballs from `make source-archives` to every release: the exact FFmpeg and dcadec trees, and the engine's `wasm/` sources.

## Layout

| Path | Holds |
| --- | --- |
| `wasm/Makefile` | The build |
| `wasm/<kit>/` | A bridge source, and the TypeScript declarations of an ES module output |
| `wasm/libdovi/` | The Rust crate that wraps the `dolby_vision` RPU parser |
| `wasm/libdovi/vendor/dolby_vision/` | The vendored, patched `dolby_vision` crate and its `PATCHES.md` |
| `wasm/licenses/` | Upstream license texts |
| `wasm/build/` | Build trees and source archives, ignored |
