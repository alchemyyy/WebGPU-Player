# Passes

## Shapes

| Shape | Reads | Writes | Use |
| --- | --- | --- | --- |
| Color function | One value at one position | One value | Matrices, tone and gamut mapping, LUTs, grading, dither |
| Kernel | Neighboring pixels of textures | One texture, or the canvas | Sharpeners, debanders, denoisers |
| Scaler | Neighboring pixels of one texture | Exactly the output rectangle | Upscaling and downscaling |
| Compute | Textures and buffers | Storage textures and buffers | Neural upscalers, reductions, temporal accumulation |

- A color function is `fn apply(color: vec4f, position: vec2f) -> vec4f`, and it is always fused into a neighboring pass.
- A compute pass can write storage buffers, which is how per-frame statistics stay on the GPU.
- Compute passes cannot use `textureSample`, but can use `textureSampleLevel` and `textureLoad`.
- In core WebGPU, `r16float`, `rg16float`, and `rgb10a2unorm` cannot be storage textures, so a compute pass writes `rgba16float`, `r32float`, or a buffer instead.
- WebGPU allows 256 invocations per workgroup by default.
- Decoders are a separate kind of module, described in [decoders.md](decoders.md).

## File format

A pass is one WGSL file whose header is a block of `//!` lines.
The engine parses the header and never parses WGSL itself.

```wgsl
//! name: Adaptive sharpen
//! shape: kernel
//! hook: OUTPUT
//! input: HOOKED
//! output: HOOKED.size, rgba16float
//! domain: sdr
//! when: output.width >= source.width
//! param strength: f32 = 0.5 in [0, 1]

fn kernel(coordinate: vec2f) -> vec4f {
    let center = HOOKED_tex(coordinate);
    let neighborhood = HOOKED_texOff(coordinate, vec2f(1.0, 0.0));
    return mix(center, neighborhood, -parameters.strength * 0.25);
}
```

| Directive | Shapes | Meaning |
| --- | --- | --- |
| `name` | All, required | The name in reports and errors |
| `shape` | All, required | `color`, `kernel`, `scaler`, or `compute` |
| `hook` | All, required without `replaces` | The stage it attaches to; passes on one hook run in preset order |
| `replaces` | Color | The built-in color function it runs in place of, such as `builtin.tone-map` |
| `domain` | All | The color domain it requires on input |
| `input` | Kernel, scaler, compute | What it reads: `HOOKED`, another stage, a saved name, or history such as `RGB[-1]` |
| `save` | Kernel, compute | A name for its output, readable by later passes on the hook |
| `output` | Kernel, compute; required for compute | The size, as expressions of input and output sizes, and the texture format |
| `components` | Kernel, compute | The channels it needs, so the planner can choose a smaller format |
| `when` | All | A condition on plan-time facts; the pass is inactive while it is false |
| `param` | All | A user parameter: type, default, and range |
| `workgroup` | Compute, required | The workgroup size |
| `dispatch` | Compute | The workgroup counts, as expressions |

## Header grammar

- The header is the run of lines that start with `//!` after any blank lines, the body starts on the line after it, and `\r\n` line endings read as `\n`.
- A header line is `//! <directive>: <value>` or `//! param <name>: <type> = <default> in [<minimum>, <maximum>]`, with any whitespace around the tokens.
- Only `input` and `param` repeat, and an unknown, repeated, or empty directive is an error, as is a directive that the shape does not take.
- An error carries the line of its directive, or line 1 for a missing required directive.
- An identifier is `[A-Za-z_]\w*`.
- `name` is at most 64 characters.
- `hook` is `OUTPUT`, `PRESCALE`, `RGB`, or `SCALE`, and a scaler hooks `SCALE`.
- `replaces` is `builtin.transfer-decode`, `builtin.tone-map`, `builtin.output-encode`, `builtin.display-controls`, or `builtin.dither`, and a pass with it declares neither a hook nor a domain, since it takes the replaced function's place and color states.
- `domain` is `any`, `display`, `linear`, `sdr`, or `source`, and defaults to `any`.
- `input` is `<NAME>` or `<NAME>[-<N>]`, where NAME is an identifier and N is from 1 to 8, and no (NAME, N) pair repeats.
- A kernel, scaler, or compute pass without inputs reads `HOOKED`, and a scaler reads nothing else.
- `save` is an identifier other than `HOOKED` and the stage names.
- No input or saved name is `source` or `output`, whose sizes are global facts, or ends in `_history<digits>`, which history accessors use.
- `output` is `<NAME>.size, <format>`, where NAME is `HOOKED`, an input, `source`, or `output`, or `<width>, <height>, <format>`, and a comma inside parentheses belongs to a function call.
- A kernel's output defaults to `HOOKED.size, rgba16float`, and its format is `rgba16float`, `rg16float`, `r16float`, `rgba32float`, `r32float`, `rgb10a2unorm`, or `rgba8unorm`.
- A compute pass's output is in a core storage format: `rgba16float`, `rgba32float`, `r32float`, or `rgba8unorm`.
- `components` is 1, 2, 3, or 4.
- `when` reads only the global facts: `source.width`, `source.height`, `output.width`, `output.height`, `frame.rate`, `hdr.source`, and `hdr.output`.
- `output` and `dispatch` expressions also read `<NAME>.width` and `<NAME>.height` for `HOOKED` and each input, by its base name for a history input.
- A parameter's name is a unique identifier, its type is `f32`, `i32`, or `u32`, and its numbers are decimals with an optional sign, fraction, and exponent.
- A parameter's default lies within its range, each of its numbers fits its type, so `i32` and `u32` values are integers and `u32` values are not negative, and a pass has at most 32 parameters.
- `workgroup` is `<x>[, <y>[, <z>]]` in positive integers, 1 where omitted, with x and y at most 256, z at most 64, and at most 256 invocations in all.
- `dispatch` is `<x>[, <y>[, <z>]]` in expressions, 1 where omitted, and without it the counts are `ceil(<output width> / x)`, `ceil(<output height> / y)`, and 1.

## Generated prelude

The engine prepends:
- the bindings, with every binding number owned by the engine;
- a globals struct: input and output sizes, pixel sizes, frame index, presentation timestamp, `history_valid`, skipped frames, and the color metadata;
- a struct holding the declared parameters;
- typed accessors per input, in the style of mpv's hooks: `HOOKED_tex`, `HOOKED_texOff`, `HOOKED_pt`, `HOOKED_size`, and for a history input such as `RGB[-1]`, `RGB_history1_tex`, `RGB_history1_texOff`, `RGB_history1_pt`, `RGB_history1_size`;
- for fragment passes, a full-screen triangle vertex stage;
- `enable f16;` when the device has `shader-f16` and the pass asks for it.

## Parameters and conditions

- Parameters are uniforms, so changing one writes a buffer and never rebuilds a pipeline.
- Conditions use plan-time facts only: sizes, the source format, the HDR type, the frame rate, and the display.
- Anything that varies per frame is a uniform that the shader branches on.

## Failures and safety

- WGSL is bounds-checked and cannot reach the network or the page, so a pass can only read the frames it is given and produce pixels.
- Compile errors come from `getCompilationInfo`, with line numbers mapped back past the prelude.
- A pass that fails to compile drops out of the plan, and playback continues without it.
- A device loss while user passes are active disables them, reports the preset, and rebuilds without them.
- A safe-mode switch makes the engine ignore every user pass.
