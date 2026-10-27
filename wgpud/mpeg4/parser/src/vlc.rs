// Variable-length code lookups: every code table becomes a multi-level table of 32-bit entries, which a 32-bit window of the
// bitstream indexes level by level. An entry is a leaf, a symbol and the bits its level consumed, or a pointer to a subtable for
// longer codes; a bit pattern no code starts reads as no symbol.
// Run-level tables keep FFmpeg's RLTable: the code of each run, level, and last triple, with the escape code after them.

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
// FFmpeg's MAX_RUN and MAX_LEVEL, the bounds of an RLTable's run and level indexes
pub const MAX_RUN: usize = 64;
pub const MAX_LEVEL: usize = 64;

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
    /// Builds the lookup of a prefix-free code: each entry's code, its length, and its symbol. Codes of length 0, which FFmpeg's tables
    /// use for unused entries, are left out; the tables are FFmpeg's, so a conflict is a bug.
    pub fn new(codes: &[(u32, u32, u32)]) -> Self {
        let codes: Vec<PendingCode> = codes
            .iter()
            .filter(|&&(_, length, _): &&(u32, u32, u32)| length > 0)
            .map(|&(code, length, symbol): &(u32, u32, u32)| PendingCode { code, length, symbol })
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


/// The lookup of a table of (code, length) pairs whose symbol is each pair's index, as FFmpeg's VLC tables of code and bits columns
/// read.
pub fn lookup_from_pairs<T: Copy + Into<u32>>(pairs: &[[T; 2]]) -> VLCLookup {
    let codes: Vec<(u32, u32, u32)> = pairs.iter().enumerate().map(|(index, pair): (usize, &[T; 2])| (pair[0].into(), pair[1].into(), index as u32)).collect();
    VLCLookup::new(&codes)
}

/// FFmpeg's ff_vlc_init_from_lengths: codes assigned in table order, each the next code of its length after the one before it, and
/// symbol i for entry i; entries of length 0 code nothing.
pub fn lookup_from_lengths(lengths: &[u8]) -> VLCLookup {
    lookup_from_lengths_and_symbols(lengths, None)
}

/// ff_vlc_init_from_lengths with a symbol for each entry.
pub fn lookup_from_lengths_and_symbols(lengths: &[u8], symbols: Option<&[u32]>) -> VLCLookup {
    let mut code: u64 = 0;
    let mut entries: Vec<(u32, u32, u32)> = Vec::with_capacity(lengths.len());
    for (index, &length) in lengths.iter().enumerate() {
        if length == 0 {
            continue;
        }
        let length: u32 = u32::from(length);
        let symbol: u32 = symbols.map_or(index as u32, |symbols: &[u32]| symbols[index]);
        entries.push(((code >> (WINDOW_BITS - length)) as u32, length, symbol));
        code += 1 << (WINDOW_BITS - length);
    }
    VLCLookup::new(&entries)
}

/// The lookup of separate code and length columns whose symbol is each entry's index.
pub fn lookup_from_columns<C: Copy + Into<u32>, L: Copy + Into<u32>>(codes: &[C], lengths: &[L]) -> VLCLookup {
    let entries: Vec<(u32, u32, u32)> =
        codes.iter().zip(lengths).enumerate().map(|(index, (&code, &length)): (usize, (&C, &L))| (code.into(), length.into(), index as u32)).collect();
    VLCLookup::new(&entries)
}

/// FFmpeg's RLTable: n codes of run, level, and last triples, the codes from `last` on ending a block, then the escape code, symbol n.
/// max_level and max_run are ff_rl_init's, indexed by last.
pub struct RLTable {
    pub n: usize,
    pub last: usize,
    pub table_run: &'static [i8],
    pub table_level: &'static [i8],
    pub lookup: VLCLookup,
    pub max_level: [[i8; MAX_RUN + 1]; 2],
    pub max_run: [[i8; MAX_LEVEL + 1]; 2],
}

/// One decoded run-level code: FFmpeg's escape code, or a run, level, and last of the table; level and run are the table's, unscaled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunLevel {
    Escape,
    Code { run: i32, level: i32, last: bool, index: usize },
}

