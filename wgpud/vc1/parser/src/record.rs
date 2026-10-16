// A picture's parse units and their GPU record. Parse calls run units of a plan and serialize what each left: its macroblocks' record
// words, its anchor motion, an IntraX8 picture's samples, and its first failure. Finishing a picture reads its units' outputs back and
// assembles the record vc1.wgsl expands: the header, each pass's parameter block, the intensity compensation lookups its passes read,
// the macroblock offset table, and the macroblocks or the samples.

use crate::bitstream::BitReader;
use crate::error::{DecodeError, DecodeResult, fail};
use crate::header::{LOOKUP_ENTRIES, LOOKUP_TABLES};
use crate::intrax8::{IntraX8Picture, decode_intrax8_picture};
use crate::layout::{
    ERROR_RECORD_INVALID, FLAG_RESET_ANCHORS, HEADER_CODED_HEIGHT, HEADER_CODED_WIDTH, HEADER_FCM, HEADER_FIELD_MODE, HEADER_FLAGS,
    HEADER_FRAME_TYPE, HEADER_KIND, HEADER_LOOKUPS, HEADER_MACROBLOCKS, HEADER_MAGIC, HEADER_MB_HEIGHT, HEADER_MB_WIDTH, HEADER_OVERLAP,
    HEADER_PASS_COUNT, HEADER_PASSES, HEADER_PROFILE, HEADER_RES_FASTTX, HEADER_SAMPLES, HEADER_VERSION, HEADER_WORDS, KIND_INTRAX8,
    KIND_MACROBLOCKS, LOOKUP_SET_WORDS, MAGIC, PASS_WORDS, VERSION,
};
use crate::plan::{ANCHOR_INTRA, ANCHOR_WORDS_PER_MACROBLOCK, Plan, UnitParameters};
use crate::sequencer::PendingPicture;
use crate::unit::{UnitOutput, UnitParser};

pub const JOB_MAGIC: u32 = 0x424F_4A56;
/// Words of a job's header: its magic and its unit count
const JOB_HEADER_WORDS: usize = 2;
/// Words before each unit's streams: its index, error word, row offset, first and end rows, macroblock count, and its streams' lengths
const UNIT_HEADER_WORDS: usize = 9;
// The record failure values of a malformed plan, job, or picture
pub const INVALID_PLAN: u32 = 1;
pub const INVALID_JOB: u32 = 2;
pub const NO_PENDING_PICTURE: u32 = 3;
pub const INVALID_UNIT_RANGE: u32 = 4;
pub const MISSING_UNIT: u32 = 5;
const SAMPLES_PER_WORD: usize = 4;

/// One parsed unit as finish reads it: its rows and its outputs.
pub struct ParsedUnit {
    pub row_offset: u32,
    pub start_row: u32,
    pub end_row: u32,
    pub output: UnitOutput,
}

/// Packs a picture's planes four samples to a word, luma then Cb and Cr, rows tightly packed.
fn pack_samples(picture: &IntraX8Picture, output: &mut Vec<u32>) {
    for plane in &picture.planes {
        for chunk in plane.chunks(SAMPLES_PER_WORD) {
            let mut bytes: [u8; SAMPLES_PER_WORD] = [0; SAMPLES_PER_WORD];
            bytes[..chunk.len()].copy_from_slice(chunk);
            output.push(u32::from_le_bytes(bytes));
        }
    }
}

/// Decodes an IntraX8 unit: the whole picture, and its anchor motion, zero vectors and every block intra.
fn parse_intrax8_unit(plan: &Plan, unit: &UnitParameters, unit_index: u32) -> UnitOutput {
    let reader: BitReader = BitReader::new(&plan.stream, unit.start_bit as usize, unit.end_bit as usize);
    let picture: IntraX8Picture = decode_intrax8_picture(
        reader,
        plan.sequence.mb_width,
        plan.sequence.mb_height,
        unit.pq,
        unit.halfpq,
        unit.pquantizer,
        plan.sequence.loop_filter != 0,
    );
    let mut output: UnitOutput = UnitOutput { unit_index, ..UnitOutput::default() };
    pack_samples(&picture, &mut output.sample_words);
    let macroblock_count: usize = (plan.sequence.mb_width * (unit.end_row - unit.start_row)) as usize;
    output.macroblock_lengths = vec![0; macroblock_count];
    for _ in 0..macroblock_count {
        output.anchor_words.extend_from_slice(&[0, 0, ANCHOR_INTRA]);
    }
    output
}

