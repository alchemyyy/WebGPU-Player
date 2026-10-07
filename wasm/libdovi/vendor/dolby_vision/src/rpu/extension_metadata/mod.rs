use anyhow::{Context, Result, ensure};
use bitvec_helpers::{
    bitstream_io_reader::BsIoSliceReader, bitstream_io_writer::BitstreamIoWriter,
};

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

pub mod blocks;
pub mod cmv29;
pub mod cmv40;

pub mod primaries;
pub use primaries::*;

pub use cmv29::CmV29DmData;
pub use cmv40::CmV40DmData;

use blocks::ExtMetadataBlock;

/// FFmpeg's AV_DOVI_MAX_EXT_BLOCKS; larger coded counts still parse, without preallocating
const MAXIMUM_PREALLOCATED_EXTENSION_BLOCKS: u64 = 32;

/// FFmpeg's ff_dovi_rpu_extension_is_static: levels that a compressed RPU reuses from the
/// last uncompressed RPU instead of carrying them
fn is_static_extension_level(level: u8) -> bool {
    matches!(level, 6 | 10 | 32 | 254 | 255)
}

/// Reads the coded payload of one extension block, which must end before the trailing bits
/// that follow the metadata, such as an RPU's CRC32 and terminator
fn read_extension_block_payload(
    reader: &mut BsIoSliceReader,
    ext_block_length: u64,
    trailing_bits: u64,
) -> Result<Vec<u8>> {
    let payload_bits = reader.available()?.saturating_sub(trailing_bits);
    ensure!(
        ext_block_length
            .checked_mul(8)
            .is_some_and(|length_bits| length_bits <= payload_bits),
        "Extension block length {ext_block_length} runs past the metadata payload"
    );

    let mut payload = vec![0; ext_block_length as usize];
    reader.read_bytes(&mut payload)?;

    Ok(payload)
}

#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(Deserialize, Serialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum DmData {
    V29(CmV29DmData),
    V40(CmV40DmData),
}

pub trait ExtMetadata {
    fn parse(&mut self, reader: &mut BsIoSliceReader) -> Result<()>;
    fn write(&self, writer: &mut BitstreamIoWriter);
}

pub trait WithExtMetadataBlocks {
    const VERSION: &'static str;
    const ALLOWED_BLOCK_LEVELS: &'static [u8];

    fn with_blocks_allocation(num_ext_blocks: u64) -> Self;

    fn set_num_ext_blocks(&mut self, num_ext_blocks: u64);
    fn num_ext_blocks(&self) -> u64;

    /// Parses a block of a level this CM version defines from the block's own coded payload.
    /// Returns None for any other level, or when the payload is too short for the level's fields
    fn parse_block(
        ext_block_level: u8,
        ext_block_length: u64,
        reader: &mut BsIoSliceReader,
    ) -> Option<ExtMetadataBlock>;
    fn blocks_ref(&self) -> &Vec<ExtMetadataBlock>;
    fn blocks_mut(&mut self) -> &mut Vec<ExtMetadataBlock>;

    fn sort_blocks(&mut self) {
        let blocks = self.blocks_mut();
        blocks.sort_by_key(|ext| ext.sort_key());
    }

    fn update_extension_block_info(&mut self) {
        self.set_num_ext_blocks(self.blocks_ref().len() as u64);
        self.sort_blocks();
    }

    fn add_block(&mut self, meta: ExtMetadataBlock) -> Result<()> {
        let level = meta.level();

        ensure!(
            Self::ALLOWED_BLOCK_LEVELS.contains(&level),
            "Metadata block level {level} is not allowed"
        );

        let blocks = self.blocks_mut();
        blocks.push(meta);

        self.update_extension_block_info();

        Ok(())
    }

    fn remove_level(&mut self, level: u8) {
        let blocks = self.blocks_mut();
        blocks.retain(|b| b.level() != level);

        self.update_extension_block_info();
    }

    fn write(&self, writer: &mut BitstreamIoWriter) -> Result<()> {
        let num_ext_blocks = self.num_ext_blocks();

        writer.write_ue(num_ext_blocks)?;

        // dm_alignment_zero_bit
        writer.byte_align()?;

        let ext_metadata_blocks = self.blocks_ref();

        for ext_metadata_block in ext_metadata_blocks {
            let level = ext_metadata_block.level();
            let remaining_bits =
                (ext_metadata_block.length_bits() - ext_metadata_block.required_bits()) as u32;

            writer.write_ue(ext_metadata_block.length_bytes())?;
            writer.write::<8, u8>(level)?;

            ext_metadata_block
                .write(writer)
                .with_context(|| format!("Level {level}"))?;

            // ext_dm_alignment_zero_bit
            writer.pad(remaining_bits)?;
        }

        Ok(())
    }
}

impl DmData {
    /// Parses one CM section the way FFmpeg's parse_ext_blocks does: every block is framed by its
    /// coded length, a known level is kept, and any other block is skipped. `compressed` drops
    /// static levels, and `trailing_bits` follow the metadata and bound every block payload
    pub(crate) fn parse<T: WithExtMetadataBlocks + Default>(
        reader: &mut BsIoSliceReader,
        compressed: bool,
        trailing_bits: u64,
    ) -> Result<Option<T>> {
        let num_ext_blocks = reader.read_ue()?;
        let mut meta =
            T::with_blocks_allocation(num_ext_blocks.min(MAXIMUM_PREALLOCATED_EXTENSION_BLOCKS));

        // dm_alignment_zero_bit, which FFmpeg skips without checking
        while !reader.byte_aligned() {
            reader.read_bit()?;
        }

        for _ in 0..num_ext_blocks {
            let ext_block_length = reader.read_ue()?;
            let ext_block_level = reader.read::<8, u8>()?;
            let payload = read_extension_block_payload(reader, ext_block_length, trailing_bits)?;

            // A block parses only from its own payload, so it never reads into the next one,
            // and its ext_dm_alignment_zero_bit padding is skipped whatever its value
            let mut payload_reader = BsIoSliceReader::from_slice(&payload);
            let block = T::parse_block(ext_block_level, ext_block_length, &mut payload_reader);
            if let Some(block) = block
                && !(compressed && is_static_extension_level(ext_block_level))
            {
                meta.blocks_mut().push(block);
            }
        }

        // The count covers only kept blocks, so writing the section back stays consistent
        let kept_block_count = meta.blocks_ref().len() as u64;
        meta.set_num_ext_blocks(kept_block_count);

        Ok(Some(meta))
    }

    pub fn write(&self, writer: &mut BitstreamIoWriter) -> Result<()> {
        match self {
            DmData::V29(m) => m.write(writer),
            DmData::V40(m) => m.write(writer),
        }
    }

    pub fn validate(&self) -> Result<()> {
        match self {
            DmData::V29(m) => m.validate(),
            DmData::V40(m) => m.validate(),
        }
    }
}
