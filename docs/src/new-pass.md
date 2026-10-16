# Create a new WebGPU pass

A pass is a WGSL file with a `//!` header that the presentation planner places into a route's pipeline.
This chapter is the reference for the pass file format: the header, the code the engine generates around a pass, and the reasons a pass is left out of a plan.
`src/presentation/passes/PassManifest.ts` parses the header, `PassPrelude.ts` generates the code around the body, and `PresentationPlanner.ts` places the pass.

## You need

- A checkout set up as in [Set up a checkout](setup.md), for the tests and the sandbox.
- A browser with WebGPU, to see the pass run in the [sandbox](sandbox.md).

## Steps

1. Create `wgpup/<project>/` and a pass file in it, `<file>.wgsl`, under a file name no other project uses.
   Start from the bundled pass of the same shape: `sharpen.wgsl` for a kernel, `saturation.wgsl` for a color function, `catmull-rom.wgsl` for a scaler, `temporal-blend.wgsl` for a history read, and the Anime4K files for compute passes.
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

The hook names the stage a pass attaches to, in pipeline order after the fixed signal step:

- `RGB`, then `PRESCALE`, run before scaling, where `HOOKED` starts at the source's size.
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

## Header

A pass is a header, a run of lines that start with `//!`, and its body, which runs up to the next line that starts with `//!`.
A file holds one or more passes, as mpv's user shaders do, so a network of several passes ships as one file.

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
| `hook` | All, required without `replaces` | `RGB`, `PRESCALE`, `SCALE`, or `OUTPUT`; a scaler hooks `SCALE` |
| `replaces` | Color | The built-in color function it runs in place of: `builtin.transfer-decode`, `builtin.tone-map`, `builtin.output-encode`, `builtin.display-controls`, or `builtin.dither` |
| `domain` | All | `any`, `source`, `linear`, `display`, or `sdr`; defaults to `any` |
| `input` | Kernel, scaler, compute; repeats | `<NAME>`, or `<NAME>[-<N>]` for the frame N back, N from 1 to 8 |
| `save` | Kernel, compute | A name for its output, which later passes read as an input |
| `output` | Kernel, compute; required for compute | `<NAME>.size, <format>` or `<width>, <height>, <format>` |
| `components` | Kernel, compute | 1, 2, 3, or 4, the channels it needs; the planner takes the format from `output` alone |
| `when` | All | A condition on the global facts; when it is 0, the plan leaves the pass out as `condition-false` |
| `workgroup` | Compute, required | `<x>[, <y>[, <z>]]` positive integers, 1 where omitted; x and y at most 256, z at most 64, and at most 256 invocations in all |
| `dispatch` | Compute | `<x>[, <y>[, <z>]]` expressions, 1 where omitted; defaults to `ceil(<output width> / x), ceil(<output height> / y), 1` |
| `param` | All; repeats | `param <name>: <type> = <default> in [<minimum>, <maximum>]` |

- A header line is `//! <directive>: <value>`, with any whitespace around the tokens, and `\r\n` line endings read as `\n`.
- Only `input` and `param` repeat; an unknown, repeated, or empty directive is an error, as is a directive that the shape does not take.
- Only blank lines may come before a file's first header, and every line that starts with `//!` belongs to a header, so a body cannot hold one.
- Each pass of a file parses on its own, so a malformed header leaves the file's other passes in place.
  An error carries the line of its directive, or the header's first line for a missing required directive, counted from the file's first line.
- An identifier is `[A-Za-z_]\w*`.

### Inputs and outputs

- `NAME` is `HOOKED`, the image at the hook, a stage name, which reads that stage's final image and must not come after the hook, or a name an earlier pass saved.
- A pass without inputs reads `HOOKED`, and a scaler reads nothing else.
- No input pairs a name and a history depth twice.
- A saved name is not `HOOKED` or a stage name, and no texture name is `source` or `output`, whose sizes are global facts, or ends in `_history<digits>`, which history accessors use.
- A compute pass's input is never `TARGET`, the prefix of its storage target.
- In `output`, `<NAME>` is `HOOKED`, an input, `source`, or `output`, and a comma inside parentheses belongs to a function call.
- A kernel's output defaults to `HOOKED.size, rgba16float`, and its format is `rgba16float`, `rg16float`, `r16float`, `rgba32float`, `r32float`, `rgb10a2unorm`, or `rgba8unorm`.
- A compute pass writes a core storage format: `rgba16float`, `rgba32float`, `r32float`, or `rgba8unorm`.
- An output's width and height round to whole pixels within 1 and the device's largest texture dimension, and each dispatch count rounds up within 1 and 65535; otherwise the pass is left out as `output-size` or `workgroup-count`.

### Expressions

- `when`, `output`, and `dispatch` take expressions of numbers, identifiers, parentheses, `abs`, `ceil`, `floor`, `max`, `min`, `round`, and the operators `! - * / % + < <= > >= == != && ||`; a comparison or logic operator yields 1 or 0.
- Every expression reads the global facts, `source.width`, `source.height`, `output.width`, `output.height`, `frame.rate`, `hdr.source`, and `hdr.output`, all fixed at plan time.
  The HDR facts are 1 or 0, and an unknown frame rate is 0.
- `output` and `dispatch` also read `<NAME>.width` and `<NAME>.height` for `HOOKED` and each input, by its base name for a history input.
- Anything that varies per frame belongs in the body, which branches on a uniform.

### Parameters

- A parameter's name is a unique identifier, its type is `f32`, `i32`, or `u32`, and its numbers are decimals with an optional sign, fraction, and exponent.
- Its default lies within its range, every number fits its type, and a pass has at most 32 parameters.
- The body reads it as `parameters.<name>`.
  Parameters are uniforms, so `WebGPUPresenter.setPresentationParameter` changes one from the next frame without rebuilding a pipeline, rounding integers and clamping to the range.
- The passes of a file share each parameter's value, so passes that declare one parameter declare it alike.

## Generated code

The engine owns every binding, and generates around each body:

- For each input, the accessors `<P>_tex(coordinate: vec2f) -> vec4f`, a bilinear read at a normalized coordinate, `<P>_texOff(coordinate: vec2f, offsetInPixels: vec2f) -> vec4f`, `<P>_pt() -> vec2f`, the size of one texel, and `<P>_size() -> vec2f`.
  `<P>` is the input's name, or `<NAME>_history<N>` for `<NAME>[-N]`, as in `RGB_history1_tex`.
  A format that cannot be filtered, such as `r32float`, reads with four loads and a manual blend, so the accessor behaves the same.
- For a compute pass, `TARGET_size() -> vec2u` and `TARGET_store(position: vec2u, value: vec4f)`, which runs the color steps fused after the pass before it stores.
- The `parameters` uniform, one 32-bit scalar per declared parameter in order.
- The `presentation` uniform, whose frame globals are `sourceSize`, `outputSize`, and `inputSize` as `vec2f`, `timestampSeconds`, `frameIndex`, `historyValid`, `skippedFrames`, and `fieldState`.
  `historyValid` counts the earlier frames history holds: 0 after a reset, rising by one per new frame to the plan's deepest history, so a pass that reads history weighs it by `historyValid`, as `temporal-blend.wgsl` does.
  `skippedFrames` counts the frames dropped since the previous new frame, which a temporal pass may treat as a soft reset.
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
| `output-size`, `output-missing`, `workgroup-count`, `workgroup-missing` | An output size or dispatch count is out of range, or missing |

WGSL is bounds-checked and cannot reach the network or the page, so a pass can only read the frames it is given and produce pixels.
