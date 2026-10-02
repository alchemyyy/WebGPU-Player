# Builds the engine's WebAssembly decoders from pinned sources.
#
# Needs GNU Make, Git, a POSIX shell (Git Bash on Windows), Emscripten 4.0.13, and cargo.
# Activate the pinned emsdk first, or pass EMSDK=/path/to/emsdk.
#
#   make -C codecs sources      Fetch the pinned FFmpeg and dcadec submodules
#   make -C codecs all          Rebuild every decoder into codecs/dist
#   make -C codecs check        Rebuild every decoder and compare it with codecs/dist
#   make -C codecs <kit>        Rebuild one of: $(KITS)
#   make -C codecs source-archives
#                               Write the corresponding-source tarballs for a release

SHELL := /bin/sh
.SUFFIXES:
.DELETE_ON_ERROR:

# Pinned versions
EMSCRIPTEN_VERSION := 4.0.13
EMSCRIPTEN_REVISION := 2659582941bef14008476903f48941909db1b196
FFMPEG_COMMIT := a59498db085e3d635532397128550141ab87408a
DCADEC_COMMIT := b93deed1a231dd6dd7e39b9fe7d2abe05aa00158

KITS := ffmpeg-eac3 ffmpeg-truehd libdcadec legacy-video libdovi

empty :=
space := $(empty) $(empty)
comma := ,
# Emscripten settings take comma-separated lists
comma_list = $(subst $(space),$(comma),$(strip $(1)))

# Layout
CODECS := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
ENGINE := $(patsubst %/,%,$(dir $(CODECS)))
BUILD := $(CODECS)/build
DIST := $(CODECS)/dist
ARCHIVES := $(BUILD)/source-archives
FFMPEG_SUBMODULE := $(CODECS)/external/ffmpeg
DCADEC_SUBMODULE := $(CODECS)/external/dcadec

# Toolchain
ifdef EMSDK
EMSCRIPTEN_DIRECTORY := $(EMSDK)/upstream/emscripten
LLVM_DIRECTORY := $(EMSDK)/upstream/bin
ifneq ($(wildcard $(EMSDK)/.emscripten),)
export EM_CONFIG := $(EMSDK)/.emscripten
endif
else
EMSCRIPTEN_DIRECTORY := $(patsubst %/,%,$(dir $(shell command -v emcc)))
LLVM_DIRECTORY := $(EMSCRIPTEN_DIRECTORY)/../bin
endif
EMCC := $(EMSCRIPTEN_DIRECTORY)/emcc
EMXX := $(EMSCRIPTEN_DIRECTORY)/em++
# Windows SDKs ship only the Python forms of these two launchers
EMAR := $(firstword $(wildcard $(EMSCRIPTEN_DIRECTORY)/emar $(EMSCRIPTEN_DIRECTORY)/emar.py))
EMRANLIB := $(firstword $(wildcard $(EMSCRIPTEN_DIRECTORY)/emranlib $(EMSCRIPTEN_DIRECTORY)/emranlib.py))
HOST_CC := $(LLVM_DIRECTORY)/clang
LLVM_NM := $(LLVM_DIRECTORY)/llvm-nm
CARGO ?= cargo
JOBS ?= $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

# Deterministic inputs; caller compiler settings never leak into a release build
export SOURCE_DATE_EPOCH := 0
export ZERO_AR_DATE := 1
export LANG := C
export LC_ALL := C
export PYTHONHASHSEED := 0
export TZ := UTC
unexport AR CC CFLAGS CONFIG_SITE CPPFLAGS CXX CXXFLAGS EMCC_CFLAGS EMCC_FORCE_STDLIBS \
	EMCC_ONLY_FORCED_STDLIBS EMMAKEN_CFLAGS EMMAKEN_JUST_CONFIGURE LD LDFLAGS LIBS NM \
	PKG_CONFIG PKG_CONFIG_LIBDIR PKG_CONFIG_PATH RANLIB

