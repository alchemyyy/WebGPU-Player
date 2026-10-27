// The state FFmpeg's MpegEncContext keeps for the mpeg4, h263, and msmpeg4 decoders, with FFmpeg's names and table layouts, so the codec
// modules read as ports of their FFmpeg sources: the picture's geometry and parameters, the per-macroblock tables, the predictors, and the
// macroblock being decoded.
// Each picture parses from fresh tables, as FFmpeg's would read them: motion vectors and the skip table are zeroed for every picture,
// and a DC or AC predictor is read only after the picture wrote it or cleaned it, since every macroblock either writes its intra
// predictors or cleans them (ff_h263_clean_intra_table_entries) before a later macroblock reads them.

use crate::tables::{DEFAULT_CHROMA_QSCALE_TABLE, MPEG12_DC_SCALE_TABLE, ZIGZAG_DIRECT};

// FFmpeg's mb_type flags, mpegutils.h
pub const MB_TYPE_INTRA4X4: u32 = 1 << 0;
pub const MB_TYPE_16X16: u32 = 1 << 3;
pub const MB_TYPE_16X8: u32 = 1 << 4;
pub const MB_TYPE_8X8: u32 = 1 << 6;
pub const MB_TYPE_INTERLACED: u32 = 1 << 7;
pub const MB_TYPE_DIRECT2: u32 = 1 << 8;
pub const MB_TYPE_CBP: u32 = 1 << 10;
pub const MB_TYPE_QUANT: u32 = 1 << 11;
pub const MB_TYPE_FORWARD_MV: u32 = 1 << 12;
pub const MB_TYPE_BACKWARD_MV: u32 = 1 << 13;
pub const MB_TYPE_BIDIR_MV: u32 = MB_TYPE_FORWARD_MV | MB_TYPE_BACKWARD_MV;
pub const MB_TYPE_GMC: u32 = 1 << 16;
pub const MB_TYPE_SKIP: u32 = 1 << 17;
pub const MB_TYPE_ACPRED: u32 = 1 << 18;
pub const MB_TYPE_INTRA: u32 = MB_TYPE_INTRA4X4;

pub const fn is_intra(mb_type: u32) -> bool {
    mb_type & 7 != 0
}
pub const fn is_skip(mb_type: u32) -> bool {
    mb_type & MB_TYPE_SKIP != 0
}
pub const fn is_direct(mb_type: u32) -> bool {
    mb_type & MB_TYPE_DIRECT2 != 0
}
pub const fn is_8x8(mb_type: u32) -> bool {
    mb_type & MB_TYPE_8X8 != 0
}
pub const fn is_interlaced(mb_type: u32) -> bool {
    mb_type & MB_TYPE_INTERLACED != 0
}
pub const fn is_acpred(mb_type: u32) -> bool {
    mb_type & MB_TYPE_ACPRED != 0
}
pub const fn has_forward_mv(mb_type: u32) -> bool {
    mb_type & MB_TYPE_FORWARD_MV != 0
}
pub const fn has_backward_mv(mb_type: u32) -> bool {
    mb_type & MB_TYPE_BACKWARD_MV != 0
}

pub const MV_DIR_FORWARD: i32 = 1;
pub const MV_DIR_BACKWARD: i32 = 2;
pub const MV_DIRECT: i32 = 4;
pub const MV_TYPE_16X16: i32 = 0;
pub const MV_TYPE_8X8: i32 = 1;
pub const MV_TYPE_FIELD: i32 = 3;

// FFmpeg's workaround_bugs flags, avcodec.h; FF_BUG_AUTODETECT is always on
pub const FF_BUG_AUTODETECT: u32 = 1;
pub const FF_BUG_XVID_ILACE: u32 = 4;
pub const FF_BUG_UMP4: u32 = 8;
pub const FF_BUG_AMV: u32 = 32;
pub const FF_BUG_QPEL_CHROMA: u32 = 64;
pub const FF_BUG_STD_QPEL: u32 = 128;
pub const FF_BUG_QPEL_CHROMA2: u32 = 256;
pub const FF_BUG_DIRECT_BLOCKSIZE: u32 = 512;
pub const FF_BUG_EDGE: u32 = 1024;
pub const FF_BUG_HPEL_CHROMA: u32 = 2048;
pub const FF_BUG_DC_CLIP: u32 = 4096;
pub const FF_BUG_IEDGE: u32 = 32768;

