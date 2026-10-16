// The coordinator's sequential decoding state: parameter sets, slice segment headers (7.3.6), the POC (8.3.1), the RPS and DPB (8.3.2),
// reference picture lists (8.3.4), the output process (C.5.2), and the decoding units of each picture. It turns each packet into a picture plan
// and the output events its picture's start decides.
// FFmpeg's libavcodec/hevc (hevcdec.c, refs.c) is the behavioral reference.

use crate::bitstream::{BitReader, extract_rbsp, raw_position_of, rbsp_index_of};
use crate::ctb_layout::CTBLayout;
use crate::error::{DecodeResult, fail};
use crate::layout::{
    ERROR_MULTIPLE_PICTURES, ERROR_PARAMETER_SET_INVALID, ERROR_PARAMETER_SET_MISSING, ERROR_PICTURE_SIZE, ERROR_REFERENCE_PICTURES,
    ERROR_SLICE_HEADER, ERROR_SLICE_SEGMENT_LIMIT, ERROR_UNSUPPORTED_FORMAT, MAXIMUM_DPB_PICTURES, MAXIMUM_HEIGHT, MAXIMUM_LUMA_PICTURE_SIZE,
    MAXIMUM_SLICE_SEGMENTS, MAXIMUM_SLICES, MAXIMUM_TILE_COLUMNS, MAXIMUM_TILE_ROWS, MAXIMUM_WIDTH, MISSING_PICTURE,
};
use crate::nal::NALUnits;
use crate::parameter_sets::{
    MAXIMUM_PPS_COUNT, MAXIMUM_SPS_COUNT, PictureParameterSet, SequenceParameterSet, ShortTermSet, parse_picture_parameter_set,
    parse_sequence_parameter_set, parse_short_term_set,
};
use crate::plan::{
    PictureParameters, Plan, ReferenceEntry, SEGMENT_PADDING_BYTES, Segment, SliceHeader, UNIT_STARTS_SEGMENT, UNIT_STARTS_SUBSTREAM, Unit,
};

// NAL unit types
const NAL_RADL_N: u32 = 6;
const NAL_RASL_N: u32 = 8;
const NAL_RASL_R: u32 = 9;
const NAL_BLA_W_LP: u32 = 16;
const NAL_BLA_N_LP: u32 = 18;
const NAL_IDR_W_RADL: u32 = 19;
const NAL_IDR_N_LP: u32 = 20;
const NAL_CRA: u32 = 21;
const NAL_IRAP_LAST: u32 = 23;
const NAL_SPS: u32 = 33;
const NAL_PPS: u32 = 34;
const NAL_EOS: u32 = 36;
const NAL_EOB: u32 = 37;
const NAL_SEI_PREFIX: u32 = 39;
const NAL_SUB_LAYER_NON_REFERENCE_LAST: u32 = 14;

const NAL_HEADER_BYTES: usize = 2;

// SEI messages (7.3.5): payload type and size bytes continue while 0xFF; the RBSP trailing bits end the messages
const SEI_RECOVERY_POINT: u32 = 6;
const SEI_CONTINUATION_BYTE: u8 = 0xFF;
const RBSP_TRAILING_BYTE: u8 = 0x80;

// FFmpeg's recovery_poc states: no recovery point seen since the last end of sequence, and recovery complete
const RECOVERY_UNSPECIFIED: i32 = i32::MAX;
const RECOVERY_END: i32 = i32::MIN;

// Output event words of the parser interface, version 1: the picture's index in decode order modulo 2^30, and the discard bit
pub const OUTPUT_EVENT_INDEX_MASK: u32 = 0x3FFF_FFFF;
pub const OUTPUT_EVENT_DISCARD: u32 = 0x8000_0000;

// Slice types
pub const SLICE_B: u32 = 0;
pub const SLICE_P: u32 = 1;
pub const SLICE_I: u32 = 2;

// DPB entries: up to MaxDpbSize references and the current picture
const DPB_ENTRY_COUNT: usize = MAXIMUM_DPB_PICTURES as usize + 1;
const DPB_VALID: u32 = 1;
const DPB_SHORT_TERM: u32 = 2;
const DPB_LONG_TERM: u32 = 4;
const DPB_MISSING: u32 = 8;
const DPB_MARKED: u32 = 16;

/// The tile substreams a picture codes whose entry points the planner keeps: one per tile at most.
const MAXIMUM_ENTRY_POINTS: usize = (MAXIMUM_TILE_COLUMNS * MAXIMUM_TILE_ROWS) as usize;
const MAXIMUM_LONG_TERM_PICTURES: usize = 32;
const MAXIMUM_OFFSET_LENGTH: u32 = 32;
const MAXIMUM_DELTA_POC_MSB_CYCLE: u32 = 1 << 24;
const MAXIMUM_SLICE_QP: i32 = 51;
const LIST_COUNT: usize = 2;

#[derive(Clone, Copy, Default)]
struct DPBEntry {
    flags: u32,
    picture_id: u32,
    poc: i32,
}

/// A picture waiting for output (FFmpeg's HEVC_FRAME_FLAG_OUTPUT), which may also be a reference in the DPB.
#[derive(Clone, Copy)]
struct WaitingPicture {
    index: u32,
    picture_id: u32,
    poc: i32,
}

/// The outcome of planning a packet.
pub enum PlanOutcome {
    Picture(Box<Plan>, Vec<u32>),
    /// The packet decodes to no picture: parameter sets only, or a RASL picture of a CRA that started decoding
    NoPicture,
}

/// The long-term part of a slice's RPS.
#[derive(Clone, Copy)]
struct LongTermSet {
    count: usize,
    pocs: [i32; MAXIMUM_LONG_TERM_PICTURES],
    used: [u8; MAXIMUM_LONG_TERM_PICTURES],
    msb_present: [u8; MAXIMUM_LONG_TERM_PICTURES],
}

impl Default for LongTermSet {
    fn default() -> Self {
        Self { count: 0, pocs: [0; MAXIMUM_LONG_TERM_PICTURES], used: [0; MAXIMUM_LONG_TERM_PICTURES], msb_present: [0; MAXIMUM_LONG_TERM_PICTURES] }
    }
}

/// The picture a packet's slice segments build.
struct PictureInProgress {
    started: bool,
    skipped: bool,
    sps_id: usize,
    pps_id: usize,
    nal_type: u32,
    irap: bool,
    no_rasl_output: bool,
    /// An IDR or BLA picture, a picture after an end of sequence, or one that activates another SPS: earlier pictures all leave first
    new_sequence: bool,
    sequence_set_changed: bool,
    /// no_output_of_prior_pics_flag, which a CRA picture after an end of sequence implies
    no_output_of_prior_pictures: bool,
    poc: i32,
    ctb_count: u32,
    // The RPS lists of the picture, as DPB entry indices
    short_term_before: Vec<usize>,
    short_term_after: Vec<usize>,
    long_term_current: Vec<usize>,
    plan: Plan,
    keep: Vec<u32>,
}

impl PictureInProgress {
    fn new(parameters: PictureParameters) -> Self {
        Self {
            started: false,
            skipped: false,
            sps_id: 0,
            pps_id: 0,
            nal_type: 0,
            irap: false,
            no_rasl_output: false,
            new_sequence: false,
            sequence_set_changed: false,
            no_output_of_prior_pictures: false,
            poc: 0,
            ctb_count: 0,
            short_term_before: Vec::new(),
            short_term_after: Vec::new(),
            long_term_current: Vec::new(),
            plan: Plan { parameters, slices: Vec::new(), segments: Vec::new(), units: Vec::new(), entry_points: Vec::new(), data: Vec::new() },
            keep: Vec::new(),
        }
    }
}

fn ceil_log2(value: u32) -> u32 {
    if value <= 1 {
        return 0;
    }
    32 - (value - 1).leading_zeros()
}

/// Reads an SEI payload type or size: its bytes summed while each is 0xFF, then the last one; None past the end.
fn read_sei_value(rbsp: &[u8], position: &mut usize) -> Option<u32> {
    let mut value: u32 = 0;
    loop {
        let byte: u8 = *rbsp.get(*position)?;
        *position += 1;
        value = value.saturating_add(u32::from(byte));
        if byte != SEI_CONTINUATION_BYTE {
            return Some(value);
        }
    }
}

