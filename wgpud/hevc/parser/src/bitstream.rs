// RBSP extraction and the bit reader of parameter sets and slice segment headers.

/// Appends a NAL unit's RBSP to `output`, without its emulation prevention bytes, and records in `escapes`
/// the RBSP index, relative to the appended RBSP, of the byte that followed each removed byte.
pub fn extract_rbsp(source: &[u8], output: &mut Vec<u8>, escapes: &mut Vec<u32>) {
    let start: usize = output.len();
    let mut zero_count: u32 = 0;
    for &value in source {
        if zero_count >= 2 && value == 3 {
            escapes.push((output.len() - start) as u32);
            zero_count = 0;
            continue;
        }
        zero_count = if value == 0 { zero_count + 1 } else { 0 };
        output.push(value);
    }
}

/// Returns the raw position, in the NAL unit, of an RBSP index: each escape at or before it moved it one byte later.
pub fn raw_position_of(rbsp_index: usize, escapes: &[u32]) -> usize {
    rbsp_index + escapes.iter().filter(|&&escape: &&u32| escape as usize <= rbsp_index).count()
}

/// Returns the RBSP index of a raw position in the NAL unit that is not itself an emulation prevention byte.
pub fn rbsp_index_of(raw_position: usize, escapes: &[u32]) -> usize {
    // Escape number n removed the raw byte at escape + n
    let removed_before: usize = escapes
        .iter()
        .enumerate()
        .filter(|&(order, &escape): &(usize, &u32)| (escape as usize) + order < raw_position)
        .count();
    raw_position - removed_before
}

/// Reads bits MSB first from an RBSP; reads past the end return zeros and mark the reader overrun.
pub struct BitReader<'a> {
    bytes: &'a [u8],
    bit_position: usize,
    overrun: bool,
}

impl<'a> BitReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, bit_position: 0, overrun: false }
    }

    /// The next 32 bits, MSB first, zeros past the end.
    fn peek_word(&self) -> u32 {
        let byte_index: usize = self.bit_position >> 3;
        let mut window: u64 = 0;
        for offset in 0..5 {
            let byte: u8 = self.bytes.get(byte_index + offset).copied().unwrap_or(0);
            window = (window << 8) | u64::from(byte);
        }
        // 40 bits are loaded; drop the bits already read in the first byte
        let shift: u32 = 8 - (self.bit_position & 7) as u32;
        (window >> shift) as u32
    }

    fn advance(&mut self, count: u32) {
        self.bit_position += count as usize;
        if self.bit_position > self.bytes.len() * 8 {
            self.overrun = true;
        }
    }

    /// Up to 32 bits.
    pub fn read_bits(&mut self, count: u32) -> u32 {
        if count == 0 {
            return 0;
        }
        let value: u32 = self.peek_word() >> (32 - count);
        self.advance(count);
        value
    }

    pub fn read_flag(&mut self) -> u32 {
        self.read_bits(1)
    }

    pub fn skip_bits(&mut self, count: u32) {
        self.advance(count);
    }

    pub fn read_unsigned_golomb(&mut self) -> u32 {
        let leading_zero_bits: u32 = self.peek_word().leading_zeros();
        if leading_zero_bits >= 32 {
            self.overrun = true;
            return 0;
        }
        self.advance(leading_zero_bits + 1);
        if leading_zero_bits == 0 {
            return 0;
        }
        ((1u32 << leading_zero_bits) - 1).wrapping_add(self.read_bits(leading_zero_bits))
    }

    pub fn read_signed_golomb(&mut self) -> i32 {
        let code_number: u32 = self.read_unsigned_golomb();
        let magnitude: i32 = ((code_number >> 1) + (code_number & 1)) as i32;
        if code_number & 1 == 1 { magnitude } else { -magnitude }
    }

    /// Skips to the next byte boundary.
    pub fn align(&mut self) {
        self.bit_position = (self.bit_position + 7) & !7;
    }

    /// The RBSP index of the next byte of a byte-aligned reader.
    pub fn byte_position(&self) -> usize {
        self.bit_position >> 3
    }

    pub fn overrun(&self) -> bool {
        self.overrun
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ESCAPED_NAL: [u8; 9] = [0x40, 0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x00];
    const UNESCAPED_RBSP: [u8; 7] = [0x40, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];

    #[test]
    fn removes_emulation_prevention_bytes_and_maps_positions_both_ways() {
        let mut rbsp: Vec<u8> = Vec::new();
        let mut escapes: Vec<u32> = Vec::new();
        extract_rbsp(&ESCAPED_NAL, &mut rbsp, &mut escapes);
        assert_eq!(rbsp, UNESCAPED_RBSP);
        assert_eq!(escapes, vec![3, 6]);
        // RBSP byte 3 (0x01) was raw byte 4, and RBSP byte 6 was raw byte 8
        assert_eq!(raw_position_of(3, &escapes), 4);
        assert_eq!(raw_position_of(6, &escapes), 8);
        assert_eq!(rbsp_index_of(4, &escapes), 3);
        assert_eq!(rbsp_index_of(8, &escapes), 6);
        assert_eq!(rbsp_index_of(2, &escapes), 2);
    }

    #[test]
    fn reads_fixed_and_exp_golomb_codes_and_flags_an_overrun() {
        // 1 | 010 | 011 | 00100 | 0001000 then zeros: flag 1, ue 1, ue 2, ue 3, se +4 (code 7)
        let bytes: [u8; 3] = [0b1010_0110, 0b0100_0001, 0b0000_0000];
        let mut reader: BitReader = BitReader::new(&bytes);
        assert_eq!(reader.read_flag(), 1);
        assert_eq!(reader.read_unsigned_golomb(), 1);
        assert_eq!(reader.read_unsigned_golomb(), 2);
        assert_eq!(reader.read_unsigned_golomb(), 3);
        assert_eq!(reader.read_signed_golomb(), 4);
        assert!(!reader.overrun());
        reader.skip_bits(16);
        assert!(reader.overrun());
    }
}
