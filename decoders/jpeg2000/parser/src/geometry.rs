// A tile's components, resolution levels, bands, precincts, and code blocks, laid out as FFmpeg's init_tile, ff_jpeg2000_init_component,
// init_band, and init_prec lay them out, with the tag trees and code block states tier-2 fills.
// Code block coordinates carry FFmpeg's offsets, so a code block's place in its tile-component's coefficients is its coordinates
// less its band's origin: high bands sit right of and below the lower resolution, as in Mallat's layout.

use crate::codestream::{
    CODE_BLOCK_STYLE_HIGH_THROUGHPUT, CodingStyle, ImageSize, MAXIMUM_COMPONENTS, QuantizationStyle, TileHeader, COD_IRREVERSIBLE_INTEGER,
};
use crate::error::{DecodeResult, fail, fail_signed};
use crate::layout::{ERROR_CODING_STYLE, ERROR_IMAGE_SIZE, ERROR_RESOURCE_LIMIT, ERROR_TILE_MISSING, ERROR_UNSUPPORTED_FEATURE};
use crate::quantization::{BandStep, band_step};

/// FFmpeg's bound on a tile-component's side
const MAXIMUM_COMPONENT_SIDE: i64 = 32768;
const IMAGE_SIZE_LIMIT: i64 = (i32::MAX / 8) as i64;
const IMAGE_SIZE_PADDING: i64 = 128;
const ROOT: u32 = u32::MAX;
/// FFmpeg's bound on precincts per level, its max_pixels over the 56 bytes of its precinct struct
const MAXIMUM_PRECINCTS: u64 = (i32::MAX as u64) / 56;
/// The band precincts and code blocks one tile may lay out: past any real stream's, and within the module's memory for any codestream
const MAXIMUM_TILE_GEOMETRY_OBJECTS: u64 = 1 << 22;
/// The steps one parse call may take: geometry objects, packets, progression positions, and code block headers, far past any real stream's,
/// so a codestream of millions of empty packets fails within a second instead of running as long as FFmpeg does
pub const MAXIMUM_PARSE_WORK: u64 = 1 << 25;
const INITIAL_LENGTH_EXPONENT: u8 = 3;
// The failing values of a geometry FFmpeg cannot allocate, or this parser will not lay out, and of a parse past its work
pub const CODE_BLOCK_GRID_INVALID: u32 = 1;
pub const PRECINCT_COUNT_LIMIT: u32 = 2;
pub const GEOMETRY_OBJECT_LIMIT: u32 = 3;
pub const PARSE_WORK_LIMIT: u32 = 4;

/// What a tile may still lay out, and the parse's remaining work, both spent before each allocation of band precincts or code blocks.
struct GeometryBudget<'a> {
    remaining_objects: u64,
    remaining_work: &'a mut u64,
}

impl GeometryBudget<'_> {
    fn spend(&mut self, objects: u64) -> DecodeResult<()> {
        if objects > self.remaining_objects {
            return fail(ERROR_RESOURCE_LIMIT, GEOMETRY_OBJECT_LIMIT);
        }
        if objects > *self.remaining_work {
            return fail(ERROR_RESOURCE_LIMIT, PARSE_WORK_LIMIT);
        }
        self.remaining_objects -= objects;
        *self.remaining_work -= objects;
        Ok(())
    }
}

pub fn ceil_divide(numerator: i64, divisor: i64) -> i64 {
    (numerator + divisor - 1) / divisor
}

/// FFmpeg's ff_jpeg2000_ceildivpow2.
pub fn ceil_divide_power(numerator: i64, exponent: u32) -> i64 {
    -((-numerator) >> exponent)
}

/// A tag tree's node: the lower bound or value FFmpeg keeps in 8 bits, whether the value is known, and its parent.
#[derive(Clone, Copy, Debug)]
struct TagNode {
    value: u8,
    visited: u8,
    parent: u32,
}

