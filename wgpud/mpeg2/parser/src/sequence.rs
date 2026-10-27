// The sequence a stream's headers declare, read as the decoder's WGSL reads them in its header stage: FFmpeg's mpeg1_decode_sequence and
// mpeg_decode_sequence_extension, which only the headers before a packet's first picture start code reach, as decode_chunks does.
// A damaged sequence header is ignored as the WGSL ignores it, so the size a picture reports is the size the WGSL decodes it at.

// A start code: the 00 00 01 prefix, then its type, which must lie within the bytes
const START_CODE_BYTES: usize = 4;
const PICTURE_START_CODE: u8 = 0x00;
const SEQUENCE_HEADER_CODE: u8 = 0xB3;
const EXTENSION_START_CODE: u8 = 0xB5;
const SEQUENCE_EXTENSION_ID: u32 = 1;
// chroma_format as the sequence extension codes it, which a sequence header without one implies; 0 is reserved and taken for 4:2:0
const CHROMA_420: u32 = 1;
const CHROMA_444: u32 = 3;
// Where horizontal_size_extension and vertical_size_extension go
const SIZE_EXTENSION_SHIFT: u32 = 12;
const COEFFICIENTS_PER_BLOCK: usize = 64;
// The bits after a sequence header that FFmpeg requires to be zero
const SEQUENCE_HEADER_TAIL_BITS: u32 = 23;
const BITS_PER_BYTE: usize = 8;
const WORD_BITS: u32 = 32;

/// What a picture's sequence declares: its size, horizontal_size and vertical_size with their extensions, and its chroma format.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SequenceFacts {
    pub width: u32,
    pub height: u32,
    /// chroma_format as `chroma_format_idc` counts it: 1 for 4:2:0, 2 for 4:2:2, 3 for 4:4:4
    pub chroma_format: u32,
}

/// The header reader of the WGSL: big-endian bits from any position, zero past the end as FFmpeg's padding reads.
struct HeaderReader<'a> {
    bytes: &'a [u8],
    bit: usize,
}

impl HeaderReader<'_> {
    fn byte(&self, index: usize) -> u32 {
        self.bytes.get(index).map_or(0, |value: &u8| u32::from(*value))
    }

    /// Returns the next count bits, 1 to 24, without consuming them.
    fn peek(&self, count: u32) -> u32 {
        let index: usize = self.bit / BITS_PER_BYTE;
        let window: u32 = (self.byte(index) << 24) | (self.byte(index + 1) << 16) | (self.byte(index + 2) << 8) | self.byte(index + 3);
        (window << (self.bit % BITS_PER_BYTE)) >> (WORD_BITS - count)
    }

    fn read(&mut self, count: u32) -> u32 {
        let value: u32 = self.peek(count);
        self.bit += count as usize;
        value
    }

    fn read_flag(&mut self) -> bool {
        self.read(1) != 0
    }

    /// Skips a quantizer matrix as the WGSL's loadMatrix reads it: a zero value is damage, which stops the matrix after it.
    fn skip_matrix(&mut self) {
        for _ in 0..COEFFICIENTS_PER_BLOCK {
            if self.read(8) == 0 {
                return;
            }
        }
    }
}

/// The session context's sequence fields, which persist from packet to packet as FFmpeg's decoder context keeps them.
#[derive(Clone, Copy, Debug, Default)]
pub struct Sequence {
    width: u32,
    height: u32,
    chroma_format: u32,
}

impl Sequence {
    /// Applies the headers of a packet or of the codec private data that precede its first picture start code.
    pub fn read_headers(&mut self, bytes: &[u8]) {
        let mut position: usize = 0;
        while position + START_CODE_BYTES <= bytes.len() {
            if bytes[position] != 0 || bytes[position + 1] != 0 || bytes[position + 2] != 1 {
                position += 1;
                continue;
            }
            let mut reader: HeaderReader<'_> = HeaderReader { bytes, bit: (position + START_CODE_BYTES) * BITS_PER_BYTE };
            match bytes[position + 3] {
                PICTURE_START_CODE => return,
                SEQUENCE_HEADER_CODE => self.read_sequence_header(&mut reader),
                EXTENSION_START_CODE if reader.read(4) == SEQUENCE_EXTENSION_ID => self.read_sequence_extension(&mut reader),
                _ => {}
            }
            position += 1;
        }
    }