/// FFmpeg's AVPictureType of the pictures these codecs code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PictType {
    #[default]
    I,
    P,
    B,
    /// MPEG-4's S(GMC)-VOP, a P picture with global motion compensation
    S,
}

impl PictType {
    /// The 1-based number FFmpeg's AVPictureType gives the type, which some syntax reads: I 1, P 2, B 3, S 4.
    pub fn number(self) -> i32 {
        match self {
            PictType::I => 1,
            PictType::P => 2,
            PictType::B => 3,
            PictType::S => 4,
        }
    }
}

/// The dequantization ff_mpv_reconstruct_mb applies: s->dct_unquantize_intra and s->dct_unquantize_inter.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Unquantize {
    /// No dequantization: the block decoder dequantized already (dct_unquantize_inter NULL)
    #[default]
    None,
    H263,
    /// MPEG-2's, which MPEG-4's MPEG quantization takes; intra blocks take FFmpeg's bit-exact form with mismatch control
    Mpeg2,
}

/// The codec a picture belongs to, as FFmpeg's codec_id and msmpeg4_version tell its decoders apart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Codec {
    #[default]
    Mpeg4,
    H263,
    MsMpeg4V1,
    MsMpeg4V2,
    MsMpeg4V3,
}

impl Codec {
    pub fn is_msmpeg4(self) -> bool {
        matches!(self, Codec::MsMpeg4V1 | Codec::MsMpeg4V2 | Codec::MsMpeg4V3)
    }
}

/// A scan table and FFmpeg's raster_end of it, under the identity permutation of FFmpeg's C IDCTs.
#[derive(Clone, Copy)]
pub struct ScanTable {
    pub permutated: [u8; 64],
    pub raster_end: [u8; 64],
}

impl ScanTable {
    /// ff_init_scantable with the identity permutation.
    pub fn new(scan: &[u8; 64]) -> Self {
        let mut raster_end: [u8; 64] = [0; 64];
        let mut end: u8 = 0;
        for (index, &position) in scan.iter().enumerate() {
            end = end.max(position);
            raster_end[index] = end;
        }
        Self { permutated: *scan, raster_end }
    }
}

impl Default for ScanTable {
    fn default() -> Self {
        Self::new(&ZIGZAG_DIRECT)
    }
}

/// A macroblock as ff_mpv_reconstruct_mb received it: the IDCT inputs of its blocks, and what predicts it. The motion operations are
/// made once the picture parsed, since OBMC reads its neighbors' vectors.
#[derive(Clone, Debug, Default)]
pub struct MacroblockRecord {
    pub mb_x: i32,
    pub mb_y: i32,
    pub mb_intra: bool,
    pub interlaced_dct: bool,
    pub mv_dir: i32,
    pub mv_type: i32,
    pub mcsel: bool,
    pub mv: [[[i32; 2]; 4]; 2],
    pub field_select: [[i32; 2]; 2],
    /// Bit n: block n has a residual, as put_dct runs for every intra block and add_dct for an inter block with block_last_index >= 0
    pub residual_blocks: u32,
    /// The nonzero IDCT inputs of the blocks with a residual: block, raster position, and value
    pub entries: Vec<(u8, u8, i16)>,
    /// The right neighbor's two vectors H.263's apply_obmc reads when the macroblock reconstructs (preview_obmc's, or the zeros of a
    /// neighbor not decoded yet); None where it reads the macroblock's own: the last column, an intra neighbor, or no OBMC
    pub obmc_right: Option<[[i16; 2]; 2]>,
}

