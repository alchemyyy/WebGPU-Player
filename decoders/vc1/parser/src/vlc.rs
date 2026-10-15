// Variable-length code lookups: every code table becomes a multi-level table of 32-bit entries, which a 32-bit window of the
// bitstream indexes level by level. An entry is a leaf, a symbol and the bits its level consumed, or a pointer to a subtable for
// longer codes; a bit pattern no code starts reads as no symbol.
// The lookups are built once per module instance from the code tables, as the WGSL decoder's lookups were built from the same codes.

use std::sync::OnceLock;

use crate::intrax8_tables::{X8_AC, X8_DC, X8_ORIENT};
use crate::tables::{
    AC_COEFFICIENTS, BITPLANE_MODE, CBPCY_P, CodeTable, DC_DIFFERENTIAL, FOUR_MV_BLOCK_PATTERN, INTERLACED_CBPCY, INTERLACED_FIELD_1MV_MBMODE,
    INTERLACED_FIELD_MIXED_MBMODE, INTERLACED_FRAME_4MV_MBMODE, INTERLACED_FRAME_NON4MV_MBMODE, INTRA_CBPCY, MV_DIFFERENTIAL, NORM2, NORM6,
    ONE_REFERENCE_MVDATA, SUBBLOCK_PATTERN, TTBLK, TTMB, TWO_MV_BLOCK_PATTERN, TWO_REFERENCE_MVDATA,
};

/// The symbol a read returns for a bit pattern no code starts; no table's symbols take it.
pub const INVALID_SYMBOL: u32 = 0xFFFF;

// An index no code reaches
const INVALID_ENTRY: u32 = 0;
// Marks an entry that points to a subtable instead of holding a symbol
const SUBTABLE_FLAG: u32 = 0x8000_0000;
// A leaf's code length within its level, above the symbol
const LENGTH_SHIFT: u32 = 16;
const LENGTH_MASK: u32 = 0x1F;
const SYMBOL_MASK: u32 = 0xFFFF;
// A pointer's subtable index width less one, and its offset from the table's first entry
const SUBTABLE_BITS_SHIFT: u32 = 24;
const SUBTABLE_BITS_MASK: u32 = 0x7;
const OFFSET_MASK: u32 = 0xF_FFFF;
// The widest index of any level; each level is as narrow as its codes allow
const MAXIMUM_INDEX_BITS: u32 = 8;
const WINDOW_BITS: u32 = 32;

/// A code still to place in a level: its remaining bits, right-aligned, their count, and its symbol.
#[derive(Clone, Copy)]
struct PendingCode {
    code: u32,
    length: u32,
    symbol: u32,
}

/// A level still to fill: its first entry, the bits it indexes, and its codes.
struct PendingLevel {
    base: usize,
    index_bits: u32,
    codes: Vec<PendingCode>,
}

/// One code table's lookup: its entries and the bits its root level indexes.
pub struct VLCLookup {
    entries: Vec<u32>,
    root_bits: u32,
}