    /// The sequence's facts, or None before a sequence header gave both sides a size.
    pub fn facts(&self) -> Option<SequenceFacts> {
        if self.width == 0 || self.height == 0 || !(CHROMA_420..=CHROMA_444).contains(&self.chroma_format) {
            return None;
        }
        Some(SequenceFacts { width: self.width, height: self.height, chroma_format: self.chroma_format })
    }

    /// FFmpeg's mpeg1_decode_sequence: a missing marker before the matrices, or a nonzero tail after them, leaves the size as it was.
    fn read_sequence_header(&mut self, reader: &mut HeaderReader<'_>) {
        let width: u32 = reader.read(12);
        let height: u32 = reader.read(12);
        // aspect_ratio_information, frame_rate_code, and bit_rate_value
        reader.read(4);
        reader.read(4);
        reader.read(18);
        if !reader.read_flag() {
            return;
        }
        // vbv_buffer_size_value and constrained_parameters_flag
        reader.read(10);
        reader.read(1);
        if reader.read_flag() {
            reader.skip_matrix();
        }
        if reader.read_flag() {
            reader.skip_matrix();
        }
        if reader.peek(SEQUENCE_HEADER_TAIL_BITS) != 0 {
            return;
        }
        self.width = width;
        self.height = height;
        self.chroma_format = CHROMA_420;
    }

