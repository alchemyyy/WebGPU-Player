# Builds the engine's WebAssembly decoders from pinned sources.
#
# Needs GNU Make, Git, a POSIX shell (Git Bash on Windows), Node.js, Emscripten 4.0.13, and cargo.
# Activate the pinned emsdk first, or pass EMSDK=/path/to/emsdk.
#
#   make -C wasm sources            Fetch the pinned FFmpeg and dcadec submodules
#   make -C wasm all                Build every decoder into bin/wasm, which is ignored like the rest of bin
#   make -C wasm check              Rebuild every decoder and compare it with the existing bin/wasm
#   make -C wasm <kit>              Rebuild one of: $(KITS)
#   make -C wasm source-archives    Write the corresponding-source tarballs for a release

SHELL := /bin/sh
.SUFFIXES:
.DELETE_ON_ERROR:

# Pinned versions
EMSCRIPTEN_VERSION := 4.0.13
EMSCRIPTEN_REVISION := 2659582941bef14008476903f48941909db1b196
FFMPEG_COMMIT := a59498db085e3d635532397128550141ab87408a
DCADEC_COMMIT := b93deed1a231dd6dd7e39b9fe7d2abe05aa00158

KITS := ffmpeg-eac3 ffmpeg-truehd libdcadec-dts ffmpeg-mpeg2-vc1 ffmpeg-hevc libdovi audio-output-stage

empty :=
space := $(empty) $(empty)
comma := ,
# Emscripten settings take comma-separated lists
comma_list = $(subst $(space),$(comma),$(strip $(1)))

# Layout
# The engine's folders come from tools/constants.json, the one place that names them
WASM := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
ENGINE := $(patsubst %/,%,$(dir $(WASM)))
engine_layout = $(shell node -p "require('$(ENGINE)/tools/constants.json').$(1)")
BUILD := $(WASM)/build
DIST := $(ENGINE)/$(call engine_layout,wasmOutputDirectory)
ARCHIVES := $(BUILD)/source-archives
FFMPEG_SOURCE := $(call engine_layout,ffmpegSourceDirectory)
DCADEC_SOURCE := $(call engine_layout,dcadecSourceDirectory)
FFMPEG_SUBMODULE := $(ENGINE)/$(FFMPEG_SOURCE)
DCADEC_SUBMODULE := $(ENGINE)/$(DCADEC_SOURCE)

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
# The audio, MPEG-2, and VC-1 kits build FFmpeg's portable C
FFMPEG_CONFIGURE_BASE := --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm \
	--disable-x86asm --disable-inline-asm --disable-programs --disable-doc --disable-debug
# The HEVC kit builds for WebAssembly instead, so FFmpeg's simd128 HEVC transforms and SAO filters build too
FFMPEG_CONFIGURE_WASM_BASE := --target-os=none --arch=wasm --enable-cross-compile \
	--disable-x86asm --disable-inline-asm --disable-programs --disable-doc --disable-debug
FFMPEG_CONFIGURE_TOOLS = --cc=$(EMCC) --cxx=$(EMXX) --ar=$(EMAR) --ranlib=$(EMRANLIB) \
	--host-cc=$(HOST_CC) --nm=$(LLVM_NM)
# The audio kits link ES module glue, which the engine bundles into its workers, and a separate WASM file.
# The probe and playback workers share that file's URL, and fetch it only when they create a decoder
AUDIO_WORKER_LINK_FLAGS := -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker -sFILESYSTEM=0 \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 \
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
# Its heap may grow to the 4 GiB a wasm32 module addresses, so no picture size is refused for memory
FFMPEG_MPEG2_VC1_COMPONENTS := --disable-all --disable-everything --disable-gpl \
	--disable-version3 --disable-nonfree --enable-avcodec --enable-decoder=mpeg2video \
	--enable-decoder=vc1 --disable-autodetect --disable-pthreads \
	--disable-runtime-cpudetect --disable-iconv
