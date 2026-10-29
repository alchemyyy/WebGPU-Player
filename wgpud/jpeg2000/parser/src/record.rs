// Turns tier-2's results into the GPU record jpeg2000.wgsl reads: what each tile contributes, as a parse job carries it,
// then the picture's record with its coefficient layout, code block table, wavelet level tables, and output planes.
// A tile's contribution travels from a parse worker to the coordinator as little-endian words.

use crate::codestream::{COD_REVERSIBLE, ImageSize, MAXIMUM_COMPONENTS, TileHeader};
use crate::error::{DecodeResult, fail};
use crate::format::OutputLayout;
use crate::geometry::{Band, CodeBlock, Tile, TileComponent};
use crate::layout::*;
use crate::quantization::irreversible_scale;

pub const TILE_JOB_MAGIC: u32 = 0x4B4A_324A;
/// Words of a serialized tile before its components: its index, component transform, and component count
const SERIALIZED_TILE_WORDS: usize = 3;
/// Words of a serialized component before its levels: slot, coordinates, sizes, wavelet, final shift, level and code block counts
const SERIALIZED_COMPONENT_WORDS: usize = 9;
/// Words of a serialized code block before its terminations and data
const SERIALIZED_CODE_BLOCK_WORDS: usize = 9;
const BYTES_PER_WORD: usize = 4;
const TERMINATIONS_PER_WORD: usize = 2;
const TERMINATION_SHIFT: u32 = 16;
/// The FFmpeg magnitude bits above which it refuses a band's code blocks
const MAXIMUM_MAGNITUDE_BITS: i32 = 31;
// The failing values of an inconsistent record
pub const JOB_MALFORMED: u32 = 1;
pub const TILE_REPEATED: u32 = 2;
pub const TILE_ABSENT: u32 = 3;

/// One code block with coded bytes, ready for tier-1: its place in its tile-component's coefficients and its decoding parameters.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedCodeBlock {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub passes: u32,
    pub style: u32,
    pub scale: u32,
    pub terminations: Vec<u32>,
    pub data: Vec<u8>,
}

/// One tile-component that feeds an output plane or the component transform.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedComponent {
    pub slot: u32,
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
    pub wavelet: u32,
    pub final_shift: u32,
    /// Each wavelet level, coarsest first: its width and height, each with its origin's parity at bit 16
    pub levels: Vec<[u32; 2]>,
    pub code_blocks: Vec<ParsedCodeBlock>,
}

/// One tile's contribution to the record.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedTile {
    pub index: u32,
    pub component_transform: u32,
    pub components: Vec<ParsedComponent>,
}

/// FFmpeg's ff_jpeg2000_dwt_init level sizes: from the full tile-component down, each level's size and origin parity, returned coarsest first.
fn wavelet_levels(component: &TileComponent, decomposition_levels: usize) -> Vec<[u32; 2]> {
    let mut levels: Vec<[u32; 2]> = vec![[0, 0]; decomposition_levels];
    let mut bounds: [[i64; 2]; 2] = [[i64::from(component.x0), i64::from(component.x1)], [i64::from(component.y0), i64::from(component.y1)]];
    for level in (0..decomposition_levels).rev() {
        for axis in 0..2 {
            let size: u32 = (bounds[axis][1] - bounds[axis][0]) as u32;
            let parity: u32 = (bounds[axis][0] & 1) as u32;
            levels[level][axis] = size | (parity << LEVEL_PARITY_SHIFT);
            for bound in &mut bounds[axis] {
                *bound = (*bound + 1) >> 1;
            }
        }
    }
    levels
}

