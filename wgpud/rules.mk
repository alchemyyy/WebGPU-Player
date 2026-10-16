# Rules every decoder project's Makefile includes: the pinned toolchain, the pinned FFmpeg, dcadec, and libaom sources, and how to build a module from them.
# A project's Makefile defines `module`, which writes $(MODULE); scripts/decoder-packages.mjs runs it, then packs the package.
#
# Needs GNU Make, Git, a POSIX shell (Git Bash on Windows), and Node.js; C modules need Emscripten 4.0.13, Rust modules cargo,
# and libaom modules CMake, Perl, and GNU patch.
# Activate the pinned emsdk first, or pass EMSDK=/path/to/emsdk.

SHELL := /bin/sh
.SUFFIXES:
.DELETE_ON_ERROR:

# Pinned versions
EMSCRIPTEN_VERSION := 4.0.13
EMSCRIPTEN_REVISION := 2659582941bef14008476903f48941909db1b196
FFMPEG_COMMIT := a59498db085e3d635532397128550141ab87408a
DCADEC_COMMIT := b93deed1a231dd6dd7e39b9fe7d2abe05aa00158
# libaom v3.15.2
AOM_COMMIT := af3dc9aadc793c1b00edc003e3fc19a44fdeb574

empty :=
space := $(empty) $(empty)
comma := ,
# Emscripten settings take comma-separated lists
comma_list = $(subst $(space),$(comma),$(strip $(1)))

# Layout
# The engine's folders come from tools/constants.json, the one place that names them
DECODERS := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
ENGINE := $(patsubst %/,%,$(dir $(DECODERS)))
engine_layout = $(shell node -p "require('$(ENGINE)/tools/constants.json').$(1)")
PROJECT := $(notdir $(CURDIR))
PROJECT_DIRECTORY := $(CURDIR)
BUILD := $(ENGINE)/$(call engine_layout,decoderBuildDirectory)/$(PROJECT)
# The module a project builds, which the package build packs
MODULE := $(BUILD)/module.wasm
FFMPEG_SUBMODULE := $(ENGINE)/$(call engine_layout,ffmpegSourceDirectory)
DCADEC_SUBMODULE := $(ENGINE)/$(call engine_layout,dcadecSourceDirectory)
AOM_SUBMODULE := $(ENGINE)/$(call engine_layout,aomSourceDirectory)

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

# FFmpeg configure settings every FFmpeg module shares: FFmpeg's portable C, cross-compiled without assembly
FFMPEG_CONFIGURE_BASE := --target-os=none --arch=x86_32 --enable-cross-compile --disable-asm \
	--disable-x86asm --disable-inline-asm --disable-programs --disable-doc --disable-debug
FFMPEG_CONFIGURE_TOOLS = --cc=$(EMCC) --cxx=$(EMXX) --ar=$(EMAR) --ranlib=$(EMRANLIB) \
	--host-cc=$(HOST_CC) --nm=$(LLVM_NM)
# Only the decoders a module names, and the LGPL scope
FFMPEG_CONFIGURE_SCOPE := --disable-all --disable-everything --disable-autodetect \
	--disable-pthreads --disable-runtime-cpudetect --disable-gpl --disable-iconv \
	--disable-version3 --disable-nonfree --enable-avcodec

# An audio decoder module: standalone WebAssembly without JavaScript glue, which imports its memory and exports
# version 1 of the audio decoder interface that include/audio_decoder_interface.h declares.
# emcc's --no-entry makes it a reactor, whose exported _initialize runs the constructors that set up emmalloc's heap
AUDIO_MODULE_LINK_FLAGS := -sSTANDALONE_WASM -sIMPORTED_MEMORY -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 \
	-sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=268435456 -sMALLOC=emmalloc -sASSERTIONS=0 --no-entry
AUDIO_MODULE_EXPORTS := _audio_decoder_abi_version _audio_decoder_create _audio_decoder_destroy \
	_audio_decoder_reserve_input _audio_decoder_configure _audio_decoder_set_option _audio_decoder_send \
	_audio_decoder_receive _audio_decoder_frame_count _audio_decoder_sample_rate _audio_decoder_channel_count \
	_audio_decoder_channel_mask _audio_decoder_channel_pointer _audio_decoder_timestamp _audio_decoder_attribute \
	_audio_decoder_clear _audio_decoder_error_code _audio_decoder_error_value
