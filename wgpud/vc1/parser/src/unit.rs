// One parse unit's macroblock layer, a slice or a field, decoded in raster order as FFmpeg's ff_vc1_decode_blocks walks a slice.
// The parse mirrors the all-WGSL decoder's slice passes, itself FFmpeg's vc1_block.c and vc1_pred.c: entropy decoding, motion vector
// prediction, the motion compensation calls, and the coefficients; intra blocks are then predicted, scanned, and dequantized at once,
// since every neighbor they read precedes them in raster order. Each macroblock leaves its words of the GPU record.

use crate::bitstream::BitReader;
use crate::error::DecodeError;
use crate::header::{MV_MODE_INTENSITY_COMPENSATION, MV_MODE_MIXED_MV, PLANE_DECODED, PLANE_RAW};
use crate::layout::{
    COEFFICIENTS_PER_BLOCK, ERROR_BITS_EXHAUSTED, ERROR_MACROBLOCK_LAYER, FCM_FIELD, FCM_FRAME, FCM_PROGRESSIVE, MACROBLOCK_CBP,
    MACROBLOCK_COUNTS, MACROBLOCK_FIELD_FLAGS, MACROBLOCK_FIXED_WORDS, MACROBLOCK_FLAGS, MACROBLOCK_IS_INTRA, MACROBLOCK_LOOP_FILTER_CHROMA_MV,
    MACROBLOCK_MV0, MACROBLOCK_OPERATIONS, MACROBLOCK_SLICE_BOTTOM_BIT, MACROBLOCK_SLICE_TOP_BIT, MACROBLOCK_TRANSFORMS, MACROBLOCK_TT,
    OPERATION_WORDS, TYPE_B, TYPE_BI, TYPE_I, TYPE_P,
};
use crate::plan::{ANCHOR_INTRA, ANCHOR_WORDS_PER_MACROBLOCK, Plan, SequenceFacts, UnitParameters};
use crate::vlc::{Lookups, VLCLookup, lookups};

// Fields of a macroblock record's flags word the parser alone reads; the record layout declares those the GPU reads
pub const MB_INTRA_BLOCKS_MASK: u32 = 0x3F;
pub const MB_SKIPPED_BIT: u32 = 1 << 6;
pub const MB_ACPRED_BIT: u32 = 1 << 9;
// Bits 10 to 15: whether each intra block codes AC levels, FFmpeg's coded argument of its intra block decoders
pub const MB_INTRA_CODED_SHIFT: u32 = 10;
pub const MB_CODED_BLOCK_SHIFT: u32 = 16;
pub const MB_BLOCK_MV_TYPE_SHIFT: u32 = 20;
pub const MB_DECODED_BIT: u32 = 1 << 24;

/// Blocks of a macroblock: four luma, then Cb and Cr.
pub const BLOCK_COUNT: usize = 6;
pub const LUMA_BLOCK_COUNT: usize = 4;
/// Operation slots: eight luma slots, then eight chroma slots, which the operation mask's bits index alike.
pub const OPERATION_SLOT_COUNT: usize = 16;
/// Words of a block's intra prediction record: the DC level and the AC levels of its first column and row, two halves a word.
pub const PREDICTION_WORDS_PER_BLOCK: usize = 8;
/// The 8x8 block grid addresses with a power-of-two stride, as the WGSL decoder's did, so its padding behaves as FFmpeg's.
pub const GRID_STRIDE_SHIFT: u32 = 10;
pub const GRID_STRIDE: i32 = 1 << GRID_STRIDE_SHIFT;
const GRID_COLUMN_MASK: u32 = (1 << GRID_STRIDE_SHIFT) - 1;
/// The coefficient entries a block holds at most.
const BLOCK_ENTRY_COUNT: usize = COEFFICIENTS_PER_BLOCK as usize;