/// The decoder state of one picture.
pub struct Mpv {
    pub codec: Codec,
    pub h263_pred: bool,
    pub h263_aic: bool,
    // Geometry
    pub mb_width: i32,
    pub mb_height: i32,
    pub mb_stride: i32,
    pub b8_stride: i32,
    pub mb_num: i32,
    pub h_edge_pos: i32,
    pub v_edge_pos: i32,
    // Picture parameters
    pub pict_type: PictType,
    pub qscale: i32,
    pub chroma_qscale: i32,
    pub y_dc_scale: i32,
    pub c_dc_scale: i32,
    pub y_dc_scale_table: &'static [u8; 32],
    pub c_dc_scale_table: &'static [u8; 32],
    pub chroma_qscale_table: &'static [u8; 32],
    pub no_rounding: bool,
    pub quarter_sample: bool,
    pub progressive_sequence: bool,
    pub alternate_scan: bool,
    pub top_field_first: bool,
    pub low_delay: bool,
    pub obmc: bool,
    pub workaround_bugs: u32,
    pub dct_unquantize_intra: Unquantize,
    pub dct_unquantize_inter: Unquantize,
    pub intra_scantable: ScanTable,
    pub inter_scantable: ScanTable,
    pub intra_matrix: [u16; 64],
    pub inter_matrix: [u16; 64],
    // Position
    pub mb_x: i32,
    pub mb_y: i32,
    pub resync_mb_x: i32,
    pub resync_mb_y: i32,
    pub first_slice_line: bool,
    pub block_index: [i32; 6],
    pub block_wrap: [i32; 6],
    // Per-macroblock tables, indexed as FFmpeg indexes them
    pub mb_type: Vec<u32>,
    pub qscale_table: Vec<i8>,
    pub mbskip_table: Vec<u8>,
    pub mbintra_table: Vec<u8>,
    pub cbp_table: Vec<u8>,
    pub pred_dir_table: Vec<u8>,
    motion_val: [Vec<[i16; 2]>; 2],
    motion_val_base: i32,
    p_field_mv_table: [[Vec<[i16; 2]>; 2]; 2],
    p_field_mv_base: i32,
    pub ref_index: [Vec<i8>; 2],
    dc_val: Vec<i16>,
    ac_val: Vec<[i16; 16]>,
    dc_val_base: i32,
    // The macroblock being decoded
    pub mb_intra: bool,
    pub mb_skipped: bool,
    pub mv_dir: i32,
    pub mv_type: i32,
    pub mv: [[[i32; 2]; 4]; 2],
    pub field_select: [[i32; 2]; 2],
    pub last_mv: [[[i32; 2]; 2]; 2],
    pub interlaced_dct: bool,
    pub mcsel: bool,
    pub ac_pred: bool,
    pub block: [[i16; 64]; 6],
    pub block_last_index: [i32; 6],
    /// The macroblocks reconstruct_mb received, in decode order
    pub records: Vec<MacroblockRecord>,
}

// Entries before the first a table's FFmpeg base offset addresses, which reads at FFmpeg's negative indexes reach
const TABLE_MARGIN: i32 = 8;

