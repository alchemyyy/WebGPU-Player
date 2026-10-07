use anyhow::{Result, ensure};
use bitvec_helpers::bitstream_io_reader::BsIoSliceReader;

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

use super::WithExtMetadataBlocks;
use crate::rpu::extension_metadata::blocks::*;

#[derive(Debug, Default, Clone)]
#[cfg_attr(feature = "serde", derive(Deserialize, Serialize))]
pub struct CmV40DmData {
    num_ext_blocks: u64,
    ext_metadata_blocks: Vec<ExtMetadataBlock>,
}

impl WithExtMetadataBlocks for CmV40DmData {
    const VERSION: &'static str = "CM v4.0";
    const ALLOWED_BLOCK_LEVELS: &'static [u8] = &[3, 8, 9, 10, 11, 254];

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
        ext_block_length: u64,
        reader: &mut BsIoSliceReader,
    ) -> Option<ExtMetadataBlock> {
        let ext_metadata_block = match ext_block_level {
            3 => level3::ExtMetadataBlockLevel3::parse(reader),
            8 => level8::ExtMetadataBlockLevel8::parse(reader, ext_block_length),
            9 => level9::ExtMetadataBlockLevel9::parse(reader, ext_block_length),
            10 => level10::ExtMetadataBlockLevel10::parse(reader, ext_block_length),
            11 => level11::ExtMetadataBlockLevel11::parse(reader),
            254 => level254::ExtMetadataBlockLevel254::parse(reader),
            // Unknown and CM v2.9 levels, which FFmpeg's parse_ext_v2 skips
            _ => return None,
        };

        // A payload too short for the level's fields, or an L8, L9, or L10 length without a
        // defined layout, is skipped like an unknown level
        ext_metadata_block.ok()
    }
}

impl CmV40DmData {
    pub fn replace_level8_block(&mut self, block: &ExtMetadataBlockLevel8) {
        let blocks = self.blocks_mut();

        let existing_idx = blocks.iter().position(|b| match b {
            ExtMetadataBlock::Level8(b) => b.target_display_index == block.target_display_index,
            _ => false,
        });

        // Replace or add level 8 block
        if let Some(i) = existing_idx {
            blocks[i] = ExtMetadataBlock::Level8(block.clone());
        } else {
            blocks.push(ExtMetadataBlock::Level8(block.clone()));
        }

        self.update_extension_block_info();
    }

    pub fn replace_level10_block(&mut self, block: &ExtMetadataBlockLevel10) {
        let blocks = self.blocks_mut();

        let existing_idx = blocks.iter().position(|b| match b {
            ExtMetadataBlock::Level10(b) => b.target_display_index == block.target_display_index,
            _ => false,
        });

        // Replace or add level 10 block
        if let Some(i) = existing_idx {
            blocks[i] = ExtMetadataBlock::Level10(block.clone());
        } else {
            blocks.push(ExtMetadataBlock::Level10(block.clone()));
        }

        self.update_extension_block_info();
    }

    /// Validates that every block is a CM v4.0 level.
    /// The specification's single L254 block and per-level block counts are not enforced,
    /// as FFmpeg does not enforce them
    pub fn validate(&self) -> Result<()> {
        let blocks = self.blocks_ref();

        let invalid_blocks_count = blocks
            .iter()
            .filter(|b| !Self::ALLOWED_BLOCK_LEVELS.contains(&b.level()))
            .count();

        ensure!(
            invalid_blocks_count == 0,
            "Only allowed blocks level 3, 8, 9, 10, 11 and 254"
        );

        Ok(())
    }

    pub fn new_with_l254_402() -> Self {
        Self {
            num_ext_blocks: 1,
            ext_metadata_blocks: vec![ExtMetadataBlock::Level254(
                ExtMetadataBlockLevel254::cmv402_default(),
            )],
        }
    }

    /// Creates CMv4.0 DM data with default static blocks: L3, L9, L11, L254.
    pub fn default_safe() -> Self {
        let ext_metadata_blocks = vec![
            ExtMetadataBlock::Level3(ExtMetadataBlockLevel3::default()),
            ExtMetadataBlock::Level9(ExtMetadataBlockLevel9::default_dci_p3()),
            ExtMetadataBlock::Level254(ExtMetadataBlockLevel254::cmv402_default()),
            ExtMetadataBlock::Level11(ExtMetadataBlockLevel11::default_cinema()),
        ];

        Self {
            num_ext_blocks: ext_metadata_blocks.len() as u64,
            ext_metadata_blocks,
        }
    }

    pub fn new_with_custom_l254(level254: &ExtMetadataBlockLevel254) -> Self {
        Self {
            num_ext_blocks: 1,
            ext_metadata_blocks: vec![ExtMetadataBlock::Level254(level254.clone())],
        }
    }
}
