//! name: NVIDIA Image Scaling and Sharpening v1.0.2
//! shape: compute
//! hook: LUMA
//! domain: any
//! input: HOOKED
//! bind: coef_scaler
//! bind: coef_usm
//! output: output.width, output.height, rgba16float
//! when: (((output.width * output.height) / (luma.width * luma.height)) > 1)
//! workgroup: 256, 1
//! dispatch: ceil(round(output.width) / 32), ceil(round(output.height) / 16)

// Converted from NVScaler.glsl by tools/convert_mpv_shader.py with naga 30.0.1

const sharpen_slider: f32 = -0.25f;

const kDetectRatio: f32 = 2.2011719f;

const kContrastBoost: f32 = 1f;

const kEps: f32 = 1f;

var<private> mpv_local_invocation_id: vec3<u32>;

var<private> mpv_workgroup_id: vec3<u32>;

var<workgroup> shPixelsY: array<f32, 836>;

var<workgroup> shCoefScaler: array<array<f32, 6>, 64>;

var<workgroup> shCoefUSM: array<array<f32, 6>, 64>;

var<workgroup> shEdgeMap: array<vec4<f32>, 612>;

fn GetEdgeMap(p: array<array<f32, 4>, 4>, i: i32, j: i32) -> vec4<f32> {
    var p_1: array<array<f32, 4>, 4>;
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
    let _e21 = j_1;
    let _e24 = i_1;
    let _e28 = p_1[(0i + _e24)][(0i + _e21)];
    let _e30 = j_1;
    let _e33 = i_1;
    let _e37 = p_1[(0i + _e33)][(1i + _e30)];
    let _e40 = j_1;
    let _e43 = i_1;
    let _e47 = p_1[(0i + _e43)][(2i + _e40)];
    let _e50 = j_1;
    let _e53 = i_1;
    let _e57 = p_1[(2i + _e53)][(0i + _e50)];
    let _e60 = j_1;
    let _e63 = i_1;
    let _e67 = p_1[(2i + _e63)][(1i + _e60)];
    let _e70 = j_1;
    let _e73 = i_1;
    let _e77 = p_1[(2i + _e73)][(2i + _e70)];
    g_0_ = abs((((((_e28 + _e37) + _e47) - _e57) - _e67) - _e77));
    let _e82 = j_1;
    let _e85 = i_1;
    let _e89 = p_1[(1i + _e85)][(0i + _e82)];
    let _e91 = j_1;
    let _e94 = i_1;
    let _e98 = p_1[(0i + _e94)][(0i + _e91)];
    let _e101 = j_1;
    let _e104 = i_1;
    let _e108 = p_1[(0i + _e104)][(1i + _e101)];
    let _e111 = j_1;
    let _e114 = i_1;
    let _e118 = p_1[(2i + _e114)][(1i + _e111)];
    let _e121 = j_1;
    let _e124 = i_1;
    let _e128 = p_1[(2i + _e124)][(2i + _e121)];
    let _e131 = j_1;
    let _e134 = i_1;
    let _e138 = p_1[(1i + _e134)][(2i + _e131)];
    g_45_ = abs((((((_e89 + _e98) + _e108) - _e118) - _e128) - _e138));
    let _e143 = j_1;
    let _e146 = i_1;
    let _e150 = p_1[(0i + _e146)][(0i + _e143)];
    let _e152 = j_1;
    let _e155 = i_1;
    let _e159 = p_1[(1i + _e155)][(0i + _e152)];
    let _e162 = j_1;
    let _e165 = i_1;
    let _e169 = p_1[(2i + _e165)][(0i + _e162)];
    let _e172 = j_1;
    let _e175 = i_1;
    let _e179 = p_1[(0i + _e175)][(2i + _e172)];
    let _e182 = j_1;
    let _e185 = i_1;
    let _e189 = p_1[(1i + _e185)][(2i + _e182)];
    let _e192 = j_1;
    let _e195 = i_1;
    let _e199 = p_1[(2i + _e195)][(2i + _e192)];
    g_90_ = abs((((((_e150 + _e159) + _e169) - _e179) - _e189) - _e199));
    let _e204 = j_1;
    let _e207 = i_1;
    let _e211 = p_1[(1i + _e207)][(0i + _e204)];
    let _e213 = j_1;
    let _e216 = i_1;
    let _e220 = p_1[(2i + _e216)][(0i + _e213)];
    let _e223 = j_1;
    let _e226 = i_1;
    let _e230 = p_1[(2i + _e226)][(1i + _e223)];
    let _e233 = j_1;
    let _e236 = i_1;
    let _e240 = p_1[(0i + _e236)][(1i + _e233)];
    let _e243 = j_1;
    let _e246 = i_1;
    let _e250 = p_1[(0i + _e246)][(2i + _e243)];
    let _e253 = j_1;
    let _e256 = i_1;
    let _e260 = p_1[(1i + _e256)][(2i + _e253)];
    g_135_ = abs((((((_e211 + _e220) + _e230) - _e240) - _e250) - _e260));
    let _e264 = g_0_;
    let _e265 = g_90_;
    g_0_90_max = max(_e264, _e265);
    let _e268 = g_0_;
    let _e269 = g_90_;
    g_0_90_min = min(_e268, _e269);
    let _e272 = g_45_;
    let _e273 = g_135_;
    g_45_135_max = max(_e272, _e273);
    let _e276 = g_45_;
    let _e277 = g_135_;
    g_45_135_min = min(_e276, _e277);
    let _e286 = g_0_90_max;
    let _e287 = g_45_135_max;
    if ((_e286 + _e287) == 0f) {
        {
            return vec4<f32>(0f, 0f, 0f, 0f);
        }
    }
    let _e301 = g_0_90_max;
    let _e302 = g_0_90_max;
    let _e303 = g_45_135_max;
    e_0_90_ = min((_e301 / (_e302 + _e303)), 1f);
    let _e309 = e_0_90_;
    e_45_135_ = (1f - _e309);
    let _e311 = g_0_90_max;
    let _e312 = g_0_90_min;
    let _e315 = g_0_90_max;
    if false {
        local = 32f;
    } else {
        local = 64f;
    }
    let _e321 = local;
    let _e326 = g_0_90_max;
    let _e327 = g_45_135_min;
    c_0_90_ = (((_e311 > (_e312 * kDetectRatio)) && (_e315 > (_e321 / 1024f))) && (_e326 > _e327));
    let _e331 = g_45_135_max;
    let _e332 = g_45_135_min;
    let _e335 = g_45_135_max;
    if false {
        local_1 = 32f;
    } else {
        local_1 = 64f;
    }
    let _e341 = local_1;
    let _e346 = g_45_135_max;
    let _e347 = g_0_90_min;
    c_45_135_ = (((_e331 > (_e332 * kDetectRatio)) && (_e335 > (_e341 / 1024f))) && (_e346 > _e347));
    let _e351 = g_0_90_max;
    let _e352 = g_0_;
    c_g_0_90_ = (_e351 == _e352);
    let _e355 = g_45_135_max;
    let _e356 = g_45_;
    c_g_45_135_ = (_e355 == _e356);
    let _e359 = c_0_90_;
    let _e360 = c_45_135_;
    if (_e359 && _e360) {
        let _e362 = e_0_90_;
        local_2 = _e362;
    } else {
        local_2 = 1f;
    }
    let _e365 = local_2;
    f_e_0_90_ = _e365;
    let _e367 = c_0_90_;
    let _e368 = c_45_135_;
    if (_e367 && _e368) {
        let _e370 = e_45_135_;
        local_3 = _e370;
    } else {
        local_3 = 1f;
    }
    let _e373 = local_3;
    f_e_45_135_ = _e373;
    let _e375 = c_0_90_;
    let _e376 = c_g_0_90_;
    if (_e375 && _e376) {
        let _e378 = f_e_0_90_;
        local_4 = _e378;
    } else {
        local_4 = 0f;
    }
    let _e381 = local_4;
    weight_0_ = _e381;
    let _e383 = c_0_90_;
    let _e384 = c_g_0_90_;
    if (_e383 && !(_e384)) {
        let _e387 = f_e_0_90_;
        local_5 = _e387;
    } else {
        local_5 = 0f;
    }
    let _e390 = local_5;
    weight_90_ = _e390;
    let _e392 = c_45_135_;
    let _e393 = c_g_45_135_;
    if (_e392 && _e393) {
        let _e395 = f_e_45_135_;
        local_6 = _e395;
    } else {
        local_6 = 0f;
    }
    let _e398 = local_6;
    weight_45_ = _e398;
    let _e400 = c_45_135_;
    let _e401 = c_g_45_135_;
    if (_e400 && !(_e401)) {
        let _e404 = f_e_45_135_;
        local_7 = _e404;
    } else {
        local_7 = 0f;
    }
    let _e407 = local_7;
    weight_135_ = _e407;
    let _e409 = weight_0_;
    let _e410 = weight_90_;
    let _e411 = weight_45_;
    let _e412 = weight_135_;
    return vec4<f32>(_e409, _e410, _e411, _e412);
}

