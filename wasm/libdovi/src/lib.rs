use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::array;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::slice;

use dolby_vision::rpu::UnsupportedRpuSyntax;
use dolby_vision::rpu::dovi_rpu::DoviRpu;
use dolby_vision::rpu::extension_metadata::blocks::ExtMetadataBlock;
use dolby_vision::rpu::rpu_data_mapping::{
    DoviMMRCurve, DoviMappingMethod, DoviPolynomialCurve, DoviReshapingCurve, RpuDataMapping,
};
use dolby_vision::rpu::rpu_data_nlq::DoviELType;
use dolby_vision::rpu::vdr_dm_data::VdrDmData;

const PARSER_SCHEMA_MAGIC: u32 = 0x5052_5644;
const PARSER_SCHEMA_VERSION: u32 = 2;
const PARSER_REVISION_PREFIX: u32 = 0x38AD_EC04;
const MAXIMUM_LINEAR_MEMORY_BYTE_LENGTH: u32 = 16 * 1_024 * 1_024;
const MAXIMUM_SHARED_BUFFER_BYTE_LENGTH: usize = 64 * 1_024;
const MAXIMUM_MAPPING_ID: usize = 15;
const MAXIMUM_PIVOT_COUNT: usize = 9;
const MAXIMUM_SEGMENT_COUNT: usize = 8;
const MAXIMUM_MMR_ORDER: usize = 3;
const MAXIMUM_MMR_COEFFICIENT_COUNT: usize = 7;
const MAXIMUM_MMR_VECTOR_COUNT: usize = 48;
const HEADER_U32_COUNT: usize = 48;
const HEADER_BYTE_LENGTH: usize = HEADER_U32_COUNT * size_of::<u32>();
const COLOR_FLOAT_COUNT: usize = 28;
const NLQ_FLOAT_COUNT: usize = 12;
const COMPONENT_HEADER_U32_COUNT: usize = 4;
const COMPONENT_PIVOT_FLOAT_COUNT: usize = 12;
const COMPONENT_SEGMENT_FLOAT_COUNT: usize = MAXIMUM_SEGMENT_COUNT * 4;
const COMPONENT_MMR_FLOAT_COUNT: usize = MAXIMUM_MMR_VECTOR_COUNT * 4;
const COMPONENT_BYTE_LENGTH: usize = (COMPONENT_HEADER_U32_COUNT
    + COMPONENT_PIVOT_FLOAT_COUNT
    + COMPONENT_SEGMENT_FLOAT_COUNT
    + COMPONENT_MMR_FLOAT_COUNT)
    * size_of::<u32>();
const OUTPUT_BYTE_LENGTH: usize = HEADER_BYTE_LENGTH
    + ((COLOR_FLOAT_COUNT + NLQ_FLOAT_COUNT) * size_of::<f32>())
    + (3 * COMPONENT_BYTE_LENGTH);
const LAST_ERROR_BYTE_LENGTH: usize = 512;
const MISSING_U32: u32 = u32::MAX;

const FLAG_USED_PREVIOUS_MAPPING: u32 = 1 << 0;
const FLAG_EXPLICIT_COLOR_METADATA: u32 = 1 << 1;
const FLAG_LEVEL1_METADATA: u32 = 1 << 2;
const FLAG_NLQ_PRESENT: u32 = 1 << 3;
const FLAG_NLQ_ACTIVE: u32 = 1 << 4;
const FLAG_MEL: u32 = 1 << 5;
const FLAG_FEL: u32 = 1 << 6;
const FLAG_SCENE_REFRESH: u32 = 1 << 7;
const FLAG_DEFAULT_COLOR_METADATA: u32 = 1 << 8;

// Component flags, one per mapping method the component's pieces use
const COMPONENT_FLAG_POLYNOMIAL: u32 = 1 << 0;
const COMPONENT_FLAG_MMR: u32 = 1 << 1;

const STATUS_INVALID_ARGUMENT: i32 = 1;
const STATUS_INPUT_TOO_LARGE: i32 = 2;
const STATUS_PARSE_FAILED: i32 = 3;
const STATUS_UNSUPPORTED_METADATA: i32 = 4;
const STATUS_MISSING_MAPPING_STATE: i32 = 5;
const STATUS_INVALID_MAPPING: i32 = 6;
const STATUS_INVALID_COLOR_METADATA: i32 = 7;

// FFmpeg divides the ycc_to_rgb offsets an RPU carries by 2^30 for Profile 4 and 2^28 otherwise
const PROFILE_4_YCC_TO_RGB_OFFSET_SCALE: f32 = 1_073_741_824.0;
const YCC_TO_RGB_OFFSET_SCALE: f32 = 268_435_456.0;
// A nonzero rpu_format extension omits the bit depths
const RPU_FORMAT_EXTENSION_MASK: u16 = 0x700;
// FFmpeg's dm_compression values, which the crate stores as reserved_zero_3bits
const UNCOMPRESSED_DISPLAY_METADATA: u8 = 0;
const COMPRESSED_DISPLAY_METADATA: u8 = 1;

/// How the input buffer carries one RPU
#[derive(Clone, Copy)]
enum RpuFraming {
    /// An HEVC UNSPEC62 NAL unit, after an optional start code
    HEVCUnspec62NALUnit,
    /// The ITU-T T.35 payload of one AV1 metadata OBU, from its country code or its provider code to the end of the OBU payload
    AV1ITUTT35Payload,
}

#[derive(Debug)]
struct ParserFailure {
    code: i32,
    message: String,
}

impl ParserFailure {
    fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

type ParserResult<T> = Result<T, ParserFailure>;

struct ParserContext {
    last_error: [u8; LAST_ERROR_BYTE_LENGTH],
    last_error_length: usize,
    mappings: [Option<RpuDataMapping>; MAXIMUM_MAPPING_ID + 1],
    // The last uncompressed display metadata, which compressed RPUs reuse
    color_metadata: Option<ScaledColorMetadata>,
}

impl Default for ParserContext {
    fn default() -> Self {
        Self {
            last_error: [0; LAST_ERROR_BYTE_LENGTH],
            last_error_length: 0,
            mappings: array::from_fn(|_| None),
            color_metadata: None,
        }
    }
}

impl ParserContext {
    fn clear_error(&mut self) {
        self.last_error.fill(0);
        self.last_error_length = 0;
    }

    fn record_error(&mut self, failure: &ParserFailure) {
        self.last_error.fill(0);
        let bytes = failure.message.as_bytes();
        self.last_error_length = bytes.len().min(LAST_ERROR_BYTE_LENGTH);
        self.last_error[..self.last_error_length].copy_from_slice(&bytes[..self.last_error_length]);
    }

    fn reset(&mut self) {
        self.clear_error();
        self.mappings.fill(None);
        self.color_metadata = None;
    }

    fn parse(&mut self, input: &[u8], framing: RpuFraming, output: &mut [u8]) -> ParserResult<()> {
        let parsed_rpu = match framing {
            RpuFraming::HEVCUnspec62NALUnit => DoviRpu::parse_unspec62_nalu(input),
            RpuFraming::AV1ITUTT35Payload => DoviRpu::parse_itu_t35_dovi_metadata_obu(input),
        };
        let rpu = parsed_rpu.map_err(|error| {
            if let Some(syntax) = error.downcast_ref::<UnsupportedRpuSyntax>() {
                return unsupported_syntax_failure(*syntax);
            }
            // The alternate form keeps the cause behind the crate's CM section context
            ParserFailure::new(
                STATUS_PARSE_FAILED,
                format!("libdovi parse failed: {error:#}"),
            )
        })?;
        validate_rpu_policy(&rpu)?;
        let mapping_resolution = self.resolve_mapping(&rpu)?;
        let color_resolution = self.resolve_color_metadata(&rpu)?;
        let packed_snapshot = PackedSnapshot::new(
            &rpu,
            &mapping_resolution.mapping,
            mapping_resolution.used_previous_mapping,
            color_resolution.color,
            color_resolution.explicit_color_metadata,
        )?;
        packed_snapshot.write(output);

        // Prior state changes only after the whole RPU was accepted
        if let Some(mapping_id) = mapping_resolution.mapping_id_to_store {
            self.mappings[mapping_id] = Some(mapping_resolution.mapping);
        }
        if let Some(color_metadata) = color_resolution.color_to_store {
            self.color_metadata = Some(color_metadata);
        }
        self.clear_error();
        Ok(())
    }

    fn resolve_mapping(&self, rpu: &DoviRpu) -> ParserResult<MappingResolution> {
        if let Some(mapping) = &rpu.rpu_data_mapping {
            let mapping_id = require_mapping_id(mapping.vdr_rpu_id)?;
            return Ok(MappingResolution {
                mapping: mapping.clone(),
                mapping_id_to_store: Some(mapping_id),
                used_previous_mapping: false,
            });
        }

        if !rpu.header.use_prev_vdr_rpu_flag {
            return Err(ParserFailure::new(
                STATUS_MISSING_MAPPING_STATE,
                "RPU contains no mapping and does not reference prior state",
            ));
        }

        let requested_mapping_id = require_mapping_id(rpu.header.prev_vdr_rpu_id)?;
        let resolved_mapping = self.mappings[requested_mapping_id]
            .as_ref()
            .or(self.mappings[0].as_ref())
            .cloned()
            .ok_or_else(|| {
                ParserFailure::new(
                    STATUS_MISSING_MAPPING_STATE,
                    format!("RPU references unavailable prior mapping {requested_mapping_id}"),
                )
            })?;
        Ok(MappingResolution {
            mapping: resolved_mapping,
            mapping_id_to_store: None,
            used_previous_mapping: true,
        })
    }

    /// Selects the display metadata to present, following FFmpeg's DM state semantics.
    /// Compressed metadata reuses the last uncompressed metadata with this RPU's dynamic fields, and an RPU without metadata presents the defaults while the stored metadata survives
    fn resolve_color_metadata(&self, rpu: &DoviRpu) -> ParserResult<ColorMetadataResolution> {
        let Some(rpu_color) = &rpu.vdr_dm_data else {
            return Ok(ColorMetadataResolution {
                color: ScaledColorMetadata {
                    metadata: default_color_metadata(),
                    ycc_to_rgb_offset_scale: YCC_TO_RGB_OFFSET_SCALE,
                },
                explicit_color_metadata: false,
                color_to_store: None,
            });
        };

        if !rpu_color.compressed {
            let color = ScaledColorMetadata {
                metadata: rpu_color.clone(),
                ycc_to_rgb_offset_scale: rpu_ycc_to_rgb_offset_scale(rpu.dovi_profile),
            };
            return Ok(ColorMetadataResolution {
                color: color.clone(),
                explicit_color_metadata: true,
                color_to_store: Some(color),
            });
        }

        let stored_color = self.color_metadata.as_ref().ok_or_else(|| {
            ParserFailure::new(
                STATUS_MISSING_MAPPING_STATE,
                "RPU compresses its display metadata, but no prior RPU carried uncompressed display metadata",
            )
        })?;
        // The offset scale stays with the profile of the RPU that carried the metadata, as in FFmpeg
        let mut color = stored_color.clone();
        color.metadata.affected_dm_metadata_id = rpu_color.affected_dm_metadata_id;
        color.metadata.current_dm_metadata_id = rpu_color.current_dm_metadata_id;
        color.metadata.scene_refresh_flag = rpu_color.scene_refresh_flag;
        color.metadata.cmv29_metadata = rpu_color.cmv29_metadata.clone();
        color.metadata.cmv40_metadata = rpu_color.cmv40_metadata.clone();
        color.metadata.compressed = false;
        Ok(ColorMetadataResolution {
            color,
            explicit_color_metadata: true,
            color_to_store: None,
        })
    }
}

struct MappingResolution {
    mapping: RpuDataMapping,
    mapping_id_to_store: Option<usize>,
    used_previous_mapping: bool,
}

/// Display metadata with the denominator of its ycc_to_rgb offsets
#[derive(Clone)]
struct ScaledColorMetadata {
    metadata: VdrDmData,
    ycc_to_rgb_offset_scale: f32,
}

struct ColorMetadataResolution {
    color: ScaledColorMetadata,
    explicit_color_metadata: bool,
    color_to_store: Option<ScaledColorMetadata>,
}

#[derive(Clone, Copy, Default)]
struct PackedNLQData {
    deadzone_slope: f32,
    deadzone_threshold: f32,
    offset: f32,
    vdr_in_max: f32,
}

/// One component's packed curve.
/// A polynomial segment holds [c0, c1, c2, 0] and an MMR segment [constant, first vector index, 0, order], so a positive fourth value marks MMR
struct PackedComponent {
    flags: u32,
    mmr_vector_count: u32,
    num_pivots: u32,
    pivots: [f32; COMPONENT_PIVOT_FLOAT_COUNT],
    segment_data: [[f32; 4]; MAXIMUM_SEGMENT_COUNT],
    mmr_data: [[f32; 4]; MAXIMUM_MMR_VECTOR_COUNT],
}

/// The values one linear interpolation piece codes, on the polynomial coefficients' scale.
/// Each is the curve's rise from the previous pivot's value, as annex A.2.4.2 of US 10,701,399 B2 derives linear_interp_value
#[derive(Clone, Copy)]
struct LinearInterpolationPiece {
    // The first piece codes its start value outright
    start_rise: f64,
    // Coded only by a component's last piece
    end_rise: Option<f64>,
}

impl Default for PackedComponent {
    fn default() -> Self {
        Self {
            flags: 0,
            mmr_vector_count: 0,
            num_pivots: 0,
            pivots: [0.0; COMPONENT_PIVOT_FLOAT_COUNT],
            segment_data: [[0.0; 4]; MAXIMUM_SEGMENT_COUNT],
            mmr_data: [[0.0; 4]; MAXIMUM_MMR_VECTOR_COUNT],
        }
    }
}

struct PackedSnapshot {
    color: VdrDmData,
    ycc_to_rgb_offset_scale: f32,
    components: [PackedComponent; 3],
    explicit_color_metadata: bool,
    flags: u32,
    level1: Option<[u16; 3]>,
    nlq: [PackedNLQData; 3],
    rpu_crc32: u32,
    rpu_profile: u8,
    rpu_header: dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    mapping_header: [u32; 5],
}

impl PackedSnapshot {
    fn new(
        rpu: &DoviRpu,
        mapping: &RpuDataMapping,
        used_previous_mapping: bool,
        scaled_color: ScaledColorMetadata,
        explicit_color_metadata: bool,
    ) -> ParserResult<Self> {
        // Every mapping color space and chroma format applies, as in FFmpeg: the reshape maps the upsampled decoded components as they are, and the RPU's ycc_to_rgb matrix converts them
        let ScaledColorMetadata {
            metadata: color,
            ycc_to_rgb_offset_scale,
        } = scaled_color;
        validate_color_metadata(&color)?;

        let components = [
            pack_component(&mapping.curves[0], &rpu.header)?,
            pack_component(&mapping.curves[1], &rpu.header)?,
            pack_component(&mapping.curves[2], &rpu.header)?,
        ];
        let (nlq, nlq_flags) = pack_nlq(mapping, &rpu.header)?;
        if rpu.dovi_profile == 5 && !rpu.header.disable_residual_flag {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Profile 5 RPU unexpectedly enables an enhancement residual",
            ));
        }

        let level1 = match color.get_block(1) {
            Some(ExtMetadataBlock::Level1(level1)) => {
                Some([level1.min_pq, level1.max_pq, level1.avg_pq])
            }
            _ => None,
        };
        let mut flags = nlq_flags;
        if used_previous_mapping {
            flags |= FLAG_USED_PREVIOUS_MAPPING;
        }
        if explicit_color_metadata {
            flags |= FLAG_EXPLICIT_COLOR_METADATA;
        } else {
            flags |= FLAG_DEFAULT_COLOR_METADATA;
        }
        if level1.is_some() {
            flags |= FLAG_LEVEL1_METADATA;
        }
        if color.scene_refresh_flag != 0 {
            flags |= FLAG_SCENE_REFRESH;
        }

