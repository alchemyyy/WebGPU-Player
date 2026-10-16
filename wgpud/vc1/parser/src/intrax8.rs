// IntraX8 pictures, the J-frame intra coding of WMV3 I pictures, as FFmpeg's intrax8.c and intrax8dsp.c decode them and the all-WGSL
// decoder mirrored them. Its bitstream depends on reconstructed samples: a block's orientation code is read only when the edge samples
// its neighbors left, after their in-loop filtering, span a wide enough range. So the parser decodes the whole picture block by block in
// raster order, predicting, transforming, and filtering each block, and the record carries the picture's samples.

use crate::bitstream::BitReader;
use crate::intrax8_tables::{
    X8_AC_DECODE, X8_DC_INDEX_OFFSET, X8_MIXED_RUN_LEVEL, X8_PREDICTION_ORIENTATIONS, X8_QUANT_MATRIX, X8_SCANS, X8_ZERO_PREDICTION_WEIGHTS,
};
use crate::vlc::{INVALID_SYMBOL, Lookups, VLCLookup, lookups};

// The spatial predictor's edge samples, setup_spatial_compensation's areas: 1 and 2 the two columns left of the block bottom up, 3 the
// top-left corner, 4 and 5 the row above this block and the next, 6 the row above that
const AREA1: usize = 0;
const AREA2: usize = 8;
const AREA3: usize = 16;
const AREA4: usize = 17;
const AREA5: usize = 25;
const AREA6: usize = 33;
const EDGE_SAMPLES: usize = 41;
// The block's samples and the five rows and columns before it the loop filter reaches: 13 x 13 from (-5, -5)
const WINDOW_SIZE: i32 = 13;
const WINDOW_ORIGIN: i32 = 5;
const WINDOW_SAMPLES: usize = (WINDOW_SIZE * WINDOW_SIZE) as usize;
// Rows the top edge filter changes above the block, and columns the left edge filter changes left of it
const FILTERED_ROWS_ABOVE: i32 = 2;
const FILTERED_COLUMNS_LEFT: i32 = 2;
const BLOCK_SIZE: usize = 8;
const COEFFICIENT_COUNT: usize = 64;
const SAMPLE_MAXIMUM: i32 = 255;
const MID_SAMPLE: u32 = 0x80;
// The picture quantizer below which IntraX8 reads its low quantizer tables
const LOW_QUANTIZER_LIMIT: i32 = 13;
// AC modes and their tables, DC modes
const AC_MODE_COUNT: usize = 4;
const DC_MODE_COUNT: usize = 3;
const AC_TABLES_PER_GROUP: usize = 8;
const DC_LOW_QUANTIZER_TABLES: usize = 8;
const ORIENT_LOW_QUANTIZER_TABLES: usize = 2;
const ORIENTATION_COUNT: u32 = 12;
// The AC symbol ranges: run-level pairs, decoded pairs, mixed escapes, and full escapes
const AC_PAIR_SYMBOLS: u32 = 46;
const AC_PAIR_FINAL_START: u32 = 23;
const AC_DECODED_SYMBOLS: u32 = 73;
const AC_DECODED_FINAL_START: u32 = 13;
const AC_MIXED_SYMBOLS: u32 = 75;
// The DC symbols that end a block, after the first 17
const DC_FINAL_START: i32 = 17;
// The highest estimated run, and the AC mode a block switches to once its run reaches it
const ESTIMATED_RUN_EDGE: u32 = 16;
const SWITCH_AC_MODE: usize = 3;
const BLOCK_RUN_LIMIT: u32 = 64;
// Orientations that predict from the top or the left edge alone
const ORIENTATION_TOP: u32 = 4;
const ORIENTATION_LEFT: u32 = 8;
// The flat DC's estimate from the edge sum: (sum + 9) * 6899 >> 17
const FLAT_DC_ROUNDING: i32 = 9;
const FLAT_DC_MULTIPLIER: i32 = 6899;
const FLAT_DC_SHIFT: u32 = 17;
const FLAT_RANGE_LIMIT: i32 = 3;
// The packed lookups of FFmpeg's x8 code, two bits per entry
const PREDICTION_INDEX_TABLE: u32 = 0xFFEA_F4C4;
const PREDICTION_FALLBACK_TABLE: u32 = 0x00FF_EAD8;
const CHROMA_ORIENTATION_TABLE: u32 = 0xCC;
const SCAN_SELECTION_TABLE: u32 = 0x0092_8548;
const COMPENSATION_DIRECTION_TABLE: u32 = 0x006A_017C;
const AC_LEVEL_TABLE: u32 = 0x00E5_0000;
const AC_RUN_MASK_TABLE: u32 = 0x0001_030F;
// The orientation the edges allow alone: a block at the left edge predicts from the top, at the top edge from the left
const EDGE_LEFT: u32 = 1;
const EDGE_TOP: u32 = 2;
const EDGE_RIGHT: u32 = 4;

/// How a parsed block places its samples: a solid value, or a prediction by orientation, flat when the edges are.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Placement {
    Solid,
    Predicted,
}

/// What a block's parse hands its reconstruction.
#[derive(Clone, Copy)]
struct ParsedBlock {
    placement: Placement,
    solid: u32,
    orientation: u32,
    flat: bool,
    transform: bool,
    /// Bit 0 filters the top edge, bit 1 the left edge
    filter_edges: u32,
}