FFMPEG_MPEG2_VC1_DECODERS := mpeg2video vc1
FFMPEG_MPEG2_VC1_CFLAGS := -DNDEBUG -O3 -flto
FFMPEG_MPEG2_VC1_LDFLAGS := -O3 -flto
FFMPEG_MPEG2_VC1_EXPORTS := _mpeg2_vc1_decoder_create _mpeg2_vc1_decoder_get_extradata \
	_mpeg2_vc1_decoder_open _mpeg2_vc1_decoder_configure_packet \
	_mpeg2_vc1_decoder_send_packet _mpeg2_vc1_decoder_start_drain \
	_mpeg2_vc1_decoder_receive_frame _mpeg2_vc1_decoder_frame_is_i420 \
	_mpeg2_vc1_decoder_get_plane _mpeg2_vc1_decoder_get_stride \
	_mpeg2_vc1_decoder_get_width _mpeg2_vc1_decoder_get_height \
	_mpeg2_vc1_decoder_get_crop_left _mpeg2_vc1_decoder_get_crop_top \
	_mpeg2_vc1_decoder_get_crop_right _mpeg2_vc1_decoder_get_crop_bottom \
	_mpeg2_vc1_decoder_get_color_primaries _mpeg2_vc1_decoder_get_color_transfer \
	_mpeg2_vc1_decoder_get_color_matrix _mpeg2_vc1_decoder_get_color_range \
	_mpeg2_vc1_decoder_get_interlaced _mpeg2_vc1_decoder_get_top_field_first \
	_mpeg2_vc1_decoder_get_repeat_picture _mpeg2_vc1_decoder_get_timestamp \
	_mpeg2_vc1_decoder_get_duration _mpeg2_vc1_decoder_error_again \
	_mpeg2_vc1_decoder_error_eof _mpeg2_vc1_decoder_close
FFMPEG_MPEG2_VC1_LINK_FLAGS := -O3 -flto -sWASM=1 -sWASM_BIGINT=1 -sFILESYSTEM=0 \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4294967296 \
	-sSTACK_SIZE=5242880 -sMODULARIZE=1 -sEXPORT_NAME=MPEG2VC1DecoderModule \
	-sENVIRONMENT=worker,node -sASSERTIONS=0 -sMALLOC=emmalloc \
	-sEXPORTED_FUNCTIONS=$(call comma_list,$(FFMPEG_MPEG2_VC1_EXPORTS)) \
	-sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8 -Wl,--no-entry

# HEVC Main and Main 10, as a classic worker module with a separate WASM file, like the MPEG-2 and VC-1 kit
# simd128 at compile and link time, because link-time optimization generates the code at the link
FFMPEG_HEVC_COMPONENTS := --disable-all --disable-everything --disable-gpl \
	--disable-version3 --disable-nonfree --enable-avcodec --enable-decoder=hevc \
	--disable-autodetect --disable-pthreads --disable-runtime-cpudetect --disable-iconv
FFMPEG_HEVC_DECODERS := hevc
FFMPEG_HEVC_CFLAGS := -DNDEBUG -O3 -flto -msimd128
FFMPEG_HEVC_LDFLAGS := -O3 -flto -msimd128
FFMPEG_HEVC_EXPORTS := _hevc_decoder_create _hevc_decoder_get_extradata _hevc_decoder_open \
	_hevc_decoder_configure_packet _hevc_decoder_send_packet _hevc_decoder_start_drain \
	_hevc_decoder_receive_frame _hevc_decoder_reset _hevc_decoder_get_bit_depth \
	_hevc_decoder_get_plane _hevc_decoder_get_stride _hevc_decoder_get_width \
	_hevc_decoder_get_height _hevc_decoder_get_timestamp _hevc_decoder_get_duration \
	_hevc_decoder_error_again _hevc_decoder_error_eof _hevc_decoder_close
FFMPEG_HEVC_LINK_FLAGS := -O3 -flto -msimd128 -sWASM=1 -sWASM_BIGINT=1 -sFILESYSTEM=0 \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4294967296 \
	-sSTACK_SIZE=5242880 -sMODULARIZE=1 -sEXPORT_NAME=HEVCDecoderModule \
	-sENVIRONMENT=worker,node -sASSERTIONS=0 -sMALLOC=emmalloc \
	-sEXPORTED_FUNCTIONS=$(call comma_list,$(FFMPEG_HEVC_EXPORTS)) \
	-sEXPORTED_RUNTIME_METHODS=HEAPU8 -Wl,--no-entry