# FFmpeg configure and link settings shared by the FFmpeg kits
FFMPEG_CONFIGURE_BASE := --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm \
	--disable-x86asm --disable-inline-asm --disable-programs --disable-doc --disable-debug
FFMPEG_CONFIGURE_TOOLS = --cc=$(EMCC) --cxx=$(EMXX) --ar=$(EMAR) --ranlib=$(EMRANLIB) \
	--host-cc=$(HOST_CC) --nm=$(LLVM_NM)
AUDIO_WORKER_LINK_FLAGS := -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sFILESYSTEM=0 \
	-sSINGLE_FILE=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
	-sMAXIMUM_MEMORY=268435456 -sMALLOC=emmalloc -sASSERTIONS=0 -sWASM_BIGINT=1

# E-AC-3: FFmpeg enables the shared AC-3 decoder with its E-AC-3 decoder dependency
FFMPEG_EAC3_COMPONENTS := --disable-all --disable-everything --disable-autodetect \
	--disable-pthreads --disable-runtime-cpudetect --disable-gpl --disable-iconv \
	--disable-version3 --disable-nonfree --enable-avcodec --enable-decoder=eac3
FFMPEG_EAC3_DECODERS := ac3 eac3
FFMPEG_EAC3_EXPORTS := _malloc _free _jellyfin_eac3_create _jellyfin_eac3_configure_packet \
	_jellyfin_eac3_send_packet _jellyfin_eac3_receive_frame _jellyfin_eac3_get_plane \
	_jellyfin_eac3_get_sample_format _jellyfin_eac3_get_sample_count \
	_jellyfin_eac3_get_channel_count _jellyfin_eac3_get_channel_mask \
	_jellyfin_eac3_get_sample_rate _jellyfin_eac3_get_pts _jellyfin_eac3_clear \
	_jellyfin_eac3_destroy _jellyfin_eac3_library_version
FFMPEG_EAC3_RUNTIME_METHODS := cwrap HEAPU8 HEAPF32

# TrueHD and MLP
FFMPEG_TRUEHD_COMPONENTS := --disable-all --disable-everything --disable-autodetect \
	--disable-pthreads --disable-runtime-cpudetect --disable-gpl --disable-iconv \
	--disable-version3 --disable-nonfree --enable-avcodec --enable-decoder=mlp \
	--enable-decoder=truehd
FFMPEG_TRUEHD_DECODERS := mlp truehd
FFMPEG_TRUEHD_EXPORTS := _malloc _free _jellyfin_truehd_create \
	_jellyfin_truehd_configure_packet _jellyfin_truehd_send_packet \
	_jellyfin_truehd_receive_frame _jellyfin_truehd_get_interleaved_data \
	_jellyfin_truehd_get_sample_format _jellyfin_truehd_get_bytes_per_sample \
	_jellyfin_truehd_get_sample_count _jellyfin_truehd_get_channel_count \
	_jellyfin_truehd_get_channel_mask _jellyfin_truehd_get_sample_rate \
	_jellyfin_truehd_get_bits_per_raw_sample _jellyfin_truehd_get_profile \
	_jellyfin_truehd_get_pts _jellyfin_truehd_clear _jellyfin_truehd_destroy \
	_jellyfin_truehd_library_version
FFMPEG_TRUEHD_RUNTIME_METHODS := cwrap HEAPU8 HEAP16 HEAP32

# Both audio kits optimize for size with SIMD
FFMPEG_AUDIO_CFLAGS := -DNDEBUG -Oz -flto -msimd128
FFMPEG_AUDIO_LDFLAGS := -Oz -flto
FFMPEG_AUDIO_LINK_TAIL := -msimd128 -flto -Oz -Wl,--no-entry

# Progressive MPEG-2 Video and VC-1, as a classic worker module with a separate WASM file
LEGACY_VIDEO_COMPONENTS := --disable-all --disable-everything --disable-gpl \
	--disable-version3 --disable-nonfree --enable-avcodec --enable-decoder=mpeg2video \
	--enable-decoder=vc1 --disable-autodetect --disable-pthreads \
	--disable-runtime-cpudetect --disable-iconv
