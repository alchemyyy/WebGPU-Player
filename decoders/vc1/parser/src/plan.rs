// A picture plan: everything the macroblock layer of its units needs, self-contained so a parse worker with its own module instance
// can take it. The coordinator serializes a plan; a worker reads it back. Both run the same module, so the plain structs travel as their bytes.

use std::mem::size_of;
use std::ptr;

pub const PLAN_MAGIC: u32 = 0x4E41_4C56;
/// Words of anchor motion per macroblock: the motion vector of block 0, that of block 2, and the flags
pub const ANCHOR_WORDS_PER_MACROBLOCK: usize = 3;
/// Bits of an anchor macroblock's flags word: the dir-0 field flag of each luma block, then whether the macroblock is intra
pub const ANCHOR_FIELD_FLAGS_MASK: u32 = 0xF;
pub const ANCHOR_INTRA: u32 = 0x10;

/// Marks a struct of only u32 and i32 fields and arrays, which any bytes of its size form validly.
///
/// # Safety
/// The implementing type must be `repr(C)`, `Copy`, and hold no references, pointers, or types with invalid bit patterns.
pub unsafe trait PlainData: Copy {}

/// Appends a plain struct's bytes.
pub fn write_plain<T: PlainData>(output: &mut Vec<u8>, value: &T) {
    // SAFETY: PlainData types are repr(C) structs of plain integers, so their bytes are initialized and readable
    let bytes: &[u8] = unsafe { std::slice::from_raw_parts(ptr::from_ref(value).cast::<u8>(), size_of::<T>()) };
    output.extend_from_slice(bytes);
}

/// Reads a plain struct at a byte offset, advancing the offset; None when the bytes run out.
pub fn read_plain<T: PlainData>(bytes: &[u8], offset: &mut usize) -> Option<T> {
    let end: usize = offset.checked_add(size_of::<T>())?;
    if end > bytes.len() {
        return None;
    }
    // SAFETY: the range is in bounds, and every bit pattern is a valid PlainData value
    let value: T = unsafe { ptr::read_unaligned(bytes.as_ptr().add(*offset).cast::<T>()) };
    *offset = end;
    Some(value)
}

/// The sequence and entry point fields the macroblock layer reads, with the frame's geometry.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct SequenceFacts {
    pub profile: u32,
    pub res_rtm_flag: u32,
    pub overlap: u32,
    pub fastuvmc: u32,
    pub loop_filter: u32,
    pub coded_width: u32,
    pub coded_height: u32,
    pub mb_width: u32,
    pub mb_height: u32,
}

// SAFETY: repr(C), Copy, and only integers
unsafe impl PlainData for SequenceFacts {}

/// One parse unit, a slice or a field: the picture header fields it decodes with, FFmpeg's VC1Context as its header left it, and
/// its bits and macroblock rows.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct UnitParameters {
    pub picture_type: u32,
    pub fcm: u32,
    pub field_mode: u32,
    pub second_field: u32,
    pub current_field_type: u32,
    pub pq: u32,
    pub pqindex: u32,
    pub halfpq: u32,
    pub pquantizer: u32,
    pub altpq: u32,
    pub dquantfrm: u32,
    pub dqprofile: u32,
    pub dqsbedge: u32,
    pub dqbilevel: u32,
    pub dmvrange: u32,
    pub range_x: u32,
    pub range_y: u32,
    pub k_x: u32,
    pub k_y: u32,
    pub mv_mode: u32,
    pub mv_mode2: u32,
    pub quarter_sample: u32,
    pub mspel: u32,
    pub mv_table_index: u32,
    pub cbptab: u32,
    pub ttmbf: u32,
    pub ttfrm: u32,
    pub tt_index: u32,
    pub dc_table_index: u32,
    pub codingset: u32,
    pub codingset2: u32,
    pub condover: u32,
    pub fourmvswitch: u32,
    pub mbmodetab: u32,
    pub imvtab: u32,
    pub icbptab: u32,
    pub twomvbptab: u32,
    pub fourmvbptab: u32,
    pub numref: u32,
    pub reffield: u32,
    pub ref_field_type_forward: u32,
    pub refdist: u32,
    pub frfd: u32,
    pub brfd: u32,
    pub bfraction: i32,
    pub x8_type: u32,
    pub plane_mvtype: u32,
    pub plane_skip: u32,
    pub plane_direct: u32,
    pub plane_forward: u32,
    pub plane_acpred: u32,
    pub plane_overflags: u32,
    pub plane_fieldtx: u32,
    /// The frame macroblock row of the unit's field's first row
    pub row_offset: u32,
    /// Whether the backward anchor of a B picture is a field picture, which field B direct prediction needs
    pub backward_field_picture: u32,
    /// The unit's bits in the plan's stream bytes
    pub start_bit: u32,
    pub end_bit: u32,
    /// The unit's rows of its field
    pub start_row: u32,
    pub end_row: u32,
    /// The plane bytes the unit reads, by version in the plan
    pub plane_version: u32,
}