# libdcadec, compiled directly from its sources in this order
DCADEC_SOURCES := bitstream.c core_decoder.c dca_context.c dca_frame.c dmix_tables.c \
	exss_parser.c idct_fixed.c idct_float.c interpolator.c interpolator_fixed.c \
	interpolator_float.c lbr_decoder.c ta.c xll_decoder.c
DCADEC_ROOT := $(BUILD)/libdcadec-dts/source/dcadec-$(DCADEC_COMMIT)
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
# With the rust-src component installed, rustc rewrites the standard library's /rustc/<commit> paths to that local copy, so it maps back.
# The trailing slash keeps the original separators.
# These expand only when build-libdovi runs, so rustc runs only for that build, inside the crate, where rust-toolchain.toml selects the toolchain
LIBDOVI_RUST_SOURCE = $(call native_path,$(shell cd $(WASM)/libdovi && rustc --print sysroot))/lib/rustlib/src/rust
LIBDOVI_RUSTC_COMMIT = $(shell cd $(WASM)/libdovi && rustc -vV | sed -n 's/^commit-hash: //p')
LIBDOVI_REMAPS = '--remap-path-prefix=$(call native_path,$(CARGO_HOME_DIRECTORY))=/cargo',\
'--remap-path-prefix=$(call native_path,$(WASM)/libdovi)=/libdovi',\
'--remap-path-prefix=$(call native_path,$(LIBDOVI_TARGET))=/target',\
'--remap-path-prefix=$(LIBDOVI_RUST_SOURCE)=/rustc/$(LIBDOVI_RUSTC_COMMIT)/'

# The decoded audio output stage: the resampler and limiter kernels, a standalone module without JavaScript glue.
# Its outputs must match the JavaScript reference bit for bit, so no multiply and add may fuse.
# emcc's own --no-entry makes it a reactor, whose exported _initialize runs the constructors that set up emmalloc's heap
AUDIO_OUTPUT_STAGE_CFLAGS := -std=c11 -O3 -DNDEBUG -msimd128 -ffp-contract=off
AUDIO_OUTPUT_STAGE_LINK_FLAGS := -sSTANDALONE_WASM -sMALLOC=emmalloc -sALLOW_MEMORY_GROWTH=1 \
	-sINITIAL_MEMORY=4194304 -sMAXIMUM_MEMORY=4294967296 -sSTACK_SIZE=65536 --no-entry
AUDIO_OUTPUT_STAGE_EXPORTS := _audio_output_stage_abi_version _audio_resampler_create \
	_audio_resampler_destroy _audio_resampler_filter_table _audio_resampler_reserve_input \
	_audio_resampler_output _audio_resampler_append _audio_resampler_discard_before \
	_audio_resampler_render _audio_limiter_create _audio_limiter_destroy \
	_audio_limiter_reserve_input _audio_limiter_output _audio_limiter_telemetry \
	_audio_limiter_append _audio_limiter_render

# Outputs, relative to $(BUILD)/<kit>/output and bin/wasm/<kit>
OUTPUTS_ffmpeg-eac3 := ffmpeg-eac3.mjs ffmpeg-eac3.wasm
OUTPUTS_ffmpeg-truehd := ffmpeg-truehd.mjs ffmpeg-truehd.wasm
OUTPUTS_libdcadec-dts := libdcadec-dts.mjs libdcadec-dts.wasm
OUTPUTS_ffmpeg-mpeg2-vc1 := ffmpeg-mpeg2-vc1.js ffmpeg-mpeg2-vc1.wasm
OUTPUTS_ffmpeg-hevc := ffmpeg-hevc.js ffmpeg-hevc.wasm
OUTPUTS_libdovi := dovi-rpu-parser.wasm
OUTPUTS_audio-output-stage := audio-output-stage.wasm

.PHONY: all check clean sources source-archives toolchain $(KITS) $(KITS:%=build-%)

all: $(KITS)

# Copies freshly built outputs into bin/wasm
$(KITS): %: build-%
	mkdir -p $(DIST)/$*
	for output in $(OUTPUTS_$*); do cp $(BUILD)/$*/output/$$output $(DIST)/$*/$$output || exit 1; done