/// A decoded IntraX8 picture: three planes of samples, luma then Cb and Cr, each width x height.
pub struct IntraX8Picture {
    pub planes: [Vec<u8>; 3],
    pub widths: [usize; 3],
}

impl IntraX8Picture {
    fn new(mb_width: u32, mb_height: u32) -> Self {
        let luma_width: usize = mb_width as usize * 16;
        let luma_height: usize = mb_height as usize * 16;
        let chroma_width: usize = luma_width / 2;
        let chroma_height: usize = luma_height / 2;
        Self {
            planes: [vec![0; luma_width * luma_height], vec![0; chroma_width * chroma_height], vec![0; chroma_width * chroma_height]],
            widths: [luma_width, chroma_width, chroma_width],
        }
    }

    fn sample(&self, plane: usize, x: i32, y: i32) -> u32 {
        u32::from(self.planes[plane][y as usize * self.widths[plane] + x as usize])
    }

    fn set_sample(&mut self, plane: usize, x: i32, y: i32, value: i32) {
        let width: usize = self.widths[plane];
        self.planes[plane][y as usize * width + x as usize] = value.clamp(0, SAMPLE_MAXIMUM) as u8;
    }
}

/// The picture's quantizers and the tables it chose, and the block being decoded: FFmpeg's IntraX8Context.
struct IntraX8Decoder<'stream> {
    reader: BitReader<'stream>,
    lookups: &'static Lookups,
    picture: IntraX8Picture,
    mb_width: u32,
    quant: i32,
    dquant: i32,
    qsum: i32,
    quant_dc_chroma: i32,
    divide_quant_dc_luma: i32,
    divide_quant_dc_chroma: i32,
    use_quant_matrix: bool,
    loop_filter: bool,
    ac_tables: [Option<&'static VLCLookup>; AC_MODE_COUNT],
    dc_tables: [Option<&'static VLCLookup>; DC_MODE_COUNT],
    orient_table: Option<&'static VLCLookup>,
    // FFmpeg's mb_x and mb_y count 8x8 blocks
    column: u32,
    row: u32,
    edges: u32,
    orient: u32,
    raw_orient: u32,
    estimated_run: u32,
    chroma_orient: u32,
    flat_dc: bool,
    predicted_dc: i32,
    /// FFmpeg's prediction_table: per block column, the estimated run and orientation class of the two last block rows
    predictions: Vec<u32>,
    coefficients: [i32; COEFFICIENT_COUNT],
    edge_samples: [u32; EDGE_SAMPLES + 7],
    window: [i32; WINDOW_SAMPLES],
}

/// Sign-extends the low 16 bits, as FFmpeg's int16_t blocks keep values.
fn wrap_int16(value: i32) -> i32 {
    (value << 16) >> 16
}

fn window_index(x: i32, y: i32) -> usize {
    ((y + WINDOW_ORIGIN) * WINDOW_SIZE + x + WINDOW_ORIGIN) as usize
}

/// The rounded product of the WMV2 transform's sqrt(2)/2 factor, in 32-bit wrapping arithmetic as FFmpeg's ints overflow
fn scale_by_half_square_root(value: i32) -> i32 {
    (181u32.wrapping_mul(value as u32).wrapping_add(128) as i32) >> 8
}

impl<'stream> IntraX8Decoder<'stream> {
    /// x8_get_prediction: the estimated run and orientation class of a luma block from its neighbors' prediction entries
    fn get_prediction(&mut self) {
        self.edges = (if self.column == 0 { EDGE_LEFT } else { 0 })
            | (if self.row == 0 { EDGE_TOP } else { 0 })
            | (if self.column >= 2 * self.mb_width - 1 { EDGE_RIGHT } else { 0 });
        let odd: u32 = self.row & 1;
        let column: usize = self.column as usize;
        match self.edges & (EDGE_LEFT | EDGE_TOP) {
            EDGE_LEFT => {
                self.estimated_run = self.predictions[(1 - odd) as usize] >> 2;
                self.orient = 1;
                return;
            }
            EDGE_TOP => {
                self.estimated_run = self.predictions[2 * column - 2] >> 2;
                self.orient = 2;
                return;
            }
            3 => {
                self.estimated_run = ESTIMATED_RUN_EDGE;
                self.orient = 0;
                return;
            }
            _ => {}
        }
        let mut b: u32 = self.predictions[2 * column + 1 - odd as usize];
        let mut a: u32 = self.predictions[2 * column - 2 + odd as usize];
        let mut c: u32 = self.predictions[2 * column - 2 + 1 - odd as usize];
        self.estimated_run = b.min(a);
        // FFmpeg's condition, which tests the block position rather than the edges
        if self.column & self.row != 0 {
            self.estimated_run = c.min(self.estimated_run);
        }
        self.estimated_run >>= 2;
        a &= 3;
        b &= 3;
        c &= 3;
        let index: u32 = (PREDICTION_INDEX_TABLE >> (2 * b + 8 * a)) & 3;
        if index != 3 {
            self.orient = index;
        } else {
            let quantizer_offset: u32 = if self.quant > 12 { 8 } else { 0 };
            self.orient = (PREDICTION_FALLBACK_TABLE >> (2 * c + quantizer_offset)) & 3;
        }
    }

    /// x8_get_prediction_chroma: the chroma orientation of the macroblock from its left neighbor's entry
    fn get_prediction_chroma(&mut self) {
        self.edges = (if self.column >> 1 == 0 { EDGE_LEFT } else { 0 })
            | (if self.row >> 1 == 0 { EDGE_TOP } else { 0 })
            | (if self.column >= 2 * self.mb_width - 1 { EDGE_RIGHT } else { 0 });
        self.raw_orient = 0;
        if self.edges & (EDGE_LEFT | EDGE_TOP) != 0 {
            self.chroma_orient = 4 << ((CHROMA_ORIENTATION_TABLE >> self.edges) & 1);
            return;
        }
        self.chroma_orient = (self.predictions[2 * self.column as usize - 2] & 3) << 2;
    }

    /// The sample position of a block of a plane: luma blocks by 8x8 block, chroma blocks by macroblock
    fn block_origin(&self, plane: usize) -> (i32, i32) {
        if plane == 0 {
            return (self.column as i32 * 8, self.row as i32 * 8);
        }
        ((self.column >> 1) as i32 * 8, (self.row >> 1) as i32 * 8)
    }

    /// x8_setup_spatial_compensation: gathers the edge samples of a block; returns their range and the sum a flat DC is predicted from
    fn setup_spatial_compensation(&mut self, plane: usize) -> (i32, i32) {
        if self.edges & 3 == 3 {
            self.edge_samples[..EDGE_SAMPLES].fill(MID_SAMPLE);
            return (0, MID_SAMPLE as i32 * (8 + 1 + 8 + 2));
        }
        let (origin_x, origin_y): (i32, i32) = self.block_origin(plane);
        let mut minimum: i32 = 256;
        let mut maximum: i32 = -1;
        let mut sum: i32 = 0;
        if self.edges & EDGE_LEFT == 0 {
            for index in 0..BLOCK_SIZE {
                let y: i32 = origin_y + 7 - index as i32;
                self.edge_samples[AREA1 + index] = self.picture.sample(plane, origin_x - 2, y);
                let sample: i32 = self.picture.sample(plane, origin_x - 1, y) as i32;
                sum += sample;
                minimum = minimum.min(sample);
                maximum = maximum.max(sample);
                self.edge_samples[AREA2 + index] = sample as u32;
            }
        }
        if self.edges & EDGE_TOP == 0 {
            let mut last: u32 = 0;
            for index in 0..BLOCK_SIZE {
                let sample: u32 = self.picture.sample(plane, origin_x + index as i32, origin_y - 1);
                sum += sample as i32;
                minimum = minimum.min(sample as i32);
                maximum = maximum.max(sample as i32);
                self.edge_samples[AREA4 + index] = sample;
                last = sample;
            }
            for index in 0..BLOCK_SIZE {
                self.edge_samples[AREA5 + index] = if self.edges & EDGE_RIGHT != 0 {
                    last
                } else {
                    self.picture.sample(plane, origin_x + 8 + index as i32, origin_y - 1)
                };
                self.edge_samples[AREA6 + index] = self.picture.sample(plane, origin_x + index as i32, origin_y - 2);
            }
        }
        if self.edges & 3 != 0 {
            let average: u32 = ((sum + 4) >> 3) as u32;
            if self.edges & EDGE_LEFT != 0 {
                self.edge_samples[AREA1..=AREA3].fill(average);
            } else {
                self.edge_samples[AREA3..EDGE_SAMPLES].fill(average);
            }
            sum += average as i32 * 9;
        } else {
            let corner: u32 = self.picture.sample(plane, origin_x - 1, origin_y - 1);
            self.edge_samples[AREA3] = corner;
            sum += corner as i32;
        }
        sum += (self.edge_samples[AREA5] + self.edge_samples[AREA5 + 1]) as i32;
        (maximum - minimum, sum)
    }

    /// x8_get_orient_vlc, choosing the picture's orientation table at its first use
    fn read_orientation(&mut self) -> u32 {
        let table: &'static VLCLookup = match self.orient_table {
            Some(table) => table,
            None => {
                let table: &'static VLCLookup = if self.quant < LOW_QUANTIZER_LIMIT {
                    &self.lookups.x8_orient[ORIENT_LOW_QUANTIZER_TABLES + self.reader.read_bits(2) as usize]
                } else {
                    &self.lookups.x8_orient[self.reader.read_bits(1) as usize]
                };
                self.orient_table = Some(table);
                table
            }
        };
        self.reader.read_code(table)
    }

    /// x8_setup_spatial_predictor: the block's orientation, flatness, and predicted flat DC; false after an invalid orientation code
    fn setup_spatial_predictor(&mut self, plane: usize) -> bool {
        let (range, sum): (i32, i32) = self.setup_spatial_compensation(plane);
        let mut quant: i32 = self.quant;
        if plane != 0 {
            self.orient = self.chroma_orient;
            quant = self.quant_dc_chroma;
        }
        self.flat_dc = false;
        if range < quant || range < FLAT_RANGE_LIMIT {
            self.orient = 0;
            // A transform error of one changes this, so the decoding is exact or not at all
            if range < FLAT_RANGE_LIMIT {
                self.flat_dc = true;
                self.predicted_dc = ((sum + FLAT_DC_ROUNDING) * FLAT_DC_MULTIPLIER) >> FLAT_DC_SHIFT;
            }
        }
        if plane != 0 {
            return true;
        }
        if range < 2 * self.quant {
            if self.edges & 3 == 0 {
                if self.orient == 1 {
                    self.orient = 11;
                }
                if self.orient == 2 {
                    self.orient = 10;
                }
            } else {
                self.orient = 0;
            }
            self.raw_orient = 0;
            return true;
        }
        self.raw_orient = self.read_orientation();
        if self.raw_orient >= ORIENTATION_COUNT {
            return false;
        }
        self.orient = u32::from(X8_PREDICTION_ORIENTATIONS[(self.orient * ORIENTATION_COUNT + self.raw_orient) as usize]);
        true
    }

    /// x8_select_ac_table: chooses the AC table of a mode at its first use in the picture
    fn select_ac_table(&mut self, mode: usize) {
        if self.ac_tables[mode].is_some() {
            return;
        }
        let low_quantizer: usize = usize::from(self.quant < LOW_QUANTIZER_LIMIT);
        let index: usize = (low_quantizer * 2 + (mode >> 1)) * AC_TABLES_PER_GROUP + self.reader.read_bits(3) as usize;
        self.ac_tables[mode] = Some(&self.lookups.x8_ac[index]);
    }

    /// x8_get_ac_rlf: the run, the level, and whether the coefficient is the block's last; an invalid code runs past the block
    fn read_ac(&mut self, mode: usize) -> (u32, i32, bool) {
        let Some(table) = self.ac_tables[mode] else {
            return (BLOCK_RUN_LIMIT, 0, true);
        };
        let mut index: u32 = self.reader.read_code(table);
        if index == INVALID_SYMBOL {
            return (BLOCK_RUN_LIMIT, BLOCK_RUN_LIMIT as i32, true);
        }
        if index < AC_PAIR_SYMBOLS {
            let final_code: u32 = u32::from(index >= AC_PAIR_FINAL_START);
            index -= AC_PAIR_FINAL_START * final_code;
            let level: u32 = (AC_LEVEL_TABLE >> (index & 0x1E)) & 3;
            let run_mask: u32 = AC_RUN_MASK_TABLE >> (level << 3);
            return (index & run_mask, level as i32, final_code != 0);
        }
        if index < AC_DECODED_SYMBOLS {
            index -= AC_PAIR_SYMBOLS;
            let mut packed: u32 = X8_AC_DECODE[index as usize];
            let extra: u32 = self.reader.read_bits(packed & 0xF);
            packed >>= 8;
            let mask: u32 = packed & 0xFF;
            packed >>= 8;
            return ((packed & 0xFF) + (extra & mask), ((packed >> 8) + (extra & !mask)) as i32, index >= AC_DECODED_FINAL_START);
        }
        if index < AC_MIXED_SYMBOLS {
            let packed: u32 = u32::from(X8_MIXED_RUN_LEVEL[self.reader.read_bits(5) as usize]);
            return (packed >> 4, (packed & 0x0F) as i32, index & 1 == 0);
        }
        let level: u32 = self.reader.read_bits(7 - 3 * (index & 1));
        let run: u32 = self.reader.read_bits(6);
        (run, level as i32, self.reader.read_flag())
    }

    /// x8_get_dc_rlf: the level and whether it ends the block, or None after an invalid code
    fn read_dc(&mut self, mode: usize) -> Option<(i32, bool)> {
        let table: &'static VLCLookup = match self.dc_tables[mode] {
            Some(table) => table,
            None => {
                let base: usize = if self.quant < LOW_QUANTIZER_LIMIT { DC_LOW_QUANTIZER_TABLES } else { 0 };
                let table: &'static VLCLookup = &self.lookups.x8_dc[base + self.reader.read_bits(3) as usize];
                self.dc_tables[mode] = Some(table);
                table
            }
        };
        let code: u32 = self.reader.read_code(table);
        let mut index: i32 = if code == INVALID_SYMBOL { -1 } else { code as i32 };
        let final_code: bool = index >= DC_FINAL_START;
        if final_code {
            index -= DC_FINAL_START;
        }
        if index < 0 {
            return None;
        }
        if index == 0 {
            return Some((0, final_code));
        }
        let mut extra_bits: i32 = (index + 1) >> 1;
        if extra_bits > 1 {
            extra_bits -= 1;
        }
        let mut extra: i32 = self.reader.read_bits(extra_bits as u32) as i32;
        let magnitude: i32 = X8_DC_INDEX_OFFSET[index as usize] + (extra >> 1);
        extra = -(extra & 1);
        Some(((magnitude ^ extra) - extra, final_code))
    }

    /// x8_ac_compensation: rounds the DC level into the first row, column, or both, by direction
    fn ac_compensation(&mut self, direction: u32, dc_level: i32) {
        let term = |weight: i32| -> i32 { (weight * dc_level + 0x8000) >> 16 };
        let coefficients: &mut [i32; COEFFICIENT_COUNT] = &mut self.coefficients;
        match direction {
            0 => {
                let mut t: i32 = term(3811);
                coefficients[1] -= t;
                coefficients[8] -= t;
                t = term(487);
                coefficients[2] -= t;
                coefficients[16] -= t;
                t = term(506);
                coefficients[3] -= t;
                coefficients[24] -= t;
                t = term(135);
                coefficients[4] -= t;
                coefficients[32] -= t;
                coefficients[10] += t;
                coefficients[17] += t;
                coefficients[11] += t;
                coefficients[25] += t;
                t = term(173);
                coefficients[5] -= t;
                coefficients[40] -= t;
                t = term(61);
                coefficients[6] -= t;
                coefficients[48] -= t;
                coefficients[13] += t;
                coefficients[41] += t;
                t = term(42);
                coefficients[7] -= t;
                coefficients[56] -= t;
                coefficients[12] += t;
                coefficients[33] += t;
                coefficients[36] += t;
                t = term(1084);
                coefficients[9] += t;
            }
            1 => {
                coefficients[8] -= term(6269);
                coefficients[24] -= term(708);
                coefficients[40] -= term(172);
                coefficients[56] -= term(73);
            }
            2 => {
                coefficients[1] -= term(6269);
                coefficients[3] -= term(708);
                coefficients[5] -= term(172);
                coefficients[7] -= term(73);
            }
            _ => {}
        }
        // The block is int16_t
        for coefficient in coefficients.iter_mut() {
            *coefficient = wrap_int16(*coefficient);
        }
    }

    /// x8_update_predictions: a luma block's entry for its neighbors
    fn update_predictions(&mut self, orient: u32, estimated_run: u32) {
        let index: usize = self.column as usize * 2 + (self.row & 1) as usize;
        self.predictions[index] = (estimated_run << 2) + u32::from(orient == ORIENTATION_TOP) + if orient == ORIENTATION_LEFT { 2 } else { 0 };
    }

    /// x8_decode_intra_mb's parse: the block's coefficients, how to place it, and which edges to filter; None after a failure
    fn parse_block(&mut self, plane: usize) -> Option<ParsedBlock> {
        let mut block: ParsedBlock =
            ParsedBlock { placement: Placement::Predicted, solid: 0, orientation: self.orient, flat: self.flat_dc, transform: false, filter_edges: 0 };
        self.coefficients = [0; COEFFICIENT_COUNT];
        let chroma: bool = plane != 0;
        let dc_mode: usize = if chroma { 2 } else { usize::from(self.estimated_run != 0) };
        let (mut dc_level, final_dc): (i32, bool) = self.read_dc(dc_mode)?;
        let mut count: u32 = 0;
        let mut zeros_only: bool = false;
        let mut placed: bool = false;
        if !final_dc {
            let mut use_quant_matrix: bool = self.use_quant_matrix;
            let mut ac_mode: usize = 1;
            let mut estimated_run: u32 = BLOCK_RUN_LIMIT;
            if !chroma {
                if self.raw_orient < 3 {
                    use_quant_matrix = false;
                }
                if self.raw_orient > 4 {
                    ac_mode = 0;
                } else if self.estimated_run > 1 {
                    ac_mode = 2;
                    estimated_run = self.estimated_run;
                } else {
                    ac_mode = 3;
                }
            }
            self.select_ac_table(ac_mode);
            let scan: usize = ((SCAN_SELECTION_TABLE >> (2 * self.orient)) & 3) as usize * COEFFICIENT_COUNT;
            let mut position: u32 = 0;
            loop {
                count += 1;
                if count >= estimated_run {
                    ac_mode = SWITCH_AC_MODE;
                    self.select_ac_table(SWITCH_AC_MODE);
                }
                let (run, coded_level, final_code): (u32, i32, bool) = self.read_ac(ac_mode);
                position += run + 1;
                if position > 63 {
                    return None;
                }
                let mut level: i32 = (coded_level + 1) * self.dquant + self.qsum;
                let sign: i32 = -(self.reader.read_bit() as i32);
                level = (level ^ sign) - sign;
                if use_quant_matrix {
                    level = (level * X8_QUANT_MATRIX[position as usize]) >> 8;
                }
                self.coefficients[X8_SCANS[scan + position as usize] as usize] = wrap_int16(level);
                if final_code {
                    break;
                }
            }
        } else if self.flat_dc && ((dc_level + 1) as u32) < 3 {
            let divide_quant: i32 = if chroma { self.divide_quant_dc_chroma } else { self.divide_quant_dc_luma };
            let dc_quant: i32 = if chroma { self.quant_dc_chroma } else { self.quant };
            // FFmpeg's rounding of dc_level += predicted_dc / quant
            dc_level += (self.predicted_dc * divide_quant + (1 << 12)) >> 13;
            block.placement = Placement::Solid;
            block.solid = ((dc_level * dc_quant + 4) >> 3).clamp(0, SAMPLE_MAXIMUM) as u32;
            placed = true;
        } else {
            zeros_only = dc_level == 0;
        }
        if !placed {
            self.coefficients[0] = wrap_int16(dc_level * if chroma { self.quant_dc_chroma } else { self.quant });
            if (dc_level + 1) as u32 >= 3 && self.edges & 3 != 3 {
                let direction: u32 = (COMPENSATION_DIRECTION_TABLE >> (self.orient * 2)) & 3;
                if direction != 3 {
                    self.ac_compensation(direction, self.coefficients[0]);
                }
            }
            if self.flat_dc {
                block.solid = self.predicted_dc as u32 & 0xFF;
            }
            block.transform = !zeros_only;
        }
        if !chroma {
            self.update_predictions(self.orient, count);
        }
        if self.loop_filter {
            if !(self.edges & EDGE_TOP != 0 || (zeros_only && (self.orient | ORIENTATION_TOP) == ORIENTATION_TOP)) {
                block.filter_edges |= 1;
            }
            if !(self.edges & EDGE_LEFT != 0 || (zeros_only && (self.orient | ORIENTATION_LEFT) == ORIENTATION_LEFT)) {
                block.filter_edges |= 2;
            }
        }
        Some(block)
    }

    /// spatial_compensation_0's smoothed edge at one position: the edge samples weighted down by their distance, the odd distances by
    /// sqrt(2)/2; FFmpeg keeps the sums in uint16_t
    fn smoothed_edge(&self, first: usize, count: usize, position: i32, reversed: bool) -> u32 {
        let mut even: u32 = 0;
        let mut odd: u32 = 0;
        for index in 0..count {
            let distance: u32 = (index as i32 - position).unsigned_abs();
            let source: usize = if reversed { first + 7 - index } else { first + index };
            let value: u32 = (self.edge_samples[source] << 4) >> (distance >> 1);
            if distance & 1 == 0 {
                even += value;
            } else {
                odd += value;
            }
        }
        (even + ((odd * 181 + 128) >> 8)) & 0xFFFF
    }

    /// The predicted sample (x, y) of the block's orientation, FFmpeg's spatial_compensation functions
    fn predict_sample(&self, orientation: u32, x: usize, y: usize) -> u32 {
        let edge: &[u32] = &self.edge_samples;
        let (signed_x, signed_y): (i32, i32) = (x as i32, y as i32);
        match orientation {
            0 => {
                // The top row reaches columns 8 and 9 for columns 5 to 7, and columns 10 and 11 for column 7
                let top_count: usize = match x {
                    7 => 12,
                    5 | 6 => 10,
                    _ => 8,
                };
                let top: u32 = self.smoothed_edge(AREA4, top_count, signed_x, false);
                let left: u32 = self.smoothed_edge(AREA2, BLOCK_SIZE, signed_y, true);
                let weights: usize = y * 16 + x * 2;
                // A uint8_t keeps the low byte
                ((top * X8_ZERO_PREDICTION_WEIGHTS[weights] + left * X8_ZERO_PREDICTION_WEIGHTS[weights + 1] + 0x8000) >> 16) & 0xFF
            }
            1 => edge[AREA4 + (2 * y + x + 2).min(15)],
            2 => edge[AREA4 + 1 + y + x],
            3 => edge[AREA4 + ((y + 1) >> 1) + x],
            4 => (edge[AREA4 + x] + edge[AREA6 + x] + 1) >> 1,
            5 => {
                if 2 * signed_x - signed_y < 0 {
                    return edge[(AREA2 as i32 + 9 + 2 * signed_x - signed_y) as usize];
                }
                edge[(AREA4 as i32 + signed_x - ((signed_y + 1) >> 1)) as usize]
            }
            6 => edge[AREA3 - y + x],
            7 => {
                if signed_x - 2 * signed_y > 0 {
                    let index: usize = (AREA3 as i32 + signed_x - 2 * signed_y) as usize;
                    return (edge[index - 1] + edge[index] + 1) >> 1;
                }
                edge[AREA2 + 8 - y + (x >> 1)]
            }
            8 => (edge[AREA1 + 7 - y] + edge[AREA2 + 7 - y] + 1) >> 1,
            9 => edge[AREA2 + 6 - (x + y).min(6)],
            10 => (edge[AREA2 + 7 - y] * (8 - x as u32) + edge[AREA4 + x] * x as u32 + 4) >> 3,
            _ => (edge[AREA2 + 7 - y] * y as u32 + edge[AREA4 + x] * (8 - y as u32) + 4) >> 3,
        }
    }

    /// wmv2_idct_row of each row, int16_t in and out
    fn transform_rows(&mut self) {
        for row in 0..BLOCK_SIZE {
            let base: usize = row * BLOCK_SIZE;
            let samples: [i32; 8] = std::array::from_fn(|index: usize| self.coefficients[base + index]);
            let a1: i32 = 2841 * samples[1] + 565 * samples[7];
            let a7: i32 = 565 * samples[1] - 2841 * samples[7];
            let a5: i32 = 1609 * samples[5] + 2408 * samples[3];
            let a3: i32 = 2408 * samples[5] - 1609 * samples[3];
            let a2: i32 = 2676 * samples[2] + 1108 * samples[6];
            let a6: i32 = 1108 * samples[2] - 2676 * samples[6];
            let a0: i32 = 2048 * samples[0] + 2048 * samples[4];
            let a4: i32 = 2048 * samples[0] - 2048 * samples[4];
            let s1: i32 = scale_by_half_square_root(a1 - a5 + a7 - a3);
            let s2: i32 = scale_by_half_square_root(a1 - a5 - a7 + a3);
            let outputs: [i32; 8] = [
                a0 + a2 + a1 + a5,
                a4 + a6 + s1,
                a4 - a6 + s2,
                a0 - a2 + a7 + a3,
                a0 - a2 - a7 - a3,
                a4 - a6 - s2,
                a4 + a6 - s1,
                a0 + a2 - a1 - a5,
            ];
            for (index, value) in outputs.iter().enumerate() {
                self.coefficients[base + index] = wrap_int16((value + 128) >> 8);
            }
        }
    }

    /// wmv2_idct_col of each column, int16_t in and out
    fn transform_columns(&mut self) {
        for column in 0..BLOCK_SIZE {
            let samples: [i32; 8] = std::array::from_fn(|index: usize| self.coefficients[column + index * BLOCK_SIZE]);
            let a1: i32 = (2841 * samples[1] + 565 * samples[7] + 4) >> 3;
            let a7: i32 = (565 * samples[1] - 2841 * samples[7] + 4) >> 3;
            let a5: i32 = (1609 * samples[5] + 2408 * samples[3] + 4) >> 3;
            let a3: i32 = (2408 * samples[5] - 1609 * samples[3] + 4) >> 3;
            let a2: i32 = (2676 * samples[2] + 1108 * samples[6] + 4) >> 3;
            let a6: i32 = (1108 * samples[2] - 2676 * samples[6] + 4) >> 3;
            let a0: i32 = (2048 * samples[0] + 2048 * samples[4]) >> 3;
            let a4: i32 = (2048 * samples[0] - 2048 * samples[4]) >> 3;
            let s1: i32 = scale_by_half_square_root(a1 - a5 + a7 - a3);
            let s2: i32 = scale_by_half_square_root(a1 - a5 - a7 + a3);
            let outputs: [i32; 8] = [
                a0 + a2 + a1 + a5,
                a4 + a6 + s1,
                a4 - a6 + s2,
                a0 - a2 + a7 + a3,
                a0 - a2 - a7 - a3,
                a4 - a6 - s2,
                a4 + a6 - s1,
                a0 + a2 - a1 - a5,
            ];
            for (index, value) in outputs.iter().enumerate() {
                self.coefficients[column + index * BLOCK_SIZE] = wrap_int16((value + 8192) >> 14);
            }
        }
    }

    /// x8_loop_filter across one line of an edge: the window samples at first + k * step for k from -5 to 4, the edge between -1 and 0
    fn filter_line(&mut self, first: i32, step: i32, quant: i32) {
        let samples: [i32; 10] = std::array::from_fn(|index: usize| self.window[(first + (index as i32 - 5) * step) as usize]);
        let level: i32 = (quant + 10) >> 3;
        let close = |first_index: usize, second_index: usize| -> i32 { i32::from((samples[first_index] - samples[second_index]).abs() <= level) };
        let mut flat_count: i32 = close(1, 2) + close(2, 3) + close(3, 4) + close(4, 5);
        if flat_count > 0 {
            flat_count += close(5, 6) + close(6, 7) + close(7, 8) + close(8, 9) + close(0, 1);
            if flat_count >= 6 {
                let mut minimum: i32 = samples[1].min(samples[3]).min(samples[5].min(samples[8]));
                let mut maximum: i32 = samples[1].max(samples[3]).max(samples[5].max(samples[8]));
                if maximum - minimum < 2 * quant {
                    minimum = minimum.min(samples[2].min(samples[4]).min(samples[6].min(samples[7])));
                    maximum = maximum.max(samples[2].max(samples[4]).max(samples[6].max(samples[7])));
                    if maximum - minimum < 2 * quant {
                        self.window[(first - 2 * step) as usize] = (4 * samples[2] + 3 * samples[3] + samples[7] + 4) >> 3;
                        self.window[(first - step) as usize] = (3 * samples[2] + 3 * samples[4] + 2 * samples[7] + 4) >> 3;
                        self.window[first as usize] = (2 * samples[2] + 3 * samples[5] + 3 * samples[7] + 4) >> 3;
                        self.window[(first + step) as usize] = (samples[2] + 3 * samples[6] + 4 * samples[7] + 4) >> 3;
                        return;
                    }
                }
            }
        }
        let x0: i32 = (2 * samples[3] - 5 * samples[4] + 5 * samples[5] - 2 * samples[6] + 4) >> 3;
        if x0.abs() < quant {
            let x1: i32 = (2 * samples[1] - 5 * samples[2] + 5 * samples[3] - 2 * samples[4] + 4) >> 3;
            let x2: i32 = (2 * samples[5] - 5 * samples[6] + 5 * samples[7] - 2 * samples[8] + 4) >> 3;
            let mut x: i32 = x0.abs() - x1.abs().min(x2.abs());
            let mut difference: i32 = samples[4] - samples[5];
            if x > 0 && (difference ^ x0) < 0 {
                let sign: i32 = difference >> 31;
                difference = ((difference ^ sign) - sign) >> 1;
                x = ((5 * x) >> 3).min(difference);
                x = (x ^ sign) - sign;
                self.window[(first - step) as usize] = samples[4] - x;
                self.window[first as usize] = samples[5] + x;
            }
        }
    }

    /// Decodes one block of a plane; false once the picture's parse failed
    fn decode_block(&mut self, plane: usize) -> bool {
        let valid: bool = if plane == 0 {
            self.get_prediction();
            self.setup_spatial_predictor(0)
        } else {
            if plane == 1 {
                self.get_prediction_chroma();
            }
            self.setup_spatial_predictor(plane)
        };
        if !valid {
            return false;
        }
        let Some(block) = self.parse_block(plane) else {
            return false;
        };
        let (origin_x, origin_y): (i32, i32) = self.block_origin(plane);
        if block.transform {
            self.transform_rows();
            self.transform_columns();
        }
        for y in 0..BLOCK_SIZE {
            for x in 0..BLOCK_SIZE {
                let predicted: u32 =
                    if block.placement == Placement::Predicted && !block.flat { self.predict_sample(block.orientation, x, y) } else { block.solid };
                let mut sample: i32 = predicted as i32;
                if block.transform {
                    sample = (sample + self.coefficients[y * BLOCK_SIZE + x]).clamp(0, SAMPLE_MAXIMUM);
                }
                self.window[window_index(x as i32, y as i32)] = sample;
            }
        }
        // The loop filter reads up to five rows above and columns left of the block, which earlier blocks finished
        if block.filter_edges != 0 {
            for window_y in -WINDOW_ORIGIN..WINDOW_SIZE - WINDOW_ORIGIN {
                for window_x in -WINDOW_ORIGIN..WINDOW_SIZE - WINDOW_ORIGIN {
                    let inside: bool = origin_x + window_x >= 0 && origin_y + window_y >= 0;
                    if (window_x < 0 || window_y < 0) && inside && (window_x >= 0 || window_y >= 0) {
                        self.window[window_index(window_x, window_y)] = self.picture.sample(plane, origin_x + window_x, origin_y + window_y) as i32;
                    }
                }
            }
        }
        if block.filter_edges & 1 != 0 {
            for line in 0..BLOCK_SIZE as i32 {
                self.filter_line(window_index(line, 0) as i32, WINDOW_SIZE, self.quant);
            }
        }
        if block.filter_edges & 2 != 0 {
            for line in 0..BLOCK_SIZE as i32 {
                self.filter_line(window_index(0, line) as i32, 1, self.quant);
            }
        }
        // Samples back to the picture: the block's, the rows above it the top filter changed, and the columns left of it the left filter changed
        for y in 0..BLOCK_SIZE as i32 {
            for x in 0..BLOCK_SIZE as i32 {
                self.picture.set_sample(plane, origin_x + x, origin_y + y, self.window[window_index(x, y)]);
            }
        }
        if block.filter_edges & 1 != 0 {
            for y in -FILTERED_ROWS_ABOVE..0 {
                for x in 0..BLOCK_SIZE as i32 {
                    self.picture.set_sample(plane, origin_x + x, origin_y + y, self.window[window_index(x, y)]);
                }
            }
        }
        if block.filter_edges & 2 != 0 {
            for y in 0..BLOCK_SIZE as i32 {
                for x in -FILTERED_COLUMNS_LEFT..0 {
                    self.picture.set_sample(plane, origin_x + x, origin_y + y, self.window[window_index(x, y)]);
                }
            }
        }
        true
    }
}