impl Mpv {
    /// FFmpeg's ff_mpv_init_context_frame for a picture of width x height, with every table in its initial state.
    pub fn new(codec: Codec, width: i32, height: i32) -> Self {
        let mb_width: i32 = (width + 15) / 16;
        let mb_height: i32 = (height + 15) / 16;
        let mb_stride: i32 = mb_width + 1;
        let b8_stride: i32 = mb_width * 2 + 1;
        let mb_array_size: usize = (mb_height * mb_stride) as usize;
        let mv_table_size: i32 = (mb_height + 2) * mb_stride + 1;
        let b8_array_size: i32 = b8_stride * mb_height * 2;
        let y_size: i32 = b8_stride * (2 * mb_height + 1);
        let c_size: i32 = mb_stride * (mb_height + 1);
        let yc_size: i32 = y_size + 2 * c_size;
        let motion_val_base: i32 = b8_stride + TABLE_MARGIN;
        let motion_val_size: usize = (motion_val_base + b8_array_size + TABLE_MARGIN) as usize;
        let p_field_mv_base: i32 = mb_stride + 1 + TABLE_MARGIN;
        let p_field_mv_size: usize = (p_field_mv_base + mv_table_size + TABLE_MARGIN) as usize;
        let dc_val_base: i32 = b8_stride + 1;
        let new_field_table = || -> [Vec<[i16; 2]>; 2] { [vec![[0; 2]; p_field_mv_size], vec![[0; 2]; p_field_mv_size]] };
        Self {
            codec,
            h263_pred: false,
            h263_aic: false,
            mb_width,
            mb_height,
            mb_stride,
            b8_stride,
            mb_num: mb_width * mb_height,
            h_edge_pos: mb_width * 16,
            v_edge_pos: mb_height * 16,
            pict_type: PictType::I,
            qscale: 1,
            chroma_qscale: 1,
            y_dc_scale: 8,
            c_dc_scale: 8,
            y_dc_scale_table: &MPEG12_DC_SCALE_TABLE[0],
            c_dc_scale_table: &MPEG12_DC_SCALE_TABLE[0],
            chroma_qscale_table: &DEFAULT_CHROMA_QSCALE_TABLE,
            no_rounding: false,
            quarter_sample: false,
            progressive_sequence: true,
            alternate_scan: false,
            top_field_first: false,
            low_delay: true,
            obmc: false,
            workaround_bugs: FF_BUG_AUTODETECT,
            dct_unquantize_intra: Unquantize::H263,
            dct_unquantize_inter: Unquantize::H263,
            intra_scantable: ScanTable::default(),
            inter_scantable: ScanTable::default(),
            intra_matrix: [0; 64],
            inter_matrix: [0; 64],
            mb_x: 0,
            mb_y: 0,
            resync_mb_x: 0,
            resync_mb_y: 0,
            first_slice_line: true,
            block_index: [0; 6],
            block_wrap: [b8_stride, b8_stride, b8_stride, b8_stride, mb_stride, mb_stride],
            mb_type: vec![0; mv_table_size as usize],
            qscale_table: vec![0; mv_table_size as usize],
            // The + 2 is FFmpeg's, for the slice end check that reads past the last macroblock
            mbskip_table: vec![0; mb_array_size + 2],
            mbintra_table: vec![0; mb_array_size],
            cbp_table: vec![0; mb_array_size + 2],
            pred_dir_table: vec![0; mb_array_size],
            motion_val: [vec![[0; 2]; motion_val_size], vec![[0; 2]; motion_val_size]],
            motion_val_base,
            p_field_mv_table: [new_field_table(), new_field_table()],
            p_field_mv_base,
            ref_index: [vec![0; 4 * mb_array_size], vec![0; 4 * mb_array_size]],
            dc_val: vec![1024; yc_size as usize],
            ac_val: vec![[0; 16]; yc_size as usize],
            dc_val_base,
            mb_intra: false,
            mb_skipped: false,
            mv_dir: MV_DIR_FORWARD,
            mv_type: MV_TYPE_16X16,
            mv: [[[0; 2]; 4]; 2],
            field_select: [[0; 2]; 2],
            last_mv: [[[0; 2]; 2]; 2],
            interlaced_dct: false,
            mcsel: false,
            ac_pred: false,
            block: [[0; 64]; 6],
            block_last_index: [-1; 6],
            records: Vec::new(),
        }
    }

    // Table accessors at FFmpeg's indexes

    /// cur_pic.motion_val[dir][index], at FFmpeg's index into the b8 grid; an index FFmpeg's guards never reach past the margin reads
    /// a scratch entry.
    pub fn motion_val(&mut self, dir: usize, index: i32) -> &mut [i16; 2] {
        let position: i32 = self.motion_val_base + index;
        let table: &mut Vec<[i16; 2]> = &mut self.motion_val[dir];
        let clamped: usize = position.clamp(0, table.len() as i32 - 1) as usize;
        &mut table[clamped]
    }

    pub fn get_motion_val(&self, dir: usize, index: i32) -> [i16; 2] {
        let position: i32 = self.motion_val_base + index;
        let table: &Vec<[i16; 2]> = &self.motion_val[dir];
        if position < 0 || position >= table.len() as i32 {
            return [0; 2];
        }
        table[position as usize]
    }

    /// p_field_mv_table[field][dir][mb_xy]
    pub fn p_field_mv(&mut self, field: usize, dir: usize, mb_xy: i32) -> &mut [i16; 2] {
        let position: usize = (self.p_field_mv_base + mb_xy) as usize;
        &mut self.p_field_mv_table[field][dir][position]
    }

    pub fn get_p_field_mv(&self, field: usize, dir: usize, mb_xy: i32) -> [i16; 2] {
        self.p_field_mv_table[field][dir][(self.p_field_mv_base + mb_xy) as usize]
    }

    /// dc_val[index], FFmpeg's s->dc_val at its offset into the luma, then Cb, then Cr grids.
    pub fn dc_val(&mut self, index: i32) -> &mut i16 {
        &mut self.dc_val[(self.dc_val_base + index) as usize]
    }

    pub fn get_dc_val(&self, index: i32) -> i16 {
        self.dc_val[(self.dc_val_base + index) as usize]
    }

    /// ac_val[index], the 16 AC predictors of a block: the left column's 7 from 1, the top row's 7 from 9.
    pub fn ac_val(&mut self, index: i32) -> &mut [i16; 16] {
        &mut self.ac_val[(self.dc_val_base + index) as usize]
    }