fn LoadFilterBanksSh(i0_: i32, di: i32) {
    var i0_1: i32;
    var di_1: i32;
    var i_2: i32;
    var phase: i32;
    var vIdx: i32;
    var v: vec4<f32>;
    var filterOffset: i32;

    i0_1 = i0_;
    di_1 = di;
    let _e18 = i0_1;
    i_2 = _e18;
    loop {
        let _e20 = i_2;
        if !((_e20 < 128i)) {
            break;
        }
        {
            let _e29 = i_2;
            phase = (_e29 >> 1u);
            let _e34 = i_2;
            vIdx = (_e34 & 1i);
            let _e38 = vIdx;
            let _e39 = phase;
            let _e41 = mpv_texture1_fetch(vec2<i32>(_e38, _e39));
            v = vec4<f32>(_e41);
            let _e44 = vIdx;
            filterOffset = (_e44 * 4i);
            let _e48 = filterOffset;
            let _e51 = phase;
            let _e54 = v;
            shCoefScaler[_e51][(_e48 + 0i)] = _e54.x;
            let _e56 = filterOffset;
            let _e59 = phase;
            let _e62 = v;
            shCoefScaler[_e59][(_e56 + 1i)] = _e62.y;
            let _e64 = vIdx;
            if (_e64 == 0i) {
                {
                    let _e68 = phase;
                    let _e71 = v;
                    shCoefScaler[_e68][2i] = _e71.z;
                    let _e74 = phase;
                    let _e77 = v;
                    shCoefScaler[_e74][3i] = _e77.w;
                }
            }
            let _e79 = vIdx;
            let _e80 = phase;
            let _e82 = mpv_texture2_fetch(vec2<i32>(_e79, _e80));
            v = vec4<f32>(_e82);
            let _e84 = filterOffset;
            let _e87 = phase;
            let _e90 = v;
            shCoefUSM[_e87][(_e84 + 0i)] = _e90.x;
            let _e92 = filterOffset;
            let _e95 = phase;
            let _e98 = v;
            shCoefUSM[_e95][(_e92 + 1i)] = _e98.y;
            let _e100 = vIdx;
            if (_e100 == 0i) {
                {
                    let _e104 = phase;
                    let _e107 = v;
                    shCoefUSM[_e104][2i] = _e107.z;
                    let _e110 = phase;
                    let _e113 = v;
                    shCoefUSM[_e110][3i] = _e113.w;
                }
            }
        }
        continuing {
            let _e26 = i_2;
            let _e27 = di_1;
            i_2 = (_e26 + _e27);
        }
    }
    return;
}

