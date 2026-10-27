// FFmpeg's h263dec.c and the parts of ituh263dec.c the three codec families share: the decoder context H263DecContext adds to the
// MpegEncContext, the shared code tables, ff_h263_decode_motion, ff_h263_resync, and the slice loop of ff_h263_decode_frame, which
// decodes each macroblock and hands it to ff_mpv_reconstruct_mb.

use std::sync::LazyLock;

use crate::bitstream::BitReader;
use crate::error::{self, DecodeError, DecodeResult};
use crate::layout::{ERROR_BITS_EXHAUSTED, ERROR_MACROBLOCK_LAYER};
use crate::mpv::{MV_DIR_FORWARD, MV_TYPE_16X16, Mpv, PictType};
use crate::tables::{H263_CBPY_TAB, H263_INTER_MCBPC_BITS, H263_INTER_MCBPC_CODE, H263_INTRA_MCBPC_BITS, H263_INTRA_MCBPC_CODE, MVTAB};
use crate::vlc::{VLCLookup, lookup_from_columns, lookup_from_pairs};

/// FFmpeg's ff_h263_intra_MCBPC_vlc, ff_h263_inter_MCBPC_vlc, ff_h263_cbpy_vlc, and ff_h263_mv_vlc.
pub struct H263Lookups {
    pub intra_mcbpc: VLCLookup,
    pub inter_mcbpc: VLCLookup,
    pub cbpy: VLCLookup,
    pub mv: VLCLookup,
}

static LOOKUPS: LazyLock<H263Lookups> = LazyLock::new(|| H263Lookups {
    intra_mcbpc: lookup_from_columns(&H263_INTRA_MCBPC_CODE, &H263_INTRA_MCBPC_BITS),
    inter_mcbpc: lookup_from_columns(&H263_INTER_MCBPC_CODE, &H263_INTER_MCBPC_BITS),
    cbpy: lookup_from_pairs(&H263_CBPY_TAB),
    mv: lookup_from_pairs(&MVTAB),
});

pub fn h263_lookups() -> &'static H263Lookups {
    &LOOKUPS
}

// The macroblock layer failure values: an invalid code, a vector code that reads none, and a slice that ended where FFmpeg found none
pub const INVALID_CODE: u32 = 1;
pub const INVALID_MOTION: u32 = 2;
pub const SLICE_MISMATCH: u32 = 3;
pub const MISSING_MACROBLOCKS: u32 = 4;
pub const INVALID_LEVEL: u32 = 5;

/// Fails the macroblock layer with a value, the failing macroblock's position in the low bits.
pub fn macroblock_failure<T>(c: &Mpv, value: u32) -> DecodeResult<T> {
    let position: u32 = ((c.mb_y as u32 & 0xFFF) << 12) | (c.mb_x as u32 & 0xFFF);
    error::fail(ERROR_MACROBLOCK_LAYER, (value << 20) ^ position)
}

/// What decode_mb returned: SLICE_OK, SLICE_END (an end marker), or SLICE_NOEND (the packet's macroblocks ran out without one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SliceStatus {
    Ok,
    End,
    NoEnd,
}

/// The H263DecContext fields every codec family reads.
pub struct H263Context<'a> {
    pub c: Mpv,
    pub gb: BitReader<'a>,
    pub last_resync_gb: BitReader<'a>,
    pub mb_num_left: i32,
    pub h263_long_vectors: bool,
    pub gob_index: i32,
    pub umvplus: bool,
    pub h263_slice_structured: bool,
    pub alt_inter_vlc: bool,
    pub loop_filter: bool,
    pub modified_quant: bool,
    pub data_partitioning: bool,
    pub partitioned_frame: bool,
    pub slice_height: i32,
    pub last_dc: [i32; 3],
    /// The picture is a reference, which ff_mpv_reconstruct_mb's skip table reads
    pub reference: bool,
}

impl<'a> H263Context<'a> {
    pub fn new(c: Mpv, packet: &'a [u8]) -> Self {
        let gb: BitReader<'a> = BitReader::new(packet);
        Self {
            c,
            last_resync_gb: gb.clone(),
            gb,
            mb_num_left: 0,
            h263_long_vectors: false,
            gob_index: 0,
            umvplus: false,
            h263_slice_structured: false,
            alt_inter_vlc: false,
            loop_filter: false,
            modified_quant: false,
            data_partitioning: false,
            partitioned_frame: false,
            slice_height: 0,
            last_dc: [0; 3],
            reference: true,
        }
    }

