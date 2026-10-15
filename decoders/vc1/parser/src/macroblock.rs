// The macroblock decoders of each picture kind and their blocks' coefficients, as FFmpeg's vc1_block.c decodes them: I macroblocks of
// the Simple, Main, and Advanced profiles, and P and B macroblocks of progressive, field, and interlaced frame pictures.
// Intra blocks leave their DC differential and their AC levels by scan index, which intra prediction scans and dequantizes; inter
// blocks leave their dequantized coefficients at their raster positions.

use crate::header::{DQPROFILE_ALL_MBS, DQPROFILE_DOUBLE_EDGES, DQPROFILE_FOUR_EDGES, DQPROFILE_SINGLE_EDGE, PLANE_ACPRED, PLANE_DECODED,
    PLANE_DIRECT, PLANE_FIELDTX, PLANE_FORWARD, PLANE_MVTYPE, PLANE_OVERFLAGS, PLANE_RAW, PLANE_SKIP};
use crate::layout::{
    COEFFICIENT_POSITION_SHIFT, CONDOVER_SELECT, FCM_PROGRESSIVE, MACROBLOCK_FIELDTX_BIT, MACROBLOCK_OVERFLAG_BIT, PROFILE_ADVANCED,
    TRANSFORM_4X4, TRANSFORM_4X8, TRANSFORM_8X4, TRANSFORM_8X8, TRANSFORM_CODED_SHIFT, TRANSFORM_DC_ONLY_SHIFT, TRANSFORM_PRESENT_BIT, TT_4X4,
    TT_4X8, TT_4X8_LEFT, TT_4X8_RIGHT, TT_8X4, TT_8X4_BOTTOM, TT_8X4_TOP, TT_8X8,
};
use crate::tables::{
    AC_DELTA_LEVEL, AC_DELTA_RUN, AC_LAST_DELTA_LEVEL, AC_LAST_DELTA_RUN, MBMODE_INTFRP, MV_OFFSET_TABLE, MV_SIZE_TABLE, SCAN_4X4_INTERLACED,
    SCAN_4X4_PROGRESSIVE, SCAN_4X8_ADVANCED, SCAN_4X8_INTERLACED, SCAN_4X8_SIMPLE, SCAN_8X4_ADVANCED, SCAN_8X4_INTERLACED, SCAN_8X4_SIMPLE,
    SCAN_8X8, TTBLK_TO_TT,
};
use crate::unit::{BLOCK_COUNT, MB_INTRA_CODED_SHIFT, MB_SKIPPED_BIT, UnitParser, wrap_int16};
use crate::vlc::{INVALID_SYMBOL, VLCLookup};

// Interlaced frame macroblock types, FFmpeg's MV_PMODE_INTFR_*
pub const FRAME_MB_1MV: u32 = 0;
pub const FRAME_MB_2MV_FIELD: u32 = 1;
pub const FRAME_MB_4MV_FIELD: u32 = 3;
pub const FRAME_MB_4MV: u32 = 4;
pub const FRAME_MB_INTRA: u32 = 5;
// Fields of an interlaced frame macroblock mode: the type, then FIELDTX, a coded vector, and coded blocks
const FRAME_MODE_TYPE_MASK: u32 = 15;
const FRAME_MODE_FIELDTX_SHIFT: u32 = 4;
const FRAME_MODE_MOTION_SHIFT: u32 = 5;
const FRAME_MODE_CODED_SHIFT: u32 = 6;
// The interlaced frame macroblock modes of one table
const FRAME_MODE_TABLE_SIZE: usize = 15;

// B macroblock prediction types, FFmpeg's BMV_TYPE_*
pub const BMV_BACKWARD: u32 = 0;
pub const BMV_FORWARD: u32 = 1;
pub const BMV_INTERPOLATED: u32 = 2;
pub const BMV_DIRECT: u32 = 3;
// BFRACTION at or above this predicts a B macroblock's single direction backward first
const BFRACTION_HALF: i32 = 128;

// Fields of an AC symbol
const AC_RUN_MASK: u32 = 63;
const AC_LEVEL_SHIFT: u32 = 6;
const AC_LEVEL_MASK: u32 = 63;
const AC_LAST_BIT: u32 = 4096;
const AC_ESCAPE_BIT: u32 = 8192;
// The entries of each coding set in the escape tables
const AC_DELTA_LEVEL_LENGTH: u32 = 31;
const AC_LAST_DELTA_LEVEL_LENGTH: u32 = 44;
const AC_DELTA_RUN_LENGTH: u32 = 57;
const AC_LAST_DELTA_RUN_LENGTH: u32 = 10;
// The third escape mode's level lengths: three bits, else two plus this, and the run length's base
const ESCAPE_LEVEL_LENGTH_BASE: u32 = 8;
const ESCAPE_RUN_LENGTH_BASE: u32 = 3;
const ESCAPE_UNARY_LEVEL_BASE: u32 = 2;
// The picture quantizer below which the third escape mode codes its level length in three bits
const ESCAPE_FIXED_LENGTH_PQUANT: u32 = 8;
// The last AC scan position of an 8x8 block
const LAST_SCAN_POSITION: u32 = 63;

// The DC differential's escape symbol
const DC_ESCAPE_SYMBOL: i32 = 119;
// MVDATA symbols: the coefficient flag adds this, and the escape and intra symbols
const MV_DIFFERENTIAL_CODED_OFFSET: u32 = 37;
const MV_DIFFERENTIAL_ESCAPE: u32 = 35;
const MV_DIFFERENTIAL_INTRA: u32 = 36;
const MV_DIFFERENTIAL_HALF_SAMPLE_SIZE_INDEX: u32 = 5;
const MV_OFFSET_EXTENDED_BASE: u32 = 9;
// The MVDATA escapes of interlaced pictures with one and two references
const ONE_REFERENCE_ESCAPE: u32 = 71;
const TWO_REFERENCE_ESCAPE: u32 = 125;
const INTERLACED_MVDATA_GROUP: u32 = 9;
// The field macroblock modes that are intra, and the last 1MV mode
const FIELD_MODE_LAST_INTRA: u32 = 1;
const FIELD_MODE_LAST_ONE_VECTOR: u32 = 5;

// Coded block pattern bits are in raster block order from bit 5 down
const CBP_TOP_BIT: u32 = 5;
// Every block's coded pattern of an intra macroblock: four bits each
const INTRA_BLOCK_CBP: u32 = 0xF;
const INTRA_MACROBLOCK_CBP: u32 = 0xFF_FFFF;
// A macroblock quantizer outside +-31 or zero is replaced
const MAXIMUM_QUANTIZER: i32 = 31;
// The 4MV chroma blocks are intra when this many luma blocks are
const CHROMA_INTRA_LUMA_COUNT: u32 = 3;

/// A progressive MVDATA: the differential, whether coefficients follow, and the intra escape.
#[derive(Clone, Copy, Default)]
pub struct MotionVectorData {
    pub differential: [i32; 2],
    pub has_coefficients: bool,
    pub intra: bool,
}

/// One AC coefficient: its run, its signed level, and whether it is the block's last.
#[derive(Clone, Copy)]
struct ACCoefficient {
    run: u32,
    level: i32,
    last: bool,
}

const FAILED_COEFFICIENT: ACCoefficient = ACCoefficient { run: 0, level: 0, last: true };

/// The scan of a subblock transform: FFmpeg's zz tables by transform, coding mode, and profile.
fn subblock_scan_table(transform: u32, progressive: bool, advanced: bool) -> &'static [u8] {
    const INTERLACED_8X8_SCAN: usize = 4;
    const SCAN_LENGTH: usize = 64;
    match transform {
        TRANSFORM_8X8 => {
            if progressive {
                &SCAN_8X8[..SCAN_LENGTH]
            } else {
                &SCAN_8X8[INTERLACED_8X8_SCAN * SCAN_LENGTH..]
            }
        }
        TRANSFORM_4X4 => {
            if progressive {
                &SCAN_4X4_PROGRESSIVE
            } else {
                &SCAN_4X4_INTERLACED
            }
        }
        TRANSFORM_8X4 => match (progressive, advanced) {
            (false, _) => &SCAN_8X4_INTERLACED,
            (true, true) => &SCAN_8X4_ADVANCED,
            (true, false) => &SCAN_8X4_SIMPLE,
        },
        _ => match (progressive, advanced) {
            (false, _) => &SCAN_4X8_INTERLACED,
            (true, true) => &SCAN_4X8_ADVANCED,
            (true, false) => &SCAN_4X8_SIMPLE,
        },
    }
}

/// The coded blocks of a CBPCY in block order, bit n for block n.
fn coded_block_mask(cbp: u32) -> u32 {
    let mut mask: u32 = 0;
    for block in 0..BLOCK_COUNT as u32 {
        mask |= ((cbp >> (CBP_TOP_BIT - block)) & 1) << block;
    }
    mask
}