/// A tag tree over a precinct's code blocks, leaves first, as FFmpeg's ff_jpeg2000_tag_tree_init lays it out.
#[derive(Clone, Debug, Default)]
pub struct TagTree {
    nodes: Vec<TagNode>,
}

impl TagTree {
    pub fn new(width: i64, height: i64) -> Self {
        let mut size: i64 = 0;
        let (mut level_width, mut level_height) = (width, height);
        while level_width > 1 || level_height > 1 {
            size += level_width * level_height;
            level_width = (level_width + 1) >> 1;
            level_height = (level_height + 1) >> 1;
        }
        let mut nodes: Vec<TagNode> = vec![TagNode { value: 0, visited: 0, parent: ROOT }; (size + 1) as usize];
        let mut level_start: usize = 0;
        let (mut level_width, mut level_height) = (width, height);
        while level_width > 1 || level_height > 1 {
            let (previous_width, previous_height) = (level_width, level_height);
            level_width = (level_width + 1) >> 1;
            level_height = (level_height + 1) >> 1;
            let next_start: usize = level_start + (previous_width * previous_height) as usize;
            for row in 0..previous_height {
                for column in 0..previous_width {
                    let parent: usize = next_start + ((row >> 1) * level_width + (column >> 1)) as usize;
                    nodes[level_start + (row * previous_width + column) as usize].parent = parent as u32;
                }
            }
            level_start = next_start;
        }
        Self { nodes }
    }

    /// FFmpeg's tag_tree_decode: decodes leaf `leaf` up to `threshold` with bits from `read_bit`, returning its value or a lower bound at the threshold.
    pub fn decode(&mut self, leaf: usize, threshold: i32, mut read_bit: impl FnMut() -> u32) -> i32 {
        let mut stack: [usize; 32] = [0; 32];
        let mut depth: usize = 0;
        let mut node: u32 = leaf as u32;
        while node != ROOT && self.nodes[node as usize].visited == 0 && depth < stack.len() {
            stack[depth] = node as usize;
            depth += 1;
            node = self.nodes[node as usize].parent;
        }
        let mut current: i32 = if node != ROOT && depth < stack.len() {
            i32::from(self.nodes[node as usize].value)
        } else {
            i32::from(self.nodes[stack[depth - 1]].value)
        };
        while current < threshold && depth > 0 {
            let index: usize = stack[depth - 1];
            current = current.max(i32::from(self.nodes[index].value));
            while current < threshold {
                if read_bit() != 0 {
                    self.nodes[index].visited = self.nodes[index].visited.wrapping_add(1);
                    break;
                }
                current += 1;
            }
            // FFmpeg keeps the value in 8 bits
            self.nodes[index].value = current as u8;
            depth -= 1;
        }
        current
    }
}

/// A code block's tier-2 state and its coded bytes, as FFmpeg's Jpeg2000Cblk keeps them.
#[derive(Clone, Debug, Default)]
pub struct CodeBlock {
    pub x0: i32,
    pub x1: i32,
    pub y0: i32,
    pub y1: i32,
    pub passes: u8,
    pub nonzero_bits: u8,
    pub included: bool,
    pub length_exponent: u8,
    /// The coded bytes of every contribution, with FFmpeg's 0xFF 0xFF after each terminated segment
    pub data: Vec<u8>,
    /// Where each segment after a termination starts in `data`, FFmpeg's data_start from index 1
    pub terminations: Vec<u32>,
    /// The current packet's segment lengths and terminations, which its data then consumes
    pub segment_lengths: Vec<u16>,
    pub included_in_packet: bool,
    pub pending_terminations: i32,
}

/// A precinct of one band: its code block grid, tag trees, and code blocks.
#[derive(Clone, Debug, Default)]
pub struct Precinct {
    pub code_block_columns: i32,
    pub code_block_rows: i32,
    pub inclusion: TagTree,
    pub zero_bit_planes: TagTree,
    pub code_blocks: Vec<CodeBlock>,
    pub decoded_layers: i32,
}