    /// get_vlc2 that fails the macroblock layer on a bit pattern no code starts.
    pub fn get_vlc(&mut self, lookup: &VLCLookup) -> DecodeResult<u32> {
        match self.gb.get_vlc(lookup) {
            Some(symbol) => Ok(symbol),
            None => macroblock_failure(&self.c, INVALID_CODE),
        }
    }

    /// ff_h263_decode_motion: a vector component from its prediction; 0xffff for a code that reads none, as FFmpeg returns it.
    pub fn decode_motion(&mut self, pred: i32, f_code: i32) -> i32 {
        let Some(code) = self.gb.get_vlc(&h263_lookups().mv) else {
            return 0xffff;
        };
        if code == 0 {
            return pred;
        }
        let sign: bool = self.gb.get_flag();
        let shift: i32 = f_code - 1;
        let mut val: i32 = code as i32;
        if shift != 0 {
            val = (val - 1) << shift;
            val |= self.gb.get_bits(shift as u32) as i32;
            val += 1;
        }
        if sign {
            val = -val;
        }
        val += pred;
        if !self.h263_long_vectors {
            sign_extend(val, (5 + f_code) as u32)
        } else {
            if pred < -31 && val < -63 {
                val += 64;
            }
            if pred > 32 && val > 63 {
                val -= 64;
            }
            val
        }
    }

    /// ff_h263_decode_motion that fails the macroblock layer where FFmpeg's caller does, on 0xffff.
    pub fn decode_motion_checked(&mut self, pred: i32, f_code: i32) -> DecodeResult<i32> {
        let value: i32 = self.decode_motion(pred, f_code);
        if value >= 0xffff {
            return macroblock_failure(&self.c, INVALID_MOTION);
        }
        Ok(value)
    }
}

/// FFmpeg's sign_extend: the low bits of val as a signed number.
pub fn sign_extend(val: i32, bits: u32) -> i32 {
    let shift: u32 = 32 - bits;
    (((val as u32) << shift) as i32) >> shift
}

/// A codec family's macroblock layer, which the shared slice loop drives.
pub trait MacroblockLayer<'a> {
    fn h(&mut self) -> &mut H263Context<'a>;
    /// The codec's decode_mb.
    fn decode_mb(&mut self) -> DecodeResult<SliceStatus>;
    /// The header after a resync marker, ff_mpeg4_decode_video_packet_header or h263_decode_gob_header: Ok(true) when it read one.
    fn decode_resync_header(&mut self) -> DecodeResult<bool>;
    /// ff_mpeg4_decode_partitions, for a data-partitioned MPEG-4 picture.
    fn decode_partitions(&mut self) -> DecodeResult<()> {
        Ok(())
    }
    /// Whether ff_h263_resync first skips a bit and aligns, as it does for MPEG-4.
    fn resync_aligns(&self) -> bool {
        false
    }
}

/// decode_slice of h263dec.c: decodes macroblocks from the resync position until the slice ends.
pub fn decode_slice<'a, D: MacroblockLayer<'a>>(decoder: &mut D) -> DecodeResult<()> {
    let h: &mut H263Context<'a> = decoder.h();
    h.last_resync_gb = h.gb.clone();
    h.c.first_slice_line = true;
    h.c.resync_mb_x = h.c.mb_x;
    h.c.resync_mb_y = h.c.mb_y;
    let qscale: i32 = h.c.qscale;
    h.c.set_qscale(qscale);
    if h.partitioned_frame {
        decoder.decode_partitions()?;
        let h: &mut H263Context<'a> = decoder.h();
        h.c.first_slice_line = true;
        h.c.mb_x = h.c.resync_mb_x;
        h.c.mb_y = h.c.resync_mb_y;
        h.c.set_qscale(qscale);
    }
    loop {
        let h: &mut H263Context<'a> = decoder.h();
        if h.c.mb_y >= h.c.mb_height {
            break;
        }
        if h.c.codec.is_msmpeg4() && h.c.resync_mb_y + h.slice_height == h.c.mb_y {
            return Ok(());
        }
        if h.c.codec == crate::mpv::Codec::MsMpeg4V1 {
            h.last_dc = [128; 3];
        }
        h.c.init_block_index();
        loop {
            let h: &mut H263Context<'a> = decoder.h();
            if h.c.mb_x >= h.c.mb_width {
                break;
            }
            h.c.update_block_index();
            if h.c.resync_mb_x == h.c.mb_x && h.c.resync_mb_y + 1 == h.c.mb_y {
                h.c.first_slice_line = false;
            }
            h.c.mv_dir = MV_DIR_FORWARD;
            h.c.mv_type = MV_TYPE_16X16;
            let status: DecodeResult<SliceStatus> = decoder.decode_mb();
            let h: &mut H263Context<'a> = decoder.h();
            if h.c.h263_pred || h.c.h263_aic {
                let mb_xy: i32 = h.c.mb_xy();
                if !h.c.mb_intra {
                    h.c.h263_clean_intra_table_entries(mb_xy);
                } else {
                    h.c.mbintra_table[mb_xy as usize] = 1;
                }
            }
            if h.c.pict_type != PictType::B {
                h.c.h263_update_motion_val();
            }
            match status? {
                SliceStatus::End => {
                    let reference: bool = h.reference;
                    h.c.reconstruct_mb(reference);
                    h.c.mb_x += 1;
                    if h.c.mb_x >= h.c.mb_width {
                        h.c.mb_x = 0;
                        h.c.mb_y += 1;
                    }
                    return Ok(());
                }
                SliceStatus::NoEnd => return macroblock_failure(&h.c, SLICE_MISMATCH),
                SliceStatus::Ok => {}
            }
            let reference: bool = h.reference;
            h.c.reconstruct_mb(reference);
            h.c.mb_x += 1;
        }
        let h: &mut H263Context<'a> = decoder.h();
        h.c.mb_x = 0;
        h.c.mb_y += 1;
    }
    Ok(())
}

