// Assembles a picture's GPU record, the packet the GPU decoder reads: a header, slice records, a raster-order CTB table,
// then the prediction, edge, job, and coefficient streams, and the PCM samples. The RECORD_ constants of hevc.wgsl lay it out.

use crate::error::{DecodeResult, fail};
use crate::layout::{
    CTB_COEFFICIENT_OFFSET, CTB_EDGE_OFFSET, CTB_JOB_OFFSET, CTB_PREDICTION_OFFSET, CTB_WORDS, ERROR_SLICE_DECODE_INCOMPLETE, HEADER_BIT_DEPTH,
    HEADER_BIT_DEPTH_CHROMA, HEADER_CB_QP_OFFSET, HEADER_CHROMA_FORMAT, HEADER_COLUMN_BOUNDARIES, HEADER_CONFORMANCE_BOTTOM,
    HEADER_CONFORMANCE_LEFT, HEADER_CONFORMANCE_RIGHT, HEADER_CONFORMANCE_TOP, HEADER_CONSTRAINED_INTRA_PRED, HEADER_CR_QP_OFFSET,
    HEADER_CTB_LOG2, HEADER_CTBS, HEADER_DEBLOCKING_ANY, HEADER_DPB, HEADER_DPB_COUNT, HEADER_HEIGHT, HEADER_INTRA_SMOOTHING_DISABLED,
    HEADER_LOOP_FILTER_ACROSS_TILES, HEADER_MAGIC, HEADER_MIN_TB_LOG2, HEADER_PCM, HEADER_PCM_COUNT, HEADER_PICTURE_ID, HEADER_POC,
    HEADER_ROW_BOUNDARIES, HEADER_SAO_ANY, HEADER_SLICE_COUNT, HEADER_SLICES, HEADER_STRONG_INTRA_SMOOTHING, HEADER_TABLES_GENERATION,
    HEADER_TILE_COLUMNS, HEADER_TILE_ROWS, HEADER_VERSION, HEADER_WIDTH, HEADER_WORDS, MAGIC, MAXIMUM_DPB_PICTURES, REFERENCE_ENTRY_WORDS,
    SLICE_ADDRESS_RS, SLICE_BETA_OFFSET, SLICE_CHROMA_LOG2_WEIGHT_DENOM, SLICE_DEBLOCKING_DISABLED, SLICE_LOOP_FILTER_ACROSS_SLICES,
    SLICE_LUMA_LOG2_WEIGHT_DENOM, SLICE_REFERENCE_COUNT_0, SLICE_REFERENCE_COUNT_1, SLICE_REFERENCES, SLICE_TC_OFFSET, SLICE_WEIGHTED, SLICE_WEIGHTS, SLICE_WORDS, VERSION, WEIGHT_ENTRY_WORDS,
};
use crate::plan::{PictureParameters, REFERENCE_LIST_LENGTH, SliceHeader, WEIGHT_VALUES};
use crate::records::{JOB_CTB_ENTRY_WORDS, JobStreams};

