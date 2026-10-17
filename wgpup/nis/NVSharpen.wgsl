//! name: NVIDIA Image Sharpening v1.0.2
//! shape: compute
//! hook: LUMA
//! domain: any
//! input: HOOKED
//! output: HOOKED.width, HOOKED.height, rgba16float
//! when: (!((((output.width * output.height) / (luma.width * luma.height)) > 1)) * !((((output.width * output.height) / (luma.width * luma.height)) < 1)))
//! workgroup: 256, 1
//! dispatch: ceil(round(HOOKED.width) / 32), ceil(round(HOOKED.height) / 32)

// Converted from NVSharpen.glsl by tools/convert_mpv_shader.py with naga 30.0.1

const sharpen_slider: f32 = -0.25f;

const kDetectRatio: f32 = 2.2011719f;

const kContrastBoost: f32 = 1f;

const kEps: f32 = 0.003921569f;

var<private> mpv_local_invocation_id: vec3<u32>;

var<private> mpv_workgroup_id: vec3<u32>;

var<workgroup> shPixelsY: array<array<f32, 38>, 38>;

fn GetEdgeMap(p: array<array<f32, 5>, 5>, i: i32, j: i32) -> vec4<f32> {
    var p_1: array<array<f32, 5>, 5>;
    var i_1: i32;
    var j_1: i32;
    var g_0_: f32;
    var g_45_: f32;
    var g_90_: f32;
    var g_135_: f32;
    var g_0_90_max: f32;
    var g_0_90_min: f32;
    var g_45_135_max: f32;
    var g_45_135_min: f32;
    var e_0_90_: f32 = 0f;
    var e_45_135_: f32 = 0f;
    var local: f32;
    var c_0_90_: bool;
    var local_1: f32;
    var c_45_135_: bool;
    var c_g_0_90_: bool;
    var c_g_45_135_: bool;
    var local_2: f32;
    var f_e_0_90_: f32;
    var local_3: f32;
    var f_e_45_135_: f32;
    var local_4: f32;
    var weight_0_: f32;
    var local_5: f32;
    var weight_90_: f32;
    var local_6: f32;
    var weight_45_: f32;
    var local_7: f32;
    var weight_135_: f32;

    p_1 = p;
    i_1 = i;
    j_1 = j;
    let _e18 = j_1;
    let _e21 = i_1;
    let _e25 = p_1[(0i + _e21)][(0i + _e18)];
    let _e27 = j_1;
    let _e30 = i_1;
    let _e34 = p_1[(0i + _e30)][(1i + _e27)];
    let _e37 = j_1;
    let _e40 = i_1;
    let _e44 = p_1[(0i + _e40)][(2i + _e37)];
    let _e47 = j_1;
    let _e50 = i_1;
    let _e54 = p_1[(2i + _e50)][(0i + _e47)];
    let _e57 = j_1;
    let _e60 = i_1;
    let _e64 = p_1[(2i + _e60)][(1i + _e57)];
    let _e67 = j_1;
    let _e70 = i_1;
    let _e74 = p_1[(2i + _e70)][(2i + _e67)];
    g_0_ = abs((((((_e25 + _e34) + _e44) - _e54) - _e64) - _e74));
    let _e79 = j_1;
    let _e82 = i_1;
    let _e86 = p_1[(1i + _e82)][(0i + _e79)];
    let _e88 = j_1;
    let _e91 = i_1;
    let _e95 = p_1[(0i + _e91)][(0i + _e88)];
    let _e98 = j_1;
    let _e101 = i_1;
    let _e105 = p_1[(0i + _e101)][(1i + _e98)];
    let _e108 = j_1;
    let _e111 = i_1;
    let _e115 = p_1[(2i + _e111)][(1i + _e108)];
    let _e118 = j_1;
    let _e121 = i_1;
    let _e125 = p_1[(2i + _e121)][(2i + _e118)];
    let _e128 = j_1;
    let _e131 = i_1;
    let _e135 = p_1[(1i + _e131)][(2i + _e128)];
    g_45_ = abs((((((_e86 + _e95) + _e105) - _e115) - _e125) - _e135));
    let _e140 = j_1;
    let _e143 = i_1;
    let _e147 = p_1[(0i + _e143)][(0i + _e140)];
    let _e149 = j_1;
    let _e152 = i_1;
    let _e156 = p_1[(1i + _e152)][(0i + _e149)];
    let _e159 = j_1;
    let _e162 = i_1;
    let _e166 = p_1[(2i + _e162)][(0i + _e159)];
    let _e169 = j_1;
    let _e172 = i_1;
    let _e176 = p_1[(0i + _e172)][(2i + _e169)];
    let _e179 = j_1;
    let _e182 = i_1;
    let _e186 = p_1[(1i + _e182)][(2i + _e179)];
    let _e189 = j_1;
    let _e192 = i_1;
    let _e196 = p_1[(2i + _e192)][(2i + _e189)];
    g_90_ = abs((((((_e147 + _e156) + _e166) - _e176) - _e186) - _e196));
    let _e201 = j_1;
    let _e204 = i_1;
    let _e208 = p_1[(1i + _e204)][(0i + _e201)];
    let _e210 = j_1;
    let _e213 = i_1;
    let _e217 = p_1[(2i + _e213)][(0i + _e210)];
    let _e220 = j_1;
    let _e223 = i_1;
    let _e227 = p_1[(2i + _e223)][(1i + _e220)];
    let _e230 = j_1;
    let _e233 = i_1;
    let _e237 = p_1[(0i + _e233)][(1i + _e230)];
    let _e240 = j_1;
    let _e243 = i_1;
    let _e247 = p_1[(0i + _e243)][(2i + _e240)];
    let _e250 = j_1;
    let _e253 = i_1;
    let _e257 = p_1[(1i + _e253)][(2i + _e250)];
    g_135_ = abs((((((_e208 + _e217) + _e227) - _e237) - _e247) - _e257));
    let _e261 = g_0_;
    let _e262 = g_90_;
    g_0_90_max = max(_e261, _e262);
    let _e265 = g_0_;
    let _e266 = g_90_;
    g_0_90_min = min(_e265, _e266);
    let _e269 = g_45_;
    let _e270 = g_135_;
    g_45_135_max = max(_e269, _e270);
    let _e273 = g_45_;
    let _e274 = g_135_;
    g_45_135_min = min(_e273, _e274);
    let _e283 = g_0_90_max;
    let _e284 = g_45_135_max;
    if ((_e283 + _e284) == 0f) {
        {
            return vec4<f32>(0f, 0f, 0f, 0f);
        }
    }
    let _e298 = g_0_90_max;
    let _e299 = g_0_90_max;
    let _e300 = g_45_135_max;
    e_0_90_ = min((_e298 / (_e299 + _e300)), 1f);
    let _e306 = e_0_90_;
    e_45_135_ = (1f - _e306);
    let _e308 = g_0_90_max;
    let _e309 = g_0_90_min;
    let _e312 = g_0_90_max;
    if false {
        local = 32f;
    } else {
        local = 64f;
    }
    let _e318 = local;
    let _e323 = g_0_90_max;
    let _e324 = g_45_135_min;
    c_0_90_ = (((_e308 > (_e309 * kDetectRatio)) && (_e312 > (_e318 / 1024f))) && (_e323 > _e324));
    let _e328 = g_45_135_max;
    let _e329 = g_45_135_min;
    let _e332 = g_45_135_max;
    if false {
        local_1 = 32f;
    } else {
        local_1 = 64f;
    }
    let _e338 = local_1;
    let _e343 = g_45_135_max;
    let _e344 = g_0_90_min;
    c_45_135_ = (((_e328 > (_e329 * kDetectRatio)) && (_e332 > (_e338 / 1024f))) && (_e343 > _e344));
    let _e348 = g_0_90_max;
    let _e349 = g_0_;
    c_g_0_90_ = (_e348 == _e349);
    let _e352 = g_45_135_max;
    let _e353 = g_45_;
    c_g_45_135_ = (_e352 == _e353);
    let _e356 = c_0_90_;
    let _e357 = c_45_135_;
    if (_e356 && _e357) {
        let _e359 = e_0_90_;
        local_2 = _e359;
    } else {
        local_2 = 1f;
    }
    let _e362 = local_2;
    f_e_0_90_ = _e362;
    let _e364 = c_0_90_;
    let _e365 = c_45_135_;
    if (_e364 && _e365) {
        let _e367 = e_45_135_;
        local_3 = _e367;
    } else {
        local_3 = 1f;
    }
    let _e370 = local_3;
    f_e_45_135_ = _e370;
    let _e372 = c_0_90_;
    let _e373 = c_g_0_90_;
    if (_e372 && _e373) {
        let _e375 = f_e_0_90_;
        local_4 = _e375;
    } else {
        local_4 = 0f;
    }
    let _e378 = local_4;
    weight_0_ = _e378;
    let _e380 = c_0_90_;
    let _e381 = c_g_0_90_;
    if (_e380 && !(_e381)) {
        let _e384 = f_e_0_90_;
        local_5 = _e384;
    } else {
        local_5 = 0f;
    }
    let _e387 = local_5;
    weight_90_ = _e387;
    let _e389 = c_45_135_;
    let _e390 = c_g_45_135_;
    if (_e389 && _e390) {
        let _e392 = f_e_45_135_;
        local_6 = _e392;
    } else {
        local_6 = 0f;
    }
    let _e395 = local_6;
    weight_45_ = _e395;
    let _e397 = c_45_135_;
    let _e398 = c_g_45_135_;
    if (_e397 && !(_e398)) {
        let _e401 = f_e_45_135_;
        local_7 = _e401;
    } else {
        local_7 = 0f;
    }
    let _e404 = local_7;
    weight_135_ = _e404;
    let _e406 = weight_0_;
    let _e407 = weight_90_;
    let _e408 = weight_45_;
    let _e409 = weight_135_;
    return vec4<f32>(_e406, _e407, _e408, _e409);
}

