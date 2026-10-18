# Builds the engine's own WebAssembly modules: the Dolby Vision RPU parser and the decoded audio output stage.
# Decoders are not the engine's; each is a project under wgpud/, built into a package by scripts/decoder-packages.mjs.
#
# Needs GNU Make, a POSIX shell (Git Bash on Windows), Node.js, Emscripten 4.0.13, and cargo.
# Emscripten comes from the emsdk that EMSDK names, as emsdk_env sets it; without EMSDK, from the engine's own emsdk,
# which `make -C wasm emsdk` installs, and without that, from emcc on PATH.
#
#   make -C wasm all                Build every module into bin/wasm, which is ignored like the rest of bin
#   make -C wasm check              Rebuild every module and compare it with the existing bin/wasm
#   make -C wasm <kit>              Rebuild one of: $(KITS)
#   make -C wasm emsdk              Install the pinned Emscripten into the engine's own emsdk in bin/emsdk

SHELL := /bin/sh
.SUFFIXES:
.DELETE_ON_ERROR:

# Pinned versions
EMSCRIPTEN_VERSION := 4.0.13
EMSCRIPTEN_REVISION := 2659582941bef14008476903f48941909db1b196

KITS := libdovi audio-output-stage

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

# Toolchain
# Without EMSDK, the engine's own emsdk once its activation has written .emscripten, and otherwise emcc from PATH
ENGINE_EMSDK := $(ENGINE)/$(call engine_layout,emsdkDirectory)
EMSDK_REPOSITORY := https://github.com/emscripten-core/emsdk.git
ifndef EMSDK
ifneq ($(wildcard $(ENGINE_EMSDK)/.emscripten),)
export EMSDK := $(ENGINE_EMSDK)
endif
endif
ifdef EMSDK
EMSCRIPTEN_DIRECTORY := $(EMSDK)/upstream/emscripten
ifneq ($(wildcard $(EMSDK)/.emscripten),)
export EM_CONFIG := $(EMSDK)/.emscripten
endif
else
EMSCRIPTEN_DIRECTORY := $(patsubst %/,%,$(dir $(shell command -v emcc)))
endif
EMCC := $(EMSCRIPTEN_DIRECTORY)/emcc
CARGO ?= cargo

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
OUTPUTS_libdovi := dovi-rpu-parser.wasm
OUTPUTS_audio-output-stage := audio-output-stage.wasm

.PHONY: all check clean toolchain emsdk $(KITS) $(KITS:%=build-%)

all: $(KITS)

# Copies freshly built outputs into bin/wasm
$(KITS): %: build-%
	mkdir -p $(DIST)/$*
	for output in $(OUTPUTS_$*); do cp $(BUILD)/$*/output/$$output $(DIST)/$*/$$output || exit 1; done

check: $(KITS:%=build-%)
	@status=0; \
	for kit in $(KITS); do \
		case $$kit in \
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
			"run make -C wasm emsdk, or pass EMSDK=/path/to/emsdk" >&2; \
		exit 1; \
	}

# The engine's own emsdk: a clone of emsdk at the release tag of the pinned version, whose scripts know that version.
# A clone at another tag is replaced, so the folder only ever holds the pinned version.
# emsdk runs on python3 from PATH until it has installed its own Python
emsdk:
	@if [ ! -e '$(ENGINE_EMSDK)/.git' ] || \
		[ "$$(git -C '$(ENGINE_EMSDK)' describe --tags --exact-match HEAD 2>/dev/null)" != '$(EMSCRIPTEN_VERSION)' ]; then \
		echo 'Cloning emsdk $(EMSCRIPTEN_VERSION) into $(ENGINE_EMSDK)'; \
		rm -rf '$(ENGINE_EMSDK)' && \
		git -c advice.detachedHead=false clone --quiet --depth 1 --branch $(EMSCRIPTEN_VERSION) \
			$(EMSDK_REPOSITORY) '$(ENGINE_EMSDK)'; \
	fi
	cd '$(ENGINE_EMSDK)' && ./emsdk install $(EMSCRIPTEN_VERSION) && ./emsdk activate $(EMSCRIPTEN_VERSION) >/dev/null

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
