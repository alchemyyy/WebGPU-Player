# Color

## Color state

Every texture and every pass input has a color state:
- primaries: BT.709, BT.2020, P3, or BT.601;
- transfer function: gamma (BT.1886), sRGB, PQ, HLG, or linear;
- for YUV, the matrix and the range;
- metadata: static (mastering display, MaxCLL, MaxFALL) and dynamic (the HDR10+ curve, Dolby Vision trims).

A pass declares the domain it requires on input:

| Domain | Meaning |
| --- | --- |
| `source` | The source's own encoding, for example PQ BT.2020 |
| `linear` | Linear light in the working primaries |
| `sdr` | SDR gamma-encoded RGB, which scalers trained on SDR content expect |
| `display` | The display's color space |
| `any` | No requirement, for example bilinear |

## Transitions

| Transition | Runs | Notes |
| --- | --- | --- |
| Transfer decode and encode | Per pixel | PQ, HLG with its OOTF, gamma, sRGB |
| Gamut mapping | Per pixel | BT.2020 to BT.709 or P3; the built-in maps chroma in IPT with a hull |
| Tone mapping | Per pixel | HDR to a lower peak; irreversible |
| Inverse tone mapping | Per pixel | SDR into an HDR display's headroom; user-supplied |
| Dither | Per output pixel | Pinned to the last pass |

The built-in mappers are today's: the operators in `RenderSettings.ts` (`aces`, `reinhard`, `spline`), the HDR10+ curves, and the Dolby Vision trims.
As replaceable passes they take the target peak as a parameter instead of assuming SDR.

## Tone mapping placement

Tone mapping belongs to the color track, not to a stage.
- The planner places the HDR to SDR transition immediately before the first pass whose domain requires SDR.
- With no such pass, it places the transition by cost: on the side of the scaler with fewer pixels when a pass already exists there, otherwise fused into the output pass.
- Tone mapping cannot be undone, so a pass that requires HDR after an SDR pass is a conflict, reported when the plan is built.
- An SDR-trained scaler with HDR output is the same conflict, unless its author declares `domain: any`.

## Dithering

- 8-bit SDR output dithers in the encoded domain, in the shader, immediately before quantization.
  This is why the engine encodes sRGB itself instead of writing linear values through an `-srgb` view format, which would leave only linear values to dither.
- A float16 HDR canvas is quantized by the compositor, so the planner drops the dither step.
- Dither never runs before a scaler, which would smear its noise.

## Video HDR versus rendering HDR

Rendering tutorials, such as the HDR chapter of Learn Wgpu, tone map scene-linear light of arbitrary exposure with a filmic per-channel curve.
Video HDR is display-referred: PQ code values are absolute luminance, mastered up to 1000 to 4000 nits, and carry metadata.
A faithful mapping leaves the SDR range mostly alone, rolls off only what the target cannot show, drives the curve from the metadata, and preserves hue.
The plumbing those tutorials describe carries over unchanged: float intermediates, a final tone-mapping pass, and compute passes that write storage textures.

## HDR output

- A WebGPU HDR canvas takes extended-range values relative to SDR white, not PQ code values, and the browser and the OS map them to the panel.
- The page cannot reliably learn the display's peak or the OS's SDR white level; at best the `dynamic-range` media query reports an HDR display.
- The render settings `outputPeakNits` and `paperWhiteNits` become the display peak and SDR white for HDR output, set by the user unless the browser exposes them.

## References

- ITU-R BT.2100: PQ and HLG.
- ITU-R BT.2390: the reference EETF for mapping PQ to a lower peak.
- ITU-R BT.2408: 203-nit HDR reference white.
- SMPTE ST 2094-40: HDR10+ dynamic metadata.
- The Dolby Vision specifications: RPU reshaping, composing, and display management.