/// The recovery_poc_cnt of the last recovery point message in an SEI RBSP before any malformed message, as FFmpeg keeps it.
fn find_recovery_point(rbsp: &[u8]) -> Option<i32> {
    let recovery_poc_count_range: std::ops::RangeInclusive<i32> = i32::from(i16::MIN)..=i32::from(i16::MAX);
    let mut recovery_poc_count: Option<i32> = None;
    let mut position: usize = NAL_HEADER_BYTES;
    while position < rbsp.len() && rbsp[position] != RBSP_TRAILING_BYTE {
        let Some(payload_type) = read_sei_value(rbsp, &mut position) else {
            break;
        };
        let Some(payload_size) = read_sei_value(rbsp, &mut position) else {
            break;
        };
        let Some(end) = position.checked_add(payload_size as usize).filter(|&end: &usize| end <= rbsp.len()) else {
            break;
        };
        if payload_type == SEI_RECOVERY_POINT {
            let mut reader: BitReader = BitReader::new(&rbsp[position..end]);
            let count: i32 = reader.read_signed_golomb();
            if reader.overrun() || !recovery_poc_count_range.contains(&count) {
                break;
            }
            recovery_poc_count = Some(count);
        }
        position = end;
    }
    recovery_poc_count
}

/// The coordinator's state from one reset to the next.
pub struct Sequencer {
    sequence_sets: Vec<Option<Box<SequenceParameterSet>>>,
    picture_sets: Vec<Option<Box<PictureParameterSet>>>,
    generation: u32,
    nal_length_size: usize,
    /// FFmpeg's eos: an end of sequence or bitstream ended the last packet, so this packet's picture follows one; a new sequencer starts with it, as after a flush
    end_of_sequence: bool,
    /// FFmpeg's last_eos: the current packet's picture follows an end of sequence
    last_end_of_sequence: bool,
    previous_poc_lsb: i32,
    previous_poc_msb: i32,
    dpb: [DPBEntry; DPB_ENTRY_COUNT],
    next_picture_id: u32,
    /// NoRaslOutputFlag of the last IRAP picture, which decides whether its RASL pictures decode
    irap_no_rasl_output: bool,
    /// The SPS of the last picture, as its ID and generation
    active_sequence_set: Option<(usize, u32)>,
    /// recovery_poc_cnt of the last recovery point SEI since the last end of sequence
    recovery_point: Option<i32>,
    /// FFmpeg's recovery_poc: until it ends, pictures before it after a recovery point are not output
    recovery_poc: i32,
    waiting: Vec<WaitingPicture>,
    /// The index the next picture's output events name it by
    next_output_index: u32,
    events: Vec<u32>,
    tables_key: (usize, usize, u32, u32),
    tables_generation: u32,
    layout: CTBLayout,
    rbsp: Vec<u8>,
    escapes: Vec<u32>,
    template: PictureParameters,
}

impl Sequencer {
    pub fn new(template: PictureParameters) -> Self {
        Self {
            sequence_sets: (0..MAXIMUM_SPS_COUNT).map(|_| None).collect(),
            picture_sets: (0..MAXIMUM_PPS_COUNT).map(|_| None).collect(),
            generation: 0,
            nal_length_size: 0,
            end_of_sequence: true,
            last_end_of_sequence: false,
            previous_poc_lsb: 0,
            previous_poc_msb: 0,
            dpb: [DPBEntry::default(); DPB_ENTRY_COUNT],
            next_picture_id: 0,
            irap_no_rasl_output: true,
            active_sequence_set: None,
            recovery_point: None,
            recovery_poc: RECOVERY_UNSPECIFIED,
            waiting: Vec::new(),
            next_output_index: 0,
            events: Vec::new(),
            tables_key: (usize::MAX, usize::MAX, 0, 0),
            tables_generation: 0,
            layout: CTBLayout::default(),
            rbsp: Vec::new(),
            escapes: Vec::new(),
            template,
        }
    }

    /// Parses the codec private data, an hvcC record or Annex B parameter sets.
    pub fn configure(&mut self, configuration: &[u8]) -> DecodeResult<()> {
        let (mut units, length_size) = NALUnits::for_configuration(configuration);
        self.nal_length_size = length_size;
        while let Some((start, end)) = units.next_unit()? {
            self.process_parameter_set(&configuration[start..end])?;
        }
        Ok(())
    }

    /// The output events the last planned packet decided.
    pub fn events(&self) -> &[u32] {
        &self.events
    }

    fn next_generation(&mut self) -> u32 {
        self.generation = self.generation.wrapping_add(1).max(1);
        self.generation
    }

    /// Parses a parameter set NAL unit; other NAL unit types are ignored.
    fn process_parameter_set(&mut self, nal: &[u8]) -> DecodeResult<()> {
        if nal.len() < 2 {
            return Ok(());
        }
        let nal_type: u32 = u32::from(nal[0] >> 1) & 63;
        let layer_id: u32 = (u32::from(nal[0] & 1) << 5) | u32::from(nal[1] >> 3);
        if layer_id != 0 {
            return Ok(());
        }
        match nal_type {
            NAL_SPS | NAL_PPS => {
                let mut rbsp: Vec<u8> = std::mem::take(&mut self.rbsp);
                let mut escapes: Vec<u32> = std::mem::take(&mut self.escapes);
                rbsp.clear();
                escapes.clear();
                extract_rbsp(nal, &mut rbsp, &mut escapes);
                let result: DecodeResult<()> = self.parse_parameter_set(&rbsp, nal_type);
                self.rbsp = rbsp;
                self.escapes = escapes;
                result
            }
            _ => Ok(()),
        }
    }

    /// sei_rbsp (7.3.2.4) of a prefix SEI NAL unit, for its recovery point (D.2.8); like FFmpeg, a malformed message ends the parse without failing.
    fn process_prefix_sei(&mut self, nal: &[u8]) {
        let mut rbsp: Vec<u8> = std::mem::take(&mut self.rbsp);
        let mut escapes: Vec<u32> = std::mem::take(&mut self.escapes);
        rbsp.clear();
        escapes.clear();
        extract_rbsp(nal, &mut rbsp, &mut escapes);
        if let Some(recovery_poc_count) = find_recovery_point(&rbsp) {
            self.recovery_point = Some(recovery_poc_count);
        }
        self.rbsp = rbsp;
        self.escapes = escapes;
    }

    fn parse_parameter_set(&mut self, rbsp: &[u8], nal_type: u32) -> DecodeResult<()> {
        let mut reader: BitReader = BitReader::new(rbsp);
        reader.skip_bits(16);
        let generation: u32 = self.next_generation();
        if nal_type == NAL_SPS {
            let (sps_id, mut sps) = parse_sequence_parameter_set(&mut reader, generation)?;
            // A repeated SPS keeps the set it repeats, as FFmpeg keeps it, so it neither starts a new sequence nor rebuilds tables
            let data_length: usize = rbsp.iter().rposition(|&byte: &u8| byte != 0).map_or(0, |last: usize| last + 1);
            let data: &[u8] = &rbsp[..data_length];
            if self.sequence_sets[sps_id].as_deref().is_some_and(|existing: &SequenceParameterSet| existing.data == data) {
                return Ok(());
            }
            sps.data = data.to_vec();
            self.sequence_sets[sps_id] = Some(Box::new(sps));
            return Ok(());
        }
        if let Some((pps_id, pps)) = parse_picture_parameter_set(&mut reader, &self.sequence_sets, generation)? {
            self.picture_sets[pps_id] = Some(Box::new(pps));
        }
        Ok(())
    }

    /// Plans the picture of one packet, in decode order, with the output events its start decides.
    pub fn plan_packet(&mut self, packet: &[u8]) -> DecodeResult<PlanOutcome> {
        self.events.clear();
        // FFmpeg's decode_nal_units: an end of sequence before any other NAL unit precedes this packet's picture, and a later one the next packet's
        self.last_end_of_sequence = self.end_of_sequence;
        self.end_of_sequence = false;
        if self.last_end_of_sequence {
            self.reset_recovery_point();
        }
        let mut picture: PictureInProgress = PictureInProgress::new(self.template);
        let mut units: NALUnits = NALUnits::for_packet(packet, self.nal_length_size);
        let mut end_of_sequence_at_start: bool = true;
        while let Some((start, end)) = units.next_unit()? {
            self.process_packet_nal(&packet[start..end], &mut picture, &mut end_of_sequence_at_start)?;
        }
        if !picture.started || picture.skipped {
            return Ok(PlanOutcome::NoPicture);
        }
        self.set_up_units(&mut picture)?;
        let keep: Vec<u32> = std::mem::take(&mut picture.keep);
        Ok(PlanOutcome::Picture(Box::new(picture.plan), keep))
    }

