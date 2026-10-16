// Band step sizes as FFmpeg's init_band_stepsize computes them, in single precision with its double-precision steps where it takes them,
// and the integer factors of its dequantization: the 5/3 path's i_stepsize and the integer 9/7 path's scale.

use crate::codestream::{QUANTIZATION_NONE, QUANTIZATION_SCALAR_DERIVED, QUANTIZATION_SCALAR_EXPOUNDED, QuantizationStyle, COD_REVERSIBLE};

/// The 9/7 wavelet's synthesis gains as FFmpeg's float literals F_LFTG_K and F_LFTG_X hold them
#[cfg(test)]
const LIFTING_K: f32 = f32::from_bits(0x3F9D_7658);
const LIFTING_X: f32 = f32::from_bits(0x3F50_19C3);
/// pow(F_LFTG_K, n) for n from 0 to 65, each the correctly rounded double, as the C library's pow returns it for FFmpeg's step sizes
const LIFTING_K_POWERS: [u64; 66] = [
    0x3FF0000000000000, 0x3FF3AECB00000000, 0x3FF83697A94F9000, 0x3FFDC958FF03F05F, 0x40025240A0A18DE5, 0x400689D3B126AB68,
    0x400BB9E4353247AF, 0x40110DD22BB6CD6C, 0x4014FAB840DF028A, 0x4019CEEB8DCC034D, 0x401FBFA96B54E59C, 0x4023873828CCC6D8,
    0x402805E8F6C764B8, 0x402D8D75B5843B04, 0x40322D6A8D34398A, 0x40365C830EA57BCC, 0x403B822568629479, 0x4040EB8862FF6E60,
    0x4044D08A0D1654EC, 0x40499B07E2B05DBF, 0x404F7FD431E6B96B, 0x40535FF4E25A7138, 0x4057D59C255BF5DD, 0x405D520AD4A09607,
    0x406208DE8998371E, 0x40662F8D88048A87, 0x406B4AD6B000439C, 0x4070C9838A9F1616, 0x4074A6B0A7D55B0D, 0x4079678C8B4FDDC0,
    0x407F407F4FA10365, 0x408339008CB036AC, 0x4087A5B07042363A, 0x408D17176A4200BB, 0x4091E49C00E58166, 0x409602F2661594E8,
    0x409B13F72AB33AB9, 0x40A0A7C317FA904E, 0x40A47D2B66999079, 0x40A93478B5E8C74F, 0x40AF01A9C27A341F, 0x40B3125A8916F125,
    0x40B77625143AC32D, 0x40BCDC9A8638377A, 0x40C1C0A25F5F7613, 0x40C5D6B0F31AA465, 0x40CADD85F8E87156, 0x40D08646818D5636,
    0x40D453F9A037431B, 0x40D901CB925F1967, 0x40DEC3528A6F8975, 0x40E2EC023A16964C, 0x40E746F94F8EC91C, 0x40ECA2933A35E100,
    0x40F19CF112727BD5, 0x40F5AAC87AC32A1C, 0x40FAA7823CCE61F7, 0x4100650D3EE75E1D, 0x41042B1AACD6E1F9, 0x4108CF8452393E18,
    0x410E8578A980FB76, 0x4112C5F70373B5EF, 0x4117182C620CEE33, 0x411C690099CCC37F, 0x4121798788B1AD25, 0x41257F384A292026,
];
/// The largest step size FFmpeg keeps; a larger one becomes 0
const MAXIMUM_STEP: f32 = (i32::MAX >> 15) as f32;
const MANTISSA_SCALE: f64 = 2048.0;
const INTEGER_STEP_SCALE: f32 = 32768.0;
/// The single-sample float exponent bias of exp2fi, whose argument FFmpeg keeps within -126 to 128
const FLOAT_EXPONENT_BIAS: i32 = 127;
const FLOAT_MANTISSA_BITS: u32 = 23;
// The integer 9/7 dequantization's fixed-point shifts: PRESCALE and FFmpeg's 16 + I_PRESHIFT
const PRESCALE: i32 = 6;
const SCALE_SHIFT: i32 = 16 + 8;
const MAGNITUDE_TOP_BIT: i32 = 31;

/// 2^x as FFmpeg's exp2fi builds it from the float's exponent field.
fn exp2_float(exponent: i32) -> f32 {
    f32::from_bits(((exponent + FLOAT_EXPONENT_BIAS) as u32) << FLOAT_MANTISSA_BITS)
}

/// A band's float step size and FFmpeg's integer step derived from it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BandStep {
    pub step: f32,
    pub integer_step: i32,
}

