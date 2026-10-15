// The header stage: the codec private data, sequence headers, entry points, picture and field headers, bitplanes, and the intensity
// compensation lookups. Each step mirrors the all-WGSL decoder's header stage, itself FFmpeg's vc1.c and vc1dec.c step for step, so
// pictures parse exactly as FFmpeg parses them.

use crate::bitstream::BitReader;
use crate::error::{DecodeResult, fail};
use crate::layout::{
    CONDOVER_NONE, CONDOVER_SELECT, ERROR_BITPLANE, ERROR_CONFIGURATION, ERROR_PICTURE_SIZE, ERROR_SEQUENCE_HEADER, ERROR_UNSUPPORTED_FEATURE,
    FCM_FIELD, FCM_FRAME, FCM_PROGRESSIVE, MAXIMUM_MACROBLOCKS, PROFILE_ADVANCED, PROFILE_SIMPLE, TT_8X8, TYPE_B, TYPE_BI, TYPE_I, TYPE_P,
};
use crate::segments::{START_CODE_LENGTH, append_unescaped, find_start_code};
use crate::tables::{BFRACTION_LUT, MV_PMODE_TABLE, MV_PMODE_TABLE2, PQUANT_IMPLICIT, TTFRM_TO_TT};
use crate::vlc::{INVALID_SYMBOL, lookups};

// Motion vector modes of P pictures, FFmpeg's MV_PMODE_*
pub const MV_MODE_1MV_HPEL_BILINEAR: u32 = 0;
pub const MV_MODE_1MV: u32 = 1;
pub const MV_MODE_1MV_HPEL: u32 = 2;
pub const MV_MODE_MIXED_MV: u32 = 3;
pub const MV_MODE_INTENSITY_COMPENSATION: u32 = 4;

// Quantizer modes, FFmpeg's QUANT_*
const QUANT_FRAME_IMPLICIT: u32 = 0;
const QUANT_FRAME_EXPLICIT: u32 = 1;
const QUANT_NON_UNIFORM: u32 = 2;

// Edges where the macroblock quantizer may change, FFmpeg's DQPROFILE_*
pub const DQPROFILE_FOUR_EDGES: u32 = 0;
pub const DQPROFILE_DOUBLE_EDGES: u32 = 1;
pub const DQPROFILE_SINGLE_EDGE: u32 = 2;
pub const DQPROFILE_ALL_MBS: u32 = 3;
// DQUANT 2 codes no VOPDQUANT flag
const DQUANT_PER_MACROBLOCK: u32 = 2;

// AC coding sets, FFmpeg's CS_* order
const CS_HIGH_MOT_INTRA: u32 = 0;
const CS_HIGH_MOT_INTER: u32 = 1;
const CS_LOW_MOT_INTRA: u32 = 2;
const CS_LOW_MOT_INTER: u32 = 3;
const CS_MID_RATE_INTRA: u32 = 4;
const CS_MID_RATE_INTER: u32 = 5;
const CS_HIGH_RATE_INTRA: u32 = 6;
const CS_HIGH_RATE_INTER: u32 = 7;

// How a bitplane reached the decoder: not coded and all zero, raw bits in the macroblock layer, or decoded into the plane bytes
pub const PLANE_ABSENT: u32 = 0;
pub const PLANE_RAW: u32 = 1;
pub const PLANE_DECODED: u32 = 2;

// Bitplanes by their bit of a macroblock's plane byte
pub const PLANE_MVTYPE: u8 = 1;
pub const PLANE_SKIP: u8 = 2;
pub const PLANE_DIRECT: u8 = 4;
pub const PLANE_FORWARD: u8 = 8;
pub const PLANE_ACPRED: u8 = 16;
pub const PLANE_OVERFLAGS: u8 = 32;
pub const PLANE_FIELDTX: u8 = 64;

// Bitplane coding modes, FFmpeg's IMODE_*
const IMODE_RAW: u32 = 0;
const IMODE_NORM2: u32 = 1;
const IMODE_DIFF2: u32 = 2;
const IMODE_NORM6: u32 = 3;
const IMODE_DIFF6: u32 = 4;
const IMODE_ROWSKIP: u32 = 5;
const IMODE_COLSKIP: u32 = 6;

// Start code types
pub const MARKER_SLICE: u8 = 0x0B;
pub const MARKER_FIELD: u8 = 0x0C;
pub const MARKER_FRAME: u8 = 0x0D;
pub const MARKER_ENTRY_POINT: u8 = 0x0E;
pub const MARKER_SEQUENCE_HEADER: u8 = 0x0F;

// Video for Windows headers in a Matroska CodecPrivate
const BITMAP_INFO_HEADER_SIZE: usize = 40;
const BITMAP_INFO_WIDTH_OFFSET: usize = 4;
const BITMAP_INFO_HEIGHT_OFFSET: usize = 8;
const BITMAP_INFO_FOURCC_OFFSET: usize = 16;
const FOURCC_WMV3: u32 = 0x3356_4D57;
const FOURCC_WMVA: u32 = 0x4156_4D57;
const FOURCC_WVC1: u32 = 0x3143_5657;
const FOURCC_WMVP: u32 = 0x5056_4D57;
const FOURCC_WVP2: u32 = 0x3250_5657;
// The Simple and Main profile sequence header, STRUCT_C, is 4 bytes of WMV3 extradata
const STRUCT_C_SIZE: usize = 4;
// VC-1 extradata holds at least a sequence header and an entry point
const MINIMUM_ADVANCED_EXTRADATA_SIZE: usize = 16;
// The configuration failure's value for a Simple or Main profile sequence header without the Video for Windows header that sizes its
// frames, above any codec private length the other configuration failures report
pub const CONFIGURATION_FRAME_SIZE_MISSING: u32 = 0xFF_FFFF;
// The configuration failure values of VC-1 extradata without a sequence header, and with one but no entry point
const CONFIGURATION_SEQUENCE_MISSING: u32 = 1;
const CONFIGURATION_ENTRY_POINT_MISSING: u32 = 2;
// The sequence header failure values: a STRUCT_C FFmpeg refuses, an Advanced profile STRUCT_C, and VC-1 extradata FFmpeg refuses
const SEQUENCE_HEADER_STRUCT_C_REFUSED: u32 = 0;
const SEQUENCE_HEADER_STRUCT_C_ADVANCED: u32 = 1;
const SEQUENCE_HEADER_EXTRADATA_REFUSED: u32 = 2;
// The unsupported feature values: 4:1:1 sampling, sprites, and a chroma format other than 4:2:0
const UNSUPPORTED_Y411: u32 = 1;
const UNSUPPORTED_SPRITES: u32 = 2;
const UNSUPPORTED_CHROMA_FORMAT: u32 = 3;
const CHROMA_FORMAT_420: u32 = 1;

// The lookup sets: two anchor sets swapped by each anchor, and the B pictures' auxiliary set
pub const LOOKUP_SET_COUNT: usize = 3;
pub const LOOKUP_TABLES: usize = 4;
pub const LOOKUP_ENTRIES: usize = 256;
const LOOKUP_AUXILIARY: u32 = 2;
// Lookup fills of one header: at most rotate_luts' two and two of intensity compensation
const LOOKUP_QUEUE_SIZE: usize = 4;
// LUMSCALE and LUMSHIFT of an identity lookup
const IDENTITY_LUMSCALE: u32 = 32;
const IDENTITY_LUMSHIFT: u32 = 0;
// Pan-scan window bits: horizontal and vertical offsets, then width and height
const PAN_SCAN_WINDOW_BITS: u32 = 18 + 18 + 14 + 14;
// REFDIST is at most this
const MAXIMUM_REFDIST: u32 = 16;
// The index of BFRACTION's invalid code
const BFRACTION_INVALID_INDEX: u32 = 21;
const BFRACTION_ESCAPE: u32 = 7;
// PQINDEX values below this code HALFQP, and pick the implicit quantizer's non-uniform quantization
const HALFQP_PQINDEX_LIMIT: u32 = 9;
// The PQUANT thresholds of the low quantizer and of the transform type tables
const LOW_QUANTIZER_LIMIT: u32 = 12;
const MID_QUANTIZER_LIMIT: u32 = 4;
// The overlap of Advanced profile I pictures depends on CONDOVER at PQUANT 8 and below
const CONDOVER_PQUANT_LIMIT: u32 = 8;
// PQINDEX values up to this pick the high rate coding sets for table index 0
const HIGH_RATE_PQINDEX_LIMIT: u32 = 8;
// Luma samples along a macroblock's side
const MACROBLOCK_SIZE: u32 = 16;

