// The pixel format FFmpeg's decoder picks for a codestream, and how this decoder writes it into the engine's planar YUV formats.
// FFmpeg tries its candidate formats in order: XYZ first for Digital Cinema profiles, then by the JP2 colour space, RGB first when none is given.
// Its YUV and YUVA picks map onto the engine's formats, at 4:2:0, 4:2:2, or 4:4:4 and up to 12 bits, and its XYZ pick onto 12-bit 4:4:4,
// which the output stage converts to BT.709 Y'CbCr; any other pick is recorded as the picture's format error, which the GPU reports,
// so a test may still decode the components into planes.

use crate::codestream::{ImageSize, MAXIMUM_COMPONENTS};
use crate::container::ColourInfo;
use crate::error::{DecodeResult, fail};
use crate::layout::{
    ERROR_BIT_DEPTH, ERROR_CHROMA_FORMAT, ERROR_CODE_SHIFT, ERROR_COLOUR_SPACE, ERROR_COMPONENT_COUNT, OUTPUT_TRANSFORM_NONE, OUTPUT_TRANSFORM_XYZ,
};

// Enumerated colour spaces of a JP2 colr box that pick FFmpeg's candidate list
const COLOUR_SPACE_SRGB: u32 = 16;
const COLOUR_SPACE_GREYSCALE: u32 = 17;
const COLOUR_SPACE_SYCC: u32 = 18;
// Rsiz values of the Digital Cinema profiles, whose components FFmpeg reads as XYZ
const PROFILE_DIGITAL_CINEMA_2K: u16 = 3;
const PROFILE_DIGITAL_CINEMA_4K: u16 = 4;
// The engine's chroma formats, as chroma_format_idc counts them
pub const CHROMA_FORMAT_420: u32 = 1;
pub const CHROMA_FORMAT_422: u32 = 2;
pub const CHROMA_FORMAT_444: u32 = 3;
// The engine's output bit depths
const OUTPUT_DEPTH_8: u32 = 8;
const OUTPUT_DEPTH_10: u32 = 10;
const OUTPUT_DEPTH_12: u32 = 12;
/// FFmpeg writes every component of a picture at or below 8 bits as 8-bit samples
const BYTE_PRECISION: i32 = 8;
// The families of formats the engine cannot show, the failing value of a colourSpace error; XYZ, 3, shows since its conversion
pub const FAMILY_RGB: u32 = 1;
pub const FAMILY_GREY: u32 = 2;
pub const FAMILY_PALETTE: u32 = 4;
/// FFmpeg writes XYZ in 16-bit samples, each shifted up from its component's precision, which its converter reads at 12 bits
const XYZ_PRECISION: i32 = 12;

/// What kind of picture a pixel format holds.
// The project spells acronyms in capitals
#[allow(clippy::upper_case_acronyms)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FormatKind {
    YUV,
    RGB,
    Grey,
    XYZ,
    Palette,
}

/// One of FFmpeg's candidate pixel formats: its components, their depth, and its chroma subsampling.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelFormat {
    kind: FormatKind,
    components: usize,
    depth: i32,
    chroma_width_log2: u32,
    chroma_height_log2: u32,
}

// The fields of a pixel format's word in a serialized plan
const WORD_COMPONENTS_SHIFT: u32 = 4;
const WORD_DEPTH_SHIFT: u32 = 8;
const WORD_CHROMA_WIDTH_SHIFT: u32 = 16;
const WORD_CHROMA_HEIGHT_SHIFT: u32 = 20;
const WORD_FIELD_MASK: u32 = 0xF;
const WORD_DEPTH_MASK: u32 = 0xFF;

