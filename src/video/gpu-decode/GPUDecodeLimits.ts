// Bounds of the GPU decode route that the decode worker protocol and the GPU modules share.
// This module imports nothing, so the worker bundle takes these bounds without any GPU code.

const MEBIBYTE = 1024 * 1024;

/** The most slots a frame pool holds, because a decoder reports freed slots as one 32-bit mask. */
export const GPU_FRAME_POOL_MAXIMUM_SLOT_COUNT = 32;

/** The largest packet a decoder may declare; a ring of two stays within WebGPU's default 128 MiB storage binding. */
export const GPU_DECODE_MAXIMUM_PACKET_BYTE_LENGTH = 64 * MEBIBYTE;

/** The largest codec private data a container track may hand a decoder. */
export const GPU_DECODE_MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH = MEBIBYTE;
