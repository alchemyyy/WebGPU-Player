# Tools

`tools/` holds development and validation tooling.
Nothing in it ships.
Run every command from the engine root.
`tools/constants.json` is described in [Repository layout](layout.md#folder-names-live-in-one-file).

## Diagram renderer

```sh
node tools/render-diagrams.mjs [--check | --watch] [book directory ...]
```

`render-diagrams.mjs` renders each book's PlantUML sources from `diagrams/` into light and dark SVGs in `src/diagrams/`, and removes SVGs whose source is gone.
With no book directory it renders this book; the Jellyfin plugin passes its own `docs/` too.
`--check` renders into a temporary folder and fails on any difference.
It needs Java, and downloads the pinned PlantUML jar into `bin/plantuml/` on first use.
See [Maintaining this book](maintaining.md#diagrams).

## Decoder package tools

```sh
node tools/pack-decoder-package.mjs --decoder <source> [--module <module.wasm>] [--vectors <vectors>] --output <package.wasm>
```

`pack-decoder-package.mjs` packs one [decoder package](decoder-packages.md) by hand: a decoder source, the module of its parser or audio decoder, and its vectors file.
It checks the result with the engine's own loader, so a package it writes loads wherever the engine runs.
`decoder-package-format.mjs` holds the writer it shares with `scripts/decoder-packages.mjs`, which builds the decoder projects (see [WebAssembly build](decoders.md#decoder-projects)).

## mpv shader converter

```sh
python tools/convert_mpv_shader.py <input.glsl> <output.wgsl> [--name <name>] [--naga <executable>]
```

`convert_mpv_shader.py` converts an mpv or libplacebo user shader into a pass file, through naga-cli 30.0.1, and reports where the result differs from mpv.
Its tests are in `tools/test/`.
See [Migrate an mpv shader to a wgpup](mpv-shaders.md).

## Cube LUT converter

```sh
python tools/convert_cube_lut.py <input.cube> <output.wgsl> [--name <name>] [--hook <stage>] [--domain <domain>]
```

`convert_cube_lut.py` turns a `.cube` 3D LUT into a pass file: one color pass that grades each pixel through the LUT, which the file holds as a three-dimensional texture block of half floats, read trilinearly at texel centers over the LUT's `DOMAIN_MIN` and `DOMAIN_MAX`.
By default the pass grades the source's encoded RGB, at `RGB` in the `source` domain, which a LUT made for Rec. 709 video expects of an SDR source; `--hook OUTPUT --domain sdr` grades what the display shows instead.
The pass name defaults to the LUT's `TITLE`, else the file's name.
A 1D LUT, a size outside 2 to 256, or a table of the wrong length does not convert, with a code and a detail.
`pass_texture_block.py` writes the texture block, as the mpv shader converter does for a `TEXTURE`.
Its tests are in `tools/test/`.
See [Texture blocks](new-pass.md#texture-blocks).

## Browser probes

| File | Does |
| --- | --- |
| `probe-browser-runtime.mjs` | Configuration-only browser diagnostics |
| `probe_dynamic_HDR_shader.py`, `probe-dynamic-HDR-shader-browser.mjs`, `emit_dynamic_HDR_shader.ts`, `probe_dynamic_HDR_vector.ts` | Compile the production HDR10+ WGSL in headless Chromium |