fn CalcLTI(p0_: f32, p1_: f32, p2_: f32, p3_: f32, p4_: f32, p5_: f32, phase_index: i32) -> f32 {
    var p0_1: f32;
    var p1_1: f32;
    var p2_1: f32;
    var p3_1: f32;
    var p4_1: f32;
    var p5_1: f32;
    var phase_index_1: i32;
    var selector: bool;
    var local_8: f32;
    var sel: f32;
    var a_min: f32;
    var a_max: f32;
    var local_9: f32;
    var b_min: f32;
    var b_max: f32;
    var a_cont: f32;
    var b_cont: f32;
    var cont_ratio: f32;
    var local_10: f32;
    var local_11: f32;
    var local_12: f32;

    p0_1 = p0_;
    p1_1 = p1_;
    p2_1 = p2_;
    p3_1 = p3_;
    p4_1 = p4_;
    p5_1 = p5_;
    phase_index_1 = phase_index;
    let _e28 = phase_index_1;
    selector = (_e28 <= 32i);
    let _e34 = selector;
    if _e34 {
        let _e35 = p0_1;
        local_8 = _e35;
    } else {
        let _e36 = p3_1;
        local_8 = _e36;
    }
    let _e38 = local_8;
    sel = _e38;
    let _e40 = p1_1;
    let _e41 = p2_1;
    let _e43 = sel;
    a_min = min(min(_e40, _e41), _e43);
    let _e46 = p1_1;
    let _e47 = p2_1;
    let _e49 = sel;
    a_max = max(max(_e46, _e47), _e49);
    let _e52 = selector;
    if _e52 {
        let _e53 = p2_1;
        local_9 = _e53;
    } else {
        let _e54 = p5_1;
        local_9 = _e54;
    }
    let _e56 = local_9;
    sel = _e56;
    let _e57 = p3_1;
    let _e58 = p4_1;
    let _e60 = sel;
    b_min = min(min(_e57, _e58), _e60);
    let _e63 = p3_1;
    let _e64 = p4_1;
    let _e66 = sel;
    b_max = max(max(_e63, _e64), _e66);
    let _e69 = a_max;
    let _e70 = a_min;
    a_cont = (_e69 - _e70);
    let _e73 = b_max;
    let _e74 = b_min;
    b_cont = (_e73 - _e74);
    let _e77 = a_cont;
    let _e78 = b_cont;
    let _e80 = a_cont;
    let _e81 = b_cont;
    cont_ratio = (max(_e77, _e78) / (min(_e80, _e81) + kEps));
    let _e87 = cont_ratio;
    if false {
        local_10 = 1.5f;
    } else {
        local_10 = 2f;
    }
    let _e93 = local_10;
    if false {
        local_11 = 5f;
    } else {
        local_11 = 10f;
    }
    let _e101 = local_11;
    if false {
        local_12 = 1.5f;
    } else {
        local_12 = 2f;
    }
    let _e107 = local_12;
    return ((1f - clamp(((_e87 - _e93) * (1f / (_e101 - _e107))), 0f, 1f)) * kContrastBoost);
}

fn GetInterpEdgeMap(edge: array<array<vec4<f32>, 2>, 2>, phase_frac_x: f32, phase_frac_y: f32) -> vec4<f32> {
    var phase_frac_x_1: f32;
    var phase_frac_y_1: f32;
    var h0_: vec4<f32>;
    var h1_: vec4<f32>;

    phase_frac_x_1 = phase_frac_x;
    phase_frac_y_1 = phase_frac_y;
    let _e27 = phase_frac_x_1;
    h0_ = mix(edge[0][0], edge[0][1], vec4(_e27));
    let _e39 = phase_frac_x_1;
    h1_ = mix(edge[1][0], edge[1][1], vec4(_e39));
    let _e43 = h0_;
    let _e44 = h1_;
    let _e45 = phase_frac_y_1;
    return mix(_e43, _e44, vec4(_e45));
}

fn EvalPoly6_(pxl: array<f32, 6>, phase_int: i32) -> f32 {
    var phase_int_1: i32;
    var y: f32 = 0f;
    var i_3: i32 = 0i;
    var y_usm: f32 = 0f;
    var i_4: i32 = 0i;
    var local_13: f32;
    var local_14: f32;
    var local_15: f32;
    var y_scale: f32;
    var local_16: f32;
    var local_17: f32;
    var local_18: f32;
    var local_19: f32;
    var local_20: f32;
    var local_21: f32;
    var y_sharpness: f32;
    var local_22: f32;
    var local_23: f32;
    var local_24: f32;
    var local_25: f32;
    var local_26: f32;
    var local_27: f32;
    var local_28: f32;
    var local_29: f32;
    var local_30: f32;
    var local_31: f32;
    var y_sharpness_limit: f32;

    phase_int_1 = phase_int;
    {
        loop {
            let _e21 = i_3;
            if !((_e21 < 6i)) {
                break;
            }
            {
                let _e28 = y;
                let _e29 = i_3;
                let _e30 = phase_int_1;
                let _e33 = shCoefScaler[_e30][_e29];
                let _e34 = i_3;
                y = (_e28 + (_e33 * pxl[_e34]));
            }
            continuing {
                let _e25 = i_3;
                i_3 = (_e25 + 1i);
            }
        }
    }
    {
        loop {
            let _e42 = i_4;
            if !((_e42 < 6i)) {
                break;
            }
            {
                let _e49 = y_usm;
                let _e50 = i_4;
                let _e51 = phase_int_1;
                let _e54 = shCoefUSM[_e51][_e50];
                let _e55 = i_4;
                y_usm = (_e49 + (_e54 * pxl[_e55]));
            }
            continuing {
                let _e46 = i_4;
                i_4 = (_e46 + 1i);
            }
        }
    }
    let _e60 = y;
    if false {
        local_13 = 0.35f;
    } else {
        local_13 = 0.45f;
    }
    let _e70 = local_13;
    if false {
        local_14 = 0.55f;
    } else {
        local_14 = 0.9f;
    }
    let _e78 = local_14;
    if false {
        local_15 = 0.35f;
    } else {
        local_15 = 0.45f;
    }
    let _e84 = local_15;
    y_scale = (1f - clamp((((_e60 * 1f) - _e70) * (1f / (_e78 - _e84))), 0f, 1f));
    let _e95 = y_scale;
    if false {
        local_16 = 2.2f;
    } else {
        local_16 = 1.6f;
    }
    let _e101 = local_16;
    if false {
        local_17 = 1.25f;
    } else {
        local_17 = 1.75f;
    }
    let _e108 = local_17;
    if false {
        local_18 = 1.25f;
    } else {
        local_18 = 1f;
    }
    let _e121 = local_18;
    if false {
        local_19 = 1.1f;
    } else {
        local_19 = 1.2f;
    }
    let _e128 = local_19;
    if false {
        local_20 = 1.25f;
    } else {
        local_20 = 1f;
    }
    let _e142 = local_20;
    if false {
        local_21 = 1.1f;
    } else {
        local_21 = 1.2f;
    }
    let _e149 = local_21;
    y_sharpness = ((_e95 * ((_e101 + ((sharpen_slider * _e108) * 1.8f)) - max(0f, (0.4f + ((sharpen_slider * _e121) * _e128))))) + max(0f, (0.4f + ((sharpen_slider * _e142) * _e149))));
    let _e155 = y_usm;
    let _e156 = y_sharpness;
    y_usm = (_e155 * _e156);
    let _e158 = y_scale;
    if false {
        local_22 = 0.6f;
    } else {
        local_22 = 0.5f;
    }
    let _e164 = local_22;
    if false {
        local_23 = 1.25f;
    } else {
        local_23 = 1f;
    }
    let _e171 = local_23;
    if false {
        local_24 = 0.06f;
    } else {
        local_24 = 0.1f;
    }
    let _e181 = local_24;
    if false {
        local_25 = 0.1f;
    } else {
        local_25 = 0.14f;
    }
    let _e187 = local_25;
    if false {
        local_26 = 1.25f;
    } else {
        local_26 = 1f;
    }
    let _e194 = local_26;
    if false {
        local_27 = 0.28f;
    } else {
        local_27 = 0.32f;
    }
    let _e201 = local_27;
    if false {
        local_28 = 0.06f;
    } else {
        local_28 = 0.1f;
    }
    let _e212 = local_28;
    if false {
        local_29 = 0.1f;
    } else {
        local_29 = 0.14f;
    }
    let _e218 = local_29;
    if false {
        local_30 = 1.25f;
    } else {
        local_30 = 1f;
    }
    let _e225 = local_30;
    if false {
        local_31 = 0.28f;
    } else {
        local_31 = 0.32f;
    }
    let _e232 = local_31;
    let _e237 = y;
    y_sharpness_limit = (((_e158 * ((_e164 + ((sharpen_slider * _e171) * 0.6f)) - max(_e181, (_e187 + ((sharpen_slider * _e194) * _e201))))) + max(_e212, (_e218 + ((sharpen_slider * _e225) * _e232)))) * _e237);
    let _e240 = y_sharpness_limit;
    let _e241 = y_sharpness_limit;
    let _e243 = y_usm;
    y_usm = min(_e240, max(-(_e241), _e243));
    let _e246 = y_usm;
    let _e259 = phase_int_1;
    let _e260 = CalcLTI(pxl[0], pxl[1], pxl[2], pxl[3], pxl[4], pxl[5], _e259);
    y_usm = (_e246 * _e260);
    let _e262 = y;
    let _e263 = y_usm;
    return (_e262 + _e263);
}

