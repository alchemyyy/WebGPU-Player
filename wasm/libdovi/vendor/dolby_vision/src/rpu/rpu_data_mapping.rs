use anyhow::{Result, anyhow, bail, ensure};
use bitvec_helpers::{
    bitstream_io_reader::BsIoSliceReader, bitstream_io_writer::BitstreamIoWriter,
};

#[cfg(feature = "serde")]
use serde::Serialize;
use tinyvec::{ArrayVec, array_vec};

use crate::rpu::MMR_MAX_COEFFS;

use super::rpu_data_header::RpuDataHeader;
use super::rpu_data_nlq::{DoviELType, RpuDataNlq};

use super::{NLQ_NUM_PIVOTS, NUM_COMPONENTS};

/// FFmpeg's bound, AV_DOVI_MAX_PIECES - 1, which also bounds the per-piece allocations
const MAXIMUM_NUM_PIVOTS_MINUS2: u64 = 7;

#[derive(Default, Debug, Copy, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub enum DoviMappingMethod {
    /// Not a valid value, placeholder for Default
    #[default]
    Invalid = 255,

    Polynomial = 0,
    MMR,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub enum DoviNlqMethod {
    LinearDeadzone = 0,
}

#[derive(Debug, Default, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub struct RpuDataMapping {
    // [0, 15]
    pub vdr_rpu_id: u64,
    pub mapping_color_space: u64,
    pub mapping_chroma_format_idc: u64,
    pub num_x_partitions_minus1: u64,
    pub num_y_partitions_minus1: u64,

    pub curves: [DoviReshapingCurve; NUM_COMPONENTS],

    // NLQ params
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub nlq_method_idc: Option<DoviNlqMethod>,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub nlq_num_pivots_minus2: Option<u8>,
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub nlq_pred_pivot_value: Option<[u16; NLQ_NUM_PIVOTS]>,

    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    pub nlq: Option<RpuDataNlq>,
}

#[derive(Debug, Default, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub struct DoviReshapingCurve {
    // [2, 9]
    pub num_pivots_minus2: u64,
    pub pivots: Vec<u16>,

    /// One method per piece, as FFmpeg's `mapping_idc[]`, so a component may mix methods.
    /// Usually luma (component 0) is Polynomial and chroma (components 1 and 2) MMR
    pub mapping_idc: Vec<DoviMappingMethod>,

    /// The DoviMappingMethod::Polynomial pieces, in coded order
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub polynomial: Option<DoviPolynomialCurve>,

    /// The DoviMappingMethod::MMR pieces, in coded order
    #[cfg_attr(feature = "serde", serde(skip_serializing_if = "Option::is_none"))]
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub mmr: Option<DoviMMRCurve>,
}

#[derive(Debug, Default, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub struct DoviPolynomialCurve {
    pub poly_order_minus1: Vec<u64>,
    pub linear_interp_flag: Vec<bool>,
    /// Empty for a linear interpolation piece, which codes no coefficients
    pub poly_coef_int: Vec<ArrayVec<[i64; 3]>>,
    pub poly_coef: Vec<ArrayVec<[u64; 3]>>,
    /// For a linear interpolation piece, the predicted values at its start pivot and, for the component's last piece, at its end pivot
    /// Empty for other pieces
    pub pred_linear_interp_value_int: Vec<ArrayVec<[u64; 2]>>,
    pub pred_linear_interp_value: Vec<ArrayVec<[u64; 2]>>,
}

#[derive(Debug, Default, Clone)]
#[cfg_attr(feature = "serde", derive(Serialize))]
pub struct DoviMMRCurve {
    pub mmr_order_minus1: Vec<u8>,
    pub mmr_constant_int: Vec<i64>,
    pub mmr_constant: Vec<u64>,
    pub mmr_coef_int: Vec<ArrayVec<[ArrayVec<[i64; MMR_MAX_COEFFS]>; 3]>>,
    pub mmr_coef: Vec<ArrayVec<[ArrayVec<[u64; MMR_MAX_COEFFS]>; 3]>>,
}

