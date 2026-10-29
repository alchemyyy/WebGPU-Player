# The object audio test module: the shared sources in this folder with test/atmos_test_exports.c, which test/Atmos.test.ts drives.
# No package carries it; this folder holds no decoder.json, so scripts/decoder-packages.mjs skips it. The eac3 and truehd modules compile
# the same sources through rules.mk's ATMOS_MODULE_SOURCES.
#   make -C wgpud/atmos module    Build $(MODULE) for the tests
include ../rules.mk

ATMOS_TEST_EXPORTS := _malloc _free _atmos_parse_oamd _atmos_layout_supported _atmos_renderer_create _atmos_renderer_destroy \
	_atmos_renderer_set_target _atmos_renderer_channel_mask _atmos_renderer_channel_count _atmos_renderer_latency \
	_atmos_renderer_add_metadata _atmos_renderer_render _atmos_renderer_reset _atmos_test_metadata_create _atmos_test_metadata_destroy \
	_atmos_test_metadata_field _atmos_test_metadata_kind _atmos_test_metadata_bed_channel _atmos_test_metadata_start \
	_atmos_test_metadata_ramp _atmos_test_metadata_property _atmos_test_metadata_add_object _atmos_test_metadata_set_update \
	_atmos_test_metadata_set_property _atmos_test_renderer_set_scene
# The packages' settings: speed with SIMD, in a module that imports its memory as the audio modules do
ATMOS_TEST_CFLAGS := -std=gnu11 -DNDEBUG -O3 -flto -msimd128 -Wall -Wextra -ffile-prefix-map=$(ENGINE)=webgpu-player

module: toolchain
	mkdir -p $(BUILD)
	$(EMCC) $(ATMOS_TEST_CFLAGS) $(ATMOS_MODULE_SOURCES) $(PROJECT_DIRECTORY)/test/atmos_test_exports.c \
		$(AUDIO_MODULE_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(ATMOS_TEST_EXPORTS)) -o $(MODULE)