check: $(KITS:%=build-%)
	@status=0; \
	for kit in $(KITS); do \
		case $$kit in \
			ffmpeg-eac3) outputs="$(OUTPUTS_ffmpeg-eac3)" ;; \
			ffmpeg-truehd) outputs="$(OUTPUTS_ffmpeg-truehd)" ;; \
			libdcadec-dts) outputs="$(OUTPUTS_libdcadec-dts)" ;; \
			ffmpeg-mpeg2-vc1) outputs="$(OUTPUTS_ffmpeg-mpeg2-vc1)" ;; \
			ffmpeg-hevc) outputs="$(OUTPUTS_ffmpeg-hevc)" ;; \
			libdovi) outputs="$(OUTPUTS_libdovi)" ;; \
			audio-output-stage) outputs="$(OUTPUTS_audio-output-stage)" ;; \
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
	$(call fetch_source,$(FFMPEG_SOURCE))
	$(call fetch_source,$(DCADEC_SOURCE))
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
			--prefix=webgpu-player-wasm-$$revision/ \
			-o $(ARCHIVES)/webgpu-player-wasm-$$revision.tar.gz HEAD wasm
	ls -l $(ARCHIVES)

# Checks out a source submodule at the commit the engine records, fetching only that commit when it is missing.
# git submodule update --depth 1 would first clone the tip of the submodule's default branch, then fetch the commit.
# The submodule's name is its path, as in .gitmodules.
# absorbgitdirs moves a new git directory to where git submodule keeps it
# $(1): submodule path, relative to the engine
define fetch_source
	git -C $(ENGINE) submodule init -- $(1)
	test -e $(ENGINE)/$(1)/.git || { git init -q $(ENGINE)/$(1) && \
		git -C $(ENGINE)/$(1) remote add origin "$$(git -C $(ENGINE) config submodule.$(1).url)"; }
	commit=$$(git -C $(ENGINE) rev-parse :$(1)) && \
		if [ "$$(git -C $(ENGINE)/$(1) rev-parse -q --verify HEAD)" != "$$commit" ]; then \
			{ git -C $(ENGINE)/$(1) cat-file -e "$$commit^{commit}" 2>/dev/null || \
				git -C $(ENGINE)/$(1) fetch --depth 1 origin "$$commit"; } && \
			git -C $(ENGINE)/$(1) checkout -q --detach "$$commit"; \
		fi
	git -C $(ENGINE) submodule absorbgitdirs -- $(1)
endef

# $(1): submodule directory, $(2): pinned commit
define require_commit
	@test "$$(git -C $(1) rev-parse HEAD)" = "$(2)" || { echo "$(1) is not at $(2); run make sources" >&2; exit 1; }
endef

# Extracts a fresh copy of the pinned FFmpeg tree, then configures and builds FFmpeg in it.
# Building outside a git checkout keeps the embedded version string and source paths stable
# $(1): kit, $(2): configure base, $(3): configure components, $(4): compile flags, $(5): link flags, $(6): decoders
define build_ffmpeg
	$(call require_commit,$(FFMPEG_SUBMODULE),$(FFMPEG_COMMIT))
	rm -rf $(BUILD)/$(1)
	mkdir -p $(BUILD)/$(1)/source $(BUILD)/$(1)/output
	git -C $(FFMPEG_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=FFmpeg-$(FFMPEG_COMMIT)/ $(FFMPEG_COMMIT) | tar -x -C $(BUILD)/$(1)/source
	cd $(BUILD)/$(1)/source/FFmpeg-$(FFMPEG_COMMIT) && ./configure $(2) $(3) \
		$(FFMPEG_CONFIGURE_TOOLS) '--extra-cflags=$(4) $(call prefix_maps,$(1))' '--extra-ldflags=$(5)'
	$(call require_decoders,$(BUILD)/$(1)/source/FFmpeg-$(FFMPEG_COMMIT),$(6))
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

# Fails unless configure kept FFmpeg's WebAssembly SIMD code, which it drops when its simd128 compile check fails
# $(1): configured FFmpeg tree
define require_simd128
	@grep -q '^.define HAVE_SIMD128 1$$' $(1)/config.h || { echo "FFmpeg config.h lacks HAVE_SIMD128 1" >&2; exit 1; }
endef

# Emscripten on Windows writes CRLF into the JavaScript glue; bin/wasm holds LF on every host.
# A glue links under its final name, so it names its WASM file after the kit, then moves aside to be normalized
# $(1): raw output, $(2): normalized output
define normalize_line_endings
	tr -d '\r' < $(1) > $(2)
	rm -f $(1)
endef

build-ffmpeg-eac3: toolchain
	$(call build_ffmpeg,ffmpeg-eac3,$(FFMPEG_CONFIGURE_BASE),$(FFMPEG_EAC3_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_EAC3_DECODERS))
	$(EMCC) $(WASM)/ffmpeg-eac3/ffmpeg_eac3_bridge.c \
		$(BUILD)/ffmpeg-eac3/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/ffmpeg-eac3/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/ffmpeg-eac3/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,ffmpeg-eac3) \
		$(AUDIO_WORKER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(FFMPEG_EAC3_EXPORTS)) \
		-sEXPORTED_RUNTIME_METHODS=$(call comma_list,$(FFMPEG_EAC3_RUNTIME_METHODS)) \
		$(FFMPEG_AUDIO_LINK_TAIL) \
		-o $(BUILD)/ffmpeg-eac3/output/ffmpeg-eac3.mjs
	mv $(BUILD)/ffmpeg-eac3/output/ffmpeg-eac3.mjs $(BUILD)/ffmpeg-eac3/output/raw.mjs
	$(call normalize_line_endings,$(BUILD)/ffmpeg-eac3/output/raw.mjs,$(BUILD)/ffmpeg-eac3/output/ffmpeg-eac3.mjs)

