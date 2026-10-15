// The parser's failure reports: an error code of the record layout and the value that failed the check.

/// A failed check, as the WGSL decoder reports one: the code names the check, the value is what failed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeError {
    pub code: u32,
    pub value: u32,
}

pub type DecodeResult<T> = Result<T, DecodeError>;

/// Returns a failure of the check `code` with the failing `value`.
pub fn fail<T>(code: u32, value: u32) -> DecodeResult<T> {
    Err(DecodeError { code, value })
}
