/*
 * Version 1 of the engine's audio decoder interface, which an audio decoder package's module exports.
 * src/decode/audio/AudioDecoderPackageInstance.ts drives it; the engine's book describes it.
 *
 * Every call takes the handle audio_decoder_create returned. A call that fails returns AUDIO_DECODER_FAILED
 * after setting the error code and value that audio_decoder_error_code and audio_decoder_error_value report,
 * named by the package manifest's `error:` lines.
 */
#ifndef AUDIO_DECODER_INTERFACE_H
#define AUDIO_DECODER_INTERFACE_H

#define AUDIO_DECODER_ABI_VERSION 1

/* Status of configure, set_option, send, and receive calls */
#define AUDIO_DECODER_SUCCESS 0
#define AUDIO_DECODER_FAILED (-1)

/* What audio_decoder_send reports for a packet */
#define AUDIO_DECODER_SEND_ACCEPTED 0
#define AUDIO_DECODER_SEND_DROPPED 1
#define AUDIO_DECODER_SEND_AWAITING_SYNC 2

/* What audio_decoder_receive reports */
#define AUDIO_DECODER_RECEIVE_NONE 0
#define AUDIO_DECODER_RECEIVE_READY 1

/* The timestamp of a block without one of its own, which then continues from its packet's timestamp */
#define AUDIO_DECODER_NO_TIMESTAMP (-1.0)

/* An attribute the decoder does not report */
#define AUDIO_DECODER_NO_ATTRIBUTE (__builtin_nan(""))

/*
 * The optional export a module may add to version 1: int audio_decoder_drain(handle).
 * The engine calls it once at the end of a track, after the last packet, and then calls audio_decoder_receive until it reports
 * AUDIO_DECODER_RECEIVE_NONE, so a decoder that holds frames back outputs them. It returns AUDIO_DECODER_SUCCESS or AUDIO_DECODER_FAILED.
 * A module without it ends a track at its last packet's blocks.
 */
#define AUDIO_DECODER_DRAIN_EXPORT "audio_decoder_drain"

#endif
