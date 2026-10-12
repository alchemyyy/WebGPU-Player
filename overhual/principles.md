# Principles

## Target workload

- 4K UHD Blu-ray content: HEVC Main 10 with PQ, often Dolby Vision Profile 7 with a full enhancement layer, mostly at 23.976 fps.
- A modern laptop: an integrated or mid-range GPU sharing memory with the CPU, a panel usually smaller than 4K, and battery and thermal limits.
- The same rules hold for every other combination, such as 1080p HDR10 upscaled to a 4K display.

## Rules

- Demand-driven: nothing is computed, copied, or kept unless an active pass reads it.
- Plan once, encode cheaply: compilation and allocation happen only when the plan changes.
- Draw only when something changed: a new frame, a parameter, the plan, or the size.
- Fuse per-pixel work: a color function never gets a pass of its own.
- Intermediate textures exist only where a kernel reads neighboring pixels.
- The last pass writes the canvas texture directly.
- History is owned, never copied: stages render straight into ring textures.
- No CPU readbacks on the playback path: per-frame statistics stay in GPU buffers that later passes read.
- No allocation, compilation, or bind group creation per frame, except the bind group of an imported external texture, which WebGPU requires.

## Per-frame CPU work

1. One uniform buffer write: frame globals, color metadata, and dynamic HDR metadata.
2. On the external route, one `importExternalTexture` and the bind group that references it.
3. One encode per active pass.
4. One `submit`.

On the GPU decode route, each frame adds one packet write, at compressed size, and the decoder's dispatches.

`CustomDecodeSession.takeFrame` already hands each frame out once: it returns a frame only when a newer one is due, and drops older due frames.
So the presenter receives 24 frames a second for 23.976 fps content, whatever the panel's refresh rate.

## Sizes

| Item | Size |
| --- | --- |
| 4K 10-bit 4:2:0 frame | about 25 MB |
| 1080p 10-bit 4:2:0 frame | 6.2 MB |
| Dolby Vision Profile 7 base and enhancement layers | about 31 MB |
| 4K `rgba16float` texture | 66.4 MB |
| 4K `r16float` texture | 16.6 MB |
| 1080p `rgba16float` texture | 16.6 MB |
| 4K `bgra8unorm` canvas | 33.2 MB |
