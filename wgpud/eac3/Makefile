# The E-AC-3 package's module: FFmpeg's AC-3 decoder with its E-AC-3 decoder dependency, behind the audio decoder interface.
include ../rules.mk

FFMPEG_COMPONENTS := --enable-decoder=eac3
FFMPEG_DECODERS := ac3 eac3

module: toolchain
	$(call build_ffmpeg,$(FFMPEG_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_DECODERS))
	$(call link_ffmpeg_audio_module,ffmpeg_eac3_bridge.c)