/// One macroblock's record: the GPU's words, and what its neighbors' prediction reads of it.
#[derive(Clone, Copy)]
pub struct MacroblockRecord {
    pub flags: u32,
    pub cbp: u32,
    pub tt: u32,
    pub is_intra: u32,
    /// FFmpeg's motion_val[0] and motion_val[1] of each luma block, packed
    pub motion_vectors: [[u32; 4]; 2],
    /// FFmpeg's mv_f[0] in bits 0 to 5 and mv_f[1] in bits 8 to 13
    pub field_flags: u32,
    pub loop_filter_chroma_mv: u32,
    /// A transform half-word per block
    pub transforms: [u32; 3],
    /// A coefficient count byte per block: blocks 0 to 3, then 4 and 5
    pub counts: [u32; 2],
    /// FFmpeg's qscale_table entry: the signed macroblock quantizer
    pub quantizer: i32,
    pub operations: u32,
    pub operation_words: [[u32; 2]; OPERATION_SLOT_COUNT],
    /// Each block's intra prediction record
    pub predictions: [[u32; PREDICTION_WORDS_PER_BLOCK]; BLOCK_COUNT],
}

impl MacroblockRecord {
    pub const EMPTY: Self = Self {
        flags: 0,
        cbp: 0,
        tt: 0,
        is_intra: 0,
        motion_vectors: [[0; 4]; 2],
        field_flags: 0,
        loop_filter_chroma_mv: 0,
        transforms: [0; 3],
        counts: [0; 2],
        quantizer: 0,
        operations: 0,
        operation_words: [[0; 2]; OPERATION_SLOT_COUNT],
        predictions: [[0; PREDICTION_WORDS_PER_BLOCK]; BLOCK_COUNT],
    };

    /// The coefficient count of block n.
    pub fn block_count(&self, block: usize) -> u32 {
        let (word, shift): (usize, u32) = if block < LUMA_BLOCK_COUNT { (0, (block as u32) * 8) } else { (1, (block as u32 - 4) * 8) };
        (self.counts[word] >> shift) & 0xFF
    }

    pub fn set_block_count(&mut self, block: usize, count: u32) {
        let (word, shift): (usize, u32) = if block < LUMA_BLOCK_COUNT { (0, (block as u32) * 8) } else { (1, (block as u32 - 4) * 8) };
        self.counts[word] = (self.counts[word] & !(0xFF << shift)) | (count << shift);
    }

    pub fn set_block_transform(&mut self, block: usize, transform: u32) {
        let shift: u32 = (block as u32 & 1) * 16;
        self.transforms[block / 2] = (self.transforms[block / 2] & !(0xFFFF << shift)) | (transform << shift);
    }

    /// Appends the macroblock's words of the GPU record: its fixed words, then its present operations in slot order.
    pub fn write_record_words(&self, output: &mut Vec<u32>) {
        let mut fixed: [u32; MACROBLOCK_FIXED_WORDS as usize] = [0; MACROBLOCK_FIXED_WORDS as usize];
        fixed[MACROBLOCK_FLAGS as usize] = self.flags;
        fixed[MACROBLOCK_CBP as usize] = self.cbp;
        fixed[MACROBLOCK_TT as usize] = self.tt;
        fixed[MACROBLOCK_IS_INTRA as usize] = self.is_intra;
        for (block, &vector) in self.motion_vectors[0].iter().enumerate() {
            fixed[MACROBLOCK_MV0 as usize + block] = vector;
        }
        fixed[MACROBLOCK_FIELD_FLAGS as usize] = self.field_flags;
        fixed[MACROBLOCK_LOOP_FILTER_CHROMA_MV as usize] = self.loop_filter_chroma_mv;
        for (index, &transform) in self.transforms.iter().enumerate() {
            fixed[MACROBLOCK_TRANSFORMS as usize + index] = transform;
        }
        fixed[MACROBLOCK_COUNTS as usize] = self.counts[0];
        fixed[MACROBLOCK_COUNTS as usize + 1] = self.counts[1];
        fixed[MACROBLOCK_OPERATIONS as usize] = self.operations;
        output.extend_from_slice(&fixed);
        let mut operations: u32 = self.operations;
        while operations != 0 {
            let slot: usize = operations.trailing_zeros() as usize;
            operations &= operations - 1;
            output.extend_from_slice(&self.operation_words[slot][..OPERATION_WORDS as usize]);
        }
    }
}

