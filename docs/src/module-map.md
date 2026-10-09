# Module map

One entry per file or family.
`[main]`, `[worker]`, and `[worklet]` mark the thread where it is not obvious.
Each source file's tests are at the same relative path under `test/`, and integration suites that span several modules sit beside their main module.

## src/

- `EngineAssets.ts`: the typed manifest of every runtime asset path, and URL resolution against the host's asset base or, inside a worker, the worker's own URL.
- `EngineConfiguration.ts`: the feature flags a host can set.
- `MediaTime.ts`: branded integer microseconds and conversions to Jellyfin ticks.
- `TimeMath.ts`: safe-integer microsecond math.
- `style.scss`: presenter and overlay styles, imported by the host.

## presentation/

- `WebGPUPresenter.ts`: the GPU device and canvas; rVFC and pushed-frame submission; installing the color pipeline; HDR and Dolby Vision authorization; device-loss recovery; the latched fallback.
- `RawYUVGPURenderer.ts`: uploads raw YUV planes, and a Dolby Vision EL, into integer textures and draws them.
  Authorization shares it.
- `PresentationInput.ts`: MediaStream metadata to color metadata; Dolby Vision descriptors with their RPU route; declared and exact native base metadata; the presented video ordinal; the known-SDR gate.
- `PresentationGeometry.ts`: pure object-fit and object-position math to viewport and texture transforms.
- `RenderSettings.ts`: versioned (v7) HDR-to-SDR settings and their 144-byte uniform, HDR10+ fields included.
- `identity.wgsl.ts`: the passthrough `texture_external` shader with crop.

## color/

- `ColorMetadata.ts`: the input color schema, validation, and SDR, PQ, and HLG factories.
- `ColorPipeline.ts`: the CPU reference of range, matrix, transfer, gamut, tone mapping, and display controls, and the luminance, YUV matrix, gamut, and IPT tables for BT.709, BT.2020, and BT.601 that the shaders share.
- `ColorPipelineShader.ts`: WGSL generators for raw YUV, external HDR code recovery, and external and raw Dolby Vision (FEL included), plus the shared `processColor`.
- `DolbyVisionColorTransform.ts`: RPU reshaping (polynomial and MMR), the FEL NLQ residual, and reconstruction to BT.2020 PQ, as a CPU reference and as WGSL.

## capability/

- `CustomContainerCodecSupport.ts`: the single container and codec matrix.
- `CustomPlaybackEligibility.ts`: per-session route choice, the player-selection prefilter, and `hasEligibleCustomVideoRoute` for item-scoped negotiation.
- `CustomDecodeCapabilities.ts`: the cached orchestrator of every capability probe, and the codec lists.
- `CustomPlaybackRuntime.ts`: runtime feature detection with failure reasons.
- `H264ProfileCapabilities.ts`: the per-profile H.264 decoded-output probe and Jellyfin's profile names.
- `HEVCRangeExtensionCapabilities.ts`: the nine range-extension variant definitions and the stream metadata resolver.
- `NativeMediaAudioCapabilities.ts`: the MSE AC-3/E-AC-3 route probe and its selection.

### capability/exact/

Qualification of the bundled decoders.
Their vectors are in `capability/vectors/` and `bin/codec_vector_assets/`, which holds the generated DTS and TrueHD modules and the JPEG 2000 and MPEG-2 streams.

- `HEVCExactCapability{Probe,Probe.worker,Protocol,WorkerRuntime}.ts`: bundled HEVC (8-frame fingerprints).
- `DTSExactCapability{Probe,Probe.worker,Protocol,Runner}.ts`: libdcadec (7 vectors, real-time factor of at least 2).
- `TrueHDExactCapability{Probe,Probe.worker,Protocol,Runner}.ts`: TrueHD and MLP (4 vectors, major-sync recovery).
- `JPEG2000ExactCapability{Probe,Probe.worker,Protocol}.ts`: OpenJPEG (a 960x540 RGBA fingerprint).
- `MPEG2VC1ExactCapability{Probe,Probe.worker,Protocol}.ts`: MPEG-2 and VC-1 (12 frames, an I420 fingerprint).

### capability/vectors/

