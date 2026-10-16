# The TrueHD package's module: FFmpeg's MLP and TrueHD decoders behind the audio decoder interface.
include ../rules.mk

FFMPEG_COMPONENTS := --enable-decoder=mlp --enable-decoder=truehd
FFMPEG_DECODERS := mlp truehd

module: toolchain
	$(call build_ffmpeg,$(FFMPEG_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_DECODERS))
	$(call link_ffmpeg_audio_module,ffmpeg_truehd_bridge.c)