impl PixelFormat {
    /// The format as one word of a serialized plan.
    pub fn to_word(self) -> u32 {
        let kind: u32 = match self.kind {
            FormatKind::YUV => 0,
            FormatKind::RGB => 1,
            FormatKind::Grey => 2,
            FormatKind::XYZ => 3,
            FormatKind::Palette => 4,
        };
        kind | ((self.components as u32) << WORD_COMPONENTS_SHIFT)
            | ((self.depth as u32) << WORD_DEPTH_SHIFT)
            | (self.chroma_width_log2 << WORD_CHROMA_WIDTH_SHIFT)
            | (self.chroma_height_log2 << WORD_CHROMA_HEIGHT_SHIFT)
    }

    /// Reads a format from its word, or None for a word no format writes.
    pub fn from_word(word: u32) -> Option<Self> {
        let kind: FormatKind = match word & WORD_FIELD_MASK {
            0 => FormatKind::YUV,
            1 => FormatKind::RGB,
            2 => FormatKind::Grey,
            3 => FormatKind::XYZ,
            4 => FormatKind::Palette,
            _ => return None,
        };
        Some(Self {
            kind,
            components: ((word >> WORD_COMPONENTS_SHIFT) & WORD_FIELD_MASK) as usize,
            depth: ((word >> WORD_DEPTH_SHIFT) & WORD_DEPTH_MASK) as i32,
            chroma_width_log2: (word >> WORD_CHROMA_WIDTH_SHIFT) & WORD_FIELD_MASK,
            chroma_height_log2: (word >> WORD_CHROMA_HEIGHT_SHIFT) & WORD_FIELD_MASK,
        })
    }
}

const fn yuv(components: usize, depth: i32, chroma_width_log2: u32, chroma_height_log2: u32) -> PixelFormat {
    PixelFormat { kind: FormatKind::YUV, components, depth, chroma_width_log2, chroma_height_log2 }
}

const fn packed(kind: FormatKind, components: usize, depth: i32) -> PixelFormat {
    PixelFormat { kind, components, depth, chroma_width_log2: 0, chroma_height_log2: 0 }
}

// FFmpeg's candidate lists, in its order: shallower formats before deeper ones of the same layout
const RGB_FORMATS: [PixelFormat; 5] = [
    packed(FormatKind::Palette, 1, 8),
    packed(FormatKind::RGB, 3, 8),
    packed(FormatKind::RGB, 4, 8),
    packed(FormatKind::RGB, 3, 16),
    packed(FormatKind::RGB, 4, 16),
];
const GREY_FORMATS: [PixelFormat; 4] = [
    packed(FormatKind::Grey, 1, 8),
    packed(FormatKind::Grey, 2, 8),
    packed(FormatKind::Grey, 1, 16),
    packed(FormatKind::Grey, 2, 16),
];
const YUV_FORMATS: [PixelFormat; 33] = [
    yuv(3, 8, 2, 2),
    yuv(3, 8, 2, 0),
    yuv(4, 8, 1, 1),
    yuv(3, 8, 1, 1),
    yuv(3, 8, 1, 0),
    yuv(4, 8, 1, 0),
    yuv(3, 8, 0, 1),
    yuv(3, 8, 0, 0),
    yuv(4, 8, 0, 0),
    yuv(3, 9, 1, 1),
    yuv(3, 9, 1, 0),
    yuv(3, 9, 0, 0),
    yuv(4, 9, 1, 1),
    yuv(4, 9, 1, 0),
    yuv(4, 9, 0, 0),
    yuv(3, 10, 1, 1),
    yuv(3, 10, 1, 0),
    yuv(3, 10, 0, 0),
    yuv(4, 10, 1, 1),
    yuv(4, 10, 1, 0),
    yuv(4, 10, 0, 0),
    yuv(3, 12, 1, 1),
    yuv(3, 12, 1, 0),
    yuv(3, 12, 0, 0),
    yuv(3, 14, 1, 1),
    yuv(3, 14, 1, 0),
    yuv(3, 14, 0, 0),
    yuv(3, 16, 1, 1),
    yuv(3, 16, 1, 0),
    yuv(3, 16, 0, 0),
    yuv(4, 16, 1, 1),
    yuv(4, 16, 1, 0),
    yuv(4, 16, 0, 0),
];
const XYZ_FORMAT: PixelFormat = packed(FormatKind::XYZ, 3, 12);
// The formats FFmpeg falls back to when no candidate fits
const YUVA_420_FALLBACK: PixelFormat = yuv(4, 8, 1, 1);
const RGB_FALLBACK: PixelFormat = packed(FormatKind::RGB, 3, 8);
const GREY_ALPHA_FALLBACK: PixelFormat = packed(FormatKind::Grey, 2, 8);
const GREY_ALPHA_16_FALLBACK: PixelFormat = packed(FormatKind::Grey, 2, 16);
const GREY_FALLBACK: PixelFormat = packed(FormatKind::Grey, 1, 8);
const GREY_16_FALLBACK: PixelFormat = packed(FormatKind::Grey, 1, 16);
// The precisions of FFmpeg's fallbacks
const FALLBACK_PRECISION_8: i32 = 8;
const FALLBACK_PRECISION_12: i32 = 12;
const FALLBACK_PRECISION_16: i32 = 16;
/// The channel associations FFmpeg's YUVA 4:2:0 fallback sets: the first component is alpha
const YUVA_420_FALLBACK_CHANNELS: [i32; MAXIMUM_COMPONENTS] = [0, 1, 2, 3];
/// The failing value of a codestream FFmpeg finds no pixel format for
const NO_PIXEL_FORMAT: u32 = 0;

