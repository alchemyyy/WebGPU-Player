// Tier-2 as FFmpeg's jpeg2000_decode_packets runs it: the progression orders and their changes, each packet's header with its tag trees,
// passes, and segment lengths, and each code block's contributions gathered with 0xFF 0xFF after every terminated segment.
// Packet headers come from the tile-part data, a PPM's per-tile-part ranges, or the tile's PPT data, switched as FFmpeg switches them.

use crate::codestream::{
    CODING_STYLE_END_OF_PACKET_HEADER, CODING_STYLE_START_OF_PACKET, CodingStyle, ImageSize, MAXIMUM_COMPONENTS, QuantizationStyle, TILE_PART_SLOTS,
    TileHeader,
};
use crate::error::{DecodeResult, fail, fail_signed};
use crate::geometry::{CodeBlock, PARSE_WORK_LIMIT, Precinct, ResolutionLevel, Tile, ceil_divide, ceil_divide_power};
use crate::layout::{
    ERROR_CODE_BLOCK_LENGTH, ERROR_LENGTH_BITS, ERROR_MAGNITUDE_BITS, ERROR_PACKET_DATA, ERROR_PASS_COUNT, ERROR_PROGRESSION_ORDER,
    ERROR_RESOURCE_LIMIT, MAXIMUM_PASSES, STYLE_BYPASS, STYLE_TERMINATE_ALL,
};
use crate::stream::ByteStream;

// Progression orders
const LAYER_RESOLUTION_COMPONENT_POSITION: u8 = 0;
const RESOLUTION_LAYER_COMPONENT_POSITION: u8 = 1;
const RESOLUTION_POSITION_COMPONENT_LAYER: u8 = 2;
const POSITION_COMPONENT_RESOLUTION_LAYER: u8 = 3;
const COMPONENT_POSITION_RESOLUTION_LAYER: u8 = 4;
/// The resolution end of the default progression, past every level
const ALL_RESOLUTIONS: u8 = 33;
const START_OF_PACKET_MARKER: u32 = 0xFF91_0004;
const START_OF_PACKET_LENGTH: usize = 6;
const END_OF_PACKET_HEADER_MARKER: u16 = 0xFF92;
const STUFFING_BYTE: u8 = 0xFF;
/// FFmpeg's bound on a code block's coded bytes, which it keeps in 16 bits
const MAXIMUM_CODE_BLOCK_LENGTH: usize = 65535;
const MAXIMUM_LENGTH_BITS: i64 = 16;
const MAXIMUM_MAGNITUDE_BITS: i32 = 30;
/// FFmpeg decodes zero bit-planes up to this threshold
const ZERO_BIT_PLANE_THRESHOLD: i32 = 100;
/// The passes of a bypassed code block before its first raw segment
const BYPASS_TERMINATION_THRESHOLD: u8 = 10;
const MAXIMUM_POSITION_STEP: u32 = 31;
const RPCL_INITIAL_STEP: u32 = 30;
const POSITION_INITIAL_STEP: u32 = 32;
const MAGNITUDE_BITS_BIAS: i64 = 128;

/// FFmpeg's av_log2: the index of the highest set bit, 0 for 0.
fn log2_floor(value: u32) -> u32 {
    if value == 0 { 0 } else { 31 - value.leading_zeros() }
}

/// FFmpeg's needs_termination: whether a code block's pass ends a segment, and the coder of the next: 1 arithmetic, 2 raw.
pub fn needs_termination(style: u8, pass: i32) -> i32 {
    let style: u32 = u32::from(style);
    if style & STYLE_BYPASS != 0 {
        let pass_type: i32 = pass % 3;
        let triple: i32 = pass / 3;
        if pass_type == 0 && triple > 2 {
            return 2;
        }
        if pass_type == 2 && triple > 2 {
            return 1;
        }
        if style & STYLE_TERMINATE_ALL != 0 {
            return if triple > 2 { 2 } else { 1 };
        }
    }
    if style & STYLE_TERMINATE_ALL != 0 {
        return 1;
    }
    0
}

