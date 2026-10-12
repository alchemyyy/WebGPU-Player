# Scenarios

## 4K HDR10 on a 2560x1600 SDR panel, default preset

- Route: external, with no copy, once the external PQ key is authorized.
- One pass at output resolution, as today: a bilinear read of the external texture, then the neutralization inverse, PQ decode, tone mapping, gamut mapping, encode, and dither, written to the canvas.
- 2560x1440 is 3.7 million output pixels, drawn 24 times a second.
- CPU per draw: one uniform write, one import, one bind group, one draw, and one submit.

## The same, with a proper downscaler

- A separable scaler adds one pass and one intermediate: 2560x2160 as `rgba16float`, 44.2 MB.
- The horizontal pass reads the external texture with `textureLoad`.
- Every color step fuses into the vertical pass, at output resolution, which has the fewest pixels.

## 4K Dolby Vision Profile 7 with a full enhancement layer

- Route: planes, a 4K base layer and a 1080p enhancement layer, about 31 MB per frame copied in the worker and uploaded with `writeTexture`.
- With bilinear, reconstruction fuses into the scaler's taps.
- With a wide scaler, the planner inserts one reconstruction pass at source resolution, so reconstruction runs once per source pixel instead of once per tap.

## 1080p HDR10 upscaled to a 4K SDR display

- Default preset: one pass at output resolution.
  Bilinear does not ring, so tone mapping after it is correct, and 8.3 million tone-mapping evaluations a frame are cheaper than another pass.
- Quality preset with a luma doubler trained on SDR content:
  1. A 1080p pass reads the source, recovers the code values, decodes PQ, tone maps, gamut maps, encodes SDR gamma, and writes luma (`r16float`) and chroma (`rg16float`).
  2. The doubler's compute passes turn 1080p luma into 2160p luma, packed as 16-bit floats into a buffer of 16.6 MB, because compute passes cannot write `r16float` textures.
  3. One 4K pass upscales chroma, converts to RGB, dithers, and writes the canvas.
- The doubler's `sdr` domain forces tone mapping before it, which also puts it on the side with a quarter of the pixels.
- The output is exactly twice the source, so the planner drops the scaler.
- On a 2560x1440 panel, the doubler's condition (1.5x or more) keeps it off.
- The cost that matters is the doubler's arithmetic at 4K, which is where `shader-f16`, conditions, and per-pass GPU timing apply.

## HDR10 to an HDR display

- Canvas: `rgba16float` with extended tone mapping.
- The tone mapper targets the display peak from the settings, or passes through when the display reaches the content's peak.
- Gamut mapping targets the canvas color space, the output is extended range relative to SDR white, and there is no dither.

## UHD ProRes 422 HQ through a user decoder

- No engine route decodes ProRes, so a user decoder that accepts `apch` takes the stream once its vector passes.
- At UHD 23.976 fps, ProRes 422 HQ is about 700 Mbps, so each packet is about 3.7 MB.
- The worker demuxes the MOV and posts packets; the page writes each into the GPU ring and submits the decoder's dispatches after presenting.
- The decoder writes 10-bit 4:2:2 planes into a pool slot, 33.2 MB, and `SIGNAL` reads the slot directly.
- The CPU moves 3.7 MB per frame instead of decoding and uploading 33.2 MB, and no decoded pixel crosses between CPU and GPU.