/// The state of FFmpeg's VC1Context that outlives a picture: the sequence header, the entry point, and the decoder's own state, the
/// WGSL decoder's S_ fields.
#[derive(Clone, Default)]
pub struct StreamState {
    pub configured: bool,
    pub sequence_valid: bool,
    pub entry_point_valid: bool,
    pub profile: u32,
    pub loop_filter: u32,
    pub res_x8: u32,
    pub multires: u32,
    pub res_fasttx: u32,
    pub fastuvmc: u32,
    pub extended_mv: u32,
    pub dquant: u32,
    pub vstransform: u32,
    pub overlap: u32,
    pub rangered: u32,
    pub max_b_frames: u32,
    pub quantizer_mode: u32,
    pub finterpflag: u32,
    pub res_sprite: u32,
    pub res_rtm_flag: u32,
    pub postprocflag: u32,
    pub max_coded_width: u32,
    pub max_coded_height: u32,
    pub broadcast: u32,
    pub interlace: u32,
    pub tfcntrflag: u32,
    pub psf: u32,
    pub hrd_param_flag: u32,
    pub hrd_leaky_buckets: u32,
    pub panscanflag: u32,
    pub refdist_flag: u32,
    pub extended_dmv: u32,
    pub coded_width: u32,
    pub coded_height: u32,
    pub mb_width: u32,
    pub mb_height: u32,
    pub rnd: u32,
    pub mvrange: u32,
    pub tff: u32,
    pub dmvrange: u32,
    pub refdist: u32,
    pub dqprofile: u32,
    pub dqsbedge: u32,
    pub dqbilevel: u32,
    pub lookups: IntensityLookups,
}

/// The intensity compensation lookups: three sets of four 256-entry tables, luma of field 0 and 1, then chroma of field 0 and 1, and
/// which set the last and next anchors use and whether they use it.
#[derive(Clone)]
pub struct IntensityLookups {
    pub tables: [[[u8; LOOKUP_ENTRIES]; LOOKUP_TABLES]; LOOKUP_SET_COUNT],
    pub last_set: u32,
    pub next_set: u32,
    pub last_use: u32,
    pub next_use: u32,
    pub auxiliary_use: u32,
}

impl Default for IntensityLookups {
    fn default() -> Self {
        Self { tables: [[[0; LOOKUP_ENTRIES]; LOOKUP_TABLES]; LOOKUP_SET_COUNT], last_set: 0, next_set: 0, last_use: 0, next_use: 0, auxiliary_use: 0 }
    }
}

/// Which use flag the current picture's own lookups set: the next anchor's, or the auxiliary set's; none before the header rotated them.
#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum CurrentUseField {
    #[default]
    Unset,
    Next,
    Auxiliary,
}

/// One queued lookup fill: the set, the field, LUMSCALE, LUMSHIFT, and whether it composes with the set's current values.
#[derive(Clone, Copy)]
struct LookupFill {
    lookup_set: u32,
    field: u32,
    lumscale: u32,
    lumshift: u32,
    chain: bool,
}

fn clip_to_byte(value: i32) -> u8 {
    value.clamp(0, 255) as u8
}

impl IntensityLookups {
    /// FFmpeg's INIT_LUT: fills the luma and chroma lookups of one field of a set, composed with their current values when chained.
    fn initialize(&mut self, fill: LookupFill) {
        let (scale, shift): (i32, i32) = if fill.lumscale == 0 {
            let mut shift: i32 = (255 - fill.lumshift as i32 * 2) * 64;
            if fill.lumshift > 31 {
                shift += 128 << 6;
            }
            (-64, shift)
        } else if fill.lumshift > 31 {
            (fill.lumscale as i32 + 32, (fill.lumshift as i32 - 64) * 64)
        } else {
            (fill.lumscale as i32 + 32, (fill.lumshift as i32) << 6)
        };
        let set: &mut [[u8; LOOKUP_ENTRIES]; LOOKUP_TABLES] = &mut self.tables[fill.lookup_set as usize];
        let field: usize = fill.field as usize;
        for entry in 0..LOOKUP_ENTRIES {
            let luma: i32 = if fill.chain { i32::from(set[field][entry]) } else { entry as i32 };
            let chroma: i32 = if fill.chain { i32::from(set[2 + field][entry]) } else { entry as i32 };
            set[field][entry] = clip_to_byte((scale * luma + shift + 32) >> 6);
            set[2 + field][entry] = clip_to_byte((scale * (chroma - 128) + 128 * 64 + 32) >> 6);
        }
    }

    fn use_flag(&self, field: CurrentUseField) -> u32 {
        match field {
            CurrentUseField::Unset => 0,
            CurrentUseField::Next => self.next_use,
            CurrentUseField::Auxiliary => self.auxiliary_use,
        }
    }

    fn set_use_flag(&mut self, field: CurrentUseField, value: u32) {
        match field {
            CurrentUseField::Unset => {}
            CurrentUseField::Next => self.next_use = value,
            CurrentUseField::Auxiliary => self.auxiliary_use = value,
        }
    }
}

/// The picture header fields of FFmpeg's VC1Context that the header stage parses: the WGSL header stage's private variables, which
/// start from zero for each packet.
#[derive(Clone, Default)]
pub struct PictureHeader {
    pub picture_type: u32,
    pub fcm: u32,
    pub field_mode: u32,
    pub second_field: u32,
    pub current_field_type: u32,
    pub field_picture_type: u32,
    pub picture_skipped: u32,
    pub pq: u32,
    pub pqindex: u32,
    pub halfpq: u32,
    pub pquantizer: u32,
    pub altpq: u32,
    pub dquantfrm: u32,
    pub mv_mode: u32,
    pub mv_mode2: u32,
    pub quarter_sample: u32,
    pub mspel: u32,
    pub mv_table_index: u32,
    pub cbptab: u32,
    pub ttmbf: u32,
    pub ttfrm: u32,
    pub tt_index: u32,
    pub c_ac_table_index: u32,
    pub y_ac_table_index: u32,
    pub dc_table_index: u32,
    pub picture_rnd: u32,
    pub condover: u32,
    pub fourmvswitch: u32,
    pub intcomp: u32,
    pub mbmodetab: u32,
    pub imvtab: u32,
    pub icbptab: u32,
    pub twomvbptab: u32,
    pub fourmvbptab: u32,
    pub numref: u32,
    pub reffield: u32,
    pub ref_field_type_forward: u32,
    pub frfd: u32,
    pub brfd: u32,
    pub bfraction: i32,
    pub rangeredfrm: u32,
    pub respic: u32,
    pub x8_type: u32,
    /// RFF of a broadcast interlaced sequence's picture: repeat its first field
    pub repeat_first_field: u32,
    pub range_x: u32,
    pub range_y: u32,
    pub k_x: u32,
    pub k_y: u32,
    pub plane_mvtype: u32,
    pub plane_skip: u32,
    pub plane_direct: u32,
    pub plane_forward: u32,
    pub plane_acpred: u32,
    pub plane_overflags: u32,
    pub plane_fieldtx: u32,
    pub first_picture_header: bool,
    pub picture_header_flag: bool,
    pub current_lookup_set: u32,
    pub current_use_field: CurrentUseField,
    pub plane_row_offset: u32,
    pub mb_height: u32,
    pending_motion_vector_range: u32,
    lookup_queue: Vec<LookupFill>,
}

impl PictureHeader {
    /// Whether the picture predicts with mixed motion vectors, directly or under intensity compensation.
    pub fn is_mixed_motion_vector_mode(&self) -> bool {
        self.mv_mode == MV_MODE_MIXED_MV || (self.mv_mode == MV_MODE_INTENSITY_COMPENSATION && self.mv_mode2 == MV_MODE_MIXED_MV)
    }

    /// Clears every bitplane's state, as a frame or second field header starts.
    pub fn clear_planes(&mut self) {
        self.plane_mvtype = PLANE_ABSENT;
        self.plane_skip = PLANE_ABSENT;
        self.plane_direct = PLANE_ABSENT;
        self.plane_forward = PLANE_ABSENT;
        self.plane_acpred = PLANE_ABSENT;
        self.plane_overflags = PLANE_ABSENT;
        self.plane_fieldtx = PLANE_ABSENT;
    }

    /// The coding sets of vc1_decode_i_blocks, vc1_decode_p_blocks, and vc1_decode_b_blocks: the intra set and the inter set.
    pub fn coding_sets(&self) -> (u32, u32) {
        let intra_index: u32 = if self.picture_type == TYPE_I || self.picture_type == TYPE_BI { self.y_ac_table_index } else { self.c_ac_table_index };
        let codingset: u32 = match intra_index {
            0 => {
                if self.pqindex <= HIGH_RATE_PQINDEX_LIMIT {
                    CS_HIGH_RATE_INTRA
                } else {
                    CS_LOW_MOT_INTRA
                }
            }
            1 => CS_HIGH_MOT_INTRA,
            _ => CS_MID_RATE_INTRA,
        };
        let codingset2: u32 = match self.c_ac_table_index {
            0 => {
                if self.pqindex <= HIGH_RATE_PQINDEX_LIMIT {
                    CS_HIGH_RATE_INTER
                } else {
                    CS_LOW_MOT_INTER
                }
            }
            1 => CS_HIGH_MOT_INTER,
            _ => CS_MID_RATE_INTER,
        };
        (codingset, codingset2)
    }
}

