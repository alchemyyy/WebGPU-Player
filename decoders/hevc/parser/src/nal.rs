// NAL unit iteration over the codec private data or a packet, in one of three framings.

use crate::error::{DecodeResult, fail};
use crate::layout::{ERROR_CONFIGURATION, ERROR_NAL_LENGTH};

// Bytes of an hvcC header before its arrays
const HVCC_ARRAYS_OFFSET: usize = 23;
const HVCC_LENGTH_SIZE_OFFSET: usize = 21;
const HVCC_VERSION: u8 = 1;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Framing {
    /// An HEVCDecoderConfigurationRecord's arrays
    Record,
    LengthPrefixed,
    AnnexB,
}

/// The first byte after the next 00 00 01 start code at or after start, or the end when there is none.
fn find_start_code(bytes: &[u8], start: usize) -> usize {
    let mut zero_count: u32 = 0;
    for position in start..bytes.len() {
        let value: u8 = bytes[position];
        if value == 1 && zero_count >= 2 {
            return position + 1;
        }
        zero_count = if value == 0 { zero_count + 1 } else { 0 };
    }
    bytes.len()
}

/// Whether the packet is a sequence of nonempty NAL units with length_size-byte lengths that ends at its last byte.
fn are_length_prefixes_valid(bytes: &[u8], length_size: usize) -> bool {
    let mut position: usize = 0;
    loop {
        if position == bytes.len() {
            return true;
        }
        if position + length_size > bytes.len() {
            return false;
        }
        let length: usize = read_length(bytes, position, length_size);
        position += length_size;
        if length == 0 || length > bytes.len() - position {
            return false;
        }
        position += length;
    }
}

fn read_length(bytes: &[u8], position: usize, length_size: usize) -> usize {
    let mut length: usize = 0;
    for index in 0..length_size {
        length = (length << 8) | usize::from(bytes[position + index]);
    }
    length
}

/// Iterates the NAL units of a codec private record or Annex B stream, or of a packet.
pub struct NALUnits<'a> {
    bytes: &'a [u8],
    framing: Framing,
    position: usize,
    length_size: usize,
    record_arrays_left: u32,
    record_units_left: u32,
}

impl<'a> NALUnits<'a> {
    /// Starts on the codec private data: an hvcC record, whose NAL length size it returns, or Annex B, with length size 0.
    pub fn for_configuration(bytes: &'a [u8]) -> (Self, usize) {
        if bytes.len() >= HVCC_ARRAYS_OFFSET && bytes[0] == HVCC_VERSION {
            let length_size: usize = usize::from(bytes[HVCC_LENGTH_SIZE_OFFSET] & 3) + 1;
            let units: Self = Self {
                bytes,
                framing: Framing::Record,
                position: HVCC_ARRAYS_OFFSET,
                length_size,
                record_arrays_left: u32::from(bytes[HVCC_ARRAYS_OFFSET - 1]),
                record_units_left: 0,
            };
            return (units, length_size);
        }
        (Self::annex_b(bytes), 0)
    }

    /// Starts on a packet; length prefixes win when they tile the packet exactly, since a length such as 257 starts like a start code.
    pub fn for_packet(bytes: &'a [u8], length_size: usize) -> Self {
        if length_size > 0 && are_length_prefixes_valid(bytes, length_size) {
            return Self {
                bytes,
                framing: Framing::LengthPrefixed,
                position: 0,
                length_size,
                record_arrays_left: 0,
                record_units_left: 0,
            };
        }
        Self::annex_b(bytes)
    }

    fn annex_b(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            framing: Framing::AnnexB,
            position: find_start_code(bytes, 0),
            length_size: 0,
            record_arrays_left: 0,
            record_units_left: 0,
        }
    }

    /// The next NAL unit as a byte range, or None when the source has no more.
    pub fn next_unit(&mut self) -> DecodeResult<Option<(usize, usize)>> {
        match self.framing {
            Framing::Record => self.next_record_unit(),
            Framing::LengthPrefixed => self.next_length_prefixed_unit(),
            Framing::AnnexB => Ok(self.next_annex_b_unit()),
        }
    }

    fn next_record_unit(&mut self) -> DecodeResult<Option<(usize, usize)>> {
        let end: usize = self.bytes.len();
        while self.record_units_left == 0 {
            if self.record_arrays_left == 0 {
                return Ok(None);
            }
            if self.position + 3 > end {
                return fail(ERROR_CONFIGURATION, self.position as u32);
            }
            self.record_units_left = (u32::from(self.bytes[self.position + 1]) << 8) | u32::from(self.bytes[self.position + 2]);
            self.record_arrays_left -= 1;
            self.position += 3;
        }
        if self.position + 2 > end {
            return fail(ERROR_CONFIGURATION, self.position as u32);
        }
        let start: usize = self.position + 2;
        let unit_end: usize = start + ((usize::from(self.bytes[self.position]) << 8) | usize::from(self.bytes[self.position + 1]));
        if unit_end > end {
            return fail(ERROR_CONFIGURATION, self.position as u32);
        }
        self.record_units_left -= 1;
        self.position = unit_end;
        Ok(Some((start, unit_end)))
    }

    fn next_length_prefixed_unit(&mut self) -> DecodeResult<Option<(usize, usize)>> {
        let end: usize = self.bytes.len();
        if self.position + self.length_size > end {
            return Ok(None);
        }
        let length: usize = read_length(self.bytes, self.position, self.length_size);
        let start: usize = self.position + self.length_size;
        if length > end - start {
            return fail(ERROR_NAL_LENGTH, length as u32);
        }
        self.position = start + length;
        Ok(Some((start, start + length)))
    }

    fn next_annex_b_unit(&mut self) -> Option<(usize, usize)> {
        let end: usize = self.bytes.len();
        if self.position >= end {
            return None;
        }
        let start: usize = self.position;
        let next_start: usize = find_start_code(self.bytes, start);
        // The unit ends before the next start code and the zero bytes leading it
        let mut unit_end: usize = end;
        if next_start < end {
            unit_end = next_start - 3;
            while unit_end > start && self.bytes[unit_end - 1] == 0 {
                unit_end -= 1;
            }
        }
        self.position = next_start;
        Some((start, unit_end))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANNEX_B: [u8; 12] = [0, 0, 0, 1, 0x40, 0x01, 0, 0, 1, 0x42, 0x01, 0x07];
    const LENGTH_PREFIXED: [u8; 9] = [0, 0, 0, 2, 0x40, 0x01, 0, 0, 0];
    const NAL_LENGTH_SIZE: usize = 4;

    #[test]
    fn splits_annex_b_at_start_codes() {
        let mut units: NALUnits = NALUnits::for_packet(&ANNEX_B, 0);
        assert_eq!(units.next_unit(), Ok(Some((4, 6))));
        assert_eq!(units.next_unit(), Ok(Some((9, 12))));
        assert_eq!(units.next_unit(), Ok(None));
    }

    #[test]
    fn falls_back_to_annex_b_when_lengths_do_not_tile_the_packet() {
        // The trailing 0, 0, 0 is an incomplete length prefix
        let mut units: NALUnits = NALUnits::for_packet(&LENGTH_PREFIXED, NAL_LENGTH_SIZE);
        assert_eq!(units.next_unit(), Ok(None));
        let mut tiled: NALUnits = NALUnits::for_packet(&LENGTH_PREFIXED[..6], NAL_LENGTH_SIZE);
        assert_eq!(tiled.next_unit(), Ok(Some((4, 6))));
        assert_eq!(tiled.next_unit(), Ok(None));
    }
}