/// The tier-1 parameters of one code block of a band, from its tier-2 state and the band's dequantization.
fn parse_code_block(code_block: &CodeBlock, band: &Band, band_position: u32, magnitude_bits: i32, region_shift: u8, wavelet: u32, style: u8) -> ParsedCodeBlock {
    let bit_plane: i32 = i32::from(code_block.nonzero_bits) - 1 + 31 - magnitude_bits - 1 - i32::from(region_shift);
    let biased_plane: u32 = (bit_plane + CODE_BLOCK_BIT_PLANE_BIAS as i32).clamp(0, 255) as u32;
    let scale: i32 = if wavelet == WAVELET_REVERSIBLE { band.step.integer_step } else { irreversible_scale(band.step.step, magnitude_bits) };
    ParsedCodeBlock {
        x: (code_block.x0 - band.x0) as u32,
        y: (code_block.y0 - band.y0) as u32,
        width: (code_block.x1 - code_block.x0) as u32,
        height: (code_block.y1 - code_block.y0) as u32,
        passes: u32::from(code_block.passes)
            | (biased_plane << CODE_BLOCK_BIT_PLANE_SHIFT)
            | (band_position << CODE_BLOCK_BAND_SHIFT)
            | (u32::from(region_shift) << CODE_BLOCK_REGION_SHIFT),
        style: u32::from(style) | (((magnitude_bits as u32) & 0xFF) << CODE_BLOCK_MAGNITUDE_BITS_SHIFT) | (wavelet << CODE_BLOCK_WAVELET_SHIFT),
        scale: scale as u32,
        terminations: code_block.terminations.clone(),
        data: code_block.data.clone(),
    }
}

/// Collects a tile's tier-1 work: each needed component's code blocks with coded bytes, with FFmpeg's refusal of a band past 31 magnitude bits.
pub fn parse_tile(tile: &Tile, header: &TileHeader, index: u32, needed_components: &[bool; MAXIMUM_COMPONENTS]) -> DecodeResult<ParsedTile> {
    let coding = &header.coding;
    // FFmpeg compares its transform types, in which both irreversible COD values are its integer 9/7 under the bitexact flag
    let is_reversible = |component: usize| coding[component].wavelet == COD_REVERSIBLE;
    let component_transform: u32 = if coding[0].component_transform == 0 {
        COMPONENT_TRANSFORM_NONE
    } else if tile.components.len() >= 3
        && (1..3).all(|component: usize| is_reversible(component) == is_reversible(0))
        && (1..3).all(|component: usize| {
            let (first, other) = (&tile.components[0], &tile.components[component]);
            (first.x0, first.x1, first.y0, first.y1) == (other.x0, other.x1, other.y0, other.y1)
        })
    {
        if coding[0].wavelet == COD_REVERSIBLE { COMPONENT_TRANSFORM_REVERSIBLE } else { COMPONENT_TRANSFORM_IRREVERSIBLE }
    } else {
        // FFmpeg skips a transform whose components differ in wavelet or size
        COMPONENT_TRANSFORM_NONE
    };
    let mut parsed: ParsedTile = ParsedTile { index, component_transform, components: Vec::new() };
    // The component transform reads the first three components whichever planes show them
    let mut needed_components: [bool; MAXIMUM_COMPONENTS] = *needed_components;
    if component_transform != COMPONENT_TRANSFORM_NONE {
        needed_components[..3].fill(true);
    }
    for (component_index, component) in tile.components.iter().enumerate() {
        let quantization = &header.quantization[component_index];
        let wavelet: u32 = if coding[component_index].wavelet == COD_REVERSIBLE { WAVELET_REVERSIBLE } else { WAVELET_IRREVERSIBLE };
        let mut global_band: usize = 0;
        let mut code_blocks: Vec<ParsedCodeBlock> = Vec::new();
        for (level_index, level) in component.levels.iter().enumerate() {
            for (band_index, band) in level.bands.iter().enumerate() {
                let magnitude_bits: i32 = i32::from(quantization.exponents[global_band.min(quantization.exponents.len() - 1)]) + i32::from(quantization.guard_bits) - 1;
                global_band += 1;
                if band.is_empty() {
                    continue;
                }
                if magnitude_bits > MAXIMUM_MAGNITUDE_BITS {
                    return fail(ERROR_QUANTIZATION, magnitude_bits as u32);
                }
                if !needed_components[component_index] {
                    continue;
                }
                let band_position: u32 = (band_index + usize::from(level_index > 0)) as u32;
                for precinct in &band.precincts {
                    for code_block in precinct.code_blocks.iter().filter(|code_block: &&CodeBlock| !code_block.data.is_empty()) {
                        code_blocks.push(parse_code_block(code_block, band, band_position, magnitude_bits, component.region_shift, wavelet, coding[component_index].code_block_style));
                    }
                }
            }
        }
        if !needed_components[component_index] {
            continue;
        }
        let decomposition_levels: usize = usize::from(coding[component_index].resolution_levels) - 1;
        parsed.components.push(ParsedComponent {
            slot: component_index as u32,
            x0: component.x0 as u32,
            y0: component.y0 as u32,
            width: component.width() as u32,
            height: component.height() as u32,
            wavelet,
            final_shift: u32::from(wavelet == WAVELET_IRREVERSIBLE && decomposition_levels > 0),
            levels: wavelet_levels(component, decomposition_levels),
            code_blocks,
        });
    }
    Ok(parsed)
}