/// Writes the GPU record of a picture from its parameters, slices, the pictures its DPB keeps, and its jobs in decode order.
pub fn assemble_picture(parameters: &PictureParameters, slices: &[SliceHeader], keep: &[u32], jobs: &[JobStreams], output: &mut Vec<u32>) -> DecodeResult<()> {
    let ctb_count: usize = parameters.ctb_count as usize;
    let slices_offset: usize = HEADER_WORDS as usize;
    let ctbs_offset: usize = slices_offset + slices.len() * SLICE_WORDS as usize;
    let predictions_offset: usize = ctbs_offset + ctb_count * CTB_WORDS as usize;
    let prediction_words: usize = jobs.iter().map(|job: &JobStreams| job.predictions.len()).sum();
    let edges_offset: usize = predictions_offset + prediction_words;
    let edge_words: usize = jobs.iter().map(|job: &JobStreams| job.edges.len()).sum();
    let jobs_offset: usize = edges_offset + edge_words;
    let job_words: usize = jobs.iter().map(|job: &JobStreams| job.jobs.len()).sum();
    let coefficients_offset: usize = jobs_offset + job_words;
    let coefficient_words: usize = jobs.iter().map(|job: &JobStreams| job.coefficients.len()).sum();
    let pcm_offset: usize = coefficients_offset + coefficient_words;
    let pcm_count: usize = jobs.iter().map(|job: &JobStreams| job.pcm_index.len()).sum();
    let pcm_words: usize = jobs.iter().map(|job: &JobStreams| job.pcm_data.len()).sum();
    let total_words: usize = pcm_offset + pcm_count + pcm_words;

    output.clear();
    output.resize(total_words, 0);
    write_header(parameters, slices.len(), keep, output);
    output[HEADER_SLICES as usize] = slices_offset as u32;
    output[HEADER_CTBS as usize] = ctbs_offset as u32;
    output[HEADER_PCM_COUNT as usize] = pcm_count as u32;
    output[HEADER_PCM as usize] = pcm_offset as u32;
    for (index, slice) in slices.iter().enumerate() {
        let start: usize = slices_offset + index * SLICE_WORDS as usize;
        write_slice(slice, &mut output[start..start + SLICE_WORDS as usize]);
    }

    // Each job's streams follow the previous job's, so its CTB records' offsets move by the streams before it
    let mut covered: Vec<bool> = vec![false; ctb_count];
    let mut covered_count: usize = 0;
    let mut prediction_base: usize = predictions_offset;
    let mut edge_base: usize = edges_offset;
    let mut job_base: usize = jobs_offset;
    let mut coefficient_base: usize = coefficients_offset;
    let mut pcm_index_position: usize = pcm_offset;
    let mut pcm_data_base: usize = pcm_offset + pcm_count;
    for job in jobs {
        for entry in job.ctb_entries.chunks_exact(JOB_CTB_ENTRY_WORDS) {
            let ctb_address_rs: usize = entry[0] as usize;
            if ctb_address_rs >= ctb_count {
                return fail(ERROR_SLICE_DECODE_INCOMPLETE, ctb_address_rs as u32);
            }
            if !covered[ctb_address_rs] {
                covered[ctb_address_rs] = true;
                covered_count += 1;
            }
            let start: usize = ctbs_offset + ctb_address_rs * CTB_WORDS as usize;
            let record: &mut [u32] = &mut output[start..start + CTB_WORDS as usize];
            record.copy_from_slice(&entry[1..]);
            record[CTB_PREDICTION_OFFSET as usize] += prediction_base as u32;
            record[CTB_EDGE_OFFSET as usize] += edge_base as u32;
            record[CTB_JOB_OFFSET as usize] += job_base as u32;
            record[CTB_COEFFICIENT_OFFSET as usize] += coefficient_base as u32;
        }
        output[prediction_base..prediction_base + job.predictions.len()].copy_from_slice(&job.predictions);
        output[edge_base..edge_base + job.edges.len()].copy_from_slice(&job.edges);
        output[job_base..job_base + job.jobs.len()].copy_from_slice(&job.jobs);
        output[coefficient_base..coefficient_base + job.coefficients.len()].copy_from_slice(&job.coefficients);
        for &record_offset in &job.pcm_index {
            output[pcm_index_position] = pcm_data_base as u32 + record_offset;
            pcm_index_position += 1;
        }
        output[pcm_data_base..pcm_data_base + job.pcm_data.len()].copy_from_slice(&job.pcm_data);
        prediction_base += job.predictions.len();
        edge_base += job.edges.len();
        job_base += job.jobs.len();
        coefficient_base += job.coefficients.len();
        pcm_data_base += job.pcm_data.len();
    }
    if covered_count != ctb_count {
        return fail(ERROR_SLICE_DECODE_INCOMPLETE, covered_count as u32);
    }
    Ok(())
}

