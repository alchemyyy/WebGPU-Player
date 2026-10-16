// The coordinator's stage: each packet's segments, the frame, field, and slice headers, the anchors, and the parse units, as the
// all-WGSL decoder's header stage, itself FFmpeg's vc1_decode_frame up to ff_vc1_decode_blocks, walked them; then the pictures' output
// events and the facts each picture reports. A B picture predicts direct vectors from the next anchor's motion, which only that anchor's
// parse yields, so its plan blocks until every planned anchor finished.

use crate::bitstream::BitReader;
use crate::error::{DecodeResult, fail};
use crate::header::{
    Bitplanes, HeaderParser, LOOKUP_ENTRIES, LOOKUP_SET_COUNT, LOOKUP_TABLES, MARKER_ENTRY_POINT, MARKER_FIELD, MARKER_FRAME, MARKER_SLICE,
    PictureHeader, StreamState, configure, parse_entry_point, update_geometry,
};
use crate::layout::{
    ERROR_CONFIGURATION, ERROR_PICTURE_HEADER, ERROR_PICTURE_TOO_SHORT, ERROR_START_CODES, FCM_PROGRESSIVE, KIND_INTRAX8, KIND_MACROBLOCKS,
    KIND_SKIPPED, PASS_CONDOVER, PASS_CURRENT_FIELD_TYPE, PASS_CURRENT_USE_IC, PASS_FCM, PASS_FIELD_MODE, PASS_LAST_USE_IC, PASS_LOOKUP_SETS,
    PASS_LOOP_FILTER, PASS_LUT_CURRENT, PASS_LUT_LAST, PASS_LUT_NEXT, PASS_MB_ROWS, PASS_MSPEL, PASS_NEXT_USE_IC, PASS_PQ, PASS_RANGEREDFRM,
    PASS_RND, PASS_ROW_OFFSET, PASS_TYPE, PASS_UNSIGNED_INTRA, PASS_WORDS, PROFILE_ADVANCED, TYPE_B, TYPE_BI, TYPE_I, TYPE_P,
};
use crate::plan::{ANCHOR_WORDS_PER_MACROBLOCK, Plan, SequenceFacts, UnitParameters};
use crate::segments::{START_CODE_LENGTH, append_unescaped, find_start_code, starts_with_start_code};

/// The picture fields word the engine reads beside each picture: bit 0 reported, bit 1 interlaced, bit 2 top field first, bit 3
/// repeat first field; 0 is unknown.
pub const PICTURE_FIELDS_REPORTED: u32 = 0x1;
pub const PICTURE_FIELDS_INTERLACED: u32 = 0x2;
pub const PICTURE_FIELDS_TOP_FIELD_FIRST: u32 = 0x4;
pub const PICTURE_FIELDS_REPEAT_FIRST_FIELD: u32 = 0x8;

// Output events name a picture by its decode order index modulo 2^30; bit 31 drops the picture instead of presenting it
const PICTURE_INDEX_MODULUS: u32 = 1 << 30;
const OUTPUT_EVENT_DISCARD_BIT: u32 = 1 << 31;
// The bytes of an interlaced WVC1 packet's first byte that mark frame data before a field start code
const FIELD_DIVIDER_MARK: u8 = 0xC0;
// A slice start code's row number
const SLICE_ROW_BITS: u32 = 9;
// The start code failure value of an interlaced WVC1 packet without the field start code it announces
const FIELD_DIVIDER_MISSING: u32 = 1;
// The picture quantizer from which Simple and Main I pictures overlap, which keeps their intra samples signed
const OVERLAP_PQUANT: u32 = 9;
const BITS_PER_BYTE: usize = 8;

/// One segment of a packet in the plan's stream: its unescaped bytes.
#[derive(Clone, Copy)]
struct Segment {
    start: usize,
    end: usize,
}

/// A slice or a second field of a packet: its segment, its first row, and whether a field start code began it.
#[derive(Clone, Copy)]
struct Slice {
    segment: Segment,
    rows: u32,
    is_field: bool,
}

/// The anchors as the GPU's slots hold them: whether a previous and a next anchor exist, and whether the next is a field picture.
#[derive(Clone, Copy, Default)]
struct AnchorState {
    has_last: bool,
    has_next: bool,
    next_field_picture: u32,
}

/// A pass's parameter block of the GPU record and the intensity compensation lookup sets it reads.
#[derive(Clone)]
pub struct PassBlock {
    pub words: [u32; PASS_WORDS as usize],
    pub lookup_sets: Vec<[[u8; LOOKUP_ENTRIES]; LOOKUP_TABLES]>,
}

/// What a planned picture reports beside its record.
#[derive(Clone, Copy, Default)]
pub struct PictureInfo {
    pub width: u32,
    pub height: u32,
    pub maximum_width: u32,
    pub maximum_height: u32,
    pub fields: u32,
}