Hand-made vectors: known inputs with known answers.
Qualification vectors run in the browser before a route is advertised; test vectors feed only tests and generators.
The TypeScript modules are embedded in the bundle; the binary files are served or read as files.

- `HEVCExactCapabilityVectors.ts`: HEVC access units and 8-frame fingerprints, which also feed the native HEVC probes.
- `NativeMediaAudioCapabilityVectors.ts`: fMP4 AC-3/E-AC-3 vectors.
- `NativeAudioCapabilityVectors.ts`: stereo silence packets per WebCodecs codec.
- `NativeSurroundAudioCapabilityVectors.ts`: 5.1 silence packets.
- `NativeVideoCapabilityVectors.ts`: 64x64 VP8, VP9, and AV1 keyframes.
- `NativeUltraHDVideoCapabilityVectors.ts`: 4K 8-bit HEVC, VP9, and AV1 keyframes.
- `RawHDRCapabilityVectors.ts`: 4K 10-bit VP9 and AV1 keyframes with plane fingerprints.
- `ExternalHDRAuthorizationVector.ts`: the neutralized Main 10 access unit and its expected samples, for external HDR authorization.
- `DolbyVisionAuthorizationVector.ts`: synthetic RPU snapshots for Dolby Vision authorization.
- `HDR10PlusVectors.ts`: deterministic HDR10+ HEVC access units for the dynamic HDR tests.
- `qualification/`: streams served at runtime that no script generates: the HEVC Main 10 4K stream (`hevc/`) and the VC-1 stream (`vc1/`).
- `test/`: inputs only tests and generators read: DTS samples, a TrueHD Matroska remux, and Dolby Vision RPU payloads.

## pipeline/

- `CustomPlaybackController.ts` [main]: lifecycle, generations, the clock, the startup (20 s without progress, 60 s ceiling), stall (10 s), and lag (2 s) policy, the live audio output layout switch, the end-of-stream and ended-track drains, and the fallback disposition.
- `CustomPlaybackControllerTypes.ts`: states, events, fallback reasons, and dispositions.
- `CustomDecodeSession.ts` [main]: one worker per generation, the frame queue, credits, raw buffer recycling, readiness, audio-only resync epochs, the decoded source format, and an ended audio track completing a start, a resync, or a native-media stream.
- `CustomDecode.worker.ts` [worker]: demux, decoder dispatch, raw copy, Dolby Vision and HDR metadata, the PCM pipeline as restartable audio attempts, fMP4 remux, and credit waits.
- `DecodeWorkerProtocol.ts`: messages, validators, credit constants (4, 2, 8), and the backend and output literals.
- `CustomDecodeTrackSelection.ts`, `ConcurrentDecodeStreams.ts`: track lookup by ordinal within one media type, and concurrent decode streams that cancel each other on the first failure and all drain before the worker reports that the generation stopped.
- `MediaClock.ts` [main]: the generation-tagged clock; `synchronize` re-anchors it.
- `MediaFetchPolicy.ts`: retries only transport errors and 408, 429, and 5xx.
- `HTTPRangeResponse.ts`: validates Range responses, Jellyfin's cross-origin 206 included.

## video/

All worker code unless marked.

- `DecodedVideoGeometry.ts` [main and worker]: the first-decoded-size lock.
- `RawVideoFrameCopy.ts`: copies a `VideoFrame`, or a software decoder's sample of CPU planes without one, into aligned plane buffers (NV12, and I420 to I444P12; base and enhancement layers), up to 128 MiB per transfer.
- `RawFrameBufferPool.ts`: reusable raw buffers, bounded by the raw credits (2).
- `MatroskaVFWVideoConfiguration.ts`: extracts the VC-1 `WVC1` extradata.

### video/decoders/

- `OwnedNativeHEVCVideoDecoder.ts`: the engine's own WebCodecs HEVC decoder: NAL order fix, leading RASL drop, optional SPS neutralization.
- `HEVCSoftwareVideoDecoder.ts`: the `@hevcjs/core` decoder (I420 and I420P10) with a shutdown registry.
- `HEVCDecoderBackend.ts`: the low-level `@hevcjs/core` WASM binding.
- `JPEG2000SoftwareVideoDecoder.ts`: OpenJPEG WASM to an RGBA `VideoFrame`.
- `MPEG2VC1SoftwareVideoDecoder.ts`: FFmpeg WASM MPEG-2 and VC-1 to I420.

