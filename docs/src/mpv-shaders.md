# Migrate an mpv shader to a wgpup

`tools/convert_mpv_shader.py` converts an mpv or libplacebo user shader, the `//!HOOK` format of mpv's `--glsl-shaders`, into a pass file (see [Create a new WebGPU pass](new-pass.md)).
It splits the shader into blocks as libplacebo does, translates each pass's GLSL to WGSL with naga, binds mpv's texture and global names to the pass API, and validates every pass with naga before it writes the file.
Its report names each place where the result differs from mpv.

## You need

- Python 3.10 or later.
- naga-cli 30.0.1, which translates the GLSL: `cargo install naga-cli --version 30.0.1 --locked`.
  The converter refuses any other version, since its repairs answer that version's GLSL frontend.

## Steps

1. Create `wgpup/<project>/`, and copy the upstream shader into `wgpup/<project>/glsl/` unmodified, with a `PROVENANCE.txt` of its source, commit, and SHA-256, and its license in `wgpup/licenses/`, as `wgpup/anime4k/` does.
2. Run from the engine root:

   ```sh
   python tools/convert_mpv_shader.py wgpup/<project>/glsl/<shader>.glsl wgpup/<project>/<shader>.wgsl
   ```

   `--name <name>` names the passes that have no `DESC`, which otherwise take the file's name and their position.
3. Read the report.
   An error leaves the file unwritten, a warning marks a difference from mpv, and a note records an emulation, a mapping, or a repair.