/// Appends a tile's serialized form: its header, then each component's header, levels, and code blocks with their terminations and data.
pub fn serialize_tile(tile: &ParsedTile, output: &mut Vec<u32>) {
    output.extend_from_slice(&[tile.index, tile.component_transform, tile.components.len() as u32]);
    for component in &tile.components {
        output.extend_from_slice(&[
            component.slot,
            component.x0,
            component.y0,
            component.width,
            component.height,
            component.wavelet,
            component.final_shift,
            component.levels.len() as u32,
            component.code_blocks.len() as u32,
        ]);
        for level in &component.levels {
            output.extend_from_slice(level);
        }
        for code_block in &component.code_blocks {
            output.extend_from_slice(&[
                code_block.x,
                code_block.y,
                code_block.width,
                code_block.height,
                code_block.passes,
                code_block.style,
                code_block.scale,
                code_block.terminations.len() as u32,
                code_block.data.len() as u32,
            ]);
            output.extend_from_slice(&code_block.terminations);
            push_bytes(&code_block.data, output);
        }
    }
}

fn push_bytes(bytes: &[u8], output: &mut Vec<u32>) {
    for chunk in bytes.chunks(BYTES_PER_WORD) {
        let mut word: [u8; BYTES_PER_WORD] = [0; BYTES_PER_WORD];
        word[..chunk.len()].copy_from_slice(chunk);
        output.push(u32::from_le_bytes(word));
    }
}

/// Reads serialized words in order, failing on a read past their end.
struct WordReader<'a> {
    words: &'a [u32],
    position: usize,
}