/// Parses units first to first + count of a plan.
pub fn parse_units(plan: &Plan, first: usize, count: usize) -> Vec<UnitOutput> {
    let mut outputs: Vec<UnitOutput> = Vec::with_capacity(count);
    for (offset, unit) in plan.units[first..first + count].iter().enumerate() {
        let unit_index: u32 = (first + offset) as u32;
        if unit.x8_type != 0 {
            outputs.push(parse_intrax8_unit(plan, unit, unit_index));
            continue;
        }
        let parser: UnitParser = UnitParser::new(plan, unit);
        outputs.push(parser.parse(unit_index));
    }
    outputs
}

/// Serializes the outputs of a parse call's units, with each unit's rows.
pub fn serialize_job(plan: &Plan, outputs: &[UnitOutput], words: &mut Vec<u32>) {
    words.clear();
    words.extend_from_slice(&[JOB_MAGIC, outputs.len() as u32]);
    for output in outputs {
        let unit: &UnitParameters = &plan.units[output.unit_index as usize];
        words.extend_from_slice(&[
            output.unit_index,
            output.error_word,
            unit.row_offset,
            unit.start_row,
            unit.end_row,
            output.macroblock_lengths.len() as u32,
            output.macroblock_words.len() as u32,
            output.anchor_words.len() as u32,
            output.sample_words.len() as u32,
        ]);
        words.extend_from_slice(&output.macroblock_lengths);
        words.extend_from_slice(&output.macroblock_words);
        words.extend_from_slice(&output.anchor_words);
        words.extend_from_slice(&output.sample_words);
    }
}

fn take_words(words: &[u32], offset: &mut usize, length: usize) -> DecodeResult<Vec<u32>> {
    let end: usize = offset.checked_add(length).ok_or(DecodeError { code: ERROR_RECORD_INVALID, value: INVALID_JOB })?;
    let Some(slice) = words.get(*offset..end) else {
        return fail(ERROR_RECORD_INVALID, INVALID_JOB);
    };
    *offset = end;
    Ok(slice.to_vec())
}

/// Reads serialized jobs, one after another, back into their units.
pub fn deserialize_jobs(words: &[u32]) -> DecodeResult<Vec<ParsedUnit>> {
    let mut units: Vec<ParsedUnit> = Vec::new();
    let mut offset: usize = 0;
    while offset < words.len() {
        let Some(header) = words.get(offset..offset + JOB_HEADER_WORDS) else {
            return fail(ERROR_RECORD_INVALID, INVALID_JOB);
        };
        if header[0] != JOB_MAGIC {
            return fail(ERROR_RECORD_INVALID, INVALID_JOB);
        }
        let unit_count: u32 = header[1];
        offset += JOB_HEADER_WORDS;
        for _ in 0..unit_count {
            let Some(unit_header) = words.get(offset..offset + UNIT_HEADER_WORDS) else {
                return fail(ERROR_RECORD_INVALID, INVALID_JOB);
            };
            let unit_header: [u32; UNIT_HEADER_WORDS] = unit_header.try_into().map_err(|_| DecodeError { code: ERROR_RECORD_INVALID, value: INVALID_JOB })?;
            offset += UNIT_HEADER_WORDS;
            let macroblock_lengths: Vec<u32> = take_words(words, &mut offset, unit_header[5] as usize)?;
            let macroblock_words: Vec<u32> = take_words(words, &mut offset, unit_header[6] as usize)?;
            let anchor_words: Vec<u32> = take_words(words, &mut offset, unit_header[7] as usize)?;
            let sample_words: Vec<u32> = take_words(words, &mut offset, unit_header[8] as usize)?;
            units.push(ParsedUnit {
                row_offset: unit_header[2],
                start_row: unit_header[3],
                end_row: unit_header[4],
                output: UnitOutput {
                    unit_index: unit_header[0],
                    error_word: unit_header[1],
                    macroblock_lengths,
                    macroblock_words,
                    anchor_words,
                    sample_words,
                },
            });
        }
    }
    Ok(units)
}

