// The parser's failure reports: an error code of the record layout and the value that failed the check.

use crate::layout::ERROR_CODE_SHIFT;

/// The largest failing value an error word holds below its code.
const ERROR_VALUE_MASK: u32 = (1 << ERROR_CODE_SHIFT) - 1;

/// A failed check, as the WGSL decoder reports one: the code names the check, the value is what failed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeError {
    pub code: u32,
    pub value: u32,
}

impl DecodeError {
    /// The failure as a status error word, `(code << 24) | value`, its value clamped as the WGSL's reportFailure clamps it.
    pub fn word(self) -> u32 {
        (self.code << ERROR_CODE_SHIFT) | self.value.min(ERROR_VALUE_MASK)
    }

    /// The failure an error word reports.
    pub fn from_word(word: u32) -> Self {
        Self { code: word >> ERROR_CODE_SHIFT, value: word & ERROR_VALUE_MASK }
    }
}

pub type DecodeResult<T> = Result<T, DecodeError>;

/// Returns a failure of the check `code` with the failing `value`.
pub fn fail<T>(code: u32, value: u32) -> DecodeResult<T> {
    Err(DecodeError { code, value })
}
