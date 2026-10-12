/** A temporal kernel that blends the RGB stage toward its previous frame while history is valid; an example, which the presenter tests also run. */
export const TEMPORAL_BLEND_KERNEL_PASS = /* wgsl */ `//! name: Temporal blend
//! shape: kernel
//! hook: RGB
//! input: HOOKED
//! input: RGB[-1]
//! output: HOOKED.size, rgba16float
//! domain: any
//! param blend: f32 = 0.5 in [0, 1]

fn kernel(coordinate: vec2f) -> vec4f {
    let current = HOOKED_tex(coordinate);
    // historyValid counts the earlier frames the ring holds, so after a reset the pass presents the current frame alone
    let previousWeight = select(0.0, parameters.blend, presentation.historyValid >= 1u);
    return mix(current, RGB_history1_tex(coordinate), previousWeight);
}
`;