/// One tile's tier-2: its header's streams, its geometry, the packet header bit reader's state, and the parse's remaining work.
pub struct TileDecoder<'a> {
    arena: &'a [u8],
    header: &'a mut TileHeader,
    tile: &'a mut Tile,
    size: &'a ImageSize,
    has_packed_main_headers: bool,
    stream: ByteStream,
    bit_index: u32,
    tile_part: usize,
    remaining_work: &'a mut u64,
}

impl<'a> TileDecoder<'a> {
    pub fn new(arena: &'a [u8], header: &'a mut TileHeader, tile: &'a mut Tile, size: &'a ImageSize, has_packed_main_headers: bool, remaining_work: &'a mut u64) -> Self {
        Self { arena, header, tile, size, has_packed_main_headers, stream: ByteStream::default(), bit_index: 8, tile_part: 0, remaining_work }
    }

    /// Takes one step of the parse's work, failing once it is spent.
    fn spend_work(&mut self) -> DecodeResult<()> {
        if *self.remaining_work == 0 {
            return fail(ERROR_RESOURCE_LIMIT, PARSE_WORK_LIMIT);
        }
        *self.remaining_work -= 1;
        Ok(())
    }

    /// FFmpeg's get_bits: bits MSB first, a byte after 0xFF holding 7.
    fn read_bits(&mut self, count: u32) -> u32 {
        let mut result: u32 = 0;
        for _ in 0..count {
            result <<= 1;
            if self.bit_index == 0 {
                self.bit_index = 7 + u32::from(self.stream.read_u8(self.arena) != STUFFING_BYTE);
            }
            self.bit_index -= 1;
            result |= (u32::from(self.stream.peek_u8(self.arena)) >> self.bit_index) & 1;
        }
        result
    }

    /// FFmpeg's jpeg2000_flush: ends a packet header at its byte boundary, past a stuffed byte after 0xFF.
    fn flush(&mut self) {
        if self.stream.read_u8(self.arena) == STUFFING_BYTE {
            self.stream.skip(1);
        }
        self.bit_index = 8;
    }

    fn tile_part_exhausted(&self) -> bool {
        self.stream.bytes_left() == 0 && self.bit_index == 8
    }

    /// FFmpeg's select_header: the current tile-part's packet headers from the PPM; when they are spent, the next tile-part's data, as FFmpeg moves on.
    fn select_header(&mut self) {
        self.stream = self.header.tile_parts[self.tile_part].header;
        if self.tile_part_exhausted() && self.tile_part < TILE_PART_SLOTS - 1 {
            self.tile_part += 1;
            self.stream = self.header.tile_parts[self.tile_part].data;
        }
    }

    /// FFmpeg's select_stream: the current tile-part's data, moving past spent tile-parts, then past a SOP marker when the style has them.
    fn select_stream(&mut self, coding_style: u8) {
        self.stream = self.header.tile_parts[self.tile_part].data;
        while self.tile_part_exhausted() {
            if self.tile_part < TILE_PART_SLOTS - 1 {
                self.tile_part += 1;
                self.stream = self.header.tile_parts[self.tile_part].data;
            } else {
                break;
            }
        }
        if coding_style & CODING_STYLE_START_OF_PACKET != 0 && self.stream.peek_u32(self.arena) == START_OF_PACKET_MARKER {
            self.stream.skip(START_OF_PACKET_LENGTH);
        }
    }

    fn read_pass_count(&mut self) -> u32 {
        if self.read_bits(1) == 0 {
            return 1;
        }
        if self.read_bits(1) == 0 {
            return 2;
        }
        let short: u32 = self.read_bits(2);
        if short != 3 {
            return 3 + short;
        }
        let medium: u32 = self.read_bits(5);
        if medium != 31 {
            return 6 + medium;
        }
        37 + self.read_bits(7)
    }

    fn read_length_increment(&mut self) -> i64 {
        let mut increment: i64 = 0;
        // Past the stream's end the reader returns zeros, which ends the count
        while self.read_bits(1) != 0 {
            increment += 1;
        }
        increment
    }