### video/dolby-vision/

- `DolbyVisionProfiles.ts` [main and worker]: the dual-layer profile set (P4, P7).
- `DolbyVisionHEVCSplitter.ts`: NAL parsing; the BL, RPU (62), and EL (63) split; RASL handling; in-band SPS neutralization; drops NAL units of layers above 0, the MV-HEVC second view.
- `DolbyVisionEncodedMetadata.ts`, `DolbyVisionEncodedMetadataProtocol.ts`: per-packet RPU parsing, PTS-keyed metadata, and the transferable schema.
- `DolbyVisionEncodedPacketPairer.ts`, `DolbyVisionFramePairQueue.ts`: BL and EL packet and frame pairing (1 us tolerance).
- `DolbyVisionRPUParser.ts`, `DolbyVisionRPUParserSession.ts`, `DolbyVisionRPUDataLayout.ts`: the libdovi WASM parser, its per-run session, and the packed 3232-byte snapshot layout.
- `ISOBaseMediaDolbyVisionSampleEntry.ts`: gives Mediabunny's unmapped `dvh1`, `dvhe`, `dva1`, `dvav`, and `dav1` tracks their wrapped codec.
- `MatroskaDolbyVisionHVCE.ts`, `ISOBaseMediaDolbyVisionConfiguration.ts`, `MPEGTransportStreamDolbyVisionConfiguration.ts`: find a P4 or P7 EL configuration in Matroska; in MP4, as a separate EL track or as `hvcE` beside the BL `hvcC` of one interleaved track; or in MPEG-TS and M2TS (any descriptor version).
- `DolbyVisionGeometry.ts` [main and worker]: the P4 and P7 EL coded size (half the BL when the BL is wider than 1920).

### video/hdr/

- `HDR10PlusMetadata.ts`, `HEVCDynamicHDRMetadataQueue.ts`: ST 2094-40 parsing and PTS matching to decoded frames.
- `HEVCStaticHDRMetadata.ts`: the MDCV and CLL startup scan.
- `StaticHDRMetadata.ts` [main and worker]: the MDCV and CLL luminance schema, the scan-result validators shared across the worker boundary, and the static tone mapping source peak.

### video/hevc/

- `HEVCSEI.ts`, `HEVCSPSParser.ts`: SEI extraction and the alternative transfer characteristics value; SPS parsing, the VUI color mapping to WebCodecs names, and the VUI rewrite with its native HDR route check.
- `NativeHDRHEVCColorNeutralizer.ts`: rewrites the `hvcC` SPS and the decoder colorSpace to limited BT.709 for the native external HDR route.

## audio/

- `CustomAudioCodec.ts`: the WebCodecs, Mediabunny PCM, and bundled codec lists.
- `CustomAudioSampleRate.ts`: the 3000 to 192000 Hz integer contract.
- `CustomCompressedAudioRoute.ts`: the E-AC-3, DTS, and TrueHD route tables and predicates, with their Jellyfin ChannelLayout requirements.
- `CustomAudioOutputPolicy.ts`: input channels per codec, the 3.0 layout requirement for decoders without a speaker mask, and the 48 kHz 2, 6, and 8-channel output contract with its 2 s ring.
- `CustomAudioTrackMetadata.ts` [worker]: the Matroska and ISO BMFF DTS and TrueHD tracks the bundled decoders own, declared-rate recovery for their sample entries, and the decoded audio timestamp tolerance.
- `AudioStartPacket.ts` [worker]: the packet an audio attempt starts from, without Mediabunny's proof scans when the track starts late.
- `NativeMultichannelAudioOutput.ts`: `selectCustomAudioOutputChannelCount`, the output layout rule (three channels and 5.1 to 5.1, 6.1 and 7.1 to 7.1 or 5.1, otherwise stereo).
- `AudioNormalization.ts`: TrackGain and AlbumGain decibels to linear gain.
- `AudioSampleWindow.ts`: PCM windowing at a seek.

### audio/decoders/