        Ok(Self {
            color,
            ycc_to_rgb_offset_scale,
            components,
            explicit_color_metadata,
            flags,
            level1,
            nlq,
            rpu_crc32: rpu.rpu_data_crc32,
            rpu_profile: rpu.dovi_profile,
            rpu_header: rpu.header.clone(),
            mapping_header: [
                require_u32(mapping.vdr_rpu_id, "VDR RPU mapping ID")?,
                require_u32(mapping.mapping_color_space, "mapping color space")?,
                require_u32(mapping.mapping_chroma_format_idc, "mapping chroma format")?,
                require_u32(mapping.num_x_partitions_minus1 + 1, "X partition count")?,
                require_u32(mapping.num_y_partitions_minus1 + 1, "Y partition count")?,
            ],
        })
    }

    fn write(&self, output: &mut [u8]) {
        output.fill(0);
        let mut writer = PackedWriter::new(output);
        let header = &self.rpu_header;
        let level1 = self
            .level1
            .map_or([MISSING_U32; 3], |values| values.map(u32::from));
        let previous_mapping_id = if header.use_prev_vdr_rpu_flag {
            header.prev_vdr_rpu_id as u32
        } else {
            MISSING_U32
        };
        let nlq_method = if self.flags & FLAG_NLQ_PRESENT != 0 {
            0
        } else {
            MISSING_U32
        };

        writer.write_u32(PARSER_SCHEMA_MAGIC);
        writer.write_u32(PARSER_SCHEMA_VERSION);
        writer.write_u32(OUTPUT_BYTE_LENGTH as u32);
        writer.write_u32(self.flags);
        writer.write_u32(PARSER_REVISION_PREFIX);
        writer.write_u32(self.rpu_profile as u32);
        writer.write_u32(header.rpu_type as u32);
        writer.write_u32(header.rpu_format as u32);
        writer.write_u32(header.vdr_rpu_profile as u32);
        writer.write_u32(header.vdr_rpu_level as u32);
        writer.write_u32(header.coefficient_data_type as u32);
        writer.write_u32(header.coefficient_log2_denom as u32);
        writer.write_u32((header.bl_bit_depth_minus8 + 8) as u32);
        writer.write_u32((header.el_bit_depth_minus8 + 8) as u32);
        writer.write_u32((header.vdr_bit_depth_minus8 + 8) as u32);
        writer.write_u32(header.vdr_rpu_normalized_idc as u32);
        writer.write_u32(header.bl_video_full_range_flag as u32);
        writer.write_u32(header.chroma_resampling_explicit_filter_flag as u32);
        writer.write_u32(header.spatial_resampling_filter_flag as u32);
        writer.write_u32(header.el_spatial_resampling_filter_flag as u32);
        writer.write_u32(header.disable_residual_flag as u32);
        writer.write_u32(self.mapping_header[0]);
        writer.write_u32(previous_mapping_id);
        writer.write_u32(self.mapping_header[1]);
        writer.write_u32(self.mapping_header[2]);
        writer.write_u32(self.mapping_header[3]);
        writer.write_u32(self.mapping_header[4]);
        writer.write_u32(self.color.signal_eotf as u32);
        writer.write_u32(self.color.signal_eotf_param0 as u32);
        writer.write_u32(self.color.signal_eotf_param1 as u32);
        writer.write_u32(self.color.signal_eotf_param2);
        writer.write_u32(self.color.signal_bit_depth as u32);
        writer.write_u32(self.color.signal_color_space as u32);
        writer.write_u32(self.color.signal_chroma_format as u32);
        writer.write_u32(self.color.signal_full_range_flag as u32);
        writer.write_u32(self.color.source_min_pq as u32);
        writer.write_u32(self.color.source_max_pq as u32);
        writer.write_u32(self.color.source_diagonal as u32);
        writer.write_u32(level1[0]);
        writer.write_u32(level1[1]);
        writer.write_u32(level1[2]);
        writer.write_u32(self.color.scene_refresh_flag as u32);
        writer.write_u32(self.color.affected_dm_metadata_id as u32);
        writer.write_u32(self.color.current_dm_metadata_id as u32);
        writer.write_u32(nlq_method);
        writer.write_u32(self.rpu_crc32);
        writer.write_u32(header.ext_mapping_idc_0_4 as u32);
        writer.write_u32(header.ext_mapping_idc_5_7 as u32);
        debug_assert_eq!(writer.offset, HEADER_BYTE_LENGTH);

        let nonlinear_offsets = [
            self.color.ycc_to_rgb_offset0,
            self.color.ycc_to_rgb_offset1,
            self.color.ycc_to_rgb_offset2,
        ];
        for offset in nonlinear_offsets {
            writer.write_f32(offset as f32 / self.ycc_to_rgb_offset_scale);
        }
        writer.write_f32(0.0);

        let nonlinear_matrix = [
            self.color.ycc_to_rgb_coef0,
            self.color.ycc_to_rgb_coef1,
            self.color.ycc_to_rgb_coef2,
            self.color.ycc_to_rgb_coef3,
            self.color.ycc_to_rgb_coef4,
            self.color.ycc_to_rgb_coef5,
            self.color.ycc_to_rgb_coef6,
            self.color.ycc_to_rgb_coef7,
            self.color.ycc_to_rgb_coef8,
        ];
        write_padded_matrix(&mut writer, &nonlinear_matrix, 8_192.0);
        let linear_matrix = [
            self.color.rgb_to_lms_coef0,
            self.color.rgb_to_lms_coef1,
            self.color.rgb_to_lms_coef2,
            self.color.rgb_to_lms_coef3,
            self.color.rgb_to_lms_coef4,
            self.color.rgb_to_lms_coef5,
            self.color.rgb_to_lms_coef6,
            self.color.rgb_to_lms_coef7,
            self.color.rgb_to_lms_coef8,
        ];
        write_padded_matrix(&mut writer, &linear_matrix, 16_384.0);

        for component in self.nlq {
            writer.write_f32(component.offset);
            writer.write_f32(component.deadzone_slope);
            writer.write_f32(component.deadzone_threshold);
            writer.write_f32(component.vdr_in_max);
        }
        for component in &self.components {
            component.write(&mut writer);
        }
        debug_assert_eq!(writer.offset, OUTPUT_BYTE_LENGTH);
        debug_assert_eq!(
            self.explicit_color_metadata,
            self.flags & FLAG_EXPLICIT_COLOR_METADATA != 0
        );
    }
}

impl PackedComponent {
    fn write(&self, writer: &mut PackedWriter<'_>) {
        writer.write_u32(self.num_pivots);
        writer.write_u32(self.mmr_vector_count);
        writer.write_u32(self.flags);
        writer.write_u32(0);
        for pivot in self.pivots {
            writer.write_f32(pivot);
        }
        for segment in self.segment_data {
            for value in segment {
                writer.write_f32(value);
            }
        }
        for vector in self.mmr_data {
            for value in vector {
                writer.write_f32(value);
            }
        }
    }
}

struct PackedWriter<'a> {
    data: &'a mut [u8],
    offset: usize,
}

impl<'a> PackedWriter<'a> {
    fn new(data: &'a mut [u8]) -> Self {
        Self { data, offset: 0 }
    }

    fn write_f32(&mut self, value: f32) {
        self.write_bytes(&value.to_le_bytes());
    }

    fn write_u32(&mut self, value: u32) {
        self.write_bytes(&value.to_le_bytes());
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        let end = self.offset + bytes.len();
        self.data[self.offset..end].copy_from_slice(bytes);
        self.offset = end;
    }
}

fn require_mapping_id(value: u64) -> ParserResult<usize> {
    let mapping_id = usize::try_from(value).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "RPU mapping ID does not fit usize")
    })?;
    if mapping_id > MAXIMUM_MAPPING_ID {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            format!("RPU mapping ID {mapping_id} exceeds {MAXIMUM_MAPPING_ID}"),
        ));
    }
    Ok(mapping_id)
}

fn require_u32(value: u64, name: &str) -> ParserResult<u32> {
    u32::try_from(value).map_err(|_| {
        ParserFailure::new(
            STATUS_INVALID_MAPPING,
            format!("{name} does not fit the packed schema"),
        )
    })
}

/// Maps syntax the vendored crate cannot parse to the status of other unsupported metadata
fn unsupported_syntax_failure(syntax: UnsupportedRpuSyntax) -> ParserFailure {
    let message = match syntax {
        UnsupportedRpuSyntax::MissingSequenceInfo => {
            "RPU VDR sequence information is required".to_string()
        }
        UnsupportedRpuSyntax::RpuFormat(rpu_format) => {
            format!("Dolby Vision RPU format {rpu_format:#05X} is unsupported")
        }
        UnsupportedRpuSyntax::DmCompression(method) => {
            format!("Dolby Vision display metadata compression method {method} is unsupported")
        }
    };
    ParserFailure::new(STATUS_UNSUPPORTED_METADATA, message)
}

/// Applies the header policy before any prior mapping or display metadata state is consulted
fn validate_rpu_policy(rpu: &DoviRpu) -> ParserResult<()> {
    if !matches!(rpu.dovi_profile, 4 | 5 | 7 | 8) {
        return Err(ParserFailure::new(
            STATUS_UNSUPPORTED_METADATA,
            format!("Dolby Vision profile {} is unsupported", rpu.dovi_profile),
        ));
    }
    let header = &rpu.header;
    if !header.vdr_seq_info_present_flag {
        return Err(unsupported_syntax_failure(
            UnsupportedRpuSyntax::MissingSequenceInfo,
        ));
    }
    if header.rpu_format & RPU_FORMAT_EXTENSION_MASK != 0 {
        return Err(unsupported_syntax_failure(UnsupportedRpuSyntax::RpuFormat(
            header.rpu_format,
        )));
    }
    validate_rpu_header(header)?;

    // FFmpeg's dm_compression checks, which precede the payload
    match header.reserved_zero_3bits {
        UNCOMPRESSED_DISPLAY_METADATA => Ok(()),
        COMPRESSED_DISPLAY_METADATA if header.vdr_dm_metadata_present_flag => Ok(()),
        COMPRESSED_DISPLAY_METADATA => Err(ParserFailure::new(
            STATUS_INVALID_COLOR_METADATA,
            "RPU declares compressed display metadata but carries none",
        )),
        method => Err(unsupported_syntax_failure(
            UnsupportedRpuSyntax::DmCompression(method),
        )),
    }
}

/// FFmpeg's denominator for the ycc_to_rgb offsets of display metadata an RPU carries
fn rpu_ycc_to_rgb_offset_scale(profile: u8) -> f32 {
    match profile {
        4 => PROFILE_4_YCC_TO_RGB_OFFSET_SCALE,
        _ => YCC_TO_RGB_OFFSET_SCALE,
    }
}

fn validate_color_metadata(color: &VdrDmData) -> ParserResult<()> {
    if color.affected_dm_metadata_id != color.current_dm_metadata_id {
        return Err(ParserFailure::new(
            STATUS_INVALID_COLOR_METADATA,
            "Affected and current Dolby Vision metadata IDs differ",
        ));
    }
    if color.signal_bit_depth < 8 || color.signal_bit_depth > 16 {
        return Err(ParserFailure::new(
            STATUS_INVALID_COLOR_METADATA,
            "Dolby Vision signal bit depth is outside 8 through 16",
        ));
    }
    Ok(())
}

fn validate_rpu_header(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<()> {
    let bit_depth_values = [
        header.bl_bit_depth_minus8,
        header.el_bit_depth_minus8,
        header.vdr_bit_depth_minus8,
    ];
    if bit_depth_values.iter().any(|value| *value > 8) {
        return Err(ParserFailure::new(
            STATUS_UNSUPPORTED_METADATA,
            "Dolby Vision bit depth is outside 8 through 16",
        ));
    }
    if header.coefficient_log2_denom > 32 {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Coefficient denominator exceeds 32 bits",
        ));
    }
    Ok(())
}

// These defaults match the decoder state used by the pinned FFmpeg reference when an RPU omits explicit display metadata.
// FFmpeg defines their offsets in 2^28 units for every profile
fn default_color_metadata() -> VdrDmData {
    VdrDmData {
        ycc_to_rgb_coef0: 9_575,
        ycc_to_rgb_coef1: 0,
        ycc_to_rgb_coef2: 14_742,
        ycc_to_rgb_coef3: 9_575,
        ycc_to_rgb_coef4: 1_754,
        ycc_to_rgb_coef5: 4_383,
        ycc_to_rgb_coef6: 9_575,
        ycc_to_rgb_coef7: 17_372,
        ycc_to_rgb_coef8: 0,
        ycc_to_rgb_offset0: 67_108_864,
        ycc_to_rgb_offset1: 536_870_912,
        ycc_to_rgb_offset2: 536_870_912,
        rgb_to_lms_coef0: 5_845,
        rgb_to_lms_coef1: 9_702,
        rgb_to_lms_coef2: 837,
        rgb_to_lms_coef3: 2_568,
        rgb_to_lms_coef4: 12_256,
        rgb_to_lms_coef5: 1_561,
        rgb_to_lms_coef6: 0,
        rgb_to_lms_coef7: 679,
        rgb_to_lms_coef8: 15_705,
        signal_eotf: 39_322,
        signal_eotf_param0: 15_867,
        signal_eotf_param1: 228,
        signal_eotf_param2: 1_383_604,
        signal_bit_depth: 14,
        signal_color_space: 0,
        signal_chroma_format: 0,
        signal_full_range_flag: 1,
        source_min_pq: 62,
        source_max_pq: 3_696,
        source_diagonal: 42,
        ..VdrDmData::default()
    }
}

fn write_padded_matrix(writer: &mut PackedWriter<'_>, matrix: &[i16; 9], scale: f32) {
    for row_index in 0..3 {
        for column_index in 0..3 {
            writer.write_f32(matrix[(row_index * 3) + column_index] as f32 / scale);
        }
        writer.write_f32(0.0);
    }
}