4. Continue from step 3 of [Create a new WebGPU pass](new-pass.md#steps): try the file in the sandbox, add the project to the pass tests, build, and add it to the table in [Bundled passes](bundled-passes.md).
   A converted pass may read `presentation.frameIndex`, `sourceSize`, or `outputSize`; add those it reads to the test's `PRESENTATION_FIELDS`.

A pass a user supplies needs only step 2; load its output in the sandbox's shader panel, or through `WebGPUPresenter.setPresentationPreset`.

## Check the result

- The converter validates each pass with naga against the pass API's declarations, and exits with status 1, writing nothing, on any error.
- Run its tests from the engine root:

  ```sh
  python -m unittest discover -s tools/test -p "*_test.py"
  ```

  The conversion tests skip when naga-cli 30.0.1 is not installed.
- In the sandbox, the shader panel shows each pass's plan state, and the pipeline graph lists the passes the plan left out as `reason: detail`.

## How passes map

- Each mpv pass becomes one pass per hook it fires on, named with the hook when it has several, and the file's passes are sorted into mpv's pipeline order, so a `MAIN` pass runs after a `LUMA` pass wherever each sits in the file.
- A fragment pass becomes a `kernel`, and a `COMPUTE <bw> <bh> [<tw> <th>]` pass becomes a `compute` pass with `workgroup: tw, th` and a `dispatch` of `bw` by `bh` blocks over its output.
- `DESC` names the pass, cut to 64 characters and made unique within the file.
- `SAVE` becomes `save`, renamed when the pass API reserves the name, and `BIND` becomes the inputs the converted code reads, and every bound saved texture, read or not, since mpv skips a pass whose bound texture no pass saved.
- `WIDTH`, `HEIGHT`, and `WHEN`, which mpv writes in RPN, become infix expressions.
  `when` reads only plan-time facts, so texture sizes there become the sizes the earlier passes leave, over `source`, `chroma`, and `output`.
- `COMPONENTS` gives a saved texture a smaller format and becomes `components`.
- `OFFSET <x> <y>` becomes `offset: <x>, <y>`, and `OFFSET ALIGN` becomes `offset: align`, which libplacebo's texture rects mean (see [Offsets](new-pass.md#offsets)), so nnedi3's and ravu's doubled luma lands where the source did.
  A pass after the scaler, or on `CHROMA_SCALED`, has no grid of its own to shift, so its `OFFSET` is reported as `offset-ignored`.
- A bound texture of an earlier stage, such as `PREKERNEL` read at `POSTKERNEL`, reads the final image of the engine stage it maps to; a plane's name reads that plane's final image, as in mpv.

| mpv hook | Stage | Domain | Notes |
| --- | --- | --- | --- |
| `LUMA` | `LUMA` | `any` | The luma plane |
| `CHROMA` | `CHROMA` | `any` | The chroma plane at its own size |
| `NATIVE` | `NATIVE` | `any` | The planes merged on luma's grid |
| `RGB`, `CHROMA_SCALED` | `RGB` | `source` | `CHROMA_SCALED` reads chroma from the RGB image and joins it back |
| `MAIN`, `MAINPRESUB` | `RGB` | `source` | |
| `LINEAR`, `SIGMOID` | `PRESCALE` | `linear` | In mpv's scale of linear light, as an SDR and an HDR pass |
| `PREKERNEL` | `PRESCALE` | `any` | |
| `POSTKERNEL`, `SCALED` | `SCALE` | `any` | After the scaler |
| `PREOUTPUT`, `OUTPUT` | `OUTPUT` | `display` | |
| `ALPHA`, `ALPHA_SCALED`, `XYZ` | None | | They never fire on video, so the pass leaves them out |

A pass that hooks `RGB` beside `LUMA` or `CHROMA` drops its `RGB` hook, since mpv fires `RGB` on RGB sources only.

### Planes

- `LUMA`, `CHROMA`, and `NATIVE` passes run on the engine's plane stages (see [Planes](new-pass.md#planes)), which hold the decoded planes as mpv's normalized code values, chroma at its own size and siting.
  A pass that overwrites its plane writes the plane, and the engine converts the planes with the source's own range and matrix.
- So a chroma upscaler such as KrigBilateral or the Chroma from Luma prediction shaders runs as in mpv on the raw and frame-pool routes: its `WHEN CHROMA.w LUMA.w <` reads `chroma.width < source.width`, it reads chroma at its native size, and its `OFFSET ALIGN` output is the chroma the image converts with.
- On the external routes the planes are derived from the RGB image at its size, so a chroma upscaler's `WHEN` is false there and the plan reports it as `condition-false`, while luma passes run on the derived luma.
- Dolby Vision routes and deinterlacing plans leave plane passes out as `planes-unavailable`.
- `CHROMA_SCALED`, chroma at the image's size after mpv's chroma scaler, is not held apart by the engine, so it is read from the RGB image with BT.709 weights, and new chroma joins the image's luma.
- A `WHEN` that reads both a parameter and the chroma plane's size plans on the parameter's default, since WGSL cannot read the chroma size.

### Linear light

- The engine's linear light is in nits, while mpv's 1.0 is SDR white.
  A `LINEAR` or `SIGMOID` pass therefore becomes two passes: one under `when: !(hdr.source)` that reads linear light divided by 100 nits, the engine's default SDR white, and one under `when: hdr.source` that divides by BT.2408's 203 nits.
  Each multiplies its result back.
- A `SIGMOID` pass also reads through libplacebo's default sigmoid, center 0.75 and slope 6.5, and writes through its inverse.

### Names a body reads

| mpv | Converted |
| --- | --- |
| `NAME_tex`, `NAME_texOff`, `NAME_pos`, `NAME_size`, `NAME_pt` | The input's accessors, at the kernel's coordinate |
| `NAME_raw` in `texture`, `textureLod`, `textureGrad`, `texelFetch`, `textureGather`, `textureSize`, and their offset forms | The same accessors; a gather samples the four texel centers |
| `NAME_pos` of the hooked texture under `OFFSET ALIGN` | The coordinate moved onto the texture's offset, `coordinate + HOOKED_offset() * HOOKED_pt()`, as libplacebo aligns its rect |
| `NAME_mul`, `NAME_rot` | 1.0, since the planes hold normalized values, and the identity |
| `NAME_off` | The input's `<P>_offset()` |
| `NAME_map(id)` | The normalized center of texel `id` of the output, moved as `NAME_pos` is |
| `frame` | `presentation.frameIndex` |
| `random` | A hash of the frame index: one value in [0, 1) per frame |
| `input_size`, `target_size` | `presentation.sourceSize` and `presentation.outputSize` |
| `tex_offset` | 0 |
| `linearize()`, `delinearize()` | Gamma 2.4, since passes do not see the source's transfer function |
| `gl_FragCoord` | The output pixel's center, from the coordinate and the pass's size |
| `gl_GlobalInvocationID` and the other compute built-ins | The invocation ID, and what it gives with the workgroup size |
| `imageStore(out_image, ...)`, `imageSize(out_image)` | `TARGET_store`, which drops a store outside the image, and `TARGET_size` |

### Parameters

- A `PARAM` of type `float`, `int`, or `uint`, `DYNAMIC` or not, becomes a `param` of type `f32`, `i32`, or `u32`, in each pass that reads it; a missing bound takes its type's range.
- An `ENUM int` parameter becomes an `i32` parameter over its labels, which read as their numbers.
- `DEFINE` and `CONSTANT` parameters are compiled in at their defaults, since they size arrays and steer `#if`.
- A `WHEN` that reads a parameter runs every frame in a pass that writes its own image at its own size, which then presents the image unchanged while the condition is false.
  In any other pass the plan reads the parameter's default.
- A parameter named like a WGSL reserved word gains `_value`.

### TEXTURE blocks

- A `TEXTURE` becomes a constant array, sampled with its `FILTER` and `BORDER`, in one, two, or three dimensions.
- A float format holds 32-bit floats, as mpv's do, or halves for an `hf` format; integer formats and `STORAGE` textures do not convert.
- A texture holds at most 4096 texels, which a D3D11 immediate constant buffer holds; ravu-zoom's tables are larger and do not convert.

### Repairs

naga 30.0.1's GLSL frontend rejects or mistranslates a few constructs that GLSL compilers accept.
The converter rewrites them without moving any line, so naga's line numbers still name the user shader's lines:

- Adjacent array dimensions, which naga reverses, are reversed in declarations and constructors first.
- A for-loop condition that opens with a constructor, which naga reads as a declaration, is parenthesized.
- `memoryBarrierShared()` and the other memory barriers are dropped, and `barrier()` becomes `workgroupBarrier()` alone, since naga adds `subgroupBarrier()`, which needs an extension.
- After a naga failure, a function that can end without a return returns zero there, `dot()` of scalars goes through overloads, a swizzle of a scalar, which GLSL 4.20 allows, reads the scalar or a vector of it, and a global `const` that naga cannot fold, such as one set by a ternary, becomes a macro, with every `const` that reads it.
  Each of these is reported as `glsl-repaired`.

## Report codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `naga-unavailable` | Error | naga-cli is missing, or not 30.0.1 |
| `headers-missing`, `directive-unknown`, `directive-invalid`, `expression-invalid`, `expression-name-unknown` | Error | The shader's headers or RPN expressions do not parse |
| `hook-unknown`, `hook-function-missing` | Error | A hook point mpv does not have, or a pass without `hook()` |
| `bind-unknown`, `bind-before-stage` | Error | A bound name nothing provides, or a stage that has not run at the hook |
| `parameter-invalid`, `parameter-limit` | Error | A malformed parameter, or more than 32 in one pass |
| `texture-invalid`, `texture-unsupported`, `buffer-unsupported` | Error | A `TEXTURE` or `BUFFER` block that does not convert |
| `raw-sampler-unsupported`, `image-unsupported` | Error | A raw sampler or `out_image` used other than in the calls above |
| `glsl-translation-failed`, `wgsl-invalid` | Error | naga rejects the GLSL with no repair left, or the converted WGSL |
| `workgroup-limit`, `workgroup-storage-limit` | Error | A compute pass beyond WebGPU's default limits |
| `offset-ignored`, `linearize-approximated`, `parameter-inlined` | Warning | The result differs from mpv as described above |
| `hook-emulated`, `hook-never-fires`, `hook-skipped`, `stage-approximated`, `condition-runtime` | Note | A hook or binding mapped as described above |
| `parameter-baked`, `parameter-renamed`, `parameter-unbounded`, `save-renamed`, `name-truncated`, `pass-unhooked` | Note | A name or parameter mapped as described above |
| `texture-emulated`, `glsl-repaired`, `glsl-directive-removed` | Note | A `TEXTURE` emulated, a repair made, or a `#version` or `#extension` line removed |

## Limits

- A `BUFFER` block does not convert, since a pass cannot declare buffers.
- A compute pass runs within WebGPU's default limits, 256 invocations per workgroup and 16 KiB of workgroup storage, so NVScaler, which needs 21776 bytes, does not convert.
- A converted pass runs as mpv ran it, pass for pass.
  A generator that fuses a network into fewer passes, as the Anime4K project's do (see [Bundled passes](bundled-passes.md#anime4k)), can go further than the converter.
