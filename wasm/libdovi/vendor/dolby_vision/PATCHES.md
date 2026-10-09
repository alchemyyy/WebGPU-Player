# Patches to dolby_vision

Vendored from quietvoid/dovi_tool rev 38adec045bf183c24df38149836c920398072281, crate `dolby_vision` 3.4.0.
Only `src/`, `Cargo.toml`, `LICENSE`, and `README.md` are copied.
The reference semantics are FFmpeg's `libavcodec/dovi_rpudec.c`.
Every deviation from upstream:

## Manifest

- `Cargo.toml`: dropped `[dev-dependencies]`, `[[bench]]`, `[package.metadata.*]`, and `[profile.release-deploy]`.
  A path dependency builds no benches, ignores non-root profiles, and the bridge uses no C API packaging.
  Dependencies and features are unchanged.

## Bounds widened to FFmpeg's

- `RpuDataHeader::validate`: `bl_bit_depth_minus8`, `el_bit_depth_minus8`, and `vdr_bit_depth_minus8` accept 0 through 8, and `coefficient_log2_denom` accepts up to 32, as FFmpeg validates them, instead of exactly 2, exactly 2, at most 6, and at most 23.
- `RpuDataHeader::validate`: no `vdr_rpu_level == 0` requirement, which FFmpeg does not check.
- `RpuDataMapping::validate`: no `mapping_color_space == 0` or `mapping_chroma_format_idc == 0` requirement, because the bridge applies its own mapping policy.
- `RpuDataMapping::validate` takes the header: the Profile 7 NLQ pivots must sum to the base-layer maximum code value `(1 << bl_bit_depth) - 1` instead of 1023, summed in `u32` so 16-bit pivots cannot overflow.
- `DoviRpu::validated_trimmed_data`: each framing checks only the 0x19 prefix, as FFmpeg does, instead of also requiring the bytes 0x08 0x09 after it, which only `rpu_format` 18 and 19 produce.
  Other formats failed before their header was read.
- `DoviRpu::validated_trimmed_data` requires the 5 start bytes it matches, and `av1_validated_trimmed_data` the 9-byte T.35 header after an optional country code, instead of 25 and 34 bytes of input.
  FFmpeg bounds an RPU only by its own length and its EMDF payload size, and an RPU that reuses a stored mapping without display metadata is shorter than either minimum.
  `DoviRpu::parse` still requires the prefix, a payload byte, the CRC32, and the terminator.

## Unsupported syntax as a typed error

- `rpu::UnsupportedRpuSyntax`, new in `rpu/mod.rs`: syntax with no known payload layout, for which FFmpeg returns AVERROR_PATCHWELCOME.
  Callers tell it from malformed data with `anyhow::Error::downcast_ref`.
- `RpuDataHeader::validate`: rejects `vdr_seq_info_present_flag == 0` and `rpu_format & 0x700 != 0`.
  Both leave the bit depths zeroed, which the widened bounds would accept, and the payload would then be misread.
- `RpuDataHeader::validate`: rejects `reserved_zero_3bits`, FFmpeg's `dm_compression`, above 1.
  Upstream parsed methods 2 through 7 as uncompressed display metadata.

## Mapping methods per piece

FFmpeg keeps `mapping_idc[]` per piece, so one component may mix polynomial and MMR pieces.

- `DoviReshapingCurve::mapping_idc` is a `Vec<DoviMappingMethod>` with one method per piece, instead of one method per component, which the parse loop overwrote with the last piece's method.
  `polynomial` and `mmr` hold their method's pieces in coded order.
- `RpuDataMapping::write` writes each piece by its own method from the next piece of that method's curve.
  Upstream wrote the component's method and the polynomial curve whenever it existed.
- `Profile81`, `Profile84`, and `RpuDataMapping::set_empty_p81_mapping` build one method per piece.
- `c_structs/rpu_data_mapping.rs`: the C `mapping_idc` is a per-piece `Data` buffer, and both curves are freed when a component mixes methods.
  Only the `capi` feature builds it, which the bridge does not enable.

## Polynomial linear interpolation

FFmpeg returns AVERROR_PATCHWELCOME for `linear_interp_flag`, and ETSI GS CCM 001 V1.1.1 does not define it.
The layout follows annex A.1.5 of US 10,701,399 B2 and the crate's own commented-out code.

- `DoviPolynomialCurve::parse` takes whether the piece is its component's last.
  An order-1 piece with `linear_interp_flag` reads two values for its start pivot:
  - `pred_linear_interp_value_int`, ue(v), only for fixed point;
  - `pred_linear_interp_value`, `coefficient_log2_denom` bits or 32 float bits.

  The last piece reads a second pair for its end pivot.
  Upstream reached `unimplemented!()`.
  Each pair codes the rise from the previous pivot's value (annex A.2.4.2); the crate keeps the values as coded, and the bridge accumulates them.
- New `DoviPolynomialCurve` fields `pred_linear_interp_value_int` and `pred_linear_interp_value` hold one entry per polynomial piece, empty unless it interpolates.
  Such a piece codes no coefficients, so its `poly_coef_int` and `poly_coef` entries are empty.