/// The plane bytes of a frame, one per macroblock with a bit per bitplane; a field picture decodes each field's planes into its rows.
#[derive(Clone, Default)]
pub struct Bitplanes {
    pub width: u32,
    pub bytes: Vec<u8>,
}

impl Bitplanes {
    /// Sizes the planes for a frame of width x rows macroblocks, keeping nothing.
    pub fn reset(&mut self, width: u32, rows: u32) {
        self.width = width;
        self.bytes.clear();
        self.bytes.resize((width * rows) as usize, 0);
    }

    fn index(&self, row_offset: u32, x: u32, y: u32) -> usize {
        ((row_offset + y) * self.width + x) as usize
    }

    fn read(&self, plane: u8, row_offset: u32, x: u32, y: u32) -> u32 {
        u32::from(self.bytes[self.index(row_offset, x, y)] & plane != 0)
    }

    fn write(&mut self, plane: u8, row_offset: u32, x: u32, y: u32, value: u32) {
        let index: usize = self.index(row_offset, x, y);
        if value != 0 {
            self.bytes[index] |= plane;
        } else {
            self.bytes[index] &= !plane;
        }
    }
}

/// The header stage of one packet: the stream state it updates, the picture header it parses, the planes it decodes, and its reader.
pub struct HeaderParser<'parse, 'bytes> {
    pub stream: &'parse mut StreamState,
    pub header: &'parse mut PictureHeader,
    pub planes: &'parse mut Bitplanes,
    pub reader: BitReader<'bytes>,
}

impl HeaderParser<'_, '_> {
    fn queue_lookup(&mut self, lookup_set: u32, field: u32, lumscale: u32, lumshift: u32, chain: bool) {
        if self.header.lookup_queue.len() >= LOOKUP_QUEUE_SIZE {
            return;
        }
        self.header.lookup_queue.push(LookupFill { lookup_set, field, lumscale, lumshift, chain });
    }

    fn apply_queued_lookups(&mut self) {
        for fill in std::mem::take(&mut self.header.lookup_queue) {
            self.stream.lookups.initialize(fill);
        }
    }

    /// FFmpeg's rotate_luts: B pictures work in the auxiliary set; an anchor swaps the last and next sets and works in the next set.
    fn rotate_lookups(&mut self) {
        let lookups: &mut IntensityLookups = &mut self.stream.lookups;
        if self.header.picture_type == TYPE_B || self.header.picture_type == TYPE_BI {
            self.header.current_lookup_set = LOOKUP_AUXILIARY;
            self.header.current_use_field = CurrentUseField::Auxiliary;
        } else {
            std::mem::swap(&mut lookups.last_set, &mut lookups.next_set);
            std::mem::swap(&mut lookups.last_use, &mut lookups.next_use);
            self.header.current_lookup_set = lookups.next_set;
            self.header.current_use_field = CurrentUseField::Next;
        }
        let current_set: u32 = self.header.current_lookup_set;
        self.queue_lookup(current_set, 0, IDENTITY_LUMSCALE, IDENTITY_LUMSHIFT, false);
        self.queue_lookup(current_set, 1, IDENTITY_LUMSCALE, IDENTITY_LUMSHIFT, false);
        let field: CurrentUseField = self.header.current_use_field;
        self.stream.lookups.set_use_flag(field, 0);
    }

    /// The use flag of the current picture's own lookups.
    pub fn current_use_flag(&self) -> u32 {
        self.stream.lookups.use_flag(self.header.current_use_field)
    }

    /// FFmpeg's decode_rowskip over columns [first_column, first_column + width) of rows [first_row, first_row + height)
    fn decode_rowskip(&mut self, plane: u8, first_column: u32, first_row: u32, width: u32, height: u32) {
        let row_offset: u32 = self.header.plane_row_offset;
        for y in first_row..first_row + height {
            let coded: bool = self.reader.read_flag();
            for x in first_column..first_column + width {
                let value: u32 = if coded { self.reader.read_bit() } else { 0 };
                self.planes.write(plane, row_offset, x, y, value);
            }
        }
    }

    /// FFmpeg's decode_colskip over columns [first_column, first_column + width) of rows [0, height)
    fn decode_colskip(&mut self, plane: u8, first_column: u32, width: u32, height: u32) {
        let row_offset: u32 = self.header.plane_row_offset;
        for x in first_column..first_column + width {
            let coded: bool = self.reader.read_flag();
            for y in 0..height {
                let value: u32 = if coded { self.reader.read_bit() } else { 0 };
                self.planes.write(plane, row_offset, x, y, value);
            }
        }
    }

    /// FFmpeg's bitplane_decoding: returns how the plane reached the decoder, or fails a malformed plane.
    fn decode_bitplane(&mut self, plane: u8) -> DecodeResult<u32> {
        let width: u32 = self.stream.mb_width;
        let height: u32 = self.header.mb_height >> self.header.field_mode;
        let row_offset: u32 = self.header.plane_row_offset;
        let invert: u32 = self.reader.read_bit();
        let imode: u32 = self.reader.read_code(&lookups().bitplane_mode);
        match imode {
            IMODE_RAW => return Ok(PLANE_RAW),
            IMODE_NORM2 | IMODE_DIFF2 => {
                let count: u32 = width * height;
                let mut position: u32 = 0;
                if count & 1 != 0 {
                    let value: u32 = self.reader.read_bit();
                    self.planes.write(plane, row_offset, 0, 0, value);
                    position = 1;
                }
                while position < count {
                    let code: u32 = self.reader.read_code(&lookups().norm2);
                    self.planes.write(plane, row_offset, position % width, position / width, code & 1);
                    self.planes.write(plane, row_offset, (position + 1) % width, (position + 1) / width, code >> 1);
                    position += 2;
                }
            }
            IMODE_NORM6 | IMODE_DIFF6 => {
                if height.is_multiple_of(3) && !width.is_multiple_of(3) {
                    // 2x3 tiles, an odd first column left to colskip
                    for y in (0..height).step_by(3) {
                        for x in ((width & 1)..width).step_by(2) {
                            let code: u32 = self.reader.read_code(&lookups().norm6);
                            if code == INVALID_SYMBOL {
                                return fail(ERROR_BITPLANE, u32::from(plane));
                            }
                            self.planes.write(plane, row_offset, x, y, code & 1);
                            self.planes.write(plane, row_offset, x + 1, y, (code >> 1) & 1);
                            self.planes.write(plane, row_offset, x, y + 1, (code >> 2) & 1);
                            self.planes.write(plane, row_offset, x + 1, y + 1, (code >> 3) & 1);
                            self.planes.write(plane, row_offset, x, y + 2, (code >> 4) & 1);
                            self.planes.write(plane, row_offset, x + 1, y + 2, (code >> 5) & 1);
                        }
                    }
                    if width & 1 != 0 {
                        self.decode_colskip(plane, 0, 1, height);
                    }
                } else {
                    // 3x2 tiles, the first width % 3 columns left to colskip and an odd first row to rowskip
                    for y in ((height & 1)..height).step_by(2) {
                        for x in ((width % 3)..width).step_by(3) {
                            let code: u32 = self.reader.read_code(&lookups().norm6);
                            if code == INVALID_SYMBOL {
                                return fail(ERROR_BITPLANE, u32::from(plane));
                            }
                            self.planes.write(plane, row_offset, x, y, code & 1);
                            self.planes.write(plane, row_offset, x + 1, y, (code >> 1) & 1);
                            self.planes.write(plane, row_offset, x + 2, y, (code >> 2) & 1);
                            self.planes.write(plane, row_offset, x, y + 1, (code >> 3) & 1);
                            self.planes.write(plane, row_offset, x + 1, y + 1, (code >> 4) & 1);
                            self.planes.write(plane, row_offset, x + 2, y + 1, (code >> 5) & 1);
                        }
                    }
                    let left_columns: u32 = width % 3;
                    if left_columns != 0 {
                        self.decode_colskip(plane, 0, left_columns, height);
                    }
                    if height & 1 != 0 {
                        self.decode_rowskip(plane, left_columns, 0, width - left_columns, 1);
                    }
                }
            }
            IMODE_ROWSKIP => self.decode_rowskip(plane, 0, 0, width, height),
            IMODE_COLSKIP => self.decode_colskip(plane, 0, width, height),
            _ => return fail(ERROR_BITPLANE, imode),
        }
        if imode == IMODE_DIFF2 || imode == IMODE_DIFF6 {
            let first: u32 = self.planes.read(plane, row_offset, 0, 0);
            self.planes.write(plane, row_offset, 0, 0, first ^ invert);
            for x in 1..width {
                let value: u32 = self.planes.read(plane, row_offset, x, 0) ^ self.planes.read(plane, row_offset, x - 1, 0);
                self.planes.write(plane, row_offset, x, 0, value);
            }
            for y in 1..height {
                let value: u32 = self.planes.read(plane, row_offset, 0, y) ^ self.planes.read(plane, row_offset, 0, y - 1);
                self.planes.write(plane, row_offset, 0, y, value);
                for x in 1..width {
                    let left: u32 = self.planes.read(plane, row_offset, x - 1, y);
                    let top: u32 = self.planes.read(plane, row_offset, x, y - 1);
                    let predictor: u32 = if left != top { invert } else { left };
                    let value: u32 = self.planes.read(plane, row_offset, x, y) ^ predictor;
                    self.planes.write(plane, row_offset, x, y, value);
                }
            }
        } else if invert != 0 {
            for y in 0..height {
                for x in 0..width {
                    let value: u32 = self.planes.read(plane, row_offset, x, y) ^ 1;
                    self.planes.write(plane, row_offset, x, y, value);
                }
            }
        }
        Ok(PLANE_DECODED)
    }

