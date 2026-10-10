# Module map

One entry per file or family.
`[main]`, `[worker]`, and `[worklet]` mark the thread where it is not obvious.
Each source file's tests are at the same relative path under `test/`, and integration suites that span several modules sit beside their main module.

## src/

- `EngineAssets.ts`: the typed manifest of every runtime asset path, the audio decoder binaries that probe and playback workers share, and URL resolution against the host's asset base or, inside a worker, the worker's own URL.
- `DecoderWASMSource.ts`: a decoder's WebAssembly as its served URL or as bytes a caller already fetched, with their validation and transfer across a worker boundary, their Emscripten `locateFile` and `wasmBinary` options, and the loader that instantiates a kit's module once per worker on first use.
- `EngineConfiguration.ts`: the feature flags a host can set.
- `MediaTime.ts`: branded integer microseconds and conversions to Jellyfin ticks.
- `TimeMath.ts`: safe-integer microsecond math.
- `TimingTrace.ts`: the opt-in playback timing trace: the page's ring buffer, the decode worker's batches stamped on the shared epoch clock, long tasks, and the JSON export; every hook is one null check until a host starts a trace.
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
- `DolbyVisionColorTransform.ts`: RPU reshaping (polynomial and MMR, chosen per segment), the FEL NLQ residual, and reconstruction to BT.2020 PQ, as a CPU reference and as WGSL.

## capability/

- `CustomContainerCodecSupport.ts`: the single container and codec matrix.
- `CustomPlaybackEligibility.ts`: per-session route choice, the player-selection prefilter, and `hasEligibleCustomVideoRoute` for item-scoped negotiation.
- `CustomDecodeCapabilities.ts`: the cached orchestrator of every capability probe, the per-item probe selection, and the codec lists.
- `CapabilityAssetLoading.ts`: the bounded, retried download of a probe's vectors and decoder binaries, and the HTTP cache warm-up of its worker script and glue.
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
  Both requests carry the decoder binary, as the URL the playback worker also loads or as bytes the page fetched.
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
- `Base64.ts`: the base64 decoder the inline vectors share.
- `qualification/`: streams served at runtime that no script generates: the HEVC Main 10 4K stream (`hevc/`) and the VC-1 stream (`vc1/`).
- `test/`: inputs only tests and generators read: DTS samples, a TrueHD Matroska remux, Dolby Vision RPU payloads, and an hdr10plus_tool HDR10+ stream.

## pipeline/

- `CustomPlaybackController.ts` [main]: lifecycle, generations, the clock, the startup (20 s without progress, 60 s ceiling), stall (10 s), and lag (2 s) policy, the live audio output layout switch, the end-of-stream and ended-track drains, the presentation timing counters, and the fallback disposition.
- `CustomPlaybackControllerTypes.ts`: states, events, fallback reasons, and dispositions.
- `CustomDecodeSession.ts` [main]: one worker per generation, the frame queue, credits, raw buffer recycling, readiness, audio-only resync epochs, the decoded source format, and an ended audio track completing a start, a resync, or a native-media stream.
- `CustomDecode.worker.ts` [worker]: demux, decoder dispatch, raw copy, Dolby Vision and HDR metadata, the PCM pipeline as restartable audio attempts, fMP4 remux, and credit waits.
- `CustomDecodeInputFormats.ts` [worker]: Mediabunny's input formats with Matroska content decoding scoped to frames, so header-stripped laced audio demuxes intact.
- `HandledDecodeFailures.ts` [worker]: marks the failures the worker catches, so the duplicate rejection Mediabunny leaves behind is not reported as unhandled.
- `DecodeWorkerProtocol.ts`: messages, validators, credit constants (4, 2, 8), and the backend and output literals.
- `CustomDecodeTrackSelection.ts`, `ConcurrentDecodeStreams.ts`: track lookup by ordinal within one media type, and concurrent decode streams that cancel each other on the first failure and all drain before the worker reports that the generation stopped.
- `MediaClock.ts` [main]: the generation-tagged clock; `synchronize` re-anchors it.
- `MediaFetchPolicy.ts`: retries only transport errors and 408, 429, and 5xx.
- `HTTPRangeResponse.ts`: validates Range responses, Jellyfin's cross-origin 206 included.

## video/

