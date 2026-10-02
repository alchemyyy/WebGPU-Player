# Module Map

One line per file. `[main]`/`[worker]`/`[worklet]` marks the thread where it is
not obvious.

- Engine sources are in `src/`, and each file's `*.test.ts` is at the same
  relative path under `test/`.
- The last section is the host's integration in `wgp/` (the fork's
  `src/plugins/webGPUPlayer/`), with tests in the fork's
  `src/webgpu-player-integ-tests/plugins/webGPUPlayer/`. Host files outside the
  plugin are in [INTEGRATION.md](INTEGRATION.md).

## src/

- `EngineAssets.ts`: typed manifest of every runtime asset path, plus URL
  resolution against the host's asset base or, inside workers, the worker URL.
- `EngineConfiguration.ts`: feature flags a host can set.
- `PresentationInput.ts`: MediaStream metadata to color metadata, DV P5/P7/P8
  descriptors and base metadata, video ordinal, known-SDR gate.
- `PresentationGeometry.ts`: pure object-fit/object-position math to viewport
  and texture transforms.
- `WebGPUPresenter.ts`: GPUDevice and canvas. rVFC and pushed-frame
  submission, color pipeline install, HDR/DV authorization, device-loss
  recovery, latched fallback.
- `RawYUVGPURenderer.ts`: uploads raw YUV (and DV EL) planes into uint
  textures and draws. Shared with authorization.
- `RenderSettings.ts`: versioned (v7) HDR-to-SDR settings and a 144-byte
  uniform with HDR10+ fields.
- `MediaTime.ts`: branded integer microseconds and conversions to Jellyfin
  ticks.
- `DolbyVisionGeometry.ts`: P7 EL coded size (half BL when BL width > 1920).
- `WebGPUAudioOutputManager.ts`: page-wide sink router (`setSinkId`) with
  fallback chain, `devicechange`, picker, and UI snapshot.
- `shaders/identity.wgsl.ts`: passthrough `texture_external` shader with
  crop.
- `style.scss`: presenter and overlay styles, imported by the host.

## src/color/

- `ColorMetadata.ts`: input color schema, validation, SDR/PQ/HLG factories.
- `ColorPipeline.ts`: CPU reference of range, matrix, transfer, gamut, tone
  map, display controls.
- `ColorPipelineShader.ts`: WGSL generators for raw YUV, external HDR code
  recovery, and external/raw DV (incl. FEL), plus shared `processColor`.
- `DolbyVisionColorTransform.ts`: RPU reshape (polynomial/MMR), FEL NLQ
  residual, reconstruction to BT.2020 PQ (CPU reference and WGSL).

## src/custom/: negotiation and capability

- `CustomContainerCodecSupport.ts`: the single container/codec matrix.
- `CustomPlaybackEligibility.ts`: per-session route choice and the
  player-selection prefilter.
- `CustomDecodeCapabilities.ts`: cached orchestrator for every capability
  probe; codec lists.
- `H264ProfileCapabilities.ts`: per-profile H.264 decoded-output probe and
  Jellyfin profile names.
- `HEVCRangeExtensionCapabilities.ts`: the nine RExt variant definitions and
  the stream-metadata resolver.
- `CustomPlaybackRuntime.ts`: runtime feature detection with failure reasons.
- `HEVCExactCapability{Probe,Probe.worker,Protocol,WorkerRuntime,Fixtures}.ts`:
  bundled HEVC qualification (8-frame fingerprints). Fixtures also feed the
  native HEVC probes.
- `DTSExactCapability{Probe,Probe.worker,Protocol,Runner,Fixtures}.ts`:
  libdcadec qualification (7 fixtures, real-time factor at least 2).
- `TrueHDExactCapability{Probe,Probe.worker,Protocol,Runner,Fixtures}.ts`:
  TrueHD/MLP qualification (4 fixtures, major-sync recovery).
- `JPEG2000ExactCapability{Probe,Probe.worker,Protocol}.ts`: OpenJPEG
  qualification (960x540 RGBA fingerprint).
- `LegacyVideoExactCapability{Probe,Probe.worker,Protocol}.ts`: MPEG-2 and
  VC-1 qualification (12 frames, I420 fingerprint).
- `NativeMediaAudioCapabilities.ts`: MSE AC-3/E-AC-3 route probe and
  selection.
- `NativeMediaAudioCapabilityFixtures.ts`: fMP4 AC-3/E-AC-3 fixtures.
- `NativeAudioCapabilityFixtures.ts`: stereo silence packets per WebCodecs
  codec.
- `NativeSurroundAudioCapabilityFixtures.ts`: 5.1 silence packets.
- `NativeVideoCapabilityFixtures.ts`: 64x64 VP8/VP9/AV1 keyframes.
- `NativeUltraHDVideoCapabilityFixtures.ts`: 4K 8-bit HEVC/VP9/AV1 keyframes.
- `RawHDRCapabilityFixtures.ts`: 4K 10-bit VP9/AV1 keyframes with plane
  fingerprints.

## src/custom/: audio policy