    /// Decodes a bitplane and records how it reached the decoder.
    fn decode_plane(&mut self, plane: u8) -> DecodeResult<()> {
        let state: u32 = self.decode_bitplane(plane)?;
        match plane {
            PLANE_MVTYPE => self.header.plane_mvtype = state,
            PLANE_SKIP => self.header.plane_skip = state,
            PLANE_DIRECT => self.header.plane_direct = state,
            PLANE_FORWARD => self.header.plane_forward = state,
            PLANE_ACPRED => self.header.plane_acpred = state,
            PLANE_OVERFLAGS => self.header.plane_overflags = state,
            _ => self.header.plane_fieldtx = state,
        }
        Ok(())
    }

    /// FFmpeg's vop_dquant_decoding
    fn decode_vop_dquant(&mut self) {
        if self.stream.dquant != DQUANT_PER_MACROBLOCK {
            self.header.dquantfrm = self.reader.read_bit();
            if self.header.dquantfrm == 0 {
                return;
            }
            self.stream.dqprofile = self.reader.read_bits(2);
            match self.stream.dqprofile {
                DQPROFILE_SINGLE_EDGE | DQPROFILE_DOUBLE_EDGES => self.stream.dqsbedge = self.reader.read_bits(2),
                DQPROFILE_ALL_MBS => {
                    self.stream.dqbilevel = self.reader.read_bit();
                    if self.stream.dqbilevel == 0 {
                        self.header.halfpq = 0;
                        return;
                    }
                }
                _ => {}
            }
        }
        let pqdiff: u32 = self.reader.read_bits(3);
        if pqdiff == 7 {
            self.header.altpq = self.reader.read_bits(5);
        } else {
            self.header.altpq = self.header.pq + pqdiff + 1;
        }
    }

    /// FFmpeg's read_bfraction; false for the invalid index 21.
    fn read_bfraction(&mut self) -> bool {
        let mut index: u32 = self.reader.read_bits(3);
        if index == BFRACTION_ESCAPE {
            index = BFRACTION_ESCAPE + self.reader.read_bits(4);
        }
        if index == BFRACTION_INVALID_INDEX {
            return false;
        }
        self.header.bfraction = BFRACTION_LUT[index as usize];
        true
    }

    /// The quantizer fields shared by every header: PQINDEX, HALFQP, and PQUANTIZER.
    fn read_picture_quantizer(&mut self) -> bool {
        self.header.pqindex = self.reader.read_bits(5);
        if self.header.pqindex == 0 {
            return false;
        }
        self.header.pq = if self.stream.quantizer_mode == QUANT_FRAME_IMPLICIT {
            u32::from(PQUANT_IMPLICIT[self.header.pqindex as usize])
        } else {
            self.header.pqindex
        };
        self.header.halfpq = 0;
        if self.header.pqindex < HALFQP_PQINDEX_LIMIT {
            self.header.halfpq = self.reader.read_bit();
        }
        self.header.pquantizer = match self.stream.quantizer_mode {
            QUANT_FRAME_IMPLICIT => u32::from(self.header.pqindex < HALFQP_PQINDEX_LIMIT),
            QUANT_NON_UNIFORM => 0,
            QUANT_FRAME_EXPLICIT => self.reader.read_bit(),
            _ => 1,
        };
        self.header.dquantfrm = 0;
        true
    }

    fn update_motion_vector_range(&mut self, mvrange: u32) {
        self.stream.mvrange = mvrange;
        self.header.k_x = mvrange + 9 + (mvrange >> 1);
        self.header.k_y = mvrange + 8;
        self.header.range_x = 1 << (self.header.k_x - 1);
        self.header.range_y = 1 << (self.header.k_y - 1);
    }

    fn set_quarter_sample(&mut self, mode: u32) {
        self.header.quarter_sample = u32::from(mode != MV_MODE_1MV_HPEL && mode != MV_MODE_1MV_HPEL_BILINEAR);
        self.header.mspel = u32::from(mode != MV_MODE_1MV_HPEL_BILINEAR);
    }

    fn read_transform_type_frame(&mut self) {
        if self.stream.vstransform != 0 {
            self.header.ttmbf = self.reader.read_bit();
            self.header.ttfrm = if self.header.ttmbf != 0 { u32::from(TTFRM_TO_TT[self.reader.read_bits(2) as usize]) } else { 0 };
        } else {
            self.header.ttmbf = 1;
            self.header.ttfrm = TT_8X8;
        }
    }

    fn transform_type_index(&self) -> u32 {
        u32::from(self.header.pq > MID_QUANTIZER_LIMIT) + u32::from(self.header.pq > LOW_QUANTIZER_LIMIT)
    }

    fn low_quantizer(&self) -> usize {
        usize::from(self.header.pq <= LOW_QUANTIZER_LIMIT)
    }

    /// Parses the picture header at the reader, Simple and Main or Advanced by the profile: FFmpeg's ff_vc1_parse_frame_header and
    /// ff_vc1_parse_frame_header_adv. Ok(false) is a header FFmpeg refuses; queued lookup fills apply once the header parsed.
    pub fn parse_picture_header(&mut self) -> DecodeResult<bool> {
        self.header.lookup_queue.clear();
        let parsed: bool = if self.stream.profile == PROFILE_ADVANCED { self.parse_advanced_header()? } else { self.parse_simple_header()? };
        if !parsed {
            return Ok(false);
        }
        self.apply_queued_lookups();
        Ok(true)
    }

    /// ff_vc1_parse_frame_header
    fn parse_simple_header(&mut self) -> DecodeResult<bool> {
        self.header.field_mode = 0;
        self.header.fcm = FCM_PROGRESSIVE;
        if self.stream.finterpflag != 0 {
            self.reader.skip_bits(1);
        }
        self.reader.skip_bits(2);
        self.header.rangeredfrm = 0;
        if self.stream.rangered != 0 {
            self.header.rangeredfrm = self.reader.read_bit();
        }
        self.header.picture_type = if self.reader.read_flag() {
            TYPE_P
        } else if self.stream.max_b_frames != 0 && !self.reader.read_flag() {
            TYPE_B
        } else {
            TYPE_I
        };
        if self.header.picture_type == TYPE_B {
            if !self.read_bfraction() {
                return Ok(false);
            }
            if self.header.bfraction == 0 {
                self.header.picture_type = TYPE_BI;
            }
        }
        let intra: bool = self.header.picture_type == TYPE_I || self.header.picture_type == TYPE_BI;
        if intra {
            self.reader.skip_bits(7);
            self.stream.rnd = 1;
        }
        if self.header.picture_type == TYPE_P {
            self.stream.rnd ^= 1;
        }
        self.header.picture_rnd = self.stream.rnd;
        if self.reader.bits_left() < 5 {
            return Ok(false);
        }
        if !self.read_picture_quantizer() {
            return Ok(false);
        }
        let mut mvrange: u32 = self.stream.mvrange;
        if self.stream.extended_mv == 1 {
            mvrange = self.reader.read_unary(0, 3);
        }
        self.update_motion_vector_range(mvrange);
        if self.stream.multires != 0 && self.header.picture_type != TYPE_B {
            self.header.respic = self.reader.read_bits(2);
        }
        self.header.x8_type = 0;
        if self.stream.res_x8 != 0 && intra {
            self.header.x8_type = self.reader.read_bit();
        }
        if self.header.first_picture_header {
            self.rotate_lookups();
        }
        match self.header.picture_type {
            TYPE_P => {
                self.header.tt_index = self.transform_type_index();
                let low_quantizer: usize = self.low_quantizer();
                self.header.mv_mode = u32::from(MV_PMODE_TABLE[low_quantizer * 5 + self.reader.read_unary(1, 4) as usize]);
                if self.header.mv_mode == MV_MODE_INTENSITY_COMPENSATION {
                    self.header.mv_mode2 = u32::from(MV_PMODE_TABLE2[low_quantizer * 4 + self.reader.read_unary(1, 3) as usize]);
                    let lumscale: u32 = self.reader.read_bits(6);
                    let lumshift: u32 = self.reader.read_bits(6);
                    self.stream.lookups.last_use = 1;
                    let last_set: u32 = self.stream.lookups.last_set;
                    self.queue_lookup(last_set, 0, lumscale, lumshift, true);
                    self.queue_lookup(last_set, 1, lumscale, lumshift, true);
                    self.set_quarter_sample(self.header.mv_mode2);
                } else {
                    self.set_quarter_sample(self.header.mv_mode);
                }
                self.header.plane_mvtype = PLANE_ABSENT;
                if self.header.is_mixed_motion_vector_mode() {
                    self.decode_plane(PLANE_MVTYPE)?;
                }
                self.decode_plane(PLANE_SKIP)?;
                self.parse_simple_header_after_planes()
            }
            TYPE_B => {
                self.header.tt_index = self.transform_type_index();
                self.header.mv_mode = if self.reader.read_flag() { MV_MODE_1MV } else { MV_MODE_1MV_HPEL_BILINEAR };
                self.header.quarter_sample = u32::from(self.header.mv_mode == MV_MODE_1MV);
                self.header.mspel = self.header.quarter_sample;
                self.decode_plane(PLANE_DIRECT)?;
                self.decode_plane(PLANE_SKIP)?;
                self.parse_simple_header_after_planes()
            }
            _ => Ok(self.parse_simple_header_tail()),
        }
    }

