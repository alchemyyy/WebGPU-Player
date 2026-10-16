//! name: Catmull-Rom
//! shape: scaler
//! hook: SCALE
//! input: HOOKED
//! domain: any

// Catmull-Rom weights of the taps 1 texel before, at, 1 texel after, and 2 texels after the origin, for a fraction in [0, 1)
fn getCatmullRomWeights(fraction: f32) -> vec4f {
    let squared = fraction * fraction;
    let cubed = squared * fraction;
    return vec4f(
        -0.5 * fraction + squared - 0.5 * cubed,
        1.0 - 2.5 * squared + 1.5 * cubed,
        0.5 * fraction + 2.0 * squared - 1.5 * cubed,
        -0.5 * squared + 0.5 * cubed
    );
}

fn scale(coordinate: vec2f) -> vec4f {
    // The origin is the texel center at or before the coordinate on each axis
    let texelPosition = coordinate * HOOKED_size() - vec2f(0.5);
    let originTexel = floor(texelPosition);
    let originCoordinate = (originTexel + vec2f(0.5)) * HOOKED_pt();
    let horizontalWeights = getCatmullRomWeights(texelPosition.x - originTexel.x);
    let verticalWeights = getCatmullRomWeights(texelPosition.y - originTexel.y);
    var color = vec4f(0.0);
    for (var row = 0u; row < 4u; row += 1u) {
        for (var column = 0u; column < 4u; column += 1u) {
            let offsetInPixels = vec2f(f32(column) - 1.0, f32(row) - 1.0);
            color += HOOKED_texOff(originCoordinate, offsetInPixels)
                * (horizontalWeights[column] * verticalWeights[row]);
        }
    }
    return color;
}
