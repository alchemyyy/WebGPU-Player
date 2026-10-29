# WebGPU Player

<img src="images/webgpu-player-logo.svg" alt="WebGPU Player logo" width="160">

A WebGPU and WebCodecs media playback engine for the browser.
It plays sources that browsers cannot play natively, and presents HDR10, HDR10+, HLG, and Dolby Vision through its own color pipeline.
Every native route is qualified in the running browser before a host may offer it.
Codecs no browser decodes play through decoder packages a host loads at runtime: WGSL video decoders that run on the GPU, and WebAssembly audio decoders.

The documentation is a book in [docs/](docs/src/SUMMARY.md), written for [mdBook](https://github.com/rust-lang/mdBook).
Read the Markdown in place, or build and serve it:

```sh
cargo install mdbook --version 0.5.4 --locked
mdbook serve docs --open
```

## Requirements

Required:

- Node.js 24 or later and npm 11 or later.
- Git, GNU Make, and a POSIX shell (Git Bash on Windows).
- Emscripten 4.0.13 and rustup, to build the engine's WebAssembly modules and the decoder projects' packages once per checkout.
  - Name an emsdk with `EMSDK`, which `emsdk_env` sets, or let `make -C wasm emsdk` (or `./build.sh`) install the pinned Emscripten into `bin/emsdk/`, which needs Python 3.
  - The repository pins Rust 1.96.1 with the `wasm32-unknown-unknown` target.
- On Windows, long path support.
  - The decoder projects' FFmpeg and cargo trees pass 260 characters in a nested checkout.
  - Enable `LongPathsEnabled` and Git's `core.longpaths`.
  - GNU Make and the MSVC linker that cargo uses must accept long paths too.

Only for specific tasks:

- Python 3.10 or later and the pinned FFmpeg and FFprobe build (`2026-03-01-git-862338fe31-full_build-www.gyan.dev`), to generate or check the codec vectors.
- MKVToolNix, for the Dolby Vision smoke media scripts.
- mdBook 0.5.4, to build the documentation.
- Chrome, Edge, or Firefox with WebGPU and WebCodecs, on a secure context (HTTPS or `localhost`), to run the engine.
  Firefox on Windows has no WebCodecs HEVC, so HEVC plays there only through a GPU decoder package.

## Quick start

```sh
npm ci
make -C wasm all           # The engine's WebAssembly modules, once per checkout
make -C wgpud sources      # The pinned FFmpeg and dcadec, once per checkout
npm run decoders           # The decoder packages, which their projects' tests load
npm run typecheck
npm run lint
npm test
npm run build
```

[Set up a checkout](docs/src/setup.md) lists the toolchain, and [Embedding the engine](docs/src/embedding.md) shows how a host uses it.

## Credits

- [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) demuxes media and remuxes audio to fragmented MP4.
- [FFmpeg](https://ffmpeg.org/) (LGPL-2.1-or-later), built from a pinned revision, is the AC-3 and E-AC-3, the TrueHD and MLP, and the WMA decoder packages; the TrueHD package's 16-channel Atmos decoder is a port of its MLP decoder.
- The MIT KEMAR measurements of Bill Gardner and Keith Martin (MIT Media Lab, 1994) are the head-related impulse responses of the Atmos binaural renderer in the E-AC-3 and TrueHD packages.
- [libdcadec](https://github.com/foo86/dcadec) (LGPL-2.1-or-later) is the DTS decoder package, DTS-HD MA included.
- The `dolby_vision` crate from [dovi_tool](https://github.com/quietvoid/dovi_tool) (MIT) parses Dolby Vision RPUs.

## License

The engine's own code is MIT; see [LICENSE](LICENSE).
The engine ships no decoder.
The decoder packages built from FFmpeg and libdcadec are LGPL-2.1-or-later, and whoever distributes them offers their corresponding source; see [WebAssembly build](docs/src/decoders.md#licenses).
