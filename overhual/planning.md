# Planning and execution

## Planner inputs

- The preset: ordered passes per hook, with parameter values.
- Plan-time facts: the source's size, format, route, and HDR type; the output size and device pixel ratio; the display target; the frame rate.
- Device facts: features such as `shader-f16` and `timestamp-query`, limits, and supported storage formats.

## Planner steps

1. Evaluate each pass's `when` condition.
2. Resolve what each active pass reads, and drop everything nothing reads.
3. Choose the cheapest source that satisfies the reads: the external route unless an active pass needs native-resolution chroma.
4. Place the color transitions (see [color.md](color.md)).
5. Fuse color-function chains into the neighboring kernels.
6. Size each intermediate from its `output` expression, and pick the smallest format that meets its components and precision.
7. Alias short-lived intermediates whose lifetimes do not overlap.
8. Allocate history rings and persistent buffers.
9. Compile pipelines with `createRenderPipelineAsync` and `createComputePipelineAsync`, and keep presenting with the old plan until the new one is ready.
10. Prebuild every bind group, one set per history ring position.

## Placement of per-pixel work

- Per-pixel work goes to the side of the scaler with fewer pixels when a pass already exists there; otherwise it fuses into the output pass.
- A cheap scaler fuses YUV conversion into each tap.
- A wide kernel over YUV planes gets one conversion pass at source resolution instead of converting per tap.
- Dither and the final encode stay in the last pass.

## Formats

| Use | Format |
| --- | --- |
| Linear or HDR RGB | `rgba16float` |
| Luma alone | `r16float` |
| Chroma alone | `rg16float` |
| Encoded 10-bit RGB, when a pass accepts it | `rgb10a2unorm` |
| Only on request | `rgba32float` |

## Executor

For each new frame:
1. Write the globals buffer.
2. On the external route, import the frame and create its bind group.
3. Encode the passes in plan order, the last one into the canvas texture.
4. Submit once.
5. Release the frame as today: a `VideoFrame` closes after `submit()`, and its credit returns after `queue.onSubmittedWorkDone()`.

## Invalidation

| Event | Effect |
| --- | --- |
| New frame | Run the plan and advance history |
| Parameter change | Write the parameter buffer, and redraw when paused |
| Preset change | Replan in the background, then swap plans |
| Resize or device pixel ratio change | Replan; history at output resolution resets |
| Source format or route change | Replan; all history resets |
| Seek or video epoch change | All history resets |
| Device loss | Re-authorize the route, then rebuild the plan |

A redraw without a new frame never advances history.
On the external route it needs a retained source, which is open question 3 in the [README](README.md).
