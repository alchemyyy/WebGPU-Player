// The parser's failure reports: an error code of the record layout and the value that failed the check.

/// A failed check, as the WGSL decoder reports one: the code names the check, the value is what failed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeError {
    pub code: u32,
    pub value: u32,
}

pub type DecodeResult<T> = Result<T, DecodeError>;

/// The largest failing value an error word carries, below its code byte
pub const MAXIMUM_ERROR_VALUE: u32 = (1 << 24) - 1;

/// Returns a failure of the check `code` with the failing `value`, clamped to the error word's 24 bits.
pub fn fail<T>(code: u32, value: u32) -> DecodeResult<T> {
    Err(DecodeError { code, value: value.min(MAXIMUM_ERROR_VALUE) })
}

/// Returns a failure whose value is a possibly negative or oversized count, clamped into the error word.
pub fn fail_signed<T>(code: u32, value: i64) -> DecodeResult<T> {
    fail(code, value.clamp(0, i64::from(MAXIMUM_ERROR_VALUE)) as u32)
}