fn FilterNormal(p_2: array<array<f32, 6>, 6>, phase_x_frac_int: i32, phase_y_frac_int: i32) -> f32 {
    var phase_x_frac_int_1: i32;
    var phase_y_frac_int_1: i32;
    var h_acc: f32 = 0f;
    var j_2: i32 = 0i;
    var v_acc: f32;
    var i_5: i32;

    phase_x_frac_int_1 = phase_x_frac_int;
    phase_y_frac_int_1 = phase_y_frac_int;
    loop {
        let _e23 = j_2;
        if !((_e23 < 6i)) {
            break;
        }
        {
            v_acc = 0f;
            i_5 = 0i;
            loop {
                let _e34 = i_5;
                if !((_e34 < 6i)) {
                    break;
                }
                {
                    let _e41 = v_acc;
                    let _e42 = j_2;
                    let _e43 = i_5;
                    let _e46 = i_5;
                    let _e47 = phase_y_frac_int_1;
                    let _e50 = shCoefScaler[_e47][_e46];
                    v_acc = (_e41 + (p_2[_e43][_e42] * _e50));
                }
                continuing {
                    let _e38 = i_5;
                    i_5 = (_e38 + 1i);
                }
            }
            let _e53 = h_acc;
            let _e54 = v_acc;
            let _e55 = j_2;
            let _e56 = phase_x_frac_int_1;
            let _e59 = shCoefScaler[_e56][_e55];
            h_acc = (_e53 + (_e54 * _e59));
        }
        continuing {
            let _e27 = j_2;
            j_2 = (_e27 + 1i);
        }
    }
    let _e62 = h_acc;
    return _e62;
}