impl VLCLookup {
    /// Builds the lookup of a prefix-free code table; the tables are the verified decoder's, so a conflict is a bug.
    pub fn new(table: &CodeTable) -> Self {
        let codes: Vec<PendingCode> = table
            .codes
            .iter()
            .zip(table.lengths)
            .enumerate()
            .map(|(index, (&code, &length)): (usize, (&u32, &u8))| PendingCode {
                code,
                length: u32::from(length),
                symbol: table.symbols.get(index).map_or(index as u32, |&symbol: &u16| u32::from(symbol)),
            })
            .collect();
        let root_bits: u32 = codes.iter().map(|pending: &PendingCode| pending.length).max().unwrap_or(1).min(MAXIMUM_INDEX_BITS);
        let mut entries: Vec<u32> = vec![INVALID_ENTRY; 1 << root_bits];
        let mut levels: Vec<PendingLevel> = vec![PendingLevel { base: 0, index_bits: root_bits, codes }];
        while let Some(level) = levels.pop() {
            let mut longer_codes: Vec<(u32, Vec<PendingCode>)> = Vec::new();
            for pending in level.codes {
                if pending.length <= level.index_bits {
                    let first: usize = (pending.code << (level.index_bits - pending.length)) as usize;
                    let count: usize = 1 << (level.index_bits - pending.length);
                    for entry in &mut entries[level.base + first..level.base + first + count] {
                        assert_eq!(*entry, INVALID_ENTRY, "symbol {} is a prefix of another code", pending.symbol);
                        *entry = (pending.length << LENGTH_SHIFT) | pending.symbol;
                    }
                    continue;
                }
                let remaining_length: u32 = pending.length - level.index_bits;
                let prefix: u32 = pending.code >> remaining_length;
                let remainder: PendingCode = PendingCode { code: pending.code & ((1 << remaining_length) - 1), length: remaining_length, symbol: pending.symbol };
                match longer_codes.iter_mut().find(|(group_prefix, _): &&mut (u32, Vec<PendingCode>)| *group_prefix == prefix) {
                    Some((_, group)) => group.push(remainder),
                    None => longer_codes.push((prefix, vec![remainder])),
                }
            }
            for (prefix, group) in longer_codes {
                let index_bits: u32 = group.iter().map(|pending: &PendingCode| pending.length).max().unwrap_or(1).min(MAXIMUM_INDEX_BITS);
                let base: usize = entries.len();
                entries.resize(base + (1 << index_bits), INVALID_ENTRY);
                let pointer: &mut u32 = &mut entries[level.base + prefix as usize];
                assert_eq!(*pointer, INVALID_ENTRY, "a code extends another code");
                *pointer = SUBTABLE_FLAG | ((index_bits - 1) << SUBTABLE_BITS_SHIFT) | base as u32;
                levels.push(PendingLevel { base, index_bits, codes: group });
            }
        }
        assert!(entries.len() <= OFFSET_MASK as usize, "a lookup of {} entries exceeds its offsets", entries.len());
        Self { entries, root_bits }
    }

    /// Decodes the code at the top of a left-aligned 32-bit window: its symbol and its length, or None for a pattern no code starts.
    pub fn decode(&self, window: u32) -> Option<(u32, u32)> {
        let mut index_bits: u32 = self.root_bits;
        let mut consumed: u32 = 0;
        let mut entry: u32 = self.entries[(window >> (WINDOW_BITS - index_bits)) as usize];
        while entry & SUBTABLE_FLAG != 0 {
            consumed += index_bits;
            index_bits = ((entry >> SUBTABLE_BITS_SHIFT) & SUBTABLE_BITS_MASK) + 1;
            let remaining: u32 = window << consumed;
            entry = self.entries[(entry & OFFSET_MASK) as usize + (remaining >> (WINDOW_BITS - index_bits)) as usize];
        }
        let length: u32 = (entry >> LENGTH_SHIFT) & LENGTH_MASK;
        if length == 0 {
            return None;
        }
        Some((entry & SYMBOL_MASK, consumed + length))
    }
}

fn build_lookups<const COUNT: usize>(tables: &[CodeTable; COUNT]) -> [VLCLookup; COUNT] {
    std::array::from_fn(|index: usize| VLCLookup::new(&tables[index]))
}

/// Every code lookup of the parser.
pub struct Lookups {
    pub bitplane_mode: VLCLookup,
    pub norm2: VLCLookup,
    pub norm6: VLCLookup,
    pub intra_cbpcy: VLCLookup,
    pub cbpcy_p: [VLCLookup; 4],
    pub interlaced_cbpcy: [VLCLookup; 8],
    pub ttmb: [VLCLookup; 3],
    pub ttblk: [VLCLookup; 3],
    pub subblock_pattern: [VLCLookup; 3],
    pub mv_differential: [VLCLookup; 4],
    pub four_mv_block_pattern: [VLCLookup; 4],
    pub two_mv_block_pattern: [VLCLookup; 4],
    pub interlaced_frame_4mv_mbmode: [VLCLookup; 4],
    pub interlaced_frame_non4mv_mbmode: [VLCLookup; 4],
    pub interlaced_field_mixed_mbmode: [VLCLookup; 8],
    pub interlaced_field_1mv_mbmode: [VLCLookup; 8],
    pub one_reference_mvdata: [VLCLookup; 4],
    pub two_reference_mvdata: [VLCLookup; 8],
    pub dc_differential: [VLCLookup; 4],
    pub ac_coefficients: [VLCLookup; 8],
    pub x8_orient: [VLCLookup; 6],
    pub x8_dc: [VLCLookup; 16],
    pub x8_ac: [VLCLookup; 32],
}

