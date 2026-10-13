# Implementation

## Code it changes

| Current code | Today | In the new design |
| --- | --- | --- |
| `src/presentation/WebGPUPresenter.ts` | Owns the device and canvas, sizes the canvas, imports frames, encodes one fused draw | Owns the device and canvas, creates the device with the features and limits that passes and decoders declare, and hands frames to the executor |
| `src/pipeline/CustomDecode.worker.ts`, `src/pipeline/DecodeWorkerProtocol.ts` | Demux, decode, and post frames | Also post compressed packets for the GPU decode route |
| `src/pipeline/CustomDecodeSession.ts` | Queues frames and returns their credits | Also queues decoded pool slots, whose free count is the route's credits |
| `src/color/ColorPipelineShader.ts` | Generates one fused WGSL shader per format and route | Its pieces become built-in passes: plane sampling, the neutralization inverse, Dolby Vision reconstruction, conversion, tone and gamut mapping, encode, and dither |
| `src/presentation/identity.wgsl.ts` | The SDR external shader: one bilinear sample | The SDR default preset |
| `src/presentation/RawYUVGPURenderer.ts` | Plane textures and `writeTexture` uploads | The plane route's ingress |
| `src/presentation/RenderSettings.ts` | The fused shader's 144-byte uniform | Parameters of the built-in passes and part of the globals |
| `src/validation/*Authorization.ts` | Render the production shader | Render the built-in default chain, with a signature over the fixed stages |

## Proposed modules

All under `src/presentation/passes/`:
- `PassManifest.ts`: parses and validates a pass's `//!` header into a typed manifest.
- `PassPrelude.ts`: generates a pass's prelude from its manifest and the plan.
- `PresentationPlanner.ts`: builds an immutable plan from a preset and the plan-time facts.
- `PresentationExecutor.ts`: encodes one frame from a plan.
- `TexturePool.ts`: textures pooled by size and format, with lifetime aliasing.
- `HistoryRing.ts`: rings of owned textures and persistent buffers.
- `builtin/`: the built-in passes, as `.wgsl.ts` modules like `identity.wgsl.ts`.

All under `src/video/gpu-decode/`:
- `GPUDecoderManifest.ts`: parses and validates a decoder's `//!` header.
- `GPUDecoderPrelude.ts`: generates a decoder's bindings and helpers.
- `GPUVideoDecodeSession.ts`: runs a decoder on the presenter's device: the packet ring, dispatches, pacing, and slot release.
- `GPUFramePool.ts`: the pool buffer, its slots, and their lifetimes.
- `GPUDecoderVectorCheck.ts`: the per-device conformance check and its cache.
- `GPUDecoderSelection.ts`: matches streams to installed decoders under the selection policy.

A new folder that tools or tests name goes into `tools/constants.json`.

## Engine API

- `setPresentationPreset(files)`: an ordered list of pass files, each a source of one or more passes with parameter values; the host stores presets.
- `setPresentationParameter(passName, parameterName, value)`: a live parameter change.
- `getPresentationPlanReport()`: active passes, passes a condition turned off, domain conflicts, compile errors, and per-pass GPU time.
- `setGPUDecoders(decoders)`: decoder sources with their conformance vectors; the host stores them.
- `getGPUDecoderReport()`: per decoder, the streams it accepts, its vector result on this device, its last error, and its GPU time per frame.
- `getGPUDecodableStreams()`: what the installed, verified decoders can play, for a host that advertises playback capabilities.

## Phases

1. Express today's pipeline as built-in passes behind the planner; the default preset compiles to the same fused shader and produces byte-identical output.
2. Planner features: kernels, intermediates, prescalers and scalers, placement, fusion, and aliasing.
3. User presets: manifest parsing, the prelude, parameters, error reporting, safe mode, and device-loss handling.
4. Temporal: history rings, persistent buffers, and reset rules.
5. HDR output: the `rgba16float` canvas, extended range, and built-in mappers that take a target peak.
6. GPU decoders: the module contract, packet transport, the frame pool, `SIGNAL` reads from buffers, vector checks, selection, and pacing.

## Validation

- The default preset matches the current renderer byte for byte, read back over the authorization vectors and frames from the codec vectors.
- Route keys, tolerances, and authorization outcomes stay unchanged.
- Each planner rule has unit tests over plan-time facts: placement, fusion, conditions, conflicts, and formats.
- Per-pass GPU time comes from `timestamp-query` when the device offers it, alongside the existing presented and dropped frame counters.
- A trivial decoder that copies uncompressed packets into the pool exercises the GPU decode route end to end: transport, slots, reordering, seeking, pacing, and device loss.
- A decoder's vector check is also its regression test.