/// FFmpeg's init_band_stepsize: the step of band `band` (0 for LL, else HL, LH, HH at 0, 1, 2) of resolution level `level`,
/// whose global band index is `global_band`, for a component of `component_bits` bits.
pub fn band_step(
    quantization: &QuantizationStyle,
    wavelet: u8,
    resolution_levels: u8,
    band: usize,
    global_band: usize,
    level: usize,
    component_bits: u8,
) -> BandStep {
    let mut step: f32 = match quantization.style {
        QUANTIZATION_NONE => 1.0,
        QUANTIZATION_SCALAR_DERIVED | QUANTIZATION_SCALAR_EXPOUNDED => {
            let exponent: i32 = i32::from(component_bits) - i32::from(quantization.exponents[global_band]);
            // Component bits less an exponent lie within -30 to 128, where exp2fi's field arithmetic makes 2^128 infinite
            let power: f32 = exp2_float(exponent.clamp(-126, 128));
            (f64::from(power) * (f64::from(quantization.mantissas[global_band]) / MANTISSA_SCALE + 1.0)) as f32
        }
        _ => 0.0,
    };
    if wavelet != COD_REVERSIBLE {
        let position: usize = band + usize::from(level > 0);
        let mut low_band: i32 = 0;
        match position {
            1 | 2 => {
                step *= LIFTING_X * 2.0;
                low_band = 1;
            }
            3 => step *= LIFTING_X * LIFTING_X * 4.0,
            _ => {}
        }
        let power: i32 = 2 * (i32::from(resolution_levels) - level as i32) + low_band - 2;
        let gain: f64 = f64::from_bits(LIFTING_K_POWERS[power.clamp(0, LIFTING_K_POWERS.len() as i32 - 1) as usize]);
        step = (f64::from(step) * gain) as f32;
    }
    if step > MAXIMUM_STEP {
        step = 0.0;
    }
    BandStep { step, integer_step: (step * INTEGER_STEP_SCALE).floor() as i32 }
}

/// The integer 9/7 path's scale of a band whose magnitude bits are `magnitude_bits`: FFmpeg's dequantization_int_97 computes it per code block.
pub fn irreversible_scale(step: f32, magnitude_bits: i32) -> i32 {
    let downshift: i32 = MAGNITUDE_TOP_BIT - magnitude_bits;
    let mut scale: f32 = step;
    // Each factor is a power of two, so each product is exact as FFmpeg's float steps are; FFmpeg's int shift by 31 makes INT_MIN on x86
    scale /= 1i32.wrapping_shl(downshift as u32) as f32;
    scale *= (1i32 << PRESCALE) as f32;
    scale *= (1i32 << SCALE_SHIFT) as f32;
    // FFmpeg rounds with a double 0.5 and truncates; C's conversion of a value outside int is undefined, which x86 makes INT_MIN
    let rounded: f64 = f64::from(scale) + 0.5;
    if rounded >= f64::from(i32::MAX) + 1.0 || rounded.is_nan() { i32::MIN } else { rounded as i32 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_the_reversible_identity_step() {
        let style: QuantizationStyle = QuantizationStyle::default();
        assert_eq!(band_step(&style, COD_REVERSIBLE, 6, 0, 0, 0, 8), BandStep { step: 1.0, integer_step: 32768 });
    }

    #[test]
    fn multiplies_irreversible_steps_by_the_lifting_gains() {
        let mut style: QuantizationStyle = QuantizationStyle { style: QUANTIZATION_SCALAR_EXPOUNDED, ..QuantizationStyle::default() };
        style.exponents[1] = 8;
        style.mantissas[1] = 1024;
        // An HL band at the coarsest level of three: 2^(8 - 8) * 1.5 * 2X * K^(2 * 2 + 1 - 2)
        let expected: f32 = ((1.5f32 * (LIFTING_X * 2.0)) as f64 * f64::from_bits(LIFTING_K_POWERS[3])) as f32;
        assert_eq!(band_step(&style, 0, 3, 0, 1, 1, 8).step, expected);
    }

    #[test]
    fn matches_the_double_precision_powers() {
        let base: f64 = f64::from(LIFTING_K);
        assert_eq!(f64::from_bits(LIFTING_K_POWERS[1]), base);
        assert_eq!(f64::from_bits(LIFTING_K_POWERS[2]), base * base);
        for (power, &bits) in LIFTING_K_POWERS.iter().enumerate().skip(3) {
            let approximate: f64 = base.powi(power as i32);
            assert!((f64::from_bits(bits) / approximate - 1.0).abs() < 1e-14, "power {power}");
        }
    }

    #[test]
    fn scales_an_irreversible_band_for_its_magnitude_bits() {
        // A step of 1.0 with 10 magnitude bits: 2^(10 - 31 + 6 + 24)
        assert_eq!(irreversible_scale(1.0, 10), 512);
    }
}