LEGACY_VIDEO_DECODERS := mpeg2video vc1
LEGACY_VIDEO_CFLAGS := -DNDEBUG -O3 -flto
LEGACY_VIDEO_LDFLAGS := -O3 -flto
LEGACY_VIDEO_EXPORTS := _legacy_video_decoder_create _legacy_video_decoder_get_extradata \
	_legacy_video_decoder_open _legacy_video_decoder_configure_packet \
	_legacy_video_decoder_send_packet _legacy_video_decoder_start_drain \
	_legacy_video_decoder_receive_frame _legacy_video_decoder_frame_is_i420 \
	_legacy_video_decoder_get_plane _legacy_video_decoder_get_stride \
	_legacy_video_decoder_get_width _legacy_video_decoder_get_height \
	_legacy_video_decoder_get_crop_left _legacy_video_decoder_get_crop_top \
	_legacy_video_decoder_get_crop_right _legacy_video_decoder_get_crop_bottom \
	_legacy_video_decoder_get_color_primaries _legacy_video_decoder_get_color_transfer \
	_legacy_video_decoder_get_color_matrix _legacy_video_decoder_get_color_range \
	_legacy_video_decoder_get_interlaced _legacy_video_decoder_get_top_field_first \
	_legacy_video_decoder_get_repeat_picture _legacy_video_decoder_get_timestamp \
	_legacy_video_decoder_get_duration _legacy_video_decoder_error_again \
	_legacy_video_decoder_error_eof _legacy_video_decoder_close
LEGACY_VIDEO_LINK_FLAGS := -O3 -flto -sWASM=1 -sWASM_BIGINT=1 -sFILESYSTEM=0 \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 \
	-sSTACK_SIZE=5242880 -sMODULARIZE=1 -sEXPORT_NAME=LegacyVideoDecoderModule \
	-sENVIRONMENT=worker,node -sASSERTIONS=0 -sMALLOC=emmalloc \
	-sEXPORTED_FUNCTIONS=$(call comma_list,$(LEGACY_VIDEO_EXPORTS)) \
	-sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 -Wl,--no-entry

# libdcadec, compiled directly from its sources in this order
DCADEC_SOURCES := bitstream.c core_decoder.c dca_context.c dca_frame.c dmix_tables.c \
	exss_parser.c idct_fixed.c idct_float.c interpolator.c interpolator_fixed.c \
	interpolator_float.c lbr_decoder.c ta.c xll_decoder.c
DCADEC_ROOT := $(BUILD)/libdcadec/source/dcadec-$(DCADEC_COMMIT)
LIBDCADEC_CFLAGS := -std=gnu99 -O3 -DNDEBUG -fno-exceptions
LIBDCADEC_EXPORTS := _jellyfin_dts_create _jellyfin_dts_configure_packet \
	_jellyfin_dts_decode_packet _jellyfin_dts_get_plane _jellyfin_dts_get_sample_count \
	_jellyfin_dts_get_channel_mask _jellyfin_dts_get_sample_rate \
	_jellyfin_dts_get_bits_per_sample _jellyfin_dts_get_profile \
	_jellyfin_dts_get_parse_status _jellyfin_dts_get_filter_status _jellyfin_dts_clear \
	_jellyfin_dts_destroy _jellyfin_dts_library_version

# libdovi; Rust embeds source paths in panic locations, so machine paths map to fixed names
LIBDOVI_TARGET := $(BUILD)/libdovi/target
LIBDOVI_MODULE := $(LIBDOVI_TARGET)/wasm32-unknown-unknown/release/jellyfin_webgpu_dolby_vision_parser.wasm
CARGO_HOME_DIRECTORY := $(or $(CARGO_HOME),$(HOME)/.cargo)
native_path = $(shell cygpath -m '$(1)' 2>/dev/null || printf '%s' '$(1)')
LIBDOVI_REMAPS := '--remap-path-prefix=$(call native_path,$(CARGO_HOME_DIRECTORY))=/cargo',\
'--remap-path-prefix=$(call native_path,$(CODECS)/libdovi)=/libdovi',\
'--remap-path-prefix=$(call native_path,$(LIBDOVI_TARGET))=/target'

