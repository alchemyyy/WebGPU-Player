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
  A bound `TEXTURE` becomes a `bind` of the file's texture block (see [TEXTURE blocks](#texture-blocks)).
- `WIDTH`, `HEIGHT`, and `WHEN`, which mpv writes in RPN, become infix expressions.
  `when` reads plan-time facts and the pass's parameters, so texture sizes there become the sizes the earlier passes leave, over `luma`, `chroma`, `source`, and `output`, and `NATIVE_CROPPED` is luma's size.
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
| `LINEAR`, `SIGMOID` | `PRESCALE` | `linear` | In mpv's scale of linear light |
| `PREKERNEL` | `PRESCALE` | `any` | |
| `POSTKERNEL`, `SCALED` | `SCALE` | `any` | After the scaler |
| `PREOUTPUT`, `OUTPUT` | `OUTPUT` | `display` | |
| `ALPHA`, `ALPHA_SCALED`, `XYZ` | None | | They never fire on video, so the pass leaves them out |

mpv fires `RGB` on RGB sources and `LUMA` and `CHROMA` on YUV ones, so a pass that hooks `RGB` beside a plane hook keeps both, the `RGB` pass under `when: rgb.source` and the plane passes under `when: !rgb.source`, which the report notes as `hook-by-source`.

### Planes

- `LUMA`, `CHROMA`, and `NATIVE` passes run on the engine's plane stages (see [Planes](new-pass.md#planes)), which hold the planes as mpv's normalized code values, chroma at its own size and siting.
  A pass that overwrites its plane writes the plane, and the engine converts the planes with the source's own range and matrix.
- So a chroma upscaler such as KrigBilateral or the Chroma from Luma prediction shaders runs as in mpv: its `WHEN CHROMA.w LUMA.w <` reads `chroma.width < luma.width`, it reads chroma at its native size, and its `OFFSET ALIGN` output is the chroma the image converts with.
  On the raw and frame-pool routes the planes are the decoded ones; on the external routes and in deinterlacing plans the engine derives them from the RGB image at the stream's own subsampling.
- Dolby Vision routes leave plane passes out as `planes-unavailable`.
- `CHROMA_SCALED`, chroma at the image's size after mpv's chroma scaler, is not held apart by the engine, so it is read from the RGB image through the prelude's `rgbToPlanes`, the source's own matrix and range, and new chroma joins the image's luma through `planesToRGB`.

### Linear light

- The engine's linear light is in nits, while mpv's 1.0 is SDR white.
  A `LINEAR` or `SIGMOID` pass divides what it reads by the prelude's `referenceWhiteNits()`, the configured SDR white for an SDR source and the HDR reference white for HDR, and multiplies its result back.
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
| `linearize()`, `delinearize()` | The prelude's, the source's own transfer function in mpv's scale of linear light |
| A `TEXTURE` sampler in `texture`, `texelFetch`, `textureGather`, and `textureSize` | The texture block's `<NAME>_tex`, `<NAME>_load`, four loads, and `<NAME>_size` |
| `gl_FragCoord` | The output pixel's center, from the coordinate and the pass's size |
| `gl_GlobalInvocationID` and the other compute built-ins | The invocation ID, and what it gives with the workgroup size |
| `imageStore(out_image, ...)`, `imageSize(out_image)` | `TARGET_store`, which drops a store outside the image, and `TARGET_size` |

### Parameters

- A `PARAM` of type `float`, `int`, or `uint`, `DYNAMIC` or not, becomes a `param` of type `f32`, `i32`, or `u32`, in each pass that reads it or whose `WHEN` reads it; a missing bound takes its type's range.
- An `ENUM int` parameter becomes an `i32` parameter over its labels, which read as their numbers.
- A `WHEN` that reads a parameter becomes a `when` that reads it by name, so the engine plans again when it changes.
  A `WIDTH` or `HEIGHT` that reads a tunable parameter takes its default, which the report notes as `parameter-inlined`.
- A `CONSTANT` parameter the code reads becomes a `const`, which the engine compiles at its current value.
  The GLSL declares it as a global, which naga reads by name, unless the code needs a constant expression of it, such as an array size; then naga may fold it into the code, which the converter finds by translating again at another value, and a folded constant keeps its default, reported as `constant-folded`.
- A `DEFINE` parameter steers the preprocessor, so the converter translates the pass once per value of the `DEFINE` parameters its code reads, each pass under `when: <name> == <value>`, and declares them as `param`s, so changing one picks another pass.
  Past 16 passes the parameters keep their defaults, reported as `define-variant-limit`.
- A parameter named like a WGSL reserved word gains `_value`.

### TEXTURE blocks

- A `TEXTURE` becomes a texture block of the file (see [Texture blocks](new-pass.md#texture-blocks)), in one, two, or three dimensions, with its `FILTER` and `BORDER` as `filter` and `edge`; each pass that binds it gets a `bind`, and the block follows the passes.
- An 8-bit format stays 8-bit, a 16-bit float format holds halves, as mpv's GPU texture does, whether the shader wrote halves or 32-bit floats, and a 32-bit float format stays 32-bit.
  Three components take four, with alpha 1, and a 16-bit or 32-bit unorm format takes 32-bit floats, which the report notes as `texture-format-mapped`.
- Integer formats and `STORAGE` textures do not convert.
- A texture's name that the pass API reserves gains `mpv_`, as `texture-renamed`.

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
| `offset-ignored`, `parameter-inlined`, `constant-folded`, `define-variant-limit` | Warning | The result differs from mpv as described above |
| `hook-emulated`, `hook-never-fires`, `hook-by-source`, `stage-approximated` | Note | A hook or binding mapped as described above |
| `parameter-baked`, `parameter-renamed`, `parameter-unbounded`, `define-variants`, `save-renamed`, `name-truncated`, `pass-unhooked` | Note | A name or parameter mapped as described above |
| `texture-format-mapped`, `texture-renamed`, `glsl-repaired`, `glsl-directive-removed` | Note | A `TEXTURE` format or name mapped, a repair made, or a `#version` or `#extension` line removed |

## Limits

- A `BUFFER` block does not convert, since a pass cannot declare buffers.
- A compute pass runs within WebGPU's default limits, 256 invocations per workgroup and 16 KiB of workgroup storage, so NVScaler, which needs 21776 bytes, does not convert as it is.
  A shader whose block size sets its shared memory can fit by a smaller block, as the `nis` project's generator converts NVScaler (see [Bundled passes](bundled-passes.md#nis)).
- A converted pass runs as mpv ran it, pass for pass.
  A generator that fuses a network into fewer passes, as the Anime4K project's do (see [Bundled passes](bundled-passes.md#anime4k)), can go further than the converter.