    /// Reads one code block's contribution to a packet: its passes and the lengths of the segments they form.
    fn read_contribution(code_block: &mut CodeBlock, style: u8, reader: &mut Self) -> DecodeResult<()> {
        let mut new_passes: u32 = reader.read_pass_count();
        if u32::from(code_block.passes) + new_passes >= MAXIMUM_PASSES {
            return fail(ERROR_PASS_COUNT, u32::from(code_block.passes) + new_passes);
        }
        let increment: i64 = reader.read_length_increment();
        let length_bits: i64 = i64::from(code_block.length_exponent) + increment + i64::from(log2_floor(new_passes));
        if length_bits > MAXIMUM_LENGTH_BITS {
            return fail_signed(ERROR_LENGTH_BITS, length_bits);
        }
        code_block.segment_lengths.clear();
        code_block.pending_terminations = 0;
        code_block.included_in_packet = true;
        code_block.length_exponent = (i64::from(code_block.length_exponent) + increment) as u8;
        let mut remaining: i32 = new_passes as i32;
        let mut counted: i32 = i32::from(code_block.passes);
        while remaining > 0 {
            let mut taken: i32 = 0;
            while taken < remaining {
                taken += 1;
                if needs_termination(style, counted + taken - 1) != 0 {
                    code_block.pending_terminations += 1;
                    break;
                }
            }
            counted += taken;
            remaining -= taken;
        }
        let length_exponent: u32 = u32::from(code_block.length_exponent);
        let style_bits: u32 = u32::from(style);
        let mut bypass_threshold: u8 = 0;
        let mut next_segment_passes: u32 = 0;
        let segment_passes: u32;
        let segment_bits: u32;
        if style_bits & (STYLE_TERMINATE_ALL | STYLE_BYPASS) == 0 {
            segment_bits = length_exponent + log2_floor(new_passes & 0xFF);
            segment_passes = new_passes;
        } else if style_bits & STYLE_TERMINATE_ALL != 0 {
            segment_bits = length_exponent;
            segment_passes = 1;
            next_segment_passes = 1;
        } else {
            bypass_threshold = BYPASS_TERMINATION_THRESHOLD;
            let passes: u8 = code_block.passes;
            let mut bits: u32 = 0;
            if passes < bypass_threshold {
                segment_passes = u32::from(bypass_threshold - passes).min(new_passes);
                while (2u32 << bits) <= segment_passes {
                    bits += 1;
                }
                next_segment_passes = 2;
            } else if (passes - bypass_threshold) % 3 < 2 {
                let phase: u32 = u32::from((passes - bypass_threshold) % 3);
                segment_passes = if new_passes > 1 { 2 - phase } else { 1 };
                bits = log2_floor(segment_passes);
                next_segment_passes = 1;
            } else {
                segment_passes = 1;
                next_segment_passes = 2;
            }
            segment_bits = (bits + length_exponent) & 0xFF;
        }
        let segment_bytes: u32 = reader.read_bits(segment_bits);
        code_block.passes = (u32::from(code_block.passes) + segment_passes) as u8;
        code_block.segment_lengths.push(segment_bytes as u16);
        new_passes -= segment_passes;
        while new_passes > 0 {
            let passes: u32;
            let bits: u32;
            if bypass_threshold != 0 {
                passes = if new_passes > 1 { next_segment_passes } else { 1 };
                next_segment_passes = 3 - next_segment_passes;
                bits = (length_exponent + log2_floor(passes)) & 0xFF;
            } else {
                passes = 1;
                bits = length_exponent;
            }
            let bytes: u32 = reader.read_bits(bits);
            new_passes = new_passes.saturating_sub(passes);
            code_block.passes = (u32::from(code_block.passes) + passes) as u8;
            code_block.segment_lengths.push(bytes as u16);
        }
        Ok(())
    }