/// ff_intrax8_decode_picture: decodes an IntraX8 picture from the reader at its first block; FFmpeg stops at a row without bits left or
/// at an invalid code, leaving the rest of the picture as it was.
pub fn decode_intrax8_picture(reader: BitReader, mb_width: u32, mb_height: u32, pq: u32, halfpq: u32, pquantizer: u32, loop_filter: bool) -> IntraX8Picture {
    let dquant: i32 = pq as i32 * 2 + halfpq as i32;
    let quant: i32 = dquant >> 1;
    let divide_quant_dc_luma: i32 = ((1 << 16) + (quant >> 1)) / quant.max(1);
    let (quant_dc_chroma, divide_quant_dc_chroma): (i32, i32) = if quant < 5 {
        (quant, divide_quant_dc_luma)
    } else {
        let chroma: i32 = quant + ((quant + 3) >> 3);
        (chroma, ((1 << 16) + (chroma >> 1)) / chroma)
    };
    let mut decoder: IntraX8Decoder = IntraX8Decoder {
        reader,
        lookups: lookups(),
        picture: IntraX8Picture::new(mb_width, mb_height),
        mb_width,
        quant,
        dquant,
        qsum: if pquantizer == 0 { pq as i32 } else { 0 },
        quant_dc_chroma,
        divide_quant_dc_luma,
        divide_quant_dc_chroma,
        use_quant_matrix: false,
        loop_filter,
        ac_tables: [None; AC_MODE_COUNT],
        dc_tables: [None; DC_MODE_COUNT],
        orient_table: None,
        column: 0,
        row: 0,
        edges: 0,
        orient: 0,
        raw_orient: 0,
        estimated_run: 0,
        chroma_orient: 0,
        flat_dc: false,
        predicted_dc: 0,
        predictions: vec![0; 4 * mb_width as usize],
        coefficients: [0; COEFFICIENT_COUNT],
        edge_samples: [0; EDGE_SAMPLES + 7],
        window: [0; WINDOW_SAMPLES],
    };
    decoder.use_quant_matrix = decoder.reader.read_flag();
    let block_rows: u32 = mb_height * 2;
    let block_columns: u32 = mb_width * 2;
    'rows: for row in 0..block_rows {
        if decoder.reader.bits_left() < 1 {
            break;
        }
        for column in 0..block_columns {
            decoder.column = column;
            decoder.row = row;
            if !decoder.decode_block(0) {
                break 'rows;
            }
            if column & row & 1 != 0 && !(decoder.decode_block(1) && decoder.decode_block(2)) {
                break 'rows;
            }
        }
    }
    decoder.picture
}