# Outputs, relative to $(BUILD)/<kit>/output and codecs/dist/<kit>
OUTPUTS_ffmpeg-eac3 := ffmpeg-eac3.mjs
OUTPUTS_ffmpeg-truehd := ffmpeg-truehd.mjs
OUTPUTS_libdcadec := libdcadec.mjs
OUTPUTS_legacy-video := legacy-video-decode.js legacy-video-decode.wasm
OUTPUTS_libdovi := dovi-rpu-parser.wasm

.PHONY: all check clean sources source-archives toolchain $(KITS) $(KITS:%=build-%)

all: $(KITS)

# Copies freshly built outputs into codecs/dist
$(KITS): %: build-%
	mkdir -p $(DIST)/$*
	for output in $(OUTPUTS_$*); do cp $(BUILD)/$*/output/$$output $(DIST)/$*/$$output || exit 1; done

check: $(KITS:%=build-%)
	@status=0; \
	for kit in $(KITS); do \
		case $$kit in \
			ffmpeg-eac3) outputs="$(OUTPUTS_ffmpeg-eac3)" ;; \
			ffmpeg-truehd) outputs="$(OUTPUTS_ffmpeg-truehd)" ;; \
			libdcadec) outputs="$(OUTPUTS_libdcadec)" ;; \
			legacy-video) outputs="$(OUTPUTS_legacy-video)" ;; \
			libdovi) outputs="$(OUTPUTS_libdovi)" ;; \
		esac; \
		for output in $$outputs; do \
			if cmp -s $(BUILD)/$$kit/output/$$output $(DIST)/$$kit/$$output; then \
				echo "identical: $$kit/$$output"; \
			else \
				echo "DIFFERS: $$kit/$$output" >&2; status=1; \
			fi; \
		done; \
	done; \
	exit $$status

clean:
	rm -rf $(BUILD)

toolchain:
	@$(EMCC) --version | grep -qF ') $(EMSCRIPTEN_VERSION) ($(EMSCRIPTEN_REVISION))' || { \
		echo "Emscripten $(EMSCRIPTEN_VERSION) ($(EMSCRIPTEN_REVISION)) is required;" \
			"activate the pinned emsdk or pass EMSDK=/path/to/emsdk" >&2; \
		exit 1; \
	}

sources:
	git -C $(ENGINE) submodule update --init --checkout --depth 1 -- codecs/external/ffmpeg codecs/external/dcadec
	$(call require_commit,$(FFMPEG_SUBMODULE),$(FFMPEG_COMMIT))
	$(call require_commit,$(DCADEC_SUBMODULE),$(DCADEC_COMMIT))

# The release attaches these as the corresponding source for the LGPL decoders
source-archives: sources
	mkdir -p $(ARCHIVES)
	git -C $(FFMPEG_SUBMODULE) -c core.autocrlf=false archive --format=tar.gz \
		--prefix=ffmpeg-$(FFMPEG_COMMIT)/ -o $(ARCHIVES)/ffmpeg-$(FFMPEG_COMMIT).tar.gz $(FFMPEG_COMMIT)
	git -C $(DCADEC_SUBMODULE) -c core.autocrlf=false archive --format=tar.gz \
		--prefix=dcadec-$(DCADEC_COMMIT)/ -o $(ARCHIVES)/dcadec-$(DCADEC_COMMIT).tar.gz $(DCADEC_COMMIT)
	revision=$$(git -C $(ENGINE) rev-parse --short=12 HEAD) && \
		git -C $(ENGINE) -c core.autocrlf=false archive --format=tar.gz \
			--prefix=webgpu-player-codecs-$$revision/ \
			-o $(ARCHIVES)/webgpu-player-codecs-$$revision.tar.gz HEAD codecs ':(exclude)codecs/dist'
	ls -l $(ARCHIVES)

