// Bounds of the GPU decode route that the decode worker protocol and the GPU modules share.
// This module imports only plain values, so the worker bundle takes these bounds without any GPU code.
import { U32_VALUE_COUNT } from '../../../presentation/WebGPUConstants';

/** The size unit `KiB` in decoder headers. */
export const KIBIBYTE = 1024;

/** The size unit `MiB` in decoder headers. */
export const MEBIBYTE = 1024 * KIBIBYTE;

/** The most slots a frame pool holds, because a decoder reports freed slots as one 32-bit mask. */
export const GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT = 32;

/** The most reference slots a decoder may keep; with the deepest reorder, presentation's slots, and spares, a pool stays within its slot limit. */
export const GPU_DECODER_MAXIMUM_REFERENCES = 16;

/** The most frames presentation order may trail decode order. */
export const GPU_DECODER_MAXIMUM_REORDER = 8;

/** The most dispatches one packet may encode, repeats expanded; a wavefront at the largest picture a decoder takes stays far within it. */
export const GPU_DECODER_MAXIMUM_DISPATCHES = 4096;

/**
 * The most dispatches one submit of a packet's decode work carries: a packet with more, such as a large picture's wavefront, submits in slices of about equal length,
 * between which other work on the device's one queue, presentation's included, runs; a reset submits no more of them.
 */
export const GPU_DECODE_SLICE_DISPATCH_COUNT = 96;

/** The largest scratch buffer a decoder may declare: u32 byte addresses reach 4 GiB; the session checks the device's own limits. */
export const GPU_DECODE_MAXIMUM_SCRATCH_BUFFER_BYTE_LENGTH = U32_VALUE_COUNT - 4;

/** The packets the ring holds, so consecutive packets occupy different regions. */
export const GPU_DECODE_PACKET_RING_PACKET_COUNT = 2;

/**
 * The largest packet a decoder may declare for any stream, 512 MiB: AV1's worst level 6 records reach it at 8K, far past the 64 MiB that half of WebGPU's default storage binding holds.
 * A header may size its packets by the stream, so a stream's ring of two packets must fit the device's largest storage binding, or selection skips the decoder and its session fails as 'packet-size'.
 */
export const GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH = 512 * MEBIBYTE;

/** The largest codec private data a container track may hand a decoder. */
export const GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH = MEBIBYTE;

/**
 * The version of the parser interface the engine drives: a decoder package's WebAssembly module that turns its track's packets into what its WGSL reads.
 * Version 2 lets a packet hold several pictures, such as an AV1 temporal unit's hidden frames beside its shown one, each with its own GPU record.
 */
export const GPU_DECODER_PARSER_ABI_VERSION = 2;

/** The most output events one picture's record, or one parser call, may carry: a parser may output or drop every picture its references and reorder depth hold at once. */
export const MAXIMUM_GPU_DECODE_OUTPUT_EVENTS = 256;

/** The most pictures a parser may make of one packet: an AV1 temporal unit's hidden frames, its shown frames, and its shown references stay far within it. */
export const MAXIMUM_GPU_DECODE_PACKET_PICTURES = 64;

/** The bit position of the error code in a decoder's status error word; the bits below hold the failing value. */
export const GPU_DECODER_ERROR_CODE_SHIFT = 24;

/** The largest error code a decoder may name, the high byte of a status error word. */
export const GPU_DECODER_MAXIMUM_ERROR_CODE = 255;

/**
 * The playback route sizes its pool from the container's coded size rounded up to a multiple of this, the largest coding block of the codecs it decodes.
 * Containers declare the cropped picture, while a decoder writes the picture padded to whole coding blocks, which the visible rectangle then crops.
 */
export const GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT = 64;