impl RpuDataMapping {
    pub(crate) fn parse(
        reader: &mut BsIoSliceReader,
        header: &RpuDataHeader,
    ) -> Result<RpuDataMapping> {
        let mut mapping = RpuDataMapping {
            vdr_rpu_id: reader.read_ue()?,
            mapping_color_space: reader.read_ue()?,
            mapping_chroma_format_idc: reader.read_ue()?,
            ..Default::default()
        };

        let bl_bit_depth = (header.bl_bit_depth_minus8 + 8) as u32;

        for cmp in 0..NUM_COMPONENTS {
            let curve = &mut mapping.curves[cmp];

            curve.num_pivots_minus2 = reader.read_ue()?;
            ensure!(
                curve.num_pivots_minus2 <= MAXIMUM_NUM_PIVOTS_MINUS2,
                "num_pivots_minus2 should be <= {MAXIMUM_NUM_PIVOTS_MINUS2}"
            );
            let num_pivots = (curve.num_pivots_minus2 + 2) as usize;

            curve.pivots = vec![0; num_pivots];

            for i in 0..num_pivots {
                curve.pivots[i] = reader.read_var(bl_bit_depth)?;
            }
        }

        // Profile 7 only
        if header.rpu_format & 0x700 == 0 && !header.disable_residual_flag {
            let nlq_method_idc = reader.read::<3, u8>()?;
            ensure!(nlq_method_idc == 0);

            mapping.nlq_method_idc = Some(DoviNlqMethod::from(nlq_method_idc));
            mapping.nlq_num_pivots_minus2 = Some(0);

            let mut nlq_pred_pivot_value = [0; NLQ_NUM_PIVOTS];
            for pv in &mut nlq_pred_pivot_value {
                *pv = reader.read_var(bl_bit_depth)?;
            }

            mapping.nlq_pred_pivot_value = Some(nlq_pred_pivot_value);
        }

        mapping.num_x_partitions_minus1 = reader.read_ue()?;
        mapping.num_y_partitions_minus1 = reader.read_ue()?;

        // rpu_data_mapping_param

        for cmp in 0..NUM_COMPONENTS {
            let curve = &mut mapping.curves[cmp];
            let num_pieces = (curve.num_pivots_minus2 + 1) as usize;
            curve.mapping_idc = Vec::with_capacity(num_pieces);

            for piece_index in 0..num_pieces {
                let mapping_idc = DoviMappingMethod::try_from(reader.read_ue()?)?;
                curve.mapping_idc.push(mapping_idc);

                // MAPPING_POLYNOMIAL
                if mapping_idc == DoviMappingMethod::Polynomial {
                    let poly_curve = curve
                        .polynomial
                        .get_or_insert_with(|| DoviPolynomialCurve::new(num_pieces));

                    poly_curve.parse(reader, header, piece_index + 1 == num_pieces)?;
                } else if mapping_idc == DoviMappingMethod::MMR {
                    let mmr_curve = curve
                        .mmr
                        .get_or_insert_with(|| DoviMMRCurve::new(num_pieces));

                    mmr_curve.parse(reader, header)?;
                }
            }
        }

        if mapping.nlq_method_idc.is_some() {
            mapping.nlq = Some(RpuDataNlq::parse(reader, header, &mapping)?);
        }

        Ok(mapping)
    }

