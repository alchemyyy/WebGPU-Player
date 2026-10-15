// The arithmetic decoding engine (9.3.4.3), in FFmpeg's 16-bit refill form: `low` holds the offset scaled by 2^17 plus the bits
// fetched ahead, with a marker bit below them that counts how many remain; the marker reaching bit 16 triggers the next two-byte fetch.
// FFmpeg's libavcodec/cabac_functions.h is the behavioral reference.

use crate::tables::{NEXT_STATE_LPS, NEXT_STATE_MPS, RANGE_LPS};

const CABAC_BITS: u32 = 16;
const CABAC_MASK: u32 = (1 << CABAC_BITS) - 1;
const INITIAL_RANGE: u32 = 0x1FE;
const RENORMALIZATION_THRESHOLD: u32 = 0x100;
// A 9-bit range sits at bits 23 and below of a 32-bit word
const RANGE_LEADING_ZEROS: u32 = 23;

/// Reads bins from one substream of slice data; bytes past the end read as zero, as FFmpeg's padding does.
pub struct ArithmeticDecoder {
    low: u32,
    range: u32,
    position: usize,
    end: usize,
}

impl Default for ArithmeticDecoder {
    fn default() -> Self {
        Self { low: 0, range: INITIAL_RANGE, position: 0, end: 0 }
    }
}

impl ArithmeticDecoder {
    #[inline(always)]
    fn fetch_pair(&mut self, data: &[u8]) -> u32 {
        if self.position >= self.end {
            return 0;
        }
        // The data keeps padding after every segment, so the byte after the last one reads
        let pair: u32 = (u32::from(data[self.position]) << 9) | (u32::from(data[self.position + 1]) << 1);
        self.position += 2;
        pair
    }

    #[inline(always)]
    fn refill(&mut self, data: &[u8]) {
        let pair: u32 = self.fetch_pair(data);
        self.low = self.low.wrapping_add(pair).wrapping_sub(CABAC_MASK);
    }

    /// Refills after a renormalization of several bits, which moved the marker past bit 16.
    #[inline(always)]
    fn refill_shifted(&mut self, data: &[u8]) {
        let shift: u32 = self.low.trailing_zeros() - CABAC_BITS;
        let pair: u32 = self.fetch_pair(data).wrapping_sub(CABAC_MASK);
        self.low = self.low.wrapping_add(pair << shift);
    }

    /// Initializes the decoder at a byte of the data (9.3.2.5); returns false when the first bits already exceed the range.
    pub fn start(&mut self, data: &[u8], position: usize, end: usize) -> bool {
        self.end = end;
        let first: u32 = if position < end { u32::from(data[position]) } else { 0 };
        let second: u32 = if position + 1 < end { u32::from(data[position + 1]) } else { 0 };
        self.position = position + 2;
        self.low = (first << 18) | (second << 10) | (1 << 9);
        self.range = INITIAL_RANGE;
        (self.range << (CABAC_BITS + 1)) >= self.low
    }

    /// One context-coded bin (9.3.4.3.2); the state byte is pStateIdx * 2 + valMps.
    #[inline(always)]
    pub fn decode_bin(&mut self, data: &[u8], state: &mut u8) -> u32 {
        let current: usize = usize::from(*state);
        let range_lps: u32 = u32::from(RANGE_LPS[((current >> 1) << 2) | ((self.range >> 6) & 3) as usize]);
        self.range -= range_lps;
        let scaled_range: u32 = self.range << (CABAC_BITS + 1);
        if self.low < scaled_range {
            *state = NEXT_STATE_MPS[current];
            // A most probable bin renormalizes by one bit at most
            if self.range < RENORMALIZATION_THRESHOLD {
                self.range <<= 1;
                self.low <<= 1;
                if self.low & CABAC_MASK == 0 {
                    self.refill(data);
                }
            }
            return (current & 1) as u32;
        }
        self.low -= scaled_range;
        self.range = range_lps;
        *state = NEXT_STATE_LPS[current];
        let shift: u32 = self.range.leading_zeros() - RANGE_LEADING_ZEROS;
        self.range <<= shift;
        self.low <<= shift;
        if self.low & CABAC_MASK == 0 {
            self.refill_shifted(data);
        }
        ((current & 1) ^ 1) as u32
    }

    /// One bypass bin (9.3.4.3.4).
    #[inline(always)]
    pub fn decode_bypass(&mut self, data: &[u8]) -> u32 {
        self.low <<= 1;
        if self.low & CABAC_MASK == 0 {
            self.refill(data);
        }
        let scaled_range: u32 = self.range << (CABAC_BITS + 1);
        if self.low < scaled_range {
            return 0;
        }
        self.low -= scaled_range;
        1
    }

    /// Bypass bins, MSB first.
    #[inline(always)]
    pub fn decode_bypass_bits(&mut self, data: &[u8], count: u32) -> u32 {
        let mut value: u32 = 0;
        for _ in 0..count {
            value = (value << 1) | self.decode_bypass(data);
        }
        value
    }

    /// The terminating bin (9.3.4.3.5).
    pub fn decode_terminate(&mut self, data: &[u8]) -> u32 {
        self.range -= 2;
        if self.low < self.range << (CABAC_BITS + 1) {
            let shift: u32 = u32::from(self.range < RENORMALIZATION_THRESHOLD);
            self.range <<= shift;
            self.low <<= shift;
            if self.low & CABAC_MASK == 0 {
                self.refill(data);
            }
            return 0;
        }
        1
    }

    /// The byte the arithmetic decoder stopped at after a terminating bin of 1, where PCM samples or the next substream start.
    pub fn stop_position(&self) -> usize {
        let mut position: usize = self.position;
        if self.low & 1 != 0 {
            position -= 1;
        }
        if self.low & 0x1FF != 0 {
            position -= 1;
        }
        position
    }

    pub fn end(&self) -> usize {
        self.end
    }
}