    pub fn get_ac_val(&self, index: i32) -> [i16; 16] {
        self.ac_val[(self.dc_val_base + index) as usize]
    }

    /// The macroblock index FFmpeg's tables use: mb_x + mb_y * mb_stride.
    pub fn mb_xy(&self) -> i32 {
        self.mb_x + self.mb_y * self.mb_stride
    }

    // FFmpeg's helpers

    /// ff_set_qscale.
    pub fn set_qscale(&mut self, qscale: i32) {
        let qscale: i32 = qscale.clamp(1, 31);
        self.qscale = qscale;
        self.chroma_qscale = i32::from(self.chroma_qscale_table[qscale as usize]);
        self.y_dc_scale = i32::from(self.y_dc_scale_table[qscale as usize]);
        self.c_dc_scale = i32::from(self.c_dc_scale_table[self.chroma_qscale as usize]);
    }

    /// ff_init_block_index, for the macroblock at mb_x - 1 of row mb_y, which ff_update_block_index then steps.
    pub fn init_block_index(&mut self) {
        let b8: i32 = self.b8_stride;
        let mb: i32 = self.mb_stride;
        self.block_index[0] = b8 * (self.mb_y * 2) - 2 + self.mb_x * 2;
        self.block_index[1] = b8 * (self.mb_y * 2) - 1 + self.mb_x * 2;
        self.block_index[2] = b8 * (self.mb_y * 2 + 1) - 2 + self.mb_x * 2;
        self.block_index[3] = b8 * (self.mb_y * 2 + 1) - 1 + self.mb_x * 2;
        self.block_index[4] = mb * (self.mb_y + 1) + b8 * self.mb_height * 2 + self.mb_x - 1;
        self.block_index[5] = mb * (self.mb_y + self.mb_height + 2) + b8 * self.mb_height * 2 + self.mb_x - 1;
    }

    /// ff_update_block_index.
    pub fn update_block_index(&mut self) {
        for index in &mut self.block_index[..4] {
            *index += 2;
        }
        self.block_index[4] += 1;
        self.block_index[5] += 1;
    }

    /// ff_clean_intra_table_entries.
    pub fn clean_intra_table_entries(&mut self) {
        let wrap: i32 = self.b8_stride;
        let xy: i32 = self.block_index[0];
        let uxy: i32 = self.block_index[4];
        let vxy: i32 = self.block_index[5];
        for index in [xy, xy + 1, xy + wrap, xy + 1 + wrap, uxy, vxy] {
            *self.dc_val(index) = 1024;
        }
        // The upper-left luma block is referenced only by blocks of its own macroblock, so FFmpeg leaves it
        for index in [xy + 1, xy + wrap, xy + wrap + 1, uxy, vxy] {
            *self.ac_val(index) = [0; 16];
        }
    }

    /// ff_h263_clean_intra_table_entries.
    pub fn h263_clean_intra_table_entries(&mut self, xy: i32) {
        if self.mbintra_table[xy as usize] != 0 {
            self.mbintra_table[xy as usize] = 0;
            self.clean_intra_table_entries();
        }
    }

    /// ff_mpeg4_clean_buffers, which MPEG-4, H.263 with prediction, and MS-MPEG4 v1 to v3 run at each resync.
    pub fn mpeg4_clean_buffers(&mut self) {
        let l_wrap: i32 = self.b8_stride;
        let l_xy: i32 = (2 * self.mb_y - 1) * l_wrap + self.mb_x * 2 - 1;
        let c_wrap: i32 = self.mb_stride;
        let u_xy: i32 = 2 * self.mb_height * l_wrap + self.mb_y * c_wrap + self.mb_x - 1;
        let v_xy: i32 = u_xy + c_wrap * (self.mb_height + 1);
        for index in l_xy..l_xy + l_wrap * 2 + 1 {
            *self.ac_val(index) = [0; 16];
        }
        for index in u_xy..=u_xy + c_wrap {
            *self.ac_val(index) = [0; 16];
        }
        for index in v_xy..=v_xy + c_wrap {
            *self.ac_val(index) = [0; 16];
        }
        self.last_mv[0][0] = [0; 2];
        self.last_mv[1][0] = [0; 2];
    }