fn CalcLTIFast(y: array<f32, 5>) -> f32 {
    var a_min: f32;
    var a_max: f32;
    var b_min: f32;
    var b_max: f32;
    var a_cont: f32;
    var b_cont: f32;
    var cont_ratio: f32;
    var local_8: f32;
    var local_9: f32;
    var local_10: f32;

    a_min = min(min(y[0], y[1]), y[2]);
    a_max = max(max(y[0], y[1]), y[2]);
    b_min = min(min(y[2], y[3]), y[4]);
    b_max = max(max(y[2], y[3]), y[4]);
    let _e48 = a_max;
    let _e49 = a_min;
    a_cont = (_e48 - _e49);
    let _e52 = b_max;
    let _e53 = b_min;
    b_cont = (_e52 - _e53);
    let _e56 = a_cont;
    let _e57 = b_cont;
    let _e59 = a_cont;
    let _e60 = b_cont;
    cont_ratio = (max(_e56, _e57) / (min(_e59, _e60) + kEps));
    let _e66 = cont_ratio;
    if false {
        local_8 = 1.5f;
    } else {
        local_8 = 2f;
    }
    let _e72 = local_8;
    if false {
        local_9 = 5f;
    } else {
        local_9 = 10f;
    }
    let _e80 = local_9;
    if false {
        local_10 = 1.5f;
    } else {
        local_10 = 2f;
    }
    let _e86 = local_10;
    return ((1f - clamp(((_e66 - _e72) * (1f / (_e80 - _e86))), 0f, 1f)) * kContrastBoost);
}

