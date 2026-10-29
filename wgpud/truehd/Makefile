# The TrueHD package's module: FFmpeg's MLP and TrueHD decoders behind the audio decoder interface,
# with our decoder of the 16-channel presentation and the shared object renderer for Dolby Atmos,
# and our decode of a single-substream stream FFmpeg refuses.
include ../rules.mk

FFMPEG_COMPONENTS := --enable-decoder=mlp --enable-decoder=truehd
FFMPEG_DECODERS := mlp truehd
TRUEHD_SOURCES := ffmpeg_truehd_bridge.c truehd_objects.c truehd_presentation.c truehd_substream.c

module: toolchain
	$(call build_ffmpeg,$(FFMPEG_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_DECODERS))
	$(call link_ffmpeg_audio_module,$(TRUEHD_SOURCES),_audio_decoder_drain,$(ATMOS_MODULE_SOURCES))