    /// FFmpeg's jpeg2000_decode_packet for precinct `precinct_index` of level `level` of component `component` in layer `layer`.
    fn decode_packet(&mut self, component: usize, level: usize, precinct_index: usize, layer: i32) -> DecodeResult<()> {
        self.spend_work()?;
        let coding: CodingStyle = self.header.coding[component];
        let quantization: QuantizationStyle = self.header.quantization[component];
        let first_band: usize = if level > 0 { 3 * (level - 1) + 1 } else { 0 };
        // FFmpeg reads the first component's shift for every component's magnitude bits
        let region_shift: i32 = i32::from(self.tile.components.first().map_or(0, |first| first.region_shift));
        {
            let resolution: &mut ResolutionLevel = &mut self.tile.components[component].levels[level];
            let Some(precinct) = resolution.bands[0].precincts.get_mut(precinct_index) else {
                return Ok(());
            };
            if layer < precinct.decoded_layers {
                return Ok(());
            }
            precinct.decoded_layers = layer + 1;
        }
        if self.has_packed_main_headers {
            self.select_header();
        } else if self.header.has_packed_headers {
            self.stream = self.header.packed_headers;
        } else {
            self.select_stream(coding.coding_style);
        }
        let nonempty: bool = self.read_bits(1) != 0;
        if nonempty {
            let band_count: usize = self.tile.components[component].levels[level].bands.len();
            for band_index in 0..band_count {
                let band_is_empty: bool = self.tile.components[component].levels[level].bands[band_index].is_empty();
                if band_is_empty {
                    continue;
                }
                let exponent: i32 = i32::from(quantization.exponents[(first_band + band_index).min(quantization.exponents.len() - 1)]);
                let guard_bits: i32 = i32::from(quantization.guard_bits);
                let code_block_count: usize = {
                    let precinct: &Precinct = &self.tile.components[component].levels[level].bands[band_index].precincts[precinct_index];
                    (precinct.code_block_columns * precinct.code_block_rows) as usize
                };
                for code_block_index in 0..code_block_count {
                    self.spend_work()?;
                    let mut precinct: Precinct = std::mem::take(&mut self.tile.components[component].levels[level].bands[band_index].precincts[precinct_index]);
                    let result: DecodeResult<()> = self.read_code_block_header(&mut precinct, code_block_index, layer, exponent, guard_bits, region_shift, coding.code_block_style);
                    self.tile.components[component].levels[level].bands[band_index].precincts[precinct_index] = precinct;
                    result?;
                }
            }
        }
        self.flush();
        if coding.coding_style & CODING_STYLE_END_OF_PACKET_HEADER != 0 && self.stream.peek_u16(self.arena) == END_OF_PACKET_HEADER_MARKER {
            self.stream.skip(2);
        }
        if self.has_packed_main_headers {
            self.header.tile_parts[self.tile_part].header = self.stream;
            self.select_stream(coding.coding_style);
        } else if self.header.has_packed_headers {
            self.header.packed_headers = self.stream;
            self.select_stream(coding.coding_style);
        }
        if nonempty {
            self.read_packet_data(component, level, precinct_index)?;
        }
        self.header.tile_parts[self.tile_part].data = self.stream;
        Ok(())
    }

    /// One code block's part of a packet header: its inclusion, zero bit-planes at first inclusion, and contribution.
    #[allow(clippy::too_many_arguments)]
    fn read_code_block_header(&mut self, precinct: &mut Precinct, code_block_index: usize, layer: i32, exponent: i32, guard_bits: i32, region_shift: i32, style: u8) -> DecodeResult<()> {
        let included: bool;
        if !precinct.code_blocks[code_block_index].included {
            if layer > 0 {
                precinct.inclusion.decode(code_block_index, 1, || self.read_bits(1));
            }
            included = precinct.inclusion.decode(code_block_index, layer + 1, || self.read_bits(1)) == layer;
            if included {
                let zero_bit_planes: i32 = precinct.zero_bit_planes.decode(code_block_index, ZERO_BIT_PLANE_THRESHOLD, || self.read_bits(1));
                let magnitude_bits: i32 = exponent + guard_bits - 1 - (zero_bit_planes - region_shift);
                if !(0..=MAXIMUM_MAGNITUDE_BITS).contains(&magnitude_bits) {
                    return fail_signed(ERROR_MAGNITUDE_BITS, i64::from(magnitude_bits) + MAGNITUDE_BITS_BIAS);
                }
                let code_block: &mut CodeBlock = &mut precinct.code_blocks[code_block_index];
                code_block.included = true;
                code_block.nonzero_bits = magnitude_bits as u8;
                code_block.length_exponent = 3;
            }
        } else {
            included = self.read_bits(1) != 0;
        }
        if included {
            Self::read_contribution(&mut precinct.code_blocks[code_block_index], style, self)?;
        }
        Ok(())
    }

