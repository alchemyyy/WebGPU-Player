// The bit reader, with the semantics of FFmpeg's unchecked GetBitContext, which the mpeg4, h263, and msmpeg4 decoders use: bits
// past the buffer's end read as zero, as FFmpeg's zero-padded packets read, and the position runs on past the end, so get_bits_left
// turns negative.

use crate::vlc::VLCLookup;

const WINDOW_BITS: u32 = 32;
const BYTE_BITS: usize = 8;
const WINDOW_BYTES: usize = 8;

#[derive(Clone)]
pub struct BitReader<'a> {
    bytes: &'a [u8],
    position: usize,
    size_in_bits: usize,
}

impl<'a> BitReader<'a> {
    /// A reader of a whole buffer, FFmpeg's init_get_bits8.
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0, size_in_bits: bytes.len() * BYTE_BITS }
    }

    /// The 32 bits from the reader's position, most significant first; bits past the buffer read as zero.
    pub fn peek_window(&self) -> u32 {
        let byte_index: usize = self.position / BYTE_BITS;
        let mut loaded: [u8; WINDOW_BYTES] = [0; WINDOW_BYTES];
        if byte_index < self.bytes.len() {
            let available: usize = (self.bytes.len() - byte_index).min(WINDOW_BYTES);
            loaded[..available].copy_from_slice(&self.bytes[byte_index..byte_index + available]);
        }
        let shifted: u64 = u64::from_be_bytes(loaded) << (self.position % BYTE_BITS);
        (shifted >> WINDOW_BITS) as u32
    }

    /// FFmpeg's show_bits and show_bits_long: the next count bits, 0 to 32, without consuming them.
    pub fn show_bits(&self, count: u32) -> u32 {
        if count == 0 {
            return 0;
        }
        self.peek_window() >> (WINDOW_BITS - count)
    }

    /// FFmpeg's skip_bits and skip_bits_long.
    pub fn skip_bits(&mut self, count: u32) {
        self.position += count as usize;
    }

    /// FFmpeg's get_bits and get_bits_long: reads count bits, 0 to 32, most significant first.
    pub fn get_bits(&mut self, count: u32) -> u32 {
        let value: u32 = self.show_bits(count);
        self.skip_bits(count);
        value
    }

    pub fn get_bits1(&mut self) -> u32 {
        self.get_bits(1)
    }

    pub fn get_flag(&mut self) -> bool {
        self.get_bits1() != 0
    }

    /// FFmpeg's get_sbits: count bits, 1 to 32, as a two's complement number.
    pub fn get_sbits(&mut self, count: u32) -> i32 {
        let value: u32 = self.get_bits(count);
        ((value << (WINDOW_BITS - count)) as i32) >> (WINDOW_BITS - count)
    }

    /// FFmpeg's get_xbits: count bits, 1 to 25, whose leading one makes them positive, and whose leading zero makes them the negative
    /// value of their complement, as MPEG's DC and motion residues code them.
    pub fn get_xbits(&mut self, count: u32) -> i32 {
        let value: u32 = self.get_bits(count);
        if value >> (count - 1) != 0 {
            value as i32
        } else {
            value as i32 - ((1i32 << count) - 1)
        }
    }

    /// FFmpeg's get_bits_count.
    pub fn bits_count(&self) -> usize {
        self.position
    }

    /// FFmpeg's get_bits_left, negative once the reader passed the buffer's end.
    pub fn bits_left(&self) -> i64 {
        self.size_in_bits as i64 - self.position as i64
    }

    /// The buffer's size in bits, FFmpeg's size_in_bits.
    pub fn size_in_bits(&self) -> usize {
        self.size_in_bits
    }

    /// FFmpeg's align_get_bits: moves to the next byte boundary.
    pub fn align(&mut self) {
        self.position = self.position.next_multiple_of(BYTE_BITS);
    }

    /// Moves the reader to a bit position.
    pub fn seek(&mut self, position: usize) {
        self.position = position;
    }


    /// FFmpeg's get_vlc2: the symbol of the code at the reader's position, or None for a bit pattern no code starts, which consumes
    /// nothing.
    pub fn get_vlc(&mut self, lookup: &VLCLookup) -> Option<u32> {
        let (symbol, length) = lookup.decode(self.peek_window())?;
        self.skip_bits(length);
        Some(symbol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTES: [u8; 3] = [0b1011_0011, 0b1111_0000, 0b1010_1010];

    #[test]
    fn reads_bits_and_reads_zeros_past_the_end() {
        let mut reader: BitReader = BitReader::new(&BYTES);
        assert_eq!(reader.get_bits(3), 0b101);
        assert_eq!(reader.get_bits(5), 0b1_0011);
        assert_eq!(reader.show_bits(8), 0b1111_0000);
        reader.skip_bits(12);
        assert_eq!(reader.get_bits(8), 0b1010_0000);
        assert_eq!(reader.bits_left(), -4);
        assert_eq!(reader.get_bits(32), 0);
    }

    #[test]
    fn reads_signed_and_sign_magnitude_values() {
        // 011 is -4 as get_xbits reads it and 3 as get_sbits does; 110 is 6 and -2
        let bytes: [u8; 1] = [0b0111_1000];
        let mut reader: BitReader = BitReader::new(&bytes);
        assert_eq!(reader.get_xbits(3), -4);
        assert_eq!(reader.get_xbits(3), 6);
        reader.seek(0);
        assert_eq!(reader.get_sbits(3), 3);
        assert_eq!(reader.get_sbits(3), -2);
    }

    #[test]
    fn aligns_to_the_next_byte() {
        let mut reader: BitReader = BitReader::new(&BYTES);
        reader.get_bits(3);
        reader.align();
        assert_eq!(reader.bits_count(), 8);
        reader.align();
        assert_eq!(reader.bits_count(), 8);
    }
}