    fn reset_recovery_point(&mut self) {
        self.recovery_poc = RECOVERY_UNSPECIFIED;
        self.recovery_point = None;
    }

    fn process_packet_nal(&mut self, nal: &[u8], picture: &mut PictureInProgress, end_of_sequence_at_start: &mut bool) -> DecodeResult<()> {
        if nal.len() < 2 {
            return Ok(());
        }
        let nal_type: u32 = u32::from(nal[0] >> 1) & 63;
        let layer_id: u32 = (u32::from(nal[0] & 1) << 5) | u32::from(nal[1] >> 3);
        let temporal_id: u32 = u32::from(nal[1] & 7).wrapping_sub(1);
        // FFmpeg counts an end of sequence or bitstream of any layer
        if nal_type == NAL_EOS || nal_type == NAL_EOB {
            if *end_of_sequence_at_start {
                self.last_end_of_sequence = true;
                self.reset_recovery_point();
            } else {
                self.end_of_sequence = true;
            }
            return Ok(());
        }
        *end_of_sequence_at_start = false;
        if layer_id != 0 {
            return Ok(());
        }
        match nal_type {
            NAL_SPS | NAL_PPS => self.process_parameter_set(nal),
            NAL_SEI_PREFIX => {
                self.process_prefix_sei(nal);
                Ok(())
            }
            _ => {
                let video_coding_layer: bool = nal_type <= NAL_RASL_R || (NAL_BLA_W_LP..=NAL_CRA).contains(&nal_type);
                if !video_coding_layer {
                    return Ok(());
                }
                let mut rbsp: Vec<u8> = std::mem::take(&mut self.rbsp);
                let mut escapes: Vec<u32> = std::mem::take(&mut self.escapes);
                rbsp.clear();
                escapes.clear();
                extract_rbsp(nal, &mut rbsp, &mut escapes);
                let result: DecodeResult<()> = self.parse_slice_segment(&rbsp, &escapes, nal_type, temporal_id, picture);
                self.rbsp = rbsp;
                self.escapes = escapes;
                result
            }
        }
    }

    /// slice_segment_header (7.3.6.1); records the segment and, for an independent segment, its slice.
    fn parse_slice_segment(&mut self, rbsp: &[u8], escapes: &[u32], nal_type: u32, temporal_id: u32, picture: &mut PictureInProgress) -> DecodeResult<()> {
        let mut reader: BitReader = BitReader::new(rbsp);
        reader.skip_bits(16);
        let first: bool = reader.read_flag() == 1;
        let irap: bool = (NAL_BLA_W_LP..=NAL_IRAP_LAST).contains(&nal_type);
        let no_output_of_prior_pictures: bool = irap && reader.read_flag() == 1;
        let pps_id: u32 = reader.read_unsigned_golomb();
        if pps_id as usize >= MAXIMUM_PPS_COUNT {
            return fail(ERROR_PARAMETER_SET_MISSING, pps_id);
        }
        let Some(pps) = self.picture_sets[pps_id as usize].clone() else {
            return fail(ERROR_PARAMETER_SET_MISSING, pps_id);
        };
        let Some(sps) = self.sequence_sets[pps.sps_id as usize].clone() else {
            return fail(ERROR_PARAMETER_SET_MISSING, pps.sps_id);
        };
        if first {
            if picture.started {
                return fail(ERROR_MULTIPLE_PICTURES, nal_type);
            }
            picture.started = true;
            picture.nal_type = nal_type;
            picture.irap = irap;
            picture.sps_id = pps.sps_id as usize;
            picture.pps_id = pps_id as usize;
            let idr: bool = nal_type == NAL_IDR_W_RADL || nal_type == NAL_IDR_N_LP;
            let broken_link: bool = (NAL_BLA_W_LP..=NAL_BLA_N_LP).contains(&nal_type);
            // FFmpeg's NoRaslOutputFlag: a CRA picture has it only after an end of sequence, which a new or reset sequencer starts with
            let clean_random_access_after_end: bool = nal_type == NAL_CRA && self.last_end_of_sequence;
            picture.no_rasl_output = irap && (idr || broken_link || clean_random_access_after_end);
            picture.no_output_of_prior_pictures = no_output_of_prior_pictures || clean_random_access_after_end;
            // A RASL picture of an IRAP picture that started decoding is skipped, as FFmpeg skips it; it changes no decoder state
            if (nal_type == NAL_RASL_N || nal_type == NAL_RASL_R) && self.irap_no_rasl_output {
                picture.skipped = true;
                return Ok(());
            }
            if irap {
                self.irap_no_rasl_output = picture.no_rasl_output;
            }
            let sequence_set: (usize, u32) = (pps.sps_id as usize, sps.generation);
            picture.sequence_set_changed = self.active_sequence_set != Some(sequence_set);
            picture.new_sequence = idr || broken_link || self.last_end_of_sequence || picture.sequence_set_changed;
            self.active_sequence_set = Some(sequence_set);
            self.activate_parameter_sets(&sps, &pps, picture)?;
        } else if picture.skipped {
            return Ok(());
        } else if !picture.started || pps_id as usize != picture.pps_id {
            return fail(ERROR_SLICE_HEADER, 1);
        }
        let mut dependent: u32 = 0;
        let mut segment_address: u32 = 0;
        if !first {
            if pps.dependent_slices == 1 {
                dependent = reader.read_flag();
            }
            segment_address = reader.read_bits(ceil_log2(picture.ctb_count));
            if segment_address >= picture.ctb_count {
                return fail(ERROR_SLICE_HEADER, segment_address);
            }
        }
        let segment_index: usize = picture.plan.segments.len();
        if segment_index >= MAXIMUM_SLICE_SEGMENTS as usize {
            return fail(ERROR_SLICE_SEGMENT_LIMIT, segment_index as u32);
        }
        let slice: usize = if dependent == 1 {
            if picture.plan.slices.is_empty() {
                return fail(ERROR_SLICE_HEADER, 2);
            }
            picture.plan.slices.len() - 1
        } else {
            if picture.plan.slices.len() >= MAXIMUM_SLICES as usize {
                return fail(ERROR_SLICE_SEGMENT_LIMIT, picture.plan.slices.len() as u32);
            }
            let header: SliceHeader = self.parse_independent_slice_header(&mut reader, segment_address, first, nal_type, temporal_id, &sps, &pps, picture)?;
            picture.plan.slices.push(header);
            picture.plan.slices.len() - 1
        };
        // Tile substreams without WPP keep their entry points, so each tile can start a unit of its own
        let mut entry_point_raw_offsets: Vec<u32> = Vec::new();
        if pps.tiles == 1 || pps.entropy_sync == 1 {
            let offset_count: u32 = reader.read_unsigned_golomb();
            if offset_count > 0 {
                let offset_length: u32 = reader.read_unsigned_golomb().saturating_add(1);
                if offset_length > MAXIMUM_OFFSET_LENGTH {
                    return fail(ERROR_SLICE_HEADER, offset_length);
                }
                let keep: bool = pps.tiles == 1
                    && pps.entropy_sync == 0
                    && (offset_count as usize) <= MAXIMUM_ENTRY_POINTS - picture.plan.entry_points.len();
                for _ in 0..offset_count {
                    if reader.overrun() {
                        break;
                    }
                    // entry_point_offset_minus1 counts raw bytes, emulation prevention bytes included
                    let offset: u32 = reader.read_bits(offset_length).wrapping_add(1);
                    if keep {
                        entry_point_raw_offsets.push(offset);
                    }
                }
            }
        }
        if pps.slice_header_extension == 1 {
            let extension_length: u32 = reader.read_unsigned_golomb();
            reader.skip_bits(extension_length.saturating_mul(8));
        }
        // byte_alignment(): alignment_bit_equal_to_one, then zero bits
        if reader.read_flag() != 1 || reader.overrun() {
            return fail(ERROR_SLICE_HEADER, 3);
        }
        reader.align();
        let data_start: usize = reader.byte_position();
        if data_start > rbsp.len() {
            return fail(ERROR_SLICE_HEADER, 3);
        }
        let data_offset: usize = picture.plan.data.len();
        picture.plan.data.extend_from_slice(&rbsp[data_start..]);
        let data_end: usize = picture.plan.data.len();
        picture.plan.data.resize(data_end + SEGMENT_PADDING_BYTES, 0);
        // Each kept entry point starts the substream of the next tile, as an offset into the plan's data
        let entry_point_first: usize = picture.plan.entry_points.len();
        let mut raw_position: usize = raw_position_of(data_start, escapes);
        for &offset in &entry_point_raw_offsets {
            raw_position = raw_position.saturating_add(offset as usize);
            let rbsp_index: usize = rbsp_index_of(raw_position, escapes);
            if rbsp_index < data_start || rbsp_index >= rbsp.len() {
                return fail(ERROR_SLICE_HEADER, 4);
            }
            picture.plan.entry_points.push((data_offset + rbsp_index - data_start) as u32);
        }
        picture.plan.segments.push(Segment {
            slice: slice as u32,
            address_ts: self.layout.rs_to_ts[segment_address as usize],
            data_offset: data_offset as u32,
            data_end: data_end as u32,
            dependent,
            entry_point_first: entry_point_first as u32,
            entry_point_count: entry_point_raw_offsets.len() as u32,
        });
        Ok(())
    }