build-ffmpeg-truehd: toolchain
	$(call build_ffmpeg,ffmpeg-truehd,$(FFMPEG_CONFIGURE_BASE),$(FFMPEG_TRUEHD_COMPONENTS),$(FFMPEG_AUDIO_CFLAGS),$(FFMPEG_AUDIO_LDFLAGS),$(FFMPEG_TRUEHD_DECODERS))
	$(EMCC) $(WASM)/ffmpeg-truehd/ffmpeg_truehd_bridge.c \
		$(BUILD)/ffmpeg-truehd/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/ffmpeg-truehd/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/ffmpeg-truehd/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,ffmpeg-truehd) \
		$(AUDIO_WORKER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(FFMPEG_TRUEHD_EXPORTS)) \
		-sEXPORTED_RUNTIME_METHODS=$(call comma_list,$(FFMPEG_TRUEHD_RUNTIME_METHODS)) \
		$(FFMPEG_AUDIO_LINK_TAIL) \
		-o $(BUILD)/ffmpeg-truehd/output/ffmpeg-truehd.mjs
	mv $(BUILD)/ffmpeg-truehd/output/ffmpeg-truehd.mjs $(BUILD)/ffmpeg-truehd/output/raw.mjs
	$(call normalize_line_endings,$(BUILD)/ffmpeg-truehd/output/raw.mjs,$(BUILD)/ffmpeg-truehd/output/ffmpeg-truehd.mjs)

build-ffmpeg-mpeg2-vc1: toolchain
	$(call build_ffmpeg,ffmpeg-mpeg2-vc1,$(FFMPEG_CONFIGURE_BASE),$(FFMPEG_MPEG2_VC1_COMPONENTS),$(FFMPEG_MPEG2_VC1_CFLAGS),$(FFMPEG_MPEG2_VC1_LDFLAGS),$(FFMPEG_MPEG2_VC1_DECODERS))
	$(EMCC) $(WASM)/ffmpeg-mpeg2-vc1/ffmpeg_mpeg2_vc1_bridge.c \
		$(BUILD)/ffmpeg-mpeg2-vc1/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/ffmpeg-mpeg2-vc1/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/ffmpeg-mpeg2-vc1/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,ffmpeg-mpeg2-vc1) \
		$(FFMPEG_MPEG2_VC1_LINK_FLAGS) -o $(BUILD)/ffmpeg-mpeg2-vc1/output/ffmpeg-mpeg2-vc1.js
	mv $(BUILD)/ffmpeg-mpeg2-vc1/output/ffmpeg-mpeg2-vc1.js $(BUILD)/ffmpeg-mpeg2-vc1/output/raw.js
	$(call normalize_line_endings,$(BUILD)/ffmpeg-mpeg2-vc1/output/raw.js,$(BUILD)/ffmpeg-mpeg2-vc1/output/ffmpeg-mpeg2-vc1.js)