/// What the coordinator keeps of a planned picture until its parsed units return: the record header's facts, its passes, whether it
/// leaves anchor motion, and what it reports.
#[derive(Clone)]
pub struct PendingPicture {
    pub kind: u32,
    pub frame_type: u32,
    pub fcm: u32,
    pub field_mode: u32,
    pub mb_width: u32,
    pub mb_height: u32,
    pub coded_width: u32,
    pub coded_height: u32,
    pub profile: u32,
    pub res_fasttx: u32,
    pub overlap: u32,
    pub passes: Vec<PassBlock>,
    pub unit_count: u32,
    pub updates_anchor_motion: bool,
    /// The decoder dropped every reference since the last record, as FFmpeg's does at a coded size change, so the GPU drops its anchors
    pub resets_anchors: bool,
    pub info: PictureInfo,
}

/// A plan's outcome: a picture with its plan and what finishing it needs, none, or a picture that must wait for earlier pictures.
pub enum PlanOutcome {
    Picture(Box<Plan>, Box<PendingPicture>),
    NoPicture,
    Blocked,
}

#[derive(Default)]
pub struct Sequencer {
    stream: StreamState,
    anchors: AnchorState,
    /// The motion of the anchors finished so far, ANCHOR_WORDS_PER_MACROBLOCK words per frame macroblock
    anchor_motion: Vec<u32>,
    /// Planned pictures not yet finished that leave anchor motion
    unfinished_motion_anchors: u32,
    picture_index: u32,
    /// The anchor waiting for the next anchor to present it, as FFmpeg's output delays anchors
    pending_output: Option<u32>,
    events: Vec<u32>,
    /// The coded size of the last picture with frame data, which FFmpeg's decoder was initialized at
    context_size: Option<(u32, u32)>,
    /// A coded size change dropped the anchors since the last record, which the next record tells the GPU
    anchors_reset_pending: bool,
}

/// The work of one packet's plan: its unescaped segments, slices, and the units and plane versions the headers decided.
struct PacketPlan {
    stream: Vec<u8>,
    frame: Option<Segment>,
    slices: Vec<Slice>,
    first_field_slices: i32,
    units: Vec<UnitParameters>,
    plane_versions: Vec<Vec<u8>>,
    planes: Bitplanes,
    planes_changed: bool,
    passes: Vec<PassBlock>,
}

/// What a frame header decided about its picture before its units.
enum FrameDecision {
    Decode,
    Skipped,
    NoPicture,
}

impl Sequencer {
    /// Configures the stream from the codec private data; it drops every picture.
    pub fn configure(&mut self, codec_private: &[u8]) -> DecodeResult<()> {
        *self = Self::default();
        configure(&mut self.stream, codec_private)
    }

    /// Drops every picture and the configuration.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The output events the last plan decided.
    pub fn events(&self) -> &[u32] {
        &self.events
    }

    /// The largest picture of the stream: the Advanced profile's maximum coded size, or the Simple and Main profiles' coded size.
    pub fn maximum_picture_size(&self) -> (u32, u32) {
        if !self.stream.configured {
            return (0, 0);
        }
        if self.stream.profile == PROFILE_ADVANCED {
            return (self.stream.max_coded_width, self.stream.max_coded_height);
        }
        (self.stream.coded_width, self.stream.coded_height)
    }

    /// Plans the picture of a packet; a plan that blocks keeps no state.
    pub fn plan_packet(&mut self, packet: &[u8]) -> DecodeResult<PlanOutcome> {
        self.events.clear();
        if !self.stream.configured {
            return fail(ERROR_CONFIGURATION, 0);
        }
        let saved_stream: StreamState = self.stream.clone();
        let saved_anchors: AnchorState = self.anchors;
        let saved_pending_output: Option<u32> = self.pending_output;
        let saved_context_size: Option<(u32, u32)> = self.context_size;
        let saved_anchors_reset_pending: bool = self.anchors_reset_pending;
        let outcome: DecodeResult<Option<(Plan, PendingPicture)>> = self.plan_picture(packet);
        let (mut plan, pending): (Plan, PendingPicture) = match outcome? {
            Some(picture) => picture,
            None => return Ok(PlanOutcome::NoPicture),
        };
        let needs_anchor_motion: bool = plan.units.iter().any(|unit: &UnitParameters| unit.picture_type == TYPE_B);
        if needs_anchor_motion && self.unfinished_motion_anchors > 0 {
            self.stream = saved_stream;
            self.anchors = saved_anchors;
            self.pending_output = saved_pending_output;
            self.context_size = saved_context_size;
            self.anchors_reset_pending = saved_anchors_reset_pending;
            self.events.clear();
            return Ok(PlanOutcome::Blocked);
        }
        if needs_anchor_motion {
            let frame_words: usize = (pending.mb_width * pending.mb_height) as usize * ANCHOR_WORDS_PER_MACROBLOCK;
            self.anchor_motion.resize(frame_words.max(self.anchor_motion.len()), 0);
            plan.anchor_motion = self.anchor_motion[..frame_words].to_vec();
        }
        if pending.updates_anchor_motion {
            self.unfinished_motion_anchors += 1;
        }
        let index: u32 = self.picture_index;
        self.picture_index = (self.picture_index + 1) % PICTURE_INDEX_MODULUS;
        self.decide_output(index, pending.frame_type);
        Ok(PlanOutcome::Picture(Box::new(plan), Box::new(pending)))
    }