    /// ff_h263_update_motion_val.
    pub fn h263_update_motion_val(&mut self) {
        let mb_xy: i32 = self.mb_xy();
        let wrap: i32 = self.b8_stride;
        let xy: i32 = self.block_index[0];
        if self.mv_type == MV_TYPE_8X8 {
            return;
        }
        let (motion_x, motion_y): (i32, i32) = if self.mb_intra {
            (0, 0)
        } else if self.mv_type == MV_TYPE_16X16 {
            (self.mv[0][0][0], self.mv[0][0][1])
        } else {
            let motion_x: i32 = self.mv[0][0][0] + self.mv[0][1][0];
            let motion_y: i32 = self.mv[0][0][1] + self.mv[0][1][1];
            for i in 0..2 {
                *self.p_field_mv(i, 0, mb_xy) = [self.mv[0][i][0] as i16, self.mv[0][i][1] as i16];
            }
            let base: usize = 4 * mb_xy as usize;
            self.ref_index[0][base] = self.field_select[0][0] as i8;
            self.ref_index[0][base + 1] = self.field_select[0][0] as i8;
            self.ref_index[0][base + 2] = self.field_select[0][1] as i8;
            self.ref_index[0][base + 3] = self.field_select[0][1] as i8;
            ((motion_x >> 1) | (motion_x & 1), motion_y)
        };
        let value: [i16; 2] = [motion_x as i16, motion_y as i16];
        for index in [xy, xy + 1, xy + wrap, xy + 1 + wrap] {
            *self.motion_val(0, index) = value;
        }
    }

    /// ff_h263_pred_motion: the median predictor of block's vector, and the block's motion_val index.
    pub fn h263_pred_motion(&mut self, block: usize, dir: usize) -> (i32, i32, i32) {
        const OFF: [i32; 4] = [2, 1, 1, -1];
        let wrap: i32 = self.b8_stride;
        let mot: i32 = self.block_index[block];
        let a: [i16; 2] = self.get_motion_val(dir, mot - 1);
        let (px, py): (i32, i32);
        if self.first_slice_line && block < 3 {
            if block == 0 {
                if self.mb_x == self.resync_mb_x {
                    px = 0;
                    py = 0;
                } else if self.mb_x + 1 == self.resync_mb_x && self.h263_pred {
                    let c: [i16; 2] = self.get_motion_val(dir, mot + OFF[block] - wrap);
                    if self.mb_x == 0 {
                        px = i32::from(c[0]);
                        py = i32::from(c[1]);
                    } else {
                        px = mid_pred(i32::from(a[0]), 0, i32::from(c[0]));
                        py = mid_pred(i32::from(a[1]), 0, i32::from(c[1]));
                    }
                } else {
                    px = i32::from(a[0]);
                    py = i32::from(a[1]);
                }
            } else if block == 1 {
                if self.mb_x + 1 == self.resync_mb_x && self.h263_pred {
                    let c: [i16; 2] = self.get_motion_val(dir, mot + OFF[block] - wrap);
                    px = mid_pred(i32::from(a[0]), 0, i32::from(c[0]));
                    py = mid_pred(i32::from(a[1]), 0, i32::from(c[1]));
                } else {
                    px = i32::from(a[0]);
                    py = i32::from(a[1]);
                }
            } else {
                let b: [i16; 2] = self.get_motion_val(dir, mot - wrap);
                let c: [i16; 2] = self.get_motion_val(dir, mot + OFF[block] - wrap);
                let mut a: [i16; 2] = a;
                if self.mb_x == self.resync_mb_x {
                    // FFmpeg zeroes the left neighbor's stored vector itself
                    *self.motion_val(dir, mot - 1) = [0; 2];
                    a = [0; 2];
                }
                px = mid_pred(i32::from(a[0]), i32::from(b[0]), i32::from(c[0]));
                py = mid_pred(i32::from(a[1]), i32::from(b[1]), i32::from(c[1]));
            }
        } else {
            let b: [i16; 2] = self.get_motion_val(dir, mot - wrap);
            let c: [i16; 2] = self.get_motion_val(dir, mot + OFF[block] - wrap);
            px = mid_pred(i32::from(a[0]), i32::from(b[0]), i32::from(c[0]));
            py = mid_pred(i32::from(a[1]), i32::from(b[1]), i32::from(c[1]));
        }
        (px, py, mot)
    }

    /// Clears the six blocks, FFmpeg's bdsp.clear_blocks(block[0]).
    pub fn clear_blocks(&mut self) {
        self.block = [[0; 64]; 6];
    }

