# Pipeline

The pipeline has two tracks.
The spatial spine says where pixels are and at what resolution.
The color track says what the values mean; it is described in [color.md](color.md).
A pass hooks a stage of the spine and declares the color domain it requires, and the planner arranges both tracks to satisfy every active pass.

## Spatial spine

| Stage | Resolution | Contents | Built-in default | Replaceable |
| --- | --- | --- | --- | --- |
| `SOURCE` | coded | What ingress delivers: an external texture, YUV planes and a Dolby Vision enhancement layer, or a user decoder's planes in GPU memory | Ingress | No |
| `SIGNAL` | source | Decoded code values: YUV planes, or code values recovered from the external RGB | Neutralization inverse, Dolby Vision reshaping and composing | No |
| `RGB` | source | RGB in the source's primaries and transfer function | YUV to RGB matrix and range | Yes |
| prescalers | fixed ratios | Fixed-ratio upscalers, such as luma doublers | None | Yes |
| `SCALE` | source to output | Exactly the output rectangle | Bilinear | Yes |
| `OUTPUT` | output | Display resolution and display color space | Encode and dither | Yes |

- Stages are conceptual.
  A stage becomes a texture only when a kernel reads it; otherwise its work fuses into a neighboring pass and it never exists in memory.
- The default preset fuses into one pass, as today: per output pixel, read the source, reconstruct, convert, tone map, gamut map, encode, and dither.
- A hook can hold several passes, which save and read named textures.
- Tone mapping and gamut mapping are color transitions, not stages; the planner places them.

## The replaceable boundary

Everything up to `SIGNAL` is equivalent to decoding, so it is fixed.
Everything after it is presentation, so it is replaceable.
Route authorization checks only the fixed part, so a user preset never changes which route a session takes.
A user decoder replaces decoding itself for the streams it takes: it produces the planes that `SIGNAL` reads, and its conformance vector stands in for authorization (see [decoders.md](decoders.md)).

## Ingress

- External route: a WebCodecs `VideoFrame` imported with `importExternalTexture`, with no copy.
  - For HDR, the decoder receives access units whose color description says BT.709 (`rewriteHEVCAccessUnitColorDescriptionToBT709`), so the browser applies its plain SDR conversion instead of its own HDR handling.
  - The fixed `SIGNAL` step inverts the BT.709 matrix and limited range to recover the original 10-bit code values, and the color track does the real BT.2020 and PQ math.
  - Luma arrives at full resolution; chroma arrives already upsampled by the browser.
- Plane route: the worker copies the decoded frame into a buffer of 256-byte-aligned rows and transfers it, and the page uploads each plane with `queue.writeTexture` into integer textures (`r8uint`, `rg8uint`, `r16uint`).
  - Chroma arrives at native resolution.
  - Dolby Vision with an enhancement layer uses this route, with both layers in one compound buffer.
- GPU decode route: a user WGSL decoder writes planes into a frame pool on the presenter's device, and the only transfer is the compressed packet (see [decoders.md](decoders.md)).
- The plane route's round trip (hardware decode, `copyTo`, upload) is the largest copy left on a laptop.
  WebGPU exposes no GPU-side access to a `VideoFrame`'s planes, and a mapped GPU buffer cannot be handed to the decode worker.
  So this design cannot remove that copy; it only never adds to it and never forces the plane route without need.

## Authorization

Today, a route that presents HDR or Dolby Vision is authorized per GPU device before use.
The check renders a known vector through the production shader, reads it back, and compares it with the CPU reference: within 10/255 for external HDR, 8/255 for external Dolby Vision, and 3/255 for raw.
The result is kept per device, keyed by route key and shader signature, and checked again after a device loss.

In the new design:
- Authorization always runs the built-in default chain, never the user's preset.
- Its shader signature covers only the fixed stages and that reference chain, so preset changes never trigger a new check.
- A failed route falls back as today: the external route to raw planes when the raw key passes, otherwise no custom route.

## Scaling

- A prescaler has a fixed ratio and runs only while its condition holds, for example at 1.5x upscaling or more.
- The scaler takes whatever size the prescalers produced and writes exactly the output rectangle, including letterboxing.
- When the output equals the scaler's input size, the planner drops the scaler.
- The canvas backing size is the CSS size times the device pixel ratio, capped by `maxTextureDimension2D` (`WebGPUPresenter.synchronizeCanvasGeometry`), so the browser composites the result 1:1.

## Output

| Target | Canvas | Notes |
| --- | --- | --- |
| SDR | `bgra8unorm`, `srgb` | Encoded and dithered in the shader |
| Wide-gamut SDR | `bgra8unorm`, `display-p3` | The gamut transition targets P3 |
| HDR | `rgba16float`, extended tone mapping | Extended-range values relative to SDR white; no dither |

The engine outputs SDR only today (`OutputTransfer` is `'srgb'`).

## Combinations

| Input -> output | Color track |
| --- | --- |
| SDR -> SDR | Decode gamma, convert gamut when needed, encode, dither |
| SDR -> HDR | Decode, optionally expand into the display's headroom, output extended range |
| HDR -> SDR | Decode PQ or HLG, tone map to the SDR peak, gamut map, encode, dither |
| HDR -> HDR | Decode, tone map to the display's peak or pass through, gamut map, output extended range |
| Dolby Vision or HDR10+ -> either | Fixed reconstruction, then the dynamic metadata drives the mapping to the target peak |