- `CustomAudioCodec.ts`: WebCodecs, Mediabunny PCM, and bundled codec lists.
- `CustomAudioSampleRate.ts`: the 3000-192000 Hz integer contract.
- `CustomCompressedAudioRoute.ts`: E-AC-3, DTS, TrueHD route tables and
  predicates.
- `CustomAudioOutputPolicy.ts`: input channels per codec; 48 kHz 2/6/8-channel
  output contract.
- `NativeMultichannelAudioOutput.ts`: `selectCustomAudioOutputChannelCount`.

## src/custom/: controller, session, worker

- `CustomPlaybackController.ts` [main]: lifecycle, generations, clock,
  startup 20 s / stall 10 s / lag 2 s policy, EOS drain, fallback disposition.
- `CustomPlaybackControllerTypes.ts`: states, events, fallback reasons and
  dispositions.
- `CustomDecodeSession.ts` [main]: one worker per generation, frame queue,
  credits, raw-buffer recycling, readiness.
- `CustomDecode.worker.ts` [worker]: demux, decoder dispatch, raw copy, DV/HDR
  metadata, PCM pipeline, fMP4 remux, credit waits.
- `DecodeWorkerProtocol.ts`: messages, validators, credit constants (4/2/8),
  backend and output literals.
- `StaticHDRMetadata.ts`: MDCV/CLL luminance schema and scan-result validators
  shared across the worker boundary; static tone-mapping source peak.
- `CustomDecodeTrackSelection.ts`, `ConcurrentDecodeStreams.ts`,
  `DecodedVideoGeometry.ts`: track selection, concurrent stream helpers, and
  the first-decoded-size lock.
- `MediaClock.ts` [main]: generation-tagged clock; `synchronize`
  re-anchors.
- `MediaFetchPolicy.ts`: retries only transport errors and 408/429/5xx.
- `HTTPRangeResponse.ts`: validates Range responses, including Jellyfin's
  cross-origin 206.
- `TimeMath.ts`: safe-integer microsecond math.

## src/custom/: video decoders, Dolby Vision, HDR metadata ([worker] unless noted)

- `OwnedNativeHEVCVideoDecoder.ts`: owned WebCodecs HEVC decoder. NAL-order
  fix, leading RASL drop, optional SPS neutralization.
- `HEVCSoftwareVideoDecoder.ts`: `@hevcjs/core` decoder (I420/I420P10) with
  shutdown registry.
- `HEVCDecoderBackend.ts`: low-level `@hevcjs/core` WASM binding.
- `JPEG2000SoftwareVideoDecoder.ts`: OpenJPEG WASM to RGBA `VideoFrame`.
- `LegacySoftwareVideoDecoder.ts`: FFmpeg WASM MPEG-2/VC-1 to I420.
- `RawVideoFrameCopy.ts`: `VideoFrame.copyTo` into aligned planar buffers
  (I420..I444P12, BL+EL). 128 MiB per transfer.
- `RawFrameBufferPool.ts`: reusable raw buffers bounded by raw credits (2).
- `DolbyVisionHEVCSplitter.ts`: NAL parse, BL/RPU(62)/EL(63) split, RASL,
  in-band SPS neutralization.
- `DolbyVisionEncodedMetadata.ts`, `DolbyVisionEncodedMetadataProtocol.ts`:
  per-packet RPU parse, PTS-keyed metadata, transferable schema.
- `DolbyVisionEncodedPacketPairer.ts`, `DolbyVisionFramePairQueue.ts`:
  BL/EL packet and frame pairing (1 us tolerance).
- `DolbyVisionRPUParser.ts`, `DolbyVisionRPUParserSession.ts`,
  `DolbyVisionRPUDataLayout.ts`: libdovi WASM RPU parser, its per-run
  session, and the packed 3232-byte snapshot layout.
- `MatroskaDolbyVisionHVCE.ts`, `ISOBaseMediaDolbyVisionConfiguration.ts`,
  `MPEGTransportStreamDolbyVisionConfiguration.ts`: find a P7 EL
  configuration in MKV, dual-track MP4, or TS/M2TS.
- `MatroskaVFWVideoConfiguration.ts`: extracts VC-1 `WVC1` extradata.
- `HDR10PlusMetadata.ts`, `HEVCDynamicHDRMetadataQueue.ts`: ST 2094-40
  parsing and PTS matching to decoded frames.
- `HEVCSEI.ts`, `HEVCSPSParser.ts`, `HEVCStaticHDRMetadata.ts`: SEI
  extraction, SPS parse/VUI rewrite, MDCV/CLL startup scan.
- `NativeHDRHEVCColorNeutralizer.ts`: rewrites hvcC SPS and decoder colorSpace
  to limited BT.709 for the native external HDR route.

## src/custom/: audio pipeline

- `AudioWorkletController.ts` [main], `AudioWorkletProcessorSource.ts`
  [worklet], `AudioWorkletProtocol.ts`: worklet node, inline processor, and
  messages.
- `BrowserAudioContextPool.ts`, `BrowserAudioContextPrewarm.ts`,
  `BrowserAudioWorkletPool.ts`, `BrowserAudioOperation.ts` [main]: shared
  48 kHz context, prewarm lease, leased worklet node, timeouts.