    /// ff_vc1_parse_frame_header after the bitplanes of a P or B picture
    fn parse_simple_header_after_planes(&mut self) -> DecodeResult<bool> {
        if self.header.picture_type == TYPE_P && self.reader.bits_left() < 4 {
            return Ok(false);
        }
        self.header.mv_table_index = self.reader.read_bits(2);
        self.header.cbptab = self.reader.read_bits(2);
        if self.stream.dquant != 0 {
            self.decode_vop_dquant();
        }
        self.read_transform_type_frame();
        Ok(self.parse_simple_header_tail())
    }

    fn parse_simple_header_tail(&mut self) -> bool {
        if self.header.x8_type == 0 {
            self.header.c_ac_table_index = self.reader.read_decode012();
            if self.header.picture_type == TYPE_I || self.header.picture_type == TYPE_BI {
                self.header.y_ac_table_index = self.reader.read_decode012();
            }
            self.header.dc_table_index = self.reader.read_bit();
        }
        true
    }

    /// The pan-scan windows of an Advanced profile picture header, which FFmpeg does not parse; they are skipped as SMPTE 421M lays them out.
    fn skip_pan_scan_windows(&mut self, rptfrm: u32, rff: u32) {
        if !self.reader.read_flag() {
            return;
        }
        let pulldown: bool = self.stream.broadcast != 0;
        let windows: u32 = if self.stream.interlace == 0 || self.stream.psf != 0 {
            if pulldown { rptfrm + 1 } else { 1 }
        } else if pulldown {
            2 + rff
        } else {
            2
        };
        self.reader.skip_bits(windows * PAN_SCAN_WINDOW_BITS);
    }

    /// ff_vc1_parse_frame_header_adv: the frame or field header, or a second field's header.
    fn parse_advanced_header(&mut self) -> DecodeResult<bool> {
        self.header.numref = 0;
        self.header.picture_skipped = 0;
        if self.header.second_field != 0 {
            if self.header.fcm != FCM_FIELD || self.header.field_mode != 1 {
                return Ok(false);
            }
            self.header.picture_type = if self.header.field_picture_type & 4 != 0 {
                if self.header.field_picture_type & 1 != 0 { TYPE_BI } else { TYPE_B }
            } else if self.header.field_picture_type & 1 != 0 {
                TYPE_P
            } else {
                TYPE_I
            };
            if !self.header.picture_header_flag {
                return self.parse_advanced_common();
            }
        }
        let mut new_field_mode: u32 = 0;
        if self.stream.interlace != 0 {
            self.header.fcm = self.reader.read_decode012();
            if self.header.fcm == FCM_FIELD {
                new_field_mode = 1;
            }
        } else {
            self.header.fcm = FCM_PROGRESSIVE;
        }
        if !self.header.first_picture_header && self.header.field_mode != new_field_mode {
            return Ok(false);
        }
        self.header.field_mode = new_field_mode;
        let coded_rows: u32 = (self.stream.coded_height + 15) >> 4;
        if self.header.field_mode != 0 {
            self.stream.mb_height = (coded_rows + 1) & !1;
            self.header.field_picture_type = self.reader.read_bits(3);
            self.header.picture_type = if self.header.field_picture_type & 4 != 0 {
                if self.header.field_picture_type & 2 != 0 { TYPE_BI } else { TYPE_B }
            } else if self.header.field_picture_type & 2 != 0 {
                TYPE_P
            } else {
                TYPE_I
            };
        } else {
            self.stream.mb_height = coded_rows;
            match self.reader.read_unary(0, 4) {
                0 => self.header.picture_type = TYPE_P,
                1 => self.header.picture_type = TYPE_B,
                2 => self.header.picture_type = TYPE_I,
                3 => self.header.picture_type = TYPE_BI,
                _ => {
                    self.header.picture_type = TYPE_P;
                    self.header.picture_skipped = 1;
                }
            }
        }
        self.header.mb_height = self.stream.mb_height;
        if self.stream.tfcntrflag != 0 {
            self.reader.skip_bits(8);
        }
        let mut rptfrm: u32 = 0;
        let mut rff: u32 = 0;
        if self.stream.broadcast != 0 {
            if self.stream.interlace == 0 || self.stream.psf != 0 {
                rptfrm = self.reader.read_bits(2);
            } else {
                self.stream.tff = self.reader.read_bit();
                rff = self.reader.read_bit();
            }
        } else {
            self.stream.tff = 1;
        }
        self.header.repeat_first_field = rff;
        if self.stream.panscanflag != 0 {
            self.skip_pan_scan_windows(rptfrm, rff);
        }
        if self.header.picture_skipped != 0 {
            return Ok(true);
        }
        self.header.picture_rnd = self.reader.read_bit();
        if self.stream.interlace != 0 {
            self.reader.skip_bits(1);
        }
        if self.header.field_mode != 0 {
            if self.stream.refdist_flag == 0 {
                self.stream.refdist = 0;
            } else if self.header.picture_type != TYPE_B && self.header.picture_type != TYPE_BI {
                let mut refdist: u32 = self.reader.read_bits(2);
                if refdist == 3 {
                    refdist += self.reader.read_unary(0, 14);
                }
                if refdist > MAXIMUM_REFDIST {
                    return Ok(false);
                }
                self.stream.refdist = refdist;
            }
            if self.header.picture_type == TYPE_B || self.header.picture_type == TYPE_BI {
                if !self.read_bfraction() {
                    return Ok(false);
                }
                let refdist: i32 = self.stream.refdist as i32;
                let forward_distance: i32 = (self.header.bfraction * refdist) >> 8;
                self.header.frfd = forward_distance as u32;
                self.header.brfd = (refdist - forward_distance - 1).max(0) as u32;
            }
            return self.parse_advanced_common();
        }
        if self.header.fcm == FCM_PROGRESSIVE {
            if self.stream.finterpflag != 0 {
                self.reader.skip_bits(1);
            }
            if self.header.picture_type == TYPE_B {
                if !self.read_bfraction() {
                    return Ok(false);
                }
                if self.header.bfraction == 0 {
                    self.header.picture_type = TYPE_BI;
                }
            }
        }
        self.parse_advanced_common()
    }

    /// The part of ff_vc1_parse_frame_header_adv from parse_common_info on.
    fn parse_advanced_common(&mut self) -> DecodeResult<bool> {
        if self.header.field_mode != 0 {
            self.header.current_field_type = u32::from(self.stream.tff ^ self.header.second_field == 0);
        }
        if !self.read_picture_quantizer() {
            return Ok(false);
        }
        if self.stream.postprocflag != 0 {
            self.reader.skip_bits(2);
        }
        if self.header.first_picture_header {
            self.rotate_lookups();
        }
        match self.header.picture_type {
            TYPE_I | TYPE_BI => {
                self.header.plane_fieldtx = PLANE_ABSENT;
                if self.header.fcm == FCM_FRAME {
                    self.decode_plane(PLANE_FIELDTX)?;
                }
                self.decode_plane(PLANE_ACPRED)?;
                self.header.condover = CONDOVER_NONE;
                self.header.plane_overflags = PLANE_ABSENT;
                if self.stream.overlap != 0 && self.header.pq <= CONDOVER_PQUANT_LIMIT {
                    self.header.condover = self.reader.read_decode012();
                    if self.header.condover == CONDOVER_SELECT {
                        self.decode_plane(PLANE_OVERFLAGS)?;
                    }
                }
                Ok(self.parse_advanced_tail())
            }
            TYPE_P => self.parse_advanced_p(),
            _ => self.parse_advanced_b(),
        }
    }