- `RpuDataMapping::write` writes these values instead of reaching `unimplemented!()`.

## Display metadata extension blocks, parsed as FFmpeg's parse_ext_blocks does

An extension block rejects an RPU only when its coded length runs past the metadata, so another block cannot cost an RPU its valid Level 1 block.

- `DmData::parse` takes `compressed` and `trailing_bits`, and frames every block by its coded `ext_block_length`.
  It reads that whole payload, then parses a known level from the payload alone, so no block can read into the next one, and the remaining payload is skipped.
- The skip stays inside the metadata: a coded length that runs past the payload, which ends `trailing_bits` before the data ends, is an error, as is a length whose bit count overflows.
  RPUs pass `CRC32_TERMINATOR_BITS`, made `pub(crate)` in `dovi_rpu.rs`, and the ST 2094-10 SEI passes 0.
- `dm_alignment_zero_bit` and `ext_dm_alignment_zero_bit` are skipped whatever their values, instead of rejecting nonzero bits.
- `WithExtMetadataBlocks::parse_block` is a per-level parser over one block's payload.
  It returns None for unknown levels and for the other CM version's levels, which are skipped and not kept, instead of rejecting them or storing them as reserved blocks.
- A payload too short for its level's fields is skipped, and so is an L8, L9, or L10 length without a defined layout, whether shorter or longer.
  FFmpeg rejects the RPU on a short known block; skipping keeps any valid Level 1 block.
  A longer payload of a fixed-size level is parsed and its excess padded over, as in FFmpeg.
- In compressed display metadata, blocks of FFmpeg's static levels, 6, 10, 32, 254, and 255 from `ff_dovi_rpu_extension_is_static`, are dropped, because a compressed RPU reuses them from the last uncompressed RPU.
- `num_ext_blocks` counts the kept blocks, so writing a section back stays consistent.
  Kept blocks keep their coded order.
- `CmV29DmData::validate` and `CmV40DmData::validate` keep only the check that every block belongs to the section.
  The per-level block counts and the single L254 block are not required, as FFmpeg requires neither, for writes too.
  Storage stays bounded by the payload size.
- `VdrDmData::validate`: no `signal_eotf == 65535` requirement when its parameters are zero, which FFmpeg does not check.
  The `signal_bit_depth` range, which FFmpeg validates, stays.
- Removed `ExtMetadataBlock::validate_and_read_remaining` and `ReservedExtMetadataBlock::parse`, which nothing calls.

## Panics reachable from `DoviRpu::parse_unspec62_nalu` and `parse_itu_t35_dovi_metadata_obu`, now errors

The release WASM aborts on panic, which kills the parser instance.

- `DoviPolynomialCurve::parse`: polynomial linear interpolation is parsed, as above, instead of reaching `unimplemented!()`.
- `av1/emdf.rs` `parse_variable_bits`: a `variable_bits` chain past 32 bits is an error.
  Upstream's arithmetic overflowed, which panics with overflow checks and wraps without them.
- `convert_av1_rpu_payload_to_regular`: the EMDF payload size must fit the remaining data before it sizes the payload buffer, as FFmpeg checks.
  Upstream allocated the coded size, so a large size aborted on allocation failure, and a size that wrapped to zero indexed an empty buffer.
- `RpuDataMapping::parse`: `num_pivots_minus2` above 7, FFmpeg's `AV_DOVI_MAX_PIECES - 1`, is an error.
  The coded value sized `vec![0; num_pivots]` and the per-piece `Vec::with_capacity` calls, which aborted on capacity overflow or allocation failure.
- `DmData::parse`: preallocates at most 32 extension blocks, FFmpeg's `AV_DOVI_MAX_EXT_BLOCKS`, instead of the coded `num_ext_blocks`, which aborted the same way.
  Larger coded counts still parse block by block until the data ends.
- `ExtMetadataBlockLevel8::parse`, `ExtMetadataBlockLevel9::parse`, and `ExtMetadataBlockLevel10::parse`: lengths other than 10, 12, 13, 19, or 25, 1 or 17, and 5 or 21 are errors, which `DmData::parse` turns into skipping the block.
  `required_bits` reached `unreachable!()` for any other coded length.

## Audited and unchanged

These parse paths cannot panic on input, so they keep upstream's code.

- `DoviNlqMethod::from` and the `nlq_num_pivots_minus2` unwrap in `RpuDataNlq::parse` follow checks that make their `unreachable!()` and `unwrap()` unreachable.
- Every `ArrayVec` push is bounded by a validated order or count, and every variable-width read is bounded by the validated bit depths of at most 16 and denominators of at most 32.
- `bitvec_helpers` 4.0.2 `read_ue` shifts by 64 and can overflow its sum on a 64-bit Exp-Golomb prefix.
  That panics only with overflow checks, which the release WASM disables.

## Kept from upstream, more lenient than FFmpeg

- `DoviRpu::parse_itu_t35_dovi_metadata_obu` checks the provider code, the provider-oriented code, and the EMDF header, then reads the payload its size names and ignores what follows, including AV1 trailing bits.
  Unlike FFmpeg, it neither checks the `emdf_protection` footer nor caps the payload at 512 bytes; the RPU's CRC32 still guards the payload.