- `AC3SoftwareAudioDecoder.ts`, `EAC3SoftwareAudioDecoder.ts`, `DTSSoftwareAudioDecoder.ts`, `TrueHDSoftwareAudioDecoder.ts` [worker]: the `@mediabunny/ac3` registration and the lazily loaded WASM decoders.
  E-AC-3, DTS, and TrueHD report their channel layout, and the FFmpeg wrappers stamp later frames of one packet after its earlier ones.
- `DTSSeekRecovery.ts`: the 1 s DTS preroll and a bounded tolerance for XLL sync errors.
- `CustomAudioDecoderRegistration.ts`, `MediabunnyPCMBuiltinDecoderAvailability.ts`: decoder registration and G.711 availability.

### audio/processing/

- `StreamingAudioResampler.ts`, `StreamingAudioLookaheadLimiter.ts`, `StreamingAudioOutputPipeline.ts`, `StreamingAudioDownmixSettings.ts` [worker]: the 48 kHz resampler with input timestamp reconciliation within 2 s (larger deviations throw, and a listener sees every correction) and a continuation across source rate changes, the 100 ms lookahead limiter, the pipeline that rebinds its source rate and enables the limiter late, and generation-scoped live gains that follow the decoded rate.
- `DecodedAudioOutputStage.ts` [worker]: binds one audio attempt's output stage to the decoded rate and layout, checks them against the decoded PCM routes, and reports each bound format.
- `CustomAudioDownmix.ts`, `CustomAudioDownmixAlgorithm.ts`, `CustomAudioChannelLayout.ts`, `CustomWaveChannelLayout.ts`: downmix matrices per algorithm (three-channel beds have their own), algorithm IDs, layout tables with by-name mapping to 5.1 and 7.1 outputs, and WAVE mask mapping.

### audio/output/

- `AudioWorkletController.ts` [main], `AudioWorkletProcessorSource.ts` [worklet], `AudioWorkletProtocol.ts`: the worklet node, the inline processor (which renders silence from a flush up to the first chunk), and their messages.
- `AudioOutputDevicePresence.ts` [main]: whether `enumerateDevices()` lists any audio output.
- `BrowserAudioContextPool.ts`, `BrowserAudioContextPrewarm.ts`, `BrowserAudioWorkletPool.ts`, `BrowserAudioOperation.ts` [main]: the shared 48 kHz context (never pooled when created without an output device), the prewarm lease, the leased worklet node, and timeouts.
- `BrowserCustomAudioOutput.ts` [main]: the production output: context, sink lease, worklet lease, the physical output time correction, in-place layout reconfiguration, and `sinkchange` reporting.
- `CustomDecodeAudioBridge.ts` [main]: worker PCM to the worklet, with continuity checks and credits.
- `WebGPUAudioOutputManager.ts`: the page-wide sink router (`setSinkId`), with its fallback chain, `devicechange` handling, output recovery poll and sink rebuild, picker, and UI snapshot.

### audio/native/

AC-3 and E-AC-3 through a hidden `<audio>` and MSE.

- `CustomDecodeNativeAudioBridge.ts`, `OwnedNativeMediaAudioBackend.ts` [main]: the bridge and the owned media element, which parks at a late first fragment, delays `play()` by the gap, and advances by a late timer's overshoot.
- `NativeMediaAudioFMP4Remuxer.ts` [worker]: the fMP4 remux of the selected audio track.
- `NativeMediaAudioLimits.ts`: the segment caps (2 s, 2 MiB) and the pending-append caps (16 segments, 4 MiB).

## validation/

The authorization vectors are in `capability/vectors/`.

- `RawHDRPresentationAuthorization.ts`: raw route keys, readback through the production raw shader, and the per-device registry.
- `ExternalHDRPresentationAuthorization.ts`: external PQ and HLG route keys, checked with the neutralized Main 10 vector.
- `DolbyVisionPresentationAuthorization.ts`, `ExternalDolbyVisionPresentationAuthorization.ts`: raw Dolby Vision keys (single-layer per raw format, the P4 and P7 bases, the P4 and P7 FEL) and the external P5 key, checked with synthetic RPU vectors.
- `GPUAuthorizationDeadline.ts`: the shared 5 s timeout, cancelled on device loss.
- `GPUCanvasReadback.ts`: bounded GPU canvas pixel readback (5 s).

## Outside src/