    /// The P picture fields; a field picture codes no bitplane, an interlaced frame picture applies its motion vector range after its
    /// skip bitplane.
    fn parse_advanced_p(&mut self) -> DecodeResult<bool> {
        if self.header.field_mode != 0 {
            self.header.numref = self.reader.read_bit();
            if self.header.numref == 0 {
                self.header.reffield = self.reader.read_bit();
                self.header.ref_field_type_forward = self.header.reffield ^ u32::from(self.header.current_field_type == 0);
            }
        }
        let mut mvrange: u32 = 0;
        if self.stream.extended_mv != 0 {
            mvrange = self.reader.read_unary(0, 3);
        }
        if self.stream.interlace != 0 {
            let mut dmvrange: u32 = 0;
            if self.stream.extended_dmv != 0 {
                dmvrange = self.reader.read_unary(0, 3);
            }
            self.stream.dmvrange = dmvrange;
            if self.header.fcm == FCM_FRAME {
                self.header.fourmvswitch = self.reader.read_bit();
                self.header.intcomp = self.reader.read_bit();
                if self.header.intcomp != 0 {
                    let lumscale: u32 = self.reader.read_bits(6);
                    let lumshift: u32 = self.reader.read_bits(6);
                    let last_set: u32 = self.stream.lookups.last_set;
                    self.queue_lookup(last_set, 0, lumscale, lumshift, true);
                    self.queue_lookup(last_set, 1, lumscale, lumshift, true);
                    self.stream.lookups.last_use = 1;
                }
                self.header.pending_motion_vector_range = mvrange;
                self.decode_plane(PLANE_SKIP)?;
                self.header.mbmodetab = self.reader.read_bits(2);
                self.header.imvtab = self.reader.read_bits(2);
                self.header.icbptab = self.reader.read_bits(3);
                self.header.twomvbptab = self.reader.read_bits(2);
                if self.header.fourmvswitch != 0 {
                    self.header.fourmvbptab = self.reader.read_bits(2);
                }
                self.update_motion_vector_range(self.header.pending_motion_vector_range);
                self.header.tt_index = self.transform_type_index();
                self.header.quarter_sample = 1;
                self.header.mspel = 1;
                return Ok(self.parse_advanced_predicted_tail());
            }
        }
        self.update_motion_vector_range(mvrange);
        self.header.tt_index = self.transform_type_index();
        let mvmode: usize = self.reader.read_unary(1, 4) as usize;
        let low_quantizer: usize = self.low_quantizer();
        self.header.mv_mode = u32::from(MV_PMODE_TABLE[low_quantizer * 5 + mvmode]);
        if self.header.mv_mode == MV_MODE_INTENSITY_COMPENSATION {
            self.header.mv_mode2 = u32::from(MV_PMODE_TABLE2[low_quantizer * 4 + self.reader.read_unary(1, 3) as usize]);
            let mut intcompfield: u32 = 3;
            if self.header.field_mode != 0 {
                intcompfield = self.reader.read_decode210() ^ 3;
            }
            let mut lumscale: u32 = IDENTITY_LUMSCALE;
            let mut lumshift: u32 = IDENTITY_LUMSHIFT;
            let mut lumscale2: u32 = IDENTITY_LUMSCALE;
            let mut lumshift2: u32 = IDENTITY_LUMSHIFT;
            if intcompfield & 1 != 0 {
                lumscale = self.reader.read_bits(6);
                lumshift = self.reader.read_bits(6);
            }
            if intcompfield & 2 != 0 && self.header.field_mode != 0 {
                lumscale2 = self.reader.read_bits(6);
                lumshift2 = self.reader.read_bits(6);
            } else if self.header.field_mode == 0 {
                lumscale2 = lumscale;
                lumshift2 = lumshift;
            }
            let last_set: u32 = self.stream.lookups.last_set;
            if self.header.field_mode != 0 && self.header.second_field != 0 {
                let current_field: u32 = self.header.current_field_type;
                let opposite: u32 = current_field ^ 1;
                let current_set: u32 = self.header.current_lookup_set;
                if current_field != 0 {
                    self.queue_lookup(current_set, opposite, lumscale, lumshift, false);
                    self.queue_lookup(last_set, current_field, lumscale2, lumshift2, true);
                } else {
                    self.queue_lookup(current_set, opposite, lumscale2, lumshift2, false);
                    self.queue_lookup(last_set, current_field, lumscale, lumshift, true);
                }
                self.stream.lookups.next_use = 1;
                let field: CurrentUseField = self.header.current_use_field;
                self.stream.lookups.set_use_flag(field, 1);
            } else {
                self.queue_lookup(last_set, 0, lumscale, lumshift, true);
                self.queue_lookup(last_set, 1, lumscale2, lumshift2, true);
            }
            self.stream.lookups.last_use = 1;
            self.set_quarter_sample(self.header.mv_mode2);
        } else {
            self.set_quarter_sample(self.header.mv_mode);
        }
        if self.header.fcm == FCM_PROGRESSIVE {
            self.header.plane_mvtype = PLANE_ABSENT;
            if self.header.is_mixed_motion_vector_mode() {
                self.decode_plane(PLANE_MVTYPE)?;
            }
            self.decode_plane(PLANE_SKIP)?;
            self.header.mv_table_index = self.reader.read_bits(2);
            self.header.cbptab = self.reader.read_bits(2);
            return Ok(self.parse_advanced_predicted_tail());
        }
        self.header.mbmodetab = self.reader.read_bits(3);
        self.header.imvtab = self.reader.read_bits(2 + self.header.numref);
        self.header.icbptab = self.reader.read_bits(3);
        if self.header.is_mixed_motion_vector_mode() {
            self.header.fourmvbptab = self.reader.read_bits(2);
        }
        Ok(self.parse_advanced_predicted_tail())
    }

    /// The B picture fields.
    fn parse_advanced_b(&mut self) -> DecodeResult<bool> {
        if self.header.fcm == FCM_FRAME {
            if !self.read_bfraction() {
                return Ok(false);
            }
            if self.header.bfraction == 0 {
                return Ok(false);
            }
        }
        let mut mvrange: u32 = 0;
        if self.stream.extended_mv != 0 {
            mvrange = self.reader.read_unary(0, 3);
        }
        self.update_motion_vector_range(mvrange);
        self.header.tt_index = self.transform_type_index();
        if self.header.field_mode != 0 {
            // FFmpeg leaves DMVRANGE as it was when the picture does not code it
            if self.stream.extended_dmv != 0 {
                self.stream.dmvrange = self.reader.read_unary(0, 3);
            }
            let mvmode: usize = self.reader.read_unary(1, 3) as usize;
            let low_quantizer: usize = self.low_quantizer();
            self.header.mv_mode = u32::from(MV_PMODE_TABLE2[low_quantizer * 4 + mvmode]);
            self.header.quarter_sample = u32::from(self.header.mv_mode == MV_MODE_1MV || self.header.mv_mode == MV_MODE_MIXED_MV);
            self.header.mspel = u32::from(self.header.mv_mode != MV_MODE_1MV_HPEL_BILINEAR);
            self.decode_plane(PLANE_FORWARD)?;
            self.header.mbmodetab = self.reader.read_bits(3);
            self.header.imvtab = self.reader.read_bits(3);
            self.header.icbptab = self.reader.read_bits(3);
            if self.header.mv_mode == MV_MODE_MIXED_MV {
                self.header.fourmvbptab = self.reader.read_bits(2);
            }
            self.header.numref = 1;
            return Ok(self.parse_advanced_predicted_tail());
        }
        if self.header.fcm == FCM_FRAME {
            if self.stream.extended_dmv != 0 {
                self.stream.dmvrange = self.reader.read_unary(0, 3);
            }
            self.reader.skip_bits(1);
            self.header.intcomp = 0;
            self.header.mv_mode = MV_MODE_1MV;
            self.header.fourmvswitch = 0;
            self.header.quarter_sample = 1;
            self.header.mspel = 1;
            self.decode_plane(PLANE_DIRECT)?;
            self.decode_plane(PLANE_SKIP)?;
            self.header.mbmodetab = self.reader.read_bits(2);
            self.header.imvtab = self.reader.read_bits(2);
            self.header.icbptab = self.reader.read_bits(3);
            self.header.twomvbptab = self.reader.read_bits(2);
            self.header.fourmvbptab = self.reader.read_bits(2);
            return Ok(self.parse_advanced_predicted_tail());
        }
        self.header.mv_mode = if self.reader.read_flag() { MV_MODE_1MV } else { MV_MODE_1MV_HPEL_BILINEAR };
        self.header.quarter_sample = u32::from(self.header.mv_mode == MV_MODE_1MV);
        self.header.mspel = self.header.quarter_sample;
        self.decode_plane(PLANE_DIRECT)?;
        self.decode_plane(PLANE_SKIP)?;
        self.header.mv_table_index = self.reader.read_bits(2);
        self.header.cbptab = self.reader.read_bits(2);
        Ok(self.parse_advanced_predicted_tail())
    }

