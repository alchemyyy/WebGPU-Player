// A packet's segments: start codes, which split Advanced profile packets as FFmpeg's find_next_marker finds them, and the removal of
// emulation prevention bytes from each segment, exactly as vc1_unescape_buffer copies one.

/// The bytes of a start code before its type byte.
const START_CODE_PREFIX: [u8; 3] = [0, 0, 1];
/// A start code's length, its type byte included.
pub const START_CODE_LENGTH: usize = 4;
/// The emulation prevention byte.
const ESCAPE_BYTE: u8 = 3;
/// A byte after an emulation prevention byte is below this.
const ESCAPED_BYTE_LIMIT: u8 = 4;
/// The bytes of zeros an emulation prevention byte follows.
const ESCAPE_ZERO_COUNT: usize = 2;

/// Returns the position of the first start code at or after `position` whose type byte lies within bytes, or the length of bytes;
/// FFmpeg's find_next_marker.
pub fn find_start_code(bytes: &[u8], position: usize) -> usize {
    if bytes.len() < position + START_CODE_LENGTH {
        return bytes.len();
    }
    let mut start: usize = position;
    while start + START_CODE_LENGTH <= bytes.len() {
        if bytes[start..start + START_CODE_PREFIX.len()] == START_CODE_PREFIX {
            return start;
        }
        start += 1;
    }
    bytes.len()
}

/// Whether bytes start with a start code.
pub fn starts_with_start_code(bytes: &[u8]) -> bool {
    bytes.len() >= START_CODE_LENGTH && bytes[..START_CODE_PREFIX.len()] == START_CODE_PREFIX
}

/// Appends one segment without its emulation prevention bytes: a 3 after two zeros and before a byte under 4, never the segment's
/// first two or last byte; the byte after it is copied without being examined. Returns the bytes appended.
pub fn append_unescaped(segment: &[u8], output: &mut Vec<u8>) -> usize {
    let start: usize = output.len();
    let mut index: usize = 0;
    while index < segment.len() {
        let value: u8 = segment[index];
        let escaped: bool = value == ESCAPE_BYTE
            && index >= ESCAPE_ZERO_COUNT
            && index + 1 < segment.len()
            && segment[index - 1] == 0
            && segment[index - 2] == 0
            && segment[index + 1] < ESCAPED_BYTE_LIMIT;
        if escaped {
            output.push(segment[index + 1]);
            index += 2;
            continue;
        }
        output.push(value);
        index += 1;
    }
    output.len() - start
}

#[cfg(test)]
mod tests {
    use super::*;

    const ESCAPED: [u8; 9] = [0, 0, 3, 1, 0, 0, 3, 0, 3];
    // The second 3 escapes the 0 after it, and the last byte is never an escape
    const UNESCAPED: [u8; 7] = [0, 0, 1, 0, 0, 0, 3];
    const PACKET_WITH_START_CODES: [u8; 12] = [0, 0, 1, 0x0D, 7, 7, 0, 0, 1, 0x0C, 9, 9];

    #[test]
    fn drops_emulation_prevention_bytes_as_vc1_unescape_buffer_does() {
        let mut output: Vec<u8> = Vec::new();
        assert_eq!(append_unescaped(&ESCAPED, &mut output), UNESCAPED.len());
        assert_eq!(output, UNESCAPED);
    }

    #[test]
    fn finds_start_codes_whose_type_byte_is_inside_the_packet() {
        assert!(starts_with_start_code(&PACKET_WITH_START_CODES));
        assert_eq!(find_start_code(&PACKET_WITH_START_CODES, 0), 0);
        assert_eq!(find_start_code(&PACKET_WITH_START_CODES, START_CODE_LENGTH), 6);
        assert_eq!(find_start_code(&PACKET_WITH_START_CODES[..9], START_CODE_LENGTH), 9);
    }
}