- `BrowserCustomAudioOutput.ts` [main]: production output. Context, sink
  lease, worklet lease, physical output-time correction.
- `CustomDecodeAudioBridge.ts` [main]: worker PCM to worklet; continuity
  checks and credits.
- `CustomDecodeNativeAudioBridge.ts`, `OwnedNativeMediaAudioBackend.ts` [main],
  `NativeMediaAudioFMP4Remuxer.ts` [worker]: AC-3/E-AC-3 via hidden `<audio>`
  and MSE.
- `StreamingAudioResampler.ts`, `StreamingAudioLookaheadLimiter.ts`,
  `StreamingAudioOutputPipeline.ts`, `StreamingAudioDownmixSettings.ts`
  [worker]: 48 kHz resampler, 100 ms lookahead limiter, pipeline,
  generation-scoped live gains.
- `CustomAudioDownmix.ts`, `CustomAudioDownmixAlgorithm.ts`,
  `CustomAudioChannelLayout.ts`, `CustomWaveChannelLayout.ts`: downmix matrices
  per algorithm, algorithm IDs, layout tables, WAVE mask mapping.
- `AC3SoftwareAudioDecoder.ts`, `EAC3SoftwareAudioDecoder.ts`,
  `DTSSoftwareAudioDecoder.ts`, `TrueHDSoftwareAudioDecoder.ts` [worker]:
  `@mediabunny/ac3` registration and lazy WASM decoders. E-AC-3 reports its
  channel layout.
- `DTSSeekRecovery.ts`: DTS 1 s preroll and bounded XLL sync-error tolerance.
- `AudioNormalization.ts`: TrackGain/AlbumGain dB to linear gain.
- `AudioSampleWindow.ts`, `CustomAudioDecoderRegistration.ts`,
  `MediabunnyPCMBuiltinDecoderAvailability.ts`, `NativeMediaAudioLimits.ts`:
  PCM windowing at seek, decoder registration, G.711 availability, native-media
  limits.

## src/validation/

- `RawHDRPresentationAuthorization.ts`: raw route keys; readback through the
  production raw shader; per-device registry.
- `ExternalHDRPresentationAuthorization.ts`, `ExternalHDRAuthorizationFixture.ts`:
  external PQ/HLG route keys and the neutralized Main10 fixture.
- `DolbyVisionPresentationAuthorization.ts`,
  `ExternalDolbyVisionPresentationAuthorization.ts`,
  `DolbyVisionAuthorizationFixture.ts`: raw DV (single-layer, P7 base, P7 FEL)
  and external P5 keys, plus synthetic RPU fixtures.
- `GPUAuthorizationDeadline.ts`: shared 5 s timeout with device-loss
  cancellation.
- `GPUCanvasReadback.ts`: bounded GPU canvas pixel readback (5 s).

## Outside src/

- `codecs/dist/`: committed decoder builds.
  - `ffmpeg-eac3/`, `ffmpeg-truehd/`, `libdcadec/` [worker]: Emscripten
    single-file ES modules (`*.mjs` with embedded WASM, plus hand-written
    `*.d.mts`). The audio decoders import them.
  - `legacy-video/` and `libdovi/`: served from `libraries/`.

  `make -C codecs` rebuilds all of them; see `codecs/README.md`.
- `scripts/build.mjs`: assembles `dist/libraries/`, including the esbuild
  worker bundles. `scripts/library-assets.mjs` maps each served file to its
  source.
- `fixtures/capability/`: qualification streams served at runtime.
  `fixtures/test/`: test-only inputs.
- `tools/`: fixture generators and browser probes; see `tools/README.md`.

## Test helpers

- `test/helpers/HDR10PlusFixture.ts`: deterministic HDR10+ HEVC access units
  for the dynamic-HDR tests.
- `test/helpers/enginePaths.ts`: engine root and `node_modules` locations,
  independent of the test runner's working directory.

## Host integration: wgp/

- `wgp/plugin.ts`: plugin entry. It configures engine assets and feature
  flags, and default-exports `WebGPUPlayer`.
- `wgp/WebGPUPlayer.ts`: the Jellyfin-facing player. Profile augmentation,
  stream-copy veto, eligibility, rAF loop, fallback, renegotiation, generations.
- `wgp/HTMLPlayerDelegate.ts`: owns one `HtmlVideoPlayer` and forwards its
  events for the current generation only.
- `wgp/WebGPUUserSettings.ts`: per-user local settings (v2): render controls,
  automatic peak, downmix, output device.
- `wgp/ui/WebGPUPlaybackSettingsDialog.ts`: in-player settings panel. Live
  render and downmix updates; flags restart-required options.
- `wgp/custom/CustomDeviceProfile.ts`: `augmentDeviceProfileForCustomDecode`,
  `createBitrateIndependentDeviceProfile`.
- `wgp/custom/NativeDirectPlayCompatibility.ts`: checks the stock profile
  against the chosen source (proof for same-session fallback).