build-ffmpeg-hevc: toolchain
	$(call build_ffmpeg,ffmpeg-hevc,$(FFMPEG_CONFIGURE_WASM_BASE),$(FFMPEG_HEVC_COMPONENTS),$(FFMPEG_HEVC_CFLAGS),$(FFMPEG_HEVC_LDFLAGS),$(FFMPEG_HEVC_DECODERS))
	$(call require_simd128,$(BUILD)/ffmpeg-hevc/source/FFmpeg-$(FFMPEG_COMMIT))
	$(EMCC) $(WASM)/ffmpeg-hevc/ffmpeg_hevc_bridge.c \
		$(BUILD)/ffmpeg-hevc/source/FFmpeg-$(FFMPEG_COMMIT)/libavcodec/libavcodec.a \
		$(BUILD)/ffmpeg-hevc/source/FFmpeg-$(FFMPEG_COMMIT)/libavutil/libavutil.a \
		-I$(BUILD)/ffmpeg-hevc/source/FFmpeg-$(FFMPEG_COMMIT) $(call prefix_maps,ffmpeg-hevc) \
		$(FFMPEG_HEVC_LINK_FLAGS) -o $(BUILD)/ffmpeg-hevc/output/ffmpeg-hevc.js
	mv $(BUILD)/ffmpeg-hevc/output/ffmpeg-hevc.js $(BUILD)/ffmpeg-hevc/output/raw.js
	$(call normalize_line_endings,$(BUILD)/ffmpeg-hevc/output/raw.js,$(BUILD)/ffmpeg-hevc/output/ffmpeg-hevc.js)

build-libdcadec-dts: toolchain
	$(call require_commit,$(DCADEC_SUBMODULE),$(DCADEC_COMMIT))
	rm -rf $(BUILD)/libdcadec-dts
	mkdir -p $(BUILD)/libdcadec-dts/source $(BUILD)/libdcadec-dts/output
	git -C $(DCADEC_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=dcadec-$(DCADEC_COMMIT)/ $(DCADEC_COMMIT) | tar -x -C $(BUILD)/libdcadec-dts/source
	$(EMCC) $(LIBDCADEC_CFLAGS) -ffile-prefix-map=$(ENGINE)=webgpu-player \
		-ffile-prefix-map=$(DCADEC_ROOT)=libdcadec-source -I$(DCADEC_ROOT)/libdcadec \
		$(WASM)/libdcadec-dts/libdcadec_dts_bridge.c $(addprefix $(DCADEC_ROOT)/libdcadec/,$(DCADEC_SOURCES)) \
		$(AUDIO_WORKER_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(LIBDCADEC_EXPORTS)) \
		-sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAP32 -Wl,--no-entry \
		-o $(BUILD)/libdcadec-dts/output/libdcadec-dts.mjs
	mv $(BUILD)/libdcadec-dts/output/libdcadec-dts.mjs $(BUILD)/libdcadec-dts/output/raw.mjs
	$(call normalize_line_endings,$(BUILD)/libdcadec-dts/output/raw.mjs,$(BUILD)/libdcadec-dts/output/libdcadec-dts.mjs)

# The crate's .cargo/config.toml supplies the memory link arguments; --config appends the remaps
build-libdovi:
	rm -rf $(BUILD)/libdovi/output
	mkdir -p $(BUILD)/libdovi/output
	cd $(WASM)/libdovi && CARGO_TARGET_DIR='$(LIBDOVI_TARGET)' $(CARGO) build --locked --release \
		--target wasm32-unknown-unknown \
		--config "target.wasm32-unknown-unknown.rustflags=[$(LIBDOVI_REMAPS)]"
	cp $(LIBDOVI_MODULE) $(BUILD)/libdovi/output/dovi-rpu-parser.wasm

# A .wasm output links without JavaScript glue; the module's one import is Math.log10
build-audio-output-stage: toolchain
	rm -rf $(BUILD)/audio-output-stage
	mkdir -p $(BUILD)/audio-output-stage/output
	$(EMCC) $(AUDIO_OUTPUT_STAGE_CFLAGS) -ffile-prefix-map=$(ENGINE)=webgpu-player \
		$(WASM)/audio-output-stage/audio_output_stage.c \
		$(AUDIO_OUTPUT_STAGE_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(AUDIO_OUTPUT_STAGE_EXPORTS)) \
		-o $(BUILD)/audio-output-stage/output/audio-output-stage.wasm