/// A band of a resolution level.
#[derive(Clone, Debug, Default)]
pub struct Band {
    pub x0: i32,
    pub x1: i32,
    pub y0: i32,
    pub y1: i32,
    pub code_block_width_log2: u32,
    pub code_block_height_log2: u32,
    pub step: BandStep,
    pub precincts: Vec<Precinct>,
}

impl Band {
    pub fn is_empty(&self) -> bool {
        self.x0 == self.x1 || self.y0 == self.y1
    }
}

/// A resolution level of a tile-component.
#[derive(Clone, Debug, Default)]
pub struct ResolutionLevel {
    pub x0: i32,
    pub x1: i32,
    pub y0: i32,
    pub y1: i32,
    pub precinct_columns: i32,
    pub precinct_rows: i32,
    pub precinct_width_log2: u8,
    pub precinct_height_log2: u8,
    pub bands: Vec<Band>,
}

/// A tile-component: its coordinates on the component's grid and its resolution levels, coarsest first.
#[derive(Clone, Debug, Default)]
pub struct TileComponent {
    pub x0: i32,
    pub x1: i32,
    pub y0: i32,
    pub y1: i32,
    pub region_shift: u8,
    pub levels: Vec<ResolutionLevel>,
}

impl TileComponent {
    pub fn width(&self) -> i32 {
        self.x1 - self.x0
    }

    pub fn height(&self) -> i32 {
        self.y1 - self.y0
    }
}

/// A tile: its coordinates on the reference grid and its components.
#[derive(Clone, Debug, Default)]
pub struct Tile {
    pub x0: i32,
    pub x1: i32,
    pub y0: i32,
    pub y1: i32,
    pub components: Vec<TileComponent>,
}

fn check_component_size(width: i64, height: i64) -> DecodeResult<()> {
    if width <= 0 || height <= 0 || (width + IMAGE_SIZE_PADDING) * (height + IMAGE_SIZE_PADDING) >= IMAGE_SIZE_LIMIT {
        return fail_signed(ERROR_IMAGE_SIZE, width.min(height));
    }
    if width > MAXIMUM_COMPONENT_SIDE || height > MAXIMUM_COMPONENT_SIDE {
        return fail_signed(ERROR_IMAGE_SIZE, width.max(height));
    }
    Ok(())
}

