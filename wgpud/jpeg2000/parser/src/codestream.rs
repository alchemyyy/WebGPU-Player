// The codestream's marker segments, read as FFmpeg's jpeg2000_read_main_headers reads them: the main header, then each tile-part's
// header and the range of its packet data, with the packed packet headers of PPM and PPT kept in order.
// Coding and quantization styles follow FFmpeg's precedence, in which a tile's COD replaces every component's style, a main COC too.
// The parse is cheap next to tier-2, so each parse worker repeats it on the same bytes rather than receive its result.

use crate::container::{ColourInfo, LocatedCodestream, locate_codestream};
use crate::error::{DecodeResult, fail, fail_signed};
use crate::format::{PixelFormat, choose_pixel_format};
use crate::layout::{
    ERROR_CODING_STYLE, ERROR_COMPONENT_COUNT, ERROR_IMAGE_SIZE, ERROR_MARKER_SEGMENT, ERROR_PICTURE_AREA, ERROR_PICTURE_SIZE, ERROR_PROGRESSION_ORDER,
    ERROR_QUANTIZATION, ERROR_REGION_OF_INTEREST, ERROR_TILE_PART, ERROR_UNSUPPORTED_FEATURE, MAXIMUM_PICTURE_AREA, MAXIMUM_PICTURE_SIDE,
};
use crate::stream::ByteStream;

pub const MAXIMUM_COMPONENTS: usize = 4;
/// Array bound of the resolution levels; a coding style has fewer than this many
pub const MAXIMUM_RESOLUTION_LEVELS: usize = 34;
/// The quantization exponents and mantissas a style holds, three per decomposition level
pub const QUANTIZATION_BANDS: usize = 99;
pub const MAXIMUM_PROGRESSION_CHANGES: usize = 32;
pub const TILE_PART_SLOTS: usize = 32;

// Markers
const SIZ: u16 = 0xFF51;
const COD: u16 = 0xFF52;
const COC: u16 = 0xFF53;
const CAP: u16 = 0xFF50;
const TLM: u16 = 0xFF55;
const PLM: u16 = 0xFF57;
const PLT: u16 = 0xFF58;
const CPF: u16 = 0xFF59;
const QCD: u16 = 0xFF5C;
const QCC: u16 = 0xFF5D;
const RGN: u16 = 0xFF5E;
const POC: u16 = 0xFF5F;
const PPM: u16 = 0xFF60;
const PPT: u16 = 0xFF61;
const CRG: u16 = 0xFF63;
const COM: u16 = 0xFF64;
const SOT: u16 = 0xFF90;
const SOD: u16 = 0xFF93;
const EOC: u16 = 0xFFD9;
// Markers without a segment, which FFmpeg passes over
const RESERVED_MARKER_FIRST: u16 = 0xFF30;
const RESERVED_MARKER_LAST: u16 = 0xFF3F;

// Coding style flags
pub const CODING_STYLE_PRECINCTS: u8 = 0x01;
pub const CODING_STYLE_START_OF_PACKET: u8 = 0x02;
pub const CODING_STYLE_END_OF_PACKET_HEADER: u8 = 0x04;
/// Code block styles at and above the HT block coder of ISO/IEC 15444-15, which this decoder does not carry
pub const CODE_BLOCK_STYLE_HIGH_THROUGHPUT: u8 = 0x40;
// The capability bit of the HT block coder in a CAP marker's Pcap
const CAPABILITY_HIGH_THROUGHPUT_SHIFT: u32 = 31 - 14;
const CAPABILITY_FIELDS: u32 = 32;

// Wavelets as the COD carries them, which FFmpeg maps to its transform types
// COD transformation byte 0 is the 9/7 wavelet, which FFmpeg decodes on its integer path under the bitexact flag
pub const COD_REVERSIBLE: u8 = 1;
/// FFmpeg's integer 9/7 type, which a COD byte of 2 selects directly
pub const COD_IRREVERSIBLE_INTEGER: u8 = 2;

// Quantization styles
pub const QUANTIZATION_NONE: u8 = 0;
pub const QUANTIZATION_SCALAR_DERIVED: u8 = 1;
pub const QUANTIZATION_SCALAR_EXPOUNDED: u8 = 2;

// Component properties: whether a COC or QCC has set the component, which a later COD or QCD then leaves alone
const HAD_COMPONENT_CODING: u8 = 0x01;
const HAD_COMPONENT_QUANTIZATION: u8 = 0x02;

// FFmpeg's bounds
const MINIMUM_SIZ_LENGTH: usize = 36;
const MAXIMUM_SAMPLE_SEPARATION: u8 = 4;
const UNSUPPORTED_SAMPLE_SEPARATION: u8 = 3;
const MAXIMUM_CODE_BLOCK_EXPONENT: u8 = 10;
const MAXIMUM_CODE_BLOCK_AREA_EXPONENT: u8 = 12;
const CODE_BLOCK_EXPONENT_OFFSET: u8 = 2;
const UNSET_PRECINCT_EXPONENT: u8 = 15;
const MAXIMUM_ROI_SHIFT: u8 = 30;
const MAXIMUM_RESOLUTION_END: u8 = 33;
const ALL_COMPONENTS: u16 = 256;
const PROGRESSION_ENTRY_LENGTH: usize = 7;
const SOT_LENGTH: usize = 8;
const MINIMUM_TILE_PART_BYTES: u64 = 14;
const TILE_LENGTH_SIZE_TYPE_SHIFT: u8 = 4;
const TILE_LENGTH_POINTER_SHIFT: u8 = 6;
const INVALID_TILE_LENGTH_SIZE: u8 = 3;
const PACKET_LENGTH_CONTINUATION: u8 = 0x80;
const MINIMUM_PACKET_LENGTH_SEGMENT: usize = 4;
const MINIMUM_PACKED_HEADER_SEGMENT: usize = 3;
// The channel associations of the components each component count needs, as bits of the associations FFmpeg's checks require
const REQUIRED_CHANNEL_ASSOCIATIONS: [u32; 5] = [0, 2, 3, 14, 15];
/// FFmpeg rejects images whose padded size reaches INT_MAX / 8, which av_image_check_size2 checks
const IMAGE_SIZE_LIMIT: i64 = (i32::MAX / 8) as i64;
const IMAGE_SIZE_PADDING: i64 = 128;