impl Lookups {
    fn new() -> Self {
        Self {
            bitplane_mode: VLCLookup::new(&BITPLANE_MODE),
            norm2: VLCLookup::new(&NORM2),
            norm6: VLCLookup::new(&NORM6),
            intra_cbpcy: VLCLookup::new(&INTRA_CBPCY),
            cbpcy_p: build_lookups(&CBPCY_P),
            interlaced_cbpcy: build_lookups(&INTERLACED_CBPCY),
            ttmb: build_lookups(&TTMB),
            ttblk: build_lookups(&TTBLK),
            subblock_pattern: build_lookups(&SUBBLOCK_PATTERN),
            mv_differential: build_lookups(&MV_DIFFERENTIAL),
            four_mv_block_pattern: build_lookups(&FOUR_MV_BLOCK_PATTERN),
            two_mv_block_pattern: build_lookups(&TWO_MV_BLOCK_PATTERN),
            interlaced_frame_4mv_mbmode: build_lookups(&INTERLACED_FRAME_4MV_MBMODE),
            interlaced_frame_non4mv_mbmode: build_lookups(&INTERLACED_FRAME_NON4MV_MBMODE),
            interlaced_field_mixed_mbmode: build_lookups(&INTERLACED_FIELD_MIXED_MBMODE),
            interlaced_field_1mv_mbmode: build_lookups(&INTERLACED_FIELD_1MV_MBMODE),
            one_reference_mvdata: build_lookups(&ONE_REFERENCE_MVDATA),
            two_reference_mvdata: build_lookups(&TWO_REFERENCE_MVDATA),
            dc_differential: build_lookups(&DC_DIFFERENTIAL),
            ac_coefficients: build_lookups(&AC_COEFFICIENTS),
            x8_orient: build_lookups(&X8_ORIENT),
            x8_dc: build_lookups(&X8_DC),
            x8_ac: build_lookups(&X8_AC),
        }
    }
}

/// The lookups, built at their first use.
pub fn lookups() -> &'static Lookups {
    static LOOKUPS: OnceLock<Lookups> = OnceLock::new();
    LOOKUPS.get_or_init(Lookups::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A small prefix code with a code longer than one level: 0, 10, 110, and 111 followed by nine bits
    const LONG_CODE: u32 = 0b1110_0000_0011;
    const LONG_CODE_SYMBOL: u32 = 3;
    const LONG_CODE_LENGTH: u32 = 12;
    // 111 followed by nine bits other than the long code's
    const UNCODED_PATTERN: u32 = 0b1111_1111_1111;
    const SHORT_CODES: [u32; 4] = [0b0, 0b10, 0b110, LONG_CODE];
    const SHORT_LENGTHS: [u8; 4] = [1, 2, 3, LONG_CODE_LENGTH as u8];

    fn window_of(code: u32, length: u32) -> u32 {
        code << (WINDOW_BITS - length)
    }

    #[test]
    fn decodes_every_code_of_a_table_with_a_subtable_and_refuses_patterns_no_code_starts() {
        let table: CodeTable = CodeTable { codes: &SHORT_CODES, lengths: &SHORT_LENGTHS, symbols: &[] };
        let lookup: VLCLookup = VLCLookup::new(&table);
        for (symbol, (&code, &length)) in SHORT_CODES.iter().zip(&SHORT_LENGTHS).enumerate() {
            assert_eq!(lookup.decode(window_of(code, u32::from(length))), Some((symbol as u32, u32::from(length))));
        }
        assert_eq!(lookup.decode(window_of(LONG_CODE, LONG_CODE_LENGTH)), Some((LONG_CODE_SYMBOL, LONG_CODE_LENGTH)));
        assert_eq!(lookup.decode(window_of(UNCODED_PATTERN, LONG_CODE_LENGTH)), None);
    }

    #[test]
    fn decodes_every_symbol_of_every_parser_table() {
        let all: &Lookups = lookups();
        let groups: [(&[CodeTable], &[VLCLookup]); 4] = [
            (&AC_COEFFICIENTS, &all.ac_coefficients),
            (&DC_DIFFERENTIAL, &all.dc_differential),
            (&TWO_REFERENCE_MVDATA, &all.two_reference_mvdata),
            (&X8_AC, &all.x8_ac),
        ];
        for (tables, group_lookups) in groups {
            for (table, lookup) in tables.iter().zip(group_lookups) {
                for (index, (&code, &length)) in table.codes.iter().zip(table.lengths).enumerate() {
                    let symbol: u32 = table.symbols.get(index).map_or(index as u32, |&symbol: &u16| u32::from(symbol));
                    assert_eq!(lookup.decode(window_of(code, u32::from(length))), Some((symbol, u32::from(length))));
                }
            }
        }
    }
}
