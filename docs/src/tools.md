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

## Browser probes

| File | Does |
| --- | --- |
| `probe-browser-runtime.mjs` | Configuration-only browser diagnostics |
| `probe_dynamic_HDR_shader.py`, `probe-dynamic-HDR-shader-browser.mjs`, `emit_dynamic_HDR_shader.ts`, `probe_dynamic_HDR_vector.ts` | Compile the production HDR10+ WGSL in headless Chromium |