All worker code unless marked.

- `DecodedVideoGeometry.ts` [main and worker]: the first-decoded-size lock.
- `RawVideoFrameCopy.ts`: copies a `VideoFrame`, or a software decoder's sample of CPU planes without one, into aligned plane buffers (NV12, and I420 to I444P12), up to 128 MiB per transfer.
  A Dolby Vision pair is a BL in any format from I420 to I444P12 and an I420P10 EL, in one compound buffer.
- `RawFrameBufferPool.ts`: reusable raw buffers, bounded by the raw credits (2).
- `MatroskaVFWVideoConfiguration.ts`: extracts the VC-1 `WVC1` extradata.
- `MatroskaBlockAdditions.ts`: wraps Mediabunny's Matroska and WebM formats so their demuxers keep every BlockAdditional but alpha, and reads a packet's additions, such as VP9 HDR10+.

### video/av1/

- `AV1OBUParser.ts`: the OBU walk of one temporal unit (headers, extension headers, leb128 sizes, a last OBU without a size field), frame header detection, metadata types and ITU-T T.35 messages, and the removal of a payload's trailing bits.
- `AV1SequenceHeaderParser.ts`, `AV1CodecParameterString.ts`: the sequence header, parsed as the AV1 specification defines it, and the `av01` codec string it declares.
- `AV1DecoderConfiguration.ts`: replaces the codec string Mediabunny derives for an AV1 track with the one its first packet's sequence header declares.

### video/decoders/

- `OwnedVideoDecodeStream.ts`: the codec-neutral state of one owned decode attempt: decoded outputs matched with their packets' metadata, the pre-start rule, BL and EL pairing, frame credits, and the packet pump, which waits briefly after each packet for the decoder's next output.
  It pairs a path's Dolby Vision and HDR10+ queues into the metadata its frames take (`createOwnedVideoFrameMetadataSource`).
  It also runs a single-layer attempt (`runOwnedSingleLayerVideoStream`), given a per-packet metadata step.
- `OwnedNativeVideoDecoder.ts`: an owned WebCodecs decoder for packets that decode unchanged, used for AV1 and VP9.
- `OwnedAV1VideoStream.ts`: one attempt of the owned AV1 path, which every AV1 track takes: each temporal unit's Dolby Vision RPU and HDR10+ metadata, paired with its frame.
- `OwnedVP9VideoStream.ts`: one attempt of the owned VP9 path, which every VP9 track takes: the HDR10+ in each packet's container side data, paired with its frame.
- `OwnedNativeHEVCVideoDecoder.ts`: the engine's own WebCodecs HEVC decoder, built on `OwnedNativeVideoDecoder`: NAL order fix, leading RASL drop, optional SPS neutralization.
- `HEVCSoftwareVideoDecoder.ts`: the `@hevcjs/core` decoder (I420 and I420P10) with a shutdown registry.
- `HEVCDecoderBackend.ts`: the low-level `@hevcjs/core` WASM binding.
- `JPEG2000SoftwareVideoDecoder.ts`: OpenJPEG WASM to an RGBA `VideoFrame`.
- `MPEG2VC1SoftwareVideoDecoder.ts`: FFmpeg WASM MPEG-2 and VC-1 to I420.

### video/dolby-vision/