# $(1): submodule directory, $(2): pinned commit
define require_commit
	@test "$$(git -C $(1) rev-parse HEAD)" = "$(2)" || { echo "$(1) is not at $(2); run make sources" >&2; exit 1; }
endef

# Extracts a fresh copy of the pinned FFmpeg tree, which FFmpeg is then configured and built in
# Building outside a git checkout keeps the embedded version string and source paths stable
# $(1): kit, $(2): configure components, $(3): compile flags, $(4): link flags, $(5): decoders
define build_ffmpeg
	$(call require_commit,$(FFMPEG_SUBMODULE),$(FFMPEG_COMMIT))
	rm -rf $(BUILD)/$(1)
	mkdir -p $(BUILD)/$(1)/source $(BUILD)/$(1)/output
	git -C $(FFMPEG_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=FFmpeg-$(FFMPEG_COMMIT)/ $(FFMPEG_COMMIT) | tar -x -C $(BUILD)/$(1)/source
	cd $(BUILD)/$(1)/source/FFmpeg-$(FFMPEG_COMMIT) && ./configure $(FFMPEG_CONFIGURE_BASE) $(2) \
		$(FFMPEG_CONFIGURE_TOOLS) '--extra-cflags=$(3) $(call prefix_maps,$(1))' '--extra-ldflags=$(4)'
	$(call require_decoders,$(BUILD)/$(1)/source/FFmpeg-$(FFMPEG_COMMIT),$(5))
	MAKEFLAGS= MFLAGS= make -C $(BUILD)/$(1)/source/FFmpeg-$(FFMPEG_COMMIT) -j$(JOBS)
endef

# $(1): kit
prefix_maps = -ffile-prefix-map=$(BUILD)/$(1)/source/FFmpeg-$(FFMPEG_COMMIT)=ffmpeg-source \
	-ffile-prefix-map=$(ENGINE)=webgpu-player

# Fails unless configure kept the LGPL scope and enabled exactly the whitelisted decoders
# $(1): configured FFmpeg tree, $(2): decoders
define require_decoders
	@for marker in 'CONFIG_AVCODEC 1' 'CONFIG_GPL 0' 'CONFIG_NONFREE 0' 'CONFIG_VERSION3 0'; do \
		grep -q "^.define $$marker$$" $(1)/config.h || { echo "FFmpeg config.h lacks $$marker" >&2; exit 1; }; \
	done
	@enabled=$$(sed -n 's/^.define CONFIG_\([A-Z0-9_]*\)_DECODER 1$$/\1/p' $(1)/config_components.h \
		| tr 'A-Z' 'a-z' | sort | tr '\n' ' '); \
	expected=$$(printf '%s\n' $(2) | sort | tr '\n' ' '); \
	test "$$enabled" = "$$expected" || { \
		echo "FFmpeg enabled decoders [$$enabled] instead of [$$expected]" >&2; exit 1; \
	}
endef

# Emscripten on Windows writes CRLF into the JavaScript glue; dist holds LF
# $(1): raw output, $(2): normalized output
define normalize_line_endings
	tr -d '\r' < $(1) > $(2)
	rm -f $(1)
endef

build-ffmpeg-eac3: toolchain
	$(call build_ffmpeg,ffmpeg-eac3,$(FFMPEG_EAC3_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_EAC3_DECODERS))
	$(EMCC) $(CODECS)/ffmpeg-eac3/ffmpeg_eac3_bridge.c \
		$(BUILD)/ffmpeg-eac3/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/ffmpeg-eac3/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/ffmpeg-eac3/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,ffmpeg-eac3) \
		$(AUDIO_WORKER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(FFMPEG_EAC3_EXPORTS)) \
		-sEXPORTED_RUNTIME_METHODS=$(call comma_list,$(FFMPEG_EAC3_RUNTIME_METHODS)) \
		$(FFMPEG_AUDIO_LINK_TAIL) \
		-o $(BUILD)/ffmpeg-eac3/output/raw.mjs
	$(call normalize_line_endings,$(BUILD)/ffmpeg-eac3/output/raw.mjs,$(BUILD)/ffmpeg-eac3/output/ffmpeg-eac3.mjs)