    /// Copies the active SPS and PPS into the picture's parameters, with the tile boundaries and CTB tables, and starts its ID.
    fn activate_parameter_sets(&mut self, sps: &SequenceParameterSet, pps: &PictureParameterSet, picture: &mut PictureInProgress) -> DecodeResult<()> {
        let width: u32 = sps.width;
        let height: u32 = sps.height;
        if width > MAXIMUM_WIDTH || height > MAXIMUM_HEIGHT || u64::from(width) * u64::from(height) > u64::from(MAXIMUM_LUMA_PICTURE_SIZE) {
            return fail(ERROR_PICTURE_SIZE, width);
        }
        if sps.extended_precision == 1 || sps.cabac_bypass_alignment == 1 {
            return fail(ERROR_UNSUPPORTED_FORMAT, 4);
        }
        let ctb_log2: u32 = sps.ctb_log2;
        let width_in_ctbs: u32 = (width + (1 << ctb_log2) - 1) >> ctb_log2;
        let height_in_ctbs: u32 = (height + (1 << ctb_log2) - 1) >> ctb_log2;
        let parameters: &mut PictureParameters = &mut picture.plan.parameters;
        parameters.tile_columns = pps.tile_columns;
        parameters.tile_rows = pps.tile_rows;
        let uniform: bool = pps.uniform_spacing == 1;
        let mut boundary: u32 = 0;
        parameters.column_boundaries[0] = 0;
        for column in 0..pps.tile_columns {
            let column_width: u32 = if uniform {
                ((column + 1) * width_in_ctbs) / pps.tile_columns - (column * width_in_ctbs) / pps.tile_columns
            } else if column + 1 < pps.tile_columns {
                pps.column_widths[column as usize]
            } else {
                width_in_ctbs - boundary.min(width_in_ctbs)
            };
            boundary = boundary.saturating_add(column_width);
            parameters.column_boundaries[column as usize + 1] = boundary;
        }
        let columns_valid: bool = boundary == width_in_ctbs;
        boundary = 0;
        parameters.row_boundaries[0] = 0;
        for row in 0..pps.tile_rows {
            let row_height: u32 = if uniform {
                ((row + 1) * height_in_ctbs) / pps.tile_rows - (row * height_in_ctbs) / pps.tile_rows
            } else if row + 1 < pps.tile_rows {
                pps.row_heights[row as usize]
            } else {
                height_in_ctbs - boundary.min(height_in_ctbs)
            };
            boundary = boundary.saturating_add(row_height);
            parameters.row_boundaries[row as usize + 1] = boundary;
        }
        if !columns_valid || boundary != height_in_ctbs {
            return fail(ERROR_PARAMETER_SET_INVALID, 8);
        }
        let tables_key: (usize, usize, u32, u32) = (picture.sps_id, picture.pps_id, sps.generation, pps.generation);
        if tables_key != self.tables_key {
            self.tables_key = tables_key;
            self.tables_generation = self.tables_generation.wrapping_add(1).max(1);
        }
        let chroma_format: u32 = sps.chroma_format;
        parameters.picture_id = self.next_picture_id;
        self.next_picture_id = self.next_picture_id.wrapping_add(1);
        if self.next_picture_id == MISSING_PICTURE {
            self.next_picture_id = 0;
        }
        parameters.width = width;
        parameters.height = height;
        parameters.chroma_format = chroma_format;
        parameters.horizontal_shift = u32::from(chroma_format == 1 || chroma_format == 2);
        parameters.vertical_shift = u32::from(chroma_format == 1);
        parameters.bit_depth = sps.bit_depth;
        parameters.bit_depth_chroma = if chroma_format != 0 { sps.bit_depth_chroma } else { sps.bit_depth };
        parameters.ctb_log2 = ctb_log2;
        parameters.min_cb_log2 = sps.min_cb_log2;
        parameters.min_tb_log2 = sps.min_tb_log2;
        parameters.max_tb_log2 = sps.max_tb_log2;
        parameters.max_transform_depth_inter = sps.max_transform_depth_inter;
        parameters.max_transform_depth_intra = sps.max_transform_depth_intra;
        parameters.ctb_width = width_in_ctbs;
        parameters.ctb_height = height_in_ctbs;
        parameters.ctb_count = width_in_ctbs * height_in_ctbs;
        parameters.amp = sps.amp;
        parameters.pcm = sps.pcm;
        parameters.pcm_bit_depth = sps.pcm_bit_depth;
        parameters.pcm_bit_depth_chroma = sps.pcm_bit_depth_chroma;
        parameters.pcm_min_log2 = sps.pcm_min_log2;
        parameters.pcm_max_log2 = sps.pcm_max_log2;
        parameters.pcm_loop_filter_disabled = sps.pcm_loop_filter_disabled & sps.pcm;
        parameters.scaling_list_enabled = sps.scaling_list_enabled;
        parameters.scaling_list = if pps.scaling_list_present == 1 { pps.scaling_list.bytes } else { sps.scaling_list.bytes };
        parameters.strong_intra_smoothing = sps.strong_intra_smoothing;
        parameters.transform_skip_rotation = sps.transform_skip_rotation;
        parameters.transform_skip_context = sps.transform_skip_context;
        parameters.implicit_rdpcm = sps.implicit_rdpcm;
        parameters.explicit_rdpcm = sps.explicit_rdpcm;
        parameters.intra_smoothing_disabled = sps.intra_smoothing_disabled;
        parameters.persistent_rice = sps.persistent_rice;
        parameters.sign_data_hiding = pps.sign_data_hiding;
        parameters.constrained_intra_pred = pps.constrained_intra_pred;
        parameters.transform_skip = pps.transform_skip;
        parameters.cu_qp_delta = pps.cu_qp_delta;
        parameters.min_cu_qp_delta_log2 = ctb_log2 - pps.diff_cu_qp_delta_depth.min(ctb_log2);
        parameters.cb_qp_offset = pps.cb_qp_offset;
        parameters.cr_qp_offset = pps.cr_qp_offset;
        parameters.transquant_bypass = pps.transquant_bypass;
        parameters.tiles = pps.tiles;
        parameters.entropy_sync = pps.entropy_sync;
        parameters.loop_filter_across_tiles = pps.loop_filter_across_tiles;
        parameters.log2_parallel_merge = pps.log2_parallel_merge;
        parameters.log2_max_transform_skip = pps.log2_max_transform_skip;
        parameters.cross_component = pps.cross_component;
        parameters.chroma_qp_offset_list = pps.chroma_qp_offset_list;
        parameters.min_cu_chroma_qp_offset_log2 = ctb_log2 - pps.diff_cu_chroma_qp_offset_depth.min(ctb_log2);
        parameters.chroma_qp_offset_list_length = pps.chroma_qp_offset_list_length;
        parameters.cb_qp_offset_list = pps.cb_qp_offset_list;
        parameters.cr_qp_offset_list = pps.cr_qp_offset_list;
        parameters.log2_sao_offset_scale_luma = pps.log2_sao_offset_scale_luma;
        parameters.log2_sao_offset_scale_chroma = pps.log2_sao_offset_scale_chroma;
        parameters.qp_bd_offset = 6 * (sps.bit_depth as i32 - 8);
        parameters.conformance_left = sps.conformance_left;
        parameters.conformance_right = sps.conformance_right;
        parameters.conformance_top = sps.conformance_top;
        parameters.conformance_bottom = sps.conformance_bottom;
        parameters.tables_generation = self.tables_generation;
        parameters.sao_any = 0;
        parameters.deblocking_any = 0;
        picture.ctb_count = parameters.ctb_count;
        self.layout.update(parameters);
        Ok(())
    }