impl UnitParser<'_> {
    /// FFmpeg's GET_MQUANT
    pub fn read_macroblock_quantizer(&mut self, initial: i32) -> i32 {
        let mut mquant: i32 = initial;
        if self.unit.dquantfrm == 0 {
            return mquant;
        }
        let pq: i32 = self.unit.pq as i32;
        let altpq: i32 = self.unit.altpq as i32;
        if self.unit.dqprofile == DQPROFILE_ALL_MBS {
            if self.unit.dqbilevel != 0 {
                mquant = if self.reader.read_flag() { -altpq } else { pq };
            } else {
                let mqdiff: u32 = self.reader.read_bits(3);
                mquant = if mqdiff != 7 { -pq - mqdiff as i32 } else { -(self.reader.read_bits(5) as i32) };
            }
        }
        let edges: u32 = match self.unit.dqprofile {
            DQPROFILE_SINGLE_EDGE => 1 << self.unit.dqsbedge,
            DQPROFILE_DOUBLE_EDGES => (3 << self.unit.dqsbedge) % 15,
            DQPROFILE_FOUR_EDGES => 15,
            _ => 0,
        };
        if edges & 1 != 0 && self.mb_x == 0 {
            mquant = -altpq;
        }
        if edges & 2 != 0 && self.mb_y == 0 {
            mquant = -altpq;
        }
        if edges & 4 != 0 && self.mb_x == self.mb_width - 1 {
            mquant = -altpq;
        }
        if edges & 8 != 0 && self.mb_y == (self.mb_height >> self.unit.field_mode) - 1 {
            mquant = -altpq;
        }
        if mquant == 0 || !(-MAXIMUM_QUANTIZER..=MAXIMUM_QUANTIZER).contains(&mquant) {
            mquant = 1;
        }
        mquant
    }

    fn read_motion_vector_component(&mut self, index: u32) -> i32 {
        let mut value: i32 = MV_OFFSET_TABLE[(MV_OFFSET_EXTENDED_BASE + index) as usize];
        let mut size: i32 = MV_SIZE_TABLE[index as usize];
        if self.unit.quarter_sample == 0 && index == MV_DIFFERENTIAL_HALF_SAMPLE_SIZE_INDEX {
            size -= 1;
        }
        if size > 0 {
            let bits: u32 = self.reader.read_bits(size as u32);
            let sign: i32 = -((bits & 1) as i32);
            value = (sign ^ ((bits >> 1) as i32 + value)) - sign;
        }
        value
    }

    /// FFmpeg's GET_MVDATA for progressive pictures
    pub fn read_motion_vector_data(&mut self) -> MotionVectorData {
        let mut result: MotionVectorData = MotionVectorData::default();
        let lookup: &VLCLookup = &self.lookups.mv_differential[self.unit.mv_table_index as usize & 3];
        let mut index: u32 = 1u32.wrapping_add(self.reader.read_code(lookup));
        if index > MV_DIFFERENTIAL_INTRA {
            result.has_coefficients = true;
            index -= MV_DIFFERENTIAL_CODED_OFFSET;
        }
        if index == 0 {
            return result;
        }
        if index == MV_DIFFERENTIAL_ESCAPE {
            let quarter: u32 = self.unit.quarter_sample;
            let x: u32 = self.reader.read_bits(self.unit.k_x - 1 + quarter);
            let y: u32 = self.reader.read_bits(self.unit.k_y - 1 + quarter);
            result.differential = [x as i32, y as i32];
            return result;
        }
        if index == MV_DIFFERENTIAL_INTRA {
            result.intra = true;
            return result;
        }
        if index > MV_DIFFERENTIAL_INTRA {
            self.macroblock_failed = true;
            return result;
        }
        let x: i32 = self.read_motion_vector_component(index % 6);
        let y: i32 = self.read_motion_vector_component(index / 6);
        result.differential = [x, y];
        result
    }

    /// FFmpeg's get_mvdata_interlaced: the differential and, with two references, the predictor flag
    pub fn read_interlaced_motion_vector_data(&mut self) -> ([i32; 2], i32) {
        let extend_x: u32 = self.unit.dmvrange & 1;
        let extend_y: u32 = (self.unit.dmvrange >> 1) & 1;
        let numref: u32 = self.unit.numref;
        let escape: u32 = if numref != 0 { TWO_REFERENCE_ESCAPE } else { ONE_REFERENCE_ESCAPE };
        let index: u32 = self.reader.read_code(self.imv_lookup);
        let mut x: i32 = 0;
        let mut y: i32 = 0;
        let mut predictor_flag: i32 = 0;
        if index == escape {
            x = self.reader.read_bits(self.unit.k_x) as i32;
            y = self.reader.read_bits(self.unit.k_y) as i32;
            if numref != 0 {
                predictor_flag = y & 1;
                y = (y + (y & 1)) >> 1;
            }
            return ([x, y], predictor_flag);
        }
        if index > escape {
            self.macroblock_failed = true;
            return ([0, 0], 0);
        }
        let mut index1: u32 = (index + 1) % INTERLACED_MVDATA_GROUP;
        if index1 != 0 {
            let value: u32 = self.reader.read_bits(index1 + extend_x);
            let sign: i32 = -((value & 1) as i32);
            x = (sign ^ ((value >> 1) as i32 + MV_OFFSET_TABLE[(extend_x * MV_OFFSET_EXTENDED_BASE + index1) as usize])) - sign;
        }
        index1 = (index + 1) / INTERLACED_MVDATA_GROUP;
        if index1 > numref {
            let value: u32 = self.reader.read_bits((index1 >> numref) + extend_y);
            let sign: i32 = -((value & 1) as i32);
            y = (sign ^ ((value >> 1) as i32 + MV_OFFSET_TABLE[(extend_y * MV_OFFSET_EXTENDED_BASE + (index1 >> numref)) as usize])) - sign;
        }
        if numref != 0 {
            predictor_flag = (index1 & 1) as i32;
        }
        ([x, y], predictor_flag)
    }

    /// FFmpeg's vc1_decode_ac_coeff; a failure marks the macroblock
    fn read_ac_coefficient(&mut self, coding_set: u32, lookup: &VLCLookup) -> ACCoefficient {
        let mut symbol: u32 = self.reader.read_code(lookup);
        if symbol == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return FAILED_COEFFICIENT;
        }
        let mut run: u32;
        let mut level: u32;
        let last: bool;
        let sign: u32;
        if symbol & AC_ESCAPE_BIT == 0 {
            run = symbol & AC_RUN_MASK;
            level = (symbol >> AC_LEVEL_SHIFT) & AC_LEVEL_MASK;
            // FFmpeg's last also holds once the code ran past the segment's end
            last = symbol & AC_LAST_BIT != 0 || self.reader.bits_left() < 0;
            sign = self.reader.read_bit();
        } else {
            let escape: u32 = self.reader.read_decode210();
            if escape != 2 {
                symbol = self.reader.read_code(lookup);
                if symbol == INVALID_SYMBOL || symbol & AC_ESCAPE_BIT != 0 {
                    self.macroblock_failed = true;
                    return FAILED_COEFFICIENT;
                }
                run = symbol & AC_RUN_MASK;
                level = (symbol >> AC_LEVEL_SHIFT) & AC_LEVEL_MASK;
                last = symbol & AC_LAST_BIT != 0;
                if escape == 0 {
                    level += u32::from(if last {
                        AC_LAST_DELTA_LEVEL[(coding_set * AC_LAST_DELTA_LEVEL_LENGTH + run) as usize]
                    } else {
                        AC_DELTA_LEVEL[(coding_set * AC_DELTA_LEVEL_LENGTH + run) as usize]
                    });
                } else {
                    run += u32::from(if last {
                        AC_LAST_DELTA_RUN[(coding_set * AC_LAST_DELTA_RUN_LENGTH + level) as usize]
                    } else {
                        AC_DELTA_RUN[(coding_set * AC_DELTA_RUN_LENGTH + level) as usize]
                    }) + 1;
                }
                sign = self.reader.read_bit();
            } else {
                last = self.reader.read_flag();
                if self.esc3_level_length == 0 {
                    if self.unit.pq < ESCAPE_FIXED_LENGTH_PQUANT || self.unit.dquantfrm != 0 {
                        self.esc3_level_length = self.reader.read_bits(3);
                        if self.esc3_level_length == 0 {
                            self.esc3_level_length = self.reader.read_bits(2) + ESCAPE_LEVEL_LENGTH_BASE;
                        }
                    } else {
                        self.esc3_level_length = self.reader.read_unary(1, 6) + ESCAPE_UNARY_LEVEL_BASE;
                    }
                    self.esc3_run_length = ESCAPE_RUN_LENGTH_BASE + self.reader.read_bits(2);
                }
                run = self.reader.read_bits(self.esc3_run_length);
                sign = self.reader.read_bit();
                level = self.reader.read_bits(self.esc3_level_length);
            }
        }
        let sign_mask: i32 = -(sign as i32);
        ACCoefficient { run, level: (level as i32 ^ sign_mask) - sign_mask, last }
    }

    /// Reads the DC differential of a block with quantizer quant
    fn read_dc_differential(&mut self, block: usize, quant: u32) -> i32 {
        let component: usize = usize::from(block >= 4);
        let lookup: &VLCLookup = &self.lookups.dc_differential[self.unit.dc_table_index as usize * 2 + component];
        let symbol: u32 = self.reader.read_code(lookup);
        if symbol == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return 0;
        }
        let mut dcdiff: i32 = symbol as i32;
        if dcdiff != 0 {
            let extra: u32 = if quant == 1 || quant == 2 { 3 - quant } else { 0 };
            if dcdiff == DC_ESCAPE_SYMBOL {
                dcdiff = self.reader.read_bits(8 + extra) as i32;
            } else if extra != 0 {
                dcdiff = (dcdiff << extra) + self.reader.read_bits(extra) as i32 - ((1 << extra) - 1);
            }
            if self.reader.read_flag() {
                dcdiff = -dcdiff;
            }
        }
        dcdiff
    }

    /// An intra block's parse: its DC differential into its DC predictor and its AC levels by scan index into its entries, since no bit
    /// depends on prediction; intra prediction predicts, scans, and dequantizes them once the macroblock is decoded
    pub fn decode_intra_block_levels(&mut self, block: usize, coded: bool, coding_set: u32, quant: u32) {
        let dc: i32 = self.read_dc_differential(block, quant);
        self.records[self.current].predictions[block][0] = dc as u32 & 0xFFFF;
        let mut count: usize = 0;
        if coded {
            let lookup: &'static VLCLookup = &self.lookups.ac_coefficients[coding_set as usize & 7];
            let mut position: u32 = 1;
            loop {
                let coefficient: ACCoefficient = self.read_ac_coefficient(coding_set, lookup);
                position += coefficient.run;
                if position > LAST_SCAN_POSITION || self.macroblock_failed {
                    break;
                }
                self.block_entries[block][count] = (position << COEFFICIENT_POSITION_SHIFT) | (coefficient.level as u32 & 0xFFFF);
                count += 1;
                if coefficient.last {
                    break;
                }
                position += 1;
            }
            self.records[self.current].flags |= 1 << (MB_INTRA_CODED_SHIFT + block as u32);
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.set_block_count(block, count as u32);
        record.set_block_transform(block, TRANSFORM_PRESENT_BIT | TRANSFORM_8X8 | (15 << TRANSFORM_CODED_SHIFT));
    }

    /// FFmpeg's vc1_decode_p_block: an inter block's transform type, subblock pattern, and coefficients.
    /// ttmb is the macroblock's transform type, -1 when each block codes its own; returns the coded subblock pattern and the block's
    /// transform type
    fn decode_inter_block(&mut self, block: usize, mquant: i32, ttmb: i32, first_block: bool) -> (u32, u32) {
        let quant: i32 = mquant.abs();
        let tt_index: usize = self.unit.tt_index as usize;
        let mut ttblk: u32 = (ttmb & 7) as u32;
        let mut subblkpat: u32 = 0;
        if ttmb == -1 {
            let symbol: u32 = self.reader.read_code(&self.lookups.ttblk[tt_index]);
            if symbol == INVALID_SYMBOL {
                self.macroblock_failed = true;
                return (0, 0);
            }
            ttblk = u32::from(TTBLK_TO_TT[tt_index * 8 + symbol as usize]);
        }
        if ttblk == TT_4X4 {
            let symbol: u32 = self.reader.read_code(&self.lookups.subblock_pattern[tt_index]);
            if symbol == INVALID_SYMBOL {
                self.macroblock_failed = true;
                return (0, 0);
            }
            subblkpat = !(symbol + 1);
        }
        let signal_per_block: bool = self.unit.ttmbf != 0 || (ttmb != -1 && ttmb & 8 != 0 && !first_block);
        if ttblk != TT_8X8 && ttblk != TT_4X4 && (signal_per_block || (self.sequence.res_rtm_flag == 0 && !first_block)) {
            subblkpat = self.reader.read_decode012();
            if subblkpat != 0 {
                subblkpat ^= 3;
            }
            if ttblk == TT_8X4_TOP || ttblk == TT_8X4_BOTTOM {
                ttblk = TT_8X4;
            }
            if ttblk == TT_4X8_RIGHT || ttblk == TT_4X8_LEFT {
                ttblk = TT_4X8;
            }
        }
        let scale: i32 = quant * 2 + if mquant < 0 { 0 } else { self.unit.halfpq as i32 };
        if ttblk == TT_8X4_TOP || ttblk == TT_8X4_BOTTOM {
            subblkpat = 2 - u32::from(ttblk == TT_8X4_TOP);
            ttblk = TT_8X4;
        }
        if ttblk == TT_4X8_RIGHT || ttblk == TT_4X8_LEFT {
            subblkpat = 2 - u32::from(ttblk == TT_4X8_LEFT);
            ttblk = TT_4X8;
        }
        // The transform's subblocks: their count, the pattern bits that skip them, and their raster offsets
        let (pattern, transform, subblocks): (u32, u32, u32) = match ttblk {
            TT_8X8 => {
                subblkpat = 0;
                (0xF, TRANSFORM_8X8, 1)
            }
            TT_4X4 => (!subblkpat & 0xF, TRANSFORM_4X4, 4),
            TT_8X4 => (!((subblkpat & 2) * 6 + (subblkpat & 1) * 3) & 0xF, TRANSFORM_8X4, 2),
            _ => (!(subblkpat.wrapping_mul(5)) & 0xF, TRANSFORM_4X8, 2),
        };
        let mut entry_count: usize = 0;
        let mut coded: u32 = 0;
        let mut dc_only: u32 = 0;
        for subblock in 0..subblocks {
            if (subblkpat >> (subblocks - 1 - subblock)) & 1 != 0 {
                continue;
            }
            let offset: u32 = match transform {
                TRANSFORM_4X4 => (subblock & 1) * 4 + (subblock & 2) * 16,
                TRANSFORM_8X4 => subblock * 32,
                TRANSFORM_4X8 => subblock * 4,
                _ => 0,
            };
            coded |= 1 << subblock;
            let last: u32 = self.decode_subblock(block, &mut entry_count, transform, offset, scale, quant);
            if last == 1 {
                dc_only |= 1 << subblock;
            }
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.set_block_count(block, entry_count as u32);
        record.set_block_transform(
            block,
            TRANSFORM_PRESENT_BIT | transform | (coded << TRANSFORM_CODED_SHIFT) | (dc_only << TRANSFORM_DC_ONLY_SHIFT),
        );
        (pattern, ttblk)
    }

    /// Decodes one subblock's coefficients at a raster offset; returns the position after the last coefficient, FFmpeg's i
    fn decode_subblock(&mut self, block: usize, entry_count: &mut usize, transform: u32, offset: u32, scale: i32, quant: i32) -> u32 {
        let limit: u32 = match transform {
            TRANSFORM_8X8 => 64,
            TRANSFORM_4X4 => 16,
            _ => 32,
        };
        let scan: &'static [u8] =
            subblock_scan_table(transform, self.unit.fcm == FCM_PROGRESSIVE, self.sequence.profile == PROFILE_ADVANCED);
        let coding_set: u32 = self.unit.codingset2;
        let lookup: &'static VLCLookup = self.inter_ac_lookup;
        let mut position: u32 = 0;
        loop {
            let coefficient: ACCoefficient = self.read_ac_coefficient(coding_set, lookup);
            position += coefficient.run;
            if position >= limit || self.macroblock_failed {
                break;
            }
            let natural: u32 = u32::from(scan[position as usize]) + offset;
            position += 1;
            // Positions never repeat within a block, so each nonzero value is its own entry
            let mut value: i32 = wrap_int16(coefficient.level.wrapping_mul(scale));
            if self.unit.pquantizer == 0 {
                value = wrap_int16(value + if value < 0 { -quant } else { quant });
            }
            if value != 0 {
                self.block_entries[block][*entry_count] = (natural << COEFFICIENT_POSITION_SHIFT) | (value as u32 & 0xFFFF);
                *entry_count += 1;
            }
            if coefficient.last {
                break;
            }
        }
        position
    }

    /// FFmpeg's vc1_coded_block_pred for Simple, Main, and Advanced I pictures
    fn coded_block_at(&self, index: i32) -> u32 {
        if self.grid_is_padding(index) {
            return 0;
        }
        // The row above a unit's first row reads as zero, as FFmpeg clears it when a slice starts
        if (Self::grid_row(index) >> 1) < self.unit.start_row {
            return 0;
        }
        let record: &crate::unit::MacroblockRecord = self.record(Self::grid_column(index) >> 1, Self::grid_row(index) >> 1);
        (record.flags >> (crate::unit::MB_CODED_BLOCK_SHIFT + Self::grid_block(index) as u32)) & 1
    }

    fn predict_coded_block(&mut self, block: u32, difference: u32) -> u32 {
        let xy: i32 = self.block_grid_index(block);
        let left: u32 = self.coded_block_at(xy - 1);
        let top_left: u32 = self.coded_block_at(xy - 1 - crate::unit::GRID_STRIDE);
        let top: u32 = self.coded_block_at(xy - crate::unit::GRID_STRIDE);
        let prediction: u32 = if top_left == top { left } else { top };
        let coded: u32 = prediction ^ difference;
        self.records[self.current].flags |= coded << (crate::unit::MB_CODED_BLOCK_SHIFT + block);
        coded
    }

    /// The availability of the top and left intra neighbors of a block, as FFmpeg's a_avail and c_avail
    fn intra_neighbor_availability(&self, block: u32) -> (bool, bool) {
        let mut top: bool = false;
        let mut left: bool = false;
        let xy: i32 = self.block_grid_index(block);
        if block == 2 || block == 3 || !self.first_slice_line {
            top = if block >= 4 {
                self.mb_y > 0 && (self.record(self.mb_x, self.mb_y - 1).flags >> block) & 1 != 0
            } else {
                self.grid_is_intra(xy - crate::unit::GRID_STRIDE)
            };
        }
        if block == 1 || block == 3 || self.mb_x != 0 {
            left = if block >= 4 {
                self.mb_x > 0 && (self.record(self.mb_x - 1, self.mb_y).flags >> block) & 1 != 0
            } else {
                self.grid_is_intra(xy - 1)
            };
        }
        (top, left)
    }

    /// One I picture macroblock of the Simple and Main profiles, vc1_decode_i_blocks
    pub fn decode_simple_intra_macroblock(&mut self) {
        self.set_all_blocks_intra(true);
        self.set_macroblock_quantizer(self.unit.pq as i32);
        self.records[self.current].is_intra = crate::unit::MB_INTRA_BLOCKS_MASK;
        let mut cbp: u32 = self.reader.read_code(&self.lookups.intra_cbpcy);
        if cbp == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return;
        }
        self.ac_pred = self.reader.read_flag();
        for block in 0..BLOCK_COUNT as u32 {
            let mut value: u32 = (cbp >> (CBP_TOP_BIT - block)) & 1;
            if block < 4 {
                value = self.predict_coded_block(block, value);
            }
            cbp |= value << (CBP_TOP_BIT - block);
            let coding_set: u32 = if block < 4 { self.unit.codingset } else { self.unit.codingset2 };
            self.decode_intra_block_levels(block as usize, value != 0, coding_set, self.unit.pq);
        }
        self.records[self.current].cbp = INTRA_MACROBLOCK_CBP;
    }

    /// One I picture macroblock of the Advanced profile, vc1_decode_i_blocks_adv
    pub fn decode_advanced_intra_macroblock(&mut self) {
        self.set_all_blocks_intra(true);
        self.records[self.current].is_intra = crate::unit::MB_INTRA_BLOCKS_MASK;
        let fieldtx: u32 = match self.unit.plane_fieldtx {
            PLANE_RAW => self.reader.read_bit(),
            PLANE_DECODED => self.plane_bit(PLANE_DECODED, PLANE_FIELDTX),
            _ => 0,
        };
        if self.reader.bits_left() <= 1 {
            self.macroblock_failed = true;
            return;
        }
        let mut cbp: u32 = self.reader.read_code(&self.lookups.intra_cbpcy);
        if cbp == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return;
        }
        self.ac_pred = if self.unit.plane_acpred == PLANE_RAW {
            self.reader.read_flag()
        } else {
            self.plane_bit(self.unit.plane_acpred, PLANE_ACPRED) != 0
        };
        let mut overflag: u32 = 0;
        if self.unit.condover == CONDOVER_SELECT {
            overflag = if self.unit.plane_overflags == PLANE_RAW {
                self.reader.read_bit()
            } else {
                self.plane_bit(self.unit.plane_overflags, PLANE_OVERFLAGS)
            };
        }
        let mquant: i32 = self.read_macroblock_quantizer(self.unit.pq as i32);
        self.set_macroblock_quantizer(mquant);
        if fieldtx != 0 {
            self.records[self.current].flags |= MACROBLOCK_FIELDTX_BIT;
        }
        if overflag != 0 {
            self.records[self.current].flags |= MACROBLOCK_OVERFLAG_BIT;
        }
        for block in 0..BLOCK_COUNT as u32 {
            let mut value: u32 = (cbp >> (CBP_TOP_BIT - block)) & 1;
            if block < 4 {
                value = self.predict_coded_block(block, value);
            }
            cbp |= value << (CBP_TOP_BIT - block);
            let coding_set: u32 = if block < 4 { self.unit.codingset } else { self.unit.codingset2 };
            self.decode_intra_block_levels(block as usize, value != 0, coding_set, mquant.unsigned_abs());
        }
        self.records[self.current].cbp = INTRA_MACROBLOCK_CBP;
    }

    /// Decodes the coded blocks of an inter macroblock, intra blocks among them; returns FFmpeg's block_cbp, block_tt, and block_intra
    fn decode_macroblock_blocks(&mut self, mquant: i32, ttmb_input: i32, intra_mask: u32, coded_mask: u32) -> (u32, u32, u32) {
        let mut ttmb: i32 = ttmb_input;
        let mut first_block: bool = true;
        let mut block_cbp: u32 = 0;
        let mut block_tt: u32 = 0;
        let mut block_intra: u32 = 0;
        for block in 0..BLOCK_COUNT as u32 {
            let coded: bool = (coded_mask >> block) & 1 != 0;
            let intra: bool = (intra_mask >> block) & 1 != 0;
            if intra {
                let coding_set: u32 = if block < 4 { self.unit.codingset } else { self.unit.codingset2 };
                self.decode_intra_block_levels(block as usize, coded, coding_set, mquant.unsigned_abs().min(MAXIMUM_QUANTIZER as u32));
                block_cbp |= INTRA_BLOCK_CBP << (block << 2);
                block_intra |= 1 << block;
            } else if coded {
                let (pattern, ttblk): (u32, u32) = self.decode_inter_block(block as usize, mquant, ttmb, first_block);
                block_cbp |= pattern << (block << 2);
                block_tt |= ttblk << (block * 4);
                if self.unit.ttmbf == 0 && ttmb < 8 {
                    ttmb = -1;
                }
                first_block = false;
            }
            if self.macroblock_failed {
                break;
            }
        }
        (block_cbp, block_tt, block_intra)
    }

    fn read_ttmb(&mut self) -> i32 {
        self.reader.read_code(&self.lookups.ttmb[self.unit.tt_index as usize]) as i32
    }

    /// FFmpeg's vc1_decode_p_mb: progressive P macroblocks
    pub fn decode_p_macroblock(&mut self) {
        let mut mquant: i32 = self.unit.pq as i32;
        let four_motion_vectors: bool = self.plane_bit(self.unit.plane_mvtype, PLANE_MVTYPE) != 0;
        let skipped: bool = self.plane_bit(self.unit.plane_skip, PLANE_SKIP) != 0;
        let mut ttmb: i32 = self.unit.ttfrm as i32;
        let mut block_cbp: u32 = 0;
        let mut block_tt: u32 = 0;
        let mut block_intra: u32 = 0;
        // The block layer of the 1MV and 4MV paths, decoded by one call after them
        let mut decode_blocks: bool = false;
        let mut blocks_intra_mask: u32 = 0;
        let mut blocks_coded_mask: u32 = 0;
        if !four_motion_vectors {
            if !skipped {
                let data: MotionVectorData = self.read_motion_vector_data();
                self.mb_intra = data.intra;
                let has_coefficients: bool = data.has_coefficients;
                self.predict_progressive_motion_vector(0, data.differential, true);
                let cbp: u32;
                if self.mb_intra && !has_coefficients {
                    mquant = self.read_macroblock_quantizer(mquant);
                    self.ac_pred = self.reader.read_flag();
                    cbp = 0;
                } else if has_coefficients {
                    if self.mb_intra {
                        self.ac_pred = self.reader.read_flag();
                    }
                    cbp = self.reader.read_code(self.cbpcy_lookup);
                    mquant = self.read_macroblock_quantizer(mquant);
                } else {
                    mquant = self.unit.pq as i32;
                    cbp = 0;
                }
                self.set_macroblock_quantizer(mquant);
                if self.unit.ttmbf == 0 && !self.mb_intra && has_coefficients {
                    ttmb = self.read_ttmb();
                }
                if !self.mb_intra {
                    self.record_motion_1mv(0);
                }
                if self.mb_intra {
                    self.set_all_blocks_intra(true);
                }
                decode_blocks = true;
                blocks_intra_mask = if self.mb_intra { crate::unit::MB_INTRA_BLOCKS_MASK } else { 0 };
                blocks_coded_mask = coded_block_mask(cbp);
            } else {
                self.mb_intra = false;
                self.records[self.current].flags |= MB_SKIPPED_BIT;
                self.set_macroblock_quantizer(0);
                self.predict_progressive_motion_vector(0, [0, 0], true);
                self.record_motion_1mv(0);
            }
        } else if !skipped {
            let mut intra_count: u32 = 0;
            let mut coded_inter: bool = false;
            let mut intra_mask: u32 = 0;
            let mut coded_mask: u32 = 0;
            let cbp: u32 = self.reader.read_code(self.cbpcy_lookup);
            for block in 0..BLOCK_COUNT as u32 {
                let value: u32 = (cbp >> (CBP_TOP_BIT - block)) & 1;
                self.mb_intra = false;
                let block_is_intra: bool;
                let block_is_coded: bool;
                if block < 4 {
                    let mut data: MotionVectorData = MotionVectorData::default();
                    if value != 0 {
                        data = self.read_motion_vector_data();
                        self.mb_intra = data.intra;
                    }
                    self.predict_progressive_motion_vector(block, data.differential, false);
                    block_is_intra = self.mb_intra;
                    block_is_coded = data.has_coefficients;
                    intra_count += u32::from(self.mb_intra);
                    self.set_block_intra(block, block_is_intra);
                    if !self.mb_intra {
                        self.record_motion_4mv_luma(block, 0, false);
                    }
                } else {
                    block_is_intra = intra_count >= CHROMA_INTRA_LUMA_COUNT;
                    block_is_coded = value != 0;
                    self.set_block_intra(block, block_is_intra);
                }
                if block == 4 {
                    self.record_motion_4mv_chroma(0);
                }
                intra_mask |= u32::from(block_is_intra) << block;
                coded_mask |= u32::from(block_is_coded) << block;
                if !coded_inter {
                    coded_inter = !block_is_intra && block_is_coded;
                }
            }
            if intra_count != 0 || coded_inter {
                mquant = self.read_macroblock_quantizer(mquant);
                self.set_macroblock_quantizer(mquant);
                let mut intra_prediction: bool = false;
                for block in 0..BLOCK_COUNT as u32 {
                    if (intra_mask >> block) & 1 != 0 {
                        let (top, left): (bool, bool) = self.intra_neighbor_availability(block);
                        if top || left {
                            intra_prediction = true;
                            break;
                        }
                    }
                }
                self.ac_pred = intra_prediction && self.reader.read_flag();
                if self.unit.ttmbf == 0 && coded_inter {
                    ttmb = self.read_ttmb();
                }
                decode_blocks = true;
                blocks_intra_mask = intra_mask;
                blocks_coded_mask = coded_mask;
            }
        } else {
            self.mb_intra = false;
            self.records[self.current].flags |= MB_SKIPPED_BIT;
            self.set_macroblock_quantizer(0);
            for block in 0..4 {
                self.predict_progressive_motion_vector(block, [0, 0], false);
                self.record_motion_4mv_luma(block, 0, false);
            }
            self.record_motion_4mv_chroma(0);
        }
        if decode_blocks {
            (block_cbp, block_tt, block_intra) = self.decode_macroblock_blocks(mquant, ttmb, blocks_intra_mask, blocks_coded_mask);
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.cbp = block_cbp;
        record.tt = block_tt;
        record.is_intra = block_intra;
    }

    /// The intra blocks of an interlaced or field macroblock that is intra: every block, each coded by the pattern
    fn decode_intra_macroblock_blocks(&mut self, cbp: u32, mquant: i32) -> u32 {
        let mut block_cbp: u32 = 0;
        for block in 0..BLOCK_COUNT as u32 {
            let coded: bool = (cbp >> (CBP_TOP_BIT - block)) & 1 != 0;
            let coding_set: u32 = if block < 4 { self.unit.codingset } else { self.unit.codingset2 };
            self.decode_intra_block_levels(block as usize, coded, coding_set, mquant.unsigned_abs().min(MAXIMUM_QUANTIZER as u32));
            block_cbp |= INTRA_BLOCK_CBP << (block << 2);
            if self.macroblock_failed {
                break;
            }
        }
        block_cbp
    }

    /// FFmpeg's vc1_decode_p_mb_intfr: interlaced frame P macroblocks
    pub fn decode_interlaced_frame_p_macroblock(&mut self) {
        let mut mquant: i32 = self.unit.pq as i32;
        let mut ttmb: i32 = self.unit.ttfrm as i32;
        let mut cbp: u32 = 0;
        let block_cbp: u32;
        let mut block_tt: u32 = 0;
        let skipped: bool = self.plane_bit(self.unit.plane_skip, PLANE_SKIP) != 0;
        if skipped {
            self.mb_intra = false;
            self.records[self.current].is_intra = 0;
            self.set_all_blocks_intra(false);
            self.records[self.current].flags |= MB_SKIPPED_BIT;
            self.set_macroblock_quantizer(0);
            self.set_block_motion_types(0);
            self.predict_interlaced_frame_motion_vector(0, [0, 0], 1, 0);
            self.record_motion_1mv(0);
            let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
            record.cbp = 0;
            record.tt = 0;
            return;
        }
        let mode: u32 = self.reader.read_code(self.mbmode_lookup);
        if mode == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return;
        }
        let entry: u32 = u32::from(MBMODE_INTFRP[self.unit.fourmvswitch as usize * FRAME_MODE_TABLE_SIZE + mode as usize]);
        let macroblock_type: u32 = entry & FRAME_MODE_TYPE_MASK;
        let mut four_motion_vectors: bool = false;
        let mut two_motion_vectors: bool = false;
        match macroblock_type {
            FRAME_MB_4MV => {
                four_motion_vectors = true;
                self.set_block_motion_types(0);
            }
            FRAME_MB_4MV_FIELD => {
                four_motion_vectors = true;
                self.set_block_motion_types(1);
            }
            FRAME_MB_2MV_FIELD => {
                two_motion_vectors = true;
                self.set_block_motion_types(1);
            }
            FRAME_MB_1MV => self.set_block_motion_types(0),
            _ => {}
        }
        if macroblock_type == FRAME_MB_INTRA {
            for block in 0..4 {
                let index: i32 = self.block_grid_index(block);
                self.set_grid_motion_vector(1, index, [0, 0]);
            }
            self.records[self.current].is_intra = crate::unit::MB_INTRA_BLOCKS_MASK;
            self.mb_intra = true;
            self.set_all_blocks_intra(true);
            if self.reader.read_flag() {
                self.records[self.current].flags |= MACROBLOCK_FIELDTX_BIT;
            }
            if self.reader.read_flag() {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            self.ac_pred = self.reader.read_flag();
            mquant = self.read_macroblock_quantizer(mquant);
            self.set_macroblock_quantizer(mquant);
            block_cbp = self.decode_intra_macroblock_blocks(cbp, mquant);
            if self.macroblock_failed {
                return;
            }
        } else {
            if (entry >> FRAME_MODE_CODED_SHIFT) & 1 != 0 {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            let mut two_pattern: u32 = 0;
            let mut four_pattern: u32 = 0;
            if macroblock_type == FRAME_MB_2MV_FIELD {
                two_pattern = self.reader.read_code(self.two_mv_block_pattern_lookup);
            } else if macroblock_type == FRAME_MB_4MV || macroblock_type == FRAME_MB_4MV_FIELD {
                four_pattern = self.reader.read_code(self.four_mv_block_pattern_lookup);
            }
            self.mb_intra = false;
            self.records[self.current].is_intra = 0;
            self.set_all_blocks_intra(false);
            if (entry >> FRAME_MODE_FIELDTX_SHIFT) & 1 != 0 {
                self.records[self.current].flags |= MACROBLOCK_FIELDTX_BIT;
            }
            if four_motion_vectors {
                for block in 0..4 {
                    let mut differential: [i32; 2] = [0, 0];
                    if four_pattern & (8 >> block) != 0 {
                        differential = self.read_interlaced_motion_vector_data().0;
                    }
                    self.predict_interlaced_frame_motion_vector(block, differential, 0, 0);
                    self.record_motion_4mv_luma(block, 0, false);
                }
                self.record_motion_4mv_chroma4(0, 0, false);
            } else if two_motion_vectors {
                let mut differential: [i32; 2] = [0, 0];
                if two_pattern & 2 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                self.predict_interlaced_frame_motion_vector(0, differential, 2, 0);
                self.record_motion_4mv_luma(0, 0, false);
                self.record_motion_4mv_luma(1, 0, false);
                differential = [0, 0];
                if two_pattern & 1 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                self.predict_interlaced_frame_motion_vector(2, differential, 2, 0);
                self.record_motion_4mv_luma(2, 0, false);
                self.record_motion_4mv_luma(3, 0, false);
                self.record_motion_4mv_chroma4(0, 0, false);
            } else {
                let mut differential: [i32; 2] = [0, 0];
                if (entry >> FRAME_MODE_MOTION_SHIFT) & 1 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                self.predict_interlaced_frame_motion_vector(0, differential, 1, 0);
                self.record_motion_1mv(0);
            }
            if cbp != 0 {
                mquant = self.read_macroblock_quantizer(mquant);
            }
            self.set_macroblock_quantizer(mquant);
            if self.unit.ttmbf == 0 && cbp != 0 {
                ttmb = self.read_ttmb();
            }
            (block_cbp, block_tt, _) = self.decode_macroblock_blocks(mquant, ttmb, 0, coded_block_mask(cbp));
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.cbp = block_cbp;
        record.tt = block_tt;
    }

    /// FFmpeg's vc1_decode_p_mb_intfi: field P macroblocks
    pub fn decode_field_p_macroblock(&mut self) {
        let mut mquant: i32 = self.unit.pq as i32;
        let mut ttmb: i32 = self.unit.ttfrm as i32;
        let mut cbp: u32 = 0;
        let block_cbp: u32;
        let mut block_tt: u32 = 0;
        let mode: u32 = self.reader.read_code(self.mbmode_lookup);
        if mode == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return;
        }
        if mode <= FIELD_MODE_LAST_INTRA {
            self.records[self.current].is_intra = crate::unit::MB_INTRA_BLOCKS_MASK;
            self.mb_intra = true;
            let index: i32 = self.block_grid_index(0);
            self.set_grid_motion_vector(1, index, [0, 0]);
            self.set_all_blocks_intra(true);
            mquant = self.read_macroblock_quantizer(mquant);
            self.set_macroblock_quantizer(mquant);
            self.ac_pred = self.reader.read_flag();
            if mode & 1 != 0 {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            block_cbp = self.decode_intra_macroblock_blocks(cbp, mquant);
            if self.macroblock_failed {
                return;
            }
        } else {
            self.mb_intra = false;
            self.records[self.current].is_intra = 0;
            self.set_all_blocks_intra(false);
            // A 1MV macroblock predicts once with its MVDATA flag, a 4MV macroblock once per block with its pattern's bits
            let one_vector: bool = mode <= FIELD_MODE_LAST_ONE_VECTOR;
            let mut pattern: u32 = 8;
            if !one_vector {
                pattern = self.reader.read_code(self.four_mv_block_pattern_lookup);
            }
            let blocks: u32 = if one_vector { 1 } else { 4 };
            for block in 0..blocks {
                let read: bool = if one_vector { mode & 1 != 0 } else { pattern & (8 >> block) != 0 };
                let mut data: ([i32; 2], i32) = ([0, 0], 0);
                if read {
                    data = self.read_interlaced_motion_vector_data();
                }
                let range_x: i32 = self.unit.range_x as i32;
                let range_y: i32 = self.unit.range_y as i32;
                self.predict_motion_vector(block, data.0, one_vector, range_x, range_y, data.1, 0);
                if !one_vector {
                    self.record_motion_4mv_luma(block, 0, false);
                }
            }
            let has_coefficients: bool = if one_vector {
                self.record_motion_1mv(0);
                mode & 2 == 0
            } else {
                self.record_motion_4mv_chroma(0);
                mode & 1 != 0
            };
            if has_coefficients {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            if cbp != 0 {
                mquant = self.read_macroblock_quantizer(mquant);
            }
            self.set_macroblock_quantizer(mquant);
            if self.unit.ttmbf == 0 && cbp != 0 {
                ttmb = self.read_ttmb();
            }
            let blocks_result: (u32, u32, u32) = self.decode_macroblock_blocks(mquant, ttmb, 0, coded_block_mask(cbp));
            block_cbp = blocks_result.0;
            block_tt = blocks_result.1;
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.cbp = block_cbp;
        record.tt = block_tt;
    }

    /// vc1_b_mc: the motion compensation of a progressive or field B macroblock with one vector per direction
    fn record_b_motion(&mut self, direct: bool, motion_type: u32) {
        if direct || motion_type == BMV_INTERPOLATED {
            self.record_motion_1mv(0);
            self.record_interpolated_motion();
            return;
        }
        self.record_motion_1mv(u32::from(motion_type == BMV_BACKWARD));
    }

    /// Reads a B macroblock's prediction type of decode012, ordered by BFRACTION
    fn read_b_motion_type(&mut self) -> u32 {
        let backward_first: bool = self.unit.bfraction >= BFRACTION_HALF;
        match self.reader.read_decode012() {
            0 => {
                if backward_first {
                    BMV_BACKWARD
                } else {
                    BMV_FORWARD
                }
            }
            1 => {
                if backward_first {
                    BMV_FORWARD
                } else {
                    BMV_BACKWARD
                }
            }
            _ => BMV_INTERPOLATED,
        }
    }

    /// FFmpeg's vc1_decode_b_mb: progressive B macroblocks
    pub fn decode_b_macroblock(&mut self) {
        let mut mquant: i32 = self.unit.pq as i32;
        let mut ttmb: i32 = self.unit.ttfrm as i32;
        let mut has_coefficients: bool = false;
        self.mb_intra = false;
        let direct: bool = self.plane_bit(self.unit.plane_direct, PLANE_DIRECT) != 0;
        let skipped: bool = self.plane_bit(self.unit.plane_skip, PLANE_SKIP) != 0;
        let mut differential_x: [i32; 2] = [0, 0];
        let mut differential_y: [i32; 2] = [0, 0];
        let mut motion_type: u32 = BMV_BACKWARD;
        self.set_all_blocks_intra(false);
        self.set_macroblock_quantizer(0);
        if !direct {
            if !skipped {
                let data: MotionVectorData = self.read_motion_vector_data();
                self.mb_intra = data.intra;
                has_coefficients = data.has_coefficients;
                differential_x = [data.differential[0], data.differential[0]];
                differential_y = [data.differential[1], data.differential[1]];
            }
            if skipped || !self.mb_intra {
                motion_type = self.read_b_motion_type();
                if motion_type == BMV_INTERPOLATED {
                    differential_x[0] = 0;
                    differential_y[0] = 0;
                }
            }
        }
        self.set_all_blocks_intra(self.mb_intra);
        if skipped {
            if direct {
                motion_type = BMV_INTERPOLATED;
            }
            self.predict_b_motion_vector(differential_x, differential_y, direct, motion_type);
            self.record_b_motion(direct, motion_type);
            self.records[self.current].flags |= MB_SKIPPED_BIT;
            return;
        }
        let cbp: u32;
        if direct {
            cbp = self.reader.read_code(self.cbpcy_lookup);
            mquant = self.read_macroblock_quantizer(mquant);
            self.mb_intra = false;
            self.set_macroblock_quantizer(mquant);
            if self.unit.ttmbf == 0 {
                ttmb = self.read_ttmb();
            }
            self.predict_b_motion_vector([0, 0], [0, 0], direct, motion_type);
            self.record_b_motion(direct, motion_type);
        } else {
            if !has_coefficients && !self.mb_intra {
                self.predict_b_motion_vector(differential_x, differential_y, direct, motion_type);
                self.record_b_motion(direct, motion_type);
                return;
            }
            if self.mb_intra && !has_coefficients {
                mquant = self.read_macroblock_quantizer(mquant);
                self.set_macroblock_quantizer(mquant);
                self.ac_pred = self.reader.read_flag();
                cbp = 0;
                self.predict_b_motion_vector(differential_x, differential_y, direct, motion_type);
            } else {
                if motion_type == BMV_INTERPOLATED {
                    let data: MotionVectorData = self.read_motion_vector_data();
                    self.mb_intra = data.intra;
                    has_coefficients = data.has_coefficients;
                    differential_x[0] = data.differential[0];
                    differential_y[0] = data.differential[1];
                    if !has_coefficients {
                        self.predict_b_motion_vector(differential_x, differential_y, direct, motion_type);
                        self.record_b_motion(direct, motion_type);
                        return;
                    }
                }
                self.predict_b_motion_vector(differential_x, differential_y, direct, motion_type);
                if !self.mb_intra {
                    self.record_b_motion(direct, motion_type);
                }
                if self.mb_intra {
                    self.ac_pred = self.reader.read_flag();
                }
                cbp = self.reader.read_code(self.cbpcy_lookup);
                mquant = self.read_macroblock_quantizer(mquant);
                self.set_macroblock_quantizer(mquant);
                if self.unit.ttmbf == 0 && !self.mb_intra && has_coefficients {
                    ttmb = self.read_ttmb();
                }
            }
        }
        self.set_all_blocks_intra(self.mb_intra);
        let intra_mask: u32 = if self.mb_intra { crate::unit::MB_INTRA_BLOCKS_MASK } else { 0 };
        self.decode_macroblock_blocks(mquant, ttmb, intra_mask, coded_block_mask(cbp));
    }

    /// FFmpeg's vc1_decode_b_mb_intfi: field B macroblocks
    pub fn decode_field_b_macroblock(&mut self) {
        self.b_motion_type = BMV_BACKWARD;
        let mut mquant: i32 = self.unit.pq as i32;
        let mut ttmb: i32 = self.unit.ttfrm as i32;
        let mut cbp: u32 = 0;
        let mut block_cbp: u32 = 0;
        let mut block_tt: u32 = 0;
        self.mb_intra = false;
        let mode: u32 = self.reader.read_code(self.mbmode_lookup);
        if mode == INVALID_SYMBOL {
            self.macroblock_failed = true;
            return;
        }
        if mode <= FIELD_MODE_LAST_INTRA {
            self.records[self.current].is_intra = crate::unit::MB_INTRA_BLOCKS_MASK;
            self.mb_intra = true;
            let index: i32 = self.block_grid_index(0);
            self.set_grid_motion_vector(1, index, [0, 0]);
            self.set_all_blocks_intra(true);
            mquant = self.read_macroblock_quantizer(mquant);
            self.set_macroblock_quantizer(mquant);
            self.ac_pred = self.reader.read_flag();
            if mode & 1 != 0 {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            for block in 0..BLOCK_COUNT as u32 {
                let coded: bool = (cbp >> (CBP_TOP_BIT - block)) & 1 != 0;
                let coding_set: u32 = if block < 4 { self.unit.codingset } else { self.unit.codingset2 };
                self.decode_intra_block_levels(block as usize, coded, coding_set, mquant.unsigned_abs().min(MAXIMUM_QUANTIZER as u32));
                if self.macroblock_failed {
                    return;
                }
            }
        } else {
            self.mb_intra = false;
            self.records[self.current].is_intra = 0;
            self.set_all_blocks_intra(false);
            let forward: bool = self.plane_bit(self.unit.plane_forward, PLANE_FORWARD) != 0;
            let has_coefficients: bool;
            if mode <= FIELD_MODE_LAST_ONE_VECTOR {
                let mut differential_x: [i32; 2] = [0, 0];
                let mut differential_y: [i32; 2] = [0, 0];
                let mut predictor_flags: [i32; 2] = [0, 0];
                let mut interpolated_predictor: bool = false;
                if forward {
                    self.b_motion_type = BMV_FORWARD;
                } else {
                    match self.reader.read_decode012() {
                        0 => self.b_motion_type = BMV_BACKWARD,
                        1 => self.b_motion_type = BMV_DIRECT,
                        _ => {
                            self.b_motion_type = BMV_INTERPOLATED;
                            interpolated_predictor = self.reader.read_flag();
                        }
                    }
                }
                if self.b_motion_type != BMV_DIRECT && mode & 1 != 0 {
                    let (differential, predictor_flag): ([i32; 2], i32) = self.read_interlaced_motion_vector_data();
                    let direction: usize = usize::from(self.b_motion_type == BMV_BACKWARD);
                    differential_x[direction] = differential[0];
                    differential_y[direction] = differential[1];
                    predictor_flags[direction] = predictor_flag;
                }
                if interpolated_predictor {
                    let (differential, predictor_flag): ([i32; 2], i32) = self.read_interlaced_motion_vector_data();
                    differential_x[1] = differential[0];
                    differential_y[1] = differential[1];
                    predictor_flags[1] = predictor_flag;
                }
                if self.b_motion_type == BMV_DIRECT {
                    differential_x = [0, 0];
                    differential_y = [0, 0];
                    predictor_flags[0] = 0;
                    if self.unit.backward_field_picture == 0 {
                        self.macroblock_failed = true;
                        return;
                    }
                }
                self.predict_field_b_motion_vector(0, differential_x, differential_y, true, predictor_flags);
                self.record_b_motion(self.b_motion_type == BMV_DIRECT, self.b_motion_type);
                has_coefficients = mode & 2 == 0;
            } else {
                if forward {
                    self.b_motion_type = BMV_FORWARD;
                }
                let direction: usize = usize::from(self.b_motion_type == BMV_BACKWARD);
                let pattern: u32 = self.reader.read_code(self.four_mv_block_pattern_lookup);
                for block in 0..4 {
                    let mut differential_x: [i32; 2] = [0, 0];
                    let mut differential_y: [i32; 2] = [0, 0];
                    let mut predictor_flags: [i32; 2] = [0, 0];
                    if pattern & (8 >> block) != 0 {
                        let (differential, predictor_flag): ([i32; 2], i32) = self.read_interlaced_motion_vector_data();
                        differential_x[direction] = differential[0];
                        differential_y[direction] = differential[1];
                        predictor_flags[direction] = predictor_flag;
                    }
                    self.predict_field_b_motion_vector(block, differential_x, differential_y, false, predictor_flags);
                    self.record_motion_4mv_luma(block, direction as u32, false);
                }
                self.record_motion_4mv_chroma(direction as u32);
                has_coefficients = mode & 1 != 0;
            }
            if has_coefficients {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            if cbp != 0 {
                mquant = self.read_macroblock_quantizer(mquant);
            }
            self.set_macroblock_quantizer(mquant);
            if self.unit.ttmbf == 0 && cbp != 0 {
                ttmb = self.read_ttmb();
            }
            (block_cbp, block_tt, _) = self.decode_macroblock_blocks(mquant, ttmb, 0, coded_block_mask(cbp));
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.cbp = block_cbp;
        record.tt = block_tt;
    }

    /// FFmpeg's vc1_decode_b_mb_intfr: interlaced frame B macroblocks
    pub fn decode_interlaced_frame_b_macroblock(&mut self) {
        let mut mquant: i32 = self.unit.pq as i32;
        let mut ttmb: i32 = self.unit.ttfrm as i32;
        let mut cbp: u32 = 0;
        let mut block_cbp: u32 = 0;
        let mut block_tt: u32 = 0;
        let mut switch_vectors: bool = false;
        let mut two_motion_vectors: bool = false;
        let mut mode: u32 = 0;
        let mut motion_type: u32 = BMV_BACKWARD;
        self.mb_intra = false;
        let skipped: bool = self.plane_bit(self.unit.plane_skip, PLANE_SKIP) != 0;
        if !skipped {
            mode = self.reader.read_code(self.mbmode_lookup);
            if mode == INVALID_SYMBOL {
                self.macroblock_failed = true;
                return;
            }
            if u32::from(MBMODE_INTFRP[mode as usize]) & FRAME_MODE_TYPE_MASK == FRAME_MB_2MV_FIELD {
                two_motion_vectors = true;
                self.set_block_motion_types(1);
            } else {
                self.set_block_motion_types(0);
            }
        }
        let entry: u32 = u32::from(MBMODE_INTFRP[mode as usize]);
        if entry & FRAME_MODE_TYPE_MASK == FRAME_MB_INTRA {
            for block in 0..4 {
                self.set_current_motion_vector(0, block, [0, 0]);
                self.set_current_motion_vector(1, block, [0, 0]);
                let index: i32 = self.block_grid_index(block as u32);
                self.set_grid_motion_vector(0, index, [0, 0]);
                self.set_grid_motion_vector(1, index, [0, 0]);
            }
            self.records[self.current].is_intra = crate::unit::MB_INTRA_BLOCKS_MASK;
            self.mb_intra = true;
            self.set_all_blocks_intra(true);
            if self.reader.read_flag() {
                self.records[self.current].flags |= MACROBLOCK_FIELDTX_BIT;
            }
            if self.reader.read_flag() {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            self.ac_pred = self.reader.read_flag();
            mquant = self.read_macroblock_quantizer(mquant);
            self.set_macroblock_quantizer(mquant);
            for block in 0..BLOCK_COUNT as u32 {
                let coded: bool = (cbp >> (CBP_TOP_BIT - block)) & 1 != 0;
                let coding_set: u32 = if block < 4 { self.unit.codingset } else { self.unit.codingset2 };
                self.decode_intra_block_levels(block as usize, coded, coding_set, mquant.unsigned_abs().min(MAXIMUM_QUANTIZER as u32));
                if self.macroblock_failed {
                    return;
                }
            }
            let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
            record.cbp = 0;
            record.tt = 0;
            return;
        }
        self.records[self.current].is_intra = 0;
        let direct: bool = self.plane_bit(self.unit.plane_direct, PLANE_DIRECT) != 0;
        if direct {
            self.predict_interlaced_frame_direct(two_motion_vectors);
        } else {
            if skipped || !self.mb_intra {
                motion_type = self.read_b_motion_type();
            }
            if two_motion_vectors && motion_type != BMV_INTERPOLATED {
                switch_vectors = self.reader.read_flag();
            }
        }
        let mut direction: u32 = u32::from(motion_type == BMV_BACKWARD);
        let mut direction2: u32 = direction;
        let mut copy_switched: bool = false;
        let mut copy_other: bool = false;
        let mut one_vector: bool = false;
        let mut interpolated_record: bool = false;
        let mut plan: FramePlan = FramePlan::default();
        if !skipped {
            if (entry >> FRAME_MODE_CODED_SHIFT) & 1 != 0 {
                cbp = 1 + self.reader.read_code(self.cbpcy_lookup);
            }
            let mut two_pattern: u32 = 0;
            let mut four_pattern: u32 = 0;
            if !direct {
                if motion_type == BMV_INTERPOLATED && two_motion_vectors {
                    four_pattern = self.reader.read_code(self.four_mv_block_pattern_lookup);
                } else if motion_type == BMV_INTERPOLATED || two_motion_vectors {
                    two_pattern = self.reader.read_code(self.two_mv_block_pattern_lookup);
                }
            }
            self.set_all_blocks_intra(false);
            if (entry >> FRAME_MODE_FIELDTX_SHIFT) & 1 != 0 {
                self.records[self.current].flags |= MACROBLOCK_FIELDTX_BIT;
            }
            // The differentials read in bitstream order as the plan fills; prediction reads no bits, so it may follow them
            if direct {
                if two_motion_vectors {
                    for block in 0..4 {
                        plan.add_luma_record(block, 0, false);
                        plan.add_luma_record(block, 1, true);
                    }
                    plan.add_chroma_record(0, 0, false);
                    plan.add_chroma_record(1, 1, true);
                } else {
                    one_vector = true;
                    direction = 0;
                    interpolated_record = true;
                }
            } else if two_motion_vectors && motion_type == BMV_INTERPOLATED {
                for index in 0..4u32 {
                    let prediction_direction: u32 = index & 1;
                    let mut differential: [i32; 2] = [0, 0];
                    if (four_pattern >> (3 - index)) & 1 != 0 {
                        differential = self.read_interlaced_motion_vector_data().0;
                    }
                    let block: u32 = if index > 1 { 2 } else { 0 };
                    plan.add_prediction(block, differential, 2, prediction_direction);
                    plan.add_luma_record(block, prediction_direction, prediction_direction != 0);
                    plan.add_luma_record(block + 1, prediction_direction, prediction_direction != 0);
                }
                plan.add_chroma_record(0, 0, false);
                plan.add_chroma_record(1, 1, true);
            } else if motion_type == BMV_INTERPOLATED {
                let mut differential: [i32; 2] = [0, 0];
                if two_pattern & 2 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                plan.add_prediction(0, differential, 1, 0);
                differential = [0, 0];
                if two_pattern & 1 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                plan.add_prediction(0, differential, 1, 1);
                one_vector = true;
                direction = 0;
                interpolated_record = true;
            } else if two_motion_vectors {
                if switch_vectors {
                    direction2 = 1 - direction;
                }
                let mut differential: [i32; 2] = [0, 0];
                if two_pattern & 2 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                plan.add_prediction(0, differential, 2, direction);
                differential = [0, 0];
                if two_pattern & 1 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                plan.add_prediction(2, differential, 2, direction2);
                if switch_vectors {
                    copy_switched = true;
                } else {
                    plan.add_prediction(0, [0, 0], 2, 1 - direction);
                    plan.add_prediction(2, [0, 0], 2, 1 - direction);
                }
                plan.add_luma_record(0, direction, false);
                plan.add_luma_record(1, direction, false);
                plan.add_luma_record(2, direction2, false);
                plan.add_luma_record(3, direction2, false);
                plan.add_chroma_record(direction, direction2, false);
            } else {
                let mut differential: [i32; 2] = [0, 0];
                if (entry >> FRAME_MODE_MOTION_SHIFT) & 1 != 0 {
                    differential = self.read_interlaced_motion_vector_data().0;
                }
                plan.add_prediction(0, differential, 1, direction);
                // The other direction predicts as a field macroblock
                plan.field_motion_from = 1;
                plan.add_prediction(0, [0, 0], 2, 1 - direction);
                copy_other = true;
                one_vector = true;
            }
        } else {
            self.set_all_blocks_intra(false);
            self.records[self.current].flags |= MB_SKIPPED_BIT;
            self.set_macroblock_quantizer(0);
            self.set_block_motion_types(0);
            direction = 0;
            if !direct {
                if motion_type == BMV_INTERPOLATED {
                    plan.add_prediction(0, [0, 0], 1, 0);
                    plan.add_prediction(0, [0, 0], 1, 1);
                } else {
                    direction = u32::from(motion_type == BMV_BACKWARD);
                    plan.add_prediction(0, [0, 0], 1, direction);
                    if switch_vectors {
                        direction2 = 1 - direction;
                        copy_switched = true;
                    } else {
                        plan.field_motion_from = 1;
                        plan.add_prediction(0, [0, 0], 2, 1 - direction);
                        copy_other = true;
                    }
                }
            }
            one_vector = true;
            interpolated_record = direct || motion_type == BMV_INTERPOLATED;
        }
        for (index, prediction) in plan.predictions[..plan.prediction_count].iter().enumerate() {
            if index == plan.field_motion_from {
                self.set_block_motion_types(1);
            }
            self.predict_interlaced_frame_motion_vector(prediction.block, prediction.differential, prediction.kind, prediction.direction);
        }
        if copy_switched {
            self.copy_field_vectors(direction as usize, false);
            self.copy_field_vectors(direction2 as usize, true);
        }
        if copy_other {
            self.copy_field_vectors(1 - direction as usize, false);
        }
        for record in &plan.luma_records[..plan.luma_count] {
            self.record_motion_4mv_luma(record.block, record.direction, record.average);
        }
        for record in &plan.chroma_records[..plan.chroma_count] {
            self.record_motion_4mv_chroma4(record.direction, record.direction2, record.average);
        }
        if one_vector {
            self.record_motion_1mv(direction);
            if interpolated_record {
                self.record_interpolated_motion();
            }
        }
        if !skipped {
            if cbp != 0 {
                mquant = self.read_macroblock_quantizer(mquant);
            }
            self.set_macroblock_quantizer(mquant);
            if self.unit.ttmbf == 0 && cbp != 0 {
                ttmb = self.read_ttmb();
            }
            (block_cbp, block_tt, _) = self.decode_macroblock_blocks(mquant, ttmb, 0, coded_block_mask(cbp));
        }
        let record: &mut crate::unit::MacroblockRecord = &mut self.records[self.current];
        record.cbp = block_cbp;
        record.tt = block_tt;
    }

    /// Copies a direction's 2MV field vectors between the top and bottom halves, as FFmpeg's mvsw loops do
    fn copy_field_vectors(&mut self, direction: usize, from_bottom: bool) {
        for block in 0..2u32 {
            let source_block: u32 = if from_bottom { block + 2 } else { block };
            let source_index: i32 = self.block_grid_index(source_block);
            let vector: [i32; 2] = self.grid_motion_vector(direction, source_index);
            self.set_current_motion_vector(direction, block as usize, vector);
            self.set_current_motion_vector(direction, block as usize + 2, vector);
            let top_index: i32 = self.block_grid_index(block);
            let bottom_index: i32 = self.block_grid_index(block + 2);
            self.set_grid_motion_vector(direction, top_index, vector);
            self.set_grid_motion_vector(direction, bottom_index, vector);
        }
    }
}

/// One vector prediction of an interlaced frame B macroblock: its block, differential, FFmpeg's mvn, and direction.
#[derive(Clone, Copy, Default)]
struct FramePrediction {
    block: u32,
    differential: [i32; 2],
    kind: u32,
    direction: u32,
}

/// A 4MV-style luma motion compensation record: its block, direction, and whether it averages.
#[derive(Clone, Copy, Default)]
struct FrameLumaRecord {
    block: u32,
    direction: u32,
    average: bool,
}

/// A chroma quarter record: the directions of the top and bottom quarters, and whether it averages.
#[derive(Clone, Copy, Default)]
struct FrameChromaRecord {
    direction: u32,
    direction2: u32,
    average: bool,
}

/// An interlaced frame B macroblock's motion: its vector predictions in order, the prediction from which every block takes field
/// motion, and its motion compensation records.
struct FramePlan {
    predictions: [FramePrediction; 4],
    prediction_count: usize,
    field_motion_from: usize,
    luma_records: [FrameLumaRecord; 8],
    luma_count: usize,
    chroma_records: [FrameChromaRecord; 2],
    chroma_count: usize,
}

impl Default for FramePlan {
    fn default() -> Self {
        Self {
            predictions: [FramePrediction::default(); 4],
            prediction_count: 0,
            // Past the last prediction when none takes field motion
            field_motion_from: 4,
            luma_records: [FrameLumaRecord::default(); 8],
            luma_count: 0,
            chroma_records: [FrameChromaRecord::default(); 2],
            chroma_count: 0,
        }
    }
}

impl FramePlan {
    fn add_prediction(&mut self, block: u32, differential: [i32; 2], kind: u32, direction: u32) {
        self.predictions[self.prediction_count] = FramePrediction { block, differential, kind, direction };
        self.prediction_count += 1;
    }

    fn add_luma_record(&mut self, block: u32, direction: u32, average: bool) {
        self.luma_records[self.luma_count] = FrameLumaRecord { block, direction, average };
        self.luma_count += 1;
    }

    fn add_chroma_record(&mut self, direction: u32, direction2: u32, average: bool) {
        self.chroma_records[self.chroma_count] = FrameChromaRecord { direction, direction2, average };
        self.chroma_count += 1;
    }
}
