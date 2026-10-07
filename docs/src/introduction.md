# WebGPU Player

WebGPU Player is a media playback engine for the browser. It plays sources a
browser cannot play natively, and presents HDR and Dolby Vision through its own
color pipeline.

- Demux: [Mediabunny](https://github.com/Vanilagy/mediabunny), in a worker.
- Decode: WebCodecs, or WebAssembly decoders built from FFmpeg, libdcadec,
  hevc.js, and OpenJPEG.
- Present: WebGPU, with tone mapping for HDR10, HDR10+, HLG, and Dolby Vision.
- Audio: an AudioWorklet output that owns the playback clock.

The engine gives a host page two layers:

1. A custom pipeline for direct-play sources the browser has qualified. Demux,
   decode, presentation, and audio all run in the engine.
2. WebGPU presentation of frames the host's own `<video>` element decodes, for
   color control of SDR video.

Nothing is offered until the running browser has proven it. A decode route is
qualified by decoding a known stream and checking the exact output. An HDR or
Dolby Vision presentation is authorized by rendering a known input through the
production shader on the current GPU device.

The engine knows nothing about Jellyfin. Its host today is the Jellyfin plugin
`jellyfin-plugin-webgpu-player`: the plugin's web client add-on embeds the
engine as a git submodule at `jellyfin-webgpu-client/vendor/webgpu-player/`,
and supplies the Jellyfin player, the device profile, the settings, and the
HTML fallback. See [The Jellyfin host](jellyfin-host.md).

## Invariants

- Negotiation advertises only what the selected route implements and has
  exact-output evidence for. A route is never gated on resolution, level, frame
  rate, bitrate, or a throughput benchmark.
- `capability/CustomContainerCodecSupport.ts` is the only table of which
  container carries which codec. There are no decoder pair blacklists.
- A failure in the custom pipeline falls back to the host's HTML player in the
  same session, or asks for one renegotiation. A player is never selected
  recursively.
- WebGPU needs a secure context. Validate over HTTPS against a local server. A
  successful negotiation is not a successful playback.

## Conventions

- Engine paths are relative to the engine root. Paths inside `src/` may drop
  the prefix; `capability/`, `pipeline/`, `audio/`, `video/`, `presentation/`,
  `color/`, and `validation/` are its domains.
- Host paths are relative to the plugin repository root and marked (host), for
  example `jellyfin-webgpu-client/src/WebGPUPlayer.ts` (host).
- Symbols are written `file:symbol` or `Class.method`.

## Where to look

| To | Read |
| --- | --- |
| Build and test a checkout | [Set up a checkout](setup.md) |
| Find a folder or a file | [Repository layout](layout.md), [Module map](module-map.md) |
| Follow a playback session | [Architecture](architecture.md) |
| Learn why a source plays or not | [Negotiation and routes](negotiation.md), [HEVC and Dolby Vision support](codec-support.md) |
| Put the engine in a page | [Embedding the engine](embedding.md), [The Jellyfin host](jellyfin-host.md) |
| Change a decoder or a vector | [WebAssembly decoders](decoders.md), [Codec vectors](codec-vectors.md), [Recipes](recipes.md) |
| Avoid repeating an investigation | [Decisions](decisions.md) |