    /// Copies each included code block's segments out of the packet body, with 0xFF 0xFF after each segment its passes terminated.
    fn read_packet_data(&mut self, component: usize, level: usize, precinct_index: usize) -> DecodeResult<()> {
        let band_count: usize = self.tile.components[component].levels[level].bands.len();
        for band_index in 0..band_count {
            let precinct: &mut Precinct = &mut self.tile.components[component].levels[level].bands[band_index].precincts[precinct_index];
            for code_block in &mut precinct.code_blocks {
                if code_block.pending_terminations == 0 && !code_block.included_in_packet {
                    continue;
                }
                for &length in &code_block.segment_lengths {
                    let length: usize = usize::from(length);
                    if self.stream.bytes_left() < length {
                        return fail(ERROR_PACKET_DATA, length as u32);
                    }
                    let terminated: bool = code_block.pending_terminations > 0;
                    let total: usize = code_block.data.len() + length + if terminated { 2 } else { 0 };
                    if total > MAXIMUM_CODE_BLOCK_LENGTH {
                        return fail(ERROR_CODE_BLOCK_LENGTH, total as u32);
                    }
                    let start: usize = self.stream.position;
                    code_block.data.extend_from_slice(&self.arena[start..start + length]);
                    self.stream.skip(length);
                    if terminated {
                        code_block.pending_terminations -= 1;
                        code_block.data.extend_from_slice(&[STUFFING_BYTE, STUFFING_BYTE]);
                        code_block.terminations.push(code_block.data.len() as u32);
                    }
                }
                code_block.segment_lengths.clear();
                code_block.included_in_packet = false;
            }
        }
        Ok(())
    }

    /// FFmpeg's jpeg2000_decode_packets_po_iteration for one progression (change).
    #[allow(clippy::too_many_arguments)]
    fn decode_progression(&mut self, resolution_start: u8, component_start: usize, layer_end: i32, resolution_end: u8, component_end: usize, order: u8) -> DecodeResult<()> {
        match order {
            RESOLUTION_LAYER_COMPONENT_POSITION => {
                let mut level_found: bool = true;
                let mut level: usize = usize::from(resolution_start);
                while level_found && level < usize::from(resolution_end) {
                    level_found = false;
                    for layer in 0..layer_end {
                        for component in component_start..component_end {
                            if level < usize::from(self.header.coding[component].resolution_levels) {
                                level_found = true;
                                self.decode_level_precincts(component, level, layer)?;
                            }
                        }
                    }
                    level += 1;
                }
            }
            LAYER_RESOLUTION_COMPONENT_POSITION => {
                for layer in 0..layer_end {
                    let mut level_found: bool = true;
                    let mut level: usize = usize::from(resolution_start);
                    while level_found && level < usize::from(resolution_end) {
                        level_found = false;
                        for component in component_start..component_end {
                            if level < usize::from(self.header.coding[component].resolution_levels) {
                                level_found = true;
                                self.decode_level_precincts(component, level, layer)?;
                            }
                        }
                        level += 1;
                    }
                }
            }
            COMPONENT_POSITION_RESOLUTION_LAYER => self.decode_component_position(resolution_start, component_start, layer_end, resolution_end, component_end)?,
            RESOLUTION_POSITION_COMPONENT_LAYER => self.decode_resolution_position(resolution_start, component_start, layer_end, resolution_end, component_end)?,
            POSITION_COMPONENT_RESOLUTION_LAYER => self.decode_position_component(resolution_start, component_start, layer_end, resolution_end, component_end)?,
            _ => {}
        }
        Ok(())
    }