// Failure values of the marker checks
pub const SIZ_TOO_SHORT: u32 = 1;
pub const SIZ_REPEATED: u32 = 2;
pub const SIZ_MISSING: u32 = 3;
pub const SOT_MISSING: u32 = 4;
pub const TILE_PART_END_BEFORE_DATA: u32 = 5;
pub const PACKED_HEADER_OVERRUN: u32 = 6;
pub const PPM_IN_TILE_HEADER: u32 = 7;
pub const PPM_AND_PPT: u32 = 8;
pub const CAP_BEFORE_SIZ: u32 = 9;
pub const PPT_OUTSIDE_FIRST_TILE_PART: u32 = 10;
pub const RGN_OUTSIDE_FIRST_TILE_PART: u32 = 11;

/// A COD's or COC's parameters for one component, as FFmpeg keeps them.
#[derive(Clone, Copy, Debug)]
pub struct CodingStyle {
    pub resolution_levels: u8,
    pub code_block_width_log2: u8,
    pub code_block_height_log2: u8,
    /// The COD's transformation byte: 0 for the 9/7 wavelet, 1 for the 5/3 wavelet
    pub wavelet: u8,
    pub coding_style: u8,
    /// FFmpeg keeps the layer count in 8 bits
    pub layers: u8,
    pub component_transform: u8,
    pub code_block_style: u8,
    pub progression_order: u8,
    pub precinct_width_log2: [u8; MAXIMUM_RESOLUTION_LEVELS],
    pub precinct_height_log2: [u8; MAXIMUM_RESOLUTION_LEVELS],
    pub initialized: bool,
}

impl Default for CodingStyle {
    fn default() -> Self {
        Self {
            resolution_levels: 0,
            code_block_width_log2: 0,
            code_block_height_log2: 0,
            wavelet: 0,
            coding_style: 0,
            layers: 0,
            component_transform: 0,
            code_block_style: 0,
            progression_order: 0,
            precinct_width_log2: [0; MAXIMUM_RESOLUTION_LEVELS],
            precinct_height_log2: [0; MAXIMUM_RESOLUTION_LEVELS],
            initialized: false,
        }
    }
}

/// A QCD's or QCC's parameters for one component.
#[derive(Clone, Copy, Debug)]
pub struct QuantizationStyle {
    pub exponents: [u8; QUANTIZATION_BANDS],
    pub mantissas: [u16; QUANTIZATION_BANDS],
    pub style: u8,
    pub guard_bits: u8,
}

impl Default for QuantizationStyle {
    fn default() -> Self {
        Self { exponents: [0; QUANTIZATION_BANDS], mantissas: [0; QUANTIZATION_BANDS], style: 0, guard_bits: 0 }
    }
}

/// One progression order change of a POC.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProgressionChange {
    pub layer_end: u16,
    pub component_start: u16,
    pub component_end: u16,
    pub resolution_start: u8,
    pub resolution_end: u8,
    pub order: u8,
}

/// The progression order changes in effect for the main header or a tile.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProgressionChanges {
    pub entries: [ProgressionChange; MAXIMUM_PROGRESSION_CHANGES],
    pub count: usize,
    /// Set on a tile's copy of the main header's changes, which the tile's own first POC replaces
    pub is_default: bool,
}

/// A tile-part: where its data ends, its packet headers from a PPM, and its packet data.
#[derive(Clone, Copy, Debug, Default)]
pub struct TilePart {
    pub end: usize,
    pub header: ByteStream,
    pub data: ByteStream,
}

/// What the headers of one tile's tile-parts set.
#[derive(Clone, Debug)]
pub struct TileHeader {
    pub coding: [CodingStyle; MAXIMUM_COMPONENTS],
    pub quantization: [QuantizationStyle; MAXIMUM_COMPONENTS],
    pub properties: [u8; MAXIMUM_COMPONENTS],
    pub progression: ProgressionChanges,
    pub tile_parts: [TilePart; TILE_PART_SLOTS],
    pub tile_part_index: u16,
    pub region_shift: [u8; MAXIMUM_COMPONENTS],
    pub has_packed_headers: bool,
    /// The arena range of the tile's PPT data, in marker order
    pub packed_headers_start: usize,
    pub packed_headers_length: usize,
    pub packed_headers: ByteStream,
}

impl Default for TileHeader {
    fn default() -> Self {
        Self {
            coding: [CodingStyle::default(); MAXIMUM_COMPONENTS],
            quantization: [QuantizationStyle::default(); MAXIMUM_COMPONENTS],
            properties: [0; MAXIMUM_COMPONENTS],
            progression: ProgressionChanges::default(),
            tile_parts: [TilePart::default(); TILE_PART_SLOTS],
            tile_part_index: 0,
            region_shift: [0; MAXIMUM_COMPONENTS],
            has_packed_headers: false,
            packed_headers_start: 0,
            packed_headers_length: 0,
            packed_headers: ByteStream::default(),
        }
    }
}