/// Whether FFmpeg's pix_fmt_match takes a format for the components: their count, their deepest precision, their subsampling at each remapped position, and a palette.
fn matches(format: &PixelFormat, components: usize, precision: i32, chroma_layout: u32, has_palette: bool) -> bool {
    if format.components != components {
        return false;
    }
    let field = |shift: u32| (chroma_layout >> shift) & 3;
    let mut matched: bool = true;
    if components >= 4 {
        matched &= format.depth >= precision && field(14) == 0 && field(12) == 0;
    }
    if components >= 3 {
        matched &= format.depth >= precision && field(10) == format.chroma_width_log2 && field(8) == format.chroma_height_log2;
    }
    if components >= 2 {
        matched &= format.depth >= precision && field(6) == format.chroma_width_log2 && field(4) == format.chroma_height_log2;
    }
    matched &= format.depth >= precision && field(2) == 0 && field(0) == 0 && (format.kind == FormatKind::Palette) == has_palette;
    matched
}

/// Picks FFmpeg's pixel format for a codestream: the previous picture's while it still fits, else the first candidate that fits,
/// else FFmpeg's fallbacks. The YUVA 4:2:0 fallback also changes the channel definitions, which `size` then carries.
pub fn choose_pixel_format(size: &ImageSize, colour: &ColourInfo, previous: Option<PixelFormat>) -> DecodeResult<PixelFormat> {
    let components: usize = size.component_count;
    if let Some(format) = previous.filter(|format: &PixelFormat| matches(format, components, size.precision, size.chroma_layout, colour.has_palette)) {
        return Ok(format);
    }
    let mut candidates: Vec<PixelFormat> = Vec::new();
    if size.profile == PROFILE_DIGITAL_CINEMA_2K || size.profile == PROFILE_DIGITAL_CINEMA_4K {
        candidates.push(XYZ_FORMAT);
        candidates.extend_from_slice(&YUV_FORMATS);
    } else {
        match colour.colour_space {
            COLOUR_SPACE_SRGB => candidates.extend_from_slice(&RGB_FORMATS),
            COLOUR_SPACE_GREYSCALE => candidates.extend_from_slice(&GREY_FORMATS),
            COLOUR_SPACE_SYCC => candidates.extend_from_slice(&YUV_FORMATS),
            _ => {
                candidates.extend_from_slice(&RGB_FORMATS);
                candidates.extend_from_slice(&GREY_FORMATS);
                candidates.extend_from_slice(&YUV_FORMATS);
                candidates.push(XYZ_FORMAT);
            }
        }
    }
    if let Some(format) = candidates.iter().find(|format: &&PixelFormat| matches(format, components, size.precision, size.chroma_layout, colour.has_palette)) {
        return Ok(*format);
    }
    let separation = |component: usize| (size.subsampling_x[component], size.subsampling_y[component]);
    let all_equal: bool = (1..components).all(|component: usize| separation(component) == separation(0));
    let fallback: Option<PixelFormat> = match components {
        4 if separation(0) == (1, 1) && separation(1) == (1, 1) && separation(2) == separation(3) => {
            (size.precision == FALLBACK_PRECISION_8 && separation(2) == (2, 2) && !colour.has_palette).then_some(YUVA_420_FALLBACK)
        }
        3 if size.precision == FALLBACK_PRECISION_8 && all_equal => Some(RGB_FALLBACK),
        2 if size.precision == FALLBACK_PRECISION_8 && all_equal => Some(GREY_ALPHA_FALLBACK),
        2 if size.precision == FALLBACK_PRECISION_16 && all_equal => Some(GREY_ALPHA_16_FALLBACK),
        1 if size.precision == FALLBACK_PRECISION_8 => Some(GREY_FALLBACK),
        1 if size.precision == FALLBACK_PRECISION_12 => Some(GREY_16_FALLBACK),
        _ => None,
    };
    match fallback {
        Some(format) => Ok(format),
        None => fail(ERROR_COMPONENT_COUNT, NO_PIXEL_FORMAT),
    }
}

