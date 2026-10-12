# Implementation

## Code it changes

| Current code | Today | In the new design |
| --- | --- | --- |
| `src/presentation/WebGPUPresenter.ts` | Owns the device and canvas, sizes the canvas, imports frames, encodes one fused draw | Owns the device and canvas, and hands frames to the executor |
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

A new folder that tools or tests name goes into `tools/constants.json`.

## Engine API

- `setPresentationPreset(preset)`: an ordered list of pass sources with parameter values; the host stores presets.
- `setPresentationParameter(passName, parameterName, value)`: a live parameter change.
- `getPresentationPlanReport()`: active passes, passes a condition turned off, domain conflicts, compile errors, and per-pass GPU time.

## Phases

1. Express today's pipeline as built-in passes behind the planner; the default preset compiles to the same fused shader and produces byte-identical output.
2. Planner features: kernels, intermediates, prescalers and scalers, placement, fusion, and aliasing.
3. User presets: manifest parsing, the prelude, parameters, error reporting, safe mode, and device-loss handling.
4. Temporal: history rings, persistent buffers, and reset rules.
5. HDR output: the `rgba16float` canvas, extended range, and built-in mappers that take a target peak.

## Validation

- The default preset matches the current renderer byte for byte, read back over the authorization vectors and frames from the codec vectors.
- Route keys, tolerances, and authorization outcomes stay unchanged.
- Each planner rule has unit tests over plan-time facts: placement, fusion, conditions, conflicts, and formats.
- Per-pass GPU time comes from `timestamp-query` when the device offers it, alongside the existing presented and dropped frame counters.