/// The SIZ marker's image and tile geometry, and the components' sample sizes and subsampling.
#[derive(Clone, Copy, Debug, Default)]
pub struct ImageSize {
    pub profile: u16,
    pub width: i32,
    pub height: i32,
    pub image_offset_x: i32,
    pub image_offset_y: i32,
    pub tile_width: i32,
    pub tile_height: i32,
    pub tile_offset_x: i32,
    pub tile_offset_y: i32,
    pub component_count: usize,
    pub component_bits: [u8; MAXIMUM_COMPONENTS],
    pub component_signed: [bool; MAXIMUM_COMPONENTS],
    pub subsampling_x: [i32; MAXIMUM_COMPONENTS],
    pub subsampling_y: [i32; MAXIMUM_COMPONENTS],
    /// The deepest component's bits
    pub precision: i32,
    pub tile_columns: u32,
    pub tile_rows: u32,
    /// The output image size FFmpeg sets, its dimx and dimy
    pub output_width: i32,
    pub output_height: i32,
    /// Each component's bit pair of FFmpeg's log2_chroma_wh at its remapped position
    pub chroma_layout: u32,
    /// The channel associations of the components, defaults applied
    pub channel_definitions: [i32; MAXIMUM_COMPONENTS],
}

/// A parsed codestream: its bytes and packed headers in one arena, its image geometry and pixel format, and its tiles.
pub struct Codestream {
    /// The packet's bytes, then the PPM data, then each tile's PPT data
    pub arena: Vec<u8>,
    pub size: ImageSize,
    pub colour: ColourInfo,
    pub pixel_format: PixelFormat,
    pub region_shift: [u8; MAXIMUM_COMPONENTS],
    pub has_packed_main_headers: bool,
    /// One entry per tile; None for a tile that no tile-part named
    pub tiles: Vec<Option<Box<TileHeader>>>,
}

/// Where the next COD, COC, QCD, QCC, or POC goes: the main header's defaults, or the current tile's.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HeaderTarget {
    Main,
    Tile(usize),
}

/// The main header's defaults, which each tile's first tile-part copies.
struct MainHeader {
    coding: [CodingStyle; MAXIMUM_COMPONENTS],
    quantization: [QuantizationStyle; MAXIMUM_COMPONENTS],
    properties: [u8; MAXIMUM_COMPONENTS],
    progression: ProgressionChanges,
}

/// The state of one marker scan.
struct Scanner {
    arena: Vec<u8>,
    stream: ByteStream,
    size: Option<ImageSize>,
    colour: ColourInfo,
    format_choice: FormatChoice,
    pixel_format: Option<PixelFormat>,
    main: MainHeader,
    region_shift: [u8; MAXIMUM_COMPONENTS],
    tiles: Vec<Option<Box<TileHeader>>>,
    current_tile: Option<usize>,
    in_tile_headers: bool,
    has_packed_main_headers: bool,
    packed_main_headers_start: usize,
    packed_main_headers_length: usize,
    packed_main_headers: ByteStream,
    packet_length: usize,
}

fn ceil_divide(numerator: i64, divisor: i64) -> i64 {
    (numerator + divisor - 1) / divisor
}

impl Scanner {
    fn component_count(&self) -> usize {
        self.size.map_or(0, |size: ImageSize| size.component_count)
    }

    fn coding_styles(&mut self, target: HeaderTarget) -> (&mut [CodingStyle; MAXIMUM_COMPONENTS], &mut [u8; MAXIMUM_COMPONENTS]) {
        match target {
            HeaderTarget::Main => (&mut self.main.coding, &mut self.main.properties),
            HeaderTarget::Tile(index) => {
                let tile: &mut TileHeader = self.tiles[index].as_mut().expect("a tile target has a header");
                (&mut tile.coding, &mut tile.properties)
            }
        }
    }

    fn quantization_styles(&mut self, target: HeaderTarget) -> (&mut [QuantizationStyle; MAXIMUM_COMPONENTS], &mut [u8; MAXIMUM_COMPONENTS]) {
        match target {
            HeaderTarget::Main => (&mut self.main.quantization, &mut self.main.properties),
            HeaderTarget::Tile(index) => {
                let tile: &mut TileHeader = self.tiles[index].as_mut().expect("a tile target has a header");
                (&mut tile.quantization, &mut tile.properties)
            }
        }
    }

    fn target(&self) -> HeaderTarget {
        match (self.in_tile_headers, self.current_tile) {
            (true, Some(index)) => HeaderTarget::Tile(index),
            _ => HeaderTarget::Main,
        }
    }

    fn read_u8(&mut self) -> u8 {
        self.stream.read_u8(&self.arena)
    }

    fn read_u16(&mut self) -> u16 {
        self.stream.read_u16(&self.arena)
    }

    fn read_u32(&mut self) -> u32 {
        self.stream.read_u32(&self.arena)
    }

