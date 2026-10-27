# Bundled passes

`wgpup/` holds the pass projects: WGSL passes the engine bundles for a host to offer as optional user passes.
Its name marks them as this player's own module type, as `wgpud/` marks the decoder projects.
The engine never loads a pass on its own: a host adds one to its users' presentation preset through `WebGPUPresenter.setPresentationPreset`, as it adds any pass file a user picks.

## Projects

A pass project is a folder of `wgpup/` whose top-level WGSL files are its pass files.
Each file holds one or more passes in the [pass file format](new-pass.md), which run in file order, and no two projects use the same file name.

| Project | Pass files | What it does |
| --- | --- | --- |
| `sharpen` | `sharpen.wgsl` | A 3x3 kernel on the OUTPUT stage that moves each pixel away from the mean of its 8 neighbors, by its `strength` parameter |
| `saturation` | `saturation.wgsl` | A color pass on the OUTPUT stage that scales chroma around BT.709 luma, by its `saturation` parameter |
| `temporal-blend` | `temporal-blend.wgsl` | A kernel on the RGB stage that blends toward the previous frame while history is valid, by its `blend` parameter |
| `smooth-motion` | `smooth-motion.wgsl` | A kernel on the OUTPUT stage that draws at the display rate and blends the two frames a refresh spans by the share each covers; see [Smooth motion](#smooth-motion) |
| `catmull-rom` | `catmull-rom.wgsl` | A 4x4 Catmull-Rom scaler that replaces the built-in bilinear scaler; its taps read texel centers, so the result does not depend on the input's filtering |
| `anime4k` | `Anime4K_Upscale_Denoise_CNN_x2_L.wgsl`, `Anime4K_Upscale_Denoise_CNN_x2_UL.wgsl` | Anime4K v3.2's Upscale+Denoise CNN x2 networks, on the PRESCALE stage when the output is more than 1.2 times the source on each axis |
| `nis` | `NVScaler.wgsl`, `NVSharpen.wgsl` | NVIDIA Image Scaling v1.0.2, a vendor-neutral spatial scaler with sharpening, on the LUMA plane: the scaler when the output is larger than the luma plane, the sharpener when they match |

Every pass file keeps the rules that `test/presentation/passes/PostprocessingPasses.test.ts` checks: each pass parses, defines its shape's entry point, reads exactly the parameters it declares, reads each input through its accessors, and reaches engine data only through the presentation globals.
The presenter, manifest, and pipeline graph tests run the four simple passes as well, and the presenter tests run smooth motion.

## Build and offer

`npm run build` copies every pass file into `bin/wgpup/`, flat, beside the served assets but outside their asset key, and fails on two files of one name.
A host serves that folder and offers its files, and the sandbox's shader panel lists them through its dev server (see [Sandbox](sandbox.md)).

## Anime4K

`wgpup/anime4k/glsl/` holds the two upstream mpv shaders, copied unmodified from [bloc97/Anime4K](https://github.com/bloc97/Anime4K) at commit `7684e9586f8dcc738af08a1cdceb024cc184f426`.
Its `PROVENANCE.txt` lists their SHA-256, which the pass tests check, and `wgpup/licenses/Anime4K-LICENSE` is the upstream MIT license.
The generators beside them turn a shader's convolution and depth-to-space passes into a pass file, with the weights copied verbatim:

- `generate_anime4k_wgsl.py` fuses the whole network into one compute pass: each workgroup evaluates a 16x16 source tile in workgroup memory, with a halo of one pixel per layer, and writes the 2x image with the bilinear-upscaled input added.
  It takes networks of 8-channel hidden layers whose tiles fit the default 16 KiB of workgroup storage, as L's do.
- `generate_anime4k_wgsl_chain.py` writes one compute pass per layer into one file: each layer stores its 4-channel parts side by side in an rgba16float texture, and the last layer does the depth-to-space step and adds the bilinear-upscaled input.
  UL's eight layers become the eight passes of its file.

The generated pass files are committed, so a build needs no Python.
`tools/convert_mpv_shader.py` converts these shaders too, pass for pass (see [Migrate an mpv shader to a wgpup](mpv-shaders.md)); the generators fuse each network into fewer passes instead.
To regenerate them, run from the engine root:

```sh
python wgpup/anime4k/generate_anime4k_wgsl.py wgpup/anime4k/glsl/Anime4K_Upscale_Denoise_CNN_x2_L.glsl wgpup/anime4k/Anime4K_Upscale_Denoise_CNN_x2_L.wgsl
python wgpup/anime4k/generate_anime4k_wgsl_chain.py wgpup/anime4k/glsl/Anime4K_Upscale_Denoise_CNN_x2_UL.glsl wgpup/anime4k/Anime4K_Upscale_Denoise_CNN_x2_UL.wgsl
```

## Smooth motion

In `smooth-motion.wgsl`, each display refresh shows the frames it spans, the newest and the one before it, blended by the share of the refresh each covers, as libplacebo's `oversample` mixer, which mpv documents as SmoothMotion, does.
A refresh within one frame shows that frame untouched, and so does every refresh while the clock stands still, so a paused picture shows one frame.
The blend runs in linear light of the display's sRGB encoding, extended past 1 and mirrored below 0 on an HDR canvas.

Whether frames blend is decided on every draw, from the refreshes a frame lasts: the media time between the stream's recent frames over the media time a refresh covers at the clock's rate, so a playback rate, a new frame rate, or another display takes effect within frames.
Its `mode` constant picks when frames blend:

- 0, the default: only where there would be motion judder without it, when a frame lasts no whole number of refreshes within `tolerance`.
- 1: also where it does, when a frame lasts other than one refresh within `tolerance`.
- 2: always.

`tolerance` is relative and defaults to 0.002, so 23.976 fps at 24 Hz counts as a whole multiple.
A refresh that need not blend shows the frame the clock is in, as it would without the pass; so does every refresh until the display is measured, and, in modes 0 and 1, before a frame's duration is known.

- It hooks `OUTPUT` in the `display` domain, so each frame is tone mapped with its own metadata before it enters history.
- A deinterlacing plan leaves it out as `display-rate-unavailable`.
- It costs a ring of two output-size `rgba16float` images and one pass per refresh; the passes before it run once per frame.

## NIS

`wgpup/nis/glsl/` holds agyild's mpv port of NVIDIA Image Scaling v1.0.2, `NVScaler.glsl` and `NVSharpen.glsl`, copied unmodified, CRLF line endings included, from [the port's gist](https://gist.github.com/agyild/7e8951915b2bf24526a9343d951db214) at revision `05f00864228871ffd157daa9beb2db8fa7412cfa`.
`.gitattributes` keeps those files and `wgpup/licenses/NIS-LICENSE` byte for byte, so their SHA-256, which `PROVENANCE.txt` lists and the pass tests check, stays upstream's.
`NIS-LICENSE` is the MIT license of [NVIDIAGameWorks/NVIDIAImageScaling](https://github.com/NVIDIAGameWorks/NVIDIAImageScaling) at commit `35e13ba316c98eeecf16f37eae70ce88019911f6`, which the port's headers carry.

- The port's scaler writes 32x24 output pixels per workgroup with 21776 bytes of workgroup storage, more than the 16384 bytes WebGPU guarantees.
  `generate_nis_wgsl.py` converts it at a 32x16 block, 16208 bytes, where each of its 256 threads still writes two pixels; it changes the block height and the `COMPUTE` directive in memory and leaves the upstream file alone.
- The sharpener fits as it is, so `tools/convert_mpv_shader.py` converts it directly.
- The converter tests regenerate both passes and require the committed files, so a converter change that alters them shows up there.

To regenerate them, run from the engine root, with naga-cli 30.0.1 installed (see [Migrate an mpv shader to a wgpup](mpv-shaders.md)):

```sh
python wgpup/nis/generate_nis_wgsl.py wgpup/nis/glsl/NVScaler.glsl wgpup/nis/NVScaler.wgsl
python tools/convert_mpv_shader.py wgpup/nis/glsl/NVSharpen.glsl wgpup/nis/NVSharpen.wgsl
```