AUDIO_MODULE_INCLUDES := -I$(DECODERS)/include
# FFmpeg audio modules optimize for speed with SIMD, as the DTS module does
FFMPEG_AUDIO_CFLAGS := -DNDEBUG -O3 -flto -msimd128
FFMPEG_AUDIO_LDFLAGS := -O3 -flto
FFMPEG_AUDIO_LINK_TAIL := -msimd128 -flto -O3 -Wl,--no-entry

# Machine paths map to fixed names, so a build embeds no checkout path
native_path = $(shell cygpath -m '$(1)' 2>/dev/null || printf '%s' '$(1)')
CARGO_HOME_DIRECTORY := $(or $(CARGO_HOME),$(HOME)/.cargo)

.PHONY: module clean toolchain

# wgpud/Makefile includes these rules for its shared jobs and cleans every project itself
ifndef DECODERS_ROOT_MAKEFILE
clean:
	rm -rf $(BUILD)
endif

toolchain:
	@$(EMCC) --version | grep -qF ') $(EMSCRIPTEN_VERSION) ($(EMSCRIPTEN_REVISION))' || { \
		echo "Emscripten $(EMSCRIPTEN_VERSION) ($(EMSCRIPTEN_REVISION)) is required;" \
			"activate the pinned emsdk or pass EMSDK=/path/to/emsdk" >&2; \
		exit 1; \
	}

# $(1): submodule directory, $(2): pinned commit
define require_commit
	@test "$$(git -C $(1) rev-parse HEAD)" = "$(2)" || { echo "$(1) is not at $(2); run make -C wgpud sources" >&2; exit 1; }
endef

# $(1): the FFmpeg tree being built
prefix_maps = -ffile-prefix-map=$(1)=ffmpeg-source -ffile-prefix-map=$(ENGINE)=webgpu-player

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

# The project's fresh copy of the pinned FFmpeg tree
FFMPEG_TREE = $(BUILD)/source/FFmpeg-$(FFMPEG_COMMIT)