/// FFmpeg's init_prec: a precinct's place in its band, its code block grid, and its code blocks' coordinates.
#[allow(clippy::too_many_arguments)]
fn initialize_precinct(
    band: &Band,
    level: &ResolutionLevel,
    lower_level: Option<&ResolutionLevel>,
    precinct_index: i32,
    position: usize,
    precinct_width_log2: u32,
    precinct_height_log2: u32,
    budget: &mut GeometryBudget,
) -> DecodeResult<Precinct> {
    let column: i64 = i64::from(precinct_index % level.precinct_columns);
    let row: i64 = i64::from(precinct_index / level.precinct_columns);
    let mut x0: i64 = ((i64::from(level.x0) >> level.precinct_width_log2) + column) * (1i64 << precinct_width_log2);
    let mut y0: i64 = ((i64::from(level.y0) >> level.precinct_height_log2) + row) * (1i64 << precinct_height_log2);
    let mut x1: i64 = x0 + (1i64 << precinct_width_log2);
    let mut y1: i64 = y0 + (1i64 << precinct_height_log2);
    x0 = x0.max(i64::from(band.x0));
    x1 = x1.min(i64::from(band.x1));
    y0 = y0.max(i64::from(band.y0));
    y1 = y1.min(i64::from(band.y1));
    let columns: i64 = ceil_divide_power(x1, band.code_block_width_log2) - (x0 >> band.code_block_width_log2);
    let rows: i64 = ceil_divide_power(y1, band.code_block_height_log2) - (y0 >> band.code_block_height_log2);
    // FFmpeg refuses a grid whose unsigned product overflows int; a negative side it cannot lay out is refused here too
    if columns < 0 || rows < 0 || columns * rows > i64::from(i32::MAX) {
        return fail(ERROR_RESOURCE_LIMIT, CODE_BLOCK_GRID_INVALID);
    }
    budget.spend((columns * rows) as u64)?;
    let mut precinct: Precinct = Precinct {
        code_block_columns: columns as i32,
        code_block_rows: rows as i32,
        inclusion: TagTree::new(columns, rows),
        zero_bit_planes: TagTree::new(columns, rows),
        code_blocks: Vec::with_capacity((columns * rows) as usize),
        decoded_layers: 0,
    };
    let (width_offset, height_offset) = match lower_level {
        Some(lower) => (i64::from(lower.x1 - lower.x0), i64::from(lower.y1 - lower.y0)),
        None => (0, 0),
    };
    for index in 0..columns * rows {
        let mut block_x0: i64 = (x0 >> band.code_block_width_log2) << band.code_block_width_log2;
        block_x0 += (index % columns) << band.code_block_width_log2;
        let mut block_y0: i64 = (y0 >> band.code_block_height_log2) << band.code_block_height_log2;
        block_y0 += (index / columns) << band.code_block_height_log2;
        let mut code_block: CodeBlock = CodeBlock {
            x0: block_x0.max(x0) as i32,
            y0: block_y0.max(y0) as i32,
            x1: (block_x0 + (1i64 << band.code_block_width_log2)).min(x1) as i32,
            y1: (block_y0 + (1i64 << band.code_block_height_log2)).min(y1) as i32,
            length_exponent: INITIAL_LENGTH_EXPONENT,
            ..CodeBlock::default()
        };
        if position & 1 != 0 {
            code_block.x0 += width_offset as i32;
            code_block.x1 += width_offset as i32;
        }
        if position & 2 != 0 {
            code_block.y0 += height_offset as i32;
            code_block.y1 += height_offset as i32;
        }
        precinct.code_blocks.push(code_block);
    }
    Ok(precinct)
}

