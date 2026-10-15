# The jobs the decoder projects share. Each project builds its own module with its own Makefile, which includes rules.mk;
# scripts/decoder-packages.mjs runs those and packs every project into bin/decoders/.
#
#   make -C decoders sources            Fetch the pinned FFmpeg, dcadec, and libaom submodules
#   make -C decoders source-archives    Write the corresponding-source tarballs of the LGPL modules for a release
#   make -C decoders clean              Remove every project's build tree

DECODERS_ROOT_MAKEFILE := 1
include rules.mk

ARCHIVES := $(ENGINE)/$(call engine_layout,decoderBuildDirectory)/source-archives
FFMPEG_SOURCE := $(call engine_layout,ffmpegSourceDirectory)
DCADEC_SOURCE := $(call engine_layout,dcadecSourceDirectory)
AOM_SOURCE := $(call engine_layout,aomSourceDirectory)

.PHONY: sources source-archives

clean:
	rm -rf $(ENGINE)/$(call engine_layout,decoderBuildDirectory)

sources:
	$(call fetch_source,$(FFMPEG_SOURCE))
	$(call fetch_source,$(DCADEC_SOURCE))
	$(call fetch_source,$(AOM_SOURCE))
	$(call require_commit,$(FFMPEG_SUBMODULE),$(FFMPEG_COMMIT))
	$(call require_commit,$(DCADEC_SUBMODULE),$(DCADEC_COMMIT))
	$(call require_commit,$(AOM_SUBMODULE),$(AOM_COMMIT))

# The release attaches these as the corresponding source of the LGPL modules: the exact FFmpeg and dcadec trees, and the decoder projects
source-archives: sources
	mkdir -p $(ARCHIVES)
	git -C $(FFMPEG_SUBMODULE) -c core.autocrlf=false archive --format=tar.gz \
		--prefix=ffmpeg-$(FFMPEG_COMMIT)/ -o $(ARCHIVES)/ffmpeg-$(FFMPEG_COMMIT).tar.gz $(FFMPEG_COMMIT)
	git -C $(DCADEC_SUBMODULE) -c core.autocrlf=false archive --format=tar.gz \
		--prefix=dcadec-$(DCADEC_COMMIT)/ -o $(ARCHIVES)/dcadec-$(DCADEC_COMMIT).tar.gz $(DCADEC_COMMIT)
	revision=$$(git -C $(ENGINE) rev-parse --short=12 HEAD) && \
		git -C $(ENGINE) -c core.autocrlf=false archive --format=tar.gz \
			--prefix=webgpu-player-decoders-$$revision/ \
			-o $(ARCHIVES)/webgpu-player-decoders-$$revision.tar.gz HEAD $(call engine_layout,decodersDirectory)
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