/// The channel definitions FFmpeg writes with: its YUVA 4:2:0 fallback reorders them when the components needed it.
pub fn effective_channel_definitions(size: &ImageSize, colour: &ColourInfo, format: &PixelFormat) -> [i32; MAXIMUM_COMPONENTS] {
    if *format == YUVA_420_FALLBACK && !matches(format, size.component_count, size.precision, size.chroma_layout, colour.has_palette) {
        return YUVA_420_FALLBACK_CHANNELS;
    }
    size.channel_definitions
}

/// One output plane: the component FFmpeg writes into it, and that component's place and sample conversion.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputPlane {
    pub component: u32,
    pub width: u32,
    pub height: u32,
    pub origin_x: u32,
    pub origin_y: u32,
    pub divisor_x: u32,
    pub divisor_y: u32,
    pub component_bits: u32,
    pub shift: u32,
}

/// How a picture's components become the engine's planes: its chroma format and bit depth, each plane's source, the conversion the
/// output stage applies, and the error word for a pixel format the engine cannot show, 0 when it can.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputLayout {
    pub chroma_format: u32,
    pub bit_depth: u32,
    pub planes: [OutputPlane; 3],
    /// OUTPUT_TRANSFORM_XYZ for an XYZ picture, whose X', Y', and Z' planes the output stage converts, else OUTPUT_TRANSFORM_NONE
    pub output_transform: u32,
    pub format_error: u32,
    /// Which components feed planes, so tier-1 skips the others
    pub decoded_components: [bool; MAXIMUM_COMPONENTS],
}

fn error_word(code: u32, value: u32) -> u32 {
    (code << ERROR_CODE_SHIFT) | value
}

fn ceil_divide(numerator: i64, divisor: i64) -> i64 {
    (numerator + divisor - 1) / divisor
}

/// The engine's bit depth for FFmpeg's write precision: 8 bits at or below 8, else the next of 10 and 12.
fn output_depth(precision: i32) -> Option<u32> {
    match precision {
        ..=8 => Some(OUTPUT_DEPTH_8),
        9..=10 => Some(OUTPUT_DEPTH_10),
        11..=12 => Some(OUTPUT_DEPTH_12),
        _ => None,
    }
}

