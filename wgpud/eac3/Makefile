# The E-AC-3 package's module: FFmpeg's AC-3 and E-AC-3 decoders behind the audio decoder interface, with our joint object coding
# decoder of Dolby Atmos objects and the shared object renderer. Its optional drain outputs the object blocks it holds at the end.
include ../rules.mk

FFMPEG_COMPONENTS := --enable-decoder=eac3
FFMPEG_DECODERS := ac3 eac3
EAC3_SOURCES := ffmpeg_eac3_bridge.c eac3_emdf.c eac3_joc.c eac3_qmf.c eac3_joc_tables.c

module: toolchain
	$(call build_ffmpeg,$(FFMPEG_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_DECODERS))
	$(call link_ffmpeg_audio_module,$(EAC3_SOURCES),_audio_decoder_drain,$(ATMOS_MODULE_SOURCES))