    /// The end of a P or B picture's own fields: VOPDQUANT and the frame transform type, then the common tail.
    fn parse_advanced_predicted_tail(&mut self) -> bool {
        if self.stream.dquant != 0 {
            self.decode_vop_dquant();
        }
        self.read_transform_type_frame();
        self.parse_advanced_tail()
    }

    /// The end of ff_vc1_parse_frame_header_adv: the AC and DC table indices, and an I picture's VOPDQUANT.
    fn parse_advanced_tail(&mut self) -> bool {
        self.header.c_ac_table_index = self.reader.read_decode012();
        let intra: bool = self.header.picture_type == TYPE_I || self.header.picture_type == TYPE_BI;
        if intra {
            self.header.y_ac_table_index = self.reader.read_decode012();
        } else if self.header.fcm != FCM_PROGRESSIVE && self.header.quarter_sample == 0 {
            self.header.range_x <<= 1;
            self.header.range_y <<= 1;
        }
        self.header.dc_table_index = self.reader.read_bit();
        if intra && self.stream.dquant != 0 {
            self.decode_vop_dquant();
        }
        true
    }
}

/// Reads one header of the codec private data or of a packet with a reader of its own.
fn parse_sequence_header(stream: &mut StreamState, reader: &mut BitReader) -> DecodeResult<bool> {
    let profile: u32 = reader.read_bits(2);
    stream.profile = profile;
    if profile == PROFILE_ADVANCED {
        return parse_advanced_sequence_header(stream, reader);
    }
    let res_y411: u32 = reader.read_bit();
    stream.res_sprite = reader.read_bit();
    if res_y411 != 0 {
        return fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_Y411);
    }
    reader.skip_bits(3 + 5);
    stream.loop_filter = reader.read_bit();
    stream.res_x8 = reader.read_bit();
    stream.multires = reader.read_bit();
    stream.res_fasttx = reader.read_bit();
    stream.fastuvmc = reader.read_bit();
    if profile == PROFILE_SIMPLE && stream.fastuvmc == 0 {
        return Ok(false);
    }
    stream.extended_mv = reader.read_bit();
    if profile == PROFILE_SIMPLE && stream.extended_mv != 0 {
        return Ok(false);
    }
    stream.dquant = reader.read_bits(2);
    stream.vstransform = reader.read_bit();
    if reader.read_flag() {
        return Ok(false);
    }
    stream.overlap = reader.read_bit();
    reader.skip_bits(1);
    stream.rangered = reader.read_bit();
    stream.max_b_frames = reader.read_bits(3);
    stream.quantizer_mode = reader.read_bits(2);
    stream.finterpflag = reader.read_bit();
    if stream.res_sprite != 0 {
        return fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_SPRITES);
    }
    stream.res_rtm_flag = reader.read_bit();
    stream.sequence_valid = true;
    Ok(true)
}

fn parse_advanced_sequence_header(stream: &mut StreamState, reader: &mut BitReader) -> DecodeResult<bool> {
    // Advanced profile B pictures follow up to seven anchors' worth of reordering, as FFmpeg sets max_b_frames
    const ADVANCED_MAX_B_FRAMES: u32 = 7;
    stream.res_rtm_flag = 1;
    reader.skip_bits(3);
    let chroma_format: u32 = reader.read_bits(2);
    if chroma_format != CHROMA_FORMAT_420 {
        return fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_CHROMA_FORMAT);
    }
    reader.skip_bits(3 + 5);
    stream.postprocflag = reader.read_bit();
    stream.max_coded_width = (reader.read_bits(12) + 1) << 1;
    stream.max_coded_height = (reader.read_bits(12) + 1) << 1;
    stream.broadcast = reader.read_bit();
    stream.interlace = reader.read_bit();
    stream.tfcntrflag = reader.read_bit();
    stream.finterpflag = reader.read_bit();
    reader.skip_bits(1);
    stream.psf = reader.read_bit();
    stream.max_b_frames = ADVANCED_MAX_B_FRAMES;
    if reader.read_flag() {
        reader.skip_bits(14 + 14);
        let mut aspect_ratio: u32 = 0;
        if reader.read_flag() {
            aspect_ratio = reader.read_bits(4);
        }
        if aspect_ratio == 15 {
            reader.skip_bits(8 + 8);
        }
        if reader.read_flag() {
            if reader.read_flag() {
                reader.skip_bits(16);
            } else {
                reader.skip_bits(8 + 4);
            }
        }
        if reader.read_flag() {
            reader.skip_bits(8 + 8 + 8);
        }
    }
    stream.hrd_param_flag = reader.read_bit();
    if stream.hrd_param_flag != 0 {
        let buckets: u32 = reader.read_bits(5);
        stream.hrd_leaky_buckets = buckets;
        reader.skip_bits(4 + 4);
        for _ in 0..buckets {
            reader.skip_bits(16 + 16);
        }
    }
    stream.sequence_valid = true;
    Ok(true)
}

/// FFmpeg's ff_vc1_decode_entry_point
pub fn parse_entry_point(stream: &mut StreamState, reader: &mut BitReader) {
    reader.skip_bits(2);
    stream.panscanflag = reader.read_bit();
    stream.refdist_flag = reader.read_bit();
    stream.loop_filter = reader.read_bit();
    stream.fastuvmc = reader.read_bit();
    stream.extended_mv = reader.read_bit();
    stream.dquant = reader.read_bits(2);
    stream.vstransform = reader.read_bit();
    stream.overlap = reader.read_bit();
    stream.quantizer_mode = reader.read_bits(2);
    if stream.hrd_param_flag != 0 {
        reader.skip_bits(8 * stream.hrd_leaky_buckets);
    }
    if reader.read_flag() {
        stream.coded_width = (reader.read_bits(12) + 1) << 1;
        stream.coded_height = (reader.read_bits(12) + 1) << 1;
    } else {
        stream.coded_width = stream.max_coded_width;
        stream.coded_height = stream.max_coded_height;
    }
    if stream.extended_mv != 0 {
        stream.extended_dmv = reader.read_bit();
    }
    if reader.read_flag() {
        reader.skip_bits(3);
    }
    if reader.read_flag() {
        reader.skip_bits(3);
    }
    stream.entry_point_valid = true;
}

/// The frame's macroblock geometry from the coded size; a field picture's frame rounds its rows up to an even count.
pub fn update_geometry(stream: &mut StreamState) -> DecodeResult<()> {
    if stream.coded_width == 0 || stream.coded_height == 0 {
        return fail(ERROR_PICTURE_SIZE, 0);
    }
    let width: u32 = stream.coded_width.div_ceil(MACROBLOCK_SIZE);
    let height: u32 = stream.coded_height.div_ceil(MACROBLOCK_SIZE);
    let aligned_height: u32 = (height + 1) & !1;
    // A Video for Windows header may declare any size, so the product is taken wide
    if u64::from(width) * u64::from(aligned_height) > u64::from(MAXIMUM_MACROBLOCKS) {
        return fail(ERROR_PICTURE_SIZE, (width << 12) | aligned_height);
    }
    stream.mb_width = width;
    if stream.mb_height != aligned_height {
        stream.mb_height = height;
    }
    Ok(())
}

fn read_little_endian_word(bytes: &[u8], position: usize) -> u32 {
    u32::from_le_bytes([bytes[position], bytes[position + 1], bytes[position + 2], bytes[position + 3]])
}

