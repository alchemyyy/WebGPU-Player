/** An OUTPUT kernel that sharpens with a 3x3 neighborhood into an intermediate texture, for integration tests. */
export const SHARPEN_KERNEL_PASS = /* wgsl */ `//! name: Sharpen
//! shape: kernel
//! hook: OUTPUT
//! input: HOOKED
//! output: HOOKED.size, rgba16float
//! domain: sdr
//! param strength: f32 = 0.5 in [0, 1]

fn kernel(coordinate: vec2f) -> vec4f {
    let center = HOOKED_tex(coordinate);
    var neighborhoodSum = vec4f(0.0);
    for (var row = -1; row <= 1; row += 1) {
        for (var column = -1; column <= 1; column += 1) {
            neighborhoodSum += HOOKED_texOff(coordinate, vec2f(f32(column), f32(row)));
        }
    }
    // The center moves away from the mean of its 8 neighbors
    let neighborMean = (neighborhoodSum - center) / 8.0;
    return center + (center - neighborMean) * parameters.strength;
}
`;