/// Lays out a picture's planes as FFmpeg writes them in its chosen format. A format the engine cannot show still gets a layout,
/// the components in plane order at 4:4:4, with the error word that names why.
/// An XYZ picture's planes hold the 12-bit X', Y', and Z' codes FFmpeg's converter reads, at 4:4:4 and 12 bits.
pub fn plan_output(size: &ImageSize, colour: &ColourInfo, format: &PixelFormat) -> OutputLayout {
    let channel_definitions: [i32; MAXIMUM_COMPONENTS] = effective_channel_definitions(size, colour, format);
    let components: usize = size.component_count;
    let precision: i32 = size.precision;
    let xyz: bool = format.kind == FormatKind::XYZ;
    let write_precision: i32 = if xyz {
        XYZ_PRECISION
    } else if precision <= BYTE_PRECISION {
        BYTE_PRECISION
    } else {
        precision
    };
    let mut layout: OutputLayout = OutputLayout::default();
    let depth: u32 = output_depth(write_precision).unwrap_or(OUTPUT_DEPTH_12);
    layout.bit_depth = depth;
    layout.output_transform = if xyz { OUTPUT_TRANSFORM_XYZ } else { OUTPUT_TRANSFORM_NONE };
    layout.chroma_format = match (format.chroma_width_log2, format.chroma_height_log2) {
        (1, 1) => CHROMA_FORMAT_420,
        (1, 0) => CHROMA_FORMAT_422,
        _ => CHROMA_FORMAT_444,
    };
    // FFmpeg's samples are exact in a format of the engine's depth; a 9-bit or 16-bit pick is scaled to the engine's depth instead
    let extra_shift: u32 = if format.depth as u32 == depth { 0 } else { depth.saturating_sub(write_precision as u32) };
    for plane in &mut layout.planes {
        plane.component = u32::MAX;
    }
    for component in 0..components {
        let plane_index: usize = if channel_definitions[component] != 0 { channel_definitions[component] as usize - 1 } else { components - 1 };
        if plane_index >= layout.planes.len() {
            continue;
        }
        let (chroma_width_log2, chroma_height_log2) = if plane_index == 0 { (0, 0) } else { (format.chroma_width_log2, format.chroma_height_log2) };
        let divisor_x: i64 = i64::from(size.subsampling_x[component]);
        let divisor_y: i64 = i64::from(size.subsampling_y[component]);
        let bits: u32 = u32::from(size.component_bits[component]);
        layout.planes[plane_index] = OutputPlane {
            component: component as u32,
            width: ((i64::from(size.output_width) + (1 << chroma_width_log2) - 1) >> chroma_width_log2) as u32,
            height: ((i64::from(size.output_height) + (1 << chroma_height_log2) - 1) >> chroma_height_log2) as u32,
            origin_x: ceil_divide(i64::from(size.image_offset_x), divisor_x) as u32,
            origin_y: ceil_divide(i64::from(size.image_offset_y), divisor_y) as u32,
            divisor_x: divisor_x as u32,
            divisor_y: divisor_y as u32,
            component_bits: bits,
            shift: (write_precision as u32).saturating_sub(bits) + extra_shift,
        };
        layout.decoded_components[component] = true;
    }
    layout.format_error = match format.kind {
        FormatKind::YUV if output_depth(write_precision).is_none() => error_word(ERROR_BIT_DEPTH, precision as u32),
        FormatKind::YUV if format.chroma_width_log2 > 1 || format.chroma_height_log2 > format.chroma_width_log2 => {
            error_word(ERROR_CHROMA_FORMAT, format.chroma_width_log2 << 2 | format.chroma_height_log2)
        }
        FormatKind::YUV => 0,
        FormatKind::RGB => error_word(ERROR_COLOUR_SPACE, FAMILY_RGB),
        FormatKind::Grey => error_word(ERROR_COLOUR_SPACE, FAMILY_GREY),
        // At 8 bits or fewer FFmpeg writes bytes into XYZ's 16-bit samples, which no format holds
        FormatKind::XYZ if precision <= BYTE_PRECISION => error_word(ERROR_BIT_DEPTH, precision as u32),
        FormatKind::XYZ => 0,
        FormatKind::Palette => error_word(ERROR_COLOUR_SPACE, FAMILY_PALETTE),
    };
    layout
}