    pub fn write(&self, writer: &mut BitstreamIoWriter, header: &RpuDataHeader) -> Result<()> {
        let coefficient_log2_denom_length = header.coefficient_log2_denom_length;

        let bl_bit_depth = (header.bl_bit_depth_minus8 + 8) as u32;

        writer.write_ue(self.vdr_rpu_id)?;
        writer.write_ue(self.mapping_color_space)?;
        writer.write_ue(self.mapping_chroma_format_idc)?;

        for cmp in 0..NUM_COMPONENTS {
            let curve = &self.curves[cmp];
            writer.write_ue(curve.num_pivots_minus2)?;

            for p in curve.pivots.iter().copied() {
                writer.write_var(bl_bit_depth, p)?;
            }
        }

        if header.rpu_format & 0x700 == 0 && !header.disable_residual_flag {
            if let Some(nlq_method_idc) = self.nlq_method_idc {
                writer.write::<3, u8>(nlq_method_idc as u8)?;
            }

            if let Some(nlq_pred_pivot_value) = &self.nlq_pred_pivot_value {
                for pv in nlq_pred_pivot_value.iter().copied() {
                    writer.write_var(bl_bit_depth, pv)?;
                }
            }
        }

        writer.write_ue(self.num_x_partitions_minus1)?;
        writer.write_ue(self.num_y_partitions_minus1)?;

        for cmp in 0..NUM_COMPONENTS {
            let curve = &self.curves[cmp];
            let num_pieces = (curve.num_pivots_minus2 + 1) as usize;
            ensure!(
                curve.mapping_idc.len() == num_pieces,
                "mapping_idc should hold one method per piece"
            );

            // Each method's curve holds its pieces in coded order
            let mut poly_piece_count = 0;
            let mut mmr_piece_count = 0;

            for (piece_index, mapping_idc) in curve.mapping_idc.iter().copied().enumerate() {
                writer.write_ue(mapping_idc as u64)?;

                match mapping_idc {
                    // MAPPING_POLYNOMIAL
                    DoviMappingMethod::Polynomial => {
                        let poly_curve = curve
                            .polynomial
                            .as_ref()
                            .ok_or_else(|| anyhow!("Missing polynomial curve"))?;
                        let i = poly_piece_count;
                        poly_piece_count += 1;

                        writer.write_ue(poly_curve.poly_order_minus1[i])?;

                        let poly_order_minus1 = poly_curve.poly_order_minus1[i];
                        if poly_order_minus1 == 0 {
                            writer.write_bit(poly_curve.linear_interp_flag[i])?;
                        }

                        if poly_order_minus1 == 0 && poly_curve.linear_interp_flag[i] {
                            // The last piece also codes the value at its end pivot
                            let value_count = if piece_index + 1 == num_pieces { 2 } else { 1 };

                            for j in 0..value_count {
                                if header.coefficient_data_type == 0 {
                                    writer
                                        .write_ue(poly_curve.pred_linear_interp_value_int[i][j])?;
                                }

                                writer.write_var(
                                    coefficient_log2_denom_length,
                                    poly_curve.pred_linear_interp_value[i][j],
                                )?;
                            }
                        } else {
                            let poly_coef_count = poly_order_minus1 as usize + 1;

                            for j in 0..=poly_coef_count {
                                if header.coefficient_data_type == 0 {
                                    writer.write_se(poly_curve.poly_coef_int[i][j])?;
                                }

                                writer.write_var(
                                    coefficient_log2_denom_length,
                                    poly_curve.poly_coef[i][j],
                                )?;
                            }
                        }
                    }
                    // MAPPING_MMR
                    DoviMappingMethod::MMR => {
                        let mmr_curve = curve
                            .mmr
                            .as_ref()
                            .ok_or_else(|| anyhow!("Missing MMR curve"))?;
                        let i = mmr_piece_count;
                        mmr_piece_count += 1;

                        writer.write::<2, u8>(mmr_curve.mmr_order_minus1[i])?;

                        if header.coefficient_data_type == 0 {
                            writer.write_se(mmr_curve.mmr_constant_int[i])?;
                        }

                        writer
                            .write_var(coefficient_log2_denom_length, mmr_curve.mmr_constant[i])?;

                        for j in 0..mmr_curve.mmr_order_minus1[i] as usize + 1 {
                            for k in 0..MMR_MAX_COEFFS {
                                if header.coefficient_data_type == 0 {
                                    writer.write_se(mmr_curve.mmr_coef_int[i][j][k])?;
                                }

                                writer.write_var(
                                    coefficient_log2_denom_length,
                                    mmr_curve.mmr_coef[i][j][k],
                                )?;
                            }
                        }
                    }
                    DoviMappingMethod::Invalid => bail!("Missing mapping method"),
                }
            }
        }

        if let Some(nlq) = self.nlq.as_ref() {
            nlq.write(writer, header, self)?;
        }

        Ok(())
    }