    /// SIZ: the image and tile geometry, the components, and the pixel format FFmpeg picks for them.
    fn read_image_size(&mut self) -> DecodeResult<()> {
        if self.stream.bytes_left() < MINIMUM_SIZ_LENGTH {
            return fail(ERROR_MARKER_SEGMENT, SIZ_TOO_SHORT);
        }
        let mut size: ImageSize = ImageSize { profile: self.read_u16(), ..ImageSize::default() };
        size.width = self.read_u32() as i32;
        size.height = self.read_u32() as i32;
        size.image_offset_x = self.read_u32() as i32;
        size.image_offset_y = self.read_u32() as i32;
        size.tile_width = self.read_u32() as i32;
        size.tile_height = self.read_u32() as i32;
        size.tile_offset_x = self.read_u32() as i32;
        size.tile_offset_y = self.read_u32() as i32;
        let component_count: usize = usize::from(self.read_u16());
        check_image_dimensions(i64::from(size.width), i64::from(size.height))?;
        if component_count == 0 || component_count > MAXIMUM_COMPONENTS {
            return fail(ERROR_COMPONENT_COUNT, component_count as u32);
        }
        let (width, height) = (i64::from(size.width), i64::from(size.height));
        let (image_x, image_y) = (i64::from(size.image_offset_x), i64::from(size.image_offset_y));
        let (tile_x, tile_y) = (i64::from(size.tile_offset_x), i64::from(size.tile_offset_y));
        if tile_x < 0 || tile_y < 0 || image_x < tile_x || image_y < tile_y || i64::from(size.tile_width) + tile_x <= image_x || i64::from(size.tile_height) + tile_y <= image_y {
            return fail_signed(ERROR_IMAGE_SIZE, image_x.max(image_y));
        }
        if image_x >= width || image_y >= height {
            return fail_signed(ERROR_IMAGE_SIZE, image_x.max(image_y));
        }
        size.component_count = component_count;
        if size.tile_width <= 0 || size.tile_height <= 0 {
            return fail_signed(ERROR_IMAGE_SIZE, i64::from(size.tile_width.min(size.tile_height)));
        }
        if self.stream.bytes_left() < 3 * component_count {
            return fail(ERROR_MARKER_SEGMENT, SIZ_TOO_SHORT);
        }
        // FFmpeg's default channel definitions: every component in order, the last of an even count as alpha
        let mut channel_definitions: [i32; MAXIMUM_COMPONENTS] = self.colour.channel_definitions;
        if channel_definitions[..component_count].iter().any(|&definition: &i32| definition < 0) {
            for (index, definition) in channel_definitions[..component_count].iter_mut().enumerate() {
                *definition = index as i32 + 1;
            }
            if component_count.is_multiple_of(2) {
                channel_definitions[component_count - 1] = 0;
            }
        }
        let used: u32 = channel_definitions[..component_count].iter().fold(0, |used: u32, &definition: &i32| used | (1 << definition));
        if used != REQUIRED_CHANNEL_ASSOCIATIONS[component_count] {
            return fail(ERROR_COMPONENT_COUNT, used);
        }
        size.channel_definitions = channel_definitions;
        for component in 0..component_count {
            let sample_size: u8 = self.read_u8();
            size.component_bits[component] = (sample_size & 0x7F) + 1;
            size.precision = size.precision.max(i32::from(size.component_bits[component]));
            size.component_signed[component] = sample_size & 0x80 != 0;
            let separation_x: u8 = self.read_u8();
            let separation_y: u8 = self.read_u8();
            for separation in [separation_x, separation_y] {
                if separation == 0 || separation == UNSUPPORTED_SAMPLE_SEPARATION || separation > MAXIMUM_SAMPLE_SEPARATION {
                    return fail(ERROR_IMAGE_SIZE, u32::from(separation_x) << 8 | u32::from(separation_y));
                }
            }
            size.subsampling_x[component] = i32::from(separation_x);
            size.subsampling_y[component] = i32::from(separation_y);
            let remapped: u32 = if channel_definitions[component] != 0 { channel_definitions[component] as u32 - 1 } else { component_count as u32 - 1 };
            size.chroma_layout |= (u32::from(separation_y >> 1) << (remapped * 4)) | (u32::from(separation_x >> 1) << (remapped * 4 + 2));
        }
        let tile_columns: i64 = ceil_divide(width - tile_x, i64::from(size.tile_width));
        let tile_rows: i64 = ceil_divide(height - tile_y, i64::from(size.tile_height));
        // Each tile needs at least a SOT and a SOD, 14 bytes
        if (tile_columns * tile_rows) as u64 * MINIMUM_TILE_PART_BYTES > self.packet_length as u64 {
            return fail_signed(ERROR_IMAGE_SIZE, tile_columns * tile_rows);
        }
        size.tile_columns = tile_columns as u32;
        size.tile_rows = tile_rows as u32;
        let output_width: i64 = (0..component_count).map(|component: usize| ceil_divide(width - image_x, i64::from(size.subsampling_x[component]))).max().unwrap_or(0);
        let output_height: i64 = (0..component_count).map(|component: usize| ceil_divide(height - image_y, i64::from(size.subsampling_y[component]))).max().unwrap_or(0);
        check_image_dimensions(output_width, output_height)?;
        // No stream the decoder accepts holds a larger picture, so none reaches tier-2
        if output_width > i64::from(MAXIMUM_PICTURE_SIDE) || output_height > i64::from(MAXIMUM_PICTURE_SIDE) {
            return fail_signed(ERROR_PICTURE_SIZE, output_width.max(output_height));
        }
        if output_width * output_height > i64::from(MAXIMUM_PICTURE_AREA) {
            return fail_signed(ERROR_PICTURE_AREA, output_width * output_height);
        }
        size.output_width = output_width as i32;
        size.output_height = output_height as i32;
        let pixel_format: PixelFormat = match self.format_choice {
            FormatChoice::Choose(previous) => choose_pixel_format(&size, &self.colour, previous)?,
            FormatChoice::Given(format) => format,
        };
        self.pixel_format = Some(pixel_format);
        self.tiles = Vec::new();
        self.tiles.resize_with((tile_columns * tile_rows) as usize, || None);
        self.size = Some(size);
        Ok(())
    }