fn EvalUSM(pxl: array<f32, 5>, sharpnessStrength: f32, sharpnessLimit: f32) -> f32 {
    var y_usm: f32;

    y_usm = (((-0.6001f * pxl[1]) + (1.2002f * pxl[2])) - (0.6001f * pxl[3]));
    let _e30 = y_usm;
    y_usm = (_e30 * sharpnessStrength);
    let _e33 = y_usm;
    y_usm = min(sharpnessLimit, max(-(sharpnessLimit), _e33));
    let _e36 = y_usm;
    let _e37 = CalcLTIFast(pxl);
    y_usm = (_e36 * _e37);
    let _e39 = y_usm;
    return _e39;
}

fn GetDirUSM(p_2: array<array<f32, 5>, 5>) -> vec4<f32> {
    var local_11: f32;
    var local_12: f32;
    var local_13: f32;
    var scaleY: f32;
    var local_14: f32;
    var local_15: f32;
    var local_16: f32;
    var local_17: f32;
    var local_18: f32;
    var local_19: f32;
    var sharpnessStrength_1: f32;
    var local_20: f32;
    var local_21: f32;
    var local_22: f32;
    var local_23: f32;
    var local_24: f32;
    var local_25: f32;
    var local_26: f32;
    var local_27: f32;
    var local_28: f32;
    var local_29: f32;
    var sharpnessLimit_1: f32;
    var rval: vec4<f32>;
    var interp0Deg: array<f32, 5>;
    var i_2: i32 = 0i;
    var interp90Deg: array<f32, 5>;
    var i_3: i32 = 0i;
    var interp45Deg: array<f32, 5>;
    var interp135Deg: array<f32, 5>;

    if false {
        local_11 = 0.35f;
    } else {
        local_11 = 0.45f;
    }
    let _e22 = local_11;
    if false {
        local_12 = 0.55f;
    } else {
        local_12 = 0.9f;
    }
    let _e30 = local_12;
    if false {
        local_13 = 0.35f;
    } else {
        local_13 = 0.45f;
    }
    let _e36 = local_13;
    scaleY = (1f - clamp(((p_2[2][2] - _e22) * (1f / (_e30 - _e36))), 0f, 1f));
    let _e47 = scaleY;
    if false {
        local_14 = 2.2f;
    } else {
        local_14 = 1.6f;
    }
    let _e53 = local_14;
    if false {
        local_15 = 1.25f;
    } else {
        local_15 = 1.75f;
    }
    let _e60 = local_15;
    if false {
        local_16 = 1.25f;
    } else {
        local_16 = 1f;
    }
    let _e73 = local_16;
    if false {
        local_17 = 1.1f;
    } else {
        local_17 = 1.2f;
    }
    let _e80 = local_17;
    if false {
        local_18 = 1.25f;
    } else {
        local_18 = 1f;
    }
    let _e94 = local_18;
    if false {
        local_19 = 1.1f;
    } else {
        local_19 = 1.2f;
    }
    let _e101 = local_19;
    sharpnessStrength_1 = ((_e47 * ((_e53 + ((sharpen_slider * _e60) * 1.8f)) - max(0f, (0.4f + ((sharpen_slider * _e73) * _e80))))) + max(0f, (0.4f + ((sharpen_slider * _e94) * _e101))));
    let _e107 = scaleY;
    if false {
        local_20 = 0.6f;
    } else {
        local_20 = 0.5f;
    }
    let _e113 = local_20;
    if false {
        local_21 = 1.25f;
    } else {
        local_21 = 1f;
    }
    let _e120 = local_21;
    if false {
        local_22 = 0.06f;
    } else {
        local_22 = 0.1f;
    }
    let _e130 = local_22;
    if false {
        local_23 = 0.1f;
    } else {
        local_23 = 0.14f;
    }
    let _e136 = local_23;
    if false {
        local_24 = 1.25f;
    } else {
        local_24 = 1f;
    }
    let _e143 = local_24;
    if false {
        local_25 = 0.28f;
    } else {
        local_25 = 0.32f;
    }
    let _e150 = local_25;
    if false {
        local_26 = 0.06f;
    } else {
        local_26 = 0.1f;
    }
    let _e161 = local_26;
    if false {
        local_27 = 0.1f;
    } else {
        local_27 = 0.14f;
    }
    let _e167 = local_27;
    if false {
        local_28 = 1.25f;
    } else {
        local_28 = 1f;
    }
    let _e174 = local_28;
    if false {
        local_29 = 0.28f;
    } else {
        local_29 = 0.32f;
    }
    let _e181 = local_29;
    sharpnessLimit_1 = (((_e107 * ((_e113 + ((sharpen_slider * _e120) * 0.6f)) - max(_e130, (_e136 + ((sharpen_slider * _e143) * _e150))))) + max(_e161, (_e167 + ((sharpen_slider * _e174) * _e181)))) * p_2[2][2]);
    {
        loop {
            let _e196 = i_2;
            if !((_e196 < 5i)) {
                break;
            }
            {
                let _e203 = i_2;
                let _e206 = i_2;
                interp0Deg[_e203] = p_2[_e206][2];
            }
            continuing {
                let _e200 = i_2;
                i_2 = (_e200 + 1i);
            }
        }
    }
    let _e210 = interp0Deg;
    let _e211 = sharpnessStrength_1;
    let _e212 = sharpnessLimit_1;
    let _e213 = EvalUSM(_e210, _e211, _e212);
    rval.x = _e213;
    {
        loop {
            let _e217 = i_3;
            if !((_e217 < 5i)) {
                break;
            }
            {
                let _e224 = i_3;
                let _e226 = i_3;
                interp90Deg[_e224] = p_2[2][_e226];
            }
            continuing {
                let _e221 = i_3;
                i_3 = (_e221 + 1i);
            }
        }
    }
    let _e231 = interp90Deg;
    let _e232 = sharpnessStrength_1;
    let _e233 = sharpnessLimit_1;
    let _e234 = EvalUSM(_e231, _e232, _e233);
    rval.y = _e234;
    interp45Deg[0i] = p_2[1][1];
    interp45Deg[1i] = mix(p_2[2][1], p_2[1][2], 0.5f);
    interp45Deg[2i] = p_2[2][2];
    interp45Deg[3i] = mix(p_2[3][2], p_2[2][3], 0.5f);
    interp45Deg[4i] = p_2[3][3];
    let _e279 = interp45Deg;
    let _e280 = sharpnessStrength_1;
    let _e281 = sharpnessLimit_1;
    let _e282 = EvalUSM(_e279, _e280, _e281);
    rval.z = _e282;
    interp135Deg[0i] = p_2[3][1];
    interp135Deg[1i] = mix(p_2[3][2], p_2[2][1], 0.5f);
    interp135Deg[2i] = p_2[2][2];
    interp135Deg[3i] = mix(p_2[2][3], p_2[1][2], 0.5f);
    interp135Deg[4i] = p_2[1][3];
    let _e327 = interp135Deg;
    let _e328 = sharpnessStrength_1;
    let _e329 = sharpnessLimit_1;
    let _e330 = EvalUSM(_e327, _e328, _e329);
    rval.w = _e330;
    let _e331 = rval;
    return _e331;
}

