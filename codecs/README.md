# Codecs

Sources and build recipe for the engine's WebAssembly decoders. The built
modules are committed in `dist/`. Using or testing the engine never needs this
toolchain; rebuild only to change a decoder or to verify a release.

| Kit | Output in `dist/<kit>/` | Library and license | Our source (MIT) |
| --- | --- | --- | --- |
| `ffmpeg-eac3` | `ffmpeg-eac3.mjs` | FFmpeg E-AC-3 and AC-3, LGPL-2.1-or-later | `ffmpeg-eac3/ffmpeg_eac3_bridge.c` |
| `ffmpeg-truehd` | `ffmpeg-truehd.mjs` | FFmpeg TrueHD and MLP, LGPL-2.1-or-later | `ffmpeg-truehd/ffmpeg_truehd_bridge.c` |
| `legacy-video` | `legacy-video-decode.js`, `legacy-video-decode.wasm` | FFmpeg MPEG-2 Video and VC-1, LGPL-2.1-or-later | `legacy-video/bridge.c` |
| `libdcadec` | `libdcadec.mjs` | [dcadec](https://github.com/foo86/dcadec), LGPL-2.1-or-later | `libdcadec/libdcadec_bridge.c` |
| `libdovi` | `dovi-rpu-parser.wasm` | The `dolby_vision` crate from [dovi_tool](https://github.com/quietvoid/dovi_tool), MIT | `libdovi/` |

The `.d.mts` declarations beside the ES module outputs are hand-written. The
OpenJPEG and hevc.js decoders come from npm packages, which `scripts/build.mjs`
copies; nothing here builds them.

## Prerequisites

- GNU Make, Git, and a POSIX shell. On Windows, use Git Bash. No Docker or other
  container is involved.
- Emscripten 4.0.13 (revision `2659582941bef14008476903f48941909db1b196`).
  Activate it with `emsdk_env`, or pass `EMSDK=/path/to/emsdk`.
- rustup, for `libdovi`. Its `rust-toolchain.toml` selects Rust 1.96.1 with the
  `wasm32-unknown-unknown` target.

## Commands

Run from the engine root:

```sh
make -C codecs sources            # Fetch the pinned FFmpeg and dcadec, once
make -C codecs all                # Rebuild every decoder into codecs/dist
make -C codecs check              # Rebuild every decoder and compare it with codecs/dist
make -C codecs ffmpeg-eac3        # Rebuild one kit
make -C codecs source-archives    # Write the release source tarballs to codecs/build/source-archives
make -C codecs clean
```

`-j5` builds the kits in parallel, and `JOBS` sets the parallelism inside each
FFmpeg build.

## How the build works

- **Pinned sources.** FFmpeg and dcadec are git submodules in `external/`,
  pinned to exact commits. They are marked `shallow` and `update = none`, so a
  recursive clone of the engine, or of an application embedding it, skips them
  until `make sources` fetches them.
- **Fresh source trees.** Each FFmpeg kit extracts a fresh copy of the pinned
  tree into `build/<kit>/` with `git archive`, then configures and builds it in
  place with only that kit's decoders. Building outside a git checkout keeps
  FFmpeg's embedded version string and source paths stable.
- **Configuration checks.** The build fails unless configure enabled exactly the
  whitelisted decoders and kept the LGPL scope, with no GPL, nonfree, or version
  3 components.
- **Deterministic environment.** The build fixes `SOURCE_DATE_EPOCH`, the
  locale, the time zone, and the Python hash seed. It ignores compiler variables
  from the calling environment, and refuses any Emscripten other than 4.0.13.
- **Line endings.** Emscripten on Windows writes CRLF into the JavaScript glue.
  The build normalizes the glue to LF, so committed outputs do not depend on the
  build host's line endings.
- **Rust panic paths.** Rust panics embed source paths, so the `libdovi` build
  maps the cargo home, crate, and target directories to fixed names.
- **`make check`** rebuilds everything and compares it byte for byte with
  `dist/`.

## Licensing and corresponding source

- The bridges and the `libdovi` crate are MIT, like the rest of the engine.
- FFmpeg and libdcadec are LGPL-2.1-or-later; `licenses/` holds their license
  texts.
- Each LGPL kit's `SOURCE.txt` names the exact upstream commit, the toolchain,
  and the build recipe. `scripts/build.mjs` serves it beside the decoder,
  together with the license, the bridge source, and the bridge license.
- For every release, attach the tarballs from `make source-archives`: the exact
  FFmpeg and dcadec trees, and the engine's `codecs/` sources.

## Layout

| Path | Content |
| --- | --- |
| `Makefile` | The build |
| `<kit>/` | Our bridge source and the kit's `SOURCE.txt` |
| `libdovi/` | Rust crate wrapping the `dolby_vision` RPU parser |
| `licenses/` | Upstream license texts |
| `external/` | FFmpeg and dcadec submodules |
| `dist/` | Committed build outputs |
| `build/` | Ignored build trees and source archives |
