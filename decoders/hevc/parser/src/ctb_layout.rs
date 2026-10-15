// CTB address tables (6.5.1) and z-scan availability (6.4.1) of a picture's active SPS and PPS.

use crate::plan::PictureParameters;

/// CtbAddrRsToTs, CtbAddrTsToRs, and TileId of a picture's CTB grid, with the tile boundaries in CTBs.
#[derive(Default)]
pub struct CTBLayout {
    /// The tables' generation; no plan has generation zero, so the first one always builds
    pub generation: u32,
    pub width_in_ctbs: u32,
    pub height_in_ctbs: u32,
    pub rs_to_ts: Vec<u32>,
    pub ts_to_rs: Vec<u32>,
    /// The raster tile index of each CTB, by tile scan address
    pub tile_id: Vec<u32>,
    ctb_log2: u32,
    min_tb_log2: u32,
    width: u32,
    height: u32,
}

impl CTBLayout {
    /// Rebuilds the tables when the picture's parameters carry another generation of them.
    pub fn update(&mut self, parameters: &PictureParameters) {
        if self.generation == parameters.tables_generation {
            return;
        }
        self.generation = parameters.tables_generation;
        self.width_in_ctbs = parameters.ctb_width;
        self.height_in_ctbs = parameters.ctb_height;
        self.ctb_log2 = parameters.ctb_log2;
        self.min_tb_log2 = parameters.min_tb_log2;
        self.width = parameters.width;
        self.height = parameters.height;
        let ctb_count: usize = (parameters.ctb_width * parameters.ctb_height) as usize;
        self.rs_to_ts.clear();
        self.rs_to_ts.resize(ctb_count, 0);
        self.ts_to_rs.clear();
        self.ts_to_rs.resize(ctb_count, 0);
        self.tile_id.clear();
        self.tile_id.resize(ctb_count, 0);
        let mut ctb_address_ts: usize = 0;
        let mut tile: u32 = 0;
        for row in 0..parameters.tile_rows as usize {
            for column in 0..parameters.tile_columns as usize {
                for y in parameters.row_boundaries[row]..parameters.row_boundaries[row + 1] {
                    for x in parameters.column_boundaries[column]..parameters.column_boundaries[column + 1] {
                        let ctb_address_rs: usize = (y * parameters.ctb_width + x) as usize;
                        self.rs_to_ts[ctb_address_rs] = ctb_address_ts as u32;
                        self.ts_to_rs[ctb_address_ts] = ctb_address_rs as u32;
                        self.tile_id[ctb_address_ts] = tile;
                        ctb_address_ts += 1;
                    }
                }
                tile += 1;
            }
        }
    }

    pub fn ctb_address_of(&self, x: u32, y: u32) -> u32 {
        (y >> self.ctb_log2) * self.width_in_ctbs + (x >> self.ctb_log2)
    }

    /// MinTbAddrZs of a luma position inside the picture (6.5.2).
    pub fn min_tb_address_zs(&self, x: u32, y: u32) -> u32 {
        let shift: u32 = self.ctb_log2 - self.min_tb_log2;
        let mask: u32 = (1 << shift) - 1;
        let ctb_address_ts: u32 = self.rs_to_ts[self.ctb_address_of(x, y) as usize];
        (ctb_address_ts << (2 * shift)) | interleave_bits((x >> self.min_tb_log2) & mask, (y >> self.min_tb_log2) & mask, shift)
    }

    /// Availability (6.4.1) while slices decode: a neighbour is available when it is inside the picture, precedes the current
    /// position in z-scan order, belongs to the current slice (its CTB follows the slice start in tile scan), and shares the tile.
    pub fn is_available_in_slice(&self, current_x: u32, current_y: u32, neighbour_x: i32, neighbour_y: i32, slice_address_ts: u32) -> bool {
        if neighbour_x < 0 || neighbour_y < 0 || neighbour_x as u32 >= self.width || neighbour_y as u32 >= self.height {
            return false;
        }
        let x: u32 = neighbour_x as u32;
        let y: u32 = neighbour_y as u32;
        if self.min_tb_address_zs(x, y) > self.min_tb_address_zs(current_x, current_y) {
            return false;
        }
        let neighbour_ts: u32 = self.rs_to_ts[self.ctb_address_of(x, y) as usize];
        if neighbour_ts < slice_address_ts {
            return false;
        }
        let current_ts: u32 = self.rs_to_ts[self.ctb_address_of(current_x, current_y) as usize];
        self.tile_id[neighbour_ts as usize] == self.tile_id[current_ts as usize]
    }
}

/// Interleaves the low bits of x and y, x in the even bits, as z-scan order does.
pub fn interleave_bits(x: u32, y: u32, bit_count: u32) -> u32 {
    let mut result: u32 = 0;
    for bit in 0..bit_count {
        result |= ((x >> bit) & 1) << (2 * bit);
        result |= ((y >> bit) & 1) << (2 * bit + 1);
    }
    result
}
