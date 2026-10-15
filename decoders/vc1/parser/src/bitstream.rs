// The bit reader over a segment of unescaped stream bytes, as the WGSL decoder's reader read its stream: bits from the segment's
// end on read as zero, as FFmpeg's zero-padded buffers read past a segment, and reading on past the end marks the reader overrun.
// Each reader also tracks whether a code read found no code, which the macroblock layer reports.

use crate::vlc::{INVALID_SYMBOL, VLCLookup};

const WINDOW_BITS: u32 = 32;
const BYTE_BITS: usize = 8;
const WORD_BYTES: usize = 8;

pub struct BitReader<'a> {
    bytes: &'a [u8],
    position: usize,
    end: usize,
    invalid_code: bool,
}

impl<'a> BitReader<'a> {
    /// A reader of bits [start, end) of bytes.
    pub fn new(bytes: &'a [u8], start: usize, end: usize) -> Self {
        Self { bytes, position: start, end, invalid_code: false }
    }

    /// The 32 bits from the reader's position, most significant first, with the bits from the segment's end on zeroed.
    pub fn peek_window(&self) -> u32 {
        if self.position >= self.end {
            return 0;
        }
        let byte_index: usize = self.position / BYTE_BITS;
        let mut loaded: [u8; WORD_BYTES] = [0; WORD_BYTES];
        let available: usize = self.bytes.len().saturating_sub(byte_index).min(WORD_BYTES);
        loaded[..available].copy_from_slice(&self.bytes[byte_index..byte_index + available]);
        let shifted: u64 = u64::from_be_bytes(loaded) << (self.position % BYTE_BITS);
        let window: u32 = (shifted >> WINDOW_BITS) as u32;
        let remaining: usize = self.end - self.position;
        if remaining >= WINDOW_BITS as usize {
            return window;
        }
        window & !(u32::MAX >> remaining)
    }

    /// The next count bits, 1 to 32, without consuming them.
    pub fn peek_bits(&self, count: u32) -> u32 {
        self.peek_window() >> (WINDOW_BITS - count)
    }

    /// Consumes count bits; the reader may move past the segment's end, which overruns it.
    pub fn skip_bits(&mut self, count: u32) {
        self.position += count as usize;
    }

    /// Reads count bits, 0 to 32, most significant first.
    pub fn read_bits(&mut self, count: u32) -> u32 {
        if count == 0 {
            return 0;
        }
        let value: u32 = self.peek_bits(count);
        self.skip_bits(count);
        value
    }

    pub fn read_bit(&mut self) -> u32 {
        self.read_bits(1)
    }

    pub fn read_flag(&mut self) -> bool {
        self.read_bit() != 0
    }

    /// The bits left in the segment, negative once the reader consumed past its end; FFmpeg's get_bits_left.
    pub fn bits_left(&self) -> i64 {
        self.end as i64 - self.position as i64
    }

    /// Whether a read consumed bits past the segment's end.
    pub fn overran(&self) -> bool {
        self.position > self.end
    }

    /// Whether a code read found no code since the reader started.
    pub fn found_invalid_code(&self) -> bool {
        self.invalid_code
    }

    /// The bit the next read starts at.
    pub fn position(&self) -> usize {
        self.position
    }

    /// The bit the segment ends at.
    pub fn end(&self) -> usize {
        self.end
    }

    /// FFmpeg's get_unary: counts bits until one equals stop or maximum_length bits were read.
    pub fn read_unary(&mut self, stop: u32, maximum_length: u32) -> u32 {
        let mut count: u32 = 0;
        while count < maximum_length && self.read_bit() != stop {
            count += 1;
        }
        count
    }

    /// FFmpeg's decode012: 0, 10, 11 read as 0, 1, 2.
    pub fn read_decode012(&mut self) -> u32 {
        if self.read_bit() == 0 {
            return 0;
        }
        self.read_bit() + 1
    }

    /// FFmpeg's decode210: 1, 01, 00 read as 0, 1, 2.
    pub fn read_decode210(&mut self) -> u32 {
        if self.read_bit() != 0 {
            return 0;
        }
        2 - self.read_bit()
    }

    /// Reads one code of a lookup; a pattern no code starts consumes nothing, marks the reader, and returns INVALID_SYMBOL.
    pub fn read_code(&mut self, lookup: &VLCLookup) -> u32 {
        match lookup.decode(self.peek_window()) {
            Some((symbol, length)) => {
                self.skip_bits(length);
                symbol
            }
            None => {
                self.invalid_code = true;
                INVALID_SYMBOL
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTES: [u8; 3] = [0b1011_0011, 0b1111_0000, 0b1010_1010];
    // A segment of the first 12 bits: everything from bit 12 on reads as zero
    const SEGMENT_END: usize = 12;

    #[test]
    fn reads_bits_and_zeroes_them_from_the_segment_end_on() {
        let mut reader: BitReader = BitReader::new(&BYTES, 0, SEGMENT_END);
        assert_eq!(reader.read_bits(3), 0b101);
        assert_eq!(reader.read_bits(5), 0b1_0011);
        assert_eq!(reader.peek_bits(8), 0b1111_0000);
        assert_eq!(reader.read_bits(8), 0b1111_0000);
        assert!(reader.overran());
        assert_eq!(reader.bits_left(), -4);
        assert_eq!(reader.read_bits(8), 0);
    }

    #[test]
    fn reads_unary_and_the_three_symbol_codes() {
        // 1110 | 10 | 01
        let bytes: [u8; 1] = [0b1110_1001];
        let mut reader: BitReader = BitReader::new(&bytes, 0, BYTE_BITS);
        assert_eq!(reader.read_unary(0, 4), 3);
        assert_eq!(reader.read_decode012(), 1);
        assert_eq!(reader.read_decode210(), 1);
        assert_eq!(reader.bits_left(), 0);
        assert!(!reader.overran());
    }
}