#[cfg(test)]
mod tests {
    use super::*;

    const SYCC: ColourInfo = ColourInfo { colour_space: COLOUR_SPACE_SYCC, has_palette: false, channel_definitions: [-1; 4] };
    const UNSPECIFIED: ColourInfo = ColourInfo { colour_space: 0, has_palette: false, channel_definitions: [-1; 4] };

    /// A three-component image at a precision with its chroma components subsampled by the given separations.
    fn image(precision: u8, separation_x: i32, separation_y: i32) -> ImageSize {
        let mut size: ImageSize = ImageSize {
            component_count: 3,
            precision: i32::from(precision),
            width: 64,
            height: 48,
            output_width: 64,
            output_height: 48,
            channel_definitions: [1, 2, 3, 0],
            ..ImageSize::default()
        };
        for component in 0..3 {
            size.component_bits[component] = precision;
            size.subsampling_x[component] = if component == 0 { 1 } else { separation_x };
            size.subsampling_y[component] = if component == 0 { 1 } else { separation_y };
            size.chroma_layout |= ((size.subsampling_y[component] as u32 >> 1) << (component * 4)) | ((size.subsampling_x[component] as u32 >> 1) << (component * 4 + 2));
        }
        size
    }

    #[test]
    fn picks_yuv_for_subsampled_chroma_and_rgb_for_unspecified_full_chroma() {
        let subsampled: ImageSize = image(8, 2, 2);
        let layout: OutputLayout = plan_output(&subsampled, &UNSPECIFIED, &choose_pixel_format(&subsampled, &UNSPECIFIED, None).unwrap());
        assert_eq!((layout.chroma_format, layout.bit_depth, layout.format_error), (CHROMA_FORMAT_420, 8, 0));
        assert_eq!((layout.planes[1].width, layout.planes[1].height), (32, 24));
        let full: ImageSize = image(8, 1, 1);
        let unspecified: OutputLayout = plan_output(&full, &UNSPECIFIED, &choose_pixel_format(&full, &UNSPECIFIED, None).unwrap());
        assert_eq!(unspecified.format_error, error_word(ERROR_COLOUR_SPACE, FAMILY_RGB));
        let ycc: OutputLayout = plan_output(&full, &SYCC, &choose_pixel_format(&full, &SYCC, None).unwrap());
        assert_eq!((ycc.chroma_format, ycc.format_error), (CHROMA_FORMAT_444, 0));
    }

    #[test]
    fn maps_precisions_onto_the_engine_depths_as_ffmpeg_writes_them() {
        let ten: ImageSize = image(10, 2, 1);
        let layout: OutputLayout = plan_output(&ten, &SYCC, &choose_pixel_format(&ten, &SYCC, None).unwrap());
        assert_eq!((layout.chroma_format, layout.bit_depth, layout.planes[0].shift), (CHROMA_FORMAT_422, 10, 0));
        // FFmpeg writes 9-bit samples into its own 9-bit format, which the engine shows at 10 bits
        let nine: ImageSize = image(9, 2, 2);
        let nine_layout: OutputLayout = plan_output(&nine, &SYCC, &choose_pixel_format(&nine, &SYCC, None).unwrap());
        assert_eq!((nine_layout.bit_depth, nine_layout.planes[2].shift), (10, 1));
        // FFmpeg writes 11-bit samples unscaled into its 12-bit format, which the engine keeps
        let eleven: ImageSize = image(11, 1, 1);
        let eleven_layout: OutputLayout = plan_output(&eleven, &SYCC, &choose_pixel_format(&eleven, &SYCC, None).unwrap());
        assert_eq!((eleven_layout.bit_depth, eleven_layout.planes[0].shift), (12, 0));
        let sixteen: ImageSize = image(16, 2, 2);
        let deep: OutputLayout = plan_output(&sixteen, &SYCC, &choose_pixel_format(&sixteen, &SYCC, None).unwrap());
        assert_eq!(deep.format_error, error_word(ERROR_BIT_DEPTH, 16));
    }