- `test/helpers/enginePaths.ts`: the engine root and the `node_modules` location, independent of the test runner's working directory, and the folders from `tools/constants.json`.
- `wasm/`: the decoder sources and build.
  See [WebAssembly decoders](decoders.md).
- `vendor/`: the FFmpeg and dcadec submodules (`update = none`), which `make -C wasm sources` fetches.
- `scripts/build.mjs`: assembles `bin/libraries/`, including the esbuild worker bundles.
  `scripts/library-assets.mjs` maps each served file to its source.
- `scripts/codec_vector_assets/`: the Python codec vector generators, their tests in `test/`, and the local playback media generators.
  See [Codec vectors](codec-vectors.md).
- `tools/`: browser probes, the DTS downmix report, and `constants.json`.
  See [Tools](tools.md).
- `bin/wasm/`: the decoder builds from `make -C wasm`, ignored:
  - `ffmpeg-eac3/`, `ffmpeg-truehd/`, `libdcadec-dts/` [worker]: Emscripten single-file ES modules (`.mjs` with embedded WASM), imported as `#wasm/<kit>/<kit>.mjs` through the `imports` map in `package.json`.
    Their hand-written declarations are `wasm/<kit>/<kit>.d.mts`, which the map's `types` condition resolves.
  - `ffmpeg-mpeg2-vc1/` and `libdovi/`: served from `libraries/`.
- `bin/codec_vector_assets/`: the generated codec vectors, the one committed folder in `bin/`:
  - `dts/DTSExactCapabilityVectors.ts`, `truehd/TrueHDExactCapabilityVectors.ts`: access units and expected outputs, which `capability/exact/` imports as `#codec_vector_assets/*`.
    `truehd/` also holds the synthetic TrueHD and MLP streams the module embeds.
  - `hevc-range-extension/`, `jpeg2000/`, `mpeg2/`: qualification streams served at runtime from `bin/libraries/`.
  - `downmix-reference/`: the deterministic 7.1-to-stereo reference.

## Host: the Jellyfin add-on

Paths are relative to the plugin repository root.
See [The Jellyfin host](jellyfin-host.md).

- `jellyfin-webgpu-client/src/index.ts`: the add-on entry.
  It configures the engine's assets and feature flags, binds the host bridge, installs the host-compatible mode, and returns the player.
- `jellyfin-webgpu-client/src/WebGPUPlayer.ts`: the Jellyfin-facing player: profile augmentation, the stream-copy veto, eligibility, the rAF loop, fallback, renegotiation, and generations.
- `jellyfin-webgpu-client/src/HostCompatibleWebGPUPlayer.ts`: adapts `WebGPUPlayer` to the stock PlaybackManager: purpose-less bitrate requests, the player preference, marked profiles, and superseded starts that never settle.
- `jellyfin-webgpu-client/src/HTMLPlayerDelegate.ts`: owns one HTML player and forwards its events for the current generation only.
- `jellyfin-webgpu-client/src/backend/`: the add-on's own copy of the HTML video player and its media helper, usable as an owned backend.
- `jellyfin-webgpu-client/src/custom/CustomDeviceProfile.ts`: `augmentDeviceProfileForCustomDecode` and `createBitrateIndependentDeviceProfile`.
- `jellyfin-webgpu-client/src/custom/NativeDirectPlayCompatibility.ts`: checks the stock profile against the chosen source, the proof for same-session fallback.
- `jellyfin-webgpu-client/src/compat/`: stand-ins for the PlaybackManager seams stock Jellyfin Web lacks: the PlaybackInfo interceptor and its policies, PlaybackManager hooks, and the settings entry points.
- `jellyfin-webgpu-client/src/host/`, `jellyfin-webgpu-client/src/shims/`: host singletons bound late from the plugin bag, and replacements for host modules the add-on cannot import.
- `jellyfin-webgpu-client/src/WebGPUUserSettings.ts`, `WebGPUPlaybackPreferences.ts`, `PreferredVideoPlayer.ts`: local per-user settings (v2), the custom decode and HDR tone mapping preferences, and the Auto, WebGPU, or HTML player preference.
- `jellyfin-webgpu-client/src/ui/WebGPUPlaybackSettingsDialog.ts`: the in-player settings panel, with live render and downmix updates and restart-required options marked.