/// Parses the codec private data: a Video for Windows header and its extradata, or bare VC-1 extradata, into a fresh stream state.
/// WMV3 extradata is the Simple and Main profile sequence header, which sizes no frame, so it comes behind the header that carries the
/// container's frame size, as FFmpeg takes it from the container; VC-1 extradata carries a sequence header and an entry point after start codes.
pub fn configure(stream: &mut StreamState, codec_private: &[u8]) -> DecodeResult<()> {
    *stream = StreamState::default();
    stream.lookups.last_set = 0;
    stream.lookups.next_set = 1;
    let length: usize = codec_private.len();
    let mut extradata_start: usize = 0;
    let mut fourcc: u32 = 0;
    let mut coded_width: u32 = 0;
    let mut coded_height: u32 = 0;
    if length >= BITMAP_INFO_HEADER_SIZE {
        let header_size: u32 = read_little_endian_word(codec_private, 0);
        let candidate: u32 = read_little_endian_word(codec_private, BITMAP_INFO_FOURCC_OFFSET);
        let video_for_windows: bool = header_size as usize >= BITMAP_INFO_HEADER_SIZE;
        if video_for_windows && (candidate == FOURCC_WMV3 || candidate == FOURCC_WMVA || candidate == FOURCC_WVC1) {
            // The extradata follows the 40-byte header whatever biSize says, as Matroska's V_MS/VFW/FOURCC and FFmpeg read it
            fourcc = candidate;
            extradata_start = BITMAP_INFO_HEADER_SIZE;
            coded_width = read_little_endian_word(codec_private, BITMAP_INFO_WIDTH_OFFSET);
            coded_height = (read_little_endian_word(codec_private, BITMAP_INFO_HEIGHT_OFFSET) as i32).unsigned_abs();
        } else if video_for_windows && (candidate == FOURCC_WMVP || candidate == FOURCC_WVP2) {
            return fail(ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_SPRITES);
        }
    }
    let first_marker: usize = find_start_code(codec_private, extradata_start);
    if fourcc == 0 && first_marker == length {
        // Extradata without start codes is a Simple or Main profile sequence header, or too short to be one
        // NOTE: Without the header only the pool's padded size is known, and a decode at it reads macroblock rows the frame does not have
        let value: u32 = if length >= STRUCT_C_SIZE { CONFIGURATION_FRAME_SIZE_MISSING } else { length as u32 };
        return fail(ERROR_CONFIGURATION, value);
    }
    if fourcc == FOURCC_WMV3 {
        // The Simple and Main profile sequence header is the extradata itself
        if length < extradata_start + STRUCT_C_SIZE {
            return fail(ERROR_CONFIGURATION, length as u32);
        }
        let mut reader: BitReader = BitReader::new(&codec_private[extradata_start..], 0, (length - extradata_start) * 8);
        if !parse_sequence_header(stream, &mut reader)? {
            return fail(ERROR_SEQUENCE_HEADER, SEQUENCE_HEADER_STRUCT_C_REFUSED);
        }
        if stream.profile == PROFILE_ADVANCED {
            return fail(ERROR_SEQUENCE_HEADER, SEQUENCE_HEADER_STRUCT_C_ADVANCED);
        }
        stream.coded_width = coded_width;
        stream.coded_height = coded_height;
        stream.entry_point_valid = true;
    } else {
        // VC-1 extradata: every sequence header and entry point between start codes; the first byte may be a size byte
        if length - extradata_start < MINIMUM_ADVANCED_EXTRADATA_SIZE {
            return fail(ERROR_CONFIGURATION, length as u32);
        }
        let mut start: usize = first_marker;
        let mut segment: Vec<u8> = Vec::new();
        while start < length {
            let next: usize = find_start_code(codec_private, start + START_CODE_LENGTH);
            if next > start + START_CODE_LENGTH {
                let marker_type: u8 = codec_private[start + 3];
                segment.clear();
                let segment_length: usize = append_unescaped(&codec_private[start + START_CODE_LENGTH..next], &mut segment);
                let mut reader: BitReader = BitReader::new(&segment, 0, segment_length * 8);
                match marker_type {
                    MARKER_SEQUENCE_HEADER => {
                        if !parse_sequence_header(stream, &mut reader)? {
                            return fail(ERROR_SEQUENCE_HEADER, SEQUENCE_HEADER_EXTRADATA_REFUSED);
                        }
                    }
                    MARKER_ENTRY_POINT => parse_entry_point(stream, &mut reader),
                    _ => {}
                }
            }
            start = next;
        }
        if !stream.sequence_valid {
            return fail(ERROR_CONFIGURATION, CONFIGURATION_SEQUENCE_MISSING);
        }
        if !stream.entry_point_valid {
            return fail(ERROR_CONFIGURATION, CONFIGURATION_ENTRY_POINT_MISSING);
        }
    }
    update_geometry(stream)?;
    stream.configured = true;
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::error::DecodeError;
    use crate::layout::PROFILE_MAIN;

    // SMM0005's STRUCT_C, a Main profile sequence of 720x480 frames
    pub const MAIN_STRUCT_C: [u8; 4] = [0x4d, 0xf1, 0x0a, 0x11];
    pub const MAIN_WIDTH: u32 = 720;
    pub const MAIN_HEIGHT: u32 = 480;
    const MAIN_MB_WIDTH: u32 = 45;
    const MAIN_MB_HEIGHT: u32 = 30;
    // The package vector's extradata: a size byte, then an Advanced profile sequence header of 1920x1080 frames and an entry point
    const ADVANCED_EXTRADATA: [u8; 31] = [
        0x27, 0x00, 0x00, 0x01, 0x0f, 0xdb, 0x7e, 0x3b, 0xf2, 0x1b, 0x8a, 0x3b, 0xf8, 0x86, 0xe8, 0x04, 0x50, 0x93, 0x5b, 0x8d, 0x44, 0xa9,
        0xc0, 0x00, 0x00, 0x01, 0x0e, 0x1a, 0x47, 0xf8, 0x40,
    ];
    const ADVANCED_WIDTH: u32 = 1920;
    const ADVANCED_HEIGHT: u32 = 1080;
    const SPRITE_FOURCC: &[u8; 4] = b"WMVP";
    const WMV3_FOURCC: &[u8; 4] = b"WMV3";
    const SHORT_EXTRADATA_LENGTH: usize = 3;
    // A frame of more macroblocks than a record holds
    const OVERSIZED_SIDE: u32 = 8192;

    /// A Video for Windows header of a frame size and FourCC, followed by extradata.
    pub fn create_video_for_windows(width: u32, height: u32, fourcc: &[u8; 4], extradata: &[u8]) -> Vec<u8> {
        let mut bytes: Vec<u8> = vec![0; BITMAP_INFO_HEADER_SIZE];
        bytes[..4].copy_from_slice(&((BITMAP_INFO_HEADER_SIZE + extradata.len()) as u32).to_le_bytes());
        bytes[BITMAP_INFO_WIDTH_OFFSET..BITMAP_INFO_WIDTH_OFFSET + 4].copy_from_slice(&width.to_le_bytes());
        bytes[BITMAP_INFO_HEIGHT_OFFSET..BITMAP_INFO_HEIGHT_OFFSET + 4].copy_from_slice(&height.to_le_bytes());
        bytes[BITMAP_INFO_FOURCC_OFFSET..BITMAP_INFO_FOURCC_OFFSET + 4].copy_from_slice(fourcc);
        bytes.extend_from_slice(extradata);
        bytes
    }

    fn configure_failure(codec_private: &[u8]) -> (u32, u32) {
        let mut stream: StreamState = StreamState::default();
        let failure: DecodeError = configure(&mut stream, codec_private).expect_err("the configuration fails");
        (failure.code, failure.value)
    }

    #[test]
    fn takes_a_wmv3_sequence_header_with_the_frame_size_of_its_video_for_windows_header() {
        let mut stream: StreamState = StreamState::default();
        configure(&mut stream, &create_video_for_windows(MAIN_WIDTH, MAIN_HEIGHT, WMV3_FOURCC, &MAIN_STRUCT_C)).expect("the configuration succeeds");

        assert!(stream.configured);
        assert_eq!(stream.profile, PROFILE_MAIN);
        assert_eq!((stream.coded_width, stream.coded_height), (MAIN_WIDTH, MAIN_HEIGHT));
        assert_eq!((stream.mb_width, stream.mb_height), (MAIN_MB_WIDTH, MAIN_MB_HEIGHT));
    }

    #[test]
    fn takes_vc1_extradata_after_its_size_byte() {
        let mut stream: StreamState = StreamState::default();
        configure(&mut stream, &ADVANCED_EXTRADATA).expect("the configuration succeeds");

        assert_eq!(stream.profile, PROFILE_ADVANCED);
        assert_eq!((stream.max_coded_width, stream.max_coded_height), (ADVANCED_WIDTH, ADVANCED_HEIGHT));
        assert_eq!((stream.coded_width, stream.coded_height), (ADVANCED_WIDTH, ADVANCED_HEIGHT));
    }

    #[test]
    fn refuses_codec_private_data_it_cannot_size_or_decode_with_the_failing_value() {
        assert_eq!(configure_failure(&MAIN_STRUCT_C), (ERROR_CONFIGURATION, CONFIGURATION_FRAME_SIZE_MISSING));
        assert_eq!(configure_failure(&MAIN_STRUCT_C[..SHORT_EXTRADATA_LENGTH]), (ERROR_CONFIGURATION, SHORT_EXTRADATA_LENGTH as u32));
        assert_eq!(configure_failure(&create_video_for_windows(MAIN_WIDTH, MAIN_HEIGHT, SPRITE_FOURCC, &MAIN_STRUCT_C)), (ERROR_UNSUPPORTED_FEATURE, UNSUPPORTED_SPRITES));
        let oversized: (u32, u32) = configure_failure(&create_video_for_windows(OVERSIZED_SIDE, OVERSIZED_SIDE, WMV3_FOURCC, &MAIN_STRUCT_C));
        assert_eq!(oversized.0, ERROR_PICTURE_SIZE);
        let unbounded: (u32, u32) = configure_failure(&create_video_for_windows(u32::MAX, u32::MAX, WMV3_FOURCC, &MAIN_STRUCT_C));
        assert_eq!(unbounded.0, ERROR_PICTURE_SIZE);
    }
}