    /// ff_mpv_reconstruct_mb, which keeps the macroblock's record instead of reconstructing it: it stores the quantizer, the skip
    /// table entry, and the IDCT inputs FFmpeg's put_dct, add_dequant_dct, and add_dct dequantize.
    pub fn reconstruct_mb(&mut self, reference: bool) {
        let mb_xy: i32 = self.mb_xy();
        self.qscale_table[mb_xy as usize] = self.qscale as i8;
        if self.mb_skipped {
            self.mb_skipped = false;
            self.mbskip_table[mb_xy as usize] = 1;
        } else if !reference {
            self.mbskip_table[mb_xy as usize] = 1;
        } else {
            self.mbskip_table[mb_xy as usize] = 0;
        }
        let mut record: MacroblockRecord = MacroblockRecord {
            mb_x: self.mb_x,
            mb_y: self.mb_y,
            mb_intra: self.mb_intra,
            interlaced_dct: self.interlaced_dct,
            mv_dir: self.mv_dir,
            mv_type: self.mv_type,
            mcsel: self.mcsel,
            mv: self.mv,
            field_select: self.field_select,
            residual_blocks: 0,
            entries: Vec::new(),
            obmc_right: if self.obmc
                && self.pict_type != PictType::B
                && !self.mb_intra
                && self.mb_x + 1 < self.mb_width
                && !is_intra(self.mb_type[(mb_xy + 1) as usize])
            {
                let mot_xy: i32 = self.mb_x * 2 + self.mb_y * 2 * self.b8_stride;
                Some([self.get_motion_val(0, mot_xy + 2), self.get_motion_val(0, mot_xy + 2 + self.b8_stride)])
            } else {
                None
            },
        };
        for n in 0..6 {
            let qscale: i32 = if n < 4 { self.qscale } else { self.chroma_qscale };
            if self.mb_intra {
                self.unquantize_intra(n, qscale);
            } else {
                if self.block_last_index[n] < 0 {
                    continue;
                }
                self.unquantize_inter(n, qscale);
            }
            record.residual_blocks |= 1 << n;
            for (position, &value) in self.block[n].iter().enumerate() {
                if value != 0 {
                    record.entries.push((n as u8, position as u8, value));
                }
            }
        }
        self.records.push(record);
    }

    fn unquantize_intra(&mut self, n: usize, qscale: i32) {
        match self.dct_unquantize_intra {
            Unquantize::None => {}
            Unquantize::H263 => self.dct_unquantize_h263_intra(n, qscale),
            Unquantize::Mpeg2 => self.dct_unquantize_mpeg2_intra_bitexact(n, qscale),
        }
    }

    fn unquantize_inter(&mut self, n: usize, qscale: i32) {
        match self.dct_unquantize_inter {
            Unquantize::None => {}
            Unquantize::H263 => self.dct_unquantize_h263_inter(n, qscale),
            Unquantize::Mpeg2 => self.dct_unquantize_mpeg2_inter(n, qscale),
        }
    }

    /// dct_unquantize_h263_intra_c.
    fn dct_unquantize_h263_intra(&mut self, n: usize, qscale: i32) {
        let qmul: i32 = qscale << 1;
        let qadd: i32;
        let dc_scale: i32 = if n < 4 { self.y_dc_scale } else { self.c_dc_scale };
        let block: &mut [i16; 64] = &mut self.block[n];
        if !self.h263_aic {
            block[0] = (i32::from(block[0]) * dc_scale) as i16;
            qadd = (qscale - 1) | 1;
        } else {
            qadd = 0;
        }
        let coefficients: usize = if self.ac_pred {
            63
        } else {
            let last: i32 = self.block_last_index[n];
            if last < 0 { 0 } else { usize::from(self.intra_scantable.raster_end[last as usize]) }
        };
        for value in &mut block[1..=coefficients] {
            let level: i32 = i32::from(*value);
            if level != 0 {
                *value = if level < 0 { (level * qmul - qadd) as i16 } else { (level * qmul + qadd) as i16 };
            }
        }
    }

    /// dct_unquantize_h263_inter_c.
    fn dct_unquantize_h263_inter(&mut self, n: usize, qscale: i32) {
        let qadd: i32 = (qscale - 1) | 1;
        let qmul: i32 = qscale << 1;
        let coefficients: usize = usize::from(self.inter_scantable.raster_end[self.block_last_index[n] as usize]);
        for value in &mut self.block[n][..=coefficients] {
            let level: i32 = i32::from(*value);
            if level != 0 {
                *value = if level < 0 { (level * qmul - qadd) as i16 } else { (level * qmul + qadd) as i16 };
            }
        }
    }