// SAFETY: repr(C), Copy, and only integers
unsafe impl PlainData for UnitParameters {}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PlanHeader {
    magic: u32,
    unit_count: u32,
    plane_version_count: u32,
    plane_byte_count: u32,
    anchor_word_count: u32,
    stream_byte_length: u32,
}

// SAFETY: repr(C), Copy, and only integers
unsafe impl PlainData for PlanHeader {}

/// A planned picture: its sequence facts, its units, the versions of its plane bytes, the next anchor's motion for B pictures, and the
/// unescaped bytes of its segments.
#[derive(Clone, Default)]
pub struct Plan {
    pub sequence: SequenceFacts,
    pub units: Vec<UnitParameters>,
    /// One frame of plane bytes per version, mb_width * mb_height each
    pub plane_versions: Vec<Vec<u8>>,
    /// ANCHOR_WORDS_PER_MACROBLOCK words per frame macroblock, or none
    pub anchor_motion: Vec<u32>,
    pub stream: Vec<u8>,
}

impl Plan {
    pub fn serialize(&self, output: &mut Vec<u8>) {
        output.clear();
        let plane_byte_count: usize = self.plane_versions.first().map_or(0, Vec::len);
        let header: PlanHeader = PlanHeader {
            magic: PLAN_MAGIC,
            unit_count: self.units.len() as u32,
            plane_version_count: self.plane_versions.len() as u32,
            plane_byte_count: plane_byte_count as u32,
            anchor_word_count: self.anchor_motion.len() as u32,
            stream_byte_length: self.stream.len() as u32,
        };
        write_plain(output, &header);
        write_plain(output, &self.sequence);
        for unit in &self.units {
            write_plain(output, unit);
        }
        for version in &self.plane_versions {
            output.extend_from_slice(version);
        }
        for word in &self.anchor_motion {
            output.extend_from_slice(&word.to_le_bytes());
        }
        output.extend_from_slice(&self.stream);
    }

