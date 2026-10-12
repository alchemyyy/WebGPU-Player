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
- WebGPU allows 256 invocations per workgroup by default.

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

fn kernel(position: vec2f) -> vec4f {
    let center = HOOKED_tex(position);
    let neighborhood = HOOKED_texOff(position, vec2f(1.0, 0.0));
    return mix(center, neighborhood, -parameters.strength * 0.25);
}
```

| Directive | Meaning |
| --- | --- |
| `name` | The name in reports and errors |
| `shape` | `color`, `kernel`, `scaler`, or `compute` |
| `hook` | The stage it attaches to; passes on one hook run in preset order |
| `input` | What it reads: `HOOKED`, another stage, a saved name, or history such as `RGB[-1]` |
| `save` | A name for its output, readable by later passes on the hook |
| `output` | The size, as an expression of input and output sizes, and the texture format |
| `components` | The channels it needs, so the planner can choose a smaller format |
| `domain` | The color domain it requires on input |
| `when` | A condition on plan-time facts; the pass is inactive while it is false |
| `param` | A user parameter: type, default, and range |
| `workgroup` | For compute passes, the workgroup size and the dispatch size expression |

## Generated prelude

The engine prepends:
- the bindings, with every binding number owned by the engine;
- a globals struct: input and output sizes, pixel sizes, frame index, presentation timestamp, `history_valid`, skipped frames, and the color metadata;
- a struct holding the declared parameters;
- typed accessors per input, in the style of mpv's hooks: `HOOKED_tex`, `HOOKED_texOff`, `HOOKED_pt`, `HOOKED_size`;
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