fn hook() {
    var blockIdx: vec2<u32>;
    var threadIdx: u32;
    var dstBlockX: i32;
    var dstBlockY: i32;
    var kShift: f32 = -1.5f;
    var i_4: i32;
    var pos: vec2<u32>;
    var dy: i32;
    var dx: i32;
    var tx: f32;
    var ty: f32;
    var px: f32;
    var k: i32;
    var pos_1: vec2<i32>;
    var p_3: array<array<f32, 5>, 5>;
    var i_5: i32;
    var j_2: i32;
    var dirUSM: vec4<f32>;
    var w: vec4<f32>;
    var usmY: f32;
    var dstX: i32;
    var dstY: i32;
    var op: vec4<f32>;

    let _e11 = mpv_workgroup_id;
    blockIdx = _e11.xy;
    let _e14 = mpv_local_invocation_id;
    threadIdx = _e14.x;
    let _e18 = blockIdx;
    dstBlockX = i32((32u * _e18.x));
    let _e25 = blockIdx;
    dstBlockY = i32((32u * _e25.y));
    let _e38 = threadIdx;
    i_4 = (i32(_e38) * 2i);
    loop {
        let _e43 = i_4;
        if !((_e43 < 722i)) {
            break;
        }
        {
            let _e64 = i_4;
            let _e73 = i_4;
            pos = vec2<u32>((u32(_e64) % 38u), ((u32(_e73) / 38u) * 2u));
            dy = 0i;
            loop {
                let _e89 = dy;
                if !((_e89 < 2i)) {
                    break;
                }
                {
                    dx = 0i;
                    loop {
                        let _e98 = dx;
                        if !((_e98 < 2i)) {
                            break;
                        }
                        {
                            let _e105 = dstBlockX;
                            let _e106 = pos;
                            let _e110 = dx;
                            let _e113 = kShift;
                            let _e118 = mpv_texture0_size();
                            tx = ((f32(((u32(_e105) + _e106.x) + u32(_e110))) + _e113) * (vec2(1f) / _e118).x);
                            let _e123 = dstBlockY;
                            let _e124 = pos;
                            let _e128 = dy;
                            let _e131 = kShift;
                            let _e136 = mpv_texture0_size();
                            ty = ((f32(((u32(_e123) + _e124.y) + u32(_e128))) + _e131) * (vec2(1f) / _e136).y);
                            let _e141 = tx;
                            let _e142 = ty;
                            let _e144 = mpv_texture0_sample(vec2<f32>(_e141, _e142));
                            px = _e144.x;
                            let _e147 = pos;
                            let _e149 = dx;
                            let _e152 = pos;
                            let _e154 = dy;
                            let _e159 = px;
                            shPixelsY[(_e152.y + u32(_e154))][(_e147.x + u32(_e149))] = _e159;
                        }
                        continuing {
                            let _e102 = dx;
                            dx = (_e102 + 1i);
                        }
                    }
                }
                continuing {
                    let _e93 = dy;
                    dy = (_e93 + 1i);
                }
            }
        }
        continuing {
            let _e59 = i_4;
            i_4 = (_e59 + 512i);
        }
    }
    workgroupBarrier();
    let _e160 = threadIdx;
    k = i32(_e160);
    loop {
        let _e163 = k;
        if !((_e163 < 1024i)) {
            break;
        }
        {
            let _e172 = k;
            let _e177 = k;
            pos_1 = vec2<i32>(i32((u32(_e172) % 32u)), i32((u32(_e177) / 32u)));
            i_5 = 0i;
            loop {
                let _e189 = i_5;
                if !((_e189 < 5i)) {
                    break;
                }
                {
                    j_2 = 0i;
                    loop {
                        let _e198 = j_2;
                        if !((_e198 < 5i)) {
                            break;
                        }
                        {
                            let _e205 = j_2;
                            let _e206 = i_5;
                            let _e209 = pos_1;
                            let _e211 = j_2;
                            let _e213 = pos_1;
                            let _e215 = i_5;
                            let _e219 = shPixelsY[(_e213.y + _e215)][(_e209.x + _e211)];
                            p_3[_e206][_e205] = _e219;
                        }
                        continuing {
                            let _e202 = j_2;
                            j_2 = (_e202 + 1i);
                        }
                    }
                }
                continuing {
                    let _e193 = i_5;
                    i_5 = (_e193 + 1i);
                }
            }
            let _e220 = p_3;
            let _e221 = GetDirUSM(_e220);
            dirUSM = _e221;
            let _e223 = p_3;
            let _e234 = GetEdgeMap(_e223, 1i, 1i);
            w = _e234;
            let _e236 = dirUSM;
            let _e238 = w;
            let _e241 = dirUSM;
            let _e243 = w;
            let _e247 = dirUSM;
            let _e249 = w;
            let _e253 = dirUSM;
            let _e255 = w;
            usmY = ((((_e236.x * _e238.x) + (_e241.y * _e243.y)) + (_e247.z * _e249.z)) + (_e253.w * _e255.w));
            let _e260 = dstBlockX;
            let _e261 = pos_1;
            dstX = (_e260 + _e261.x);
            let _e265 = dstBlockY;
            let _e266 = pos_1;
            dstY = (_e265 + _e266.y);
            let _e270 = dstX;
            let _e276 = mpv_texture0_size();
            let _e280 = dstY;
            let _e286 = mpv_texture0_size();
            let _e291 = mpv_texture0_sample(vec2<f32>(((f32(_e270) + 0.5f) * (vec2(1f) / _e276).x), ((f32(_e280) + 0.5f) * (vec2(1f) / _e286).y)));
            op = _e291;
            let _e294 = op;
            let _e296 = usmY;
            op.x = (_e294.x + _e296);
            let _e298 = dstX;
            let _e299 = dstY;
            let _e301 = op;
            mpv_image_store(vec2<i32>(_e298, _e299), _e301);
        }
        continuing {
            let _e169 = k;
            k = (_e169 + 256i);
        }
    }
    return;
}

// A store outside the image is dropped
fn mpv_image_store(texel: vec2i, value: vec4f) {
    if (any(texel < vec2i(0)) || any(vec2u(texel) >= TARGET_size())) {
        return;
    }
    TARGET_store(vec2u(texel), value);
}

fn mpv_texture0_sample(position: vec2f) -> vec4f {
    let color = HOOKED_tex(position);
    return color;
}

fn mpv_texture0_size() -> vec2f {
    return HOOKED_size();
}

const MPV_WORKGROUP_SIZE = vec3u(256u, 1u, 1u);

fn compute(id: vec3u) {
    mpv_local_invocation_id = id % MPV_WORKGROUP_SIZE;
    mpv_workgroup_id = id / MPV_WORKGROUP_SIZE;
    hook();
}