- `DolbyVisionProfiles.ts` [main and worker]: the dual-layer profile set (P4, P7).
- `DolbyVisionHEVCSplitter.ts`: NAL parsing; the BL, RPU (62), and EL (63) split; RASL handling; in-band SPS neutralization; drops NAL units of layers above 0, the MV-HEVC second view.
- `DolbyVisionAV1Splitter.ts`: removes the Dolby Vision T.35 metadata OBUs from an AV1 temporal unit and returns their messages; other metadata, HDR10+ included, stays.
- `DolbyVisionEncodedMetadata.ts`, `DolbyVisionEncodedMetadataProtocol.ts`: per-packet RPU parsing for HEVC and per-temporal-unit parsing for AV1, which removes the RPUs unparsed on a route without Dolby Vision, over one PTS-keyed window, and the transferable schema.
- `DolbyVisionEncodedPacketPairer.ts`, `DolbyVisionFramePairQueue.ts`: BL and EL packet and frame pairing (1 us tolerance).
- `DolbyVisionRPUParser.ts`, `DolbyVisionRPUParserSession.ts`, `DolbyVisionRPUDataLayout.ts`: the libdovi WASM parser with its HEVC and AV1 T.35 entry points, its per-run session, and the packed 3232-byte snapshot layout (schema 2: a mapping method per segment).
- `ISOBaseMediaDolbyVisionSampleEntry.ts`: gives Mediabunny's unmapped `dvh1`, `dvhe`, `dva1`, `dvav`, and `dav1` tracks their wrapped codec.
- `MatroskaDolbyVisionHVCE.ts`, `ISOBaseMediaDolbyVisionConfiguration.ts`, `MPEGTransportStreamDolbyVisionConfiguration.ts`: find a P4 or P7 EL configuration in Matroska; in MP4, as a separate EL track or as `hvcE` beside the BL `hvcC` of one interleaved track; or in MPEG-TS and M2TS (any descriptor version).
- `DolbyVisionGeometry.ts` [main and worker]: the P4 and P7 EL coded size (half the BL when the BL is wider than 1920).

### video/hdr/

- `HDR10PlusMetadata.ts`: ST 2094-40 parsing from a frame's ITU-T T.35 messages, and from an HEVC access unit's SEI.
- `HDR10PlusFrameMetadataQueue.ts`, `HEVCDynamicHDRMetadataQueue.ts`: PTS matching of each packet's HDR10+ result to its decoded frame, for any codec, with the last metadata carried in decode order to frames without their own, and the HEVC packet step that feeds it.
- `AV1HDR10PlusMetadata.ts`: the HDR10+ messages of an AV1 temporal unit's T.35 metadata OBUs, without their trailing bits, parsed by `HDR10PlusMetadata.ts`.
- `HEVCStaticHDRMetadata.ts`, `AV1StaticHDRMetadata.ts`: the MDCV and CLL of an HEVC access unit's SEI and of an AV1 temporal unit's metadata OBUs, and the AV1 PQ sequence header check that gates its scan.
- `StaticHDRMetadata.ts` [main and worker]: the MDCV and CLL luminance schema, the codec-neutral startup scan, the scan-result validators shared across the worker boundary, and the static tone mapping source peak.

### video/hevc/

- `HEVCSEI.ts`, `HEVCSPSParser.ts`: SEI extraction and the alternative transfer characteristics value; SPS parsing, the VUI color mapping to WebCodecs names, and the VUI rewrite with its native HDR route check.
- `NativeHDRHEVCColorNeutralizer.ts`: rewrites the `hvcC` SPS and the decoder colorSpace to limited BT.709 for the native external HDR route.

### video/vp9/

- `VP9FrameParser.ts`: splits a packet at its superframe index and tells from the frame headers whether it shows a frame.

## audio/

- `CustomAudioCodec.ts`: the WebCodecs, Mediabunny PCM, and bundled codec lists.
- `CustomAudioSampleRate.ts`: the sample rate contract, any positive integer.
- `CustomCompressedAudioRoute.ts`: the E-AC-3, DTS, and TrueHD route tables and predicates, with their Jellyfin ChannelLayout requirements.
- `CustomAudioOutputPolicy.ts`: input channels per codec, the 3.0 layout requirement for decoders without a speaker mask, and the 48 kHz 2, 6, and 8-channel output contract with its 2 s ring.
- `CustomAudioTrackMetadata.ts` [worker]: the Matroska and ISO BMFF DTS and TrueHD tracks the bundled decoders own, declared-rate recovery for their sample entries, and the decoded audio timestamp tolerance.
- `AudioStartPacket.ts` [worker]: the packet an audio attempt starts from, without Mediabunny's proof scans when the track starts late.
- `NativeMultichannelAudioOutput.ts`: `selectCustomAudioOutputChannelCount`, the output layout rule (three channels and 5.1 to 5.1, 6.1 and 7.1 to 7.1 or 5.1, otherwise stereo).
- `AudioNormalization.ts`: TrackGain and AlbumGain decibels to linear gain.
- `AudioSampleWindow.ts`: PCM windowing at a seek.
- `SafeIntegerValidation.ts`: the positive safe integer check the audio modules share.

### audio/decoders/