    /// The POC of the current picture (8.3.1).
    fn compute_picture_order_count(&mut self, poc_lsb: u32, log2_max_poc_lsb: u32, temporal_id: u32, picture: &PictureInProgress) -> i32 {
        let mut poc_msb: i32 = 0;
        if !(picture.irap && picture.no_rasl_output) {
            let max_poc_lsb: i32 = 1 << log2_max_poc_lsb;
            let lsb: i32 = poc_lsb as i32;
            if lsb < self.previous_poc_lsb && self.previous_poc_lsb - lsb >= max_poc_lsb / 2 {
                poc_msb = self.previous_poc_msb + max_poc_lsb;
            } else if lsb > self.previous_poc_lsb && lsb - self.previous_poc_lsb > max_poc_lsb / 2 {
                poc_msb = self.previous_poc_msb - max_poc_lsb;
            } else {
                poc_msb = self.previous_poc_msb;
            }
        }
        // prevTid0Pic: temporal ID 0 and not a RASL, RADL, or sub-layer non-reference picture
        let nal_type: u32 = picture.nal_type;
        let sub_layer_non_reference: bool = nal_type <= NAL_SUB_LAYER_NON_REFERENCE_LAST && nal_type & 1 == 0;
        let leading: bool = (NAL_RADL_N..=NAL_RASL_R).contains(&nal_type);
        if temporal_id == 0 && !sub_layer_non_reference && !leading {
            self.previous_poc_lsb = poc_lsb as i32;
            self.previous_poc_msb = poc_msb;
        }
        poc_msb.wrapping_add(poc_lsb as i32)
    }

    /// Adds a DPB entry; returns its index.
    fn add_dpb_entry(&mut self, picture_id: u32, poc: i32, flags: u32) -> DecodeResult<usize> {
        let Some(index) = self.dpb.iter().position(|entry: &DPBEntry| entry.flags & DPB_VALID == 0) else {
            return fail(ERROR_REFERENCE_PICTURES, DPB_ENTRY_COUNT as u32);
        };
        self.dpb[index] = DPBEntry { flags: flags | DPB_VALID, picture_id, poc };
        Ok(index)
    }

    /// Finds the DPB picture of a POC, comparing all bits or only the POC LSB; generates a missing picture when there is none (8.3.3).
    fn find_reference_picture(&mut self, poc: i32, use_msb: bool, lsb_mask: u32, flag: u32, current_poc: i32) -> DecodeResult<usize> {
        for index in 0..DPB_ENTRY_COUNT {
            let entry: DPBEntry = self.dpb[index];
            if entry.flags & DPB_VALID == 0 {
                continue;
            }
            let matches: bool = if use_msb { entry.poc == poc } else { (entry.poc as u32 & lsb_mask) == poc as u32 };
            if matches && (use_msb || entry.poc != current_poc) {
                self.dpb[index].flags = (entry.flags & !(DPB_SHORT_TERM | DPB_LONG_TERM)) | flag | DPB_MARKED;
                return Ok(index);
            }
        }
        self.add_dpb_entry(MISSING_PICTURE, poc, DPB_MISSING | DPB_MARKED | flag)
    }

    /// The decoding process for the RPS (8.3.2); the current picture then joins the DPB, and the pictures it keeps are listed.
    fn apply_reference_picture_set(
        &mut self,
        short_term: &ShortTermSet,
        long_term: &LongTermSet,
        log2_max_poc_lsb: u32,
        picture: &mut PictureInProgress,
    ) -> DecodeResult<()> {
        // Missing pictures generated for the previous picture leave first
        for entry in &mut self.dpb {
            if entry.flags & DPB_MISSING != 0 {
                *entry = DPBEntry::default();
            } else if entry.flags & DPB_VALID != 0 {
                entry.flags &= !(DPB_MARKED | DPB_SHORT_TERM | DPB_LONG_TERM);
            }
        }
        picture.short_term_before.clear();
        picture.short_term_after.clear();
        picture.long_term_current.clear();
        let current_poc: i32 = picture.poc;
        if !(picture.irap && picture.no_rasl_output) {
            for index in 0..short_term.count as usize {
                let entry: usize = self.find_reference_picture(current_poc.wrapping_add(short_term.delta_pocs[index]), true, u32::MAX, DPB_SHORT_TERM, current_poc)?;
                if short_term.used[index] == 0 {
                    continue;
                }
                if index < short_term.negative_count as usize {
                    picture.short_term_before.push(entry);
                } else {
                    picture.short_term_after.push(entry);
                }
            }
            let lsb_mask: u32 = (1u32 << log2_max_poc_lsb) - 1;
            for index in 0..long_term.count {
                let entry: usize = self.find_reference_picture(long_term.pocs[index], long_term.msb_present[index] == 1, lsb_mask, DPB_LONG_TERM, current_poc)?;
                if long_term.used[index] == 1 && picture.long_term_current.len() < MAXIMUM_DPB_PICTURES as usize {
                    picture.long_term_current.push(entry);
                }
            }
        }
        for entry in &mut self.dpb {
            if entry.flags & DPB_VALID != 0 && entry.flags & DPB_MARKED == 0 {
                *entry = DPBEntry::default();
            }
        }
        picture.keep.clear();
        for entry in &self.dpb {
            if entry.flags & DPB_VALID != 0 && entry.flags & DPB_MISSING == 0 {
                picture.keep.push(entry.picture_id);
            }
        }
        self.add_dpb_entry(picture.plan.parameters.picture_id, current_poc, DPB_SHORT_TERM)?;
        Ok(())
    }

    /// FFmpeg's ff_hevc_set_new_ref: the current picture takes the next output index and waits for output, unless pic_output_flag is 0
    /// or a recovery point holds it back; a picture that is never output is discarded at once, so the engine frees its slot.
    fn add_waiting_picture(&mut self, picture: &PictureInProgress, output_flag: bool) {
        if picture.irap {
            self.recovery_poc = RECOVERY_END;
        }
        if self.recovery_poc != RECOVERY_END
            && let Some(recovery_poc_count) = self.recovery_point
        {
            if self.recovery_poc == RECOVERY_UNSPECIFIED {
                self.recovery_poc = picture.poc.wrapping_add(recovery_poc_count);
            } else if picture.poc >= self.recovery_poc {
                self.recovery_poc = RECOVERY_END;
            }
        }
        let recovering: bool = self.recovery_poc != RECOVERY_UNSPECIFIED && self.recovery_poc != RECOVERY_END;
        let held_back: bool = !picture.irap && picture.poc < self.recovery_poc && recovering;
        let index: u32 = self.next_output_index;
        self.next_output_index = self.next_output_index.wrapping_add(1) & OUTPUT_EVENT_INDEX_MASK;
        if output_flag && !held_back {
            self.waiting.push(WaitingPicture { index, picture_id: picture.plan.parameters.picture_id, poc: picture.poc });
        } else {
            self.events.push(index | OUTPUT_EVENT_DISCARD);
        }
    }

    /// FFmpeg's ff_hevc_output_frames: while more pictures wait than maximum_waiting, or any wait while the DPB holds more than maximum_pictures,
    /// the waiting picture with the lowest POC leaves, output or discarded.
    fn output_waiting_pictures(&mut self, maximum_waiting: u32, maximum_pictures: u32, discard: bool) {
        while !self.waiting.is_empty() {
            if self.waiting.len() as u32 <= maximum_waiting && self.count_dpb_pictures() <= maximum_pictures {
                return;
            }
            let mut lowest: usize = 0;
            for (position, waiting) in self.waiting.iter().enumerate() {
                if waiting.poc < self.waiting[lowest].poc {
                    lowest = position;
                }
            }
            let picture: WaitingPicture = self.waiting.remove(lowest);
            self.events.push(if discard { picture.index | OUTPUT_EVENT_DISCARD } else { picture.index });
        }
    }

