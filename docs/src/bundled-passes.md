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
| `catmull-rom` | `catmull-rom.wgsl` | A 4x4 Catmull-Rom scaler that replaces the built-in bilinear scaler; its taps read texel centers, so the result does not depend on the input's filtering |
| `anime4k` | `Anime4K_Upscale_Denoise_CNN_x2_L.wgsl`, `Anime4K_Upscale_Denoise_CNN_x2_UL.wgsl` | Anime4K v3.2's Upscale+Denoise CNN x2 networks, on the PRESCALE stage when the output is more than 1.2 times the source on each axis |

Every pass file keeps the rules that `test/presentation/passes/PostprocessingPasses.test.ts` checks: each pass parses, defines its shape's entry point, reads exactly the parameters it declares, reads each input through its accessors, and reaches engine data only through the presentation globals.
The presenter, manifest, and pipeline graph tests run the four simple passes as well.

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