fn AddDirFilters(p_3: array<array<f32, 6>, 6>, phase_x_frac: f32, phase_y_frac: f32, phase_x_frac_int_2: i32, phase_y_frac_int_2: i32, w: vec4<f32>) -> f32 {
    var p_4: array<array<f32, 6>, 6>;
    var phase_x_frac_1: f32;
    var phase_y_frac_1: f32;
    var phase_x_frac_int_3: i32;
    var phase_y_frac_int_3: i32;
    var w_1: vec4<f32>;
    var f: f32 = 0f;
    var interp0Deg: array<f32, 6>;
    var i_6: i32 = 0i;
    var interp90Deg: array<f32, 6>;
    var i_7: i32 = 0i;
    var pphase_b45_: f32;
    var temp_interp45Deg: array<f32, 7>;
    var local_32: f32;
    var a: f32;
    var local_33: f32;
    var b: f32;
    var local_34: f32;
    var c: f32;
    var local_35: f32;
    var d: f32;
    var interp45Deg: array<f32, 6>;
    var pphase_p45_: f32;
    var i_8: i32 = 0i;
    var i_9: i32 = 0i;
    var pphase_b135_: f32;
    var temp_interp135Deg: array<f32, 7>;
    var local_36: f32;
    var a_1: f32;
    var local_37: f32;
    var b_1: f32;
    var local_38: f32;
    var c_1: f32;
    var local_39: f32;
    var d_1: f32;
    var interp135Deg: array<f32, 6>;
    var pphase_p135_: f32;
    var i_10: i32 = 0i;
    var i_11: i32 = 0i;

    p_4 = p_3;
    phase_x_frac_1 = phase_x_frac;
    phase_y_frac_1 = phase_y_frac;
    phase_x_frac_int_3 = phase_x_frac_int_2;
    phase_y_frac_int_3 = phase_y_frac_int_2;
    w_1 = w;
    let _e28 = w_1;
    if (_e28.x > 0f) {
        {
            {
                loop {
                    let _e35 = i_6;
                    if !((_e35 < 6i)) {
                        break;
                    }
                    {
                        let _e42 = i_6;
                        let _e45 = i_6;
                        let _e48 = p_4[_e45][2];
                        let _e50 = i_6;
                        let _e53 = p_4[_e50][3];
                        let _e54 = phase_x_frac_1;
                        interp0Deg[_e42] = mix(_e48, _e53, _e54);
                    }
                    continuing {
                        let _e39 = i_6;
                        i_6 = (_e39 + 1i);
                    }
                }
            }
            let _e56 = f;
            let _e57 = interp0Deg;
            let _e58 = phase_y_frac_int_3;
            let _e59 = EvalPoly6_(_e57, _e58);
            let _e60 = w_1;
            f = (_e56 + (_e59 * _e60.x));
        }
    }
    let _e64 = w_1;
    if (_e64.y > 0f) {
        {
            {
                loop {
                    let _e71 = i_7;
                    if !((_e71 < 6i)) {
                        break;
                    }
                    {
                        let _e78 = i_7;
                        let _e80 = i_7;
                        let _e84 = p_4[2][_e80];
                        let _e85 = i_7;
                        let _e89 = p_4[3][_e85];
                        let _e90 = phase_y_frac_1;
                        interp90Deg[_e78] = mix(_e84, _e89, _e90);
                    }
                    continuing {
                        let _e75 = i_7;
                        i_7 = (_e75 + 1i);
                    }
                }
            }
            let _e92 = f;
            let _e93 = interp90Deg;
            let _e94 = phase_x_frac_int_3;
            let _e95 = EvalPoly6_(_e93, _e94);
            let _e96 = w_1;
            f = (_e92 + (_e95 * _e96.y));
        }
    }
    let _e100 = w_1;
    if (_e100.z > 0f) {
        {
            let _e107 = phase_x_frac_1;
            let _e108 = phase_y_frac_1;
            pphase_b45_ = (0.5f + (0.5f * (_e107 - _e108)));
            let _e119 = p_4[2][1];
            let _e124 = p_4[1][2];
            let _e125 = pphase_b45_;
            temp_interp45Deg[1i] = mix(_e119, _e124, _e125);
            let _e133 = p_4[3][2];
            let _e138 = p_4[2][3];
            let _e139 = pphase_b45_;
            temp_interp45Deg[3i] = mix(_e133, _e138, _e139);
            let _e147 = p_4[4][3];
            let _e152 = p_4[3][4];
            let _e153 = pphase_b45_;
            temp_interp45Deg[5i] = mix(_e147, _e152, _e153);
            {
                let _e155 = pphase_b45_;
                pphase_b45_ = (_e155 - 0.5f);
                let _e158 = pphase_b45_;
                if (_e158 >= 0f) {
                    let _e165 = p_4[0][2];
                    local_32 = _e165;
                } else {
                    let _e170 = p_4[2][0];
                    local_32 = _e170;
                }
                let _e172 = local_32;
                a = _e172;
                let _e174 = pphase_b45_;
                if (_e174 >= 0f) {
                    let _e181 = p_4[1][3];
                    local_33 = _e181;
                } else {
                    let _e186 = p_4[3][1];
                    local_33 = _e186;
                }
                let _e188 = local_33;
                b = _e188;
                let _e190 = pphase_b45_;
                if (_e190 >= 0f) {
                    let _e197 = p_4[2][4];
                    local_34 = _e197;
                } else {
                    let _e202 = p_4[4][2];
                    local_34 = _e202;
                }
                let _e204 = local_34;
                c = _e204;
                let _e206 = pphase_b45_;
                if (_e206 >= 0f) {
                    let _e213 = p_4[3][5];
                    local_35 = _e213;
                } else {
                    let _e218 = p_4[5][3];
                    local_35 = _e218;
                }
                let _e220 = local_35;
                d = _e220;
                let _e228 = p_4[1][1];
                let _e229 = a;
                let _e230 = pphase_b45_;
                temp_interp45Deg[0i] = mix(_e228, _e229, abs(_e230));
                let _e239 = p_4[2][2];
                let _e240 = b;
                let _e241 = pphase_b45_;
                temp_interp45Deg[2i] = mix(_e239, _e240, abs(_e241));
                let _e250 = p_4[3][3];
                let _e251 = c;
                let _e252 = pphase_b45_;
                temp_interp45Deg[4i] = mix(_e250, _e251, abs(_e252));
                let _e261 = p_4[4][4];
                let _e262 = d;
                let _e263 = pphase_b45_;
                temp_interp45Deg[6i] = mix(_e261, _e262, abs(_e263));
            }
            let _e267 = phase_x_frac_1;
            let _e268 = phase_y_frac_1;
            pphase_p45_ = (_e267 + _e268);
            let _e271 = pphase_p45_;
            if (_e271 >= 1f) {
                {
                    loop {
                        let _e277 = i_8;
                        if !((_e277 < 6i)) {
                            break;
                        }
                        {
                            let _e284 = i_8;
                            let _e286 = i_8;
                            let _e290 = temp_interp45Deg[(_e286 + 1i)];
                            interp45Deg[_e284] = _e290;
                        }
                        continuing {
                            let _e281 = i_8;
                            i_8 = (_e281 + 1i);
                        }
                    }
                    let _e291 = pphase_p45_;
                    pphase_p45_ = (_e291 - 1f);
                }
            } else {
                {
                    loop {
                        let _e297 = i_9;
                        if !((_e297 < 6i)) {
                            break;
                        }
                        {
                            let _e304 = i_9;
                            let _e306 = i_9;
                            let _e308 = temp_interp45Deg[_e306];
                            interp45Deg[_e304] = _e308;
                        }
                        continuing {
                            let _e301 = i_9;
                            i_9 = (_e301 + 1i);
                        }
                    }
                }
            }
            let _e309 = f;
            let _e310 = interp45Deg;
            let _e311 = pphase_p45_;
            let _e316 = EvalPoly6_(_e310, i32((_e311 * 64f)));
            let _e317 = w_1;
            f = (_e309 + (_e316 * _e317.z));
        }
    }
    let _e321 = w_1;
    if (_e321.w > 0f) {
        {
            let _e326 = phase_x_frac_1;
            let _e327 = phase_y_frac_1;
            pphase_b135_ = (0.5f * (_e326 + _e327));
            let _e338 = p_4[3][1];
            let _e343 = p_4[4][2];
            let _e344 = pphase_b135_;
            temp_interp135Deg[1i] = mix(_e338, _e343, _e344);
            let _e352 = p_4[2][2];
            let _e357 = p_4[3][3];
            let _e358 = pphase_b135_;
            temp_interp135Deg[3i] = mix(_e352, _e357, _e358);
            let _e366 = p_4[1][3];
            let _e371 = p_4[2][4];
            let _e372 = pphase_b135_;
            temp_interp135Deg[5i] = mix(_e366, _e371, _e372);
            {
                let _e374 = pphase_b135_;
                pphase_b135_ = (_e374 - 0.5f);
                let _e377 = pphase_b135_;
                if (_e377 >= 0f) {
                    let _e384 = p_4[5][2];
                    local_36 = _e384;
                } else {
                    let _e389 = p_4[3][0];
                    local_36 = _e389;
                }
                let _e391 = local_36;
                a_1 = _e391;
                let _e393 = pphase_b135_;
                if (_e393 >= 0f) {
                    let _e400 = p_4[4][3];
                    local_37 = _e400;
                } else {
                    let _e405 = p_4[2][1];
                    local_37 = _e405;
                }
                let _e407 = local_37;
                b_1 = _e407;
                let _e409 = pphase_b135_;
                if (_e409 >= 0f) {
                    let _e416 = p_4[3][4];
                    local_38 = _e416;
                } else {
                    let _e421 = p_4[1][2];
                    local_38 = _e421;
                }
                let _e423 = local_38;
                c_1 = _e423;
                let _e425 = pphase_b135_;
                if (_e425 >= 0f) {
                    let _e432 = p_4[2][5];
                    local_39 = _e432;
                } else {
                    let _e437 = p_4[0][3];
                    local_39 = _e437;
                }
                let _e439 = local_39;
                d_1 = _e439;
                let _e447 = p_4[4][1];
                let _e448 = a_1;
                let _e449 = pphase_b135_;
                temp_interp135Deg[0i] = mix(_e447, _e448, abs(_e449));
                let _e458 = p_4[3][2];
                let _e459 = b_1;
                let _e460 = pphase_b135_;
                temp_interp135Deg[2i] = mix(_e458, _e459, abs(_e460));
                let _e469 = p_4[2][3];
                let _e470 = c_1;
                let _e471 = pphase_b135_;
                temp_interp135Deg[4i] = mix(_e469, _e470, abs(_e471));
                let _e480 = p_4[1][4];
                let _e481 = d_1;
                let _e482 = pphase_b135_;
                temp_interp135Deg[6i] = mix(_e480, _e481, abs(_e482));
            }
            let _e487 = phase_x_frac_1;
            let _e488 = phase_y_frac_1;
            pphase_p135_ = (1f + (_e487 - _e488));
            let _e493 = pphase_p135_;
            if (_e493 >= 1f) {
                {
                    loop {
                        let _e499 = i_10;
                        if !((_e499 < 6i)) {
                            break;
                        }
                        {
                            let _e506 = i_10;
                            let _e508 = i_10;
                            let _e512 = temp_interp135Deg[(_e508 + 1i)];
                            interp135Deg[_e506] = _e512;
                        }
                        continuing {
                            let _e503 = i_10;
                            i_10 = (_e503 + 1i);
                        }
                    }
                    let _e513 = pphase_p135_;
                    pphase_p135_ = (_e513 - 1f);
                }
            } else {
                {
                    loop {
                        let _e519 = i_11;
                        if !((_e519 < 6i)) {
                            break;
                        }
                        {
                            let _e526 = i_11;
                            let _e528 = i_11;
                            let _e530 = temp_interp135Deg[_e528];
                            interp135Deg[_e526] = _e530;
                        }
                        continuing {
                            let _e523 = i_11;
                            i_11 = (_e523 + 1i);
                        }
                    }
                }
            }
            let _e531 = f;
            let _e532 = interp135Deg;
            let _e533 = pphase_p135_;
            let _e538 = EvalPoly6_(_e532, i32((_e533 * 64f)));
            let _e539 = w_1;
            f = (_e531 + (_e538 * _e539.w));
        }
    }
    let _e543 = f;
    return _e543;
}