    pub fn validate(&self, profile: u8, header: &RpuDataHeader) -> Result<()> {
        match profile {
            5 => {
                ensure!(
                    self.nlq_method_idc.is_none(),
                    "profile 5: nlq_method_idc should be undefined"
                );
                ensure!(
                    self.nlq_num_pivots_minus2.is_none(),
                    "profile 5: nlq_num_pivots_minus2 should be undefined"
                );
                ensure!(
                    self.nlq_pred_pivot_value.is_none(),
                    "profile 5: nlq_pred_pivot_value should be undefined"
                );
            }
            7 => {
                ensure!(
                    self.nlq_pred_pivot_value.is_some(),
                    "profile 7: nlq_pred_pivot_value should be defined"
                );

                if let Some(nlq_pred_pivot_value) = self.nlq_pred_pivot_value {
                    // The pivots span the BL code range; the header bounds its bit depth to 16
                    let bl_maximum_code_value = (1_u32 << (header.bl_bit_depth_minus8 + 8)) - 1;
                    let pivot_sum: u32 = nlq_pred_pivot_value.iter().copied().map(u32::from).sum();
                    ensure!(
                        pivot_sum == bl_maximum_code_value,
                        "profile 7: nlq_pred_pivot_value elements should add up to the BL maximum code value"
                    );
                }
            }
            8 => {
                ensure!(
                    self.nlq_method_idc.is_none(),
                    "profile 8: nlq_method_idc should be undefined"
                );
                ensure!(
                    self.nlq_num_pivots_minus2.is_none(),
                    "profile 8: nlq_num_pivots_minus2 should be undefined"
                );
                ensure!(
                    self.nlq_pred_pivot_value.is_none(),
                    "profile 8: nlq_pred_pivot_value should be undefined"
                );
            }
            _ => (),
        };

        Ok(())
    }

    pub fn set_empty_p81_mapping(&mut self) {
        self.curves.iter_mut().for_each(|curve| {
            curve.num_pivots_minus2 = 0;
            curve.pivots.clear();
            curve.pivots.push(0);
            curve.pivots.push(1023);

            curve.mapping_idc.clear();
            curve.mapping_idc.push(DoviMappingMethod::Polynomial);
            curve.mmr = None;

            if let Some(poly_curve) = curve.polynomial.as_mut() {
                poly_curve.set_p81_params();
            } else {
                curve.polynomial = Some(DoviPolynomialCurve::p81_default());
            }
        });
    }

    pub fn get_enhancement_layer_type(&self) -> Option<DoviELType> {
        self.nlq.as_ref().map(|nlq| nlq.el_type())
    }
}

impl DoviPolynomialCurve {
    fn new(num_pieces: usize) -> Self {
        DoviPolynomialCurve {
            poly_order_minus1: Vec::with_capacity(num_pieces),
            linear_interp_flag: Vec::with_capacity(num_pieces),
            poly_coef_int: Vec::with_capacity(num_pieces),
            poly_coef: Vec::with_capacity(num_pieces),
            pred_linear_interp_value_int: Vec::with_capacity(num_pieces),
            pred_linear_interp_value: Vec::with_capacity(num_pieces),
        }
    }

    fn parse(
        &mut self,
        reader: &mut BsIoSliceReader,
        header: &RpuDataHeader,
        last_piece: bool,
    ) -> Result<()> {
        let coefficient_log2_denom_length = header.coefficient_log2_denom_length;

        let poly_order_minus1 = reader.read_ue()?;
        ensure!(poly_order_minus1 <= 1);

        self.poly_order_minus1.push(poly_order_minus1);

        let linear_interp_flag = if poly_order_minus1 == 0 {
            reader.read_bit()?
        } else {
            false
        };
        self.linear_interp_flag.push(linear_interp_flag);

        let mut poly_coef_int = array_vec!();
        let mut poly_coef = array_vec!();
        let mut pred_linear_interp_value_int = array_vec!();
        let mut pred_linear_interp_value = array_vec!();

        if poly_order_minus1 == 0 && linear_interp_flag {
            // Linear interpolation codes the value at the piece's start pivot, and the last piece also the value at its end pivot (ETSI GS CCM 001)
            let value_count = if last_piece { 2 } else { 1 };

            for _j in 0..value_count {
                if header.coefficient_data_type == 0 {
                    pred_linear_interp_value_int.push(reader.read_ue()?);
                }

                pred_linear_interp_value.push(reader.read_var(coefficient_log2_denom_length)?);
            }
        } else {
            let poly_coef_count = poly_order_minus1 as usize + 2;

            for _j in 0..poly_coef_count {
                if header.coefficient_data_type == 0 {
                    poly_coef_int.push(reader.read_se()?);
                }

                poly_coef.push(reader.read_var(coefficient_log2_denom_length)?);
            }
        }

        self.poly_coef_int.push(poly_coef_int);
        self.poly_coef.push(poly_coef);
        self.pred_linear_interp_value_int
            .push(pred_linear_interp_value_int);
        self.pred_linear_interp_value.push(pred_linear_interp_value);

        Ok(())
    }

