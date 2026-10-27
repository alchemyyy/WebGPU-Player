# Create a new WebGPU pass

A pass is a WGSL file with a `//!` header that the presentation planner places into a route's pipeline.
This chapter is the reference for the pass file format: the header, the code the engine generates around a pass, and the reasons a pass is left out of a plan.
`src/presentation/passes/PassManifest.ts` parses the header, `PassPrelude.ts` generates the code around the body, and `PresentationPlanner.ts` places the pass.

## You need

- A checkout set up as in [Set up a checkout](setup.md), for the tests and the sandbox.
- A browser with WebGPU, to see the pass run in the [sandbox](sandbox.md).

## Steps

1. Create `wgpup/<project>/` and a pass file in it, `<file>.wgsl`, under a file name no other project uses.
   Start from the bundled pass of the same shape: `sharpen.wgsl` for a kernel, `saturation.wgsl` for a color function, `catmull-rom.wgsl` for a scaler, `temporal-blend.wgsl` for a history read, `smooth-motion.wgsl` for a pass that draws at the display rate, and the Anime4K files for compute passes.
2. Write the header, then a blank line, then the body with the entry point of its shape (see [Shapes](#shapes)).
3. To try it before building, run `npm run sandbox` and drop the file on the shader panel.
   The panel shows a plan state per pass and an input per parameter, and the pipeline graph lists a pass the plan left out as `reason: detail`.
4. Add the project to `EXPECTED_PROJECTS` in `test/presentation/passes/PostprocessingPasses.test.ts`, and run `npx vitest --watch=false test/presentation/passes`.
5. Run `npm run build`, which copies the file into `bin/wgpup/`, where a host serves it.
   The sandbox lists that folder on each request, so the file then shows in the shader panel's bundled pass selector.
6. Add the project to the table in [Bundled passes](bundled-passes.md).

A pass a user supplies at run time follows the same format, and skips steps 4 to 6.
To start from an mpv user shader instead, convert it (see [Migrate an mpv shader to a wgpup](mpv-shaders.md)).
A host loads any pass file through `WebGPUPresenter.setPresentationPreset`, as a `PresentationPresetFile` of its `source` and its stored `parameters` values.

## Check the result

- The pass tests check every bundled pass file: each pass parses, its body starts with a blank line and defines its shape's entry point, it reads exactly the parameters it declares as `parameters.<name>`, it reads each input through its accessors, and it reads no `@group`, `@binding`, `renderSettings`, `textureSample`, or `textureLoad`.
  Of the `presentation` uniform it may read only the fields in the test's `PRESENTATION_FIELDS`; add a field there when a pass needs it.
- The sandbox's pipeline graph shows the pass as a node, or as a fused color step of a neighboring pass, and lists it beside the graph as `reason: detail` when the plan left it out.

## Shapes

| Shape | Entry point | Reads | Writes |
| --- | --- | --- | --- |
| `color` | `fn apply(color: vec4f, position: vec2f) -> vec4f` | One value at one position | One value; always fused into a neighboring pass |
| `kernel` | `fn kernel(coordinate: vec2f) -> vec4f` | Neighboring pixels of its inputs | One texture |
| `scaler` | `fn scale(coordinate: vec2f) -> vec4f` | Neighboring pixels of `HOOKED` | Exactly the output rectangle, in place of the built-in bilinear scaler |
| `compute` | `fn compute(id: vec3u)` | Its inputs | One storage texture, through `TARGET_store` |

- A coordinate is a normalized position in the hooked input, and a position is the target pixel's center in pixels.
- A compute pass's `id` is the global invocation ID, and its dispatch rounds up, so check `id.xy` against `TARGET_size()` before storing.
- The input accessors read with `textureSampleLevel` or `textureLoad`, so they work in compute passes, where WGSL has no `textureSample`.
- WebGPU's default compute limits apply: 256 invocations per workgroup, and 16 KiB of workgroup storage.

## Stages and color domains

The hook names the stage a pass attaches to, in pipeline order:

- `LUMA`, `CHROMA`, then `NATIVE`, the plane stages, run on the signal's planes before it converts them into RGB (see [Planes](#planes)).
- `RGB`, then `PRESCALE`, run before scaling, where `HOOKED` starts at the source's size, or at luma's when plane passes replaced a plane.
  A pass there may change the size, as the Anime4K passes double it, and the scaler takes whatever size it is given.
- `SCALE` holds the scaler: the first user scaler that can run replaces the built-in bilinear one, and every other scaler is left out as `extra-scaler`.
  Kernels and color functions on `SCALE` run after the scaler.
- `OUTPUT` runs at the output's size, before the canvas.

Passes on one hook run in preset order, and a file's passes in file order.

The domain names the color state a pass needs on its input; the planner runs the built-in color functions, transfer decode, tone mapping, and output encode, up to that state before the pass:

| Domain | Input |
| --- | --- |
| `any` | Whatever state the pipeline is in; the default |
| `source` | Encoded RGB in the source's primaries and transfer function, as the signal step produces it |
| `linear` | Linear light in nits, in the source's primaries |
| `display` | Values encoded for the output target |
| `sdr` | `display` while the output is SDR; on an HDR output the pass is left out as `sdr-on-hdr-output` |

The planner only moves forward along the color track, so a pass whose domain the pipeline has already passed, such as `source` after any built-in step has run, is left out as `domain-unreachable`.
Dither always runs in the pass that writes the canvas, since its noise must not pass through a scaler.
The plane stages come before the color track, so a pass there takes the domain `any`; any other is left out as `domain-unreachable`.

### Planes

The plane stages hold the planes as mpv's do, as normalized code values: a code divided by the largest code of its bit depth, so a limited-range black is 16/255 at 8 bits.

| Stage | `HOOKED` | Size |
| --- | --- | --- |
| `LUMA` | Y in `.x` | The frame's visible size in samples: `luma.width` by `luma.height` |
| `CHROMA` | Cb in `.x` and Cr in `.y` | The chroma plane's: `chroma.width` by `chroma.height`, half luma's across and down at 4:2:0, rounded up |
| `NATIVE` | Y, Cb, and Cr in `.xyz`, chroma resampled onto luma's grid | Luma's |

- A pass that writes its plane stage's image replaces that plane; the plan then merges the planes and converts them with the signal's own range and matrix, reading a plane no pass replaced from the source, so it converts as the signal does.
- Chroma resampled onto luma's grid, by `NATIVE` or the merge, is read bilinearly through both images' offsets; a chroma upscaler that writes chroma at luma's size with `offset: align` is read texel for texel.
- A plane is read apart from the source only when a pass reads it; a plan without plane passes reads the source as it always does.
- The planes hold the frame's samples, so an anamorphic stream's planes keep its non-square samples, and the image the planes merge into starts at luma's size; the scaler takes it to the display's shape.
- Chroma's size is luma's over the subsampling divisor, rounded up, and its extent on the reference grid is luma's over the divisor exactly, as libplacebo sizes a plane's rect; an odd luma size leaves chroma's last pixel half outside, so chroma's scale stays exactly the subsampling's.
- The raw and frame-pool routes hold the decoded planes.
- The external routes import a frame the browser already converted to RGB, so they derive the planes from it through the conversion that made it: the stream's own matrix and range, at its bit depth, which the merge inverts exactly.
  The external HDR route reads the codes its signal recovers from the browser's BT.709 texture, the engine's own labeling of the stream.
  Chroma takes the stream's subsampling from its decoder configuration, read at each chroma sample's site, so a chroma upscaler runs there too; a stream that declares none has chroma at the image's size.
- A deinterlacing plan derives the planes from its deinterlaced image through the same conversion, chroma at the stream's subsampling.
- Dolby Vision routes have no planes to offer, so a plane pass, and a pass that reads a plane stage, is left out there as `planes-unavailable`.

### Display rate

A pass with `rate: display` draws at the display's refresh rate rather than once per frame, as `smooth-motion.wgsl` does.

- The engine draws it on every refresh from history, and the frame loop takes frames one refresh ahead of the clock, so the frame that starts within a refresh is already in history when the refresh draws.
- `HOOKED` is the newest frame, and `HOOKED[-1]` the frame before it.
- `presentation.refreshSeconds` is the media time one refresh covers, and `presentation.targetOffsetSeconds` the clock time the draw presents at minus `timestampSeconds`; the newest frame's share of the refresh is `clamp((targetOffsetSeconds + refreshSeconds) / refreshSeconds, 0, 1)`.
  `refreshSeconds` is 0 until the display rate is measured, and while the clock stands still, as when paused, when a refresh shows the frame the clock is in: the newest once `targetOffsetSeconds` reaches 0, else the one before it.
  The frame loop's tick after a pause redraws at the stopped clock, so a paused picture shows one frame.
- A draw from history skips the passes that read the source and every pass before the first display-rate pass, whose outputs no draw of the frame changes, so a heavy pass before it runs once per frame.
- The pass that reads the source then writes a texture rather than the canvas, and a color pass at the display rate gets a pass of its own rather than fusing into it.
- A plane stage reads the source, which a draw from history skips, so `rate: display` on `LUMA`, `CHROMA`, or `NATIVE` is a header error.
- Where frames are timed by the browser's video element, or the plan deinterlaces, whose history holds fields rather than the frame after the shown one, the pass is left out as `display-rate-unavailable`, with the detail `video-element` or `deinterlace`.

### Offsets

Every image the plan holds has an offset: the pixel of the image, in its own pixels, that the reference grid's origin falls on, as libplacebo's texture rects place them.

- The source's luma and the signal's RGB have the offset 0, and chroma has its siting: 4:2:0 chroma at the location the stream declares, and 4:2:2 chroma on its left luma column.
  Left-sited chroma, H.264's and HEVC's default and the engine's where a stream declares no location, has (0.25, 0), half a luma pixel; top-left chroma, as BT.2020 sites it, has (0.25, 0.25).
- A kernel or compute pass's output has the hooked image's offset scaled by the output's size over the hooked image's, plus its declared `offset`, or 0 with `offset: align`.
- The engine never shifts a read: `<P>_tex` reads where the pass asks, and `<P>_offset()` gives the input's offset, so a pass that aligns itself reads `HOOKED_tex(coordinate + HOOKED_offset() * HOOKED_pt())`, as libplacebo's `OFFSET ALIGN` moves `HOOKED_pos`.
- The scaler corrects its image's offset within its own resample, built-in or user, so an image that a pass doubled with `offset: -0.5, -0.5` lands where the source did.

## Header

A pass is a header, a run of lines that start with `//!`, and its body, which runs up to the next line that starts with `//!`.
A file holds one or more passes, as mpv's user shaders do, so a network of several passes ships as one file, and any texture blocks its passes bind (see [Texture blocks](#texture-blocks)).

```wgsl
//! name: Sharpen
//! shape: kernel
//! hook: OUTPUT
//! input: HOOKED
//! output: HOOKED.size, rgba16float
//! domain: sdr
//! param strength: f32 = 0.5 in [0, 1]

fn kernel(coordinate: vec2f) -> vec4f {
    ...
}
```

| Directive | Shapes | Value |
| --- | --- | --- |
| `name` | All, required | The name in reports and errors, at most 64 characters; unique within a preset |
| `shape` | All, required | `color`, `kernel`, `scaler`, or `compute` |
| `hook` | All, required without `replaces` | `LUMA`, `CHROMA`, `NATIVE`, `RGB`, `PRESCALE`, `SCALE`, or `OUTPUT`; a scaler hooks `SCALE`, and a color pass no plane stage |
| `replaces` | Color | The built-in color function it runs in place of: `builtin.transfer-decode`, `builtin.tone-map`, `builtin.output-encode`, `builtin.display-controls`, or `builtin.dither` |
| `domain` | All | `any`, `source`, `linear`, `display`, or `sdr`; defaults to `any` |
| `input` | Kernel, scaler, compute; repeats | `<NAME>`, or `<NAME>[-<N>]` for the frame N back, N from 1 to 8 |
| `save` | Kernel, compute | A name for its output, which later passes read as an input |
| `output` | Kernel, compute; required for compute | `<NAME>.size, <format>` or `<width>, <height>, <format>` |
| `components` | Kernel, compute | 1, 2, 3, or 4, the channels it needs; the planner takes the format from `output` alone |
| `offset` | Kernel, compute, on a hook before `SCALE` | `<x>, <y>` decimals, the output's offset in its own pixels beyond the hooked image's, or `align`; see [Offsets](#offsets) |
| `rate` | All | `frame` or `display`, how often the pass draws; defaults to `frame`; see [Display rate](#display-rate) |
| `when` | All | A condition on the global facts and the pass's own parameters; when it is 0, the plan leaves the pass out as `condition-false` |
| `workgroup` | Compute, required | `<x>[, <y>[, <z>]]` positive integers, 1 where omitted; x and y at most 256, z at most 64, and at most 256 invocations in all |
| `dispatch` | Compute | `<x>[, <y>[, <z>]]` expressions, 1 where omitted; defaults to `ceil(<output width> / x), ceil(<output height> / y), 1` |
| `bind` | All; repeats | The name of a texture block of the file, which the pass reads; see [Texture blocks](#texture-blocks) |
| `param` | All; repeats | `param <name>: <type> = <default> in [<minimum>, <maximum>]`, a uniform |
| `const` | All; repeats | `const <name>: <type> = <default> in [<minimum>, <maximum>]`, a constant the plan compiles in |

- A header line is `//! <directive>: <value>`, with any whitespace around the tokens, and `\r\n` line endings read as `\n`.
- Only `input`, `bind`, `param`, and `const` repeat; an unknown, repeated, or empty directive is an error, as is a directive that the shape does not take.
- Only blank lines may come before a file's first header, and every line that starts with `//!` belongs to a header, so a body cannot hold one.
- Each pass of a file parses on its own, so a malformed header leaves the file's other passes in place.
  An error carries the line of its directive, or the header's first line for a missing required directive, counted from the file's first line.
- An identifier is `[A-Za-z_]\w*`.

### Inputs and outputs

- `NAME` is `HOOKED`, the image at the hook, a stage name, which reads that stage's final image and must not come after the hook, or a name an earlier pass saved.
- A pass without inputs reads `HOOKED`, and a scaler reads nothing else.
- No input pairs a name and a history depth twice.
- A saved name is not `HOOKED` or a stage name, and no texture name is `source`, `output`, `luma`, or `chroma`, whose sizes are global facts, or ends in `_history<digits>`, which history accessors use.
- A compute pass's input is never `TARGET`, the prefix of its storage target.
- In `output`, `<NAME>` is `HOOKED`, an input, `source`, `output`, `luma`, or `chroma`, and a comma inside parentheses belongs to a function call.
- A kernel's output defaults to `HOOKED.size, rgba16float`, and its format is `rgba16float`, `rg16float`, `r16float`, `rgba32float`, `r32float`, `rgb10a2unorm`, or `rgba8unorm`.
- A compute pass writes a core storage format: `rgba16float`, `rgba32float`, `r32float`, or `rgba8unorm`.
- An output's width and height round to whole pixels within 1 and the device's largest texture dimension, and each dispatch count rounds up within 1 and 65535; otherwise the pass is left out as `output-size` or `workgroup-count`.

### Expressions

- `when`, `output`, and `dispatch` take expressions of numbers, identifiers, parentheses, `abs`, `ceil`, `floor`, `max`, `min`, `round`, and the operators `! - * / % + < <= > >= == != && ||`; a comparison or logic operator yields 1 or 0.
- Every expression reads the global facts, `source.width`, `source.height`, `output.width`, `output.height`, `luma.width`, `luma.height`, `chroma.width`, `chroma.height`, `frame.rate`, `display.rate`, `hdr.source`, `hdr.output`, and `rgb.source`, all fixed at plan time.
  The HDR facts are 1 or 0, and the luma and chroma sizes are the planes' (see [Planes](#planes)), so `chroma.width < luma.width` holds for subsampled chroma.
  `frame.rate` is the stream's declared frame rate, its average frame rate, else its real frame rate when the average is missing or at least 1000, and 0 when it declares none.
  `display.rate` is the display's refresh rate in Hz, which the presenter measures from the frame loop's animation frames, and 0 until measured; the presenter plans again when the measurement moves more than 0.1% from the rate the plan read.
  `rgb.source` is 1 where the source codes R, G, and B planes, where mpv fires its `RGB` hook rather than `LUMA` and `CHROMA`; no route presents such video, so it is 0 on every route.
- `when` also reads the pass's own parameters and constants by name, at their current values, and the presenter plans again when one that a `when` reads changes.
- `output` and `dispatch` also read `<NAME>.width` and `<NAME>.height` for `HOOKED` and each input, by its base name for a history input.
- Anything else that varies per frame belongs in the body, which branches on a uniform.

### Parameters

- A parameter's name is a unique identifier, its type is `f32`, `i32`, or `u32`, and its numbers are decimals with an optional sign, fraction, and exponent.
- Its default lies within its range, every number fits its type, and a pass has at most 32 parameters and constants together.
- The body reads a `param` as `parameters.<name>`.
  It is a uniform, so `WebGPUPresenter.setPresentationParameter` changes one from the next frame without rebuilding a pipeline, rounding integers and clamping to the range.
- The body reads a `const` as `<name>`, a WGSL constant at its current value, so it may size an array or fold into other constants.
  A change builds a new plan, whose modules compile the new value, as does a change to a `param` that the pass's `when` reads.
- The passes of a file share each parameter's value, so passes that declare one parameter declare it alike, of the same kind.

### Texture blocks

A file may hold texture blocks beside its passes, such as a 3D LUT or a table of weights, so a host keeps storing one file per pass.
A block is a header that names a texture, then its data:

```wgsl
//! texture: LUT
//! size: 33, 33, 33
//! format: rgba16float
//! filter: linear
//! edge: clamp

AAA8AAA8AAA8ADw...
```

| Directive | Value |
| --- | --- |
| `texture` | Required: the name passes bind it by, an identifier other than `HOOKED`, a stage name, or a global size's name |
| `size` | Required: `<width>[, <height>[, <depth>]]` positive integers, which give it one, two, or three dimensions |
| `format` | Required: `r8unorm`, `rg8unorm`, `rgba8unorm`, `r16float`, `rg16float`, `rgba16float`, `r32float`, `rg32float`, or `rgba32float` |
| `filter` | `linear` or `nearest`, the default |
| `edge` | `clamp`, the default, `repeat`, or `mirror`: how a read beyond the edge wraps |

- The body is the texels' bytes in base64, whitespace ignored: little-endian, packed tightly in the format, x fastest, then y, then z.
  It fills the size in the format exactly.
- A block is not a pass; a pass reads it after `bind: <NAME>`, under a name no input of the pass takes, and a file of blocks alone has no pass.
- A block that does not parse fails the passes that bind it, with its own line and message.
- The engine uploads a block once, when a plan first binds it, keyed by a content identity of its size, format, and data, so a new version of the file replaces the old upload once no preset holds it; there is no count or LRU limit.
- A block beyond the device's largest texture of its dimensions, 2D for one and two, is left out as `texture-size`, and a linear filter on a 32-bit float format a device cannot filter as `texture-format`.
- `tools/convert_cube_lut.py` turns a `.cube` 3D LUT into a file of one color pass that grades through it (see [Tools](tools.md#cube-lut-converter)).

## Generated code

The engine owns every binding, and generates around each body:

- For each input, the accessors `<P>_tex(coordinate: vec2f) -> vec4f`, a bilinear read at a normalized coordinate, `<P>_texOff(coordinate: vec2f, offsetInPixels: vec2f) -> vec4f`, `<P>_pt() -> vec2f`, the size of one texel, `<P>_size() -> vec2f`, and `<P>_offset() -> vec2f`, the input's offset in its own pixels (see [Offsets](#offsets)).
  `<P>` is the input's name, or `<NAME>_history<N>` for `<NAME>[-N]`, as in `RGB_history1_tex`.
  A format that cannot be filtered, such as `r32float`, reads with four loads and a manual blend, so the accessor behaves the same.
- For a compute pass, `TARGET_size() -> vec2u` and `TARGET_store(position: vec2u, value: vec4f)`, which runs the color steps fused after the pass before it stores.
- For each texture block it binds, `<NAME>_tex(coordinate)`, a read through the block's filter and edge mode at a normalized coordinate, `<NAME>_size()`, and `<NAME>_load(texel)`, one texel clamped to the block.
  A coordinate is `f32`, `vec2f`, or `vec3f`, and a texel `i32`, `vec2i`, or `vec3i`, by the block's dimensions.
- The `parameters` uniform, one 32-bit scalar per declared `param` in order, and each `const` as a WGSL constant.
- For a body that calls them without declaring them itself:
  - `linearize(color: vec4f) -> vec4f` and `delinearize(color: vec4f) -> vec4f`, the source's own transfer function, compiled from the code of the built-in transfer decode and its inverse, in mpv's scale of linear light, where 1.0 is `referenceWhiteNits()` nits.
  - `referenceWhiteNits() -> f32`, the nits of mpv's linear 1.0: the configured SDR white for an SDR source, BT.2408's HDR reference white, 203 nits, for HDR.
    A pass of the `linear` domain reads nits, so it divides by it to work in mpv's scale.
  - `rgbToPlanes(color: vec3f) -> vec3f` and `planesToRGB(planes: vec3f) -> vec3f`: 'source' RGB to the normalized Y, Cb, and Cr plane values of the source's own matrix and range, and back, each the other's exact inverse.
- The `presentation` uniform, whose frame globals are `sourceSize`, `outputSize`, and `inputSize` as `vec2f`, `timestampSeconds`, `frameIndex`, `historyValid`, `skippedFrames`, `fieldState`, `refreshSeconds`, and `targetOffsetSeconds`.
  `historyValid` counts the earlier frames history holds: 0 after a reset, rising by one per new frame to the plan's deepest history, so a pass that reads history weighs it by `historyValid`, as `temporal-blend.wgsl` does.
  `skippedFrames` counts the frames dropped since the previous new frame, which a temporal pass may treat as a soft reset.
  `refreshSeconds` and `targetOffsetSeconds` time a draw within the display's refreshes (see [Display rate](#display-rate)).
  [Architecture](architecture.md#presentation) lists when history resets.
- The vertex stage and the fragment or compute entry point that call the body's entry point.

The engine renames each body's module-scope declarations, so two passes can declare the same helper.
The renaming is lexical, so a struct member that shares the name of a module-scope declaration is renamed where it is declared but not where it is read; give members names of their own.

## Why a pass is left out

A pass that cannot run is left out of the plan, playback continues without it, and `WebGPUPresenter.getPresentationPlanReport` and `setPresentationPreset` report it as a reason code and a terse detail.

| Reason | Cause |
| --- | --- |
| `header-invalid` | The header does not parse; the detail carries the line and message |
| `compile-error` | The WGSL does not compile; the plan is rebuilt without the pass, and messages map back to the pass file's lines |
| `duplicate-name` | An earlier pass of the preset has the same name |
| `parameter-unknown`, `parameter-invalid` | A stored value names no parameter of the file, or is not finite; every pass of the file is left out |
| `condition-false`, `condition-invalid` | `when` is 0, or cannot be evaluated |
| `sdr-on-hdr-output`, `domain-unreachable` | The domain cannot be met; see [Stages and color domains](#stages-and-color-domains) |
| `extra-scaler` | Another scaler runs |
| `replaced-function-missing`, `replaced-function-taken` | The route's chain has no such built-in function, or another pass replaced it |
| `input-unknown`, `input-after-hook`, `input-reserved` | An input names nothing saved, a later stage, or `TARGET` |
| `planes-unavailable` | The pass hooks or reads a plane stage, or calls the prelude's plane transform, on a route without planes, which the detail names by its signal |
| `linear-light-unavailable` | The pass calls `linearize`, `delinearize`, or `referenceWhiteNits` on a route that does not know its stream's transfer function, which the detail names by its signal |
| `display-rate-unavailable` | The pass draws at the display rate where the presenter cannot redraw between frames: `video-element` where the browser's video element times the frames, `deinterlace` where the plan deinterlaces; see [Display rate](#display-rate) |
| `texture-size`, `texture-format` | A texture block exceeds the device's texture size, or needs a filter the device lacks for its format; the detail names the block |
| `output-size`, `output-missing`, `workgroup-count`, `workgroup-missing` | An output size or dispatch count is out of range, or missing |

WGSL is bounds-checked and cannot reach the network or the page, so a pass can only read the frames it is given and produce pixels.