    /// FFmpeg's vc1_decode_frame reinitializes its decoder when the coded size its entry points set differs from the one it was initialized
    /// at, which drops every reference picture: the anchor waiting to present drops, and later B pictures wait for two new anchors.
    fn reinitialize_at_size_change(&mut self) {
        let coded_size: (u32, u32) = (self.stream.coded_width, self.stream.coded_height);
        let size_changed: bool = self.context_size.is_some_and(|size: (u32, u32)| size != coded_size);
        self.context_size = Some(coded_size);
        if !size_changed {
            return;
        }
        self.anchors = AnchorState::default();
        self.anchors_reset_pending = true;
        if let Some(pending) = self.pending_output.take() {
            self.events.push(pending | OUTPUT_EVENT_DISCARD_BIT);
        }
    }

    /// FFmpeg's output: a B picture, or any picture of a low-delay stream, presents at once; an anchor presents the anchor before it
    fn decide_output(&mut self, index: u32, frame_type: u32) {
        let low_delay: bool = self.stream.profile != PROFILE_ADVANCED && self.stream.max_b_frames == 0;
        if low_delay || frame_type == TYPE_B || frame_type == TYPE_BI {
            self.events.push(index);
            return;
        }
        if let Some(previous) = self.pending_output.replace(index) {
            self.events.push(previous);
        }
    }

    /// Takes a finished anchor's motion: each of its units' macroblocks, at their frame rows.
    pub fn finish_anchor(&mut self, pending: &PendingPicture, unit_motion: &[(u32, u32, u32, Vec<u32>)]) {
        if !pending.updates_anchor_motion {
            return;
        }
        self.unfinished_motion_anchors = self.unfinished_motion_anchors.saturating_sub(1);
        let frame_words: usize = (pending.mb_width * pending.mb_height) as usize * ANCHOR_WORDS_PER_MACROBLOCK;
        if self.anchor_motion.len() < frame_words {
            self.anchor_motion.resize(frame_words, 0);
        }
        for (row_offset, start_row, end_row, words) in unit_motion {
            let first: usize = ((row_offset + start_row) * pending.mb_width) as usize * ANCHOR_WORDS_PER_MACROBLOCK;
            let length: usize = ((end_row - start_row) * pending.mb_width) as usize * ANCHOR_WORDS_PER_MACROBLOCK;
            if words.len() == length && first + length <= self.anchor_motion.len() {
                self.anchor_motion[first..first + length].copy_from_slice(words);
            }
        }
    }

    /// Releases a picture that will never finish, so later B pictures do not wait for it.
    pub fn abandon(&mut self, pending: &PendingPicture) {
        if pending.updates_anchor_motion {
            self.unfinished_motion_anchors = self.unfinished_motion_anchors.saturating_sub(1);
        }
    }

    /// Appends a segment of the packet to the plan's stream, unescaped in the Advanced profile.
    fn add_segment(&self, packet_plan: &mut PacketPlan, bytes: &[u8]) -> Segment {
        let start: usize = packet_plan.stream.len();
        if self.stream.profile == PROFILE_ADVANCED {
            append_unescaped(bytes, &mut packet_plan.stream);
        } else {
            packet_plan.stream.extend_from_slice(bytes);
        }
        Segment { start, end: packet_plan.stream.len() }
    }