impl WordReader<'_> {
    fn read(&mut self) -> DecodeResult<u32> {
        let Some(&word) = self.words.get(self.position) else {
            return fail(ERROR_RECORD_INVALID, JOB_MALFORMED);
        };
        self.position += 1;
        Ok(word)
    }

    fn read_slice(&mut self, count: usize) -> DecodeResult<&[u32]> {
        let end: usize = self.position.checked_add(count).filter(|&end: &usize| end <= self.words.len()).ok_or(crate::error::DecodeError { code: ERROR_RECORD_INVALID, value: JOB_MALFORMED })?;
        let slice: &[u32] = &self.words[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn read_bytes(&mut self, count: usize) -> DecodeResult<Vec<u8>> {
        let words: &[u32] = self.read_slice(count.div_ceil(BYTES_PER_WORD))?;
        let mut bytes: Vec<u8> = Vec::with_capacity(words.len() * BYTES_PER_WORD);
        for word in words {
            bytes.extend_from_slice(&word.to_le_bytes());
        }
        bytes.truncate(count);
        Ok(bytes)
    }
}

/// Reads the tiles of serialized jobs, concatenated in order.
pub fn deserialize_tiles(words: &[u32]) -> DecodeResult<Vec<ParsedTile>> {
    let mut reader: WordReader = WordReader { words, position: 0 };
    let mut tiles: Vec<ParsedTile> = Vec::new();
    while reader.position < words.len() {
        if reader.read()? != TILE_JOB_MAGIC {
            return fail(ERROR_RECORD_INVALID, JOB_MALFORMED);
        }
        let tile_count: usize = reader.read()? as usize;
        for _ in 0..tile_count {
            let header: &[u32] = reader.read_slice(SERIALIZED_TILE_WORDS)?;
            let mut tile: ParsedTile = ParsedTile { index: header[0], component_transform: header[1], components: Vec::new() };
            let component_count: usize = header[2] as usize;
            for _ in 0..component_count {
                let fields: Vec<u32> = reader.read_slice(SERIALIZED_COMPONENT_WORDS)?.to_vec();
                let mut component: ParsedComponent = ParsedComponent {
                    slot: fields[0],
                    x0: fields[1],
                    y0: fields[2],
                    width: fields[3],
                    height: fields[4],
                    wavelet: fields[5],
                    final_shift: fields[6],
                    levels: Vec::new(),
                    code_blocks: Vec::new(),
                };
                for _ in 0..fields[7] {
                    let level: &[u32] = reader.read_slice(LEVEL_WORDS as usize)?;
                    component.levels.push([level[0], level[1]]);
                }
                for _ in 0..fields[8] {
                    let block: Vec<u32> = reader.read_slice(SERIALIZED_CODE_BLOCK_WORDS)?.to_vec();
                    let terminations: Vec<u32> = reader.read_slice(block[7] as usize)?.to_vec();
                    let data: Vec<u8> = reader.read_bytes(block[8] as usize)?;
                    component.code_blocks.push(ParsedCodeBlock {
                        x: block[0],
                        y: block[1],
                        width: block[2],
                        height: block[3],
                        passes: block[4],
                        style: block[5],
                        scale: block[6],
                        terminations,
                        data,
                    });
                }
                tile.components.push(component);
            }
            tiles.push(tile);
        }
    }
    Ok(tiles)
}

// The header ends with the output planes
const _: () = assert!(HEADER_PLANES + PLANE_COUNT * PLANE_WORDS == HEADER_WORDS);

/// The words of a record under construction, with its header filled in last.
struct RecordWriter {
    words: Vec<u32>,
}

impl RecordWriter {
    fn set(&mut self, field: u32, value: u32) {
        self.words[field as usize] = value;
    }

    fn position(&self) -> u32 {
        self.words.len() as u32
    }

    /// Appends a zeroed table of entries of the given words, returning its word offset.
    fn reserve_table(&mut self, entry_count: usize, entry_words: u32) -> u32 {
        let table: u32 = self.position();
        self.words.resize(self.words.len() + entry_count * entry_words as usize, 0);
        table
    }
}

/// One tile-component's place in the record while it is assembled.
struct ComponentPlacement {
    coefficients: u32,
    first_big_level: u32,
    level_count: u32,
    levels: Vec<[u32; 2]>,
}

fn level_size(word: u32) -> u32 {
    word & LEVEL_SIZE_MASK
}

/// The pairs of line indices, an even one and the odd one after it, that a level's line spans; each is one GPU work item
fn pair_count(word: u32) -> u32 {
    let size: u32 = level_size(word);
    if size == 0 { 0 } else { (size + level_parity(word) + 1) >> 1 }
}

fn level_parity(word: u32) -> u32 {
    word >> LEVEL_PARITY_SHIFT
}

/// Assembles the GPU record of a picture from its image geometry, output layout, and tiles, which it puts in tile order.
pub fn assemble_record(size: &ImageSize, tile_count: usize, layout: &OutputLayout, mut tiles: Vec<ParsedTile>) -> DecodeResult<Vec<u32>> {
    tiles.sort_by_key(|tile: &ParsedTile| tile.index);
    if tiles.len() != tile_count {
        return fail(ERROR_RECORD_INVALID, TILE_ABSENT);
    }
    for (expected, tile) in tiles.iter().enumerate() {
        if tile.index as usize != expected {
            return fail(ERROR_RECORD_INVALID, TILE_REPEATED);
        }
    }
    let mut record: RecordWriter = RecordWriter { words: vec![0; HEADER_WORDS as usize] };
    record.set(HEADER_MAGIC, MAGIC);
    record.set(HEADER_VERSION, VERSION);
    record.set(HEADER_WIDTH, size.output_width as u32);
    record.set(HEADER_HEIGHT, size.output_height as u32);
    record.set(HEADER_CHROMA_FORMAT, layout.chroma_format);
    record.set(HEADER_OUTPUT_BIT_DEPTH, layout.bit_depth);
    record.set(HEADER_FORMAT_ERROR, layout.format_error);
    record.set(HEADER_OUTPUT_TRANSFORM, layout.output_transform);
    record.set(HEADER_TILE_COLUMNS, size.tile_columns);
    record.set(HEADER_TILE_ROWS, size.tile_rows);
    record.set(HEADER_TILE_WIDTH, size.tile_width as u32);
    record.set(HEADER_TILE_HEIGHT, size.tile_height as u32);
    record.set(HEADER_TILE_OFFSET_X, size.tile_offset_x as u32);
    record.set(HEADER_TILE_OFFSET_Y, size.tile_offset_y as u32);
    record.set(HEADER_IMAGE_X0, size.image_offset_x as u32);
    record.set(HEADER_IMAGE_Y0, size.image_offset_y as u32);
    record.set(HEADER_IMAGE_X1, size.width as u32);
    record.set(HEADER_IMAGE_Y1, size.height as u32);
    for (plane_index, plane) in layout.planes.iter().enumerate() {
        let base: u32 = HEADER_PLANES + plane_index as u32 * PLANE_WORDS;
        record.set(base + PLANE_COMPONENT, plane.component);
        record.set(base + PLANE_WIDTH, plane.width);
        record.set(base + PLANE_HEIGHT, plane.height);
        record.set(base + PLANE_ORIGIN_X, plane.origin_x);
        record.set(base + PLANE_ORIGIN_Y, plane.origin_y);
        record.set(base + PLANE_DIVISOR_X, plane.divisor_x);
        record.set(base + PLANE_DIVISOR_Y, plane.divisor_y);
        record.set(base + PLANE_COMPONENT_BITS, plane.component_bits);
        record.set(base + PLANE_SHIFT, plane.shift);
    }

    // Tile-components in tile order, each with its coefficients after the last's
    let mut placements: Vec<ComponentPlacement> = Vec::new();
    let mut tile_slots: Vec<[u32; COMPONENT_SLOTS as usize]> = Vec::with_capacity(tile_count);
    let mut coefficient_words: u64 = 0;
    for tile in &tiles {
        let mut slots: [u32; COMPONENT_SLOTS as usize] = [MISSING; COMPONENT_SLOTS as usize];
        for component in &tile.components {
            if (component.slot as usize) < slots.len() {
                slots[component.slot as usize] = placements.len() as u32;
            }
            let first_big_level: usize = component
                .levels
                .iter()
                .position(|level: &[u32; 2]| level_size(level[0]) > SMALL_LEVEL_SIZE || level_size(level[1]) > SMALL_LEVEL_SIZE)
                .unwrap_or(component.levels.len());
            placements.push(ComponentPlacement {
                coefficients: coefficient_words as u32,
                first_big_level: first_big_level as u32,
                level_count: component.levels.len() as u32,
                levels: component.levels.clone(),
            });
            coefficient_words += u64::from(component.width) * u64::from(component.height);
        }
        tile_slots.push(slots);
    }
    if coefficient_words > u64::from(u32::MAX >> 2) {
        return fail(ERROR_RESOURCE_LIMIT, (coefficient_words >> 20).min(u64::from(u32::MAX)) as u32);
    }
    record.set(HEADER_COEFFICIENT_WORDS, coefficient_words as u32);

    let tile_table: u32 = record.reserve_table(tiles.len(), TILE_WORDS);
    record.set(HEADER_TILE_TABLE, tile_table);
    for (tile_index, (tile, slots)) in tiles.iter().zip(&tile_slots).enumerate() {
        let entry: u32 = tile_table + tile_index as u32 * TILE_WORDS;
        record.set(entry + TILE_TRANSFORM, tile.component_transform);
        for (slot, &component) in slots.iter().enumerate() {
            record.set(entry + TILE_COMPONENTS + slot as u32, component);
        }
    }

    // Each tile-component's wavelet levels, then the tile-component table pointing into them
    let mut level_tables: Vec<u32> = Vec::with_capacity(placements.len());
    for placement in &placements {
        let level_table: u32 = record.reserve_table(placement.levels.len(), LEVEL_WORDS);
        for (level_index, level) in placement.levels.iter().enumerate() {
            let entry: u32 = level_table + level_index as u32 * LEVEL_WORDS;
            record.set(entry + LEVEL_WIDTH, level[0]);
            record.set(entry + LEVEL_HEIGHT, level[1]);
        }
        level_tables.push(level_table);
    }
    let component_table: u32 = record.reserve_table(placements.len(), TILE_COMPONENT_WORDS);
    record.set(HEADER_TILE_COMPONENT_TABLE, component_table);
    record.set(HEADER_TILE_COMPONENT_COUNT, placements.len() as u32);
    let components = tiles.iter().flat_map(|tile: &ParsedTile| &tile.components);
    for (placement_index, (placement, component)) in placements.iter().zip(components).enumerate() {
        let entry: u32 = component_table + placement_index as u32 * TILE_COMPONENT_WORDS;
        record.set(entry + TILE_COMPONENT_COEFFICIENTS, placement.coefficients);
        record.set(entry + TILE_COMPONENT_WIDTH, component.width);
        record.set(entry + TILE_COMPONENT_HEIGHT, component.height);
        record.set(entry + TILE_COMPONENT_X0, component.x0);
        record.set(entry + TILE_COMPONENT_Y0, component.y0);
        record.set(entry + TILE_COMPONENT_LEVEL_COUNT, placement.level_count);
        record.set(entry + TILE_COMPONENT_FIRST_BIG_LEVEL, placement.first_big_level);
        record.set(entry + TILE_COMPONENT_LEVELS, level_tables[placement_index]);
        record.set(entry + TILE_COMPONENT_WAVELET, component.wavelet);
        record.set(entry + TILE_COMPONENT_FINAL_SHIFT, component.final_shift);
    }

    // Wavelet jobs: one workgroup per tile-component with small levels, then each larger level's iteration
    record.set(HEADER_SMALL_JOB_TABLE, record.position());
    let mut small_job_count: u32 = 0;
    for (index, placement) in placements.iter().enumerate() {
        if placement.first_big_level > 0 {
            record.words.push(index as u32);
            small_job_count += 1;
        }
    }
    record.set(HEADER_SMALL_JOB_COUNT, small_job_count);
    let iteration_count: u32 = placements.iter().map(|placement: &ComponentPlacement| placement.level_count - placement.first_big_level).max().unwrap_or(0);
    if iteration_count > MAXIMUM_BIG_ITERATIONS {
        return fail(ERROR_RESOURCE_LIMIT, iteration_count);
    }
    let iteration_table: u32 = record.position();
    record.set(HEADER_BIG_ITERATION_TABLE, iteration_table);
    record.set(HEADER_BIG_ITERATION_COUNT, iteration_count);
    record.words.resize(record.words.len() + (iteration_count * ITERATION_WORDS) as usize, 0);
    for iteration in 0..iteration_count {
        let jobs: u32 = record.position();
        let (mut horizontal_items, mut vertical_items, mut job_count): (u64, u64, u32) = (0, 0, 0);
        for (index, placement) in placements.iter().enumerate() {
            let level: u32 = placement.first_big_level + iteration;
            if level >= placement.level_count {
                continue;
            }
            let [width, height] = placement.levels[level as usize];
            let job: u32 = record.reserve_table(1, JOB_WORDS);
            record.set(job + JOB_TILE_COMPONENT, index as u32);
            record.set(job + JOB_LEVEL, level);
            record.set(job + JOB_HORIZONTAL_START, horizontal_items as u32);
            record.set(job + JOB_VERTICAL_START, vertical_items as u32);
            horizontal_items += u64::from(level_size(height)) * u64::from(pair_count(width));
            vertical_items += u64::from(level_size(width)) * u64::from(pair_count(height));
            job_count += 1;
        }
        if horizontal_items > u64::from(u32::MAX) || vertical_items > u64::from(u32::MAX) {
            return fail(ERROR_RESOURCE_LIMIT, iteration);
        }
        let entry: u32 = iteration_table + iteration * ITERATION_WORDS;
        record.set(entry + ITERATION_HORIZONTAL_ITEMS, horizontal_items as u32);
        record.set(entry + ITERATION_VERTICAL_ITEMS, vertical_items as u32);
        record.set(entry + ITERATION_JOB_COUNT, job_count);
        record.set(entry + ITERATION_JOBS, jobs);
    }

    // Code blocks, their termination tables, then their bytes
    let code_block_count: usize = tiles.iter().flat_map(|tile: &ParsedTile| &tile.components).map(|component: &ParsedComponent| component.code_blocks.len()).sum();
    let code_block_table: u32 = record.position();
    record.set(HEADER_CODE_BLOCK_TABLE, code_block_table);
    record.set(HEADER_CODE_BLOCK_COUNT, code_block_count as u32);
    record.words.resize(record.words.len() + code_block_count * CODE_BLOCK_WORDS as usize, 0);
    let mut termination_tables: Vec<u32> = Vec::with_capacity(code_block_count);
    for tile in &tiles {
        for component in &tile.components {
            for code_block in &component.code_blocks {
                termination_tables.push(record.position());
                for pair in code_block.terminations.chunks(TERMINATIONS_PER_WORD) {
                    let high: u32 = pair.get(1).copied().unwrap_or(0);
                    record.words.push((pair[0] & 0xFFFF) | (high << TERMINATION_SHIFT));
                }
            }
        }
    }
    let data_start: usize = record.words.len() * BYTES_PER_WORD;
    let mut data: Vec<u8> = Vec::new();
    let mut block_index: usize = 0;
    let mut placement_index: usize = 0;
    for tile in &tiles {
        for component in &tile.components {
            let coefficients: u32 = placements[placement_index].coefficients;
            placement_index += 1;
            for code_block in &component.code_blocks {
                let entry: u32 = code_block_table + block_index as u32 * CODE_BLOCK_WORDS;
                record.set(entry + CODE_BLOCK_DESTINATION, coefficients + code_block.y * component.width + code_block.x);
                record.set(entry + CODE_BLOCK_STRIDE, component.width);
                record.set(entry + CODE_BLOCK_SIZE, code_block.width | (code_block.height << CODE_BLOCK_HEIGHT_SHIFT));
                record.set(entry + CODE_BLOCK_DATA_OFFSET, (data_start + data.len()) as u32);
                record.set(entry + CODE_BLOCK_DATA_LENGTH, code_block.data.len() as u32 | ((code_block.terminations.len() as u32) << CODE_BLOCK_TERMINATION_COUNT_SHIFT));
                record.set(entry + CODE_BLOCK_PASSES, code_block.passes);
                record.set(entry + CODE_BLOCK_STYLE, code_block.style);
                record.set(entry + CODE_BLOCK_SCALE, code_block.scale);
                record.set(entry + CODE_BLOCK_TERMINATIONS, termination_tables[block_index]);
                data.extend_from_slice(&code_block.data);
                block_index += 1;
            }
        }
    }
    push_bytes(&data, &mut record.words);
    let byte_length: usize = record.words.len() * BYTES_PER_WORD;
    if byte_length > MAXIMUM_BYTE_LENGTH as usize {
        return fail(ERROR_RESOURCE_LIMIT, (byte_length >> 20) as u32);
    }
    record.set(HEADER_BYTE_LENGTH, byte_length as u32);
    Ok(record.words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_tile() -> ParsedTile {
        ParsedTile {
            index: 2,
            component_transform: COMPONENT_TRANSFORM_REVERSIBLE,
            components: vec![ParsedComponent {
                slot: 0,
                x0: 4,
                y0: 6,
                width: 9,
                height: 7,
                wavelet: WAVELET_REVERSIBLE,
                final_shift: 0,
                levels: vec![[5 | (1 << LEVEL_PARITY_SHIFT), 4], [9, 7]],
                code_blocks: vec![ParsedCodeBlock {
                    x: 1,
                    y: 2,
                    width: 3,
                    height: 4,
                    passes: 7,
                    style: 1,
                    scale: 32768,
                    terminations: vec![5, 9, 13],
                    data: vec![1, 2, 3, 4, 5, 6, 7],
                }],
            }],
        }
    }

    #[test]
    fn round_trips_a_tile_through_its_serialized_words() {
        let tile: ParsedTile = sample_tile();
        let mut words: Vec<u32> = vec![TILE_JOB_MAGIC, 1];
        serialize_tile(&tile, &mut words);
        assert_eq!(deserialize_tiles(&words), Ok(vec![tile]));
    }

    #[test]
    fn refuses_truncated_or_foreign_jobs() {
        let mut words: Vec<u32> = vec![TILE_JOB_MAGIC, 1];
        serialize_tile(&sample_tile(), &mut words);
        words.pop();
        assert_eq!(deserialize_tiles(&words).err().map(|error| error.value), Some(JOB_MALFORMED));
        assert_eq!(deserialize_tiles(&[0, 0]).err().map(|error| error.value), Some(JOB_MALFORMED));
    }

    #[test]
    fn assembles_every_table_where_the_header_and_the_entries_point() {
        // Three tiles of one 9x7 component each, given out of order
        const TILE_COUNT: usize = 3;
        const COMPONENT_WORDS: u32 = 9 * 7;
        const LAST_TILE: u32 = 2;
        let tiles: Vec<ParsedTile> = [2, 0, 1].iter().map(|&index: &u32| ParsedTile { index, ..sample_tile() }).collect();
        let size: ImageSize = ImageSize { tile_columns: TILE_COUNT as u32, tile_rows: 1, ..ImageSize::default() };
        let record: Vec<u32> = assemble_record(&size, TILE_COUNT, &OutputLayout::default(), tiles).expect("a record");
        let field = |offset: u32| record[offset as usize];
        assert_eq!((field(HEADER_MAGIC), field(HEADER_VERSION)), (MAGIC, VERSION));
        assert_eq!(field(HEADER_BYTE_LENGTH) as usize, record.len() * BYTES_PER_WORD);
        assert_eq!(field(HEADER_COEFFICIENT_WORDS), TILE_COUNT as u32 * COMPONENT_WORDS);

        let tile: u32 = field(HEADER_TILE_TABLE) + LAST_TILE * TILE_WORDS;
        assert_eq!(field(tile + TILE_TRANSFORM), COMPONENT_TRANSFORM_REVERSIBLE);
        assert_eq!(field(tile + TILE_COMPONENTS), LAST_TILE);
        assert_eq!(field(tile + TILE_COMPONENTS + 1), MISSING);

        assert_eq!(field(HEADER_TILE_COMPONENT_COUNT), TILE_COUNT as u32);
        let component: u32 = field(HEADER_TILE_COMPONENT_TABLE) + LAST_TILE * TILE_COMPONENT_WORDS;
        assert_eq!(field(component + TILE_COMPONENT_COEFFICIENTS), LAST_TILE * COMPONENT_WORDS);
        assert_eq!((field(component + TILE_COMPONENT_WIDTH), field(component + TILE_COMPONENT_HEIGHT)), (9, 7));
        assert_eq!((field(component + TILE_COMPONENT_X0), field(component + TILE_COMPONENT_Y0)), (4, 6));
        // Both levels fit one workgroup, so the tile-component is a small job and no larger level iterates
        assert_eq!((field(component + TILE_COMPONENT_LEVEL_COUNT), field(component + TILE_COMPONENT_FIRST_BIG_LEVEL)), (2, 2));
        let first_level: u32 = field(component + TILE_COMPONENT_LEVELS);
        assert_eq!((field(first_level + LEVEL_WIDTH), field(first_level + LEVEL_HEIGHT)), (5 | (1 << LEVEL_PARITY_SHIFT), 4));
        assert_eq!((field(first_level + LEVEL_WORDS + LEVEL_WIDTH), field(first_level + LEVEL_WORDS + LEVEL_HEIGHT)), (9, 7));
        assert_eq!((field(HEADER_SMALL_JOB_COUNT), field(HEADER_BIG_ITERATION_COUNT)), (TILE_COUNT as u32, 0));
        assert_eq!(field(field(HEADER_SMALL_JOB_TABLE) + LAST_TILE), LAST_TILE);

        assert_eq!(field(HEADER_CODE_BLOCK_COUNT), TILE_COUNT as u32);
        let block: u32 = field(HEADER_CODE_BLOCK_TABLE) + LAST_TILE * CODE_BLOCK_WORDS;
        // At x 1, y 2 of the third tile-component's coefficients, 9 per row
        assert_eq!(field(block + CODE_BLOCK_DESTINATION), LAST_TILE * COMPONENT_WORDS + 2 * 9 + 1);
        assert_eq!(field(block + CODE_BLOCK_STRIDE), 9);
        assert_eq!(field(block + CODE_BLOCK_SIZE), 3 | (4 << CODE_BLOCK_HEIGHT_SHIFT));
        assert_eq!(field(block + CODE_BLOCK_DATA_LENGTH), 7 | (3 << CODE_BLOCK_TERMINATION_COUNT_SHIFT));
        let terminations: u32 = field(block + CODE_BLOCK_TERMINATIONS);
        assert_eq!((field(terminations), field(terminations + 1)), (5 | (9 << TERMINATION_SHIFT), 13));
        let bytes: Vec<u8> = record.iter().flat_map(|word: &u32| word.to_le_bytes()).collect();
        let data_offset: usize = field(block + CODE_BLOCK_DATA_OFFSET) as usize;
        assert_eq!(bytes[data_offset..data_offset + 7], [1, 2, 3, 4, 5, 6, 7]);
    }

    #[test]
    fn lays_out_wavelet_levels_as_ffmpeg_halves_them() {
        let component: TileComponent = TileComponent { x0: 3, x1: 20, y0: 0, y1: 9, ..TileComponent::default() };
        let levels: Vec<[u32; 2]> = wavelet_levels(&component, 2);
        // Finest: 17 wide from x 3 (odd), 9 tall from 0; then x 2..10 and y 0..5
        assert_eq!(levels[1], [17 | (1 << LEVEL_PARITY_SHIFT), 9]);
        assert_eq!(levels[0], [8, 5]);
    }
}
