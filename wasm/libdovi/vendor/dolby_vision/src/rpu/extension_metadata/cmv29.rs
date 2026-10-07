use anyhow::{Result, ensure};
use bitvec_helpers::bitstream_io_reader::BsIoSliceReader;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

use super::WithExtMetadataBlocks;
use crate::rpu::extension_metadata::blocks::*;

#[derive(Debug, Default, Clone)]
#[cfg_attr(feature = "serde", derive(Deserialize, Serialize))]
pub struct CmV29DmData {
    num_ext_blocks: u64,
    ext_metadata_blocks: Vec<ExtMetadataBlock>,
}

impl WithExtMetadataBlocks for CmV29DmData {
    const VERSION: &'static str = "CM v2.9";
    const ALLOWED_BLOCK_LEVELS: &'static [u8] = &[1, 2, 4, 5, 6, 255];

    fn with_blocks_allocation(num_ext_blocks: u64) -> Self {
        Self {
            ext_metadata_blocks: Vec::with_capacity(num_ext_blocks as usize),
            ..Default::default()
        }
    }

    fn set_num_ext_blocks(&mut self, num_ext_blocks: u64) {
        self.num_ext_blocks = num_ext_blocks;
    }

    fn num_ext_blocks(&self) -> u64 {
        self.num_ext_blocks
    }

    fn blocks_ref(&self) -> &Vec<ExtMetadataBlock> {
        self.ext_metadata_blocks.as_ref()
    }

    fn blocks_mut(&mut self) -> &mut Vec<ExtMetadataBlock> {
        self.ext_metadata_blocks.as_mut()
    }

    fn parse_block(
        ext_block_level: u8,
        _ext_block_length: u64,
        reader: &mut BsIoSliceReader,
    ) -> Option<ExtMetadataBlock> {
        let ext_metadata_block = match ext_block_level {
            1 => level1::ExtMetadataBlockLevel1::parse(reader),
            2 => level2::ExtMetadataBlockLevel2::parse(reader),
            4 => level4::ExtMetadataBlockLevel4::parse(reader),
            5 => level5::ExtMetadataBlockLevel5::parse(reader),
            6 => level6::ExtMetadataBlockLevel6::parse(reader),
            255 => level255::ExtMetadataBlockLevel255::parse(reader),
            // Unknown and CM v4.0 levels, which FFmpeg's parse_ext_v1 skips
            _ => return None,
        };

        // A payload too short for the level's fields is skipped like an unknown level
        ext_metadata_block.ok()
    }
}

impl CmV29DmData {
    pub fn replace_level2_block(&mut self, block: &ExtMetadataBlockLevel2) {
        let blocks = self.blocks_mut();

        let existing_idx = blocks.iter().position(|b| match b {
            ExtMetadataBlock::Level2(b) => b.target_max_pq == block.target_max_pq,
            _ => false,
        });

        // Replace or add level 2 block
        if let Some(i) = existing_idx {
            blocks[i] = ExtMetadataBlock::Level2(block.clone());
        } else {
            blocks.push(ExtMetadataBlock::Level2(block.clone()));
        }

        self.update_extension_block_info();
    }

    /// Validates that every block is a CM v2.9 level.
    /// The specification's per-level block counts are not enforced, as FFmpeg does not enforce them
    pub fn validate(&self) -> Result<()> {
        let blocks = self.blocks_ref();

        let invalid_blocks_count = blocks
            .iter()
            .filter(|b| !Self::ALLOWED_BLOCK_LEVELS.contains(&b.level()))
            .count();

        ensure!(
            invalid_blocks_count == 0,
            "Only allowed blocks level 1, 2, 4, 5, 6, and 255"
        );

        Ok(())
    }
}