/// ff_h263_resync: finds the next slice's header from the slice's start, skipping bytes until one reads; false when none does.
pub fn h263_resync<'a, D: MacroblockLayer<'a>>(decoder: &mut D) -> DecodeResult<bool> {
    let aligns: bool = decoder.resync_aligns();
    let h: &mut H263Context<'a> = decoder.h();
    if aligns {
        h.gb.skip_bits(1);
        h.gb.align();
    }
    if h.gb.show_bits(16) == 0 && decoder.decode_resync_header()? {
        return Ok(true);
    }
    let h: &mut H263Context<'a> = decoder.h();
    h.gb = h.last_resync_gb.clone();
    h.gb.align();
    let mut left: i64 = h.gb.bits_left();
    while left > 16 + 1 + 5 + 5 {
        let h: &mut H263Context<'a> = decoder.h();
        if h.gb.show_bits(16) == 0 {
            let backup: BitReader<'a> = h.gb.clone();
            if decoder.decode_resync_header()? {
                return Ok(true);
            }
            decoder.h().gb = backup;
        }
        decoder.h().gb.skip_bits(8);
        left -= 8;
    }
    Ok(false)
}

/// The macroblock loop of ff_h263_decode_frame: the first slice, then each slice the codec resyncs to, until the picture's macroblocks
/// are decoded. A picture that leaves macroblocks undecoded, which FFmpeg's error resilience would conceal, fails as damage.
pub fn decode_frame_macroblocks<'a, D: MacroblockLayer<'a>>(decoder: &mut D) -> DecodeResult<()> {
    {
        let h: &mut H263Context<'a> = decoder.h();
        h.c.mb_x = 0;
        h.c.mb_y = 0;
    }
    decode_slice(decoder)?;
    loop {
        let h: &mut H263Context<'a> = decoder.h();
        if h.c.mb_y >= h.c.mb_height {
            break;
        }
        if h.c.codec.is_msmpeg4() {
            if h.slice_height == 0 || h.c.mb_x != 0 || h.c.mb_y % h.slice_height != 0 || h.gb.bits_left() < 0 {
                break;
            }
        } else {
            let previous: (i32, i32) = (h.c.mb_x, h.c.mb_y);
            if !h263_resync(decoder)? {
                break;
            }
            let h: &mut H263Context<'a> = decoder.h();
            if previous.1 * h.c.mb_width + previous.0 < h.c.mb_y * h.c.mb_width + h.c.mb_x {
                // A slice was lost between the two, which FFmpeg conceals
                return macroblock_failure(&h.c, MISSING_MACROBLOCKS);
            }
        }
        let h: &mut H263Context<'a> = decoder.h();
        if h.c.h263_pred {
            h.c.mpeg4_clean_buffers();
        }
        decode_slice(decoder)?;
    }
    let h: &mut H263Context<'a> = decoder.h();
    if h.c.mb_y < h.c.mb_height {
        return macroblock_failure(&h.c, MISSING_MACROBLOCKS);
    }
    Ok(())
}

/// Fails a picture whose reader ran past its packet, as damage.
pub fn check_bits(h: &H263Context) -> DecodeResult<()> {
    if h.gb.bits_left() < 0 {
        return Err(DecodeError { code: ERROR_BITS_EXHAUSTED, value: (-h.gb.bits_left()).min(0xFF_FFFF) as u32 });
    }
    Ok(())
}