fn write_header(parameters: &PictureParameters, slice_count: usize, keep: &[u32], output: &mut [u32]) {
    output[HEADER_MAGIC as usize] = MAGIC;
    output[HEADER_VERSION as usize] = VERSION;
    output[HEADER_PICTURE_ID as usize] = parameters.picture_id;
    output[HEADER_POC as usize] = parameters.poc as u32;
    output[HEADER_WIDTH as usize] = parameters.width;
    output[HEADER_HEIGHT as usize] = parameters.height;
    output[HEADER_CHROMA_FORMAT as usize] = parameters.chroma_format;
    output[HEADER_BIT_DEPTH as usize] = parameters.bit_depth;
    output[HEADER_BIT_DEPTH_CHROMA as usize] = parameters.bit_depth_chroma;
    output[HEADER_CTB_LOG2 as usize] = parameters.ctb_log2;
    output[HEADER_MIN_TB_LOG2 as usize] = parameters.min_tb_log2;
    output[HEADER_CONFORMANCE_LEFT as usize] = parameters.conformance_left;
    output[HEADER_CONFORMANCE_RIGHT as usize] = parameters.conformance_right;
    output[HEADER_CONFORMANCE_TOP as usize] = parameters.conformance_top;
    output[HEADER_CONFORMANCE_BOTTOM as usize] = parameters.conformance_bottom;
    output[HEADER_STRONG_INTRA_SMOOTHING as usize] = parameters.strong_intra_smoothing;
    output[HEADER_INTRA_SMOOTHING_DISABLED as usize] = parameters.intra_smoothing_disabled;
    output[HEADER_CONSTRAINED_INTRA_PRED as usize] = parameters.constrained_intra_pred;
    output[HEADER_CB_QP_OFFSET as usize] = parameters.cb_qp_offset as u32;
    output[HEADER_CR_QP_OFFSET as usize] = parameters.cr_qp_offset as u32;
    output[HEADER_LOOP_FILTER_ACROSS_TILES as usize] = parameters.loop_filter_across_tiles;
    output[HEADER_TILE_COLUMNS as usize] = parameters.tile_columns;
    output[HEADER_TILE_ROWS as usize] = parameters.tile_rows;
    output[HEADER_TABLES_GENERATION as usize] = parameters.tables_generation;
    output[HEADER_SAO_ANY as usize] = parameters.sao_any;
    output[HEADER_DEBLOCKING_ANY as usize] = parameters.deblocking_any;
    output[HEADER_SLICE_COUNT as usize] = slice_count as u32;
    let columns: usize = parameters.column_boundaries.len();
    output[HEADER_COLUMN_BOUNDARIES as usize..HEADER_COLUMN_BOUNDARIES as usize + columns].copy_from_slice(&parameters.column_boundaries);
    let rows: usize = parameters.row_boundaries.len();
    output[HEADER_ROW_BOUNDARIES as usize..HEADER_ROW_BOUNDARIES as usize + rows].copy_from_slice(&parameters.row_boundaries);
    let kept: usize = keep.len().min(MAXIMUM_DPB_PICTURES as usize);
    output[HEADER_DPB_COUNT as usize] = kept as u32;
    output[HEADER_DPB as usize..HEADER_DPB as usize + kept].copy_from_slice(&keep[..kept]);
}

fn write_slice(slice: &SliceHeader, record: &mut [u32]) {
    record[SLICE_ADDRESS_RS as usize] = slice.address_rs;
    record[SLICE_DEBLOCKING_DISABLED as usize] = slice.deblocking_disabled;
    record[SLICE_BETA_OFFSET as usize] = slice.beta_offset as u32;
    record[SLICE_TC_OFFSET as usize] = slice.tc_offset as u32;
    record[SLICE_LOOP_FILTER_ACROSS_SLICES as usize] = slice.loop_filter_across_slices;
    record[SLICE_WEIGHTED as usize] = slice.weighted;
    record[SLICE_LUMA_LOG2_WEIGHT_DENOM as usize] = slice.luma_log2_weight_denominator;
    record[SLICE_CHROMA_LOG2_WEIGHT_DENOM as usize] = slice.chroma_log2_weight_denominator;
    record[SLICE_REFERENCE_COUNT_0 as usize] = slice.reference_counts[0];
    record[SLICE_REFERENCE_COUNT_1 as usize] = slice.reference_counts[1];
    for list in 0..2 {
        for ref_idx in 0..REFERENCE_LIST_LENGTH {
            let entry_start: usize = SLICE_REFERENCES as usize + (list * REFERENCE_LIST_LENGTH + ref_idx) * REFERENCE_ENTRY_WORDS as usize;
            let entry = slice.references[list][ref_idx];
            record[entry_start] = entry.picture_id;
            record[entry_start + 1] = entry.poc as u32;
            record[entry_start + 2] = entry.long_term;
            let weight_start: usize = SLICE_WEIGHTS as usize + (list * REFERENCE_LIST_LENGTH + ref_idx) * WEIGHT_ENTRY_WORDS as usize;
            for value in 0..WEIGHT_VALUES {
                record[weight_start + value] = slice.weights[list][ref_idx][value] as u32;
            }
        }
    }
}