    /// FFmpeg's nb_dpb: the references, generated missing references, and current picture in the DPB, and the other pictures waiting for output.
    fn count_dpb_pictures(&self) -> u32 {
        let mut count: u32 = 0;
        for entry in &self.dpb {
            if entry.flags & DPB_VALID != 0 {
                count += 1;
            }
        }
        for waiting in &self.waiting {
            let in_dpb: bool = self
                .dpb
                .iter()
                .any(|entry: &DPBEntry| entry.flags & DPB_VALID != 0 && entry.flags & DPB_MISSING == 0 && entry.picture_id == waiting.picture_id);
            if !in_dpb {
                count += 1;
            }
        }
        count
    }

    /// pred_weight_table (7.3.6.3), into the slice header; false on an out-of-range value.
    fn parse_prediction_weights(reader: &mut BitReader, header: &mut SliceHeader, chroma_format: u32) -> bool {
        let luma_denominator: u32 = reader.read_unsigned_golomb();
        if luma_denominator > 7 {
            return false;
        }
        let mut chroma_denominator: i32 = 0;
        if chroma_format != 0 {
            chroma_denominator = luma_denominator as i32 + reader.read_signed_golomb();
            if !(0..=7).contains(&chroma_denominator) {
                return false;
            }
        }
        header.luma_log2_weight_denominator = luma_denominator;
        header.chroma_log2_weight_denominator = chroma_denominator as u32;
        let list_count: usize = if header.slice_type == SLICE_B { 2 } else { 1 };
        for list in 0..list_count {
            let count: u32 = header.reference_counts[list];
            let luma_flags: u32 = reader.read_bits(count);
            let chroma_flags: u32 = if chroma_format != 0 { reader.read_bits(count) } else { 0 };
            for ref_idx in 0..count as usize {
                let flag_bit: u32 = 1 << (count - 1 - ref_idx as u32);
                let mut luma_weight: i32 = 1 << luma_denominator;
                let mut luma_offset: i32 = 0;
                if luma_flags & flag_bit != 0 {
                    let delta: i32 = reader.read_signed_golomb();
                    if !(-128..=127).contains(&delta) {
                        return false;
                    }
                    luma_weight += delta;
                    luma_offset = reader.read_signed_golomb();
                }
                let entry: &mut [i32; 6] = &mut header.weights[list][ref_idx];
                entry[0] = luma_weight;
                entry[1] = luma_offset;
                for component in 0..2 {
                    let mut chroma_weight: i32 = 1 << chroma_denominator;
                    let mut chroma_offset: i32 = 0;
                    if chroma_flags & flag_bit != 0 {
                        let weight_delta: i32 = reader.read_signed_golomb();
                        let offset_delta: i32 = reader.read_signed_golomb();
                        if !(-128..=127).contains(&weight_delta) || !(-(1 << 17)..=(1 << 17)).contains(&offset_delta) {
                            return false;
                        }
                        chroma_weight += weight_delta;
                        chroma_offset = (offset_delta - ((128 * chroma_weight) >> chroma_denominator) + 128).clamp(-128, 127);
                    }
                    entry[2 + component * 2] = chroma_weight;
                    entry[3 + component * 2] = chroma_offset;
                }
            }
        }
        true
    }

    /// Builds RefPicList0 and RefPicList1 of a slice (8.3.4) into its header; false when a list refers past the candidates.
    fn build_reference_lists(&self, header: &mut SliceHeader, modification_flags: [u32; 2], list_entries: &[[u32; 16]; 2], picture: &PictureInProgress) -> bool {
        let total_current: usize = picture.short_term_before.len() + picture.short_term_after.len() + picture.long_term_current.len();
        if total_current == 0 {
            return false;
        }
        let list_count: usize = if header.slice_type == SLICE_B { 2 } else { 1 };
        for list in 0..list_count {
            let count: usize = header.reference_counts[list] as usize;
            let mut temporary: [usize; 16] = [0; 16];
            let mut temporary_long_term: [u32; 16] = [0; 16];
            let mut temporary_count: usize = 0;
            let wanted: usize = count.max(total_current).min(16);
            let (first_part, second_part) = if list == 1 {
                (&picture.short_term_after, &picture.short_term_before)
            } else {
                (&picture.short_term_before, &picture.short_term_after)
            };
            while temporary_count < wanted {
                for (part_index, part) in [first_part, second_part, &picture.long_term_current].into_iter().enumerate() {
                    for &entry in part {
                        if temporary_count >= wanted {
                            break;
                        }
                        temporary[temporary_count] = entry;
                        temporary_long_term[temporary_count] = u32::from(part_index == 2);
                        temporary_count += 1;
                    }
                }
            }
            for ref_idx in 0..count {
                let mut index: usize = ref_idx;
                if modification_flags[list] == 1 {
                    index = list_entries[list][ref_idx] as usize;
                    if index >= temporary_count {
                        return false;
                    }
                }
                let entry: DPBEntry = self.dpb[temporary[index]];
                header.references[list][ref_idx] = ReferenceEntry { picture_id: entry.picture_id, poc: entry.poc, long_term: temporary_long_term[index] };
            }
        }
        true
    }

