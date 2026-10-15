# The AV1 package's module: its parser, libaom's decoder running its parse-only pass behind the bridge in parser/, which turns every
# frame into the GPU record av1.wgsl and the family files in wgsl/ reconstruct from. libaom builds from the pinned vendor/aom with the
# patch set in parser/patches/, applied in order in the build tree.
include ../rules.mk

PARSER_DIRECTORY := $(PROJECT_DIRECTORY)/parser
PATCHES := $(sort $(wildcard $(PARSER_DIRECTORY)/patches/*.patch))
PARSER_SOURCES := $(PARSER_DIRECTORY)/av1_parser.c $(PARSER_DIRECTORY)/av1_record.c
GENERATED_DIRECTORY = $(BUILD)/generated
RECORD_LAYOUT_HEADER = $(GENERATED_DIRECTORY)/av1_record_layout.h

# libaom and the bridge optimize for speed: entropy decoding is the parser's serial cost
PARSER_COMPILE_FLAGS := -O3 -DNDEBUG -msimd128
# A standalone reactor without JavaScript glue, which imports its memory, up to the 1 GiB a package instance gets
PARSER_LINK_FLAGS := -sSTANDALONE_WASM -sIMPORTED_MEMORY -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 \
	-sINITIAL_MEMORY=33554432 -sMAXIMUM_MEMORY=1073741824 -sSTACK_SIZE=1048576 -sMALLOC=emmalloc \
	-sASSERTIONS=0 --no-entry
PARSER_EXPORTS := _parser_abi_version _parser_create _parser_destroy _parser_reserve_input _parser_configure \
	_parser_reset _parser_plan _parser_plan_next _parser_plan_unit_count _parser_parse _parser_finish _parser_decode \
	_parser_decode_next _parser_output_pointer _parser_output_byte_length _parser_event_pointer _parser_event_count \
	_parser_picture_width _parser_picture_height _parser_picture_format _parser_picture_repeat_count _parser_maximum_picture_width \
	_parser_maximum_picture_height _parser_error_code _parser_error_value

module: toolchain
	$(call build_aom,$(PATCHES),$(PARSER_COMPILE_FLAGS))
	node $(PARSER_DIRECTORY)/record_layout.mjs $(PROJECT_DIRECTORY)/av1.wgsl $(RECORD_LAYOUT_HEADER)
	$(EMCC) $(PARSER_COMPILE_FLAGS) $(AOM_LONGJMP_FLAGS) $(aom_prefix_maps) \
		-I$(AOM_TREE) -I$(AOM_BUILD_TREE) -I$(GENERATED_DIRECTORY) $(PARSER_SOURCES) $(AOM_LIBRARY) \
		$(PARSER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(PARSER_EXPORTS)) -o $(MODULE)