    /// CAP: the HT block coder of ISO/IEC 15444-15, which this decoder rejects; other capabilities change nothing.
    fn read_capabilities(&mut self) -> DecodeResult<()> {
        if self.stream.bytes_left() < 6 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(CAP));
        }
        let capabilities: u32 = self.read_u32();
        for field in 0..CAPABILITY_FIELDS {
            if (capabilities >> (31 - field)) & 1 != 0 {
                self.read_u16();
            }
        }
        if (capabilities >> CAPABILITY_HIGH_THROUGHPUT_SHIFT) & 1 != 0 {
            return fail(ERROR_UNSUPPORTED_FEATURE, u32::from(CAP));
        }
        Ok(())
    }

    /// The SPcod or SPcoc part of a COD or COC.
    fn read_coding_parameters(&mut self, style: &mut CodingStyle) -> DecodeResult<()> {
        if self.stream.bytes_left() < 5 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(COD));
        }
        let resolution_levels: u16 = u16::from(self.read_u8()) + 1;
        if usize::from(resolution_levels) >= MAXIMUM_RESOLUTION_LEVELS {
            return fail(ERROR_CODING_STYLE, u32::from(resolution_levels));
        }
        style.resolution_levels = resolution_levels as u8;
        style.code_block_width_log2 = (self.read_u8() & 15) + CODE_BLOCK_EXPONENT_OFFSET;
        style.code_block_height_log2 = (self.read_u8() & 15) + CODE_BLOCK_EXPONENT_OFFSET;
        if style.code_block_width_log2 > MAXIMUM_CODE_BLOCK_EXPONENT
            || style.code_block_height_log2 > MAXIMUM_CODE_BLOCK_EXPONENT
            || style.code_block_width_log2 + style.code_block_height_log2 > MAXIMUM_CODE_BLOCK_AREA_EXPONENT
        {
            return fail(ERROR_CODING_STYLE, u32::from(style.code_block_width_log2) << 8 | u32::from(style.code_block_height_log2));
        }
        // A style is checked against what this decoder carries where a tile uses it, as FFmpeg checks the wavelet there
        style.code_block_style = self.read_u8();
        style.wavelet = self.read_u8();
        if style.coding_style & CODING_STYLE_PRECINCTS != 0 {
            for level in 0..usize::from(style.resolution_levels) {
                let exponents: u8 = self.read_u8();
                style.precinct_width_log2[level] = exponents & 0x0F;
                style.precinct_height_log2[level] = (exponents >> 4) & 0x0F;
                if level > 0 && (style.precinct_width_log2[level] == 0 || style.precinct_height_log2[level] == 0) {
                    return fail(ERROR_CODING_STYLE, u32::from(exponents));
                }
            }
        } else {
            style.precinct_width_log2 = [UNSET_PRECINCT_EXPONENT; MAXIMUM_RESOLUTION_LEVELS];
            style.precinct_height_log2 = [UNSET_PRECINCT_EXPONENT; MAXIMUM_RESOLUTION_LEVELS];
        }
        Ok(())
    }

    /// COD: the default coding style, for every component no COC has set.
    fn read_coding_style(&mut self, target: HeaderTarget) -> DecodeResult<()> {
        if self.stream.bytes_left() < 5 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(COD));
        }
        let mut style: CodingStyle = CodingStyle { coding_style: self.read_u8(), progression_order: self.read_u8(), ..CodingStyle::default() };
        // FFmpeg keeps 8 bits of the 16-bit layer count
        style.layers = self.read_u16() as u8;
        style.component_transform = self.read_u8();
        let component_count: usize = self.component_count();
        if style.component_transform != 0 && component_count < 3 {
            return fail(ERROR_CODING_STYLE, u32::from(style.component_transform));
        }
        self.read_coding_parameters(&mut style)?;
        style.initialized = true;
        let (styles, properties) = self.coding_styles(target);
        for component in 0..component_count {
            if properties[component] & HAD_COMPONENT_CODING == 0 {
                styles[component] = style;
            }
        }
        Ok(())
    }

    /// COC: one component's coding style, which keeps the SOP and EPH flags of the style it replaces.
    fn read_component_coding_style(&mut self, target: HeaderTarget) -> DecodeResult<()> {
        if self.stream.bytes_left() < 2 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(COC));
        }
        let component: usize = usize::from(self.read_u8());
        if component >= self.component_count() {
            return fail(ERROR_CODING_STYLE, component as u32);
        }
        let mut style: CodingStyle = self.coding_styles(target).0[component];
        let kept_flags: u8 = style.coding_style & (CODING_STYLE_START_OF_PACKET | CODING_STYLE_END_OF_PACKET_HEADER);
        style.coding_style = self.read_u8() | kept_flags;
        self.read_coding_parameters(&mut style)?;
        style.initialized = true;
        let (styles, properties) = self.coding_styles(target);
        styles[component] = style;
        properties[component] |= HAD_COMPONENT_CODING;
        Ok(())
    }

    /// RGN: a component's region of interest shift, in the main header or the first tile-part of a tile.
    fn read_region(&mut self) -> DecodeResult<()> {
        let component: usize = if self.component_count() < 257 { usize::from(self.read_u8()) } else { usize::from(self.read_u16()) };
        if self.read_u8() != 0 {
            return fail(ERROR_REGION_OF_INTEREST, component as u32);
        }
        if component >= self.component_count() {
            return fail(ERROR_REGION_OF_INTEREST, component as u32);
        }
        match self.current_tile {
            None => {
                let shift: u8 = self.read_u8();
                if shift > MAXIMUM_ROI_SHIFT {
                    return fail(ERROR_REGION_OF_INTEREST, u32::from(shift));
                }
                self.region_shift[component] = shift;
            }
            Some(index) => {
                if self.tiles[index].as_deref().is_some_and(|tile: &TileHeader| tile.tile_part_index != 0) {
                    return fail(ERROR_REGION_OF_INTEREST, RGN_OUTSIDE_FIRST_TILE_PART);
                }
                let shift: u8 = self.read_u8();
                if shift > MAXIMUM_ROI_SHIFT {
                    return fail(ERROR_REGION_OF_INTEREST, u32::from(shift));
                }
                if let Some(tile) = self.tiles[index].as_mut() {
                    tile.region_shift[component] = shift;
                }
            }
        }
        Ok(())
    }

    /// The Sqcd or Sqcc part of a QCD or QCC and its step sizes; `length` is the marker segment's length less what precedes Sqcd.
    fn read_quantization_parameters(&mut self, length: usize, style: &mut QuantizationStyle) -> DecodeResult<()> {
        if self.stream.bytes_left() < 1 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(QCD));
        }
        let parameters: u8 = self.read_u8();
        style.guard_bits = parameters >> 5;
        style.style = parameters & 0x1F;
        match style.style {
            QUANTIZATION_NONE => {
                let count: usize = length.wrapping_sub(3);
                if self.stream.bytes_left() < count || count > QUANTIZATION_BANDS {
                    return fail(ERROR_QUANTIZATION, length as u32);
                }
                for band in 0..count {
                    style.exponents[band] = self.read_u8() >> 3;
                }
            }
            QUANTIZATION_SCALAR_DERIVED => {
                if self.stream.bytes_left() < 2 {
                    return fail(ERROR_QUANTIZATION, length as u32);
                }
                let step: u16 = self.read_u16();
                style.exponents[0] = (step >> 11) as u8;
                style.mantissas[0] = step & 0x7FF;
                for band in 1..QUANTIZATION_BANDS {
                    style.exponents[band] = (i32::from(style.exponents[0]) - ((band as i32 - 1) / 3)).max(0) as u8;
                    style.mantissas[band] = style.mantissas[0];
                }
            }
            _ => {
                let count: usize = length.wrapping_sub(3) >> 1;
                if self.stream.bytes_left() < 2 * count || count > QUANTIZATION_BANDS {
                    return fail(ERROR_QUANTIZATION, length as u32);
                }
                for band in 0..count {
                    let step: u16 = self.read_u16();
                    style.exponents[band] = (step >> 11) as u8;
                    style.mantissas[band] = step & 0x7FF;
                }
            }
        }
        Ok(())
    }

    /// QCD: the default quantization, for every component no QCC has set.
    fn read_quantization(&mut self, length: usize, target: HeaderTarget) -> DecodeResult<()> {
        let mut style: QuantizationStyle = QuantizationStyle::default();
        self.read_quantization_parameters(length, &mut style)?;
        let component_count: usize = self.component_count();
        let (styles, properties) = self.quantization_styles(target);
        for component in 0..component_count {
            if properties[component] & HAD_COMPONENT_QUANTIZATION == 0 {
                styles[component] = style;
            }
        }
        Ok(())
    }

    /// QCC: one component's quantization, which FFmpeg updates in place.
    fn read_component_quantization(&mut self, length: usize, target: HeaderTarget) -> DecodeResult<()> {
        if self.stream.bytes_left() < 1 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(QCC));
        }
        let component: usize = usize::from(self.read_u8());
        if component >= self.component_count() {
            return fail(ERROR_QUANTIZATION, component as u32);
        }
        self.quantization_styles(target).1[component] |= HAD_COMPONENT_QUANTIZATION;
        let mut style: QuantizationStyle = self.quantization_styles(target).0[component];
        let result: DecodeResult<()> = self.read_quantization_parameters(length - 1, &mut style);
        self.quantization_styles(target).0[component] = style;
        result
    }

    /// POC: progression order changes, which replace a tile's copy of the main header's and add to its own.
    fn read_progression_changes(&mut self, length: usize, target: HeaderTarget) -> DecodeResult<()> {
        if self.stream.bytes_left() < 5 || length < 2 + PROGRESSION_ENTRY_LENGTH {
            return fail(ERROR_MARKER_SEGMENT, u32::from(POC));
        }
        let component_count: usize = self.component_count();
        let mut changes: ProgressionChanges = ProgressionChanges { count: (length - 2) / PROGRESSION_ENTRY_LENGTH, ..ProgressionChanges::default() };
        if changes.count > MAXIMUM_PROGRESSION_CHANGES {
            return fail(ERROR_PROGRESSION_ORDER, changes.count as u32);
        }
        for index in 0..changes.count {
            let mut entry: ProgressionChange = ProgressionChange { resolution_start: self.read_u8(), ..ProgressionChange::default() };
            entry.component_start = u16::from(self.read_u8());
            entry.layer_end = self.read_u16();
            entry.resolution_end = self.read_u8();
            entry.component_end = u16::from(self.read_u8());
            entry.order = self.read_u8();
            if entry.component_end == 0 {
                entry.component_end = ALL_COMPONENTS;
            }
            entry.component_end = entry.component_end.min(component_count as u16);
            if entry.resolution_start >= entry.resolution_end
                || entry.resolution_end > MAXIMUM_RESOLUTION_END
                || entry.component_start >= entry.component_end
                || usize::from(entry.component_end) > component_count
                || entry.layer_end == 0
            {
                return fail(ERROR_PROGRESSION_ORDER, index as u32);
            }
            changes.entries[index] = entry;
        }
        let existing: &mut ProgressionChanges = match target {
            HeaderTarget::Main => &mut self.main.progression,
            HeaderTarget::Tile(index) => &mut self.tiles[index].as_mut().expect("a tile target has a header").progression,
        };
        if existing.count == 0 || existing.is_default {
            *existing = changes;
        } else {
            if existing.count + changes.count > MAXIMUM_PROGRESSION_CHANGES {
                return fail(ERROR_PROGRESSION_ORDER, (existing.count + changes.count) as u32);
            }
            let first: usize = existing.count;
            existing.entries[first..first + changes.count].copy_from_slice(&changes.entries[..changes.count]);
            existing.count += changes.count;
        }
        existing.is_default = false;
        Ok(())
    }

    /// SOT: starts a tile-part, whose data ends Psot bytes after the marker; the first tile-part of a tile copies the main header's styles.
    fn read_tile_part_start(&mut self, length: usize) -> DecodeResult<()> {
        if self.stream.bytes_left() < SOT_LENGTH {
            return fail(ERROR_TILE_PART, u32::from(SOT));
        }
        self.current_tile = Some(0);
        let tile_index: usize = usize::from(self.read_u16());
        if tile_index >= self.tiles.len() {
            return fail(ERROR_TILE_PART, tile_index as u32);
        }
        self.current_tile = Some(tile_index);
        let mut tile_part_length: i64 = i64::from(self.read_u32());
        let tile_part_index: usize = usize::from(self.read_u8());
        self.read_u8();
        let available: i64 = self.stream.bytes_left() as i64 - 2 + length as i64 + 2;
        if tile_part_length == 0 {
            tile_part_length = available;
        }
        if tile_part_length > available {
            return fail_signed(ERROR_TILE_PART, tile_part_length);
        }
        if tile_part_index >= TILE_PART_SLOTS {
            return fail(ERROR_TILE_PART, tile_part_index as u32);
        }
        let end: i64 = self.stream.position as i64 + tile_part_length - length as i64 - 2;
        let main: &MainHeader = &self.main;
        let tile: &mut Box<TileHeader> = self.tiles[tile_index].get_or_insert_with(Box::default);
        tile.tile_part_index = tile_part_index as u16;
        tile.tile_parts[tile_part_index].end = end.max(0) as usize;
        if tile_part_index == 0 {
            tile.coding = main.coding;
            tile.quantization = main.quantization;
            tile.progression = main.progression;
            tile.progression.is_default = true;
        }
        Ok(())
    }

    /// TLM: tile-part lengths, which FFmpeg reads past.
    fn read_tile_lengths(&mut self, length: usize) -> DecodeResult<()> {
        self.read_u8();
        let parameters: u8 = self.read_u8();
        let size_type: u8 = (parameters >> TILE_LENGTH_SIZE_TYPE_SHIFT) & 0x03;
        if size_type == INVALID_TILE_LENGTH_SIZE {
            return fail(ERROR_MARKER_SEGMENT, u32::from(TLM));
        }
        let pointer_size: usize = usize::from((parameters >> TILE_LENGTH_POINTER_SHIFT) & 0x01);
        let entry_length: usize = (pointer_size + 1) * 2 + usize::from(size_type);
        let entries: usize = (length.wrapping_sub(4) / entry_length) & 0xFF;
        for _ in 0..entries {
            match size_type {
                1 => {
                    self.read_u8();
                }
                2 => {
                    self.read_u16();
                }
                _ => {}
            }
            if pointer_size == 0 {
                self.read_u16();
            } else {
                self.read_u32();
            }
        }
        Ok(())
    }

    /// PLT: packet lengths, which FFmpeg reads past, requiring the last length to end.
    fn read_packet_lengths(&mut self, length: usize) -> DecodeResult<()> {
        if length < MINIMUM_PACKET_LENGTH_SEGMENT {
            return fail(ERROR_MARKER_SEGMENT, u32::from(PLT));
        }
        self.read_u8();
        let mut last: u8 = 0;
        for _ in 0..length - 3 {
            last = self.read_u8();
        }
        if last & PACKET_LENGTH_CONTINUATION != 0 {
            return fail(ERROR_MARKER_SEGMENT, u32::from(PLT));
        }
        Ok(())
    }

    /// Appends a PPM's or PPT's packed packet headers to the arena and returns where they start.
    fn append_packed_headers(&mut self, length: usize) -> usize {
        self.read_u8();
        let count: usize = length - 3;
        let start: usize = self.arena.len();
        let source: usize = self.stream.position;
        let end: usize = source + count.min(self.stream.bytes_left());
        self.arena.extend_from_within(source..end);
        self.arena.resize(start + count, 0);
        self.stream.skip(count);
        start
    }

    /// PPM: packed packet headers of the whole codestream, in the main header only.
    fn read_packed_main_headers(&mut self, length: usize) -> DecodeResult<()> {
        if length < MINIMUM_PACKED_HEADER_SEGMENT {
            return fail(ERROR_MARKER_SEGMENT, u32::from(PPM));
        }
        let start: usize = self.append_packed_headers(length);
        if !self.has_packed_main_headers {
            self.packed_main_headers_start = start;
        }
        // Each PPM's data follows the last in the arena, since nothing else is appended before the first SOT
        self.packed_main_headers_length += length - 3;
        self.has_packed_main_headers = true;
        Ok(())
    }

    /// PPT: packed packet headers of a tile, in its first tile-part's header.
    fn read_packed_tile_headers(&mut self, length: usize) -> DecodeResult<()> {
        if length < MINIMUM_PACKED_HEADER_SEGMENT {
            return fail(ERROR_MARKER_SEGMENT, u32::from(PPT));
        }
        let Some(index) = self.current_tile else {
            return fail(ERROR_MARKER_SEGMENT, SOT_MISSING);
        };
        if self.tiles[index].as_deref().is_some_and(|tile: &TileHeader| tile.tile_part_index != 0) {
            return fail(ERROR_MARKER_SEGMENT, PPT_OUTSIDE_FIRST_TILE_PART);
        }
        let start: usize = self.append_packed_headers(length);
        let tile: &mut Box<TileHeader> = self.tiles[index].get_or_insert_with(Box::default);
        if !tile.has_packed_headers {
            tile.packed_headers_start = start;
        }
        // A tile's PPTs sit together in its first tile-part's header, so they stay contiguous in the arena
        tile.packed_headers_length += length - 3;
        tile.has_packed_headers = true;
        Ok(())
    }

    /// SOD: the current tile-part's packet data runs to its end; with a PPM, its packet headers are the PPM's next Nppm bytes.
    fn read_tile_part_data(&mut self) -> DecodeResult<()> {
        if self.size.is_none() {
            return fail(ERROR_MARKER_SEGMENT, SIZ_MISSING);
        }
        let Some(index) = self.current_tile else {
            return fail(ERROR_MARKER_SEGMENT, SOT_MISSING);
        };
        let position: usize = self.stream.position;
        let has_packed_main_headers: bool = self.has_packed_main_headers;
        let mut header_stream: Option<ByteStream> = None;
        let tile_part_index: usize = self.tiles[index].as_deref().map_or(0, |tile: &TileHeader| usize::from(tile.tile_part_index));
        let end: usize = self.tiles[index].as_deref().map_or(0, |tile: &TileHeader| tile.tile_parts[tile_part_index].end);
        if end < position {
            return fail(ERROR_TILE_PART, TILE_PART_END_BEFORE_DATA);
        }
        if has_packed_main_headers {
            let header_length: usize = self.packed_main_headers.read_u32(&self.arena) as usize;
            if self.packed_main_headers.bytes_left() < header_length {
                return fail(ERROR_TILE_PART, PACKED_HEADER_OVERRUN);
            }
            let start: usize = self.packed_main_headers.position;
            header_stream = Some(ByteStream::new(start, start + header_length));
            self.packed_main_headers.skip(header_length);
        }
        let data_end: usize = end.min(self.stream.end);
        let tile: &mut Box<TileHeader> = self.tiles[index].get_or_insert_with(Box::default);
        if let Some(stream) = header_stream {
            tile.tile_parts[tile_part_index].header = stream;
        }
        if tile.has_packed_headers && tile_part_index == 0 {
            tile.packed_headers = ByteStream::new(tile.packed_headers_start, tile.packed_headers_start + tile.packed_headers_length);
        }
        tile.tile_parts[tile_part_index].data = ByteStream::new(position, data_end);
        self.stream.seek(data_end);
        Ok(())
    }

    /// Reads marker segments until EOC or the end of the codestream, as FFmpeg's main header loop does.
    fn scan(&mut self) -> DecodeResult<()> {
        loop {
            if self.stream.bytes_left() < 2 {
                // A codestream without EOC decodes what it holds
                return Ok(());
            }
            let marker: u16 = self.read_u16();
            let segment_start: usize = self.stream.position;
            if (RESERVED_MARKER_FIRST..=RESERVED_MARKER_LAST).contains(&marker) {
                continue;
            }
            if marker == SOD {
                self.read_tile_part_data()?;
                continue;
            }
            if marker == EOC {
                return Ok(());
            }
            let length: usize = usize::from(self.read_u16());
            if length < 2 || self.stream.bytes_left() < length - 2 {
                // FFmpeg ends the codestream at a segment that does not fit, unless it is strict
                return Ok(());
            }
            let target: HeaderTarget = self.target();
            match marker {
                SIZ => {
                    if self.component_count() != 0 {
                        return fail(ERROR_MARKER_SEGMENT, SIZ_REPEATED);
                    }
                    self.read_image_size()?;
                }
                CAP => {
                    if self.component_count() == 0 {
                        return fail(ERROR_MARKER_SEGMENT, CAP_BEFORE_SIZ);
                    }
                    self.read_capabilities()?;
                }
                COC => self.read_component_coding_style(target)?,
                COD => self.read_coding_style(target)?,
                RGN => self.read_region()?,
                QCC => self.read_component_quantization(length, target)?,
                QCD => self.read_quantization(length, target)?,
                POC => self.read_progression_changes(length, target)?,
                SOT => {
                    if !self.in_tile_headers {
                        self.in_tile_headers = true;
                        if self.has_packed_main_headers {
                            self.packed_main_headers = ByteStream::new(self.packed_main_headers_start, self.packed_main_headers_start + self.packed_main_headers_length);
                        }
                    }
                    self.read_tile_part_start(length)?;
                }
                PLM | COM | CPF => self.stream.skip(length - 2),
                CRG => {
                    if self.component_count() * 4 != length - 2 {
                        return fail(ERROR_MARKER_SEGMENT, u32::from(CRG));
                    }
                    self.stream.skip(length - 2);
                }
                TLM => self.read_tile_lengths(length)?,
                PLT => self.read_packet_lengths(length)?,
                PPM => {
                    if self.in_tile_headers {
                        return fail(ERROR_MARKER_SEGMENT, PPM_IN_TILE_HEADER);
                    }
                    self.read_packed_main_headers(length)?;
                }
                PPT => {
                    if self.has_packed_main_headers {
                        return fail(ERROR_MARKER_SEGMENT, PPM_AND_PPT);
                    }
                    self.read_packed_tile_headers(length)?;
                }
                _ => self.stream.skip(length - 2),
            }
            if self.stream.position - segment_start != length {
                return fail(ERROR_MARKER_SEGMENT, u32::from(marker));
            }
        }
    }
}

