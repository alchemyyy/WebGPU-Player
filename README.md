# WebGPU Player

<img src="images/webgpu-player-logo.svg" alt="WebGPU Player logo" width="160">

A WebGPU and WebCodecs media playback engine for the browser.
It plays sources that browsers cannot play natively, and presents HDR10, HDR10+, HLG, and Dolby Vision through its own color pipeline.
Every route is qualified in the running browser before a host may offer it.

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
- Emscripten 4.0.13 and rustup, to build the WebAssembly decoders once per checkout.
  - Activate Emscripten with `emsdk_env`, or name it with `EMSDK`.
  - The repository pins Rust 1.96.1 with the `wasm32-unknown-unknown` target.
- On Windows, long path support.
  - The decoder build's FFmpeg and cargo trees pass 260 characters in a nested checkout.
  - Enable `LongPathsEnabled` and Git's `core.longpaths`.
  - GNU Make and the MSVC linker that cargo uses must accept long paths too.

Only for specific tasks:

- Python 3.10 or later and the pinned FFmpeg and FFprobe build (`2026-03-01-git-862338fe31-full_build-www.gyan.dev`), to generate or check the codec vectors.
- MKVToolNix, for the Dolby Vision smoke media scripts.
- mdBook 0.5.4, to build the documentation.
- Chrome, Edge, or Firefox with WebGPU and WebCodecs, on a secure context (HTTPS or `localhost`), to run the engine.
  Firefox on Windows decodes HEVC in software only, which is below real time at 4K.

## Quick start

```sh
npm ci
make -C wasm sources all   # The WebAssembly decoders, once per checkout
npm run typecheck
npm run lint
npm test
npm run build
```

[Set up a checkout](docs/src/setup.md) lists the toolchain, and [Embedding the engine](docs/src/embedding.md) shows how a host uses it.

## Credits

- [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) demuxes media and remuxes audio to fragmented MP4.
  Its [`@mediabunny/ac3`](https://www.npmjs.com/package/@mediabunny/ac3) extension supplies the AC-3 decoder.
- [FFmpeg](https://ffmpeg.org/) (LGPL-2.1-or-later) supplies the E-AC-3, TrueHD and MLP, MPEG-2 Video, and VC-1 decoders, built from a pinned revision.
- [libdcadec](https://github.com/foo86/dcadec) (LGPL-2.1-or-later) supplies the DTS decoder, DTS-HD MA included.
- [hevc.js](https://github.com/privaloops/hevc.js) (MIT) supplies the software HEVC decoder.
- [OpenJPEG](https://www.openjpeg.org/) (BSD-2-Clause), through `@cornerstonejs/codec-openjpeg` (MIT), supplies the JPEG 2000 decoder.
- The `dolby_vision` crate from [dovi_tool](https://github.com/quietvoid/dovi_tool) (MIT) parses Dolby Vision RPUs.

## License

The engine's own code is MIT; see [LICENSE](LICENSE).
Bundled third-party decoders keep their own licenses, and their license texts ship beside each decoder in the served assets.
The corresponding source of the LGPL decoders is published with each release; see [WebAssembly decoders](docs/src/decoders.md#licenses).