    fn decode_level_precincts(&mut self, component: usize, level: usize, layer: i32) -> DecodeResult<()> {
        let resolution: &ResolutionLevel = &self.tile.components[component].levels[level];
        let precinct_count: usize = (resolution.precinct_columns * resolution.precinct_rows).max(0) as usize;
        for precinct_index in 0..precinct_count {
            self.decode_packet(component, level, precinct_index, layer)?;
        }
        Ok(())
    }

    /// The precinct a reference grid position falls in at a level of a component, or None outside the level's precincts.
    fn precinct_at(&self, component: usize, level: usize, x: i64, y: i64, scaled: bool) -> Option<usize> {
        let tile_component = &self.tile.components[component];
        let resolution: &ResolutionLevel = &tile_component.levels[level];
        let reduced: u32 = (usize::from(self.header.coding[component].resolution_levels) - 1 - level) as u32;
        let divisor_x: i64 = i64::from(self.size.subsampling_x[component]);
        let divisor_y: i64 = i64::from(self.size.subsampling_y[component]);
        let (mut precinct_x, mut precinct_y): (i64, i64) = if scaled {
            (
                ceil_divide(x, divisor_x << reduced) >> resolution.precinct_width_log2,
                ceil_divide(y, divisor_y << reduced) >> resolution.precinct_height_log2,
            )
        } else {
            (
                ceil_divide_power(x / divisor_x, reduced) >> resolution.precinct_width_log2,
                ceil_divide_power(y / divisor_y, reduced) >> resolution.precinct_height_log2,
            )
        };
        precinct_x -= ceil_divide_power(i64::from(tile_component.x0), reduced) >> resolution.precinct_width_log2;
        precinct_y -= ceil_divide_power(i64::from(tile_component.y0), reduced) >> resolution.precinct_height_log2;
        // FFmpeg's unsigned comparison takes a negative index as past the end
        if precinct_x < 0 || precinct_y < 0 || precinct_x >= i64::from(resolution.precinct_columns) || precinct_y >= i64::from(resolution.precinct_rows) {
            return None;
        }
        Some((precinct_x + i64::from(resolution.precinct_columns) * precinct_y) as usize)
    }

    /// Whether a reference grid position starts a precinct of a level, as RPCL and PCRL test it.
    fn starts_precinct(&self, component: usize, level: usize, x: i64, y: i64) -> bool {
        let resolution: &ResolutionLevel = &self.tile.components[component].levels[level];
        let reduced: u32 = (usize::from(self.header.coding[component].resolution_levels) - 1 - level) as u32;
        let divisor_x: i64 = i64::from(self.size.subsampling_x[component]);
        let divisor_y: i64 = i64::from(self.size.subsampling_y[component]);
        let tile_x: i64 = i64::from(self.tile.x0);
        let tile_y: i64 = i64::from(self.tile.y0);
        let origin_x: i64 = ceil_divide(tile_x, divisor_x << reduced);
        let origin_y: i64 = ceil_divide(tile_y, divisor_y << reduced);
        let height_shift: u32 = u32::from(resolution.precinct_height_log2) + reduced;
        let width_shift: u32 = u32::from(resolution.precinct_width_log2) + reduced;
        let row_starts: bool = (y as u64).is_multiple_of((divisor_y as u64) << height_shift)
            || (y == tile_y && !((origin_y << reduced) as u64).is_multiple_of(1u64 << height_shift));
        let column_starts: bool = (x as u64).is_multiple_of((divisor_x as u64) << width_shift)
            || (x == tile_x && !((origin_x << reduced) as u64).is_multiple_of(1u64 << width_shift));
        row_starts && column_starts
    }