    fn segment_reader<'stream>(stream: &'stream [u8], segment: Segment) -> BitReader<'stream> {
        BitReader::new(stream, segment.start * BITS_PER_BYTE, segment.end * BITS_PER_BYTE)
    }

    /// Splits the packet into its segments as vc1_decode_frame walks its start codes, parsing its entry points on the way.
    fn collect_segments(&mut self, packet: &[u8], packet_plan: &mut PacketPlan) -> DecodeResult<()> {
        let length: usize = packet.len();
        let advanced: bool = self.stream.profile == PROFILE_ADVANCED;
        if advanced && starts_with_start_code(packet) {
            let mut start: usize = 0;
            while start < length {
                // The next start code at least four bytes on, as find_next_marker searches from start + 4
                let next: usize = find_start_code(packet, start + START_CODE_LENGTH);
                if next > start + START_CODE_LENGTH {
                    let marker_type: u8 = packet[start + 3];
                    let bytes: &[u8] = &packet[start + START_CODE_LENGTH..next];
                    match marker_type {
                        MARKER_FRAME => {
                            let segment: Segment = self.add_segment(packet_plan, bytes);
                            packet_plan.frame = Some(segment);
                        }
                        MARKER_FIELD | MARKER_SLICE => {
                            let segment: Segment = self.add_segment(packet_plan, bytes);
                            if marker_type == MARKER_FIELD {
                                packet_plan.first_field_slices = packet_plan.slices.len() as i32 - 1;
                                let rows: u32 = (self.stream.coded_height + 31) >> 5;
                                packet_plan.slices.push(Slice { segment, rows, is_field: true });
                            } else {
                                let rows: u32 = Self::segment_reader(&packet_plan.stream, segment).read_bits(SLICE_ROW_BITS);
                                packet_plan.slices.push(Slice { segment, rows, is_field: false });
                            }
                        }
                        MARKER_ENTRY_POINT => {
                            let mut segment_bytes: Vec<u8> = Vec::new();
                            let segment_length: usize = append_unescaped(bytes, &mut segment_bytes);
                            let mut reader: BitReader = BitReader::new(&segment_bytes, 0, segment_length * BITS_PER_BYTE);
                            parse_entry_point(&mut self.stream, &mut reader);
                            update_geometry(&mut self.stream)?;
                        }
                        // FFmpeg reads sequence headers from the extradata alone
                        _ => {}
                    }
                }
                start = next;
            }
            return Ok(());
        }
        if advanced && self.stream.interlace != 0 && length >= START_CODE_LENGTH && packet[0] & FIELD_DIVIDER_MARK == FIELD_DIVIDER_MARK {
            // WVC1 interlaced frame data stores both fields divided by a field start code
            let divider: usize = find_start_code(packet, 0);
            if divider == length || packet[divider + 3] != MARKER_FIELD {
                return fail(ERROR_START_CODES, FIELD_DIVIDER_MISSING);
            }
            let frame: Segment = self.add_segment(packet_plan, &packet[..divider]);
            packet_plan.frame = Some(frame);
            let segment: Segment = self.add_segment(packet_plan, &packet[divider + START_CODE_LENGTH..]);
            let rows: u32 = (self.stream.mb_height + 1) >> 1;
            packet_plan.slices.push(Slice { segment, rows, is_field: true });
            return Ok(());
        }
        let frame: Segment = self.add_segment(packet_plan, packet);
        packet_plan.frame = Some(frame);
        Ok(())
    }

    /// After the frame header: the picture's size check and its anchors; FFmpeg skips a B picture without a previous anchor.
    /// An anchor's forward reference is the previous next anchor, and it becomes the next anchor itself.
    fn begin_frame(&mut self, header: &PictureHeader) -> DecodeResult<FrameDecision> {
        let mb_height: u32 = self.stream.mb_height;
        // FFmpeg's "image too short": a field picture needs two macroblock rows
        if mb_height >> header.field_mode == 0 {
            return fail(ERROR_PICTURE_TOO_SHORT, mb_height);
        }
        let anchor: bool = header.picture_type == TYPE_I || header.picture_type == TYPE_P;
        if header.picture_type == TYPE_B && !self.anchors.has_last {
            return Ok(FrameDecision::NoPicture);
        }
        if anchor {
            self.anchors.has_last = self.anchors.has_next;
            self.anchors.has_next = true;
            self.anchors.next_field_picture = header.field_mode;
        }
        if header.picture_skipped != 0 {
            return Ok(FrameDecision::Skipped);
        }
        Ok(FrameDecision::Decode)
    }

    /// The parameter block of a pass and a snapshot of the lookup sets its intensity compensation reads.
    fn pass_block(&self, header: &PictureHeader, current_use: u32) -> PassBlock {
        let lookups: &crate::header::IntensityLookups = &self.stream.lookups;
        let intra: bool = header.picture_type == TYPE_I || header.picture_type == TYPE_BI;
        let unsigned_intra: bool = self.stream.profile != PROFILE_ADVANCED && intra && !(self.stream.overlap != 0 && header.pq >= OVERLAP_PQUANT);
        let mut used_sets: u32 = 0;
        if lookups.last_use != 0 {
            used_sets |= 1 << lookups.last_set;
        }
        if lookups.next_use != 0 {
            used_sets |= 1 << lookups.next_set;
        }
        if current_use != 0 {
            used_sets |= 1 << header.current_lookup_set;
        }
        used_sets &= (1 << LOOKUP_SET_COUNT) - 1;
        let mut words: [u32; PASS_WORDS as usize] = [0; PASS_WORDS as usize];
        words[PASS_TYPE as usize] = header.picture_type;
        words[PASS_FCM as usize] = header.fcm;
        words[PASS_FIELD_MODE as usize] = header.field_mode;
        words[PASS_CURRENT_FIELD_TYPE as usize] = header.current_field_type;
        words[PASS_PQ as usize] = header.pq;
        words[PASS_MSPEL as usize] = header.mspel;
        words[PASS_RND as usize] = header.picture_rnd;
        words[PASS_RANGEREDFRM as usize] = header.rangeredfrm;
        words[PASS_CONDOVER as usize] = header.condover;
        words[PASS_UNSIGNED_INTRA as usize] = u32::from(unsigned_intra);
        words[PASS_LOOP_FILTER as usize] = self.stream.loop_filter;
        words[PASS_ROW_OFFSET as usize] = if header.second_field != 0 { header.mb_height >> 1 } else { 0 };
        words[PASS_MB_ROWS as usize] = header.mb_height >> header.field_mode;
        words[PASS_LAST_USE_IC as usize] = lookups.last_use;
        words[PASS_NEXT_USE_IC as usize] = lookups.next_use;
        words[PASS_CURRENT_USE_IC as usize] = current_use;
        words[PASS_LUT_LAST as usize] = lookups.last_set;
        words[PASS_LUT_NEXT as usize] = lookups.next_set;
        words[PASS_LUT_CURRENT as usize] = header.current_lookup_set;
        words[PASS_LOOKUP_SETS as usize] = used_sets;
        let lookup_sets: Vec<[[u8; LOOKUP_ENTRIES]; LOOKUP_TABLES]> =
            (0..LOOKUP_SET_COUNT).filter(|set: &usize| (used_sets >> set) & 1 != 0).map(|set: usize| lookups.tables[set]).collect();
        PassBlock { words, lookup_sets }
    }

    /// A unit's parameters: the header's fields as its parse reads them, and its bits, rows, and planes.
    fn unit_parameters(&self, header: &PictureHeader, start_bit: usize, end_bit: usize, rows: (u32, u32), plane_version: u32) -> UnitParameters {
        let (codingset, codingset2): (u32, u32) = header.coding_sets();
        let anchor: bool = header.picture_type == TYPE_I || header.picture_type == TYPE_P;
        UnitParameters {
            picture_type: header.picture_type,
            fcm: header.fcm,
            field_mode: header.field_mode,
            second_field: header.second_field,
            current_field_type: header.current_field_type,
            pq: header.pq,
            pqindex: header.pqindex,
            halfpq: header.halfpq,
            pquantizer: header.pquantizer,
            altpq: header.altpq,
            dquantfrm: header.dquantfrm,
            dqprofile: self.stream.dqprofile,
            dqsbedge: self.stream.dqsbedge,
            dqbilevel: self.stream.dqbilevel,
            dmvrange: self.stream.dmvrange,
            range_x: header.range_x,
            range_y: header.range_y,
            k_x: header.k_x,
            k_y: header.k_y,
            mv_mode: header.mv_mode,
            mv_mode2: header.mv_mode2,
            quarter_sample: header.quarter_sample,
            mspel: header.mspel,
            mv_table_index: header.mv_table_index,
            cbptab: header.cbptab,
            ttmbf: header.ttmbf,
            ttfrm: header.ttfrm,
            tt_index: header.tt_index,
            dc_table_index: header.dc_table_index,
            codingset,
            codingset2,
            condover: header.condover,
            fourmvswitch: header.fourmvswitch,
            mbmodetab: header.mbmodetab,
            imvtab: header.imvtab,
            icbptab: header.icbptab,
            twomvbptab: header.twomvbptab,
            fourmvbptab: header.fourmvbptab,
            numref: header.numref,
            reffield: header.reffield,
            ref_field_type_forward: header.ref_field_type_forward,
            refdist: self.stream.refdist,
            frfd: header.frfd,
            brfd: header.brfd,
            bfraction: header.bfraction,
            x8_type: header.x8_type,
            plane_mvtype: header.plane_mvtype,
            plane_skip: header.plane_skip,
            plane_direct: header.plane_direct,
            plane_forward: header.plane_forward,
            plane_acpred: header.plane_acpred,
            plane_overflags: header.plane_overflags,
            plane_fieldtx: header.plane_fieldtx,
            row_offset: if header.second_field != 0 { header.mb_height >> 1 } else { 0 },
            backward_field_picture: if anchor { 0 } else { self.anchors.next_field_picture },
            start_bit: start_bit as u32,
            end_bit: end_bit as u32,
            start_row: rows.0,
            end_row: rows.1,
            plane_version,
        }
    }

    /// The plane version a unit reads: the planes as its header left them, snapshotted once per change.
    fn plane_version(packet_plan: &mut PacketPlan) -> u32 {
        if packet_plan.planes_changed || packet_plan.plane_versions.is_empty() {
            packet_plan.plane_versions.push(packet_plan.planes.bytes.clone());
            packet_plan.planes_changed = false;
        }
        packet_plan.plane_versions.len() as u32 - 1
    }

    /// Plans a packet's picture: its segments, its frame and field headers, its slices' headers, and its units; FFmpeg's vc1_decode_frame
    /// up to ff_vc1_decode_blocks. None for a packet that decodes no picture.
    fn plan_picture(&mut self, packet: &[u8]) -> DecodeResult<Option<(Plan, PendingPicture)>> {
        if packet.is_empty() {
            return Ok(None);
        }
        let mut packet_plan: PacketPlan = PacketPlan {
            stream: Vec::with_capacity(packet.len()),
            frame: None,
            slices: Vec::new(),
            first_field_slices: -1,
            units: Vec::new(),
            plane_versions: Vec::new(),
            planes: Bitplanes::default(),
            planes_changed: false,
            passes: Vec::new(),
        };
        self.collect_segments(packet, &mut packet_plan)?;
        // A packet without frame data, such as a lone sequence header, decodes no picture
        let Some(frame) = packet_plan.frame else {
            return Ok(None);
        };
        self.reinitialize_at_size_change();
        packet_plan.planes.reset(self.stream.mb_width, self.stream.mb_height.max((self.stream.coded_height + 15) >> 4).max(1) + 1);
        let mut header: PictureHeader = PictureHeader::default();
        let mut field_rows: u32 = 0;
        let mut header_failed: bool = false;
        let mut decision: FrameDecision = FrameDecision::Decode;
        let slice_count: usize = packet_plan.slices.len();
        let stream_bytes: Vec<u8> = std::mem::take(&mut packet_plan.stream);
        for unit in 0..=slice_count {
            let mut parse_header: bool = false;
            let mut field_header: bool = false;
            let segment: Segment;
            let mut skip_slice_address: bool = false;
            if unit == 0 {
                segment = frame;
                header.first_picture_header = true;
                header.picture_header_flag = false;
                header.second_field = 0;
                header.current_field_type = 0;
                header.plane_row_offset = 0;
                header.clear_planes();
                header.field_mode = 0;
                parse_header = true;
            } else {
                let slice: Slice = packet_plan.slices[unit - 1];
                if slice.rows >= field_rows {
                    if header.field_mode == 0 {
                        continue;
                    }
                    header.second_field = 1;
                } else {
                    header.second_field = 0;
                }
                header.plane_row_offset = if header.second_field != 0 { self.stream.mb_height >> 1 } else { 0 };
                segment = slice.segment;
                skip_slice_address = !slice.is_field;
            }
            let mut reader: BitReader = Self::segment_reader(&stream_bytes, segment);
            if unit > 0 {
                if skip_slice_address {
                    reader.skip_bits(SLICE_ROW_BITS);
                }
                header.picture_header_flag = false;
                if header.field_mode != 0 && unit as i32 == packet_plan.first_field_slices + 2 {
                    header.clear_planes();
                    parse_header = true;
                    field_header = true;
                } else if reader.read_flag() {
                    header.picture_header_flag = true;
                    parse_header = true;
                }
            }
            if parse_header {
                if header.mb_height == 0 {
                    header.mb_height = self.stream.mb_height;
                }
                let mut parser: HeaderParser = HeaderParser { stream: &mut self.stream, header: &mut header, planes: &mut packet_plan.planes, reader };
                header_failed = !parser.parse_picture_header()?;
                let current_use: u32 = parser.current_use_flag();
                reader = parser.reader;
                packet_plan.planes_changed = true;
                if unit == 0 {
                    header.first_picture_header = false;
                    if header_failed {
                        return fail(ERROR_PICTURE_HEADER, header.picture_type);
                    }
                    decision = self.begin_frame(&header)?;
                    if matches!(decision, FrameDecision::NoPicture) {
                        return Ok(None);
                    }
                    field_rows = self.stream.mb_height >> header.field_mode;
                }
                if !header_failed && (unit == 0 || field_header) {
                    let block: PassBlock = self.pass_block(&header, current_use);
                    packet_plan.passes.truncate(header.second_field as usize);
                    packet_plan.passes.push(block);
                    if matches!(decision, FrameDecision::Skipped) {
                        break;
                    }
                }
            }
            if header_failed {
                continue;
            }
            let start_row: u32 = if unit > 0 { packet_plan.slices[unit - 1].rows % field_rows } else { 0 };
            let mut end_row: u32 = field_rows;
            if header.field_mode == 0 || header.second_field != 0 {
                if unit < slice_count {
                    end_row = field_rows.min(packet_plan.slices[unit].rows % field_rows);
                }
            } else {
                if unit >= slice_count {
                    continue;
                }
                if unit as i32 != packet_plan.first_field_slices + 1 {
                    end_row = field_rows.min(packet_plan.slices[unit].rows % field_rows);
                }
            }
            if end_row <= start_row {
                continue;
            }
            let plane_version: u32 = Self::plane_version(&mut packet_plan);
            let parameters: UnitParameters = self.unit_parameters(&header, reader.position(), reader.end(), (start_row, end_row), plane_version);
            packet_plan.units.push(parameters);
        }
        let kind: u32 = match decision {
            FrameDecision::Skipped => KIND_SKIPPED,
            _ if packet_plan.units.first().is_some_and(|unit: &UnitParameters| unit.x8_type != 0) => KIND_INTRAX8,
            _ => KIND_MACROBLOCKS,
        };
        if kind == KIND_SKIPPED {
            packet_plan.units.clear();
        }
        let frame_type: u32 = packet_plan.passes.first().map_or(header.picture_type, |pass: &PassBlock| pass.words[PASS_TYPE as usize]);
        let frame_fcm: u32 = packet_plan.passes.first().map_or(header.fcm, |pass: &PassBlock| pass.words[PASS_FCM as usize]);
        let frame_field_mode: u32 = packet_plan.passes.first().map_or(header.field_mode, |pass: &PassBlock| pass.words[PASS_FIELD_MODE as usize]);
        let updates_anchor_motion: bool = packet_plan.units.iter().any(|unit: &UnitParameters| unit.picture_type == TYPE_I || unit.picture_type == TYPE_P);
        let mut fields: u32 = PICTURE_FIELDS_REPORTED;
        if frame_fcm != FCM_PROGRESSIVE {
            fields |= PICTURE_FIELDS_INTERLACED;
        }
        if self.stream.tff != 0 {
            fields |= PICTURE_FIELDS_TOP_FIELD_FIRST;
        }
        if header.repeat_first_field != 0 && frame_fcm == FCM_PROGRESSIVE {
            fields |= PICTURE_FIELDS_REPEAT_FIRST_FIELD;
        }
        let (maximum_width, maximum_height): (u32, u32) = self.maximum_picture_size();
        let pending: PendingPicture = PendingPicture {
            kind,
            frame_type,
            fcm: frame_fcm,
            field_mode: frame_field_mode,
            mb_width: self.stream.mb_width,
            mb_height: self.stream.mb_height,
            coded_width: self.stream.coded_width,
            coded_height: self.stream.coded_height,
            profile: self.stream.profile,
            res_fasttx: self.stream.res_fasttx,
            overlap: self.stream.overlap,
            passes: packet_plan.passes,
            unit_count: packet_plan.units.len() as u32,
            updates_anchor_motion,
            resets_anchors: std::mem::take(&mut self.anchors_reset_pending),
            info: PictureInfo { width: self.stream.coded_width, height: self.stream.coded_height, maximum_width, maximum_height, fields },
        };
        let plan: Plan = Plan {
            sequence: SequenceFacts {
                profile: self.stream.profile,
                res_rtm_flag: self.stream.res_rtm_flag,
                overlap: self.stream.overlap,
                fastuvmc: self.stream.fastuvmc,
                loop_filter: self.stream.loop_filter,
                coded_width: self.stream.coded_width,
                coded_height: self.stream.coded_height,
                mb_width: self.stream.mb_width,
                mb_height: self.stream.mb_height,
            },
            units: packet_plan.units,
            plane_versions: packet_plan.plane_versions,
            anchor_motion: Vec::new(),
            stream: stream_bytes,
        };
        Ok(Some((plan, pending)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::DecodeError;
    use crate::header::tests::{MAIN_HEIGHT, MAIN_STRUCT_C, MAIN_WIDTH, create_video_for_windows};
    use crate::layout::PROFILE_MAIN;

    const WMV3_FOURCC: &[u8; 4] = b"WMV3";
    const ADVANCED_MAXIMUM_B_FRAMES: u32 = 7;
    const ANY_PACKET: [u8; 3] = [1, 2, 3];

    fn decide(sequencer: &mut Sequencer, index: u32, frame_type: u32) -> Vec<u32> {
        sequencer.events.clear();
        sequencer.decide_output(index, frame_type);
        sequencer.events.clone()
    }

    #[test]
    fn plans_nothing_before_its_configuration_and_no_picture_of_an_empty_packet() {
        let mut sequencer: Sequencer = Sequencer::default();
        let failure: DecodeError = sequencer.plan_packet(&ANY_PACKET).err().expect("an unconfigured plan fails");
        assert_eq!((failure.code, failure.value), (ERROR_CONFIGURATION, 0));

        sequencer.configure(&create_video_for_windows(MAIN_WIDTH, MAIN_HEIGHT, WMV3_FOURCC, &MAIN_STRUCT_C)).expect("the configuration succeeds");
        assert!(matches!(sequencer.plan_packet(&[]), Ok(PlanOutcome::NoPicture)));
        assert_eq!(sequencer.maximum_picture_size(), (MAIN_WIDTH, MAIN_HEIGHT));
    }

    #[test]
    fn presents_every_picture_at_once_in_a_low_delay_stream() {
        let mut sequencer: Sequencer = Sequencer::default();
        sequencer.stream.profile = PROFILE_MAIN;
        sequencer.stream.max_b_frames = 0;

        assert_eq!(decide(&mut sequencer, 0, TYPE_I), [0]);
        assert_eq!(decide(&mut sequencer, 1, TYPE_P), [1]);
    }

    #[test]
    fn presents_b_pictures_at_once_and_each_anchor_once_the_next_anchor_comes() {
        let mut sequencer: Sequencer = Sequencer::default();
        sequencer.stream.profile = PROFILE_ADVANCED;
        sequencer.stream.max_b_frames = ADVANCED_MAXIMUM_B_FRAMES;

        assert_eq!(decide(&mut sequencer, 0, TYPE_I), Vec::<u32>::new());
        assert_eq!(decide(&mut sequencer, 1, TYPE_P), [0]);
        assert_eq!(decide(&mut sequencer, 2, TYPE_B), [2]);
        assert_eq!(decide(&mut sequencer, 3, TYPE_BI), [3]);
        assert_eq!(decide(&mut sequencer, 4, TYPE_P), [1]);
    }

    #[test]
    fn drops_the_waiting_anchor_and_every_reference_when_the_coded_size_changes() {
        const FIRST_SIZE: (u32, u32) = (352, 288);
        const CHANGED_SIZE: (u32, u32) = (352, 224);
        const WAITING_ANCHOR: u32 = 5;
        let mut sequencer: Sequencer = Sequencer::default();
        sequencer.stream.coded_width = FIRST_SIZE.0;
        sequencer.stream.coded_height = FIRST_SIZE.1;
        sequencer.reinitialize_at_size_change();
        sequencer.pending_output = Some(WAITING_ANCHOR);
        sequencer.anchors = AnchorState { has_last: true, has_next: true, next_field_picture: 0 };
        sequencer.reinitialize_at_size_change();
        assert!(sequencer.events.is_empty());
        assert!(!sequencer.anchors_reset_pending);

        sequencer.stream.coded_width = CHANGED_SIZE.0;
        sequencer.stream.coded_height = CHANGED_SIZE.1;
        sequencer.reinitialize_at_size_change();
        assert_eq!(sequencer.events, [WAITING_ANCHOR | OUTPUT_EVENT_DISCARD_BIT]);
        assert_eq!(sequencer.pending_output, None);
        assert!(!sequencer.anchors.has_last && !sequencer.anchors.has_next);
        assert!(sequencer.anchors_reset_pending);
        assert_eq!(sequencer.context_size, Some(CHANGED_SIZE));
    }

    #[test]
    fn releases_an_abandoned_anchor_so_later_b_pictures_plan() {
        let mut sequencer: Sequencer = Sequencer::default();
        let pending: PendingPicture = PendingPicture {
            kind: KIND_MACROBLOCKS,
            frame_type: TYPE_P,
            fcm: FCM_PROGRESSIVE,
            field_mode: 0,
            mb_width: 1,
            mb_height: 1,
            coded_width: 16,
            coded_height: 16,
            profile: PROFILE_MAIN,
            res_fasttx: 0,
            overlap: 0,
            passes: Vec::new(),
            unit_count: 1,
            updates_anchor_motion: true,
            resets_anchors: false,
            info: PictureInfo::default(),
        };
        sequencer.unfinished_motion_anchors = 1;

        sequencer.abandon(&pending);
        assert_eq!(sequencer.unfinished_motion_anchors, 0);
        sequencer.unfinished_motion_anchors = 1;
        let motion: Vec<u32> = vec![1, 2, 3];
        sequencer.finish_anchor(&pending, &[(0, 0, 1, motion.clone())]);
        assert_eq!(sequencer.unfinished_motion_anchors, 0);
        assert_eq!(sequencer.anchor_motion, motion);
    }
}