pub fn pack_motion_vector(vector: [i32; 2]) -> u32 {
    (vector[0] as u32 & 0xFFFF) | ((vector[1] as u32) << 16)
}

pub fn unpack_motion_vector(word: u32) -> [i32; 2] {
    [((word << 16) as i32) >> 16, (word as i32) >> 16]
}

/// Sign-extends the low 16 bits, as FFmpeg's int16_t blocks and vectors keep values.
pub fn wrap_int16(value: i32) -> i32 {
    (value << 16) >> 16
}

/// FFmpeg's mid_pred: the median of three.
pub fn median_of_three(first: i32, second: i32, third: i32) -> i32 {
    first.min(second).max(first.max(second).min(third))
}

/// FFmpeg's median4: the mean of the middle two of four, truncated toward zero as C division is.
pub fn median_of_four(first: i32, second: i32, third: i32, fourth: i32) -> i32 {
    if first < second {
        if third < fourth {
            return (second.min(fourth) + first.max(third)) / 2;
        }
        return (second.min(third) + first.max(fourth)) / 2;
    }
    if third < fourth {
        return (first.min(fourth) + second.max(third)) / 2;
    }
    (first.min(third) + second.max(fourth)) / 2
}

/// What one unit's parse leaves for the record: each macroblock's words, its anchor motion, and its first failure.
#[derive(Default)]
pub struct UnitOutput {
    pub unit_index: u32,
    /// The highest error word of the unit, or 0
    pub error_word: u32,
    /// The record words of each macroblock of the unit's rows in raster order, 0 for one the unit did not decode
    pub macroblock_lengths: Vec<u32>,
    pub macroblock_words: Vec<u32>,
    /// ANCHOR_WORDS_PER_MACROBLOCK words per macroblock of an anchor's unit, or none
    pub anchor_words: Vec<u32>,
    /// An IntraX8 picture's samples, four to a word
    pub sample_words: Vec<u32>,
}

/// The macroblock layer of one unit: its parameters, its reader, the records of its rows, and FFmpeg's per-macroblock state.
pub struct UnitParser<'plan> {
    pub sequence: SequenceFacts,
    pub unit: UnitParameters,
    pub planes: &'plan [u8],
    pub anchor_motion: &'plan [u32],
    pub reader: BitReader<'plan>,
    pub lookups: &'static Lookups,
    pub mb_width: u32,
    pub mb_height: u32,
    // The lookups the unit's picture chose
    pub cbpcy_lookup: &'static VLCLookup,
    pub mbmode_lookup: &'static VLCLookup,
    pub imv_lookup: &'static VLCLookup,
    pub two_mv_block_pattern_lookup: &'static VLCLookup,
    pub four_mv_block_pattern_lookup: &'static VLCLookup,
    pub inter_ac_lookup: &'static VLCLookup,
    pub records: Vec<MacroblockRecord>,
    // The macroblock being decoded, FFmpeg's MpegEncContext and VC1Context fields
    pub mb_x: u32,
    pub mb_y: u32,
    pub frame_row: u32,
    pub current: usize,
    pub first_slice_line: bool,
    pub mb_intra: bool,
    pub ac_pred: bool,
    pub esc3_level_length: u32,
    pub esc3_run_length: u32,
    pub ref_field_type: [u32; 2],
    /// FFmpeg's s->mv[dir][n] at index dir * 4 + n
    pub motion_vectors: [[i32; 2]; 8],
    pub macroblock_failed: bool,
    /// The bmvtype of field B macroblocks, which ff_vc1_pred_b_mv_intfi reads
    pub b_motion_type: u32,
    /// The coefficient entries of the macroblock being decoded, per block
    pub block_entries: [[u32; BLOCK_ENTRY_COUNT]; BLOCK_COUNT],
}