# Extracts a fresh copy of the pinned FFmpeg tree, then configures and builds it with only the given decoders.
# Building outside a git checkout keeps the embedded version string and source paths stable
# $(1): configure components, $(2): compile flags, $(3): link flags, $(4): decoders
define build_ffmpeg
	$(call require_commit,$(FFMPEG_SUBMODULE),$(FFMPEG_COMMIT))
	rm -rf $(BUILD)
	mkdir -p $(BUILD)/source
	git -C $(FFMPEG_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=FFmpeg-$(FFMPEG_COMMIT)/ $(FFMPEG_COMMIT) | tar -x -C $(BUILD)/source
	cd $(FFMPEG_TREE) && ./configure $(FFMPEG_CONFIGURE_BASE) $(FFMPEG_CONFIGURE_SCOPE) $(1) \
		$(FFMPEG_CONFIGURE_TOOLS) '--extra-cflags=$(2) $(call prefix_maps,$(FFMPEG_TREE))' '--extra-ldflags=$(3)'
	$(call require_decoders,$(FFMPEG_TREE),$(4))
	MAKEFLAGS= MFLAGS= make -C $(FFMPEG_TREE) -j$(JOBS)
endef

# Links an FFmpeg audio module from its bridge and the FFmpeg libraries into $(MODULE)
# $(1): the bridge source in the project's folder
define link_ffmpeg_audio_module
	$(EMCC) $(PROJECT_DIRECTORY)/$(1) \
		$(FFMPEG_TREE)/libavcodec/libavcodec.a $(FFMPEG_TREE)/libavutil/libavutil.a \
		-I$(FFMPEG_TREE) $(AUDIO_MODULE_INCLUDES) $(call prefix_maps,$(FFMPEG_TREE)) \
		$(AUDIO_MODULE_LINK_FLAGS) -sEXPORTED_FUNCTIONS=$(call comma_list,$(AUDIO_MODULE_EXPORTS)) \
		$(FFMPEG_AUDIO_LINK_TAIL) -o $(MODULE)
endef

# Builds a Rust crate of the project for wasm32 and copies its cdylib to $(MODULE).
# Rust embeds source paths in panic locations, so the cargo home, crate, and target directories, and the standard library's sources, map to fixed names.
# With the rust-src component installed, rustc rewrites the standard library's /rustc/<commit> paths to that local copy, so it maps back.
# The crate's .cargo/config.toml supplies its memory link arguments; --config appends the remaps
# $(1): the crate's folder in the project, $(2): its library name
define build_rust_module
	mkdir -p $(BUILD)
	cd $(PROJECT_DIRECTORY)/$(1) && rust_source="$$(cygpath -m "$$(rustc --print sysroot)" 2>/dev/null || rustc --print sysroot)/lib/rustlib/src/rust" && \
		rustc_commit="$$(rustc -vV | sed -n 's/^commit-hash: //p')" && \
		CARGO_TARGET_DIR='$(BUILD)/target' $(CARGO) build --locked --release --target wasm32-unknown-unknown \
		--config "target.wasm32-unknown-unknown.rustflags=['--remap-path-prefix=$(call native_path,$(CARGO_HOME_DIRECTORY))=/cargo',\
'--remap-path-prefix=$(call native_path,$(PROJECT_DIRECTORY)/$(1))=/$(PROJECT)/$(1)',\
'--remap-path-prefix=$(call native_path,$(BUILD)/target)=/target',\
'--remap-path-prefix=$$rust_source=/rustc/$$rustc_commit/']"
	cp $(BUILD)/target/wasm32-unknown-unknown/release/$(2).wasm $(MODULE)
endef

# libaom's decoder for wasm32: the generic C target, single-threaded, without the encoder, runtime CPU detection, or applications.
# libaom reports errors with longjmp, which -sSUPPORT_LONGJMP=wasm compiles to WebAssembly exception handling, so a module needs no JavaScript glue
CMAKE ?= cmake
AOM_CMAKE_OPTIONS := -DCMAKE_BUILD_TYPE=Release -DAOM_TARGET_CPU=generic -DCONFIG_AV1_ENCODER=0 -DCONFIG_MULTITHREAD=0 \
	-DCONFIG_RUNTIME_CPU_DETECT=0 -DCONFIG_WEBM_IO=0 -DCONFIG_LIBYUV=0 -DENABLE_DOCS=0 -DENABLE_EXAMPLES=0 \
	-DENABLE_TESTS=0 -DENABLE_TOOLS=0
AOM_LONGJMP_FLAGS := -sSUPPORT_LONGJMP=wasm

# The project's fresh copy of the pinned libaom tree, its CMake build tree, and the library it builds
AOM_TREE = $(BUILD)/source/aom-$(AOM_COMMIT)
AOM_BUILD_TREE = $(BUILD)/aom
AOM_LIBRARY = $(AOM_BUILD_TREE)/libaom.a
# CMake hands emcc native paths, make POSIX ones; both map to fixed names
aom_prefix_maps = -ffile-prefix-map=$(call native_path,$(AOM_TREE))=aom-source -ffile-prefix-map=$(AOM_TREE)=aom-source \
	-ffile-prefix-map=$(call native_path,$(AOM_BUILD_TREE))=aom-build -ffile-prefix-map=$(AOM_BUILD_TREE)=aom-build \
	-ffile-prefix-map=$(call native_path,$(ENGINE))=webgpu-player -ffile-prefix-map=$(ENGINE)=webgpu-player

# Extracts a fresh copy of the pinned libaom tree, applies the project's patches in order, and builds libaom.a with CMake.
# Building outside a git checkout keeps libaom's version string stable, since its CMake then reads the version from CHANGELOG
# $(1): the patch files, $(2): compile flags
define build_aom
	$(call require_commit,$(AOM_SUBMODULE),$(AOM_COMMIT))
	rm -rf $(BUILD)
	mkdir -p $(BUILD)/source
	git -C $(AOM_SUBMODULE) -c core.autocrlf=false archive --format=tar \
		--prefix=aom-$(AOM_COMMIT)/ $(AOM_COMMIT) | tar -x -C $(BUILD)/source
	for patch in $(1); do \
		patch -d $(AOM_TREE) -p1 --forward --fuzz=0 --no-backup-if-mismatch --quiet < "$$patch" || exit 1; \
	done
	$(CMAKE) -S $(AOM_TREE) -B $(AOM_BUILD_TREE) -G "Unix Makefiles" \
		-DCMAKE_TOOLCHAIN_FILE=$(EMSCRIPTEN_DIRECTORY)/cmake/Modules/Platform/Emscripten.cmake \
		$(AOM_CMAKE_OPTIONS) '-DCMAKE_C_FLAGS=$(2) $(AOM_LONGJMP_FLAGS) $(aom_prefix_maps)'
	MAKEFLAGS= MFLAGS= $(CMAKE) --build $(AOM_BUILD_TREE) --target aom -j $(JOBS)
endef