    /// Reads a serialized plan back; None when the bytes are not one.
    pub fn deserialize(bytes: &[u8]) -> Option<Self> {
        let mut offset: usize = 0;
        let header: PlanHeader = read_plain(bytes, &mut offset)?;
        if header.magic != PLAN_MAGIC {
            return None;
        }
        let sequence: SequenceFacts = read_plain(bytes, &mut offset)?;
        // Counts reserve at most what the bytes can hold, so a malformed header allocates nothing beyond them
        let mut units: Vec<UnitParameters> = Vec::with_capacity((header.unit_count as usize).min(bytes.len() / size_of::<UnitParameters>()));
        for _ in 0..header.unit_count {
            units.push(read_plain(bytes, &mut offset)?);
        }
        let plane_byte_count: usize = header.plane_byte_count as usize;
        let mut plane_versions: Vec<Vec<u8>> = Vec::with_capacity((header.plane_version_count as usize).min(bytes.len()));
        for _ in 0..header.plane_version_count {
            let end: usize = offset.checked_add(plane_byte_count)?;
            plane_versions.push(bytes.get(offset..end)?.to_vec());
            offset = end;
        }
        let mut anchor_motion: Vec<u32> = Vec::with_capacity((header.anchor_word_count as usize).min(bytes.len() / size_of::<u32>()));
        for _ in 0..header.anchor_word_count {
            let word: [u8; 4] = bytes.get(offset..offset + 4)?.try_into().ok()?;
            anchor_motion.push(u32::from_le_bytes(word));
            offset += 4;
        }
        let stream_end: usize = offset.checked_add(header.stream_byte_length as usize)?;
        let stream: Vec<u8> = bytes.get(offset..stream_end)?.to_vec();
        if stream_end != bytes.len() {
            return None;
        }
        Some(Self { sequence, units, plane_versions, anchor_motion, stream })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MB_WIDTH: u32 = 3;
    const MB_HEIGHT: u32 = 2;
    const FIRST_UNIT_END_BIT: u32 = 77;
    const SECOND_UNIT_START_ROW: u32 = 1;
    const PLANE_BYTE: u8 = 0x15;
    const ANCHOR_WORD: u32 = 0xDEAD_BEEF;
    const STREAM_BYTES: [u8; 5] = [0x0D, 0x01, 0x02, 0x03, 0x04];

    fn create_plan() -> Plan {
        let macroblock_count: usize = (MB_WIDTH * MB_HEIGHT) as usize;
        Plan {
            sequence: SequenceFacts { mb_width: MB_WIDTH, mb_height: MB_HEIGHT, ..SequenceFacts::default() },
            units: vec![
                UnitParameters { end_bit: FIRST_UNIT_END_BIT, end_row: SECOND_UNIT_START_ROW, ..UnitParameters::default() },
                UnitParameters { start_row: SECOND_UNIT_START_ROW, end_row: MB_HEIGHT, bfraction: -1, ..UnitParameters::default() },
            ],
            plane_versions: vec![vec![PLANE_BYTE; macroblock_count], vec![0; macroblock_count]],
            anchor_motion: vec![ANCHOR_WORD; macroblock_count * ANCHOR_WORDS_PER_MACROBLOCK],
            stream: STREAM_BYTES.to_vec(),
        }
    }

    #[test]
    fn reads_back_what_it_serializes() {
        let plan: Plan = create_plan();
        let mut bytes: Vec<u8> = Vec::new();
        plan.serialize(&mut bytes);
        let read: Plan = Plan::deserialize(&bytes).expect("a serialized plan reads back");

        assert_eq!(read.sequence.mb_width, MB_WIDTH);
        assert_eq!(read.units.len(), plan.units.len());
        assert_eq!(read.units[0].end_bit, FIRST_UNIT_END_BIT);
        assert_eq!(read.units[1].start_row, SECOND_UNIT_START_ROW);
        assert_eq!(read.units[1].bfraction, -1);
        assert_eq!(read.plane_versions, plan.plane_versions);
        assert_eq!(read.anchor_motion, plan.anchor_motion);
        assert_eq!(read.stream, STREAM_BYTES);
    }

    #[test]
    fn refuses_bytes_that_are_not_exactly_one_plan() {
        let mut bytes: Vec<u8> = Vec::new();
        create_plan().serialize(&mut bytes);

        assert!(Plan::deserialize(&bytes[..bytes.len() - 1]).is_none());
        let mut extended: Vec<u8> = bytes.clone();
        extended.push(0);
        assert!(Plan::deserialize(&extended).is_none());
        let mut renamed: Vec<u8> = bytes;
        renamed[0] ^= 1;
        assert!(Plan::deserialize(&renamed).is_none());
    }
}
