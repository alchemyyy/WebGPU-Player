// Bounds of the GPU decode route that the decode worker protocol and the GPU modules share.
// This module imports only plain values, so the worker bundle takes these bounds without any GPU code.
import { MAXIMUM_STORAGE_BUFFER_BINDING_SIZE } from '../../presentation/WebGPUConstants';

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

/** The packets the ring holds, so consecutive packets occupy different regions. */
export const GPU_DECODE_PACKET_RING_PACKET_COUNT = 2;

/** The largest packet a decoder may declare: a full ring fills WebGPU's default storage binding. */
export const GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH = MAXIMUM_STORAGE_BUFFER_BINDING_SIZE / GPU_DECODE_PACKET_RING_PACKET_COUNT;

/** The largest codec private data a container track may hand a decoder. */
export const GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH = MEBIBYTE;