    #[test]
    fn rejects_subsampling_outside_the_engine_formats() {
        let quarter: ImageSize = image(8, 4, 1);
        let layout: OutputLayout = plan_output(&quarter, &SYCC, &choose_pixel_format(&quarter, &SYCC, None).unwrap());
        assert_eq!(layout.format_error, error_word(ERROR_CHROMA_FORMAT, 2 << 2));
        let vertical: ImageSize = image(8, 1, 2);
        let vertical_layout: OutputLayout = plan_output(&vertical, &SYCC, &choose_pixel_format(&vertical, &SYCC, None).unwrap());
        assert_eq!(vertical_layout.format_error, error_word(ERROR_CHROMA_FORMAT, 1));
    }

    #[test]
    fn reads_digital_cinema_profiles_as_xyz_planes_at_12_bits() {
        for profile in [PROFILE_DIGITAL_CINEMA_2K, PROFILE_DIGITAL_CINEMA_4K] {
            let mut cinema: ImageSize = image(12, 1, 1);
            cinema.profile = profile;
            // The profile picks XYZ ahead of the colour box's sYCC
            let layout: OutputLayout = plan_output(&cinema, &SYCC, &choose_pixel_format(&cinema, &SYCC, None).unwrap());
            assert_eq!((layout.chroma_format, layout.bit_depth, layout.output_transform, layout.format_error), (CHROMA_FORMAT_444, 12, OUTPUT_TRANSFORM_XYZ, 0));
            assert_eq!(layout.planes.map(|plane: OutputPlane| (plane.component, plane.shift)), [(0, 0), (1, 0), (2, 0)]);
        }
    }

    #[test]
    fn shifts_shallower_xyz_components_to_the_12_bits_ffmpeg_converts_and_refuses_8_bit_xyz() {
        let mut ten: ImageSize = image(10, 1, 1);
        ten.profile = PROFILE_DIGITAL_CINEMA_2K;
        let layout: OutputLayout = plan_output(&ten, &UNSPECIFIED, &choose_pixel_format(&ten, &UNSPECIFIED, None).unwrap());
        // FFmpeg writes a 10-bit sample 6 bits up in 16 bits, and its converter reads the top 12
        assert_eq!((layout.bit_depth, layout.planes[0].shift, layout.format_error), (12, 2, 0));
        let mut eight: ImageSize = image(8, 1, 1);
        eight.profile = PROFILE_DIGITAL_CINEMA_2K;
        let byte_layout: OutputLayout = plan_output(&eight, &UNSPECIFIED, &choose_pixel_format(&eight, &UNSPECIFIED, None).unwrap());
        assert_eq!(byte_layout.format_error, error_word(ERROR_BIT_DEPTH, 8));
    }

    #[test]
    fn reads_subsampled_digital_cinema_components_as_yuv_without_a_transform() {
        let mut cinema: ImageSize = image(12, 2, 2);
        cinema.profile = PROFILE_DIGITAL_CINEMA_2K;
        let layout: OutputLayout = plan_output(&cinema, &UNSPECIFIED, &choose_pixel_format(&cinema, &UNSPECIFIED, None).unwrap());
        assert_eq!((layout.chroma_format, layout.output_transform, layout.format_error), (CHROMA_FORMAT_420, OUTPUT_TRANSFORM_NONE, 0));
    }

    #[test]
    fn keeps_the_previous_format_while_it_fits() {
        let full: ImageSize = image(8, 1, 1);
        let previous: PixelFormat = choose_pixel_format(&full, &SYCC, None).unwrap();
        assert_eq!(choose_pixel_format(&full, &UNSPECIFIED, Some(previous)), Ok(previous));
    }
}