    fn decode_component_position(&mut self, resolution_start: u8, component_start: usize, layer_end: i32, resolution_end: u8, component_end: usize) -> DecodeResult<()> {
        for component in component_start..component_end {
            let levels: usize = usize::from(self.header.coding[component].resolution_levels).min(usize::from(resolution_end));
            if usize::from(resolution_start) >= levels {
                continue;
            }
            let (mut step_x, mut step_y): (u32, u32) = (POSITION_INITIAL_STEP, POSITION_INITIAL_STEP);
            for level in usize::from(resolution_start)..levels {
                let reduced: u32 = (usize::from(self.header.coding[component].resolution_levels) - 1 - level) as u32;
                let resolution: &ResolutionLevel = &self.tile.components[component].levels[level];
                step_x = step_x.min(u32::from(resolution.precinct_width_log2) + reduced);
                step_y = step_y.min(u32::from(resolution.precinct_height_log2) + reduced);
            }
            if step_x >= MAXIMUM_POSITION_STEP || step_y >= MAXIMUM_POSITION_STEP {
                return fail(ERROR_PROGRESSION_ORDER, step_x.max(step_y));
            }
            let (step_x, step_y): (i64, i64) = (1i64 << step_x, 1i64 << step_y);
            let divisor_x: i64 = i64::from(self.size.subsampling_x[component]);
            let divisor_y: i64 = i64::from(self.size.subsampling_y[component]);
            let mut y: i64 = i64::from(self.tile.y0);
            while y < i64::from(self.tile.y1) {
                let mut x: i64 = i64::from(self.tile.x0);
                while x < i64::from(self.tile.x1) {
                    self.spend_work()?;
                    for level in usize::from(resolution_start)..levels {
                        let reduced: u32 = (usize::from(self.header.coding[component].resolution_levels) - 1 - level) as u32;
                        let resolution: &ResolutionLevel = &self.tile.components[component].levels[level];
                        let component_x: i64 = x / divisor_x;
                        let component_y: i64 = y / divisor_y;
                        if component_y % (1i64 << (u32::from(resolution.precinct_height_log2) + reduced)) != 0 && y != i64::from(self.tile.y0) {
                            continue;
                        }
                        if component_x % (1i64 << (u32::from(resolution.precinct_width_log2) + reduced)) != 0 && x != i64::from(self.tile.x0) {
                            continue;
                        }
                        let Some(precinct_index) = self.precinct_at(component, level, x, y, false) else {
                            continue;
                        };
                        for layer in 0..layer_end {
                            self.decode_packet(component, level, precinct_index, layer)?;
                        }
                    }
                    x = (x / step_x + 1) * step_x;
                }
                y = (y / step_y + 1) * step_y;
            }
        }
        Ok(())
    }

    fn decode_resolution_position(&mut self, resolution_start: u8, component_start: usize, layer_end: i32, resolution_end: u8, component_end: usize) -> DecodeResult<()> {
        let mut level_found: bool = true;
        let mut level: usize = usize::from(resolution_start);
        while level_found && level < usize::from(resolution_end) {
            level_found = false;
            let (mut step_x, mut step_y): (u32, u32) = (RPCL_INITIAL_STEP, RPCL_INITIAL_STEP);
            for component in component_start..component_end {
                let levels: usize = usize::from(self.header.coding[component].resolution_levels);
                if level < levels {
                    let reduced: u32 = (levels - 1 - level) as u32;
                    let resolution: &ResolutionLevel = &self.tile.components[component].levels[level];
                    step_x = step_x.min(u32::from(resolution.precinct_width_log2) + reduced);
                    step_y = step_y.min(u32::from(resolution.precinct_height_log2) + reduced);
                }
            }
            let (step_x, step_y): (i64, i64) = (1i64 << step_x, 1i64 << step_y);
            let mut y: i64 = i64::from(self.tile.y0);
            while y < i64::from(self.tile.y1) {
                let mut x: i64 = i64::from(self.tile.x0);
                while x < i64::from(self.tile.x1) {
                    self.spend_work()?;
                    for component in component_start..component_end {
                        if level >= usize::from(self.header.coding[component].resolution_levels) {
                            continue;
                        }
                        if !self.starts_precinct(component, level, x, y) {
                            continue;
                        }
                        let precinct: Option<usize> = self.precinct_at(component, level, x, y, true);
                        level_found = true;
                        let Some(precinct_index) = precinct else {
                            continue;
                        };
                        for layer in 0..layer_end {
                            self.decode_packet(component, level, precinct_index, layer)?;
                        }
                    }
                    x = (x / step_x + 1) * step_x;
                }
                y = (y / step_y + 1) * step_y;
            }
            level += 1;
        }
        Ok(())
    }