/// FFmpeg's ff_jpeg2000_init_component: a tile-component's resolution levels, bands with their step sizes, precincts, and code blocks.
fn initialize_component(component: &mut TileComponent, coding: &CodingStyle, quantization: &QuantizationStyle, component_bits: u8, budget: &mut GeometryBudget) -> DecodeResult<()> {
    if coding.resolution_levels == 0 {
        return fail(ERROR_CODING_STYLE, 0);
    }
    if coding.wavelet > COD_IRREVERSIBLE_INTEGER {
        return fail(ERROR_CODING_STYLE, u32::from(coding.wavelet));
    }
    if coding.code_block_style >= CODE_BLOCK_STYLE_HIGH_THROUGHPUT {
        return fail(ERROR_UNSUPPORTED_FEATURE, u32::from(coding.code_block_style));
    }
    check_component_size(i64::from(component.width()), i64::from(component.height()))?;
    let resolution_levels: usize = usize::from(coding.resolution_levels);
    let mut global_band: usize = 0;
    for level_index in 0..resolution_levels {
        // A level is laid out even without precincts, so it costs the parse a step too
        budget.spend(1)?;
        let decomposition: u32 = (resolution_levels - level_index) as u32;
        let mut level: ResolutionLevel = ResolutionLevel {
            x0: ceil_divide_power(i64::from(component.x0), decomposition - 1) as i32,
            x1: ceil_divide_power(i64::from(component.x1), decomposition - 1) as i32,
            y0: ceil_divide_power(i64::from(component.y0), decomposition - 1) as i32,
            y1: ceil_divide_power(i64::from(component.y1), decomposition - 1) as i32,
            precinct_width_log2: coding.precinct_width_log2[level_index],
            precinct_height_log2: coding.precinct_height_log2[level_index],
            ..ResolutionLevel::default()
        };
        level.precinct_columns = if level.x1 == level.x0 {
            0
        } else {
            (ceil_divide_power(i64::from(level.x1), u32::from(level.precinct_width_log2)) - (i64::from(level.x0) >> level.precinct_width_log2)) as i32
        };
        level.precinct_rows = if level.y1 == level.y0 {
            0
        } else {
            (ceil_divide_power(i64::from(level.y1), u32::from(level.precinct_height_log2)) - (i64::from(level.y0) >> level.precinct_height_log2)) as i32
        };
        let band_count: usize = if level_index == 0 { 1 } else { 3 };
        let precinct_count: i64 = i64::from(level.precinct_columns) * i64::from(level.precinct_rows);
        if precinct_count < 0 || (precinct_count as u64).saturating_mul(band_count as u64) > MAXIMUM_PRECINCTS {
            return fail(ERROR_RESOURCE_LIMIT, PRECINCT_COUNT_LIMIT);
        }
        budget.spend(precinct_count as u64 * band_count as u64)?;
        for band_index in 0..band_count {
            let step: BandStep = band_step(quantization, coding.wavelet, coding.resolution_levels, band_index, global_band, level_index, component_bits);
            let mut band: Band = Band { step, ..Band::default() };
            let (precinct_width_log2, precinct_height_log2): (u32, u32);
            if level_index == 0 {
                band.x0 = ceil_divide_power(i64::from(component.x0), decomposition - 1) as i32;
                band.x1 = ceil_divide_power(i64::from(component.x1), decomposition - 1) as i32;
                band.y0 = ceil_divide_power(i64::from(component.y0), decomposition - 1) as i32;
                band.y1 = ceil_divide_power(i64::from(component.y1), decomposition - 1) as i32;
                precinct_width_log2 = u32::from(level.precinct_width_log2);
                precinct_height_log2 = u32::from(level.precinct_height_log2);
                band.code_block_width_log2 = u32::from(coding.code_block_width_log2.min(level.precinct_width_log2));
                band.code_block_height_log2 = u32::from(coding.code_block_height_log2.min(level.precinct_height_log2));
            } else {
                let offset_x: i64 = (((band_index + 1) & 1) as i64) << (decomposition - 1);
                let offset_y: i64 = ((((band_index + 1) >> 1) & 1) as i64) << (decomposition - 1);
                band.x0 = ceil_divide_power(i64::from(component.x0) - offset_x, decomposition) as i32;
                band.x1 = ceil_divide_power(i64::from(component.x1) - offset_x, decomposition) as i32;
                band.y0 = ceil_divide_power(i64::from(component.y0) - offset_y, decomposition) as i32;
                band.y1 = ceil_divide_power(i64::from(component.y1) - offset_y, decomposition) as i32;
                // FFmpeg's uint8 arithmetic keeps a band's precinct exponent one below its level's
                precinct_width_log2 = u32::from(level.precinct_width_log2.wrapping_sub(1));
                precinct_height_log2 = u32::from(level.precinct_height_log2.wrapping_sub(1));
                band.code_block_width_log2 = u32::from(coding.code_block_width_log2).min(precinct_width_log2);
                band.code_block_height_log2 = u32::from(coding.code_block_height_log2).min(precinct_height_log2);
            }
            for precinct_index in 0..precinct_count as i32 {
                let lower_level: Option<&ResolutionLevel> = if level_index > 0 { component.levels.get(level_index - 1) } else { None };
                let position: usize = band_index + usize::from(level_index > 0);
                let precinct: Precinct = initialize_precinct(&band, &level, lower_level, precinct_index, position, precinct_width_log2, precinct_height_log2, budget)?;
                band.precincts.push(precinct);
            }
            level.bands.push(band);
            global_band += 1;
        }
        component.levels.push(level);
    }
    Ok(())
}