fn pack_component(
    curve: &DoviReshapingCurve,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<PackedComponent> {
    let num_pivots = curve.pivots.len();
    if !(2..=MAXIMUM_PIVOT_COUNT).contains(&num_pivots)
        || curve.num_pivots_minus2 as usize + 2 != num_pivots
    {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Dolby Vision reshaping pivot count is invalid",
        ));
    }
    let segment_count = num_pivots - 1;
    if curve.mapping_idc.len() != segment_count {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Dolby Vision reshape does not give every piece a mapping method",
        ));
    }
    let bit_depth = u32::try_from(header.bl_bit_depth_minus8 + 8).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "Base-layer bit depth is invalid")
    })?;
    let pivot_denominator = (1_u32 << bit_depth) - 1;
    let mut packed = PackedComponent {
        num_pivots: num_pivots as u32,
        ..PackedComponent::default()
    };
    // Linear interpolation pieces derive their polynomials from float64 pivots, not the packed float32 ones
    let mut pivots = [0.0_f64; MAXIMUM_PIVOT_COUNT];
    let mut cumulative_pivot = 0_u32;
    for (pivot_index, pivot_delta) in curve.pivots.iter().enumerate() {
        cumulative_pivot = cumulative_pivot
            .checked_add(*pivot_delta as u32)
            .ok_or_else(|| {
                ParserFailure::new(STATUS_INVALID_MAPPING, "Dolby Vision pivot overflowed")
            })?;
        if cumulative_pivot > pivot_denominator {
            return Err(ParserFailure::new(
                STATUS_INVALID_MAPPING,
                "Dolby Vision pivot exceeds the base-layer range",
            ));
        }
        packed.pivots[pivot_index] = cumulative_pivot as f32 / pivot_denominator as f32;
        pivots[pivot_index] = f64::from(cumulative_pivot) / f64::from(pivot_denominator);
    }

    // Each method's curve holds its pieces in coded order
    let mut linear_pieces = [None; MAXIMUM_SEGMENT_COUNT];
    let mut polynomial_piece_count = 0;
    let mut mmr_piece_count = 0;
    let mut mmr_vector_count = 0;
    for (segment_index, mapping_method) in curve.mapping_idc.iter().enumerate() {
        match mapping_method {
            DoviMappingMethod::Polynomial => {
                let polynomial = curve.polynomial.as_ref().ok_or_else(|| {
                    ParserFailure::new(
                        STATUS_INVALID_MAPPING,
                        "Polynomial reshape is missing its coefficients",
                    )
                })?;
                linear_pieces[segment_index] = pack_polynomial_segment(
                    &mut packed.segment_data[segment_index],
                    polynomial,
                    polynomial_piece_count,
                    segment_index + 1 == segment_count,
                    header,
                )?;
                polynomial_piece_count += 1;
                packed.flags |= COMPONENT_FLAG_POLYNOMIAL;
            }
            DoviMappingMethod::MMR => {
                let mmr = curve.mmr.as_ref().ok_or_else(|| {
                    ParserFailure::new(
                        STATUS_INVALID_MAPPING,
                        "MMR reshape is missing its coefficients",
                    )
                })?;
                mmr_vector_count = pack_mmr_segment(
                    &mut packed,
                    segment_index,
                    mmr,
                    mmr_piece_count,
                    mmr_vector_count,
                    header,
                )?;
                mmr_piece_count += 1;
                packed.flags |= COMPONENT_FLAG_MMR;
            }
            DoviMappingMethod::Invalid => {
                return Err(ParserFailure::new(
                    STATUS_INVALID_MAPPING,
                    "Dolby Vision reshape uses an invalid mapping method",
                ));
            }
        }
    }
    let polynomial_pieces_match = curve
        .polynomial
        .as_ref()
        .is_none_or(|polynomial| polynomial.poly_order_minus1.len() == polynomial_piece_count);
    let mmr_pieces_match = curve
        .mmr
        .as_ref()
        .is_none_or(|mmr| mmr.mmr_order_minus1.len() == mmr_piece_count);
    if !polynomial_pieces_match || !mmr_pieces_match {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Dolby Vision reshape pieces disagree with their mapping methods",
        ));
    }
    packed.mmr_vector_count = mmr_vector_count as u32;
    pack_linear_interpolation_segments(
        &mut packed,
        &linear_pieces[..segment_count],
        &curve.mapping_idc,
        &pivots,
    )?;
    Ok(packed)
}

/// Packs one polynomial piece's coefficients, or returns the coded values of a linear interpolation piece, whose polynomial depends on the pieces around it
fn pack_polynomial_segment(
    segment: &mut [f32; 4],
    polynomial: &DoviPolynomialCurve,
    piece_index: usize,
    last_piece: bool,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<Option<LinearInterpolationPiece>> {
    let (Some(order_minus1), Some(coefficients)) = (
        polynomial.poly_order_minus1.get(piece_index),
        polynomial.poly_coef.get(piece_index),
    ) else {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Polynomial reshape segment arrays have inconsistent lengths",
        ));
    };
    let linear_interpolation = *order_minus1 == 0
        && polynomial
            .linear_interp_flag
            .get(piece_index)
            .copied()
            .unwrap_or(false);
    if linear_interpolation {
        return linear_interpolation_piece(polynomial, piece_index, last_piece, header).map(Some);
    }

    let coefficient_count = *order_minus1 as usize + 2;
    if !(2..=3).contains(&coefficient_count) || coefficients.len() != coefficient_count {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Polynomial reshape coefficient count is invalid",
        ));
    }
    for (coefficient_index, coefficient) in coefficients.iter().enumerate() {
        let integer = polynomial
            .poly_coef_int
            .get(piece_index)
            .and_then(|values| values.get(coefficient_index))
            .copied();
        segment[coefficient_index] = signed_coefficient(header, integer, *coefficient)?;
    }
    Ok(None)
}

/// Reads the unsigned rises a linear interpolation piece codes on the polynomial coefficients' scale: to its start pivot and, for the last piece, to its end pivot
fn linear_interpolation_piece(
    polynomial: &DoviPolynomialCurve,
    piece_index: usize,
    last_piece: bool,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<LinearInterpolationPiece> {
    let fractional_values = polynomial
        .pred_linear_interp_value
        .get(piece_index)
        .map_or(&[][..], |values| values.as_slice());
    let integer_values = polynomial
        .pred_linear_interp_value_int
        .get(piece_index)
        .map_or(&[][..], |values| values.as_slice());
    let value_count = if last_piece { 2 } else { 1 };
    if fractional_values.len() != value_count {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Linear interpolation piece codes an unexpected number of values",
        ));
    }
    let value = |value_index: usize| {
        unsigned_coefficient_value(
            header,
            integer_values.get(value_index).copied(),
            fractional_values[value_index],
        )
    };
    Ok(LinearInterpolationPiece {
        start_rise: value(0)?,
        end_rise: if last_piece { Some(value(1)?) } else { None },
    })
}

/// Packs each linear interpolation piece as the order-1 polynomial between the curve's values at its pivots, so the shader evaluates it like any polynomial piece
fn pack_linear_interpolation_segments(
    packed: &mut PackedComponent,
    linear_pieces: &[Option<LinearInterpolationPiece>],
    mapping_methods: &[DoviMappingMethod],
    pivots: &[f64],
) -> ParserResult<()> {
    // The curve's value at each pivot that has a scalar one.
    // A coded rise adds to the previous pivot's value, which a polynomial piece takes at its start.
    // An MMR piece maps all three components together, so its pivot has no scalar value
    let mut pivot_values: [Option<f64>; MAXIMUM_PIVOT_COUNT] = [None; MAXIMUM_PIVOT_COUNT];
    for (segment_index, (linear_piece, mapping_method)) in
        linear_pieces.iter().zip(mapping_methods).enumerate()
    {
        let Some(linear_piece) = linear_piece else {
            if let DoviMappingMethod::Polynomial = mapping_method {
                let [constant, linear, quadratic, _] =
                    packed.segment_data[segment_index].map(f64::from);
                let pivot = pivots[segment_index];
                pivot_values[segment_index] =
                    Some(constant + ((linear + (quadratic * pivot)) * pivot));
            }
            continue;
        };
        let previous_value = match segment_index.checked_sub(1) {
            Some(previous_segment_index) => {
                pivot_values[previous_segment_index].ok_or_else(|| {
                    ParserFailure::new(
                        STATUS_UNSUPPORTED_METADATA,
                        "Dolby Vision linear interpolation after an MMR piece is unsupported",
                    )
                })?
            }
            None => 0.0,
        };
        let start_value = previous_value + linear_piece.start_rise;
        pivot_values[segment_index] = Some(start_value);
        // Only the last piece codes the rise to its end pivot
        if let Some(end_rise) = linear_piece.end_rise {
            pivot_values[segment_index + 1] = Some(start_value + end_rise);
        }
    }

    for (segment_index, linear_piece) in linear_pieces.iter().enumerate() {
        if linear_piece.is_none() {
            continue;
        }
        let next_segment_index = segment_index + 1;
        let (Some(start_value), Some(end_value)) = (
            pivot_values[segment_index],
            pivot_values[next_segment_index],
        ) else {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Dolby Vision linear interpolation before an MMR piece is unsupported",
            ));
        };
        let start_pivot = pivots[segment_index];
        let end_pivot = pivots[next_segment_index];
        // A zero-width piece keeps its start value
        let slope = if end_pivot > start_pivot {
            (end_value - start_value) / (end_pivot - start_pivot)
        } else {
            0.0
        };
        packed.segment_data[segment_index] = [
            finite_f32(start_value - (slope * start_pivot))?,
            finite_f32(slope)?,
            0.0,
            0.0,
        ];
    }
    Ok(())
}

/// Packs one MMR piece, with its coefficient vectors after those of the component's earlier MMR pieces, and returns the next free vector index
fn pack_mmr_segment(
    packed: &mut PackedComponent,
    segment_index: usize,
    mmr: &DoviMMRCurve,
    piece_index: usize,
    first_vector_index: usize,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<usize> {
    let (Some(order_minus1), Some(constant), Some(orders)) = (
        mmr.mmr_order_minus1.get(piece_index),
        mmr.mmr_constant.get(piece_index),
        mmr.mmr_coef.get(piece_index),
    ) else {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "MMR reshape segment arrays have inconsistent lengths",
        ));
    };
    let order = *order_minus1 as usize + 1;
    if !(1..=MAXIMUM_MMR_ORDER).contains(&order) || orders.len() != order {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "MMR reshape order is invalid",
        ));
    }
    packed.segment_data[segment_index][0] = signed_coefficient(
        header,
        mmr.mmr_constant_int.get(piece_index).copied(),
        *constant,
    )?;
    packed.segment_data[segment_index][1] = first_vector_index as f32;
    packed.segment_data[segment_index][3] = order as f32;

    let mut mmr_vector_index = first_vector_index;
    for (order_index, order_coefficients) in orders.iter().enumerate() {
        if order_coefficients.len() != MAXIMUM_MMR_COEFFICIENT_COUNT
            || mmr_vector_index + 1 >= MAXIMUM_MMR_VECTOR_COUNT
        {
            return Err(ParserFailure::new(
                STATUS_INVALID_MAPPING,
                "MMR reshape coefficient array exceeds its packed bound",
            ));
        }
        let mut coefficients = [0.0_f32; MAXIMUM_MMR_COEFFICIENT_COUNT];
        for (coefficient_index, coefficient) in coefficients.iter_mut().enumerate() {
            let integer = mmr
                .mmr_coef_int
                .get(piece_index)
                .and_then(|orders| orders.get(order_index))
                .and_then(|values| values.get(coefficient_index))
                .copied();
            *coefficient =
                signed_coefficient(header, integer, order_coefficients[coefficient_index])?;
        }
        packed.mmr_data[mmr_vector_index] =
            [coefficients[0], coefficients[1], coefficients[2], 0.0];
        packed.mmr_data[mmr_vector_index + 1] = [
            coefficients[3],
            coefficients[4],
            coefficients[5],
            coefficients[6],
        ];
        mmr_vector_index += 2;
    }
    Ok(mmr_vector_index)
}

fn pack_nlq(
    mapping: &RpuDataMapping,
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<([PackedNLQData; 3], u32)> {
    let Some(nlq) = &mapping.nlq else {
        if !header.disable_residual_flag {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Enabled enhancement residual has no LINEAR_DZ metadata",
            ));
        }
        return Ok(([PackedNLQData::default(); 3], 0));
    };
    if mapping.nlq_method_idc.is_none() {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "NLQ data has no declared method",
        ));
    }

    let mut packed = [PackedNLQData::default(); 3];
    let el_bit_depth = u32::try_from(header.el_bit_depth_minus8 + 8).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "Enhancement bit depth is invalid")
    })?;
    let el_denominator = ((1_u32 << el_bit_depth) - 1) as f32;
    let mut trivial = true;
    for (component_index, packed_component) in packed.iter_mut().enumerate() {
        let vdr_in_max = unsigned_coefficient(
            header,
            nlq.vdr_in_max_int[component_index],
            nlq.vdr_in_max[component_index],
        )?;
        let slope = unsigned_coefficient(
            header,
            nlq.linear_deadzone_slope_int[component_index],
            nlq.linear_deadzone_slope[component_index],
        )?;
        let threshold = unsigned_coefficient(
            header,
            nlq.linear_deadzone_threshold_int[component_index],
            nlq.linear_deadzone_threshold[component_index],
        )?;
        trivial &= nlq.nlq_offset[component_index] == 0
            && vdr_in_max == 1.0
            && slope == 0.0
            && threshold == 0.0;
        *packed_component = PackedNLQData {
            deadzone_slope: el_denominator * slope,
            deadzone_threshold: threshold - (0.5 * slope),
            offset: nlq.nlq_offset[component_index] as f32 / el_denominator,
            vdr_in_max,
        };
    }

    let mut flags = FLAG_NLQ_PRESENT;
    match nlq.el_type() {
        DoviELType::MEL => flags |= FLAG_MEL,
        DoviELType::FEL => flags |= FLAG_FEL,
    }
    if !header.disable_residual_flag && !trivial {
        flags |= FLAG_NLQ_ACTIVE;
    }
    Ok((packed, flags))
}

fn signed_coefficient(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    integer: Option<i64>,
    fractional: u64,
) -> ParserResult<f32> {
    let value = match header.coefficient_data_type {
        0 => {
            let integer = integer.ok_or_else(|| {
                ParserFailure::new(
                    STATUS_INVALID_MAPPING,
                    "Fixed-point coefficient is missing its integer part",
                )
            })?;
            integer as f64 + fractional as f64 / coefficient_scale(header)?
        }
        1 => float_coefficient(fractional)?,
        _ => {
            return Err(ParserFailure::new(
                STATUS_UNSUPPORTED_METADATA,
                "Dolby Vision coefficient data type is unsupported",
            ));
        }
    };
    finite_f32(value)
}

fn unsigned_coefficient(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    integer: u64,
    fractional: u64,
) -> ParserResult<f32> {
    finite_f32(unsigned_coefficient_value(
        header,
        Some(integer),
        fractional,
    )?)
}

/// An unsigned coefficient at full precision.
/// Only fixed-point coefficients code an integer part
fn unsigned_coefficient_value(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
    integer: Option<u64>,
    fractional: u64,
) -> ParserResult<f64> {
    match header.coefficient_data_type {
        0 => {
            let integer = integer.ok_or_else(|| {
                ParserFailure::new(
                    STATUS_INVALID_MAPPING,
                    "Fixed-point coefficient is missing its integer part",
                )
            })?;
            Ok(integer as f64 + fractional as f64 / coefficient_scale(header)?)
        }
        1 => float_coefficient(fractional),
        _ => Err(ParserFailure::new(
            STATUS_UNSUPPORTED_METADATA,
            "Dolby Vision coefficient data type is unsupported",
        )),
    }
}

fn coefficient_scale(
    header: &dolby_vision::rpu::rpu_data_header::RpuDataHeader,
) -> ParserResult<f64> {
    let denominator = u32::try_from(header.coefficient_log2_denom).map_err(|_| {
        ParserFailure::new(STATUS_INVALID_MAPPING, "Coefficient denominator is invalid")
    })?;
    if denominator > 32 {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Coefficient denominator exceeds 32 bits",
        ));
    }
    Ok((1_u64 << denominator) as f64)
}

fn float_coefficient(bits: u64) -> ParserResult<f64> {
    let bits = u32::try_from(bits).map_err(|_| {
        ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Floating coefficient does not fit 32 bits",
        )
    })?;
    let value = f32::from_bits(bits);
    if !value.is_finite() {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Floating coefficient is not finite",
        ));
    }
    Ok(value as f64)
}

fn finite_f32(value: f64) -> ParserResult<f32> {
    let packed = value as f32;
    if !packed.is_finite() {
        return Err(ParserFailure::new(
            STATUS_INVALID_MAPPING,
            "Coefficient exceeds finite float32 range",
        ));
    }
    Ok(packed)
}

