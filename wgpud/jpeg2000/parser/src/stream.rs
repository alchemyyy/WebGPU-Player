// A byte range read as FFmpeg's bytestream2 reads it: reads past the end return zero and leave the position at the end,
// and peeks never move. Tier-2 switches between such ranges of one arena (the codestream, its packed packet headers),
// as FFmpeg's decoder reassigns its byte context.

/// A position and end within an arena; copied freely, as FFmpeg copies its byte contexts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ByteStream {
    pub position: usize,
    pub end: usize,
}

impl ByteStream {
    pub fn new(position: usize, end: usize) -> Self {
        Self { position, end: end.max(position) }
    }

    pub fn bytes_left(&self) -> usize {
        self.end - self.position
    }

    /// Reads a byte, or 0 at the end.
    pub fn read_u8(&mut self, arena: &[u8]) -> u8 {
        if self.position >= self.end {
            self.position = self.end;
            return 0;
        }
        let value: u8 = arena.get(self.position).copied().unwrap_or(0);
        self.position += 1;
        value
    }

    /// Reads a big-endian 16-bit value, or 0 when fewer than 2 bytes are left.
    pub fn read_u16(&mut self, arena: &[u8]) -> u16 {
        if self.bytes_left() < 2 {
            self.position = self.end;
            return 0;
        }
        let high: u16 = u16::from(self.read_u8(arena));
        let low: u16 = u16::from(self.read_u8(arena));
        (high << 8) | low
    }

    /// Reads a big-endian 32-bit value, or 0 when fewer than 4 bytes are left.
    pub fn read_u32(&mut self, arena: &[u8]) -> u32 {
        if self.bytes_left() < 4 {
            self.position = self.end;
            return 0;
        }
        let high: u32 = u32::from(self.read_u16(arena));
        let low: u32 = u32::from(self.read_u16(arena));
        (high << 16) | low
    }

    /// The next byte without moving, or 0 at the end.
    pub fn peek_u8(&self, arena: &[u8]) -> u8 {
        if self.position >= self.end {
            return 0;
        }
        arena.get(self.position).copied().unwrap_or(0)
    }

    /// The next big-endian 16-bit value without moving, or 0 when fewer than 2 bytes are left.
    pub fn peek_u16(&self, arena: &[u8]) -> u16 {
        let mut copy: ByteStream = *self;
        copy.read_u16(arena)
    }

    /// The next big-endian 32-bit value without moving, or 0 when fewer than 4 bytes are left.
    pub fn peek_u32(&self, arena: &[u8]) -> u32 {
        let mut copy: ByteStream = *self;
        copy.read_u32(arena)
    }

    /// Skips up to `count` bytes, stopping at the end.
    pub fn skip(&mut self, count: usize) {
        self.position = self.position.saturating_add(count).min(self.end);
    }

    /// Moves to an absolute position, clamped to the range's end.
    pub fn seek(&mut self, position: usize) {
        self.position = position.min(self.end);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BYTES: [u8; 5] = [0x12, 0x34, 0x56, 0x78, 0x9A];

    #[test]
    fn reads_big_endian_values_and_zero_past_the_end() {
        let mut stream: ByteStream = ByteStream::new(0, BYTES.len());
        assert_eq!(stream.read_u16(&BYTES), 0x1234);
        assert_eq!(stream.peek_u16(&BYTES), 0x5678);
        assert_eq!(stream.read_u16(&BYTES), 0x5678);
        assert_eq!(stream.read_u16(&BYTES), 0);
        assert_eq!(stream.bytes_left(), 0);
        assert_eq!(stream.read_u8(&BYTES), 0);
    }

    #[test]
    fn reads_only_within_its_range() {
        let mut stream: ByteStream = ByteStream::new(1, 3);
        assert_eq!(stream.read_u32(&BYTES), 0);
        assert_eq!(stream.position, 3);
        let mut skipping: ByteStream = ByteStream::new(0, 2);
        skipping.skip(10);
        assert_eq!(skipping.position, 2);
    }
}