/// FFmpeg's init_tile: a tile's coordinates, clipped to the image, and each component's geometry, which spends the parse's remaining work.
pub fn initialize_tile(size: &ImageSize, header: Option<&TileHeader>, main_region_shift: &[u8; MAXIMUM_COMPONENTS], tile_index: usize, remaining_work: &mut u64) -> DecodeResult<Tile> {
    let Some(header) = header else {
        return fail(ERROR_TILE_MISSING, tile_index as u32);
    };
    let tile_column: i64 = (tile_index % size.tile_columns as usize) as i64;
    let tile_row: i64 = (tile_index / size.tile_columns as usize) as i64;
    let clip_x = |value: i64| value.clamp(i64::from(size.image_offset_x), i64::from(size.width)) as i32;
    let clip_y = |value: i64| value.clamp(i64::from(size.image_offset_y), i64::from(size.height)) as i32;
    let mut tile: Tile = Tile {
        x0: clip_x(tile_column * i64::from(size.tile_width) + i64::from(size.tile_offset_x)),
        x1: clip_x((tile_column + 1) * i64::from(size.tile_width) + i64::from(size.tile_offset_x)),
        y0: clip_y(tile_row * i64::from(size.tile_height) + i64::from(size.tile_offset_y)),
        y1: clip_y((tile_row + 1) * i64::from(size.tile_height) + i64::from(size.tile_offset_y)),
        components: Vec::with_capacity(size.component_count),
    };
    let mut budget: GeometryBudget = GeometryBudget { remaining_objects: MAXIMUM_TILE_GEOMETRY_OBJECTS, remaining_work };
    for component_index in 0..size.component_count {
        let divisor_x: i64 = i64::from(size.subsampling_x[component_index]);
        let divisor_y: i64 = i64::from(size.subsampling_y[component_index]);
        let mut component: TileComponent = TileComponent {
            x0: ceil_divide(i64::from(tile.x0), divisor_x) as i32,
            x1: ceil_divide(i64::from(tile.x1), divisor_x) as i32,
            y0: ceil_divide(i64::from(tile.y0), divisor_y) as i32,
            y1: ceil_divide(i64::from(tile.y1), divisor_y) as i32,
            region_shift: header.region_shift[component_index],
            levels: Vec::new(),
        };
        if component.region_shift == 0 {
            component.region_shift = main_region_shift[component_index];
        }
        let coding: &CodingStyle = &header.coding[component_index];
        if !coding.initialized {
            return fail(ERROR_TILE_MISSING, tile_index as u32);
        }
        initialize_component(&mut component, coding, &header.quantization[component_index], size.component_bits[component_index], &mut budget)?;
        tile.components.push(component);
    }
    Ok(tile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn divides_rounding_up_as_ffmpeg_does() {
        assert_eq!(ceil_divide_power(5, 1), 3);
        assert_eq!(ceil_divide_power(-5, 1), -2);
        assert_eq!(ceil_divide(7, 2), 4);
    }

    #[test]
    fn decodes_a_tag_tree_to_its_leaf_values() {
        // A 2x1 tree with leaf values 1 and 2 under a root of 1: the root takes bits 0 1, leaf 0 bit 1, then leaf 1 bits 0 1
        let mut tree: TagTree = TagTree::new(2, 1);
        let bits: [u32; 5] = [0, 1, 1, 0, 1];
        let mut position: usize = 0;
        let mut next = || {
            position += 1;
            bits[position - 1]
        };
        assert_eq!(tree.decode(0, 100, &mut next), 1);
        assert_eq!(tree.decode(1, 100, &mut next), 2);
    }

    // A one-level tile of one component, each code block a single sample, and the precinct exponent FFmpeg defaults to
    const SINGLE_SAMPLE_EXPONENT: u8 = 0;
    const DEFAULT_PRECINCT_EXPONENT: u8 = 15;
    const SMALL_SIDE: i32 = 64;
    // 2048 x 2048 single-sample code blocks reach the tile's bound, before its precinct and level
    const OVERSIZED_SIDE: i32 = 2048;
    const NO_REGION_SHIFT: [u8; MAXIMUM_COMPONENTS] = [0; MAXIMUM_COMPONENTS];
    const SCARCE_WORK: u64 = 100;
    // A level, its one precinct, and a code block per sample
    const SMALL_TILE_OBJECTS: u64 = 2 + (SMALL_SIDE * SMALL_SIDE) as u64;

    fn single_sample_tile(side: i32) -> (ImageSize, TileHeader) {
        let size: ImageSize = ImageSize {
            width: side,
            height: side,
            tile_width: side,
            tile_height: side,
            tile_columns: 1,
            tile_rows: 1,
            component_count: 1,
            component_bits: [8; MAXIMUM_COMPONENTS],
            subsampling_x: [1; MAXIMUM_COMPONENTS],
            subsampling_y: [1; MAXIMUM_COMPONENTS],
            ..ImageSize::default()
        };
        let mut header: TileHeader = TileHeader::default();
        header.coding[0] = CodingStyle {
            resolution_levels: 1,
            code_block_width_log2: SINGLE_SAMPLE_EXPONENT,
            code_block_height_log2: SINGLE_SAMPLE_EXPONENT,
            wavelet: crate::codestream::COD_REVERSIBLE,
            layers: 1,
            precinct_width_log2: [DEFAULT_PRECINCT_EXPONENT; crate::codestream::MAXIMUM_RESOLUTION_LEVELS],
            precinct_height_log2: [DEFAULT_PRECINCT_EXPONENT; crate::codestream::MAXIMUM_RESOLUTION_LEVELS],
            initialized: true,
            ..CodingStyle::default()
        };
        (size, header)
    }

    #[test]
    fn spends_the_parse_work_on_each_level_precinct_and_code_block() {
        let (size, header) = single_sample_tile(SMALL_SIDE);
        let mut remaining_work: u64 = MAXIMUM_PARSE_WORK;

        let tile: Tile = initialize_tile(&size, Some(&header), &NO_REGION_SHIFT, 0, &mut remaining_work).expect("a tile");

        assert_eq!(tile.components[0].levels[0].bands[0].precincts[0].code_blocks.len(), (SMALL_SIDE * SMALL_SIDE) as usize);
        assert_eq!(MAXIMUM_PARSE_WORK - remaining_work, SMALL_TILE_OBJECTS);
    }

    #[test]
    fn refuses_a_tile_past_its_geometry_or_the_parse_past_its_work_before_laying_it_out() {
        let (oversized_size, oversized_header) = single_sample_tile(OVERSIZED_SIDE);
        let (small_size, small_header) = single_sample_tile(SMALL_SIDE);
        let mut ample_work: u64 = MAXIMUM_PARSE_WORK;
        let mut scarce_work: u64 = SCARCE_WORK;

        let oversized = initialize_tile(&oversized_size, Some(&oversized_header), &NO_REGION_SHIFT, 0, &mut ample_work);
        let starved = initialize_tile(&small_size, Some(&small_header), &NO_REGION_SHIFT, 0, &mut scarce_work);

        assert_eq!(oversized.err(), Some(crate::error::DecodeError { code: ERROR_RESOURCE_LIMIT, value: GEOMETRY_OBJECT_LIMIT }));
        assert_eq!(starved.err(), Some(crate::error::DecodeError { code: ERROR_RESOURCE_LIMIT, value: PARSE_WORK_LIMIT }));
    }

    #[test]
    fn stops_a_tag_tree_at_its_threshold() {
        let mut tree: TagTree = TagTree::new(1, 1);
        assert_eq!(tree.decode(0, 1, || 0), 1);
        assert_eq!(tree.decode(0, 3, || 1), 1);
    }
}
