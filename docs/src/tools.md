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

## DTS downmix report

```sh
npx --no-install vite-node --script tools/report_dts_downmix_reference.ts --check
```

`report_dts_downmix_reference.ts` prints the DTS downmix fingerprint report.
With `--check` it fails unless every decoded stereo fingerprint matches the qualification fingerprint in `src/capability/vectors/test/dts/packets.json`.
It runs the DTS decoder from `bin/wasm/`, so build the decoders first.

## Browser probes

| File | Does |
| --- | --- |
| `run-dolby-vision-worker-smoke.mjs` | Runs a Dolby Vision Profile 7 FEL decode in the prebuilt custom decode worker through Chromium remote debugging. The worker defaults to `libraries/webgpu-player/CustomDecode.worker.js`, relative to `--frontend-url` |
| `probe-browser-runtime.mjs` | Configuration-only browser diagnostics |
| `probe_dynamic_HDR_shader.py`, `probe-dynamic-HDR-shader-browser.mjs`, `emit_dynamic_HDR_shader.ts`, `probe_dynamic_HDR_vector.ts` | Compile the production HDR10+ WGSL in headless Chromium |