    /// The independent part of a slice segment header; the first slice also computes the POC and applies the RPS.
    #[allow(clippy::too_many_arguments)]
    fn parse_independent_slice_header(
        &mut self,
        reader: &mut BitReader,
        slice_address: u32,
        first: bool,
        nal_type: u32,
        temporal_id: u32,
        sps: &SequenceParameterSet,
        pps: &PictureParameterSet,
        picture: &mut PictureInProgress,
    ) -> DecodeResult<SliceHeader> {
        let mut header: SliceHeader = SliceHeader::empty();
        reader.skip_bits(pps.extra_slice_header_bits);
        let slice_type: u32 = reader.read_unsigned_golomb();
        if slice_type > SLICE_I || (picture.irap && slice_type != SLICE_I) {
            return fail(ERROR_SLICE_HEADER, 10u32.saturating_add(slice_type));
        }
        header.slice_type = slice_type;
        let output_flag: bool = pps.output_flag_present == 0 || reader.read_flag() == 1;
        let log2_max_poc_lsb: u32 = sps.log2_max_poc_lsb;
        let idr: bool = nal_type == NAL_IDR_W_RADL || nal_type == NAL_IDR_N_LP;
        let mut temporal_mvp: u32 = 0;
        let mut short_term: ShortTermSet = ShortTermSet::default();
        let mut long_term: LongTermSet = LongTermSet::default();
        if !idr {
            let poc_lsb: u32 = reader.read_bits(log2_max_poc_lsb);
            if first {
                picture.poc = self.compute_picture_order_count(poc_lsb, log2_max_poc_lsb, temporal_id, picture);
            }
            let short_term_set_count: u32 = sps.short_term_set_count;
            if reader.read_flag() == 0 {
                let Some(parsed) = parse_short_term_set(reader, &sps.short_term_sets, short_term_set_count, short_term_set_count, true) else {
                    return fail(ERROR_SLICE_HEADER, 20);
                };
                short_term = parsed;
            } else {
                if short_term_set_count == 0 {
                    return fail(ERROR_SLICE_HEADER, 21);
                }
                let set_index: u32 = reader.read_bits(ceil_log2(short_term_set_count));
                if set_index >= short_term_set_count {
                    return fail(ERROR_SLICE_HEADER, 22);
                }
                short_term = sps.short_term_sets[set_index as usize];
            }
            if sps.long_term_present == 1 {
                let sps_candidates: u32 = sps.long_term_count;
                let sps_long_term_count: u32 = if sps_candidates > 0 { reader.read_unsigned_golomb() } else { 0 };
                let slice_long_term_count: u32 = reader.read_unsigned_golomb();
                if sps_long_term_count > sps_candidates || sps_long_term_count.saturating_add(slice_long_term_count) > MAXIMUM_LONG_TERM_PICTURES as u32 {
                    return fail(ERROR_SLICE_HEADER, 23);
                }
                long_term.count = (sps_long_term_count + slice_long_term_count) as usize;
                let mut previous_delta_msb: u32 = 0;
                for index in 0..long_term.count {
                    let lsb: u32;
                    if index < sps_long_term_count as usize {
                        let candidate: u32 = if sps_candidates > 1 { reader.read_bits(ceil_log2(sps_candidates)) } else { 0 };
                        lsb = sps.long_term_lsb[candidate.min(31) as usize];
                        long_term.used[index] = ((sps.long_term_used_mask >> candidate.min(31)) & 1) as u8;
                    } else {
                        lsb = reader.read_bits(log2_max_poc_lsb);
                        long_term.used[index] = reader.read_flag() as u8;
                    }
                    long_term.msb_present[index] = reader.read_flag() as u8;
                    long_term.pocs[index] = lsb as i32;
                    if long_term.msb_present[index] == 1 {
                        let mut delta_msb: u32 = reader.read_unsigned_golomb();
                        if delta_msb > MAXIMUM_DELTA_POC_MSB_CYCLE {
                            return fail(ERROR_SLICE_HEADER, 24);
                        }
                        if index != 0 && index != sps_long_term_count as usize {
                            delta_msb = delta_msb.wrapping_add(previous_delta_msb);
                        }
                        long_term.pocs[index] = (lsb as i32)
                            .wrapping_add(picture.poc)
                            .wrapping_sub((delta_msb << log2_max_poc_lsb) as i32)
                            .wrapping_sub(poc_lsb as i32);
                        previous_delta_msb = delta_msb;
                    }
                }
            }
            if sps.temporal_mvp == 1 {
                temporal_mvp = reader.read_flag();
            }
        } else if first {
            picture.poc = self.compute_picture_order_count(0, log2_max_poc_lsb, temporal_id, picture);
        }
        if first {
            picture.plan.parameters.poc = picture.poc;
            // FFmpeg's hevc_frame_start: a new sequence first outputs every waiting picture, or discards them for no_output_of_prior_pics_flag,
            // and another SPS drops every reference; after the RPS, the pictures past the SPS's reorder depth or DPB size leave
            if picture.new_sequence {
                self.output_waiting_pictures(0, 0, picture.no_output_of_prior_pictures);
            }
            if picture.sequence_set_changed {
                self.dpb = [DPBEntry::default(); DPB_ENTRY_COUNT];
            }
            self.apply_reference_picture_set(&short_term, &long_term, log2_max_poc_lsb, picture)?;
            self.add_waiting_picture(picture, output_flag);
            self.output_waiting_pictures(sps.num_reorder_pictures, sps.max_dec_pic_buffering, false);
        }
        let chroma_format: u32 = sps.chroma_format;
        if sps.sao == 1 {
            header.sao_luma = reader.read_flag();
            if chroma_format != 0 {
                header.sao_chroma = reader.read_flag();
            }
        }
        let mut modification_flags: [u32; 2] = [0; 2];
        let mut list_entries: [[u32; 16]; 2] = [[0; 16]; 2];
        let mut collocated_ref_idx: u32 = 0;
        if slice_type != SLICE_I {
            header.reference_counts[0] = pps.num_ref_idx_l0_default;
            if slice_type == SLICE_B {
                header.reference_counts[1] = pps.num_ref_idx_l1_default;
            }
            if reader.read_flag() == 1 {
                header.reference_counts[0] = reader.read_unsigned_golomb().saturating_add(1);
                if slice_type == SLICE_B {
                    header.reference_counts[1] = reader.read_unsigned_golomb().saturating_add(1);
                }
            }
            if header.reference_counts[0] > 16 || header.reference_counts[1] > 16 {
                return fail(ERROR_SLICE_HEADER, 30);
            }
            let total_current: u32 = (picture.short_term_before.len() + picture.short_term_after.len() + picture.long_term_current.len()) as u32;
            if pps.lists_modification == 1 && total_current > 1 {
                let entry_bits: u32 = ceil_log2(total_current);
                for list in 0..(if slice_type == SLICE_B { 2 } else { 1 }) {
                    modification_flags[list] = reader.read_flag();
                    if modification_flags[list] == 1 {
                        for index in 0..header.reference_counts[list] as usize {
                            list_entries[list][index] = reader.read_bits(entry_bits);
                        }
                    }
                }
            }
            if slice_type == SLICE_B {
                header.mvd_l1_zero = reader.read_flag();
            }
            if pps.cabac_init_present == 1 {
                header.cabac_init = reader.read_flag();
            }
            if temporal_mvp == 1 {
                if slice_type == SLICE_B {
                    header.collocated_list = 1 - reader.read_flag();
                }
                if header.reference_counts[header.collocated_list as usize] > 1 {
                    collocated_ref_idx = reader.read_unsigned_golomb();
                    if collocated_ref_idx >= header.reference_counts[header.collocated_list as usize] {
                        return fail(ERROR_SLICE_HEADER, 31);
                    }
                }
            }
            let weighted: bool = (pps.weighted_pred == 1 && slice_type == SLICE_P) || (pps.weighted_bipred == 1 && slice_type == SLICE_B);
            header.weighted = u32::from(weighted);
            if weighted && !Self::parse_prediction_weights(reader, &mut header, chroma_format) {
                return fail(ERROR_SLICE_HEADER, 32);
            }
            let five_minus_max_merge_candidates: u32 = reader.read_unsigned_golomb();
            if five_minus_max_merge_candidates > 4 {
                return fail(ERROR_SLICE_HEADER, 33);
            }
            header.max_merge_candidates = 5 - five_minus_max_merge_candidates;
            if !self.build_reference_lists(&mut header, modification_flags, &list_entries, picture) {
                return fail(ERROR_REFERENCE_PICTURES, 1);
            }
        }
        header.qp = pps.init_qp.wrapping_add(reader.read_signed_golomb());
        if pps.slice_chroma_qp_offsets == 1 {
            header.cb_qp_offset = reader.read_signed_golomb();
            header.cr_qp_offset = reader.read_signed_golomb();
        }
        if pps.chroma_qp_offset_list == 1 {
            header.cu_chroma_qp_offset = reader.read_flag();
        }
        if pps.deblocking_control == 1 {
            let deblocking_override: u32 = if pps.deblocking_override == 1 { reader.read_flag() } else { 0 };
            if deblocking_override == 1 {
                header.deblocking_disabled = reader.read_flag();
                if header.deblocking_disabled == 0 {
                    header.beta_offset = reader.read_signed_golomb().wrapping_mul(2);
                    header.tc_offset = reader.read_signed_golomb().wrapping_mul(2);
                }
            } else {
                header.deblocking_disabled = pps.deblocking_disabled;
                header.beta_offset = pps.beta_offset;
                header.tc_offset = pps.tc_offset;
            }
        }
        header.loop_filter_across_slices = pps.loop_filter_across_slices;
        if header.loop_filter_across_slices == 1 && (header.sao_luma == 1 || header.sao_chroma == 1 || header.deblocking_disabled == 0) {
            header.loop_filter_across_slices = reader.read_flag();
        }
        let qp_bd_offset: i32 = 6 * (sps.bit_depth as i32 - 8);
        if header.qp < -qp_bd_offset || header.qp > MAXIMUM_SLICE_QP || reader.overrun() {
            return fail(ERROR_SLICE_HEADER, 40);
        }
        // NoBackwardPredFlag: no reference picture follows the current picture
        header.no_backward_prediction = 1;
        for list in 0..LIST_COUNT {
            for ref_idx in 0..header.reference_counts[list] as usize {
                if header.references[list][ref_idx].poc > picture.poc {
                    header.no_backward_prediction = 0;
                }
            }
        }
        header.temporal_mvp = temporal_mvp;
        header.collocated_ref_idx = collocated_ref_idx;
        if temporal_mvp == 1 && slice_type != SLICE_I {
            let collocated: ReferenceEntry = header.references[header.collocated_list as usize][collocated_ref_idx as usize];
            header.collocated_valid = u32::from(collocated.picture_id != MISSING_PICTURE);
        }
        header.address_rs = slice_address;
        header.address_ts = self.layout.rs_to_ts[slice_address as usize];
        if header.sao_luma == 1 || header.sao_chroma == 1 {
            picture.plan.parameters.sao_any = 1;
        }
        if header.deblocking_disabled == 0 {
            picture.plan.parameters.deblocking_any = 1;
        }
        Ok(header)
    }

