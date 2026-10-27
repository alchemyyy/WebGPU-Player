//! name: Smooth motion
//! shape: kernel
//! hook: OUTPUT
//! input: HOOKED
//! input: HOOKED[-1]
//! domain: display
//! rate: display
//! const mode: u32 = 0 in [0, 2]
//! const tolerance: f32 = 0.002 in [0, 0.05]
//! when: display.rate > 0 && (frame.rate > 0 || mode == 2) && abs(display.rate / max(frame.rate, 1) - ((mode == 0) * max(round(display.rate / max(frame.rate, 1)), 1) + (mode == 1))) > tolerance * ((mode == 0) * max(round(display.rate / max(frame.rate, 1)), 1) + (mode == 1))

// Smooth motion: each display refresh shows the video frames it spans, blended by the share of the refresh each one covers,
// so video whose frame rate the refresh rate is no multiple of plays without judder, and a refresh within one frame shows that frame untouched.
//
// The pass draws at the display's rate, so the engine draws it on every refresh, with the frame that starts within the refresh already in history:
// HOOKED is the newest frame, and HOOKED[-1] the one before it.
// A refresh shows from the clock's time, targetOffsetSeconds after the newest frame starts, for refreshSeconds of media time;
// the newest frame covers the part of the refresh from its start on, and the frame before it the rest.
// While the clock stands still, as when paused, a refresh covers no media time and shows the frame the clock is in, unblended.
//
// The condition decides when smooth motion runs, by `mode`:
// - 0, only if there would be motion judder without it: the display rate is no multiple of the frame rate, within `tolerance`.
// - 1, also where the display rate is a multiple of the frame rate: the display rate is not the frame rate, within `tolerance`.
// - 2, always.
// Elsewhere the plan leaves the pass out, so frames present as they are, without lookahead or redraws between them.
// `tolerance` is relative: 0.002 counts 23.976 fps at 24 Hz and 29.97 fps at 60 Hz as multiples, whose rare repeated frame is no judder.
// A stream that declares no frame rate runs the pass only in mode 2.
//
// The blend runs in linear light.
// Display values are sRGB-encoded: on an HDR canvas, extended past 1 and mirrored below 0.

fn srgbToLinear(encoded: vec3f) -> vec3f {
    let magnitude = abs(encoded);
    let light = select(pow((magnitude + 0.055) / 1.055, vec3f(2.4)), magnitude / 12.92, magnitude <= vec3f(0.04045));
    return sign(encoded) * light;
}

fn linearToSRGB(light: vec3f) -> vec3f {
    let magnitude = abs(light);
    let encoded = select(1.055 * pow(magnitude, vec3f(1.0 / 2.4)) - 0.055, 12.92 * magnitude, magnitude <= vec3f(0.0031308));
    return sign(light) * encoded;
}

fn kernel(coordinate: vec2f) -> vec4f {
    let newest = HOOKED_tex(coordinate);
    // After a seek or a reset, history holds no frame before the newest, which then shows alone
    if (presentation.historyValid == 0u) {
        return newest;
    }
    let refresh = presentation.refreshSeconds;
    var newestShare = select(0.0, 1.0, presentation.targetOffsetSeconds >= 0.0);
    if (refresh > 0.0) {
        newestShare = clamp((presentation.targetOffsetSeconds + refresh) / refresh, 0.0, 1.0);
    }
    if (newestShare >= 1.0) {
        return newest;
    }
    let previous = HOOKED_history1_tex(coordinate);
    if (newestShare <= 0.0) {
        return previous;
    }
    let blended = mix(srgbToLinear(previous.rgb), srgbToLinear(newest.rgb), newestShare);
    return vec4f(linearToSRGB(blended), mix(previous.a, newest.a, newestShare));
}