fn parse_context<'a>(context: *mut c_void) -> Option<&'a mut ParserContext> {
    if context.is_null() {
        return None;
    }
    // SAFETY: The exported API creates and exclusively owns this pointer.
    Some(unsafe { &mut *(context.cast::<ParserContext>()) })
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_schema_version() -> u32 {
    PARSER_SCHEMA_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_revision_prefix() -> u32 {
    PARSER_REVISION_PREFIX
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_output_byte_length() -> u32 {
    OUTPUT_BYTE_LENGTH as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_maximum_buffer_byte_length() -> u32 {
    MAXIMUM_SHARED_BUFFER_BYTE_LENGTH as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_maximum_memory_byte_length() -> u32 {
    MAXIMUM_LINEAR_MEMORY_BYTE_LENGTH
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_create() -> *mut c_void {
    Box::into_raw(Box::new(ParserContext::default())).cast::<c_void>()
}

#[unsafe(no_mangle)]
/// Destroys one context returned by `dovi_parser_create`.
///
/// # Safety
/// The pointer must be live and must not be used or destroyed again.
pub unsafe extern "C" fn dovi_parser_destroy(context: *mut c_void) {
    if context.is_null() {
        return;
    }
    // SAFETY: The caller relinquishes the pointer returned by create exactly once.
    unsafe {
        drop(Box::from_raw(context.cast::<ParserContext>()));
    }
}

#[unsafe(no_mangle)]
/// Clears the mapping and display metadata state of one live parser context.
///
/// # Safety
/// The pointer must identify a live context returned by `dovi_parser_create`.
pub unsafe extern "C" fn dovi_parser_reset(context: *mut c_void) -> i32 {
    let Some(context) = parse_context(context) else {
        return STATUS_INVALID_ARGUMENT;
    };
    context.reset();
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn dovi_parser_allocate(byte_length: u32) -> *mut u8 {
    let byte_length = byte_length as usize;
    if byte_length == 0 || byte_length > MAXIMUM_SHARED_BUFFER_BYTE_LENGTH {
        return null_mut();
    }
    let Ok(layout) = Layout::array::<u8>(byte_length) else {
        return null_mut();
    };
    // SAFETY: The matching exported deallocator receives the same layout.
    unsafe { alloc_zeroed(layout) }
}

#[unsafe(no_mangle)]
/// Releases one buffer returned by `dovi_parser_allocate`.
///
/// # Safety
/// The pointer and byte length must exactly match one live allocation.
pub unsafe extern "C" fn dovi_parser_deallocate(pointer: *mut u8, byte_length: u32) {
    let byte_length = byte_length as usize;
    if pointer.is_null() || byte_length == 0 || byte_length > MAXIMUM_SHARED_BUFFER_BYTE_LENGTH {
        return;
    }
    let Ok(layout) = Layout::array::<u8>(byte_length) else {
        return;
    };
    // SAFETY: The TypeScript wrapper preserves the original allocation length.
    unsafe {
        dealloc(pointer, layout);
    }
}

#[unsafe(no_mangle)]
/// Parses one HEVC UNSPEC62 NAL unit RPU into the fixed schema output buffer.
///
/// # Safety
/// The context and both buffers must be live, non-overlapping allocations from this module with at least the supplied lengths.
pub unsafe extern "C" fn dovi_parser_parse(
    context_pointer: *mut c_void,
    input_pointer: *const u8,
    input_byte_length: u32,
    output_pointer: *mut u8,
    output_byte_length: u32,
) -> i32 {
    // SAFETY: The caller upholds the contract this function shares with the helper.
    unsafe {
        parse_exported_input(
            context_pointer,
            input_pointer,
            input_byte_length,
            output_pointer,
            output_byte_length,
            RpuFraming::HEVCUnspec62NALUnit,
        )
    }
}

#[unsafe(no_mangle)]
/// Parses the ITU-T T.35 payload of one AV1 Dolby Vision metadata OBU, from its country code or its provider code to the end of the OBU payload, into the fixed schema output buffer.
/// It shares the context's mapping and display metadata state with `dovi_parser_parse`.
///
/// # Safety
/// The context and both buffers must be live, non-overlapping allocations from this module with at least the supplied lengths.
pub unsafe extern "C" fn dovi_parser_parse_av1_t35(
    context_pointer: *mut c_void,
    input_pointer: *const u8,
    input_byte_length: u32,
    output_pointer: *mut u8,
    output_byte_length: u32,
) -> i32 {
    // SAFETY: The caller upholds the contract this function shares with the helper.
    unsafe {
        parse_exported_input(
            context_pointer,
            input_pointer,
            input_byte_length,
            output_pointer,
            output_byte_length,
            RpuFraming::AV1ITUTT35Payload,
        )
    }
}

/// Validates the exported buffers, then parses one framed RPU into the fixed schema output buffer.
///
/// # Safety
/// The context and both buffers must be live, non-overlapping allocations from this module with at least the supplied lengths.
unsafe fn parse_exported_input(
    context_pointer: *mut c_void,
    input_pointer: *const u8,
    input_byte_length: u32,
    output_pointer: *mut u8,
    output_byte_length: u32,
    framing: RpuFraming,
) -> i32 {
    let Some(context) = parse_context(context_pointer) else {
        return STATUS_INVALID_ARGUMENT;
    };
    if input_pointer.is_null() || output_pointer.is_null() {
        let failure = ParserFailure::new(STATUS_INVALID_ARGUMENT, "Parser buffer is null");
        context.record_error(&failure);
        return failure.code;
    }
    let input_byte_length = input_byte_length as usize;
    if input_byte_length == 0 || input_byte_length > MAXIMUM_SHARED_BUFFER_BYTE_LENGTH {
        let failure = ParserFailure::new(
            STATUS_INPUT_TOO_LARGE,
            "RPU input length is zero or exceeds 64 KiB",
        );
        context.record_error(&failure);
        return failure.code;
    }
    if output_byte_length as usize != OUTPUT_BYTE_LENGTH {
        let failure = ParserFailure::new(
            STATUS_INVALID_ARGUMENT,
            format!("Parser output length does not match schema version {PARSER_SCHEMA_VERSION}"),
        );
        context.record_error(&failure);
        return failure.code;
    }

    // SAFETY: The caller allocated both bounded regions from this module.
    let input = unsafe { slice::from_raw_parts(input_pointer, input_byte_length) };
    // SAFETY: The output length was checked against OUTPUT_BYTE_LENGTH above.
    let output = unsafe { slice::from_raw_parts_mut(output_pointer, OUTPUT_BYTE_LENGTH) };
    match context.parse(input, framing, output) {
        Ok(()) => 0,
        Err(failure) => {
            context.record_error(&failure);
            failure.code
        }
    }
}

#[unsafe(no_mangle)]
/// Returns a borrowed diagnostic pointer owned by a live parser context.
///
/// # Safety
/// The context pointer must remain live until the diagnostic is copied.
pub unsafe extern "C" fn dovi_parser_last_error_pointer(context: *const c_void) -> *const u8 {
    if context.is_null() {
        return null();
    }
    // SAFETY: The pointer remains owned by the live parser context.
    let context = unsafe { &*(context.cast::<ParserContext>()) };
    context.last_error.as_ptr()
}

#[unsafe(no_mangle)]
/// Returns the current borrowed diagnostic length.
///
/// # Safety
/// The context pointer must identify a live parser context.
pub unsafe extern "C" fn dovi_parser_last_error_byte_length(context: *const c_void) -> u32 {
    if context.is_null() {
        return 0;
    }
    // SAFETY: The pointer remains owned by the live parser context.
    let context = unsafe { &*(context.cast::<ParserContext>()) };
    context.last_error_length as u32
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use super::*;
    use dolby_vision::av1::convert_regular_rpu_to_av1_payload;
    use dolby_vision::rpu::ConversionMode;
    use dolby_vision::rpu::extension_metadata::blocks::ExtMetadataBlockLevel1;
    use dolby_vision::rpu::extension_metadata::{CmV29DmData, DmData, WithExtMetadataBlocks};
    use dolby_vision::rpu::generate::GenerateConfig;
    use dolby_vision::rpu::rpu_data_header::RpuDataHeader;
    use dolby_vision::utils::{
        add_start_code_emulation_prevention_3_byte, clear_start_code_emulation_prevention_3_byte,
    };

    // Packed header words, in PackedSnapshot::write order
    const FLAGS_WORD: usize = 3;
    const PROFILE_WORD: usize = 5;
    const RPU_FORMAT_WORD: usize = 7;
    const COEFFICIENT_DATA_TYPE_WORD: usize = 10;
    const BASE_LAYER_BIT_DEPTH_WORD: usize = 12;
    const MAPPING_ID_WORD: usize = 21;
    const PREVIOUS_MAPPING_ID_WORD: usize = 22;
    const MAPPING_COLOR_SPACE_WORD: usize = 23;
    const MAPPING_CHROMA_FORMAT_WORD: usize = 24;
    const SIGNAL_EOTF_WORD: usize = 27;
    const SOURCE_MAXIMUM_PQ_WORD: usize = 36;
    const LEVEL1_MINIMUM_PQ_WORD: usize = 38;
    const LEVEL1_MAXIMUM_PQ_WORD: usize = 39;
    const LEVEL1_AVERAGE_PQ_WORD: usize = 40;
    const SCENE_REFRESH_WORD: usize = 41;
    const AFFECTED_DM_METADATA_ID_WORD: usize = 42;
    const COMPONENT_BYTE_OFFSET: usize =
        HEADER_BYTE_LENGTH + ((COLOR_FLOAT_COUNT + NLQ_FLOAT_COUNT) * size_of::<f32>());
    const LUMA_PIVOT_BYTE_OFFSET: usize =
        COMPONENT_BYTE_OFFSET + (COMPONENT_HEADER_U32_COUNT * size_of::<u32>());

    // Packed component words and vectors, in PackedComponent::write order
    const COMPONENT_MMR_VECTOR_COUNT_WORD: usize = 1;
    const COMPONENT_FLAGS_WORD: usize = 2;
    const PACKED_VECTOR_BYTE_LENGTH: usize = 4 * size_of::<f32>();
    const COMPONENT_SEGMENT_BYTE_OFFSET: usize =
        (COMPONENT_HEADER_U32_COUNT + COMPONENT_PIVOT_FLOAT_COUNT) * size_of::<u32>();
    const COMPONENT_MMR_BYTE_OFFSET: usize =
        COMPONENT_SEGMENT_BYTE_OFFSET + (COMPONENT_SEGMENT_FLOAT_COUNT * size_of::<f32>());

    // The crate's Profile 8.1 header codes 10-bit pivots and 23 coefficient fraction bits
    const PIVOT_CODE_MAXIMUM: f64 = 1_023.0;
    const COEFFICIENT_LOG2_DENOMINATOR: u64 = 23;
    const COEFFICIENT_SCALE: f64 = (1_u64 << COEFFICIENT_LOG2_DENOMINATOR) as f64;
    const FLOAT_COEFFICIENT_DATA_TYPE: u8 = 1;
    const FLOAT_COEFFICIENT_BIT_LENGTH: u32 = 32;
    // Packed linear interpolation polynomials are float32 coefficients derived in float64
    const LINEAR_INTERPOLATION_TOLERANCE: f64 = 0.000_001;

    // The engine names its folders in this file, which the Makefile also reads through Node
    const ENGINE_LAYOUT_FILE: &str = "tools/constants.json";
    const TEST_VECTORS_DIRECTORY_KEY: &str = "testVectorsDirectory";
    const RPU_VECTOR_DIRECTORY: &str = "dolby-vision-rpu";
    const RPU_VECTOR_EXTENSION: &str = "bin";
    const ITU_T_T35_COUNTRY_CODE_UNITED_STATES: u8 = 0xB5;
    // The AV1 trailing bits and zero padding that may end an OBU after its T.35 payload
    const OBU_TRAILING_BYTES: [u8; 3] = [0x80, 0x00, 0x00];
    // The country code, the provider code, the provider-oriented code, and the EMDF header bits FFmpeg reads as one fixed value
    const ITU_T_T35_PROVIDER_CODE_DOLBY: u64 = 0x003B;
    const ITU_T_T35_PROVIDER_ORIENTED_CODE_DOLBY: u64 = 0x0800;
    const EMDF_HEADER: u64 = 0x01BE_6841;
    const EMDF_HEADER_BIT_LENGTH: usize = 27;
    const EMDF_VARIABLE_BITS_CHUNK_BIT_LENGTH: usize = 8;
    // The input lengths upstream requires before parsing an HEVC or an AV1 RPU
    const UPSTREAM_MINIMUM_HEVC_INPUT_BYTE_LENGTH: usize = 25;
    const UPSTREAM_MINIMUM_AV1_INPUT_BYTE_LENGTH: usize = 34;

    // The prefix byte, rpu_type, rpu_format, vdr_rpu_profile, vdr_rpu_level, and vdr_seq_info_present_flag
    const FIXED_HEADER_BIT_LENGTH: usize = 8 + 6 + 11 + 4 + 4 + 1;
    const RPU_FORMAT_BIT_OFFSET: usize = 8 + 6;
    const RPU_FORMAT_BIT_LENGTH: usize = 11;
    const DM_COMPRESSION_BIT_LENGTH: usize = 3;
    // The CRC32 and the 0x80 terminator
    const RPU_TRAILER_BYTE_LENGTH: usize = 5;
    const CRC32_MPEG2_POLYNOMIAL: u32 = 0x04C1_1DB7;
    const HEVC_UNSPEC62_NAL_HEADER: [u8; 2] = [0x7C, 0x01];
    const RPU_TERMINATOR: u8 = 0x80;

    // Level 1 values the extension section tests expect to survive every other block
    const LEVEL1_VALUES: [u64; 3] = [5, 2_000, 1_000];
    const LEVEL1_WORDS: [u32; 3] = [5, 2_000, 1_000];
    const DECOY_LEVEL1_VALUES: [u64; 3] = [0, 4_095, 2_048];
    const PQ_FIELD_BIT_LENGTH: usize = 12;
    const NEUTRAL_TRIM: u64 = 2_048;

    /// Writes bits most significant first, to code extension sections the crate's writer refuses
    #[derive(Default)]
    struct BitWriter {
        bytes: Vec<u8>,
        bit_length: usize,
    }

    impl BitWriter {
        fn write_bits(&mut self, value: u64, bit_count: usize) {
            for bit_index in (0..bit_count).rev() {
                if self.bit_length.is_multiple_of(8) {
                    self.bytes.push(0);
                }
                if (value >> bit_index) & 1 == 1 {
                    *self.bytes.last_mut().unwrap() |= 0x80 >> (self.bit_length % 8);
                }
                self.bit_length += 1;
            }
        }

        fn write_unsigned_exp_golomb(&mut self, value: u64) {
            let code = value + 1;
            let significant_bit_count = (u64::BITS - code.leading_zeros()) as usize;
            self.write_bits(0, significant_bit_count - 1);
            self.write_bits(code, significant_bit_count);
        }

        /// Fills the current byte with one bit value and returns how many bits that took
        fn fill_to_byte(&mut self, bit: u64) -> usize {
            let mut fill_bit_count = 0;
            while !self.bit_length.is_multiple_of(8) {
                self.write_bits(bit, 1);
                fill_bit_count += 1;
            }
            fill_bit_count
        }
    }

    /// One extension block as an encoder codes it: leading payload fields, then padding up to the coded byte length
    struct CodedBlock {
        level: u8,
        length: u64,
        fields: Vec<(u64, usize)>,
        padding_bit: u64,
    }

    fn level1_block(values: [u64; 3]) -> CodedBlock {
        CodedBlock {
            level: 1,
            length: 5,
            fields: values.map(|value| (value, PQ_FIELD_BIT_LENGTH)).to_vec(),
            padding_bit: 0,
        }
    }

    /// An L2 trim for one target display: six 12-bit fields, then the 13-bit ms_weight
    fn level2_block() -> CodedBlock {
        let mut fields = vec![(NEUTRAL_TRIM, PQ_FIELD_BIT_LENGTH); 6];
        fields.push((NEUTRAL_TRIM, 13));
        CodedBlock {
            level: 2,
            length: 11,
            fields,
            padding_bit: 0,
        }
    }

    fn level3_block() -> CodedBlock {
        CodedBlock {
            level: 3,
            length: 5,
            fields: vec![(NEUTRAL_TRIM, PQ_FIELD_BIT_LENGTH); 3],
            padding_bit: 0,
        }
    }

    /// The standard 10-byte L8 trim
    fn level8_block() -> CodedBlock {
        let mut fields = vec![(1, 8)];
        fields.extend([(NEUTRAL_TRIM, PQ_FIELD_BIT_LENGTH); 6]);
        CodedBlock {
            level: 8,
            length: 10,
            fields,
            padding_bit: 0,
        }
    }

    fn level254_block() -> CodedBlock {
        CodedBlock {
            level: 254,
            length: 2,
            fields: vec![(0, 8), (2, 8)],
            padding_bit: 0,
        }
    }

    /// A block whose payload is padding only, for levels the parser must skip
    fn opaque_block(level: u8, length: u64) -> CodedBlock {
        CodedBlock {
            level,
            length,
            fields: Vec::new(),
            padding_bit: 1,
        }
    }

    /// Codes one CM section and returns its dm_alignment bit count
    fn write_extension_section(
        writer: &mut BitWriter,
        blocks: &[CodedBlock],
        alignment_bit: u64,
    ) -> usize {
        writer.write_unsigned_exp_golomb(blocks.len() as u64);
        let alignment_bit_count = writer.fill_to_byte(alignment_bit);
        for block in blocks {
            writer.write_unsigned_exp_golomb(block.length);
            writer.write_bits(u64::from(block.level), 8);
            let payload_end = writer.bit_length + (block.length as usize * 8);
            for (value, bit_count) in &block.fields {
                writer.write_bits(*value, *bit_count);
            }
            assert!(writer.bit_length <= payload_end);
            while writer.bit_length < payload_end {
                writer.write_bits(block.padding_bit, 1);
            }
        }
        alignment_bit_count
    }

    /// Encodes a Profile 8.1 RPU whose display metadata ends in hand-coded extension sections
    fn encode_with_extension_sections(write_sections: impl FnOnce(&mut BitWriter)) -> Vec<u8> {
        let mut rpu = profile8_rpu();
        let color = rpu.vdr_dm_data.as_mut().unwrap();
        color.cmv29_metadata = Some(DmData::V29(CmV29DmData::default()));
        color.cmv40_metadata = None;
        let written = rpu.write_rpu().unwrap();
        let crc_offset = written.len() - RPU_TRAILER_BYTE_LENGTH;
        // The empty CM v2.9 section is ue(0), the last 1 bit before the CRC32, then zero alignment
        let section_bit_offset = (0..crc_offset * 8)
            .rev()
            .find(|position| read_bits(&written, *position, 1) == 1)
            .unwrap();
        assert!((crc_offset * 8) - section_bit_offset <= 8);

        let mut writer = BitWriter::default();
        for position in 0..section_bit_offset {
            writer.write_bits(read_bits(&written, position, 1), 1);
        }
        write_sections(&mut writer);
        // rpu_alignment_zero_bit
        writer.fill_to_byte(0);

        let mut unescaped = writer.bytes;
        let crc = crc32_mpeg2(&unescaped[1..]);
        unescaped.extend_from_slice(&crc.to_be_bytes());
        unescaped.push(RPU_TERMINATOR);
        add_start_code_emulation_prevention_3_byte(&mut unescaped);

        let mut nal_unit = HEVC_UNSPEC62_NAL_HEADER.to_vec();
        nal_unit.extend_from_slice(&unescaped);
        nal_unit
    }

    fn parsed_level1(input: &[u8]) -> [u32; 3] {
        let mut context = ParserContext::default();
        level1(&parse_into(&mut context, input).unwrap())
    }

    /// The levels the crate keeps in its CM v2.9 and v4.0 sections, in coded order
    fn kept_section_levels(input: &[u8]) -> [Vec<u8>; 2] {
        let color = DoviRpu::parse_unspec62_nalu(input)
            .unwrap()
            .vdr_dm_data
            .unwrap();
        [color.cmv29_metadata, color.cmv40_metadata].map(|section| {
            let (block_count, blocks) = match &section {
                Some(DmData::V29(metadata)) => (metadata.num_ext_blocks(), metadata.blocks_ref()),
                Some(DmData::V40(metadata)) => (metadata.num_ext_blocks(), metadata.blocks_ref()),
                None => return Vec::new(),
            };
            // The section's count covers exactly the kept blocks
            assert_eq!(block_count, blocks.len() as u64);
            blocks.iter().map(ExtMetadataBlock::level).collect()
        })
    }

    /// A Profile 8.1 RPU with CM v2.9 and v4.0 display metadata from the crate's generator
    fn profile8_rpu() -> DoviRpu {
        DoviRpu::profile81_config(&GenerateConfig::default()).unwrap()
    }

    /// A Profile 4 RPU shaped like the dovi_tool Profile 4 vector, with a residual and a 14-bit VDR
    fn profile4_rpu() -> DoviRpu {
        let mut rpu = profile8_rpu();
        rpu.convert_with_mode(ConversionMode::ToMel).unwrap();
        rpu.header.vdr_bit_depth_minus8 = 6;
        rpu.dovi_profile = rpu.header.get_dovi_profile();
        assert_eq!(rpu.dovi_profile, 4);
        rpu
    }

    fn without_color_metadata(mut rpu: DoviRpu) -> DoviRpu {
        rpu.header.vdr_dm_metadata_present_flag = false;
        rpu.vdr_dm_data = None;
        rpu
    }

    /// Turns the display metadata into method 1, which carries only the dynamic fields
    fn compressed_rpu(mut rpu: DoviRpu, level1: ExtMetadataBlockLevel1) -> DoviRpu {
        rpu.header.reserved_zero_3bits = COMPRESSED_DISPLAY_METADATA;
        let color = rpu.vdr_dm_data.as_mut().unwrap();
        color.compressed = true;
        color.affected_dm_metadata_id = 3;
        color.current_dm_metadata_id = 3;
        color.scene_refresh_flag = 1;
        color
            .add_metadata_block(ExtMetadataBlock::Level1(level1))
            .unwrap();
        rpu
    }

    fn with_ycc_to_rgb_offsets(mut rpu: DoviRpu, offsets: [u32; 3]) -> DoviRpu {
        let color = rpu.vdr_dm_data.as_mut().unwrap();
        color.ycc_to_rgb_offset0 = offsets[0];
        color.ycc_to_rgb_offset1 = offsets[1];
        color.ycc_to_rgb_offset2 = offsets[2];
        rpu
    }

    fn with_source_maximum_pq(mut rpu: DoviRpu, source_maximum_pq: u16) -> DoviRpu {
        rpu.vdr_dm_data.as_mut().unwrap().source_max_pq = source_maximum_pq;
        rpu
    }

    fn encode(rpu: &DoviRpu) -> Vec<u8> {
        rpu.write_hevc_unspec62_nalu().unwrap()
    }

    fn parse_into(context: &mut ParserContext, input: &[u8]) -> ParserResult<Vec<u8>> {
        let mut output = vec![0_u8; OUTPUT_BYTE_LENGTH];
        context
            .parse(input, RpuFraming::HEVCUnspec62NALUnit, &mut output)
            .map(|()| output)
    }

    fn header_word(output: &[u8], word_index: usize) -> u32 {
        let byte_offset = word_index * size_of::<u32>();
        u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap())
    }

    fn float_at(output: &[u8], byte_offset: usize) -> f32 {
        f32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap())
    }

    fn nonlinear_offsets(output: &[u8]) -> [f32; 3] {
        array::from_fn(|index| float_at(output, HEADER_BYTE_LENGTH + (index * size_of::<f32>())))
    }

    fn luma_pivots(output: &[u8], pivot_count: usize) -> Vec<f32> {
        (0..pivot_count)
            .map(|index| float_at(output, LUMA_PIVOT_BYTE_OFFSET + (index * size_of::<f32>())))
            .collect()
    }

    fn level1(output: &[u8]) -> [u32; 3] {
        [
            header_word(output, LEVEL1_MINIMUM_PQ_WORD),
            header_word(output, LEVEL1_MAXIMUM_PQ_WORD),
            header_word(output, LEVEL1_AVERAGE_PQ_WORD),
        ]
    }

    fn exp_golomb_bit_length(value: u64) -> usize {
        let significant_bit_count = (u64::BITS - (value + 1).leading_zeros()) as usize;
        (2 * significant_bit_count) - 1
    }

    /// Bit offset of dm_compression in an unescaped RPU that starts with its prefix byte
    fn dm_compression_bit_offset(header: &RpuDataHeader) -> usize {
        assert_eq!(header.coefficient_data_type, 0);
        let ext_mapping_idc =
            (u64::from(header.ext_mapping_idc_5_7) << 5) | u64::from(header.ext_mapping_idc_0_4);
        let el_bit_depth_code = (ext_mapping_idc << 8) | header.el_bit_depth_minus8;
        // chroma_resampling_explicit_filter_flag and coefficient_data_type
        FIXED_HEADER_BIT_LENGTH + 1 + 2
            + exp_golomb_bit_length(header.coefficient_log2_denom)
            // vdr_rpu_normalized_idc and bl_video_full_range_flag
            + 2 + 1
            + exp_golomb_bit_length(header.bl_bit_depth_minus8)
            + exp_golomb_bit_length(el_bit_depth_code)
            + exp_golomb_bit_length(header.vdr_bit_depth_minus8)
            // spatial_resampling_filter_flag
            + 1
    }

    /// Bit offset of the first luma linear_interp_flag, for a first-order first piece and no NLQ
    fn first_linear_interpolation_flag_bit_offset(rpu: &DoviRpu) -> usize {
        let header = &rpu.header;
        assert!(header.disable_residual_flag && !header.use_prev_vdr_rpu_flag);
        let mapping = rpu.rpu_data_mapping.as_ref().unwrap();
        let bl_bit_depth = (header.bl_bit_depth_minus8 + 8) as usize;
        // dm_compression, el_spatial_resampling_filter_flag, disable_residual_flag, vdr_dm_metadata_present_flag, and use_prev_vdr_rpu_flag
        let mut bit_offset = dm_compression_bit_offset(header) + DM_COMPRESSION_BIT_LENGTH + 4;
        bit_offset += exp_golomb_bit_length(mapping.vdr_rpu_id)
            + exp_golomb_bit_length(mapping.mapping_color_space)
            + exp_golomb_bit_length(mapping.mapping_chroma_format_idc);
        for curve in &mapping.curves {
            bit_offset += exp_golomb_bit_length(curve.num_pivots_minus2)
                + (curve.pivots.len() * bl_bit_depth);
        }
        bit_offset += exp_golomb_bit_length(mapping.num_x_partitions_minus1)
            + exp_golomb_bit_length(mapping.num_y_partitions_minus1);
        // mapping_idc and poly_order_minus1 of the first piece, both ue(0)
        bit_offset + exp_golomb_bit_length(0) + exp_golomb_bit_length(0)
    }

    fn read_bits(bytes: &[u8], bit_offset: usize, bit_count: usize) -> u64 {
        (bit_offset..bit_offset + bit_count).fold(0, |value, position| {
            (value << 1) | u64::from((bytes[position / 8] >> (7 - (position % 8))) & 1)
        })
    }

    fn crc32_mpeg2(bytes: &[u8]) -> u32 {
        bytes.iter().fold(u32::MAX, |crc, byte| {
            (0..8).fold(crc ^ (u32::from(*byte) << 24), |crc, _| {
                if crc & 0x8000_0000 != 0 {
                    (crc << 1) ^ CRC32_MPEG2_POLYNOMIAL
                } else {
                    crc << 1
                }
            })
        })
    }

    /// Encodes syntax the crate's writer refuses to emit by overwriting raw RPU bits, then restores the CRC, emulation prevention, and NAL header a real stream carries
    fn encode_with_bits(rpu: &DoviRpu, bit_offset: usize, bit_count: usize, value: u64) -> Vec<u8> {
        let mut unescaped = rpu.write_rpu().unwrap();
        let crc_offset = unescaped.len() - RPU_TRAILER_BYTE_LENGTH;
        let written_crc =
            u32::from_be_bytes(unescaped[crc_offset..crc_offset + 4].try_into().unwrap());
        assert_eq!(crc32_mpeg2(&unescaped[1..crc_offset]), written_crc);

        for bit_index in 0..bit_count {
            let position = bit_offset + bit_index;
            let mask = 0x80_u8 >> (position % 8);
            if (value >> (bit_count - 1 - bit_index)) & 1 == 1 {
                unescaped[position / 8] |= mask;
            } else {
                unescaped[position / 8] &= !mask;
            }
        }
        let crc = crc32_mpeg2(&unescaped[1..crc_offset]);
        unescaped[crc_offset..crc_offset + 4].copy_from_slice(&crc.to_be_bytes());
        add_start_code_emulation_prevention_3_byte(&mut unescaped);

        let mut nal_unit = HEVC_UNSPEC62_NAL_HEADER.to_vec();
        nal_unit.extend_from_slice(&unescaped);
        nal_unit
    }

    fn prior_mapping_rpu(mapping_id: u64) -> DoviRpu {
        let mut rpu = DoviRpu::default();
        rpu.header.use_prev_vdr_rpu_flag = true;
        rpu.header.prev_vdr_rpu_id = mapping_id;
        rpu
    }

    fn parse_av1_into(context: &mut ParserContext, input: &[u8]) -> ParserResult<Vec<u8>> {
        let mut output = vec![0_u8; OUTPUT_BYTE_LENGTH];
        context
            .parse(input, RpuFraming::AV1ITUTT35Payload, &mut output)
            .map(|()| output)
    }

    /// The ITU-T T.35 payload of an AV1 metadata OBU that carries the RPU, from its country code
    fn encode_av1(rpu: &DoviRpu) -> Vec<u8> {
        rpu.write_av1_rpu_metadata_obu_t35_complete().unwrap()
    }

    /// A parse result that two entry points can be compared by
    fn outcome(result: ParserResult<Vec<u8>>) -> Result<Vec<u8>, (i32, String)> {
        result.map_err(|failure| (failure.code, failure.message))
    }

    /// Resolves one engine folder from tools/constants.json through Node, as the Makefile does
    fn engine_layout_directory(key: &str) -> PathBuf {
        let engine_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .find(|directory| directory.join(ENGINE_LAYOUT_FILE).is_file())
            .expect("The crate lies inside the engine");
        let output = Command::new("node")
            .arg("-p")
            .arg(format!("require(process.argv[1]).{key}"))
            .arg(engine_root.join(ENGINE_LAYOUT_FILE))
            .output()
            .expect("Node reads the engine layout, as for the Makefile");
        assert!(output.status.success());
        engine_root.join(String::from_utf8(output.stdout).unwrap().trim())
    }

    fn rpu_vector_paths() -> Vec<PathBuf> {
        let directory =
            engine_layout_directory(TEST_VECTORS_DIRECTORY_KEY).join(RPU_VECTOR_DIRECTORY);
        let mut paths: Vec<PathBuf> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == RPU_VECTOR_EXTENSION)
            })
            .collect();
        paths.sort();
        paths
    }

    /// Wraps an HEVC RPU vector, a start code and then the escaped RPU, in the AV1 T.35 payload the crate writes, without the country code
    fn av1_payload_from_hevc_vector(vector: &[u8]) -> Vec<u8> {
        let escaped_rpu = DoviRpu::validated_trimmed_data(vector).unwrap();
        convert_regular_rpu_to_av1_payload(&clear_start_code_emulation_prevention_3_byte(
            escaped_rpu,
        ))
        .unwrap()
    }

    /// The T.35 payload of a Dolby Vision metadata OBU up to and including emdf_payload_size, coded in variable_bits chunks of 8 bits
    fn av1_payload_with_emdf_payload_size_chunks(size_chunks: &[u64]) -> Vec<u8> {
        let mut writer = BitWriter::default();
        writer.write_bits(u64::from(ITU_T_T35_COUNTRY_CODE_UNITED_STATES), 8);
        writer.write_bits(ITU_T_T35_PROVIDER_CODE_DOLBY, 16);
        writer.write_bits(ITU_T_T35_PROVIDER_ORIENTED_CODE_DOLBY, 32);
        writer.write_bits(EMDF_HEADER, EMDF_HEADER_BIT_LENGTH);
        for (chunk_index, chunk) in size_chunks.iter().enumerate() {
            writer.write_bits(*chunk, EMDF_VARIABLE_BITS_CHUNK_BIT_LENGTH);
            // read_more
            writer.write_bits(u64::from(chunk_index + 1 < size_chunks.len()), 1);
        }
        writer.fill_to_byte(0);
        writer.bytes
    }

    fn component_word(output: &[u8], component_index: usize, word_index: usize) -> u32 {
        let byte_offset = COMPONENT_BYTE_OFFSET
            + (component_index * COMPONENT_BYTE_LENGTH)
            + (word_index * size_of::<u32>());
        u32::from_le_bytes(output[byte_offset..byte_offset + 4].try_into().unwrap())
    }

    fn component_vector(output: &[u8], component_index: usize, byte_offset: usize) -> [f32; 4] {
        let vector_byte_offset =
            COMPONENT_BYTE_OFFSET + (component_index * COMPONENT_BYTE_LENGTH) + byte_offset;
        array::from_fn(|index| float_at(output, vector_byte_offset + (index * size_of::<f32>())))
    }

    fn segment(output: &[u8], component_index: usize, segment_index: usize) -> [f32; 4] {
        component_vector(
            output,
            component_index,
            COMPONENT_SEGMENT_BYTE_OFFSET + (segment_index * PACKED_VECTOR_BYTE_LENGTH),
        )
    }

    fn mmr_vector(output: &[u8], component_index: usize, vector_index: usize) -> [f32; 4] {
        component_vector(
            output,
            component_index,
            COMPONENT_MMR_BYTE_OFFSET + (vector_index * PACKED_VECTOR_BYTE_LENGTH),
        )
    }

    /// A value as the crate codes a signed coefficient: an integer part and a 23-bit fraction
    fn signed_fixed_point(value: f64) -> (i64, u64) {
        let integer = value.floor();
        (
            integer as i64,
            ((value - integer) * COEFFICIENT_SCALE) as u64,
        )
    }

    fn unsigned_fixed_point(value: f64) -> (u64, u64) {
        let (integer, fraction) = signed_fixed_point(value);
        (u64::try_from(integer).unwrap(), fraction)
    }

    fn normalized_pivot(pivot_code: u16) -> f64 {
        f64::from(pivot_code) / PIVOT_CODE_MAXIMUM
    }

    /// A curve over absolute pivot codes, to which the push helpers add pieces in coded order
    fn reshaping_curve(pivot_codes: &[u16]) -> DoviReshapingCurve {
        // The crate keeps the coded first pivot and then each difference
        let mut previous_code = 0;
        let pivots = pivot_codes
            .iter()
            .map(|code| {
                let delta = code - previous_code;
                previous_code = *code;
                delta
            })
            .collect();
        DoviReshapingCurve {
            num_pivots_minus2: pivot_codes.len() as u64 - 2,
            pivots,
            ..DoviReshapingCurve::default()
        }
    }

    fn push_polynomial_piece(curve: &mut DoviReshapingCurve, coefficients: &[f64]) {
        curve.mapping_idc.push(DoviMappingMethod::Polynomial);
        let polynomial = curve.polynomial.get_or_insert_with(Default::default);
        polynomial
            .poly_order_minus1
            .push(coefficients.len() as u64 - 2);
        polynomial.linear_interp_flag.push(false);
        polynomial.poly_coef_int.push(
            coefficients
                .iter()
                .map(|value| signed_fixed_point(*value).0)
                .collect(),
        );
        polynomial.poly_coef.push(
            coefficients
                .iter()
                .map(|value| signed_fixed_point(*value).1)
                .collect(),
        );
        polynomial
            .pred_linear_interp_value_int
            .push(Default::default());
        polynomial.pred_linear_interp_value.push(Default::default());
    }

    /// Adds a linear interpolation piece coding its start value, and its end value when last
    fn push_linear_interpolation_piece(curve: &mut DoviReshapingCurve, values: &[f64]) {
        curve.mapping_idc.push(DoviMappingMethod::Polynomial);
        let polynomial = curve.polynomial.get_or_insert_with(Default::default);
        polynomial.poly_order_minus1.push(0);
        polynomial.linear_interp_flag.push(true);
        polynomial.poly_coef_int.push(Default::default());
        polynomial.poly_coef.push(Default::default());
        polynomial.pred_linear_interp_value_int.push(
            values
                .iter()
                .map(|value| unsigned_fixed_point(*value).0)
                .collect(),
        );
        polynomial.pred_linear_interp_value.push(
            values
                .iter()
                .map(|value| unsigned_fixed_point(*value).1)
                .collect(),
        );
    }

    fn push_mmr_piece(
        curve: &mut DoviReshapingCurve,
        constant: f64,
        orders: &[[f64; MAXIMUM_MMR_COEFFICIENT_COUNT]],
    ) {
        curve.mapping_idc.push(DoviMappingMethod::MMR);
        let mmr = curve.mmr.get_or_insert_with(Default::default);
        mmr.mmr_order_minus1.push(orders.len() as u8 - 1);
        mmr.mmr_constant_int.push(signed_fixed_point(constant).0);
        mmr.mmr_constant.push(signed_fixed_point(constant).1);
        mmr.mmr_coef_int.push(
            orders
                .iter()
                .map(|order| {
                    order
                        .iter()
                        .map(|value| signed_fixed_point(*value).0)
                        .collect()
                })
                .collect(),
        );
        mmr.mmr_coef.push(
            orders
                .iter()
                .map(|order| {
                    order
                        .iter()
                        .map(|value| signed_fixed_point(*value).1)
                        .collect()
                })
                .collect(),
        );
    }

    /// The crate's Profile 8.1 RPU with one component's curve replaced
    fn rpu_with_curve(component_index: usize, curve: DoviReshapingCurve) -> DoviRpu {
        let mut rpu = profile8_rpu();
        assert_eq!(
            rpu.header.coefficient_log2_denom,
            COEFFICIENT_LOG2_DENOMINATOR
        );
        rpu.rpu_data_mapping.as_mut().unwrap().curves[component_index] = curve;
        rpu
    }

    /// Recodes every polynomial coefficient and linear interpolation value as float32 bits
    fn with_float_coefficients(mut rpu: DoviRpu) -> DoviRpu {
        rpu.header.coefficient_data_type = FLOAT_COEFFICIENT_DATA_TYPE;
        rpu.header.coefficient_log2_denom_length = FLOAT_COEFFICIENT_BIT_LENGTH;
        let float_bits = |integer: f64, fraction: u64| -> u64 {
            u64::from(((integer + (fraction as f64 / COEFFICIENT_SCALE)) as f32).to_bits())
        };
        for curve in &mut rpu.rpu_data_mapping.as_mut().unwrap().curves {
            assert!(curve.mmr.is_none());
            let polynomial = curve.polynomial.as_mut().unwrap();
            for (integers, fractions) in polynomial
                .poly_coef_int
                .iter_mut()
                .zip(&mut polynomial.poly_coef)
            {
                for (integer, fraction) in integers.iter().zip(fractions.iter_mut()) {
                    *fraction = float_bits(*integer as f64, *fraction);
                }
                integers.clear();
            }
            for (integers, fractions) in polynomial
                .pred_linear_interp_value_int
                .iter_mut()
                .zip(&mut polynomial.pred_linear_interp_value)
            {
                for (integer, fraction) in integers.iter().zip(fractions.iter_mut()) {
                    *fraction = float_bits(*integer as f64, *fraction);
                }
                integers.clear();
            }
        }
        rpu
    }

    /// Asserts that a packed segment is the line through the given (pivot, value) points
    fn assert_line_through(segment: [f32; 4], points: [(f64, f64); 2]) {
        assert_eq!(segment[2..], [0.0, 0.0]);
        for (pivot, value) in points {
            let line_value = f64::from(segment[0]) + (f64::from(segment[1]) * pivot);
            assert!(
                (line_value - value).abs() < LINEAR_INTERPOLATION_TOLERANCE,
                "{segment:?} gives {line_value} instead of {value} at {pivot}"
            );
        }
    }

    #[test]
    fn explicit_mapping_is_returned_for_storage() {
        let context = ParserContext::default();
        let mapping = RpuDataMapping {
            vdr_rpu_id: 3,
            ..RpuDataMapping::default()
        };
        let mut rpu = DoviRpu::default();
        rpu.rpu_data_mapping = Some(mapping);

        let resolution = context.resolve_mapping(&rpu).unwrap();

        assert_eq!(resolution.mapping.vdr_rpu_id, 3);
        assert_eq!(resolution.mapping_id_to_store, Some(3));
        assert!(!resolution.used_previous_mapping);
    }

    #[test]
    fn requested_and_default_prior_mappings_match_ffmpeg_state_semantics() {
        let mut context = ParserContext::default();
        context.mappings[0] = Some(RpuDataMapping {
            vdr_rpu_id: 0,
            ..RpuDataMapping::default()
        });
        context.mappings[3] = Some(RpuDataMapping {
            vdr_rpu_id: 3,
            ..RpuDataMapping::default()
        });

        let exact = context.resolve_mapping(&prior_mapping_rpu(3)).unwrap();
        assert_eq!(exact.mapping.vdr_rpu_id, 3);
        assert!(exact.used_previous_mapping);
        assert_eq!(exact.mapping_id_to_store, None);

        let fallback = context.resolve_mapping(&prior_mapping_rpu(7)).unwrap();
        assert_eq!(fallback.mapping.vdr_rpu_id, 0);
        assert!(fallback.used_previous_mapping);
    }

    #[test]
    fn reset_discards_all_prior_mapping_state() {
        let mut context = ParserContext::default();
        context.mappings[0] = Some(RpuDataMapping::default());
        context.reset();

        let failure = context
            .resolve_mapping(&prior_mapping_rpu(0))
            .err()
            .unwrap();

        assert_eq!(failure.code, STATUS_MISSING_MAPPING_STATE);
        assert!(failure.message.contains("unavailable prior mapping 0"));
    }

    #[test]
    fn compressed_display_metadata_reuses_the_last_uncompressed_metadata() {
        let mut context = ParserContext::default();
        parse_into(
            &mut context,
            &encode(&with_source_maximum_pq(profile8_rpu(), 3_000)),
        )
        .unwrap();

        let compressed =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        let output = parse_into(&mut context, &encode(&compressed)).unwrap();

        let flags = header_word(&output, FLAGS_WORD);
        assert_ne!(flags & FLAG_EXPLICIT_COLOR_METADATA, 0);
        assert_eq!(flags & FLAG_DEFAULT_COLOR_METADATA, 0);
        assert_ne!(flags & FLAG_LEVEL1_METADATA, 0);
        assert_ne!(flags & FLAG_SCENE_REFRESH, 0);
        // Static fields come from the stored metadata, dynamic fields from the compressed RPU
        assert_eq!(header_word(&output, SOURCE_MAXIMUM_PQ_WORD), 3_000);
        assert_eq!(level1(&output), [5, 2_000, 1_000]);
        assert_eq!(header_word(&output, SCENE_REFRESH_WORD), 1);
        assert_eq!(header_word(&output, AFFECTED_DM_METADATA_ID_WORD), 3);

        // Compressed RPUs never replace the stored metadata
        let next = compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(0, 3_000, 1_500));
        let next_output = parse_into(&mut context, &encode(&next)).unwrap();
        assert_eq!(header_word(&next_output, SOURCE_MAXIMUM_PQ_WORD), 3_000);
        assert_eq!(level1(&next_output), [0, 3_000, 1_500]);
    }

    #[test]
    fn compressed_display_metadata_without_prior_metadata_is_missing_state() {
        let mut context = ParserContext::default();
        let compressed =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));

        let failure = parse_into(&mut context, &encode(&compressed)).unwrap_err();

        assert_eq!(failure.code, STATUS_MISSING_MAPPING_STATE);
        assert!(failure.message.contains("uncompressed display metadata"));
        // The failed RPU's mapping is not kept either
        assert!(context.mappings.iter().all(Option::is_none));
    }

    #[test]
    fn reset_discards_stored_display_metadata() {
        let mut context = ParserContext::default();
        parse_into(&mut context, &encode(&profile8_rpu())).unwrap();
        context.reset();

        let compressed =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        let failure = parse_into(&mut context, &encode(&compressed)).unwrap_err();

        assert_eq!(failure.code, STATUS_MISSING_MAPPING_STATE);
    }

    #[test]
    fn rpu_without_display_metadata_presents_defaults_and_keeps_stored_metadata() {
        let mut context = ParserContext::default();
        parse_into(
            &mut context,
            &encode(&with_source_maximum_pq(profile8_rpu(), 3_000)),
        )
        .unwrap();

        let default_output = parse_into(
            &mut context,
            &encode(&without_color_metadata(profile8_rpu())),
        )
        .unwrap();
        assert_ne!(
            header_word(&default_output, FLAGS_WORD) & FLAG_DEFAULT_COLOR_METADATA,
            0
        );
        assert_eq!(
            header_word(&default_output, SOURCE_MAXIMUM_PQ_WORD),
            u32::from(default_color_metadata().source_max_pq)
        );

        let compressed =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        let output = parse_into(&mut context, &encode(&compressed)).unwrap();
        assert_eq!(header_word(&output, SOURCE_MAXIMUM_PQ_WORD), 3_000);
    }

    #[test]
    fn rejected_rpu_does_not_replace_stored_display_metadata() {
        let mut context = ParserContext::default();
        parse_into(
            &mut context,
            &encode(&with_source_maximum_pq(profile8_rpu(), 3_000)),
        )
        .unwrap();
        // The bridge rejects a linear interpolation piece before an MMR piece only while packing
        let mut luma = reshaping_curve(&[0, 512, 1_023]);
        push_linear_interpolation_piece(&mut luma, &[0.25]);
        push_mmr_piece(&mut luma, 0.5, &[[0.0; MAXIMUM_MMR_COEFFICIENT_COUNT]]);
        let rejected = with_source_maximum_pq(rpu_with_curve(0, luma), 1_000);
        let failure = parse_into(&mut context, &encode(&rejected)).unwrap_err();
        assert_eq!(failure.code, STATUS_UNSUPPORTED_METADATA);

        let compressed =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        let output = parse_into(&mut context, &encode(&compressed)).unwrap();

        assert_eq!(header_word(&output, SOURCE_MAXIMUM_PQ_WORD), 3_000);
    }

    #[test]
    fn display_metadata_compression_methods_above_one_are_unsupported() {
        let mut context = ParserContext::default();
        let with_metadata = profile8_rpu();
        let bit_offset = dm_compression_bit_offset(&with_metadata.header);
        // Guards the offset: method 1 written by hand must equal the crate's own encoding of it
        let mut method_one = with_metadata.clone();
        method_one.header.reserved_zero_3bits = COMPRESSED_DISPLAY_METADATA;
        assert_eq!(
            encode_with_bits(&with_metadata, bit_offset, DM_COMPRESSION_BIT_LENGTH, 1),
            encode(&method_one)
        );

        let without_metadata = without_color_metadata(profile8_rpu());
        for method in 2..=7_u64 {
            for rpu in [&with_metadata, &without_metadata] {
                let input = encode_with_bits(rpu, bit_offset, DM_COMPRESSION_BIT_LENGTH, method);
                let failure = parse_into(&mut context, &input).unwrap_err();
                assert_eq!(failure.code, STATUS_UNSUPPORTED_METADATA);
                assert!(
                    failure
                        .message
                        .contains(&format!("compression method {method}"))
                );
            }
        }
        assert!(parse_into(&mut context, &encode(&with_metadata)).is_ok());
    }

    #[test]
    fn compressed_display_metadata_flag_without_metadata_is_invalid() {
        let mut context = ParserContext::default();
        let mut rpu = without_color_metadata(profile8_rpu());
        rpu.header.reserved_zero_3bits = COMPRESSED_DISPLAY_METADATA;

        let failure = parse_into(&mut context, &encode(&rpu)).unwrap_err();

        assert_eq!(failure.code, STATUS_INVALID_COLOR_METADATA);
    }

    #[test]
    fn rpu_format_extension_is_unsupported() {
        let mut context = ParserContext::default();
        let rpu = profile8_rpu();
        let written = rpu.write_rpu().unwrap();
        assert_eq!(
            read_bits(&written, RPU_FORMAT_BIT_OFFSET, RPU_FORMAT_BIT_LENGTH),
            u64::from(rpu.header.rpu_format)
        );
        let extended_format = u64::from(rpu.header.rpu_format | 0x100);

        let input = encode_with_bits(
            &rpu,
            RPU_FORMAT_BIT_OFFSET,
            RPU_FORMAT_BIT_LENGTH,
            extended_format,
        );
        let failure = parse_into(&mut context, &input).unwrap_err();

        assert_eq!(failure.code, STATUS_UNSUPPORTED_METADATA);
        assert!(failure.message.contains("RPU format 0x112"));
    }

    #[test]
    fn rpu_formats_without_the_extension_are_parsed_like_ffmpeg() {
        let mut context = ParserContext::default();
        let rpu = profile8_rpu();
        let other_format = 0x010;

        let input = encode_with_bits(
            &rpu,
            RPU_FORMAT_BIT_OFFSET,
            RPU_FORMAT_BIT_LENGTH,
            other_format,
        );
        let output = parse_into(&mut context, &input).unwrap();

        assert_eq!(
            u64::from(header_word(&output, RPU_FORMAT_WORD)),
            other_format
        );
    }

    #[test]
    fn profile4_rpus_are_accepted() {
        let mut context = ParserContext::default();

        let output = parse_into(&mut context, &encode(&profile4_rpu())).unwrap();

        assert_eq!(header_word(&output, PROFILE_WORD), 4);
        let flags = header_word(&output, FLAGS_WORD);
        assert_ne!(flags & FLAG_NLQ_PRESENT, 0);
        assert_ne!(flags & FLAG_MEL, 0);
        assert_eq!(flags & FLAG_FEL, 0);
    }

    #[test]
    fn profile4_display_metadata_offsets_use_the_profile4_denominator() {
        let mut context = ParserContext::default();
        let offsets = [1 << 30, 1 << 29, 1 << 28];

        let profile4_output = parse_into(
            &mut context,
            &encode(&with_ycc_to_rgb_offsets(profile4_rpu(), offsets)),
        )
        .unwrap();
        assert_eq!(nonlinear_offsets(&profile4_output), [1.0, 0.5, 0.25]);

        // Compressed reuse keeps the denominator of the RPU that carried the metadata
        let compressed =
            compressed_rpu(profile4_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        let compressed_output = parse_into(&mut context, &encode(&compressed)).unwrap();
        assert_eq!(nonlinear_offsets(&compressed_output), [1.0, 0.5, 0.25]);

        let profile8_output = parse_into(
            &mut context,
            &encode(&with_ycc_to_rgb_offsets(profile8_rpu(), offsets)),
        )
        .unwrap();
        assert_eq!(nonlinear_offsets(&profile8_output), [4.0, 2.0, 1.0]);

        // The default metadata keeps FFmpeg's 2^28 units for Profile 4 too
        let default_output = parse_into(
            &mut context,
            &encode(&without_color_metadata(profile4_rpu())),
        )
        .unwrap();
        assert_eq!(nonlinear_offsets(&default_output), [0.25, 2.0, 2.0]);
    }

    #[test]
    fn eight_bit_base_layer_pivots_normalize_by_255() {
        let mut context = ParserContext::default();
        let mut rpu = profile8_rpu();
        rpu.header.bl_bit_depth_minus8 = 0;
        for curve in &mut rpu.rpu_data_mapping.as_mut().unwrap().curves {
            curve.pivots = vec![51, 153];
        }

        let output = parse_into(&mut context, &encode(&rpu)).unwrap();

        assert_eq!(header_word(&output, BASE_LAYER_BIT_DEPTH_WORD), 8);
        assert_eq!(luma_pivots(&output, 2), vec![0.2, 0.8]);
    }

    #[test]
    fn every_mapping_color_space_and_chroma_format_is_packed() {
        let mut context = ParserContext::default();
        // YCbCr, RGB, and IPT, then 4:2:0, 4:2:2, 4:4:4, and a value FFmpeg reads without a name
        for mapping_color_space in 0..=2 {
            for chroma_format_idc in 0..=3 {
                let mut rpu = profile8_rpu();
                let mapping = rpu.rpu_data_mapping.as_mut().unwrap();
                mapping.mapping_color_space = mapping_color_space;
                mapping.mapping_chroma_format_idc = chroma_format_idc;

                let output = parse_into(&mut context, &encode(&rpu)).unwrap();

                assert_eq!(
                    u64::from(header_word(&output, MAPPING_COLOR_SPACE_WORD)),
                    mapping_color_space
                );
                assert_eq!(
                    u64::from(header_word(&output, MAPPING_CHROMA_FORMAT_WORD)),
                    chroma_format_idc
                );
            }
        }
    }

    #[test]
    fn linear_interpolation_values_follow_their_flag_as_ffmpeg_would_read_them() {
        let start_value = 0.25;
        let end_rise = 1.5;
        let mut luma = reshaping_curve(&[0, 1_023]);
        push_linear_interpolation_piece(&mut luma, &[start_value, end_rise]);
        let rpu = rpu_with_curve(0, luma);
        let bit_offset = first_linear_interpolation_flag_bit_offset(&rpu);

        // The set flag, then for the last piece ue(v) and u(23) at the start and end pivots
        let mut expected = BitWriter::default();
        expected.write_bits(1, 1);
        for value in [start_value, end_rise] {
            let (integer, fraction) = unsigned_fixed_point(value);
            expected.write_unsigned_exp_golomb(integer);
            expected.write_bits(fraction, COEFFICIENT_LOG2_DENOMINATOR as usize);
        }
        let written = rpu.write_rpu().unwrap();
        for position in 0..expected.bit_length {
            assert_eq!(
                read_bits(&written, bit_offset + position, 1),
                read_bits(&expected.bytes, position, 1)
            );
        }

        // The end value is the start value plus the coded rise
        let output = parse_into(&mut ParserContext::default(), &encode(&rpu)).unwrap();
        assert_eq!(segment(&output, 0, 0), [0.25, 1.5, 0.0, 0.0]);
    }

    #[test]
    fn unknown_extension_levels_are_skipped_by_their_coded_length() {
        let input = encode_with_extension_sections(|writer| {
            let blocks = [
                opaque_block(7, 3),
                level1_block(LEVEL1_VALUES),
                opaque_block(200, 0),
                opaque_block(32, 9),
            ];
            write_extension_section(writer, &blocks, 0);
        });

        assert_eq!(parsed_level1(&input), LEVEL1_WORDS);
        assert_eq!(kept_section_levels(&input), [vec![1], vec![]]);
    }

    #[test]
    fn variable_length_blocks_without_a_defined_layout_are_skipped() {
        let input = encode_with_extension_sections(|writer| {
            write_extension_section(writer, &[level1_block(LEVEL1_VALUES)], 0);
            // L8, L9, and L10 lengths both shorter and longer than their defined layouts
            let blocks = [
                opaque_block(8, 5),
                opaque_block(8, 11),
                level8_block(),
                opaque_block(9, 3),
                opaque_block(9, 40),
                opaque_block(10, 4),
                opaque_block(10, 30),
                level254_block(),
            ];
            write_extension_section(writer, &blocks, 0);
        });

        assert_eq!(parsed_level1(&input), LEVEL1_WORDS);
        // Only the standard 10-byte L8 and the L254 remain
        assert_eq!(kept_section_levels(&input), [vec![1], vec![8, 254]]);
    }

    #[test]
    fn misplaced_levels_are_skipped() {
        // CM v4.0 levels in the CM v2.9 section, and CM v2.9 levels, a decoy L1 among them, in the CM v4.0 section
        let input = encode_with_extension_sections(|writer| {
            let cm_v29_blocks = [
                opaque_block(3, 5),
                opaque_block(254, 2),
                level1_block(LEVEL1_VALUES),
            ];
            write_extension_section(writer, &cm_v29_blocks, 0);
            let cm_v40_blocks = [
                level1_block(DECOY_LEVEL1_VALUES),
                opaque_block(5, 7),
                level254_block(),
            ];
            write_extension_section(writer, &cm_v40_blocks, 0);
        });
        assert_eq!(parsed_level1(&input), LEVEL1_WORDS);
        assert_eq!(kept_section_levels(&input), [vec![1], vec![254]]);

        // An L1 only in the CM v4.0 section is skipped as well, leaving the RPU without L1
        let misplaced_only = encode_with_extension_sections(|writer| {
            write_extension_section(writer, &[opaque_block(254, 2)], 0);
            let cm_v40_blocks = [level1_block(LEVEL1_VALUES), level254_block()];
            write_extension_section(writer, &cm_v40_blocks, 0);
        });
        let output = parse_into(&mut ParserContext::default(), &misplaced_only).unwrap();
        assert_eq!(header_word(&output, FLAGS_WORD) & FLAG_LEVEL1_METADATA, 0);
        assert_eq!(kept_section_levels(&misplaced_only), [vec![], vec![254]]);
    }

    #[test]
    fn nonzero_alignment_and_padding_bits_are_skipped() {
        let input = encode_with_extension_sections(|writer| {
            // A longer coded length is padded over, as FFmpeg does, whatever the padding bits are
            let long_level1 = CodedBlock {
                length: 9,
                padding_bit: 1,
                ..level1_block(LEVEL1_VALUES)
            };
            let padded_decoy = CodedBlock {
                padding_bit: 1,
                ..level1_block(DECOY_LEVEL1_VALUES)
            };
            let alignment_bit_count =
                write_extension_section(writer, &[long_level1, padded_decoy], 1);
            assert_ne!(alignment_bit_count, 0);
        });

        assert_eq!(parsed_level1(&input), LEVEL1_WORDS);
        assert_eq!(kept_section_levels(&input), [vec![1, 1], vec![]]);
    }

    #[test]
    fn cm_v40_sections_without_exactly_one_level254_are_accepted() {
        for level254_count in [0, 2] {
            let input = encode_with_extension_sections(|writer| {
                write_extension_section(writer, &[level1_block(LEVEL1_VALUES)], 0);
                let mut blocks = vec![level3_block()];
                blocks.extend((0..level254_count).map(|_| level254_block()));
                write_extension_section(writer, &blocks, 0);
            });

            assert_eq!(parsed_level1(&input), LEVEL1_WORDS);
            let mut cm_v40_levels = vec![3];
            cm_v40_levels.extend((0..level254_count).map(|_| 254));
            assert_eq!(kept_section_levels(&input), [vec![1], cm_v40_levels]);
        }
    }

    #[test]
    fn repeated_blocks_are_kept_and_the_first_level1_is_presented() {
        let input = encode_with_extension_sections(|writer| {
            let mut blocks = vec![
                level1_block(LEVEL1_VALUES),
                level1_block(DECOY_LEVEL1_VALUES),
            ];
            blocks.extend((0..9).map(|_| level2_block()));
            write_extension_section(writer, &blocks, 0);
        });

        assert_eq!(parsed_level1(&input), LEVEL1_WORDS);
        let mut cm_v29_levels = vec![1, 1];
        cm_v29_levels.extend([2; 9]);
        assert_eq!(kept_section_levels(&input), [cm_v29_levels, vec![]]);
    }

    #[test]
    fn signal_eotf_without_parameters_is_accepted() {
        let mut rpu = profile8_rpu();
        let color = rpu.vdr_dm_data.as_mut().unwrap();
        let parameters = (
            color.signal_eotf_param0,
            color.signal_eotf_param1,
            color.signal_eotf_param2,
        );
        assert_eq!(parameters, (0, 0, 0));
        color.signal_eotf = 0;

        let output = parse_into(&mut ParserContext::default(), &encode(&rpu)).unwrap();

        assert_eq!(header_word(&output, SIGNAL_EOTF_WORD), 0);
    }

    #[test]
    fn static_blocks_of_compressed_display_metadata_are_ignored() {
        let compressed =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        let written_color = compressed.vdr_dm_data.as_ref().unwrap();
        assert!(written_color.get_block(6).is_some() && written_color.get_block(254).is_some());

        let color = DoviRpu::parse_unspec62_nalu(&encode(&compressed))
            .unwrap()
            .vdr_dm_data
            .unwrap();

        // FFmpeg's static levels are reused from the last uncompressed RPU instead
        for static_level in [6, 254] {
            assert!(color.get_block(static_level).is_none());
        }
        for dynamic_level in [1, 3, 5, 9, 11] {
            assert!(color.get_block(dynamic_level).is_some());
        }
    }

    #[test]
    fn extension_block_running_past_the_payload_is_malformed() {
        let input = encode_with_extension_sections(|writer| {
            writer.write_unsigned_exp_golomb(1);
            writer.fill_to_byte(0);
            // A 200-byte block whose payload the RPU ends before
            writer.write_unsigned_exp_golomb(200);
            writer.write_bits(1, 8);
        });

        let failure = parse_into(&mut ParserContext::default(), &input).unwrap_err();

        assert_eq!(failure.code, STATUS_PARSE_FAILED);
        assert!(failure.message.contains("runs past the metadata payload"));
    }

    #[test]
    fn av1_t35_payloads_pack_every_rpu_vector_like_its_hevc_nal_unit() {
        let vector_paths = rpu_vector_paths();
        assert!(!vector_paths.is_empty());
        for vector_path in vector_paths {
            let vector = fs::read(&vector_path).unwrap();
            let hevc_output = parse_into(&mut ParserContext::default(), &vector)
                .unwrap_or_else(|failure| panic!("{}: {}", vector_path.display(), failure.message));
            let payload = av1_payload_from_hevc_vector(&vector);
            let mut payload_with_country_code = vec![ITU_T_T35_COUNTRY_CODE_UNITED_STATES];
            payload_with_country_code.extend_from_slice(&payload);

            for av1_input in [payload, payload_with_country_code] {
                let av1_output = parse_av1_into(&mut ParserContext::default(), &av1_input);
                assert_eq!(
                    outcome(av1_output),
                    Ok(hevc_output.clone()),
                    "{}",
                    vector_path.display()
                );
            }
        }
    }

    #[test]
    fn av1_t35_payloads_ignore_the_obu_trailing_bits() {
        let rpu = profile8_rpu();
        let expected = parse_into(&mut ParserContext::default(), &encode(&rpu)).unwrap();
        let mut payload = encode_av1(&rpu);
        payload.extend_from_slice(&OBU_TRAILING_BYTES);

        let output = parse_av1_into(&mut ParserContext::default(), &payload).unwrap();

        assert_eq!(output, expected);
    }

    #[test]
    fn av1_t35_payloads_require_the_dolby_country_and_provider_codes() {
        let mut context = ParserContext::default();
        let payload = encode_av1(&profile8_rpu());
        // Another country code, provider code, or provider-oriented code
        for (byte_index, value) in [(0, 0xB4), (2, 0x3C), (6, 0x01)] {
            let mut other_provider = payload.clone();
            other_provider[byte_index] = value;

            let failure = parse_av1_into(&mut context, &other_provider).unwrap_err();

            assert_eq!(failure.code, STATUS_PARSE_FAILED);
            assert!(failure.message.contains("Invalid AV1 RPU payload header"));
        }
        // A rejected payload leaves the context usable
        assert!(parse_av1_into(&mut context, &payload).is_ok());
    }

    #[test]
    fn each_entry_point_rejects_the_other_framing() {
        let mut context = ParserContext::default();
        let rpu = profile8_rpu();

        let hevc_failure = parse_into(&mut context, &encode_av1(&rpu)).unwrap_err();
        let av1_failure = parse_av1_into(&mut context, &encode(&rpu)).unwrap_err();

        assert_eq!(hevc_failure.code, STATUS_PARSE_FAILED);
        assert_eq!(av1_failure.code, STATUS_PARSE_FAILED);
    }

    #[test]
    fn av1_t35_payloads_share_mapping_and_display_metadata_state_with_hevc() {
        let mut context = ParserContext::default();
        let mut stored = with_source_maximum_pq(profile8_rpu(), 3_000);
        stored.rpu_data_mapping.as_mut().unwrap().vdr_rpu_id = 3;
        parse_into(&mut context, &encode(&stored)).unwrap();

        // An AV1 RPU reuses the mapping and display metadata an HEVC RPU stored
        let mut reusing =
            compressed_rpu(profile8_rpu(), ExtMetadataBlockLevel1::new(5, 2_000, 1_000));
        reusing.header.use_prev_vdr_rpu_flag = true;
        reusing.header.prev_vdr_rpu_id = 3;
        reusing.rpu_data_mapping = None;
        let output = parse_av1_into(&mut context, &encode_av1(&reusing)).unwrap();

        assert_ne!(
            header_word(&output, FLAGS_WORD) & FLAG_USED_PREVIOUS_MAPPING,
            0
        );
        assert_eq!(header_word(&output, MAPPING_ID_WORD), 3);
        assert_eq!(header_word(&output, PREVIOUS_MAPPING_ID_WORD), 3);
        assert_eq!(header_word(&output, SOURCE_MAXIMUM_PQ_WORD), 3_000);
        assert_eq!(level1(&output), [5, 2_000, 1_000]);

        // And an HEVC RPU reuses what an AV1 RPU stored
        parse_av1_into(
            &mut context,
            &encode_av1(&with_source_maximum_pq(stored, 2_000)),
        )
        .unwrap();
        let output = parse_into(&mut context, &encode(&reusing)).unwrap();
        assert_eq!(header_word(&output, SOURCE_MAXIMUM_PQ_WORD), 2_000);

        context.reset();
        let failure = parse_av1_into(&mut context, &encode_av1(&reusing)).unwrap_err();
        assert_eq!(failure.code, STATUS_MISSING_MAPPING_STATE);
    }

    #[test]
    fn av1_rpus_keep_the_profile_their_header_infers() {
        // Profile 10.0 RPUs are coded like Profile 5, and 10.1, 10.2, and 10.4 like Profile 8
        let profile5 = DoviRpu::profile5_config(&GenerateConfig::default()).unwrap();
        for (rpu, profile) in [(profile5, 5), (profile8_rpu(), 8)] {
            let output = parse_av1_into(&mut ParserContext::default(), &encode_av1(&rpu)).unwrap();

            assert_eq!(header_word(&output, PROFILE_WORD), profile);
        }
    }

    #[test]
    fn emdf_payload_sizes_that_overflow_or_pass_the_data_are_errors() {
        // 65535 bytes, then a variable_bits chain past 32 bits; upstream aborts the release WASM on both
        let oversized = av1_payload_with_emdf_payload_size_chunks(&[0xFE, 0xFF]);
        let overflowing = av1_payload_with_emdf_payload_size_chunks(&[0xFF; 5]);
        for (input, message) in [
            (
                oversized,
                "EMDF payload size 65535 exceeds the remaining data",
            ),
            (overflowing, "variable_bits value exceeds 32 bits"),
        ] {
            let failure = parse_av1_into(&mut ParserContext::default(), &input).unwrap_err();

            assert_eq!(failure.code, STATUS_PARSE_FAILED);
            assert!(failure.message.contains(message), "{}", failure.message);
        }
    }

    #[test]
    fn rpus_below_the_upstream_minimum_lengths_parse_like_ffmpeg() {
        // An RPU that reuses a stored mapping and carries no display metadata is a few bytes long
        let mut reusing = without_color_metadata(profile8_rpu());
        reusing.header.use_prev_vdr_rpu_flag = true;
        reusing.rpu_data_mapping = None;
        let hevc_input = encode(&reusing);
        let av1_input = encode_av1(&reusing);
        assert!(hevc_input.len() < UPSTREAM_MINIMUM_HEVC_INPUT_BYTE_LENGTH);
        assert!(av1_input.len() < UPSTREAM_MINIMUM_AV1_INPUT_BYTE_LENGTH);

        let mut context = ParserContext::default();
        parse_into(&mut context, &encode(&profile8_rpu())).unwrap();
        let hevc_output = parse_into(&mut context, &hevc_input).unwrap();
        let av1_output = parse_av1_into(&mut context, &av1_input).unwrap();

        let flags = header_word(&hevc_output, FLAGS_WORD);
        assert_ne!(flags & FLAG_USED_PREVIOUS_MAPPING, 0);
        assert_ne!(flags & FLAG_DEFAULT_COLOR_METADATA, 0);
        assert_eq!(av1_output, hevc_output);
    }

    #[test]
    fn single_method_components_keep_their_component_flags() {
        let rpu = DoviRpu::profile84_config(&GenerateConfig::default()).unwrap();

        let output = parse_into(&mut ParserContext::default(), &encode(&rpu)).unwrap();

        let component_flags: [u32; 3] = array::from_fn(|component_index| {
            component_word(&output, component_index, COMPONENT_FLAGS_WORD)
        });
        assert_eq!(
            component_flags,
            [
                COMPONENT_FLAG_POLYNOMIAL,
                COMPONENT_FLAG_MMR,
                COMPONENT_FLAG_MMR
            ]
        );
    }

    #[test]
    fn mixed_polynomial_and_mmr_pieces_pack_per_segment() {
        let first_order = [0.5, 0.25, 0.125, 0.0, 0.0, 0.0, -0.5];
        let second_order = [0.0, 0.0, 0.0, 0.75, 0.0, 0.0, 0.0];
        let mut chroma = reshaping_curve(&[0, 300, 700, 1_023]);
        push_mmr_piece(&mut chroma, 0.5, &[first_order]);
        push_polynomial_piece(&mut chroma, &[0.25, 1.0, -0.25]);
        push_mmr_piece(&mut chroma, -1.5, &[first_order, second_order]);
        let rpu = rpu_with_curve(1, chroma);
        let input = encode(&rpu);

        let output = parse_into(&mut ParserContext::default(), &input).unwrap();

        // The crate keeps each piece's method, which upstream overwrites with the last one
        let parsed_curve = &DoviRpu::parse_unspec62_nalu(&input)
            .unwrap()
            .rpu_data_mapping
            .unwrap()
            .curves[1];
        assert_eq!(
            parsed_curve.mapping_idc,
            [
                DoviMappingMethod::MMR,
                DoviMappingMethod::Polynomial,
                DoviMappingMethod::MMR
            ]
        );
        assert_eq!(
            component_word(&output, 1, COMPONENT_FLAGS_WORD),
            COMPONENT_FLAG_POLYNOMIAL | COMPONENT_FLAG_MMR
        );
        assert_eq!(
            component_word(&output, 1, COMPONENT_MMR_VECTOR_COUNT_WORD),
            6
        );
        // MMR segments hold their constant, first vector, and order; polynomials leave the order zero
        assert_eq!(segment(&output, 1, 0), [0.5, 0.0, 0.0, 1.0]);
        assert_eq!(segment(&output, 1, 1), [0.25, 1.0, -0.25, 0.0]);
        assert_eq!(segment(&output, 1, 2), [-1.5, 2.0, 0.0, 2.0]);
        // The later MMR piece's vectors follow the earlier piece's
        for vector_index in [0, 2] {
            assert_eq!(
                mmr_vector(&output, 1, vector_index),
                [0.5, 0.25, 0.125, 0.0]
            );
            assert_eq!(
                mmr_vector(&output, 1, vector_index + 1),
                [0.0, 0.0, 0.0, -0.5]
            );
        }
        assert_eq!(mmr_vector(&output, 1, 4), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(mmr_vector(&output, 1, 5), [0.75, 0.0, 0.0, 0.0]);
        assert_eq!(mmr_vector(&output, 1, 6), [0.0; 4]);
        // The other components keep the Profile 8.1 polynomials
        assert_eq!(
            component_word(&output, 0, COMPONENT_FLAGS_WORD),
            COMPONENT_FLAG_POLYNOMIAL
        );
        assert_eq!(
            component_word(&output, 2, COMPONENT_FLAGS_WORD),
            COMPONENT_FLAG_POLYNOMIAL
        );
    }

    #[test]
    fn all_linear_interpolation_curves_pack_one_line_per_piece() {
        let pivot_codes = [0, 256, 512, 1_023];
        let values = [0.0625, 0.25, 0.5, 1.0];
        // Each piece codes the rise from the previous pivot's value, and the first its start value
        let rises = [0.0625, 0.1875, 0.25, 0.5];
        let mut luma = reshaping_curve(&pivot_codes);
        push_linear_interpolation_piece(&mut luma, &rises[..1]);
        push_linear_interpolation_piece(&mut luma, &rises[1..2]);
        // The last piece also codes the rise to its end pivot
        push_linear_interpolation_piece(&mut luma, &rises[2..]);

        let output = parse_into(
            &mut ParserContext::default(),
            &encode(&rpu_with_curve(0, luma)),
        )
        .unwrap();

        assert_eq!(
            component_word(&output, 0, COMPONENT_FLAGS_WORD),
            COMPONENT_FLAG_POLYNOMIAL
        );
        for segment_index in 0..3 {
            assert_line_through(
                segment(&output, 0, segment_index),
                [segment_index, segment_index + 1].map(|pivot_index| {
                    (
                        normalized_pivot(pivot_codes[pivot_index]),
                        values[pivot_index],
                    )
                }),
            );
        }
    }

    #[test]
    fn linear_interpolation_before_a_polynomial_ends_on_that_polynomial() {
        let pivot_codes = [0, 512, 1_023];
        let polynomial = [0.125, 0.75, 0.25];
        let mut luma = reshaping_curve(&pivot_codes);
        push_linear_interpolation_piece(&mut luma, &[0.0625]);
        push_polynomial_piece(&mut luma, &polynomial);

        let output = parse_into(
            &mut ParserContext::default(),
            &encode(&rpu_with_curve(0, luma)),
        )
        .unwrap();

        let boundary = normalized_pivot(pivot_codes[1]);
        let boundary_value =
            polynomial[0] + (polynomial[1] * boundary) + (polynomial[2] * boundary * boundary);
        assert_line_through(
            segment(&output, 0, 0),
            [(0.0, 0.0625), (boundary, boundary_value)],
        );
        assert_eq!(segment(&output, 0, 1), [0.125, 0.75, 0.25, 0.0]);
    }

    #[test]
    fn a_linear_interpolation_piece_after_a_polynomial_rises_from_its_start_value() {
        let pivot_codes = [0, 384, 1_023];
        let mut luma = reshaping_curve(&pivot_codes);
        push_polynomial_piece(&mut luma, &[0.25, 1.0]);
        push_linear_interpolation_piece(&mut luma, &[0.25, 0.375]);

        let output = parse_into(
            &mut ParserContext::default(),
            &encode(&rpu_with_curve(0, luma)),
        )
        .unwrap();

        // The polynomial is 0.25 at its start pivot, so the line runs from 0.5 to 0.875
        assert_eq!(segment(&output, 0, 0), [0.25, 1.0, 0.0, 0.0]);
        assert_line_through(
            segment(&output, 0, 1),
            [(normalized_pivot(pivot_codes[1]), 0.5), (1.0, 0.875)],
        );
    }

    #[test]
    fn zero_width_linear_interpolation_pieces_keep_their_start_value() {
        // The middle piece starts and ends at code 512, and the first piece ends on its start value
        let mut luma = reshaping_curve(&[0, 512, 512, 1_023]);
        push_linear_interpolation_piece(&mut luma, &[0.125]);
        push_linear_interpolation_piece(&mut luma, &[0.25]);
        push_linear_interpolation_piece(&mut luma, &[0.125, 0.5]);

        let output = parse_into(
            &mut ParserContext::default(),
            &encode(&rpu_with_curve(0, luma)),
        )
        .unwrap();

        assert_line_through(
            segment(&output, 0, 0),
            [(0.0, 0.125), (normalized_pivot(512), 0.375)],
        );
        assert_eq!(segment(&output, 0, 1), [0.375, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn linear_interpolation_next_to_an_mmr_piece_is_unsupported() {
        // An MMR piece has no scalar value for a line to end on or rise from
        let mut chroma = reshaping_curve(&[0, 512, 1_023]);
        push_linear_interpolation_piece(&mut chroma, &[0.5]);
        push_mmr_piece(&mut chroma, 0.5, &[[0.0; MAXIMUM_MMR_COEFFICIENT_COUNT]]);
        let mut chroma_after_mmr = reshaping_curve(&[0, 512, 1_023]);
        push_mmr_piece(
            &mut chroma_after_mmr,
            0.5,
            &[[0.0; MAXIMUM_MMR_COEFFICIENT_COUNT]],
        );
        push_linear_interpolation_piece(&mut chroma_after_mmr, &[0.5, 0.25]);

        for (curve, expected_message) in [
            (chroma, "linear interpolation before an MMR piece"),
            (chroma_after_mmr, "linear interpolation after an MMR piece"),
        ] {
            let failure = parse_into(
                &mut ParserContext::default(),
                &encode(&rpu_with_curve(2, curve)),
            )
            .unwrap_err();

            assert_eq!(failure.code, STATUS_UNSUPPORTED_METADATA);
            assert!(failure.message.contains(expected_message));
        }
    }

    #[test]
    fn float_linear_interpolation_values_are_float32_bits() {
        let mut luma = reshaping_curve(&[0, 1_023]);
        push_linear_interpolation_piece(&mut luma, &[0.375, 0.5]);
        let rpu = with_float_coefficients(rpu_with_curve(0, luma));

        let output = parse_into(&mut ParserContext::default(), &encode(&rpu)).unwrap();

        assert_eq!(
            header_word(&output, COEFFICIENT_DATA_TYPE_WORD),
            u32::from(FLOAT_COEFFICIENT_DATA_TYPE)
        );
        assert_eq!(segment(&output, 0, 0), [0.375, 0.5, 0.0, 0.0]);
        // The Profile 8.1 identity polynomials survive the float recoding
        assert_eq!(segment(&output, 1, 0), [0.0, 1.0, 0.0, 0.0]);
    }
}