/// Packs a lookup set's four tables of 256 entries four entries to a word.
fn pack_lookup_set(set: &[[u8; LOOKUP_ENTRIES]; LOOKUP_TABLES], output: &mut Vec<u32>) {
    for table in set {
        for chunk in table.chunks(SAMPLES_PER_WORD) {
            output.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
    }
}

/// Assembles a finished picture's GPU record from its units, in unit order; a unit that failed fails the picture with its highest error.
pub fn assemble_record(pending: &PendingPicture, units: &[ParsedUnit], output: &mut Vec<u32>) -> DecodeResult<()> {
    if units.len() != pending.unit_count as usize {
        return fail(ERROR_RECORD_INVALID, MISSING_UNIT);
    }
    let error_word: u32 = units.iter().map(|unit: &ParsedUnit| unit.output.error_word).max().unwrap_or(0);
    if error_word != 0 {
        return Err(DecodeError::from_word(error_word));
    }
    output.clear();
    output.resize(HEADER_WORDS as usize, 0);
    output[HEADER_MAGIC as usize] = MAGIC;
    output[HEADER_VERSION as usize] = VERSION;
    output[HEADER_KIND as usize] = pending.kind;
    output[HEADER_FRAME_TYPE as usize] = pending.frame_type;
    output[HEADER_FCM as usize] = pending.fcm;
    output[HEADER_FIELD_MODE as usize] = pending.field_mode;
    output[HEADER_MB_WIDTH as usize] = pending.mb_width;
    output[HEADER_MB_HEIGHT as usize] = pending.mb_height;
    output[HEADER_CODED_WIDTH as usize] = pending.coded_width;
    output[HEADER_CODED_HEIGHT as usize] = pending.coded_height;
    output[HEADER_PROFILE as usize] = pending.profile;
    output[HEADER_RES_FASTTX as usize] = pending.res_fasttx;
    output[HEADER_OVERLAP as usize] = pending.overlap;
    output[HEADER_FLAGS as usize] = if pending.resets_anchors { FLAG_RESET_ANCHORS } else { 0 };
    output[HEADER_PASS_COUNT as usize] = pending.passes.len() as u32;
    for (pass_index, pass) in pending.passes.iter().enumerate() {
        let base: usize = HEADER_PASSES as usize + pass_index * PASS_WORDS as usize;
        output[base..base + PASS_WORDS as usize].copy_from_slice(&pass.words);
    }
    if pending.passes.iter().any(|pass: &crate::sequencer::PassBlock| !pass.lookup_sets.is_empty()) {
        output[HEADER_LOOKUPS as usize] = output.len() as u32;
        for pass in &pending.passes {
            for set in &pass.lookup_sets {
                pack_lookup_set(set, output);
            }
        }
        debug_assert_eq!(LOOKUP_SET_WORDS as usize * SAMPLES_PER_WORD, LOOKUP_ENTRIES * LOOKUP_TABLES);
    }
    match pending.kind {
        KIND_MACROBLOCKS => {
            let table: usize = output.len();
            output[HEADER_MACROBLOCKS as usize] = table as u32;
            let macroblock_count: usize = (pending.mb_width * pending.mb_height) as usize;
            output.resize(table + macroblock_count, 0);
            for unit in units {
                let mut source: usize = 0;
                for (index, &length) in unit.output.macroblock_lengths.iter().enumerate() {
                    let row: u32 = unit.row_offset + unit.start_row + index as u32 / pending.mb_width;
                    let column: u32 = index as u32 % pending.mb_width;
                    let slot: usize = (row * pending.mb_width + column) as usize;
                    let end: usize = source + length as usize;
                    let Some(words) = unit.output.macroblock_words.get(source..end) else {
                        return fail(ERROR_RECORD_INVALID, INVALID_JOB);
                    };
                    if length != 0 {
                        if slot >= macroblock_count {
                            return fail(ERROR_RECORD_INVALID, INVALID_UNIT_RANGE);
                        }
                        output[table + slot] = output.len() as u32;
                        output.extend_from_slice(words);
                    }
                    source = end;
                }
            }
        }
        KIND_INTRAX8 => {
            output[HEADER_SAMPLES as usize] = output.len() as u32;
            for unit in units {
                output.extend_from_slice(&unit.output.sample_words);
            }
        }
        _ => {}
    }
    Ok(())
}

/// Each unit's anchor motion at its frame rows, for the sequencer.
pub fn unit_anchor_motion(units: &[ParsedUnit]) -> Vec<(u32, u32, u32, Vec<u32>)> {
    units
        .iter()
        .filter(|unit: &&ParsedUnit| unit.output.anchor_words.len().is_multiple_of(ANCHOR_WORDS_PER_MACROBLOCK) && !unit.output.anchor_words.is_empty())
        .map(|unit: &ParsedUnit| (unit.row_offset, unit.start_row, unit.end_row, unit.output.anchor_words.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{ERROR_BITS_EXHAUSTED, ERROR_MACROBLOCK_LAYER, PASS_TYPE, TYPE_P};
    use crate::sequencer::{PassBlock, PictureInfo};

    // A picture of two macroblocks in one row, parsed as two units of one macroblock each
    const MB_WIDTH: u32 = 2;
    const MB_HEIGHT: u32 = 1;
    const FIRST_MACROBLOCK_WORDS: [u32; 3] = [11, 12, 13];
    const SECOND_MACROBLOCK_WORDS: [u32; 2] = [21, 22];
    const ANCHOR_FLAGS: u32 = 7;
    const LOWER_ERROR_VALUE: u32 = 3;
    const HIGHER_ERROR_VALUE: u32 = 9;

    fn create_plan() -> Plan {
        Plan {
            units: vec![UnitParameters { end_row: MB_HEIGHT, ..UnitParameters::default() }, UnitParameters { end_row: MB_HEIGHT, ..UnitParameters::default() }],
            ..Plan::default()
        }
    }

    fn create_pending() -> PendingPicture {
        let mut words: [u32; PASS_WORDS as usize] = [0; PASS_WORDS as usize];
        words[PASS_TYPE as usize] = TYPE_P;
        PendingPicture {
            kind: KIND_MACROBLOCKS,
            frame_type: TYPE_P,
            fcm: 0,
            field_mode: 0,
            mb_width: MB_WIDTH,
            mb_height: MB_HEIGHT,
            coded_width: MB_WIDTH * 16,
            coded_height: MB_HEIGHT * 16,
            profile: 0,
            res_fasttx: 0,
            overlap: 0,
            passes: vec![PassBlock { words, lookup_sets: Vec::new() }],
            unit_count: 2,
            updates_anchor_motion: true,
            resets_anchors: true,
            info: PictureInfo::default(),
        }
    }

    /// Unit 0 holds the first macroblock's words, unit 1 the second's, each in its own column of the row.
    fn create_units() -> Vec<ParsedUnit> {
        let first: UnitOutput = UnitOutput {
            unit_index: 0,
            macroblock_lengths: vec![FIRST_MACROBLOCK_WORDS.len() as u32, 0],
            macroblock_words: FIRST_MACROBLOCK_WORDS.to_vec(),
            anchor_words: vec![0, 0, ANCHOR_FLAGS, 0, 0, 0],
            ..UnitOutput::default()
        };
        let second: UnitOutput = UnitOutput {
            unit_index: 1,
            macroblock_lengths: vec![0, SECOND_MACROBLOCK_WORDS.len() as u32],
            macroblock_words: SECOND_MACROBLOCK_WORDS.to_vec(),
            ..UnitOutput::default()
        };
        vec![
            ParsedUnit { row_offset: 0, start_row: 0, end_row: MB_HEIGHT, output: first },
            ParsedUnit { row_offset: 0, start_row: 0, end_row: MB_HEIGHT, output: second },
        ]
    }

    #[test]
    fn reads_back_the_jobs_it_serializes_one_after_another() {
        let plan: Plan = create_plan();
        let units: Vec<ParsedUnit> = create_units();
        let mut words: Vec<u32> = Vec::new();
        let mut joined: Vec<u32> = Vec::new();
        for unit in units {
            serialize_job(&plan, &[unit.output], &mut words);
            joined.extend_from_slice(&words);
        }
        let read: Vec<ParsedUnit> = deserialize_jobs(&joined).expect("serialized jobs read back");

        assert_eq!(read.len(), 2);
        assert_eq!(read[0].output.macroblock_words, FIRST_MACROBLOCK_WORDS);
        assert_eq!(read[0].output.anchor_words[2], ANCHOR_FLAGS);
        assert_eq!(read[1].output.unit_index, 1);
        assert_eq!(read[1].end_row, MB_HEIGHT);
    }

    #[test]
    fn refuses_a_cut_job() {
        let mut words: Vec<u32> = Vec::new();
        serialize_job(&create_plan(), &[create_units().remove(0).output], &mut words);
        words.pop();

        let failure: DecodeError = deserialize_jobs(&words).err().expect("a cut job fails");
        assert_eq!((failure.code, failure.value), (ERROR_RECORD_INVALID, INVALID_JOB));
    }

    #[test]
    fn assembles_the_header_the_pass_and_each_macroblock_by_its_raster_position() {
        let mut record: Vec<u32> = Vec::new();
        assemble_record(&create_pending(), &create_units(), &mut record).expect("the picture assembles");

        assert_eq!(record[HEADER_MAGIC as usize], MAGIC);
        assert_eq!(record[HEADER_VERSION as usize], VERSION);
        assert_eq!(record[HEADER_FLAGS as usize], FLAG_RESET_ANCHORS);
        assert_eq!(record[HEADER_PASS_COUNT as usize], 1);
        assert_eq!(record[HEADER_PASSES as usize + PASS_TYPE as usize], TYPE_P);
        assert_eq!(record[HEADER_LOOKUPS as usize], 0);
        let table: usize = record[HEADER_MACROBLOCKS as usize] as usize;
        let first: usize = record[table] as usize;
        let second: usize = record[table + 1] as usize;
        assert_eq!(record[first..first + FIRST_MACROBLOCK_WORDS.len()], FIRST_MACROBLOCK_WORDS);
        assert_eq!(record[second..second + SECOND_MACROBLOCK_WORDS.len()], SECOND_MACROBLOCK_WORDS);
        assert_eq!(record.len(), second + SECOND_MACROBLOCK_WORDS.len());
    }

    #[test]
    fn fails_a_picture_with_the_highest_error_of_its_units_or_a_missing_unit() {
        let mut units: Vec<ParsedUnit> = create_units();
        units[0].output.error_word = DecodeError { code: ERROR_BITS_EXHAUSTED, value: HIGHER_ERROR_VALUE }.word();
        units[1].output.error_word = DecodeError { code: ERROR_MACROBLOCK_LAYER, value: LOWER_ERROR_VALUE }.word();
        let mut record: Vec<u32> = Vec::new();

        let failure: DecodeError = assemble_record(&create_pending(), &units, &mut record).expect_err("a failed unit fails the picture");
        assert_eq!((failure.code, failure.value), (ERROR_BITS_EXHAUSTED, HIGHER_ERROR_VALUE));
        let missing: DecodeError = assemble_record(&create_pending(), &units[..1], &mut record).expect_err("a missing unit fails the picture");
        assert_eq!((missing.code, missing.value), (ERROR_RECORD_INVALID, MISSING_UNIT));
    }
}