    /// FFmpeg's mpeg_decode_sequence_extension: the chroma format, and the size extensions, which the sequence's size takes on.
    fn read_sequence_extension(&mut self, reader: &mut HeaderReader<'_>) {
        // profile_and_level_indication and progressive_sequence
        reader.read(8);
        reader.read(1);
        let chroma_format: u32 = reader.read(2);
        self.chroma_format = if chroma_format == 0 { CHROMA_420 } else { chroma_format };
        self.width |= reader.read(2) << SIZE_EXTENSION_SHIFT;
        self.height |= reader.read(2) << SIZE_EXTENSION_SHIFT;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHROMA_422: u32 = 2;

    /// Writes big-endian bits, as a stream codes its headers.
    #[derive(Default)]
    struct BitWriter {
        bytes: Vec<u8>,
        bit_count: usize,
    }

    impl BitWriter {
        fn write(mut self, value: u32, count: u32) -> Self {
            for shift in (0..count).rev() {
                if self.bit_count.is_multiple_of(BITS_PER_BYTE) {
                    self.bytes.push(0);
                }
                let bit: u8 = ((value >> shift) & 1) as u8;
                let last: usize = self.bytes.len() - 1;
                self.bytes[last] |= bit << (7 - self.bit_count % BITS_PER_BYTE);
                self.bit_count += 1;
            }
            self
        }

        fn finish(self) -> Vec<u8> {
            self.bytes
        }
    }

    fn start_code(code: u8) -> Vec<u8> {
        vec![0, 0, 1, code]
    }

    /// A sequence header of a size, with the marker bit and its matrices as given; a matrix value of 0 is damage.
    fn sequence_header(width: u32, height: u32, marker: bool, intra_matrix: Option<&[u32]>) -> Vec<u8> {
        let mut writer: BitWriter = BitWriter::default().write(width, 12).write(height, 12).write(1, 4).write(3, 4).write(0x3FFFF, 18).write(u32::from(marker), 1);
        writer = writer.write(112, 10).write(0, 1);
        match intra_matrix {
            Some(values) => {
                writer = writer.write(1, 1);
                for value in values {
                    writer = writer.write(*value, 8);
                }
            }
            None => writer = writer.write(0, 1),
        }
        writer = writer.write(0, 1);
        [start_code(SEQUENCE_HEADER_CODE), writer.finish()].concat()
    }

    fn sequence_extension(chroma_format: u32, horizontal_extension: u32, vertical_extension: u32) -> Vec<u8> {
        let payload: Vec<u8> = BitWriter::default()
            .write(SEQUENCE_EXTENSION_ID, 4)
            .write(0x48, 8)
            .write(0, 1)
            .write(chroma_format, 2)
            .write(horizontal_extension, 2)
            .write(vertical_extension, 2)
            .write(0, 12)
            .write(1, 1)
            .write(0, 8)
            .write(0, 1)
            .write(0, 7)
            .finish();
        [start_code(EXTENSION_START_CODE), payload].concat()
    }

    fn picture() -> Vec<u8> {
        [start_code(PICTURE_START_CODE), vec![0x00, 0x0F, 0xFF, 0xF8]].concat()
    }

    fn read(chunks: &[Vec<u8>]) -> Option<SequenceFacts> {
        let mut sequence: Sequence = Sequence::default();
        sequence.read_headers(&chunks.concat());
        sequence.facts()
    }

    #[test]
    fn an_mpeg1_sequence_header_declares_its_size_at_420() {
        assert_eq!(read(&[sequence_header(352, 288, true, None), picture()]), Some(SequenceFacts { width: 352, height: 288, chroma_format: CHROMA_420 }));
    }

    #[test]
    fn a_sequence_extension_adds_its_size_extensions_and_chroma_format() {
        let facts: Option<SequenceFacts> = read(&[sequence_header(0x780, 0x438, true, None), sequence_extension(CHROMA_422, 1, 2), picture()]);
        assert_eq!(facts, Some(SequenceFacts { width: 0x1780, height: 0x2438, chroma_format: CHROMA_422 }));
    }

    #[test]
    fn a_reserved_chroma_format_is_taken_for_420() {
        assert_eq!(read(&[sequence_header(720, 576, true, None), sequence_extension(0, 0, 0)]).map(|facts: SequenceFacts| facts.chroma_format), Some(CHROMA_420));
    }

    #[test]
    fn headers_after_the_first_picture_start_code_never_apply() {
        assert_eq!(read(&[sequence_header(720, 576, true, None), picture(), sequence_header(1920, 1080, true, None)]).map(|facts: SequenceFacts| facts.width), Some(720));
    }

    #[test]
    fn a_header_without_its_marker_keeps_the_size_before_it() {
        let mut sequence: Sequence = Sequence::default();
        sequence.read_headers(&sequence_header(720, 576, true, None));
        sequence.read_headers(&sequence_header(1920, 1080, false, None));
        assert_eq!(sequence.facts().map(|facts: SequenceFacts| (facts.width, facts.height)), Some((720, 576)));
    }

    #[test]
    fn a_header_whose_tail_is_not_zero_keeps_the_size_before_it() {
        let mut sequence: Sequence = Sequence::default();
        sequence.read_headers(&sequence_header(720, 576, true, None));
        // A zero in the matrix stops it there, so the rest of the matrix becomes the tail
        let mut damaged: Vec<u32> = vec![16; COEFFICIENTS_PER_BLOCK];
        damaged[3] = 0;
        sequence.read_headers(&sequence_header(1920, 1080, true, Some(&damaged)));
        assert_eq!(sequence.facts().map(|facts: SequenceFacts| facts.width), Some(720));
    }

    #[test]
    fn a_full_matrix_keeps_the_header() {
        let matrix: Vec<u32> = vec![16; COEFFICIENTS_PER_BLOCK];
        assert_eq!(read(&[sequence_header(1920, 1080, true, Some(&matrix)), picture()]).map(|facts: SequenceFacts| facts.width), Some(1920));
    }

    #[test]
    fn no_size_before_a_sequence_header_or_with_a_zero_side() {
        assert_eq!(read(&[picture()]), None);
        assert_eq!(read(&[sequence_header(720, 0, true, None)]), None);
    }

    #[test]
    fn a_start_code_whose_type_lies_past_the_end_is_none() {
        assert_eq!(read(&[vec![0, 0, 1]]), None);
    }
}
