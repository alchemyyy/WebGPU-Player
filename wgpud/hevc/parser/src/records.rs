// The records slice data parsing emits for one job, per CTB in tile scan order, and their serialized form.
// A job's output: a header, one entry per CTB with offsets into its streams, then the streams.
// The coordinator derives motion over the prediction stream and assembles the GPU record of the picture from one or more jobs.

use crate::layout::{CTB_WORDS, PREDICTION_WORDS};

pub const JOB_MAGIC: u32 = 0x424F_4A52;
/// Words of a job header: magic, CTB count, then the word counts of the predictions, edges, jobs, coefficients, PCM index, and PCM data
pub const JOB_HEADER_WORDS: usize = 8;
/// Words of a job's CTB entry: the CTB's raster address, then its GPU CTB record with offsets relative to each stream
pub const JOB_CTB_ENTRY_WORDS: usize = 1 + CTB_WORDS as usize;
pub const PREDICTION_RECORD_WORDS: usize = PREDICTION_WORDS as usize;

// Fields of a prediction record's geometry word above the GPU's 16 bits, which only motion derivation reads
pub const SYNTAX_MERGE_FLAG_SHIFT: u32 = 16;
pub const SYNTAX_MERGE_INDEX_SHIFT: u32 = 17;
pub const SYNTAX_INTER_PRED_IDC_SHIFT: u32 = 20;
pub const SYNTAX_MVP_L0_SHIFT: u32 = 22;
pub const SYNTAX_MVP_L1_SHIFT: u32 = 23;
pub const SYNTAX_PART_INDEX_SHIFT: u32 = 24;
pub const SYNTAX_PART_MODE_SHIFT: u32 = 26;
pub const SYNTAX_CU_LOG2_SHIFT: u32 = 29;
/// The smallest coding block, whose log2 the record stores as an offset from
pub const SYNTAX_CU_LOG2_BASE: u32 = 3;

/// The streams of one job.
#[derive(Default)]
pub struct JobStreams {
    pub ctb_entries: Vec<u32>,
    pub predictions: Vec<u32>,
    pub edges: Vec<u32>,
    pub jobs: Vec<u32>,
    pub coefficients: Vec<u32>,
    pub pcm_index: Vec<u32>,
    pub pcm_data: Vec<u32>,
}

impl JobStreams {
    pub fn clear(&mut self) {
        self.ctb_entries.clear();
        self.predictions.clear();
        self.edges.clear();
        self.jobs.clear();
        self.coefficients.clear();
        self.pcm_index.clear();
        self.pcm_data.clear();
    }

    pub fn ctb_count(&self) -> usize {
        self.ctb_entries.len() / JOB_CTB_ENTRY_WORDS
    }

    /// Writes the job's serialized form: the header, then the CTB entries and every stream in order.
    pub fn serialize(&self, output: &mut Vec<u32>) {
        output.clear();
        output.extend_from_slice(&[
            JOB_MAGIC,
            self.ctb_count() as u32,
            self.predictions.len() as u32,
            self.edges.len() as u32,
            self.jobs.len() as u32,
            self.coefficients.len() as u32,
            self.pcm_index.len() as u32,
            self.pcm_data.len() as u32,
        ]);
        output.extend_from_slice(&self.ctb_entries);
        output.extend_from_slice(&self.predictions);
        output.extend_from_slice(&self.edges);
        output.extend_from_slice(&self.jobs);
        output.extend_from_slice(&self.coefficients);
        output.extend_from_slice(&self.pcm_index);
        output.extend_from_slice(&self.pcm_data);
    }

    /// Reads a serialized job back into these streams; false when the words are not one.
    pub fn deserialize(&mut self, words: &[u32]) -> bool {
        self.clear();
        let Some(header) = words.get(..JOB_HEADER_WORDS) else {
            return false;
        };
        if header[0] != JOB_MAGIC {
            return false;
        }
        let lengths: [usize; 7] = [
            header[1] as usize * JOB_CTB_ENTRY_WORDS,
            header[2] as usize,
            header[3] as usize,
            header[4] as usize,
            header[5] as usize,
            header[6] as usize,
            header[7] as usize,
        ];
        let mut offset: usize = JOB_HEADER_WORDS;
        let mut streams: [&mut Vec<u32>; 7] = [
            &mut self.ctb_entries,
            &mut self.predictions,
            &mut self.edges,
            &mut self.jobs,
            &mut self.coefficients,
            &mut self.pcm_index,
            &mut self.pcm_data,
        ];
        for (stream, length) in streams.iter_mut().zip(lengths) {
            let Some(end) = offset.checked_add(length) else {
                return false;
            };
            let Some(source) = words.get(offset..end) else {
                return false;
            };
            stream.extend_from_slice(source);
            offset = end;
        }
        offset == words.len()
    }
}