impl<'plan> UnitParser<'plan> {
    pub fn new(plan: &'plan Plan, unit: &UnitParameters) -> Self {
        let all: &'static Lookups = lookups();
        let mixed: bool = unit.mv_mode == MV_MODE_MIXED_MV || (unit.mv_mode == MV_MODE_INTENSITY_COMPENSATION && unit.mv_mode2 == MV_MODE_MIXED_MV);
        let (cbpcy_lookup, mbmode_lookup, imv_lookup): (&'static VLCLookup, &'static VLCLookup, &'static VLCLookup) = match unit.fcm {
            FCM_FRAME => {
                let mbmode: &'static VLCLookup = if unit.fourmvswitch != 0 {
                    &all.interlaced_frame_4mv_mbmode[unit.mbmodetab as usize & 3]
                } else {
                    &all.interlaced_frame_non4mv_mbmode[unit.mbmodetab as usize & 3]
                };
                (&all.interlaced_cbpcy[unit.icbptab as usize & 7], mbmode, &all.one_reference_mvdata[unit.imvtab as usize & 3])
            }
            FCM_FIELD => {
                let mbmode: &'static VLCLookup = if mixed {
                    &all.interlaced_field_mixed_mbmode[unit.mbmodetab as usize & 7]
                } else {
                    &all.interlaced_field_1mv_mbmode[unit.mbmodetab as usize & 7]
                };
                let imv: &'static VLCLookup =
                    if unit.numref != 0 { &all.two_reference_mvdata[unit.imvtab as usize & 7] } else { &all.one_reference_mvdata[unit.imvtab as usize & 3] };
                (&all.interlaced_cbpcy[unit.icbptab as usize & 7], mbmode, imv)
            }
            _ => (&all.cbpcy_p[unit.cbptab as usize & 3], &all.interlaced_field_1mv_mbmode[0], &all.one_reference_mvdata[0]),
        };
        let plane_bytes: &[u8] = plan.plane_versions.get(unit.plane_version as usize).map_or(&[], Vec::as_slice);
        let row_count: usize = unit.end_row.saturating_sub(unit.start_row) as usize;
        Self {
            sequence: plan.sequence,
            unit: *unit,
            planes: plane_bytes,
            anchor_motion: &plan.anchor_motion,
            reader: BitReader::new(&plan.stream, unit.start_bit as usize, unit.end_bit as usize),
            lookups: all,
            mb_width: plan.sequence.mb_width,
            mb_height: plan.sequence.mb_height,
            cbpcy_lookup,
            mbmode_lookup,
            imv_lookup,
            two_mv_block_pattern_lookup: &all.two_mv_block_pattern[unit.twomvbptab as usize & 3],
            four_mv_block_pattern_lookup: &all.four_mv_block_pattern[unit.fourmvbptab as usize & 3],
            inter_ac_lookup: &all.ac_coefficients[unit.codingset2 as usize & 7],
            records: vec![MacroblockRecord::EMPTY; row_count * plan.sequence.mb_width as usize],
            mb_x: 0,
            mb_y: unit.start_row,
            frame_row: 0,
            current: 0,
            first_slice_line: true,
            mb_intra: false,
            ac_pred: false,
            esc3_level_length: 0,
            esc3_run_length: 0,
            ref_field_type: [unit.ref_field_type_forward, 0],
            motion_vectors: [[0; 2]; 8],
            macroblock_failed: false,
            b_motion_type: 0,
            block_entries: [[0; BLOCK_ENTRY_COUNT]; BLOCK_COUNT],
        }
    }

    pub fn is_mixed_motion_vector_mode(&self) -> bool {
        self.unit.mv_mode == MV_MODE_MIXED_MV || (self.unit.mv_mode == MV_MODE_INTENSITY_COMPENSATION && self.unit.mv_mode2 == MV_MODE_MIXED_MV)
    }

    /// The record of a macroblock of the current field, or the empty record for one outside the unit's rows, which no read uses.
    pub fn record(&self, column: u32, row: u32) -> &MacroblockRecord {
        match self.record_index(column, row) {
            Some(index) => &self.records[index],
            None => &MacroblockRecord::EMPTY,
        }
    }

    pub fn record_index(&self, column: u32, row: u32) -> Option<usize> {
        if column >= self.mb_width || row < self.unit.start_row || row >= self.unit.end_row {
            return None;
        }
        Some(((row - self.unit.start_row) * self.mb_width + column) as usize)
    }

    /// The record of the macroblock being decoded.
    pub fn current_record(&mut self) -> &mut MacroblockRecord {
        &mut self.records[self.current]
    }

    // The 8x8 luma block grid of the current field: columns from 2 * mb_width on are padding, of which FFmpeg's b8_stride of
    // 2 * mb_width + 1 holds one, and FFmpeg reads none past it

    pub fn block_grid_index(&self, block: u32) -> i32 {
        let x: i32 = self.mb_x as i32 * 2 + (block & 1) as i32;
        let y: i32 = self.mb_y as i32 * 2 + (block >> 1) as i32;
        y * GRID_STRIDE + x
    }

    pub fn grid_column(index: i32) -> u32 {
        index as u32 & GRID_COLUMN_MASK
    }

    pub fn grid_row(index: i32) -> u32 {
        index as u32 >> GRID_STRIDE_SHIFT
    }

    pub fn grid_block(index: i32) -> usize {
        ((Self::grid_column(index) & 1) | ((Self::grid_row(index) & 1) << 1)) as usize
    }

    pub fn grid_is_padding(&self, index: i32) -> bool {
        index < 0 || Self::grid_column(index) >= self.mb_width * 2
    }

    fn grid_record(&self, index: i32) -> &MacroblockRecord {
        self.record(Self::grid_column(index) >> 1, Self::grid_row(index) >> 1)
    }

    fn grid_record_mut(&mut self, index: i32) -> Option<&mut MacroblockRecord> {
        let record: usize = self.record_index(Self::grid_column(index) >> 1, Self::grid_row(index) >> 1)?;
        Some(&mut self.records[record])
    }

    /// motion_val[direction] of a grid block
    pub fn grid_motion_vector(&self, direction: usize, index: i32) -> [i32; 2] {
        if self.grid_is_padding(index) {
            return [0, 0];
        }
        unpack_motion_vector(self.grid_record(index).motion_vectors[direction][Self::grid_block(index)])
    }

    pub fn set_grid_motion_vector(&mut self, direction: usize, index: i32, vector: [i32; 2]) {
        let block: usize = Self::grid_block(index);
        if let Some(record) = self.grid_record_mut(index) {
            record.motion_vectors[direction][block] = pack_motion_vector(vector);
        }
    }

    /// Sets mv_f[direction] of a grid block
    pub fn set_grid_field_flag(&mut self, direction: u32, index: i32, value: u32) {
        let bit: u32 = 1 << (direction * 8 + Self::grid_block(index) as u32);
        if let Some(record) = self.grid_record_mut(index) {
            if value != 0 {
                record.field_flags |= bit;
            } else {
                record.field_flags &= !bit;
            }
        }
    }

    /// Chroma mv_f, which the motion compensation calls set in field pictures
    pub fn set_chroma_field_flags(&mut self, direction: u32, value: u32) {
        let bits: u32 = (3 << 4) << (direction * 8);
        let record: &mut MacroblockRecord = self.current_record();
        if value != 0 {
            record.field_flags |= bits;
        } else {
            record.field_flags &= !bits;
        }
    }

    /// v->mb_type of a grid block: whether it is intra
    pub fn grid_is_intra(&self, index: i32) -> bool {
        if self.grid_is_padding(index) {
            return false;
        }
        (self.grid_record(index).flags >> Self::grid_block(index)) & 1 != 0
    }

    pub fn set_block_intra(&mut self, block: u32, intra: bool) {
        let bit: u32 = 1 << block;
        let record: &mut MacroblockRecord = self.current_record();
        if intra {
            record.flags |= bit;
        } else {
            record.flags &= !bit;
        }
    }

    pub fn set_all_blocks_intra(&mut self, intra: bool) {
        let record: &mut MacroblockRecord = self.current_record();
        record.flags &= !MB_INTRA_BLOCKS_MASK;
        if intra {
            record.flags |= MB_INTRA_BLOCKS_MASK;
        }
    }

    /// Sets v->blk_mv_type of every luma block: whether its motion vector is a field motion vector
    pub fn set_block_motion_types(&mut self, field_motion: u32) {
        let record: &mut MacroblockRecord = self.current_record();
        record.flags &= !(15 << MB_BLOCK_MV_TYPE_SHIFT);
        if field_motion != 0 {
            record.flags |= 15 << MB_BLOCK_MV_TYPE_SHIFT;
        }
    }

    pub fn set_macroblock_quantizer(&mut self, quantizer: i32) {
        self.current_record().quantizer = quantizer;
    }

    /// The bitplane bit of the current macroblock, or the raw bit the macroblock layer reads
    pub fn plane_bit(&mut self, state: u32, plane: u8) -> u32 {
        match state {
            PLANE_RAW => self.reader.read_bit(),
            PLANE_DECODED => {
                let index: usize = (self.frame_row * self.mb_width + self.mb_x) as usize;
                u32::from(self.planes.get(index).is_some_and(|&byte: &u8| byte & plane != 0))
            }
            _ => 0,
        }
    }

    pub fn current_motion_vector(&self, direction: usize, block: usize) -> [i32; 2] {
        self.motion_vectors[direction * 4 + block]
    }

    pub fn set_current_motion_vector(&mut self, direction: usize, block: usize, vector: [i32; 2]) {
        self.motion_vectors[direction * 4 + block] = vector;
    }

    pub fn is_intra_picture(&self) -> bool {
        self.unit.picture_type == TYPE_I || self.unit.picture_type == TYPE_BI
    }

    /// Clears the macroblock at mb_x, mb_y for decoding
    fn begin_macroblock(&mut self) {
        self.current = ((self.mb_y - self.unit.start_row) * self.mb_width + self.mb_x) as usize;
        self.records[self.current] = MacroblockRecord::EMPTY;
        self.block_entries = [[0; BLOCK_ENTRY_COUNT]; BLOCK_COUNT];
        self.mb_intra = false;
        self.ac_pred = false;
    }

    /// Prepares the macroblock at mb_x, mb_y; a failure stops the unit.
    fn begin_unit_macroblock(&mut self) -> Result<(), DecodeError> {
        self.frame_row = self.unit.row_offset + self.mb_y;
        self.begin_macroblock();
        self.ref_field_type[0] = self.unit.ref_field_type_forward;
        self.motion_vectors = [[0; 2]; 8];
        // vc1_decode_p_blocks and vc1_decode_b_blocks stop a slice whose raw bitplanes leave no bits
        let raw_planes: bool = self.unit.fcm == FCM_FIELD
            || self.unit.plane_skip == PLANE_RAW
            || self.unit.plane_direct == PLANE_RAW
            || (self.unit.fcm == FCM_PROGRESSIVE && self.unit.plane_mvtype == PLANE_RAW && self.unit.picture_type == TYPE_P);
        if raw_planes && !self.is_intra_picture() && self.reader.bits_left() < 1 {
            return Err(DecodeError { code: ERROR_BITS_EXHAUSTED, value: self.frame_row * self.mb_width + self.mb_x });
        }
        Ok(())
    }

    /// The anchor motion of an I or P picture's macroblock for later B pictures: motion_val[1] of blocks 0 and 2, the dir-0 field flags,
    /// and whether it is intra.
    fn store_anchor_motion(&self, output: &mut UnitOutput) {
        let record: &MacroblockRecord = &self.records[self.current];
        let intra: bool = record.is_intra == MB_INTRA_BLOCKS_MASK || record.flags & MB_INTRA_BLOCKS_MASK == MB_INTRA_BLOCKS_MASK;
        let flags: u32 = (record.field_flags & 0xF) | if intra { ANCHOR_INTRA } else { 0 };
        output.anchor_words.extend_from_slice(&[record.motion_vectors[1][0], record.motion_vectors[1][2], flags]);
    }

    /// Records the decoded macroblock and moves to the next, as ff_vc1_decode_blocks walks a slice; Ok(false) once the unit ended.
    fn finish_unit_macroblock(&mut self, output: &mut UnitOutput) -> Result<bool, DecodeError> {
        let mut flags: u32 = MB_DECODED_BIT | if self.ac_pred { MB_ACPRED_BIT } else { 0 };
        if self.mb_y == self.unit.start_row {
            flags |= MACROBLOCK_SLICE_TOP_BIT;
        }
        if self.mb_y + 1 == self.unit.end_row {
            flags |= MACROBLOCK_SLICE_BOTTOM_BIT;
        }
        self.current_record().flags |= flags;
        let failure_value: u32 = self.frame_row * self.mb_width + self.mb_x;
        if self.macroblock_failed || self.reader.found_invalid_code() {
            return Err(DecodeError { code: ERROR_MACROBLOCK_LAYER, value: failure_value });
        }
        if self.reader.overran() {
            return Err(DecodeError { code: ERROR_BITS_EXHAUSTED, value: failure_value });
        }
        self.predict_intra_macroblock();
        let length_before: usize = output.macroblock_words.len();
        self.write_macroblock_words(&mut output.macroblock_words);
        output.macroblock_lengths[self.current] = (output.macroblock_words.len() - length_before) as u32;
        if self.unit.picture_type == TYPE_I || self.unit.picture_type == TYPE_P {
            self.store_anchor_motion(output);
        }
        self.mb_x += 1;
        if self.mb_x == self.mb_width {
            self.mb_x = 0;
            self.mb_y += 1;
            self.first_slice_line = false;
        }
        Ok(self.mb_y < self.unit.end_row)
    }

    /// Appends the current macroblock's record words and its coefficient entries, block by block.
    fn write_macroblock_words(&self, output: &mut Vec<u32>) {
        let record: &MacroblockRecord = &self.records[self.current];
        record.write_record_words(output);
        for block in 0..BLOCK_COUNT {
            let count: usize = record.block_count(block) as usize;
            output.extend_from_slice(&self.block_entries[block][..count]);
        }
    }

    /// Decodes the unit's macroblocks with its picture kind's macroblock decoder; the first failure ends the unit.
    pub fn parse(mut self, unit_index: u32) -> UnitOutput {
        let row_count: u32 = self.unit.end_row.saturating_sub(self.unit.start_row);
        let mut output: UnitOutput = UnitOutput {
            unit_index,
            macroblock_lengths: vec![0; (row_count * self.mb_width) as usize],
            ..UnitOutput::default()
        };
        if row_count == 0 || self.mb_width == 0 {
            return output;
        }
        let anchor: bool = self.unit.picture_type == TYPE_I || self.unit.picture_type == TYPE_P;
        if anchor {
            output.anchor_words.reserve((row_count * self.mb_width) as usize * ANCHOR_WORDS_PER_MACROBLOCK);
        }
        let result: Result<(), DecodeError> = self.parse_macroblocks(&mut output);
        if let Err(error) = result {
            output.error_word = error.word();
            // A failed unit leaves no anchor motion; the picture fails as a whole
            output.anchor_words.clear();
        }
        output
    }

    fn parse_macroblocks(&mut self, output: &mut UnitOutput) -> Result<(), DecodeError> {
        loop {
            self.begin_unit_macroblock()?;
            match (self.unit.picture_type, self.unit.fcm) {
                (TYPE_I | TYPE_BI, _) => {
                    if self.sequence.profile == crate::layout::PROFILE_ADVANCED {
                        self.decode_advanced_intra_macroblock();
                    } else {
                        self.decode_simple_intra_macroblock();
                    }
                }
                (TYPE_P, FCM_FIELD) => self.decode_field_p_macroblock(),
                (TYPE_P, FCM_FRAME) => self.decode_interlaced_frame_p_macroblock(),
                (TYPE_P, _) => self.decode_p_macroblock(),
                (TYPE_B, FCM_FIELD) => self.decode_field_b_macroblock(),
                (TYPE_B, FCM_FRAME) => self.decode_interlaced_frame_b_macroblock(),
                _ => self.decode_b_macroblock(),
            }
            if !self.finish_unit_macroblock(output)? {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LUMA_OPERATION_SLOTS;

    const FLAGS: u32 = 0x3F | MACROBLOCK_SLICE_TOP_BIT;
    const PACKED_VECTOR: u32 = 0x0004_FFFC;
    const UNPACKED_VECTOR: [i32; 2] = [-4, 4];
    const FIRST_COUNT_BLOCK: usize = 1;
    const FIRST_COUNT: u32 = 17;
    const CHROMA_COUNT_BLOCK: usize = 5;
    const CHROMA_COUNT: u32 = 64;
    const LUMA_SLOT: usize = 2;
    const CHROMA_SLOT: usize = LUMA_OPERATION_SLOTS as usize + 1;
    const LUMA_OPERATION: [u32; 2] = [0x11, 0x22];
    const CHROMA_OPERATION: [u32; 2] = [0x33, 0x44];

    #[test]
    fn packs_vectors_and_counts_as_the_record_reads_them() {
        assert_eq!(pack_motion_vector(UNPACKED_VECTOR), PACKED_VECTOR);
        assert_eq!(unpack_motion_vector(PACKED_VECTOR), UNPACKED_VECTOR);
        let mut record: MacroblockRecord = MacroblockRecord::EMPTY;
        record.set_block_count(FIRST_COUNT_BLOCK, FIRST_COUNT);
        record.set_block_count(CHROMA_COUNT_BLOCK, CHROMA_COUNT);

        assert_eq!(record.block_count(FIRST_COUNT_BLOCK), FIRST_COUNT);
        assert_eq!(record.block_count(CHROMA_COUNT_BLOCK), CHROMA_COUNT);
        assert_eq!(record.counts, [FIRST_COUNT << 8, CHROMA_COUNT << 8]);
    }

    #[test]
    fn writes_its_fixed_words_then_its_present_operations_in_slot_order() {
        let mut record: MacroblockRecord = MacroblockRecord::EMPTY;
        record.flags = FLAGS;
        record.motion_vectors[0][1] = PACKED_VECTOR;
        record.operations = (1 << LUMA_SLOT) | (1 << CHROMA_SLOT);
        record.operation_words[LUMA_SLOT] = LUMA_OPERATION;
        record.operation_words[CHROMA_SLOT] = CHROMA_OPERATION;
        let mut words: Vec<u32> = Vec::new();
        record.write_record_words(&mut words);

        let fixed: usize = MACROBLOCK_FIXED_WORDS as usize;
        assert_eq!(words.len(), fixed + 2 * OPERATION_WORDS as usize);
        assert_eq!(words[MACROBLOCK_FLAGS as usize], FLAGS);
        assert_eq!(words[MACROBLOCK_MV0 as usize + 1], PACKED_VECTOR);
        assert_eq!(words[MACROBLOCK_OPERATIONS as usize], record.operations);
        assert_eq!(words[fixed..], [LUMA_OPERATION, CHROMA_OPERATION].concat());
    }

    #[test]
    fn takes_the_median_of_three_and_the_truncated_mean_of_the_middle_two_of_four() {
        assert_eq!(median_of_three(3, -1, 7), 3);
        assert_eq!(median_of_four(-3, 4, 1, 10), 2);
        assert_eq!(median_of_four(-3, -4, 0, 10), -1);
        assert_eq!(wrap_int16(0x1_8000), -0x8000);
    }
}
