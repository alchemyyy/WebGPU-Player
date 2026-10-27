// Plan serialization: a coordinator instance plans each picture, and a parse worker's instance decodes its macroblock layer from the
// serialized plan, as little-endian words. Every value a plan holds is a PlanField, and plan_struct! makes a struct of them one.

/// Writes plan words.
#[derive(Default)]
pub struct PlanWriter {
    pub words: Vec<u32>,
}

/// Reads plan words; a read past the end yields None, which fails the plan as invalid.
pub struct PlanReader<'a> {
    words: &'a [u32],
    position: usize,
}

impl<'a> PlanReader<'a> {
    pub fn new(words: &'a [u32]) -> Self {
        Self { words, position: 0 }
    }

    pub fn word(&mut self) -> Option<u32> {
        let word: u32 = *self.words.get(self.position)?;
        self.position += 1;
        Some(word)
    }

    pub fn is_empty(&self) -> bool {
        self.position >= self.words.len()
    }
}

/// A value a plan carries.
pub trait PlanField: Sized {
    fn write(&self, writer: &mut PlanWriter);
    fn read(reader: &mut PlanReader) -> Option<Self>;
}

macro_rules! word_field {
    ($($type:ty),*) => {
        $(impl PlanField for $type {
            fn write(&self, writer: &mut PlanWriter) {
                writer.words.push(*self as u32);
            }
            fn read(reader: &mut PlanReader) -> Option<Self> {
                Some(reader.word()? as $type)
            }
        })*
    };
}

word_field!(u8, i8, u16, i16, u32, i32);

impl PlanField for bool {
    fn write(&self, writer: &mut PlanWriter) {
        writer.words.push(u32::from(*self));
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        match reader.word()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }
}

impl PlanField for i64 {
    fn write(&self, writer: &mut PlanWriter) {
        writer.words.push(*self as u32);
        writer.words.push((*self >> 32) as u32);
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        let low: u32 = reader.word()?;
        let high: u32 = reader.word()?;
        Some(i64::from(low) | (i64::from(high as i32) << 32))
    }
}

impl<T: PlanField + Copy + Default, const N: usize> PlanField for [T; N] {
    fn write(&self, writer: &mut PlanWriter) {
        for value in self {
            value.write(writer);
        }
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        let mut values: [T; N] = [T::default(); N];
        for value in &mut values {
            *value = T::read(reader)?;
        }
        Some(values)
    }
}

impl<T: PlanField> PlanField for Option<T> {
    fn write(&self, writer: &mut PlanWriter) {
        match self {
            None => writer.words.push(0),
            Some(value) => {
                writer.words.push(1);
                value.write(writer);
            }
        }
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        match reader.word()? {
            0 => Some(None),
            1 => Some(Some(T::read(reader)?)),
            _ => None,
        }
    }
}

/// Byte vectors pack four bytes to a word after their length.
impl PlanField for Vec<u8> {
    fn write(&self, writer: &mut PlanWriter) {
        writer.words.push(self.len() as u32);
        for chunk in self.chunks(4) {
            let mut bytes: [u8; 4] = [0; 4];
            bytes[..chunk.len()].copy_from_slice(chunk);
            writer.words.push(u32::from_le_bytes(bytes));
        }
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        let length: usize = reader.word()? as usize;
        let mut bytes: Vec<u8> = Vec::with_capacity(length);
        while bytes.len() < length {
            let word: [u8; 4] = reader.word()?.to_le_bytes();
            let take: usize = (length - bytes.len()).min(4);
            bytes.extend_from_slice(&word[..take]);
        }
        Some(bytes)
    }
}

/// Word vectors carry their length, then their words.
impl PlanField for Vec<i16> {
    fn write(&self, writer: &mut PlanWriter) {
        writer.words.push(self.len() as u32);
        writer.words.extend(self.iter().map(|&value: &i16| value as u16 as u32));
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        let length: usize = reader.word()? as usize;
        (0..length).map(|_| reader.word().map(|word: u32| word as u16 as i16)).collect()
    }
}

impl PlanField for Vec<u32> {
    fn write(&self, writer: &mut PlanWriter) {
        writer.words.push(self.len() as u32);
        writer.words.extend_from_slice(self);
    }
    fn read(reader: &mut PlanReader) -> Option<Self> {
        let length: usize = reader.word()? as usize;
        (0..length).map(|_| reader.word()).collect()
    }
}

/// Implements PlanField for a struct by its fields, in order.
#[macro_export]
macro_rules! plan_struct {
    ($name:ident { $($field:ident),* $(,)? }) => {
        impl $crate::plan::PlanField for $name {
            fn write(&self, writer: &mut $crate::plan::PlanWriter) {
                $($crate::plan::PlanField::write(&self.$field, writer);)*
            }
            fn read(reader: &mut $crate::plan::PlanReader) -> Option<Self> {
                Some(Self { $($field: $crate::plan::PlanField::read(reader)?,)* })
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    struct Sample {
        flag: bool,
        value: i32,
        pairs: [[i16; 2]; 2],
        bytes: Vec<u8>,
        wide: i64,
        optional: Option<u8>,
    }
    plan_struct!(Sample { flag, value, pairs, bytes, wide, optional });

    #[test]
    fn round_trips_a_struct_and_refuses_a_short_plan() {
        let sample: Sample = Sample { flag: true, value: -7, pairs: [[1, -2], [3, -4]], bytes: vec![1, 2, 3, 4, 5], wide: -1 << 40, optional: Some(9) };
        let mut writer: PlanWriter = PlanWriter::default();
        sample.write(&mut writer);
        let mut reader: PlanReader = PlanReader::new(&writer.words);
        assert_eq!(Sample::read(&mut reader), Some(sample));
        assert!(reader.is_empty());
        let mut short: PlanReader = PlanReader::new(&writer.words[..writer.words.len() - 1]);
        assert_eq!(Sample::read(&mut short), None);
    }
}