- `AC3SoftwareAudioDecoder.ts`, `EAC3SoftwareAudioDecoder.ts`, `DTSSoftwareAudioDecoder.ts`, `TrueHDSoftwareAudioDecoder.ts` [worker]: the `@mediabunny/ac3` registration and the lazily loaded WASM decoders.
  A worker fetches a kit's served binary when it creates the kit's first decoder; `loadDTSDecoderModule`, `loadEAC3DecoderModule`, and `loadTrueHDDecoderModule` take bytes a caller already fetched instead.
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
- `DolbyVisionPresentationAuthorization.ts`, `ExternalDolbyVisionPresentationAuthorization.ts`: raw Dolby Vision keys (per raw format: single-layer, the P4 and P7 bases, and the P4 and P7 FEL) and the external P5 key, checked with synthetic RPU vectors.
- `GPUAuthorizationDeadline.ts`: the shared 5 s timeout, cancelled on device loss.
- `GPUCanvasReadback.ts`: bounded GPU canvas pixel readback (5 s).
- `GPUErrorScope.ts`: the error-scope cleanup the authorizations share.

## Outside src/

- `test/helpers/enginePaths.ts`: the engine root and the `node_modules` location, independent of the test runner's working directory, and the folders from `tools/constants.json`.
- `test/helpers/dolbyVisionAV1ITUTT35Payload.ts`, `test/helpers/dolbyVisionMixedRPUVector.ts`: wrap an HEVC RPU in the AV1 EMDF T.35 container, and build RPUs with mixed and linear pieces.
- `test/helpers/libraryAssets.ts`: the asset build's tables from `scripts/library-assets.mjs`, and a served decoder binary read as bytes from the file the build copies, since tests have no server for its URL.
- `test/helpers/av1MetadataOBUs.ts`: AV1 OBUs, metadata OBUs included, that the AV1 tests build temporal units from.
- `test/helpers/hdr10PlusVectors.ts`: the HDR10+ messages of `HDR10PlusVectors.ts`, and what the HDR10+ AV1 and VP9 vectors share: the `expectations.json` reader, the coded values in the engine's units, and the check of a posted frame's HDR10+ result.
- `test/helpers/av1HDR10PlusVectors.ts`, `test/helpers/vp9HDR10PlusVectors.ts`: each set's files and its codec's known answers, such as the AV1 static HDR metadata and the VP9 BlockAddID.
- `test/helpers/ownedVideoStreamFakes.ts`: a stream run, a packet iterator, and a decoder that outputs each frame at once or holds its frames until a flush, in decode or presentation order, for the owned decode path tests.
- `test/helpers/decodeWorkerHarness.ts`: loads a fresh playback worker in a stand-in browser: a global scope that plays the session's part, range responses for the media it plays, and a WebCodecs video decoder.
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
  - `ffmpeg-eac3/`, `ffmpeg-truehd/`, `libdcadec-dts/` [worker]: Emscripten ES module glue (`.mjs`), imported as `#wasm/<kit>/<kit>.mjs` through the `imports` map in `package.json` and bundled into the workers, and its `.wasm`, served from `libraries/<kit>/`.
    Their hand-written declarations are `wasm/<kit>/<kit>.d.mts`, which the map's `types` condition resolves.
  - `ffmpeg-mpeg2-vc1/` and `libdovi/`: served from `libraries/`.
- `bin/codec_vector_assets/`: the generated codec vectors, the one committed folder in `bin/`:
  - `dts/DTSExactCapabilityVectors.ts`, `truehd/TrueHDExactCapabilityVectors.ts`: access units and expected outputs, which `capability/exact/` imports as `#codec_vector_assets/*`.
    `truehd/` also holds the synthetic TrueHD and MLP streams the module embeds.
  - `hevc-range-extension/`, `jpeg2000/`, `mpeg2/`: qualification streams served at runtime from `bin/libraries/`.
  - `dolby-vision-av1/`: the Profile 10 test vectors and their `expectations.json`.
  - `hdr10plus-av1/`: the HDR10+ AV1 test vectors and their `expectations.json`.
  - `hdr10plus-vp9/`: the HDR10+ VP9 test vectors, in WebM and Matroska, and their `expectations.json`.
  - `downmix-reference/`: the deterministic 7.1-to-stereo reference.