/// Fails unless a size is positive and its padded area stays within FFmpeg's av_image_check_size2 bound.
fn check_image_dimensions(width: i64, height: i64) -> DecodeResult<()> {
    if width <= 0 || height <= 0 || (width + IMAGE_SIZE_PADDING) * (height + IMAGE_SIZE_PADDING) >= IMAGE_SIZE_LIMIT {
        return fail_signed(ERROR_IMAGE_SIZE, width.max(height));
    }
    Ok(())
}

/// How a parse settles the pixel format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormatChoice {
    /// Picks it as FFmpeg does, keeping the stream's previous picture's format while it still fits the components
    Choose(Option<PixelFormat>),
    /// Takes the format the picture's plan chose, as a parse worker repeats the plan's parse
    Given(PixelFormat),
}

/// Parses a packet's codestream headers and tile-part ranges, settling the pixel format as `format_choice` says.
pub fn parse_codestream(packet: &[u8], format_choice: FormatChoice) -> DecodeResult<Codestream> {
    let located: LocatedCodestream = locate_codestream(packet)?;
    let mut scanner: Scanner = Scanner {
        arena: packet.to_vec(),
        stream: ByteStream::new(located.first_marker, packet.len()),
        size: None,
        colour: located.colour,
        format_choice,
        pixel_format: None,
        main: MainHeader {
            coding: [CodingStyle::default(); MAXIMUM_COMPONENTS],
            quantization: [QuantizationStyle::default(); MAXIMUM_COMPONENTS],
            properties: [0; MAXIMUM_COMPONENTS],
            progression: ProgressionChanges::default(),
        },
        region_shift: [0; MAXIMUM_COMPONENTS],
        tiles: Vec::new(),
        current_tile: None,
        in_tile_headers: false,
        has_packed_main_headers: false,
        packed_main_headers_start: 0,
        packed_main_headers_length: 0,
        packed_main_headers: ByteStream::default(),
        packet_length: packet.len(),
    };
    scanner.scan()?;
    let (Some(size), Some(pixel_format)) = (scanner.size, scanner.pixel_format) else {
        return fail(ERROR_MARKER_SEGMENT, SIZ_MISSING);
    };
    Ok(Codestream {
        arena: scanner.arena,
        size,
        colour: scanner.colour,
        pixel_format,
        region_shift: scanner.region_shift,
        has_packed_main_headers: scanner.has_packed_main_headers,
        tiles: scanner.tiles,
    })
}
