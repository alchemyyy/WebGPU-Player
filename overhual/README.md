# Presentation overhaul

This folder designs a user-extensible WGSL presentation pipeline for the engine.
It is a design, not an implementation; nothing here describes shipped behavior unless it says so.
The book in `docs/` remains the reference for what the engine does today.

## Decisions

- Shaders are WGSL only.
- Presentation steps are replaceable, including the built-in scaler and tone mapper.
- Presets belong to each user's browser: the engine exposes an API, and the host stores and supplies presets.
- Temporal passes, which read earlier frames, are in scope.
- Users can drop in WGSL compute decoders for video; they run on the presenter's device, so decoded frames never leave the GPU.
  Audio is out of scope.
- The design target is 4K UHD Blu-ray content on a modern laptop: no avoidable copies and no avoidable CPU work.

## Files

| File | Covers |
| --- | --- |
| [principles.md](principles.md) | The target workload and the efficiency rules every part follows |
| [pipeline.md](pipeline.md) | The stage spine, ingress, authorization, scaling, output, and the replaceable boundary |
| [color.md](color.md) | Color states, transitions, tone mapping placement, dithering, and HDR output |
| [passes.md](passes.md) | Pass shapes, the shader file format, the generated prelude, and failure handling |
| [planning.md](planning.md) | The planner, the per-frame executor, formats, and invalidation |
| [temporal.md](temporal.md) | History rings, persistent state, and reset rules |
| [decoders.md](decoders.md) | User WGSL compute decoders for video: the module, the route, verification, and failures |
| [scenarios.md](scenarios.md) | Worked plans for typical inputs and displays |
| [implementation.md](implementation.md) | The code it changes, proposed modules, migration phases, and validation |

## Open questions

1. Default scaler: keep bilinear, the byte-identical baseline, or default to a proper downscaler, which costs one pass and one intermediate.
2. Native-resolution chroma on the external route: let the planner move a session to the plane route, with its CPU copy, or make passes that need it unavailable there.
3. Redraw source on the external route: the presenter closes a `VideoFrame` right after submitting it, so a redraw without a new frame (a resize or a parameter change while paused) has nothing to read.
   The options are holding the last frame until its successor arrives, which keeps one decoder credit longer, or keeping an owned copy only while paused.
4. The versioning policy of the metadata contract that user shaders bind to.
5. 3D LUT assets in the first version.
6. Display knowledge for HDR output: settings for the display peak and SDR white, or values the browser exposes.
7. Whether the demuxer can pass through packets of codecs it does not recognize, which decides the containers user decoders can read.
8. Whether decoders without a conformance vector are allowed at all, or only when the user forces them.