fn hook() {
    var blockIdx: vec2<u32>;
    var threadIdx: u32;
    var dstBlockX: i32;
    var dstBlockY: i32;
    var srcBlockStartX: i32;
    var srcBlockStartY: i32;
    var srcBlockEndX: i32;
    var srcBlockEndY: i32;
    var numTilePixelsX: i32;
    var numTilePixelsY: i32;
    var numTilePixels: i32;
    var numEdgeMapPixelsX: i32;
    var numEdgeMapPixelsY: i32;
    var numEdgeMapPixels: i32;
    var i_12: u32;
    var py: u32;
    var px: u32;
    var kShift: f32;
    var tx: f32;
    var ty: f32;
    var p_5: array<array<f32, 2>, 2>;
    var sY: vec4<f32>;
    var idx: u32;
    var i_13: u32;
    var py_1: u32;
    var px_1: u32;
    var edgeMapIdx: u32;
    var tileCornerIdx: u32;
    var p_6: array<array<f32, 4>, 4>;
    var j_3: i32;
    var k: i32;
    var pos: vec2<i32>;
    var dstX: i32;
    var srcX: f32;
    var px_2: i32;
    var fx: f32;
    var fx_int: i32;
    var k_1: i32 = 0i;
    var dstY: i32;
    var srcY: f32;
    var py_2: i32;
    var fy: f32;
    var fy_int: i32;
    var startEdgeMapIdx: i32;
    var edge_1: array<array<vec4<f32>, 2>, 2>;
    var i_14: i32;
    var j_4: i32;
    var w_2: vec4<f32>;
    var startTileIdx: i32;
    var p_7: array<array<f32, 6>, 6>;
    var i_15: i32;
    var j_5: i32;
    var baseWeight: f32;
    var opY: f32;
    var op: vec4<f32>;
    var corr: f32;

    let _e14 = mpv_workgroup_id;
    blockIdx = _e14.xy;
    let _e17 = mpv_local_invocation_id;
    threadIdx = _e17.x;
    let _e21 = blockIdx;
    dstBlockX = i32((32u * _e21.x));
    let _e28 = blockIdx;
    dstBlockY = i32((16u * _e28.y));
    let _e34 = dstBlockX;
    let _e38 = mpv_texture0_size();
    let _e40 = mpv_target_size();
    srcBlockStartX = i32(floor((((f32(_e34) + 0.5f) * (_e38.x / _e40.x)) - 0.5f)));
    let _e49 = dstBlockY;
    let _e53 = mpv_texture0_size();
    let _e55 = mpv_target_size();
    srcBlockStartY = i32(floor((((f32(_e49) + 0.5f) * (_e53.y / _e55.y)) - 0.5f)));
    let _e64 = dstBlockX;
    let _e70 = mpv_texture0_size();
    let _e72 = mpv_target_size();
    srcBlockEndX = i32(ceil((((f32((_e64 + 32i)) + 0.5f) * (_e70.x / _e72.x)) - 0.5f)));
    let _e81 = dstBlockY;
    let _e87 = mpv_texture0_size();
    let _e89 = mpv_target_size();
    srcBlockEndY = i32(ceil((((f32((_e81 + 16i)) + 0.5f) * (_e87.y / _e89.y)) - 0.5f)));
    let _e98 = srcBlockEndX;
    let _e99 = srcBlockStartX;
    numTilePixelsX = (((_e98 - _e99) + 6i) - 1i);
    let _e106 = srcBlockEndY;
    let _e107 = srcBlockStartY;
    numTilePixelsY = (((_e106 - _e107) + 6i) - 1i);
    let _e114 = numTilePixelsX;
    let _e115 = numTilePixelsX;
    numTilePixelsX = (_e114 + (_e115 & 1i));
    let _e119 = numTilePixelsY;
    let _e120 = numTilePixelsY;
    numTilePixelsY = (_e119 + (_e120 & 1i));
    let _e124 = numTilePixelsX;
    let _e125 = numTilePixelsY;
    numTilePixels = (_e124 * _e125);
    let _e128 = numTilePixelsX;
    numEdgeMapPixelsX = ((_e128 - 6i) + 2i);
    let _e134 = numTilePixelsY;
    numEdgeMapPixelsY = ((_e134 - 6i) + 2i);
    let _e140 = numEdgeMapPixelsX;
    let _e141 = numEdgeMapPixelsY;
    numEdgeMapPixels = (_e140 * _e141);
    {
        let _e144 = threadIdx;
        i_12 = (_e144 * 2u);
        loop {
            let _e149 = i_12;
            let _e150 = numTilePixels;
            if !((_e149 < (u32(_e150) >> 1u))) {
                break;
            }
            {
                let _e163 = i_12;
                let _e164 = numTilePixelsX;
                py = ((_e163 / u32(_e164)) * 2u);
                let _e171 = i_12;
                let _e172 = numTilePixelsX;
                px = (_e171 % u32(_e172));
                kShift = -1.5f;
                let _e185 = srcBlockStartX;
                let _e186 = px;
                let _e189 = kShift;
                let _e194 = mpv_texture0_size();
                tx = ((f32((u32(_e185) + _e186)) + _e189) * (vec2(1f) / _e194).x);
                let _e199 = srcBlockStartY;
                let _e200 = py;
                let _e203 = kShift;
                let _e208 = mpv_texture0_size();
                ty = ((f32((u32(_e199) + _e200)) + _e203) * (vec2(1f) / _e208).y);
                {
                    let _e214 = tx;
                    let _e215 = ty;
                    let _e218 = mpv_texture0_gather(vec2<f32>(_e214, _e215), 0i);
                    sY = _e218;
                    let _e224 = sY;
                    p_5[0i][0i] = _e224.w;
                    let _e230 = sY;
                    p_5[0i][1i] = _e230.z;
                    let _e236 = sY;
                    p_5[1i][0i] = _e236.x;
                    let _e242 = sY;
                    p_5[1i][1i] = _e242.y;
                }
                let _e244 = py;
                let _e250 = px;
                idx = ((_e244 * 38u) + _e250);
                let _e253 = idx;
                let _e259 = p_5[0][0];
                shPixelsY[_e253] = f32(_e259);
                let _e261 = idx;
                let _e270 = p_5[0][1];
                shPixelsY[(_e261 + 1u)] = f32(_e270);
                let _e272 = idx;
                let _e283 = p_5[1][0];
                shPixelsY[(_e272 + 38u)] = f32(_e283);
                let _e285 = idx;
                let _e299 = p_5[1][1];
                shPixelsY[((_e285 + 38u) + 1u)] = f32(_e299);
            }
            continuing {
                let _e157 = i_12;
                i_12 = (_e157 + 512u);
            }
        }
    }
    workgroupBarrier();
    {
        let _e301 = threadIdx;
        i_13 = (_e301 * 2u);
        loop {
            let _e306 = i_13;
            let _e307 = numEdgeMapPixels;
            if !((_e306 < (u32(_e307) >> 1u))) {
                break;
            }
            {
                let _e320 = i_13;
                let _e321 = numEdgeMapPixelsX;
                py_1 = ((_e320 / u32(_e321)) * 2u);
                let _e328 = i_13;
                let _e329 = numEdgeMapPixelsX;
                px_1 = (_e328 % u32(_e329));
                let _e333 = py_1;
                let _e339 = px_1;
                edgeMapIdx = ((_e333 * 34u) + _e339);
                let _e342 = py_1;
                let _e351 = px_1;
                tileCornerIdx = ((((_e342 + 1u) * 38u) + _e351) + 1u);
                j_3 = 0i;
                loop {
                    let _e360 = j_3;
                    if !((_e360 < 4i)) {
                        break;
                    }
                    {
                        k = 0i;
                        loop {
                            let _e369 = k;
                            if !((_e369 < 4i)) {
                                break;
                            }
                            {
                                let _e376 = k;
                                let _e377 = j_3;
                                let _e380 = tileCornerIdx;
                                let _e381 = j_3;
                                let _e388 = k;
                                let _e392 = shPixelsY[((_e380 + u32((_e381 * 38i))) + u32(_e388))];
                                p_6[_e377][_e376] = _e392;
                            }
                            continuing {
                                let _e373 = k;
                                k = (_e373 + 1i);
                            }
                        }
                    }
                    continuing {
                        let _e364 = j_3;
                        j_3 = (_e364 + 1i);
                    }
                }
                let _e393 = edgeMapIdx;
                let _e395 = p_6;
                let _e398 = GetEdgeMap(_e395, 0i, 0i);
                shEdgeMap[_e393] = vec4<f32>(_e398);
                let _e400 = edgeMapIdx;
                let _e405 = p_6;
                let _e408 = GetEdgeMap(_e405, 0i, 1i);
                shEdgeMap[(_e400 + 1u)] = vec4<f32>(_e408);
                let _e410 = edgeMapIdx;
                let _e417 = p_6;
                let _e420 = GetEdgeMap(_e417, 1i, 0i);
                shEdgeMap[(_e410 + 34u)] = vec4<f32>(_e420);
                let _e422 = edgeMapIdx;
                let _e432 = p_6;
                let _e435 = GetEdgeMap(_e432, 1i, 1i);
                shEdgeMap[((_e422 + 34u) + 1u)] = vec4<f32>(_e435);
            }
            continuing {
                let _e314 = i_13;
                i_13 = (_e314 + 512u);
            }
        }
    }
    let _e437 = threadIdx;
    LoadFilterBanksSh(i32(_e437), 256i);
    workgroupBarrier();
    let _e440 = threadIdx;
    let _e445 = threadIdx;
    pos = vec2<i32>(i32((u32(_e440) % 32u)), i32((u32(_e445) / 32u)));
    let _e454 = dstBlockX;
    let _e455 = pos;
    dstX = (_e454 + _e455.x);
    let _e460 = dstX;
    let _e463 = mpv_texture0_size();
    let _e465 = mpv_target_size();
    srcX = (((0.5f + f32(_e460)) * (_e463.x / _e465.x)) - 0.5f);
    let _e472 = srcX;
    let _e474 = srcBlockStartX;
    px_2 = i32((floor(_e472) - f32(_e474)));
    let _e479 = srcX;
    let _e480 = srcX;
    fx = (_e479 - floor(_e480));
    let _e484 = fx;
    fx_int = i32((_e484 * 64f));
    loop {
        let _e492 = k_1;
        if !((_e492 < 2i)) {
            break;
        }
        {
            let _e503 = dstBlockY;
            let _e504 = pos;
            let _e507 = k_1;
            dstY = ((_e503 + _e504.y) + (_e507 * 8i));
            let _e515 = dstY;
            let _e518 = mpv_texture0_size();
            let _e520 = mpv_target_size();
            srcY = (((0.5f + f32(_e515)) * (_e518.y / _e520.y)) - 0.5f);
            let _e527 = srcY;
            let _e529 = srcBlockStartY;
            py_2 = i32((floor(_e527) - f32(_e529)));
            let _e534 = srcY;
            let _e535 = srcY;
            fy = (_e534 - floor(_e535));
            let _e539 = fy;
            fy_int = i32((_e539 * 64f));
            let _e545 = py_2;
            let _e550 = px_2;
            startEdgeMapIdx = ((_e545 * 34i) + _e550);
            i_14 = 0i;
            loop {
                let _e556 = i_14;
                if !((_e556 < 2i)) {
                    break;
                }
                {
                    j_4 = 0i;
                    loop {
                        let _e565 = j_4;
                        if !((_e565 < 2i)) {
                            break;
                        }
                        {
                            let _e572 = j_4;
                            let _e573 = i_14;
                            let _e576 = startEdgeMapIdx;
                            let _e577 = i_14;
                            let _e583 = j_4;
                            let _e586 = shEdgeMap[((_e576 + (_e577 * 34i)) + _e583)];
                            edge_1[_e573][_e572] = _e586;
                        }
                        continuing {
                            let _e569 = j_4;
                            j_4 = (_e569 + 1i);
                        }
                    }
                }
                continuing {
                    let _e560 = i_14;
                    i_14 = (_e560 + 1i);
                }
            }
            let _e587 = edge_1;
            let _e588 = fx;
            let _e589 = fy;
            let _e590 = GetInterpEdgeMap(_e587, _e588, _e589);
            w_2 = (_e590 * 1f);
            let _e595 = py_2;
            let _e600 = px_2;
            startTileIdx = ((_e595 * 38i) + _e600);
            {
                i_15 = 0i;
                loop {
                    let _e606 = i_15;
                    if !((_e606 < 6i)) {
                        break;
                    }
                    {
                        j_5 = 0i;
                        loop {
                            let _e615 = j_5;
                            if !((_e615 < 6i)) {
                                break;
                            }
                            {
                                let _e622 = j_5;
                                let _e623 = i_15;
                                let _e626 = startTileIdx;
                                let _e627 = i_15;
                                let _e633 = j_5;
                                let _e636 = shPixelsY[((_e626 + (_e627 * 38i)) + _e633)];
                                p_7[_e623][_e622] = _e636;
                            }
                            continuing {
                                let _e619 = j_5;
                                j_5 = (_e619 + 1i);
                            }
                        }
                    }
                    continuing {
                        let _e610 = i_15;
                        i_15 = (_e610 + 1i);
                    }
                }
            }
            let _e638 = w_2;
            let _e641 = w_2;
            let _e644 = w_2;
            let _e647 = w_2;
            baseWeight = ((((1f - _e638.x) - _e641.y) - _e644.z) - _e647.w);
            opY = 0f;
            let _e654 = opY;
            let _e655 = p_7;
            let _e656 = fx_int;
            let _e657 = fy_int;
            let _e658 = FilterNormal(_e655, _e656, _e657);
            let _e659 = baseWeight;
            opY = (_e654 + (_e658 * _e659));
            let _e662 = opY;
            let _e663 = p_7;
            let _e664 = fx;
            let _e665 = fy;
            let _e666 = fx_int;
            let _e667 = fy_int;
            let _e668 = w_2;
            let _e669 = AddDirFilters(_e663, _e664, _e665, _e666, _e667, _e668);
            opY = (_e662 + _e669);
            let _e671 = srcX;
            let _e676 = mpv_texture0_size();
            let _e680 = srcY;
            let _e685 = mpv_texture0_size();
            let _e690 = mpv_texture0_sample(vec2<f32>(((_e671 + 0.5f) * (vec2(1f) / _e676).x), ((_e680 + 0.5f) * (vec2(1f) / _e685).y)));
            op = _e690;
            let _e692 = opY;
            let _e697 = op;
            corr = ((_e692 * 1f) - _e697.x);
            let _e702 = op;
            let _e704 = corr;
            op.x = (_e702.x + _e704);
            let _e706 = dstX;
            let _e707 = dstY;
            let _e709 = op;
            mpv_image_store(vec2<i32>(_e706, _e707), _e709);
        }
        continuing {
            let _e500 = k_1;
            k_1 = (_e500 + 1i);
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

fn mpv_target_size() -> vec2f {
    return presentation.outputSize;
}

fn mpv_texture0_sample(position: vec2f) -> vec4f {
    let color = HOOKED_tex(position);
    return color;
}

fn mpv_texture0_size() -> vec2f {
    return HOOKED_size();
}

// The four texels textureGather reads, sampled at their centers, in its (0, 1), (1, 1), (1, 0), (0, 0) order
fn mpv_texture0_gather(position: vec2f, component: i32) -> vec4f {
    let size = mpv_texture0_size();
    let origin = floor(position * size - vec2f(0.5)) + vec2f(0.5);
    let lowerLeft = mpv_texture0_sample((origin + vec2f(0.0, 1.0)) / size);
    let lowerRight = mpv_texture0_sample((origin + vec2f(1.0, 1.0)) / size);
    let upperRight = mpv_texture0_sample((origin + vec2f(1.0, 0.0)) / size);
    let upperLeft = mpv_texture0_sample(origin / size);
    return vec4f(lowerLeft[component], lowerRight[component], upperRight[component], upperLeft[component]);
}

fn mpv_texture1_fetch(texel: vec2i) -> vec4f {
    return coef_scaler_load(texel);
}

fn mpv_texture2_fetch(texel: vec2i) -> vec4f {
    return coef_usm_load(texel);
}

const MPV_WORKGROUP_SIZE = vec3u(256u, 1u, 1u);

fn compute(id: vec3u) {
    mpv_local_invocation_id = id % MPV_WORKGROUP_SIZE;
    mpv_workgroup_id = id / MPV_WORKGROUP_SIZE;
    hook();
}

//! texture: coef_scaler
//! size: 2, 64
//! format: rgba32float
//! filter: nearest
//! edge: clamp

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

//! texture: coef_usm
//! size: 2, 64
//! format: rgba32float
//! filter: nearest
//! edge: clamp

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