    /// Groups the segments into decoding units, which may parse in parallel.
    /// A unit starts at every independent slice segment and, when tiles code without WPP, at every tile a segment or a substream starts,
    /// since a tile initializes its contexts and nothing in it depends on another tile. A unit ends where the next one starts.
    fn set_up_units(&self, picture: &mut PictureInProgress) -> DecodeResult<()> {
        let plan: &mut Plan = &mut picture.plan;
        let parameters: &PictureParameters = &plan.parameters;
        let tile_count: u32 = parameters.tile_columns * parameters.tile_rows;
        let tiles_split: bool = parameters.tiles == 1 && parameters.entropy_sync == 0;
        let mut units: Vec<Unit> = Vec::new();
        for (segment_index, segment) in plan.segments.iter().enumerate() {
            // A slice that codes chroma QP offsets carries them from tile to tile, so its tiles stay in one unit
            let split_tiles: bool = tiles_split && plan.slices[segment.slice as usize].cu_chroma_qp_offset == 0;
            let segment_ts: u32 = segment.address_ts;
            let starts_tile: bool = segment_ts == 0 || self.layout.tile_id[segment_ts as usize] != self.layout.tile_id[segment_ts as usize - 1];
            if segment.dependent == 0 || (split_tiles && starts_tile) {
                units.push(Unit {
                    first_segment: segment_index as u32,
                    last_segment: segment_index as u32,
                    ctb_ts: segment_ts,
                    end_ctb_ts: 0,
                    start: UNIT_STARTS_SEGMENT,
                    position: segment.data_offset,
                });
            } else if let Some(unit) = units.last_mut() {
                unit.last_segment = segment_index as u32;
            }
            if !split_tiles {
                continue;
            }
            // Entry point k starts the substream of the k-th tile after the segment's first one
            let first_tile: u32 = self.layout.tile_id[segment_ts as usize];
            let mut previous_ts: u32 = segment_ts;
            for entry_point in 0..segment.entry_point_count {
                let position: u32 = plan.entry_points[(segment.entry_point_first + entry_point) as usize];
                let tile: u32 = first_tile + entry_point + 1;
                if tile >= tile_count || position >= segment.data_end || position < segment.data_offset {
                    return fail(ERROR_SLICE_HEADER, 4);
                }
                let substream_ts: u32 = self.tile_start_ts(parameters, tile);
                if substream_ts <= previous_ts {
                    return fail(ERROR_SLICE_HEADER, 5);
                }
                previous_ts = substream_ts;
                units.push(Unit {
                    first_segment: segment_index as u32,
                    last_segment: segment_index as u32,
                    ctb_ts: substream_ts,
                    end_ctb_ts: 0,
                    start: UNIT_STARTS_SUBSTREAM,
                    position,
                });
            }
        }
        let ctb_count: u32 = parameters.ctb_count;
        for index in 0..units.len() {
            units[index].end_ctb_ts = if index + 1 < units.len() { units[index + 1].ctb_ts } else { ctb_count };
        }
        plan.units = units;
        Ok(())
    }

    /// The first CTB of a tile, in tile scan, from its raster tile index.
    fn tile_start_ts(&self, parameters: &PictureParameters, tile: u32) -> u32 {
        let columns: u32 = parameters.tile_columns;
        let row: u32 = parameters.row_boundaries[(tile / columns) as usize];
        let column: u32 = parameters.column_boundaries[(tile % columns) as usize];
        self.layout.rs_to_ts[(row * parameters.ctb_width + column) as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::empty_parameters;

    // A prefix SEI NAL unit header, then a recovery point message of recovery_poc_cnt 3: se(v) 00110, exact_match_flag 1, broken_link_flag 0
    const RECOVERY_POINT_SEI: [u8; 6] = [0x4E, 0x01, 0x06, 0x01, 0x34, RBSP_TRAILING_BYTE];
    const RECOVERY_POC_COUNT: i32 = 3;
    // The same message behind a user data message of 255 + 2 type bytes and 1 payload byte
    const RECOVERY_POINT_AFTER_LONG_TYPE: [u8; 9] = [0x4E, 0x01, 0xFF, 0x02, 0x01, 0x00, 0x06, 0x01, 0x34];
    // A message whose size runs past the RBSP
    const TRUNCATED_SEI: [u8; 5] = [0x4E, 0x01, 0x06, 0x08, 0x34];
    const REORDER_DEPTH: u32 = 2;
    const DPB_SIZE: u32 = 3;
    const LONG_DPB_SIZE: u32 = 16;

    fn waiting_picture(index: u32, poc: i32) -> WaitingPicture {
        WaitingPicture { index, picture_id: index, poc }
    }

    fn picture_with(poc: i32, irap: bool) -> PictureInProgress {
        let mut picture: PictureInProgress = PictureInProgress::new(empty_parameters());
        picture.poc = poc;
        picture.irap = irap;
        picture
    }

    #[test]
    fn reads_recovery_points() {
        assert_eq!(find_recovery_point(&RECOVERY_POINT_SEI), Some(RECOVERY_POC_COUNT));
        assert_eq!(find_recovery_point(&RECOVERY_POINT_AFTER_LONG_TYPE), Some(RECOVERY_POC_COUNT));
        assert_eq!(find_recovery_point(&TRUNCATED_SEI), None);
    }

    #[test]
    fn bumps_the_lowest_poc_past_the_reorder_depth() {
        let mut sequencer: Sequencer = Sequencer::new(empty_parameters());
        sequencer.waiting = vec![waiting_picture(0, 8), waiting_picture(1, 4), waiting_picture(2, 2)];
        sequencer.output_waiting_pictures(REORDER_DEPTH, LONG_DPB_SIZE, false);
        assert_eq!(sequencer.events, vec![2]);
        assert_eq!(sequencer.waiting.len(), REORDER_DEPTH as usize);
    }

    #[test]
    fn bumps_while_the_dpb_holds_more_than_its_size() {
        let mut sequencer: Sequencer = Sequencer::new(empty_parameters());
        // Two references and the current picture, all in the DPB, and a non-reference picture still waiting
        for (picture_id, poc) in [(0u32, 0i32), (1, 4), (3, 6)] {
            sequencer.add_dpb_entry(picture_id, poc, DPB_SHORT_TERM).expect("the DPB has room");
        }
        sequencer.waiting = vec![waiting_picture(2, 2), waiting_picture(3, 6)];
        sequencer.output_waiting_pictures(LONG_DPB_SIZE, DPB_SIZE, false);
        // Four pictures exceed three, so POC 2 leaves; the three left in the DPB fit
        assert_eq!(sequencer.events, vec![2]);
    }

    #[test]
    fn a_new_sequence_discards_every_waiting_picture_in_poc_order() {
        let mut sequencer: Sequencer = Sequencer::new(empty_parameters());
        sequencer.waiting = vec![waiting_picture(5, 10), waiting_picture(6, 9)];
        sequencer.output_waiting_pictures(0, 0, true);
        assert_eq!(sequencer.events, vec![6 | OUTPUT_EVENT_DISCARD, 5 | OUTPUT_EVENT_DISCARD]);
        assert!(sequencer.waiting.is_empty());
    }

    #[test]
    fn a_picture_without_output_is_discarded_at_once() {
        let mut sequencer: Sequencer = Sequencer::new(empty_parameters());
        sequencer.add_waiting_picture(&picture_with(0, true), false);
        sequencer.add_waiting_picture(&picture_with(1, false), true);
        assert_eq!(sequencer.events, vec![OUTPUT_EVENT_DISCARD]);
        assert_eq!(sequencer.waiting.len(), 1);
        assert_eq!(sequencer.waiting[0].index, 1);
    }

    #[test]
    fn a_recovery_point_holds_back_pictures_before_its_poc() {
        let mut sequencer: Sequencer = Sequencer::new(empty_parameters());
        sequencer.recovery_point = Some(RECOVERY_POC_COUNT);
        // Decoding starts at a non-IRAP picture: pictures before POC 10 + 3 are not output, and POC 13 ends the recovery
        sequencer.add_waiting_picture(&picture_with(10, false), true);
        sequencer.add_waiting_picture(&picture_with(12, false), true);
        sequencer.add_waiting_picture(&picture_with(13, false), true);
        sequencer.add_waiting_picture(&picture_with(11, false), true);
        assert_eq!(sequencer.events, vec![OUTPUT_EVENT_DISCARD, 1 | OUTPUT_EVENT_DISCARD]);
        assert_eq!(sequencer.waiting.iter().map(|picture: &WaitingPicture| picture.index).collect::<Vec<u32>>(), vec![2, 3]);
    }

    #[test]
    fn output_indices_wrap_at_two_to_the_thirty() {
        let mut sequencer: Sequencer = Sequencer::new(empty_parameters());
        sequencer.next_output_index = OUTPUT_EVENT_INDEX_MASK;
        sequencer.add_waiting_picture(&picture_with(0, true), false);
        sequencer.add_waiting_picture(&picture_with(1, false), false);
        assert_eq!(sequencer.events, vec![OUTPUT_EVENT_INDEX_MASK | OUTPUT_EVENT_DISCARD, OUTPUT_EVENT_DISCARD]);
    }
}

