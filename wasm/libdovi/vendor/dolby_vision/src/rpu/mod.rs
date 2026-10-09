use crc::{CRC_32_MPEG_2, Crc, Table};

pub mod dovi_rpu;
pub mod extension_metadata;
pub mod generate;
pub mod profiles;
pub mod rpu_data_header;
pub mod rpu_data_mapping;
pub mod rpu_data_nlq;
pub mod vdr_dm_data;

pub mod utils;

static CRC32_INSTANCE: Crc<u32, Table<16>> = Crc::<u32, Table<16>>::new(&CRC_32_MPEG_2);

pub const NUM_COMPONENTS: usize = 3;

pub(crate) const MMR_MAX_COEFFS: usize = 7;
pub(crate) const NLQ_NUM_PIVOTS: usize = 2;

/// RPU syntax with no known payload layout, which FFmpeg also rejects as unimplemented.
/// Parsing stops at the first such field, so callers can tell it from malformed data
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum UnsupportedRpuSyntax {
    /// `vdr_seq_info_present_flag` is 0, so the bit depths and coefficient format are absent
    MissingSequenceInfo,
    /// `rpu_format & 0x700` is nonzero, so the bit depths are absent
    RpuFormat(u16),
    /// Display metadata compression methods 2 through 7
    DmCompression(u8),
}

impl std::fmt::Display for UnsupportedRpuSyntax {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UnsupportedRpuSyntax::MissingSequenceInfo => {
                write!(f, "RPU without VDR sequence info is unsupported")
            }
            UnsupportedRpuSyntax::RpuFormat(rpu_format) => {
                write!(f, "RPU format {rpu_format:#05X} is unsupported")
            }
            UnsupportedRpuSyntax::DmCompression(method) => {
                write!(f, "DM metadata compression method {method} is unsupported")
            }
        }
    }
}

impl std::error::Error for UnsupportedRpuSyntax {}

#[derive(Default, Debug, Copy, Clone, PartialEq, Eq)]
pub enum ConversionMode {
    #[default]
    Lossless = 0,
    ToMel,
    To81,
    To84,
    To81MappingPreserved,
}

#[inline(always)]
fn compute_crc32(data: &[u8]) -> u32 {
    CRC32_INSTANCE.checksum(data)
}

impl From<u8> for ConversionMode {
    fn from(mode: u8) -> ConversionMode {
        match mode {
            0 => ConversionMode::Lossless,
            1 => ConversionMode::ToMel,
            2 | 3 => ConversionMode::To81,
            4 => ConversionMode::To84,
            _ => ConversionMode::Lossless,
        }
    }
}

impl std::fmt::Display for ConversionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConversionMode::Lossless => write!(f, "Lossless"),
            ConversionMode::ToMel => write!(f, "To MEL"),
            ConversionMode::To81 => write!(f, "To 8.1"),
            ConversionMode::To84 => write!(f, "To 8.4"),
            ConversionMode::To81MappingPreserved => {
                write!(f, "To 8.1, preserving the mapping metadata")
            }
        }
    }
}