    pub fn p81_default() -> Self {
        let mut poly_curve = Self::new(1);
        poly_curve.set_p81_params();

        poly_curve
    }

    pub fn set_p81_params(&mut self) {
        self.poly_order_minus1.clear();
        self.poly_order_minus1.push(0);

        self.linear_interp_flag.clear();
        self.linear_interp_flag.push(false);

        self.poly_coef_int.clear();
        self.poly_coef_int.push(array_vec!(0, 1));

        self.poly_coef.clear();
        self.poly_coef.push(array_vec!(0, 0));

        self.pred_linear_interp_value_int.clear();
        self.pred_linear_interp_value_int.push(array_vec!());

        self.pred_linear_interp_value.clear();
        self.pred_linear_interp_value.push(array_vec!());
    }
}

impl DoviMMRCurve {
    fn new(num_pieces: usize) -> Self {
        DoviMMRCurve {
            mmr_order_minus1: Vec::with_capacity(num_pieces),
            mmr_constant_int: Vec::with_capacity(num_pieces),
            mmr_constant: Vec::with_capacity(num_pieces),
            mmr_coef_int: Vec::with_capacity(num_pieces),
            mmr_coef: Vec::with_capacity(num_pieces),
        }
    }

    fn parse(&mut self, reader: &mut BsIoSliceReader, header: &RpuDataHeader) -> Result<()> {
        let coefficient_log2_denom_length = header.coefficient_log2_denom_length;

        let mmr_order_minus1 = reader.read::<2, u8>()?;
        ensure!(mmr_order_minus1 <= 2);

        self.mmr_order_minus1.push(mmr_order_minus1);

        let mmr_orders_count = mmr_order_minus1 as usize + 1;

        if header.coefficient_data_type == 0 {
            self.mmr_constant_int.push(reader.read_se()?);
        }
        self.mmr_constant
            .push(reader.read_var(coefficient_log2_denom_length)?);

        let mut mmr_coef_int = array_vec!();
        let mut mmr_coef = array_vec!();

        for _j in 0..mmr_orders_count {
            let mut mmr_coef_int2 = array_vec!();
            let mut mmr_coef2 = array_vec!();

            for _k in 0..MMR_MAX_COEFFS {
                if header.coefficient_data_type == 0 {
                    mmr_coef_int2.push(reader.read_se()?);
                }

                mmr_coef2.push(reader.read_var(coefficient_log2_denom_length)?);
            }

            mmr_coef_int.push(mmr_coef_int2);
            mmr_coef.push(mmr_coef2);
        }

        self.mmr_coef_int.push(mmr_coef_int);
        self.mmr_coef.push(mmr_coef);

        Ok(())
    }
}

impl TryFrom<u64> for DoviMappingMethod {
    type Error = anyhow::Error;

    fn try_from(value: u64) -> Result<Self> {
        match value {
            0 => Ok(Self::Polynomial),
            1 => Ok(Self::MMR),
            _ => bail!("Invalid mapping_idc value: {value}"),
        }
    }
}

impl From<u8> for DoviNlqMethod {
    fn from(value: u8) -> Self {
        match value {
            0 => Self::LinearDeadzone,
            _ => unreachable!(),
        }
    }
}