impl RLTable {
    /// ff_rl_init of a table of n codes and the escape code's vlc entry at n, and its lookup.
    pub fn new(n: usize, last: usize, table_vlc: &'static [[u16; 2]], table_run: &'static [i8], table_level: &'static [i8]) -> Self {
        let mut max_level: [[i8; MAX_RUN + 1]; 2] = [[0; MAX_RUN + 1]; 2];
        let mut max_run: [[i8; MAX_LEVEL + 1]; 2] = [[0; MAX_LEVEL + 1]; 2];
        for last_index in 0..2 {
            let (start, end): (usize, usize) = if last_index == 0 { (0, last) } else { (last, n) };
            for i in start..end {
                let run: usize = table_run[i] as usize;
                let level: usize = table_level[i] as usize;
                if level as i8 > max_level[last_index][run] {
                    max_level[last_index][run] = level as i8;
                }
                if run as i8 > max_run[last_index][level] {
                    max_run[last_index][level] = run as i8;
                }
            }
        }
        let lookup: VLCLookup = lookup_from_pairs(&table_vlc[..=n]);
        Self { n, last, table_run, table_level, lookup, max_level, max_run }
    }

    /// Decodes one code from a 32-bit window: the code and its length, or None for a bit pattern no code starts.
    pub fn decode(&self, window: u32) -> Option<(RunLevel, u32)> {
        let (symbol, length) = self.lookup.decode(window)?;
        let index: usize = symbol as usize;
        if index == self.n {
            return Some((RunLevel::Escape, length));
        }
        Some((
            RunLevel::Code { run: i32::from(self.table_run[index]), level: i32::from(self.table_level[index]), last: index >= self.last, index },
            length,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tables::{INTER_LEVEL, INTER_RUN, INTER_VLC};

    // A small prefix code with a code longer than one level: 0, 10, 110, and 111 followed by nine bits
    const LONG_CODE: u32 = 0b1110_0000_0011;
    const LONG_CODE_LENGTH: u32 = 12;
    // 111 followed by nine bits other than the long code's
    const UNCODED_PATTERN: u32 = 0b1111_1111_1111;

    fn window_of(code: u32, length: u32) -> u32 {
        code << (WINDOW_BITS - length)
    }

    #[test]
    fn decodes_every_code_of_a_table_with_a_subtable_and_refuses_patterns_no_code_starts() {
        let codes: [(u32, u32, u32); 4] = [(0b0, 1, 0), (0b10, 2, 1), (0b110, 3, 2), (LONG_CODE, LONG_CODE_LENGTH, 3)];
        let lookup: VLCLookup = VLCLookup::new(&codes);
        for &(code, length, symbol) in &codes {
            assert_eq!(lookup.decode(window_of(code, length)), Some((symbol, length)));
        }
        assert_eq!(lookup.decode(window_of(UNCODED_PATTERN, LONG_CODE_LENGTH)), None);
    }

    #[test]
    fn decodes_the_h263_inter_table_as_ffmpeg_indexes_it() {
        let table: RLTable = RLTable::new(102, 58, &INTER_VLC, &INTER_RUN, &INTER_LEVEL);
        for index in 0..=102usize {
            let [code, length] = INTER_VLC[index];
            let decoded = table.decode(window_of(u32::from(code), u32::from(length)));
            if index == 102 {
                assert_eq!(decoded, Some((RunLevel::Escape, u32::from(length))));
            } else {
                assert_eq!(
                    decoded,
                    Some((RunLevel::Code { run: i32::from(INTER_RUN[index]), level: i32::from(INTER_LEVEL[index]), last: index >= 58, index }, u32::from(length)))
                );
            }
        }
        // ff_rl_init's maxima: the longest run of level 1 that is not last is 26, and of last codes 40
        assert_eq!(table.max_run[0][1], 26);
        assert_eq!(table.max_run[1][1], 40);
        assert_eq!(table.max_level[0][0], 12);
    }
}