    /// dct_unquantize_mpeg2_intra_bitexact, the form FFmpeg's bit-exact decode takes, with MPEG-4's mismatch control.
    fn dct_unquantize_mpeg2_intra_bitexact(&mut self, n: usize, qscale: i32) {
        let qscale: i32 = qscale << 1;
        let dc_scale: i32 = if n < 4 { self.y_dc_scale } else { self.c_dc_scale };
        let last: i32 = self.block_last_index[n];
        let scan: [u8; 64] = self.intra_scantable.permutated;
        let block: &mut [i16; 64] = &mut self.block[n];
        block[0] = (i32::from(block[0]) * dc_scale) as i16;
        let mut sum: i32 = -1 + i32::from(block[0]);
        for i in 1..=last.max(0) as usize {
            let j: usize = usize::from(scan[i]);
            let level: i32 = i32::from(block[j]);
            if level != 0 {
                let magnitude: i32 = (level.abs() * qscale * i32::from(self.intra_matrix[j])) >> 4;
                let value: i32 = if level < 0 { -magnitude } else { magnitude };
                block[j] = value as i16;
                sum += value;
            }
        }
        block[63] ^= (sum & 1) as i16;
    }

    /// dct_unquantize_mpeg2_inter_c.
    fn dct_unquantize_mpeg2_inter(&mut self, n: usize, qscale: i32) {
        let qscale: i32 = qscale << 1;
        let last: i32 = self.block_last_index[n];
        let scan: [u8; 64] = self.intra_scantable.permutated;
        let block: &mut [i16; 64] = &mut self.block[n];
        let mut sum: i32 = -1;
        for i in 0..=last as usize {
            let j: usize = usize::from(scan[i]);
            let level: i32 = i32::from(block[j]);
            if level != 0 {
                let magnitude: i32 = (((level.abs() << 1) + 1) * qscale * i32::from(self.inter_matrix[j])) >> 5;
                let value: i32 = if level < 0 { -magnitude } else { magnitude };
                block[j] = value as i16;
                sum += value;
            }
        }
        block[63] ^= (sum & 1) as i16;
    }
}

/// FFmpeg's mid_pred, the median of three.
pub fn mid_pred(a: i32, b: i32, c: i32) -> i32 {
    if a > b {
        if c > b {
            if c > a { a } else { c }
        } else {
            b
        }
    } else if b > c {
        if c > a { c } else { a }
    } else {
        b
    }
}

/// FFmpeg's ROUNDED_DIV.
pub fn rounded_div(a: i32, b: i32) -> i32 {
    (if a >= 0 { a + (b >> 1) } else { a - (b >> 1) }) / b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_median_of_three() {
        assert_eq!(mid_pred(1, 2, 3), 2);
        assert_eq!(mid_pred(3, 1, 2), 2);
        assert_eq!(mid_pred(-4, 7, -4), -4);
    }

    #[test]
    fn indexes_blocks_as_ffmpeg_does() {
        let mut mpv: Mpv = Mpv::new(Codec::Mpeg4, 64, 32);
        mpv.mb_x = 0;
        mpv.mb_y = 1;
        mpv.init_block_index();
        mpv.update_block_index();
        // b8_stride is 9, mb_stride 5, mb_height 2
        assert_eq!(mpv.block_index, [18, 19, 27, 28, 2 * 5 + 9 * 4, 5 * 5 + 9 * 4]);
    }

    #[test]
    fn dequantizes_h263_intra_blocks_with_the_dc_scale() {
        let mut mpv: Mpv = Mpv::new(Codec::H263, 16, 16);
        mpv.set_qscale(5);
        mpv.block[0][0] = 10;
        mpv.block[0][1] = -2;
        mpv.block_last_index[0] = 1;
        mpv.mb_intra = true;
        mpv.block_last_index[1..].fill(-1);
        mpv.reconstruct_mb(true);
        let record: &MacroblockRecord = &mpv.records[0];
        assert_eq!(record.residual_blocks, 63);
        assert_eq!(record.entries, vec![(0, 0, 80), (0, 1, -25)]);
    }
}
