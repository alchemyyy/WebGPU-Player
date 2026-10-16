# The DTS package's module: libdcadec, compiled directly from its sources, behind the audio decoder interface.
# It decodes DTS core, DTS-HD High Resolution, and DTS-HD Master Audio.
include ../rules.mk

# libdcadec's sources, compiled in this order
DCADEC_SOURCES := bitstream.c core_decoder.c dca_context.c dca_frame.c dmix_tables.c \
	exss_parser.c idct_fixed.c idct_float.c interpolator.c interpolator_fixed.c \
	interpolator_float.c lbr_decoder.c ta.c xll_decoder.c
DCADEC_ROOT := $(BUILD)/source/dcadec-$(DCADEC_COMMIT)
# One emcc call compiles and links, so SIMD and link-time optimization cover both, as in the FFmpeg audio modules
LIBDCADEC_CFLAGS := -std=gnu99 -O3 -DNDEBUG -fno-exceptions -msimd128 -flto

module: toolchain
	$(call require_commit,$(DCADEC_SUBMODULE),$(DCADEC_COMMIT))
	rm -rf $(BUILD)
	mkdir -p $(BUILD)/source
	git -C $(DCADEC_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=dcadec-$(DCADEC_COMMIT)/ $(DCADEC_COMMIT) | tar -x -C $(BUILD)/source
	$(EMCC) $(LIBDCADEC_CFLAGS) -ffile-prefix-map=$(ENGINE)=webgpu-player \
		-ffile-prefix-map=$(DCADEC_ROOT)=libdcadec-source -I$(DCADEC_ROOT)/libdcadec $(AUDIO_MODULE_INCLUDES) \
		$(PROJECT_DIRECTORY)/libdcadec_dts_bridge.c $(addprefix $(DCADEC_ROOT)/libdcadec/,$(DCADEC_SOURCES)) \
		$(AUDIO_MODULE_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(AUDIO_MODULE_EXPORTS)) \
		-o $(MODULE)
