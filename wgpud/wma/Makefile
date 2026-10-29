# The WMA package's module: FFmpeg's WMA 1, WMA 2, WMA Pro, WMA Lossless, and WMA Voice decoders behind the audio decoder interface,
# with its optional drain, since these decoders hold frames back until the end of the stream.
include ../rules.mk

FFMPEG_COMPONENTS := --enable-decoder=wmav1 --enable-decoder=wmav2 --enable-decoder=wmapro \
	--enable-decoder=wmalossless --enable-decoder=wmavoice
FFMPEG_DECODERS := wmav1 wmav2 wmapro wmalossless wmavoice

module: toolchain
	$(call build_ffmpeg,$(FFMPEG_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_DECODERS))
	$(call link_ffmpeg_audio_module,ffmpeg_wma_bridge.c,_audio_decoder_drain)
