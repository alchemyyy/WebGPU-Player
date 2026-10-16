//! name: Saturation
//! shape: color
//! hook: OUTPUT
//! domain: display
//! param saturation: f32 = 1.2 in [0, 2]

fn apply(color: vec4f, position: vec2f) -> vec4f {
    let luma = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
    return vec4f(mix(vec3f(luma), color.rgb, parameters.saturation), color.a);
}