build-ffmpeg-truehd: toolchain
	$(call build_ffmpeg,ffmpeg-truehd,$(FFMPEG_TRUEHD_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_TRUEHD_DECODERS))
	$(EMCC) $(CODECS)/ffmpeg-truehd/ffmpeg_truehd_bridge.c \
		$(BUILD)/ffmpeg-truehd/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/ffmpeg-truehd/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/ffmpeg-truehd/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,ffmpeg-truehd) \
		$(AUDIO_WORKER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(FFMPEG_TRUEHD_EXPORTS)) \
		-sEXPORTED_RUNTIME_METHODS=$(call comma_list,$(FFMPEG_TRUEHD_RUNTIME_METHODS)) \
		$(FFMPEG_AUDIO_LINK_TAIL) \
		-o $(BUILD)/ffmpeg-truehd/output/raw.mjs
	$(call normalize_line_endings,$(BUILD)/ffmpeg-truehd/output/raw.mjs,$(BUILD)/ffmpeg-truehd/output/ffmpeg-truehd.mjs)

build-legacy-video: toolchain
	$(call build_ffmpeg,legacy-video,$(LEGACY_VIDEO_COMPONENTS),$(LEGACY_VIDEO_CFLAGS),$(LEGACY_VIDEO_LDFLAGS),$(LEGACY_VIDEO_DECODERS))
	$(EMCC) $(CODECS)/legacy-video/bridge.c \
		$(BUILD)/legacy-video/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/legacy-video/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/legacy-video/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,legacy-video) \
		$(LEGACY_VIDEO_LINK_FLAGS) -o $(BUILD)/legacy-video/output/legacy-video-decode.js
	mv $(BUILD)/legacy-video/output/legacy-video-decode.js $(BUILD)/legacy-video/output/raw.js
	$(call normalize_line_endings,$(BUILD)/legacy-video/output/raw.js,$(BUILD)/legacy-video/output/legacy-video-decode.js)

build-libdcadec: toolchain
	$(call require_commit,$(DCADEC_SUBMODULE),$(DCADEC_COMMIT))
	rm -rf $(BUILD)/libdcadec
	mkdir -p $(BUILD)/libdcadec/source $(BUILD)/libdcadec/output
	git -C $(DCADEC_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=dcadec-$(DCADEC_COMMIT)/ $(DCADEC_COMMIT) | tar -x -C $(BUILD)/libdcadec/source
	$(EMCC) $(LIBDCADEC_CFLAGS) -ffile-prefix-map=$(ENGINE)=webgpu-player \
		-ffile-prefix-map=$(DCADEC_ROOT)=libdcadec-source -I$(DCADEC_ROOT)/libdcadec \
		$(CODECS)/libdcadec/libdcadec_bridge.c $(addprefix $(DCADEC_ROOT)/libdcadec/,$(DCADEC_SOURCES)) \
		$(AUDIO_WORKER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(LIBDCADEC_EXPORTS)) \
		-sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAP32 -Wl,--no-entry \
		-o $(BUILD)/libdcadec/output/raw.mjs
	$(call normalize_line_endings,$(BUILD)/libdcadec/output/raw.mjs,$(BUILD)/libdcadec/output/libdcadec.mjs)

# The crate's .cargo/config.toml supplies the memory link arguments; --config appends the remaps
build-libdovi:
	rm -rf $(BUILD)/libdovi/output
	mkdir -p $(BUILD)/libdovi/output
	cd $(CODECS)/libdovi && CARGO_TARGET_DIR='$(LIBDOVI_TARGET)' $(CARGO) build --locked --release \
		--target wasm32-unknown-unknown \
		--config "target.wasm32-unknown-unknown.rustflags=[$(LIBDOVI_REMAPS)]"
	cp $(LIBDOVI_MODULE) $(BUILD)/libdovi/output/dovi-rpu-parser.wasm