    fn decode_position_component(&mut self, resolution_start: u8, component_start: usize, layer_end: i32, resolution_end: u8, component_end: usize) -> DecodeResult<()> {
        let (mut step_x, mut step_y): (u32, u32) = (POSITION_INITIAL_STEP, POSITION_INITIAL_STEP);
        for component in component_start..component_end {
            let levels: usize = usize::from(self.header.coding[component].resolution_levels);
            for level in usize::from(resolution_start)..levels.min(usize::from(resolution_end)) {
                let reduced: u32 = (levels - 1 - level) as u32;
                let resolution: &ResolutionLevel = &self.tile.components[component].levels[level];
                step_x = step_x.min(u32::from(resolution.precinct_width_log2) + reduced);
                step_y = step_y.min(u32::from(resolution.precinct_height_log2) + reduced);
            }
        }
        if step_x >= MAXIMUM_POSITION_STEP || step_y >= MAXIMUM_POSITION_STEP {
            return fail(ERROR_PROGRESSION_ORDER, step_x.max(step_y));
        }
        let (step_x, step_y): (i64, i64) = (1i64 << step_x, 1i64 << step_y);
        let mut y: i64 = i64::from(self.tile.y0);
        while y < i64::from(self.tile.y1) {
            let mut x: i64 = i64::from(self.tile.x0);
            while x < i64::from(self.tile.x1) {
                self.spend_work()?;
                for component in component_start..component_end {
                    let levels: usize = usize::from(self.header.coding[component].resolution_levels).min(usize::from(resolution_end));
                    for level in usize::from(resolution_start)..levels {
                        if !self.starts_precinct(component, level, x, y) {
                            continue;
                        }
                        let Some(precinct_index) = self.precinct_at(component, level, x, y, true) else {
                            continue;
                        };
                        for layer in 0..layer_end {
                            self.decode_packet(component, level, precinct_index, layer)?;
                        }
                    }
                }
                x = (x / step_x + 1) * step_x;
            }
            y = (y / step_y + 1) * step_y;
        }
        Ok(())
    }

    /// FFmpeg's jpeg2000_decode_packets: the tile's progression changes in order, else its default progression.
    pub fn decode_packets(&mut self) -> DecodeResult<()> {
        self.bit_index = 8;
        self.tile_part = 0;
        let component_count: usize = self.size.component_count.min(MAXIMUM_COMPONENTS);
        let layers: i32 = i32::from(self.header.coding[0].layers);
        if self.header.progression.count > 0 {
            for index in 0..self.header.progression.count {
                let change = self.header.progression.entries[index];
                self.decode_progression(
                    change.resolution_start,
                    usize::from(change.component_start),
                    i32::from(change.layer_end).min(layers),
                    change.resolution_end,
                    usize::from(change.component_end).min(component_count),
                    change.order,
                )?;
            }
            return Ok(());
        }
        let order: u8 = self.header.coding[0].progression_order;
        self.decode_progression(0, 0, layers, ALL_RESOLUTIONS, component_count, order)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminates_every_pass_or_bypass_segments() {
        let terminate_all: u8 = STYLE_TERMINATE_ALL as u8;
        let bypass: u8 = STYLE_BYPASS as u8;
        assert_eq!(needs_termination(0, 5), 0);
        assert_eq!(needs_termination(terminate_all, 0), 1);
        // A bypassed code block terminates after the cleanup pass of its fourth bit-plane, then after each raw refinement pass
        assert_eq!(needs_termination(bypass, 8), 0);
        assert_eq!(needs_termination(bypass, 9), 2);
        assert_eq!(needs_termination(bypass, 10), 0);
        assert_eq!(needs_termination(bypass, 11), 1);
        assert_eq!(needs_termination(bypass | terminate_all, 10), 2);
        assert_eq!(needs_termination(bypass | terminate_all, 4), 1);
    }

    #[test]
    fn takes_floor_logarithms_as_ffmpeg() {
        assert_eq!(log2_floor(0), 0);
        assert_eq!(log2_floor(1), 0);
        assert_eq!(log2_floor(37), 5);
    }
}
