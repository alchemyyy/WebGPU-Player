# Module map

One entry per file or family.
`[main]`, `[worker]`, and `[worklet]` mark the thread where it is not obvious.
Each source file's tests are at the same relative path under `test/`, and integration suites that span several modules sit beside their main module.

## src/

- `EngineAssets.ts`: the typed manifest of every runtime asset path, the engine's workers, its own WebAssembly modules, and the native range extension probes' streams, and URL resolution against the host's asset base or, inside a worker, the worker's own URL.
- `EngineConfiguration.ts`: the feature flags a host can set.
- `GPUCompletion.ts`: `waitForGPUCompletion`, through which every wait on a device's queue work goes, `onSubmittedWorkDone()` or a `mapAsync()`; it polls the device with empty submits while the wait is pending, since Firefox completes queue work only when the device is polled.
- `MediaTime.ts`: branded integer microseconds and conversions to Jellyfin ticks.
- `TimeMath.ts`: safe-integer microsecond math.
- `TimingTrace.ts`: the opt-in playback timing trace: the page's ring buffer, the decode worker's batches stamped on the shared epoch clock, long tasks, and the JSON export; every hook is one null check until a host starts a trace.
- `style.css`: presenter and overlay styles, imported by the host; plain CSS, so a host needs no preprocessor.

## presentation/

- `WebGPUPresenter.ts`: the GPU device and canvas; rVFC and pushed-frame submission; each route's built-in chain, planned and recorded through `passes/`; HDR and Dolby Vision authorization; device-loss recovery; the latched fallback.
  It also holds the engine API for presentation: the host's preset of user passes, live parameter changes, the plan report, HDR output for HDR sources, and the deinterlacing mode.
  While a plan deinterlaces it shows the frame before the newest, tells the frame loop its lookahead, and draws held fields from history.
  While a plan holds a display-rate pass it measures the display's refresh rate from the frame loop's animation frames, takes frames one refresh ahead, and redraws from history at each tick's clock time.
- `DisplayRefresh.ts`: the display's refresh interval, a least-squares fit of animation frame times over refresh counts, reported once it is precise and restarted when the display changes.
- `FrameInterval.ts`: the media time between a stream's frames, frame by frame: a least-squares fit of the last 24 new frames' timestamps over frame counts, counting skipped frames and restarted when the frame rate changes.
- `DeinterlaceTimeline.ts`: the frames a deinterlacing plan's history holds and the draw a clock time picks: the field shown, of which frame, and its time, at double or single rate, with yadif's passthrough of progressive frames.
- `PresentationInput.ts`: MediaStream metadata to color metadata; Dolby Vision descriptors with their RPU route; declared and exact native base metadata; the presented video ordinal; the known-SDR gate; the stream's fields from its `FieldOrder` or `IsInterlaced` and its size, and its declared frame rate, which `PresentationSetup.ts` hands the presenter.
- `DolbyVisionGeometry.ts`: the P4 and P7 EL coded size (half the BL when the BL is wider than 1920).
- `PresentationSetup.ts`: what a host calls around the eligibility, without state of its own: the play options' presentation input, the authorizations that gate the eligibility's presentation routes, the offers of the host's GPU decoder packages for a stream (`getGPUVideoDecoderOffers`) and the factory of their sessions on the presenter's device, the presenter's color pipeline for the chosen route, Dolby Vision bases included, and static HDR metadata updates.
- `PresentationGeometry.ts`: pure object-fit and object-position math to viewport and texture transforms.
- `RenderSettings.ts`: versioned (v7) HDR-to-SDR settings and their 144-byte uniform, HDR10+ fields included.
- `WebGPUConstants.ts`: the WebGPU values presentation and GPU decode share: canvas configuration, texture formats, features, and default limits.

### presentation/passes/

The presentation pipeline: each route's fixed signal and default color track, user WGSL passes, the planner that arranges them, and the executor that records frames.

- `PassTypes.ts`: the contracts of the pipeline: pass manifests, built-in chains, plans, and frame input.
- `PassLanguage.ts`: the names that headers, the prelude, and the planner share: the plane and image stages, `HOOKED`, history accessors, texture block accessors, entry points, `offset: align`, the prelude's functions, and plan-time facts.
- `PassExpression.ts`: the size and condition expressions of pass and decoder headers.
- `PassManifest.ts`: parses a pass file, whose passes each start with a `//!` header as in mpv's user shaders, into manifests in file order, each with the texture blocks it binds; a failure names its line in the file.
- `ContentIdentity.ts`: the content identity of a texture block, a 53-bit cyrb53 hash computed synchronously, which keys its upload.
- `PassResources.ts`: the engine-owned bindings, their WGSL declarations and layout entries, the byte layouts of the uniforms the engine writes, and a parameter value's normalization to its type and range.
- `PassPrelude.ts`: the WGSL around pass code: input accessors, each with its input's plan-time offset, texture block accessors, constants, the prelude's linear light and planes transform, entry stages, and the renaming that keeps each user body's names apart.
- `PresentationPlanner.ts`: arranges a route's built-in chain and the user passes on the stage spine and the color track, then generates each pass's module.
  A pass that cannot run is left out with a reason code and a terse detail.
  Without user passes every route plans one pass, which reads the source and writes the canvas.
  It reads the signal's planes apart for plane passes, from the source or a deinterlaced image, merges and converts the planes they replace, and gives every image its offset and extent, which the scaler corrects.
- `PresentationExecutor.ts`: compiles a plan, owns its textures, history rings, buffers, and bind groups, binds the caller's uploads of its texture blocks, and records each frame without submitting; a draw from history records the passes from the plan's history draw start on, except those that read the source.
- `PresentationPipelineCache.ts`: the passes each device keeps compiled, a bounded least recently used cache keyed by WGSL, bind group layout, and target format, which the executor compiles through.
- `PassTextureCache.ts`: the uploads of texture blocks on one device by content identity, made when a plan first binds a block and released when no plan or preset holds it.
- `PlaneTextureSource.ts`: the plane route's ingress: layout validation that names the failed check, one integer texture per plane, and the uploads.
- `builtin/`: the built-in signals (`BuiltinSignals.ts`, `FramePoolSignal.ts`, which reads a pool slot of any output format, as its layout says, for the frame-pool route's chain, and `FramePoolDolbyVisionSignal.ts`, the raw Dolby Vision reconstruction over that read), color functions (`BuiltinColorFunctions.ts`), and route chains (`BuiltinChains.ts`), and the deinterlacing pass (`DeinterlacePass.ts`, yadif over the signal's ring).
  A deinterlacing plan's raw and frame pool signals read an interlaced frame's 4:2:0 chroma within each field.
  Every signal reads 4:2:0 chroma at the stream's declared location, left where it declares none.
  Each signal offers its planes to plane passes: the raw and frame pool signals their decoded planes, with chroma's siting, range, and matrix, the external signals planes derived from RGB through the stream's own matrix and range at its chroma subsampling, and the Dolby Vision signals none.
  Every signal with planes also offers their transform from 'source' RGB and back, which deinterlacing plans and the prelude use.
  `BuiltinColorFunctions.ts` also gives each chain its transfer function for the prelude's linearize and delinearize, renamed from the transfer decode's code.

The optional user passes a host may offer are pass projects in `wgpup/`, outside `src/` (see [Bundled passes](bundled-passes.md)); the presenter tests run some of them.

## color/

- `ColorMetadata.ts`: the input color schema, validation, and SDR, PQ, and HLG factories.
- `ColorPipeline.ts`: the CPU reference of range, matrix, transfer, gamut, tone mapping, and display controls, and the luminance, YUV matrix, gamut, and IPT tables for BT.709, BT.2020, and BT.601 that the built-in color functions share.
- `DolbyVisionColorTransform.ts`: RPU reshaping (polynomial and MMR, chosen per segment), the FEL NLQ residual, and reconstruction to BT.2020 PQ, as a CPU reference and as WGSL.

## capability/

- `CustomContainerCodecSupport.ts`: the single container and codec matrix.
- `CustomPlaybackEligibility.ts`: per-session route choice, the player-selection prefilter, `hasEligibleCustomVideoRoute` for item-scoped negotiation, the codecs whose interlaced streams a route presents (`presentsInterlacedVideo`), and the video and audio codecs a playback decodes (`getGPUVideoDecodeTarget`, `getPlaybackAudioCodec`), which a host fetches packages for.
- `CustomDecodeCapabilities.ts`: the cached orchestrator of every capability probe, the per-item probe selection, and the codec lists, with the video codecs only a decoder package decodes (`CUSTOM_PACKAGE_VIDEO_CODECS`).
- `CapabilityAssetLoading.ts`: the bounded, retried download of a probe's served vectors.
- `CapabilityProbeStore.ts`: the probe verdicts kept in localStorage across page loads, their fingerprint, and the clear a failed start or a host calls.
- `CustomPlaybackRuntime.ts`: runtime feature detection with failure reasons.
- `H264ProfileCapabilities.ts`: the per-profile H.264 decoded-output probe and Jellyfin's profile names.
- `HEVCRangeExtensionCapabilities.ts`: the nine range-extension variant definitions and the stream metadata resolver.
- `AV1RawFormatCapabilities.ts`: the eight AV1 raw format variant definitions outside Main 10 (High 4:4:4, Professional 4:2:2 and 12 bits, and 8-bit Main for Dolby Vision) and the stream metadata resolver.
- `H264RawFormatCapabilities.ts`: the five H.264 raw format variant definitions beyond 8-bit 4:2:0 (10-bit 4:2:0, and 4:2:2 and 4:4:4 at 8 and 10 bits), the profiles beyond High that FFmpeg names and the chroma formats each codes, and the stream metadata resolver.
- `NativeMediaAudioCapabilities.ts`: the MSE AC-3/E-AC-3 route probe and its selection.
- `NativeAudioChannelTones.ts`: the channel order check of the 7.1 probes, which finds each decoded plane's strongest source tone with a windowed Goertzel measure.

### capability/vectors/

Hand-made vectors: known inputs with known answers.
Qualification vectors run in the browser before a route is advertised; test vectors feed only tests and generators.
The TypeScript modules are embedded in the bundle; the binary files are served or read as files.

- `HEVCExactCapabilityVectors.ts`: the single-frame black HEVC access units the native HEVC probes decode, Main at 1080p and Main 10 at 4K.
- `NativeMediaAudioCapabilityVectors.ts`: fMP4 AC-3/E-AC-3 vectors.
- `NativeAudioCapabilityVectors.ts`: stereo silence packets per WebCodecs codec.
- `NativeSurroundAudioCapabilityVectors.ts`: 5.1 silence packets.
- `NativeSevenPointOneAudioCapabilityVectors.ts`: 7.1 packets of one sine per source channel, and each channel's tone in WAVE 7.1 order.
- `NativeVideoCapabilityVectors.ts`: 64x64 VP8, VP9, and AV1 keyframes.
- `NativeUltraHDVideoCapabilityVectors.ts`: 4K 8-bit HEVC, VP9, and AV1 keyframes.
- `RawHDRCapabilityVectors.ts`: 4K 10-bit VP9 and AV1 keyframes with plane fingerprints.
- `ExternalHDRAuthorizationVector.ts`: the neutralized Main 10 access unit and its expected samples, for external HDR authorization.
- `ExternalAV1HDRAuthorizationVector.ts`: a lossless AV1 Main 10 BT.2020 PQ temporal unit and its exact samples, for the AV1 external HDR keys.
- `DolbyVisionAuthorizationVector.ts`: synthetic RPU snapshots for Dolby Vision authorization.
- `HDR10PlusVectors.ts`: deterministic HDR10+ HEVC access units for the dynamic HDR tests.
- `Base64.ts`: the base64 decoder the inline vectors share.
- `qualification/`: a stream that no script generates, the VC-1 stream (`vc1/`), which the `vc1` decoder project's vector holds.
- `test/`: inputs only tests and generators read: DTS samples, a TrueHD Matroska remux, Dolby Vision RPU payloads, and an hdr10plus_tool HDR10+ stream.

## pipeline/

- `CustomPlaybackController.ts` [main]: lifecycle, generations, the clock, the startup (20 s without progress, the source bytes read before readiness counting as progress, 60 s ceiling), stall (10 s), and lag (2 s) policy, the live audio output layout switch, the end-of-stream and ended-track drains, the presentation timing counters, and the fallback disposition.
- `CustomPlaybackControllerTypes.ts`: states, events, fallback reasons, and dispositions.
- `CustomPlaybackFrameLoop.ts` [main]: the frame loop a host runs per playback: each animation frame hands the presenter its timestamp and the clock's rate, then presents the controller's current frame, taken the presenter's lookahead ahead of the clock, and acknowledges its credit, or draws again from history when no frame is due, and a hidden page drains decoded video every 25 ms instead.
- `CustomDecodeSession.ts` [main]: the session's one decode worker, which the first start takes from the page's idle worker or creates, each generation takes at once while the stopped runs unwind beside it, a failure, an unacknowledged stop, or too many unwinding runs replace, and `destroy` leaves idle for the page's next session for 30 s once its runs are over; and per generation, the frame queue, credits, raw buffer recycling, the frame-pool route's GPU decode feed, readiness, audio-only resync epochs, the decoded source format, and an ended audio track completing a start, a resync, or a native-media stream.
- `CustomDecode.worker.ts` [worker]: one current run, which a start replaces at once while the stopped run unwinds beside it, each ending with `stopped`: demux, decoder dispatch, raw copy, Dolby Vision and HDR metadata, decoded PCM as restartable audio attempts in its audio decode worker, fMP4 remux, and credit waits.
  On the frame-pool route it posts compressed packets, or the records of the package's parser, with their HDR10+ state, and the track's codec private data on `ready`; after a parser's recoverable failure it posts held packets up to the next key packet and restarts the parser there.
- `CustomAudioDecode.worker.ts`, `AudioDecodeWorkerRuntime.ts` [worker]: the audio decode worker, which a decode worker spawns for its decoded PCM runs and keeps for its life, or until it is lost, when its next run spawns another.
  Each attempt has an audio decoder package's instance, or none for samples Mediabunny decoded, an output stage, and a `WorkletPCMProducer`; it renders one batch at a time under the producer's credit window and credits each batch back once rendered.
  A close shuts the attempt's worklet channel at once and is acknowledged once the attempt released the rest, and a failure reports the kind the page acts on.
- `AudioDecodeWorkerClient.ts` [worker]: the decode worker's side: the audio decode worker's spawn, each attempt's open, input credits, outcome, and close, and the packet and sample batch builders.
  A worker that fails to start, throws, or answers out of contract fails every attempt as `audio-output-failed`.
- `AudioDecodeWorkerProtocol.ts`: the messages between the two workers, their validators, the batch shapes and their transfers, the batch and credit constants (4 batches, 40 ms or 64 inputs), and the 1 MiB bound of the codec private data a package attempt carries.
- `DecodeWorkerProtocol.ts`: messages, validators, credit constants (4 frames, 2 raw buffers, 8 GPU decode packets, 8 audio samples), and the backend and output literals.
- `ConcurrentDecodeStreams.ts`: concurrent decode streams that cancel each other on the first failure and all drain before the worker reports that the generation stopped.
- `MediaClock.ts` [main]: the generation-tagged clock; `synchronize` re-anchors it.

## demux/

The first stage: the media a playback reads, its container input and track selection, codec configuration records, packet shaping and restamping, and the bitstream metadata that travels with packets.
All worker code unless marked.

- `CustomDecodeMediaSource.ts` [main and worker]: the media a playback reads, a URL that the worker fetches in byte ranges, with the host's pattern for the paths whose cross-origin 206 hides `Content-Range`, or a `File` that crosses to it by structured clone, and its validator.
- `MediaFetchPolicy.ts`: retries only transport errors and 408, 429, and 5xx.
- `HTTPRangeResponse.ts`: validates Range responses, a cross-origin 206 that hides `Content-Range` included, from the paths the source's pattern names.
- `URLSourceRetention.ts`: keeps the last run's URL source for the next run over the same media, released only by the run that took it last, and sizes its read-ahead and cache by the media's bitrate.
- `MatroskaBlockAdditions.ts`: reads a packet's Matroska or WebM BlockAdditionals but alpha, such as VP9 HDR10+, from the fork's packet side data.
- `ContainerVideoScan.ts`: a video track's scan as its container declares it: Matroska's FlagInterlaced and FieldOrder, which the fork's Matroska demuxer reports as the track's field order, or an ISO base media sample entry's `fiel` box.
- `CustomDecodeTrackSelection.ts`: track lookup by ordinal within one media type.
- `CustomAudioTrackMetadata.ts`: the Matroska and ISO BMFF DTS and TrueHD tracks whose codec Mediabunny does not map (`DTS `, `mlpa`), DTS Express detection, declared-rate recovery for their sample entries, the declared channel layout a track is screened with from its container and the host's metadata layout, the native media route's bed, and the decoded audio timestamp tolerance.
- `WaveFormatAudioConfiguration.ts`: the WAVEFORMATEX of a Matroska `A_MS/ACM` track or a codec-less AVI or ASF audio stream, written back from the fork's parsed stream format fields, and the WMA codec its format tag names as FFmpeg's RIFF tags do, its SubFormat's for WAVE_FORMAT_EXTENSIBLE.
- `VFWStreamFormat.ts`: the FourCC and extradata of an AVI or ASF video stream's BITMAPINFOHEADER, from the fork's parsed stream format, for a stream Mediabunny names no codec for.
- `AVIIndexCoverage.ts`: whether an AVI track's indexed packets end well before its stream header's declared length, as a truncated file's do, or an OpenDML file's whose OpenDML index cannot be read.
- `UnsupportedTrackFeatures.ts`: the first feature, such as an edit list, that Mediabunny reports it cannot honor for a track.
- `VideoChromaFormat.ts` [main and worker]: a video track's chroma from its decoder configuration, which the worker's ready response names and every frame carries to presentation: its subsampling from an avcC (its closing chroma format or its first SPS), an hvcC, an av1C, or an AV1, VP9, or VP8 codecs string, and its 4:2:0 location from the first SPS's VUI of an avcC or hvcC, or an av1C's or AV1 codecs string's chroma_sample_position; an H.264 or HEVC track without a record, or whose record holds no SPS, takes both from its first key packet's in-band SPS, and MPEG-1 is center-sited 4:2:0.
- `NALUnitFraming.ts`: splits H.264 and HEVC data into NAL units at Annex B start codes or at an avcC's or hvcC's length prefixes, without copying them.
- `AudioStartPacket.ts`: the packet an audio attempt starts from, without Mediabunny's proof scans when the track starts late or the start is at the playback timeline's origin, and a decoder's preroll, which never reaches before that origin.
- `PlaybackTimelineOrigin.ts`: which containers stamp their packets on a program clock, MPEG-TS, M2TS, and MPEG program streams, and where a run's playback timeline starts in such a container: the first timestamp of the tracks it plays.
- `TrackIteration.ts`: a track's packets in decode order, read about a second ahead, and its decoded video or audio samples from a start time, as iterators that end at once on `return()`.
- `ISOBaseMediaSampleEntryChildBox.ts`: reads a child box of an ISO base media track's first sample entry, such as `fiel`, from the `moov` bytes Mediabunny keeps.
- `PresentationOrderTrack.ts`: a track whose packets carry presentation timestamps for one that stamps them in decode order, as AVI and Matroska Video for Windows tracks do, by a codec's reader of each packet's picture order: an anchor takes the time of the packet FFmpeg outputs it at, and a B picture keeps its own; a key packet lookup steps back to the anchor that presents by the time.
- `BitmapInfoHeader.ts`: the BITMAPINFOHEADER of Video for Windows codec private data: its FourCC, printable or as hexadecimal bytes, and the header of a coded size and FourCC the engine builds before a codec's extradata.
- `JPEG2000TrackConfiguration.ts`: the tracks the JPEG 2000 route reads, an MJ2 `mjp2` sample entry or a Matroska Video for Windows track of a FourCC FFmpeg's `riff.c` maps to JPEG 2000, which pass no codec private data.

### demux/av1/

- `AV1OBUParser.ts`: the OBU walk of one temporal unit (headers, extension headers, leb128 sizes, a last OBU without a size field), frame header detection, metadata types and ITU-T T.35 messages, and the removal of a payload's trailing bits.
- `AV1SequenceHeaderParser.ts`: the sequence header, parsed as the AV1 specification defines it, with the bit offsets of its color_config and trailing bits.
- `AV1SequenceHeaderColorRewriter.ts`: the bit-exact rewrite of a sequence header's color description and range, and of every sequence header OBU of a temporal unit or `av1C` configOBUs.

### demux/dolby-vision/

- `DolbyVisionProfiles.ts` [main and worker]: the dual-layer profile set (P4, P7), and the 1 us tolerance within which a base and an enhancement layer timestamp pair, as packets and as decoded frames.
- `DolbyVisionHEVCSplitter.ts`: NAL unit headers over `NALUnitFraming.ts`; the BL, RPU (62), and EL (63) split; RASL handling; in-band SPS neutralization; drops NAL units of layers above 0, the MV-HEVC second view.
- `DolbyVisionAV1Splitter.ts`: removes the Dolby Vision T.35 metadata OBUs from an AV1 temporal unit and returns their messages; other metadata, HDR10+ included, stays.
- `DolbyVisionEncodedMetadata.ts`, `DolbyVisionEncodedMetadataProtocol.ts`: per-packet RPU parsing for HEVC and per-temporal-unit parsing for AV1, which removes the RPUs unparsed on a route without Dolby Vision, over one PTS-keyed window, and the transferable schema.
- `DolbyVisionEncodedPacketPairer.ts`: BL and EL packet pairing, within the tolerance of `DolbyVisionProfiles.ts`.
- `DolbyVisionRPUParser.ts`, `DolbyVisionRPUParserSession.ts`, `DolbyVisionRPUDataLayout.ts`: the libdovi WASM parser with its HEVC and AV1 T.35 entry points, one instance per worker with a context for each parser, its per-run session, and the packed 3232-byte snapshot layout (schema 2: a mapping method per segment).
- `WorkerWASMInstanceCache.ts`: the one instance of a WebAssembly module that a worker's users share, one cache per kit with the source it loads from as its version, discarded after its code traps; the libdovi parser uses it.
- `MatroskaDolbyVisionHVCE.ts`, `ISOBaseMediaDolbyVisionConfiguration.ts`, `MPEGTransportStreamDolbyVisionConfiguration.ts`: find a P4 or P7 EL configuration in Matroska; in MP4, as a separate EL track or as `hvcE` beside the BL `hvcC` of one interleaved track; or in MPEG-TS and M2TS (any descriptor version).

### demux/hdr/

- `HDR10PlusMetadata.ts`: ST 2094-40 parsing from a frame's ITU-T T.35 messages, and from an HEVC access unit's SEI.
- `AV1HDR10PlusMetadata.ts`: the HDR10+ messages of an AV1 temporal unit's T.35 metadata OBUs, without their trailing bits, parsed by `HDR10PlusMetadata.ts`.
- `HEVCStaticHDRMetadata.ts`, `AV1StaticHDRMetadata.ts`: the MDCV and CLL of an HEVC access unit's SEI and of an AV1 temporal unit's metadata OBUs, and the AV1 PQ sequence header check that gates its scan.
- `StaticHDRMetadata.ts` [main and worker]: the MDCV and CLL luminance schema, the codec-neutral startup scan, the scan-result validators shared across the worker boundary, and the static tone mapping source peak.

### demux/hevc/

- `HEVCDecoderConfiguration.ts`: reads an `hvcC` record: its profile, chroma format, bit depth, NAL length size, and its base layer's parameter sets.
- `HEVCSEI.ts`, `HEVCSPSParser.ts`: SEI extraction and the alternative transfer characteristics value; SPS parsing within the progressive Main and Main 10 bounds, the VUI color mapping to WebCodecs names, and the VUI rewrite with its native HDR route check, and the chroma format and VUI chroma location of any profile's SPS.

### demux/mpeg/

- `MatroskaMPEGVideoConfiguration.ts`: a Matroska `V_MPEG1` or `V_MPEG2` track's CodecPrivate, the sequence header FFmpeg hands its decoder, or none.
- `MPEGTransportStreamVideoConfiguration.ts`: the engine codec of an MPEG-TS, M2TS, or MPEG program stream MPEG-1, MPEG-2, or VC-1 track, and its codec private data, the extradata of its first packet with a sequence header, as FFmpeg's `extract_extradata` takes it.

### demux/vc1/

- `MatroskaVFWVideoConfiguration.ts`: reads a Matroska Video for Windows track's FourCC and extradata as FFmpeg does, and from them or an ASF stream's (`readVFWVC1DecoderDescription`, `readVFWWMV3DecoderDescription`) VC-1's extradata after a `WVC1` or `WMVA` header, and WMV3's STRUCT_C behind a new header of the track's coded size, since STRUCT_C holds no frame size.
- `ISOBaseMediaVC1Configuration.ts`: a `vc-1` sample entry's `dvc1` sequence header and entry point, Advanced profile only, which the fork hands on as the track's description.
- `VC1TrackConfiguration.ts`: the codec private data and packet track of a VC-1 or WMV3 track, per codec and container.
- `VC1PresentationOrder.ts`: reads a VC-1 or WMV3 picture's order from its picture header, for `PresentationOrderTrack.ts` to restamp a Matroska VC-1 or WMV3 track by FFmpeg's rule: an I or P picture takes the next I or P picture's time, and a B picture keeps its own.

### demux/mpeg4/

- `MPEG4TrackConfiguration.ts`: the codec private data and packet track of an MPEG-4 Part 2, H.263, or MS-MPEG4 track: its codec ID per container, a Video for Windows or AVI FourCC of the negotiated codec as FFmpeg's `riff.c` maps it, and a BITMAPINFOHEADER of the track's coded size and FourCC before its extradata.
- `MPEG4PresentationOrder.ts`: reads a video object layer's `low_delay`, `vol_control_parameters`, and time increment width, and a VOP's coding type and `vop_coded`, for `PresentationOrderTrack.ts` to restamp an AVI or Matroska VfW MPEG-4 Part 2 track FFmpeg outputs one VOP late, a layer without `vol_control_parameters` by whether its first group holds a B-VOP, passing over N-VOPs.

### demux/vp9/

- `VP9FrameParser.ts`: splits a packet at its superframe index and tells from the frame headers whether it shows a frame.

## decode/

The second stage: the WebCodecs decoders the engine owns, the GPU decoder package route, the audio decoders, and the package loading that video and audio share.
The video modules are worker code unless marked.

### decode/video/

What both video routes share.

- `RawVideoFrameCopy.ts`: copies a `VideoFrame` into aligned plane buffers (NV12, and I420 to I444P12).
  A Dolby Vision pair is a BL in any format from I420 to I444P12 and an I420P10 EL, in one compound buffer.
  It also names each format's bit depth and the BL formats Dolby Vision reconstruction samples, which the presenter and the host check.
- `RawFrameBufferPool.ts`: a run's spare raw buffers, recycled by the page or left by frames closed unposted, which drained frames and raw copies take; it allocates when no spare fits and keeps at most 2 of each byte length.
- `DecodedVideoGeometry.ts` [main and worker]: the first-decoded-size lock.
- `VideoFields.ts` [main and worker]: a stream's scan, a frame's fields, and the picture fields word GPU decoders and parsers report them in.
- `HDR10PlusFrameMetadataQueue.ts`, `HEVCDynamicHDRMetadataQueue.ts`: PTS matching of each packet's HDR10+ result to its decoded frame, for any codec, with the last metadata carried in decode order to frames without their own, and the HEVC packet step that feeds it.

### decode/video/native/

The owned WebCodecs paths.

- `OwnedVideoDecodeStream.ts`: the codec-neutral state of one owned decode attempt: decoded outputs matched with their packets' metadata, the pre-start rule, BL and EL pairing, frame credits, and the packet pump, which waits briefly after each packet for the decoder's next output, and in a preroll for the GPU's decode of the batch before.
  It pairs a path's Dolby Vision and HDR10+ queues into the metadata its frames take (`createOwnedVideoFrameMetadataSource`).
  It also runs a single-layer attempt (`runOwnedSingleLayerVideoStream`), given a per-packet metadata step.
- `VideoDecodeFence.ts`: the decode worker's fence over native frames, a WebGPU device of its own whose one-texel read of a frame completes once the GPU decoded it.
- `OwnedNativeVideoDecoder.ts`: an owned WebCodecs decoder for packets that decode unchanged, used for AV1 and VP9.
- `OwnedAV1VideoStream.ts`: one attempt of the owned AV1 path, which every AV1 track takes: each temporal unit's Dolby Vision RPU and HDR10+ metadata, paired with its frame, after an optional color neutralization.
- `OwnedVP9VideoStream.ts`: one attempt of the owned VP9 path, which every VP9 track takes: the HDR10+ in each packet's container side data, paired with its frame.
- `OwnedNativeHEVCVideoDecoder.ts`: the engine's own WebCodecs HEVC decoder, built on `OwnedNativeVideoDecoder`: NAL order fix, leading RASL drop, repair of an SPS without `default_display_window_flag`, optional SPS neutralization.
- `NativeHDRHEVCColorNeutralizer.ts`: rewrites the `hvcC` SPS and the decoder colorSpace to BT.709 at the stream's own range for the native external HDR route, and repairs an `hvcC` SPS without `default_display_window_flag` on any route.
- `NativeHDRAV1ColorNeutralizer.ts`: the AV1 counterpart: the decoder colorSpace, codecs string, and `av1C`, and each temporal unit's sequence headers, each checked against the route's limited BT.2020 color first.
- `DolbyVisionFramePairQueue.ts`: BL and EL frame pairing, within the tolerance of `demux/dolby-vision/DolbyVisionProfiles.ts`.

### decode/video/gpu/

The video half of [decoder packages](decoder-packages.md): WGSL compute decoders, which write decoded frames into a pool on the presenter's device, and their optional CPU parsers.
The frame-pool route plays them: `GPUVideoDecodeFeed.ts` feeds a session the worker's packets, and `presentation/PresentationSetup.ts` offers the host's packages and creates sessions on the presenter's device.
The engine holds no decoder; the decoder projects in `wgpud/` build packages.

- `GPUDecodeTypes.ts` [main]: the decoder manifest, stream facts, packets, output events, and coded failures.
- `GPUVideoDecoderCatalog.ts` [main]: the offer of one video decoder package for one output format, with the device's buffer limit, which the eligibility selects from, and the summary of a package a host has not loaded, which judges a stream by the same fit check when it carries the package's header.
- `GPUDecoderStreamFit.ts` [main]: whether a decoder fits a stream on a device (its `accepts` on the picture size, pool, state, scratch buffers, and packet ring), which eligibility checks at the container's size, and the pool a session codes at: a first session's at the largest picture its parser declared when the decoder fits it, a stream change's at its sequence's requirement or the old pool grown to the picture.
- `GPUDecoderManifest.ts`, `GPUDecoderPrelude.ts` [main]: parse a decoder's `//!` header, its error codes' recoveries among it, or the header alone as a server's catalog carries it, and generate its bindings and helpers, the status a packet reports into among them.
- `GPUDecoderEntryPointModules.ts` [main]: splits a decoder's module into one module per entry point, of the declarations it reaches, each kept character at its line and column, or leaves code it does not understand whole.
- `GPUFramePool.ts` [main]: the pool buffer, its slot layout, and slot lifetimes, with counted holds on a frame a resync repeats.
- `GPUVideoDecodeSession.ts` [main]: runs a decoder: the packet ring, dispatches with each picture's repeat counts, submitted whole or, when the host turns slicing on, in slices that a reset or a resync stops, every packet's status readback, which its frame waits for, a recoverable error's recovery, reordering or a parser's output events, slot release, and the visible rectangle its first header or each picture reports.
- `GPUDecoderPipelineCache.ts` [main]: the compiled decoders a device keeps for later sessions, by package id and output format, with the package's content hash as their version, so a package's new version replaces its old one's.
- `GPUVideoDecodeFeed.ts` [main]: the frame-pool route's page side: it creates or reuses a GPU decode session per generation, hands a picture its session cannot hold to a session made for it (a stream change), keeps up to two slices of decode work in flight and submits the next as one completes or a status readback applies, returns packet credits, turns decoded frames into presentation frames, counts the session's recoveries, and reports its failure and its drained end.
- `GPUDecodeFormats.ts` [main], `GPUDecodeLimits.ts` [main and worker]: the planar formats a decoder may write and the FFmpeg pixel formats each holds, and the route's bounds.
- `GPUDecoderParser.ts`: one instance of a package's parser module, with its configure, plan, plan_next, parse, finish, and decode calls, each picture's record, output events, visible size, repeat counts, output format, and sequence maximum, and whether a failure resyncs.
- `GPUDecoderParserPipeline.ts`: an attempt's parser on its coordinator instance: it plans each packet's pictures, splits a picture's units into parse jobs, retries a blocked plan or plan_next, and finishes the pictures in decode order.
- `GPUDecoderCoordinator.worker.ts`, `GPUDecoderParse.worker.ts`: a video decoder package's coordinator worker, which a decode worker starts with its first attempt that needs one and keeps for its life, and its parse workers, which the coordinator worker keeps while the package's id and content hash stay; they run `GPUDecoderCoordinatorWorkerRuntime.ts` and `GPUDecoderParseWorkerRuntime.ts`.
- `GPUDecoderWorkerCoordinator.ts`, `GPUDecoderCoordinatorHost.ts`, `GPUDecoderCoordinatorProtocol.ts`, `GPUDecoderCoordinatorWorkerRuntime.ts`: the decode worker's coordinator worker, shared by its attempts, with its 30 s watchdog; its messages; and its runtime, which runs one pipeline at a time.
- `GPUDecoderParseWorkerPool.ts`, `GPUDecoderParseProtocol.ts`, `GPUDecoderParseWorkerRuntime.ts`: the parse workers, one per core beyond two, from one to six; the pool sends each job to the worker with the fewest outstanding and stops on a worker error or the watchdog.
- `GPUDecoderVectorSet.ts` [main]: reads and writes a package's vectors section.
- `GPUDecoderVectorCheck.ts`, `GPUDecoderVerification.ts` [main]: one vector's check on a device, and `verifyGPUDecoderPackage`, which runs it, through the package's parser on a worker of its own, only when a host calls it.

### decode/audio/

The audio half of [decoder packages](decoder-packages.md).

- `AudioDecoderManifest.ts`: parses an audio package's `//!` header.
- `AudioDecoderPackageInstance.ts` [worker]: one decoder on its own instance of a package's module, which drives version 1 of the audio decoder interface and copies each block out; the selection of a package and codec, and its validators across worker boundaries.
- `PackageSoftwareAudioDecoder.ts` [worker]: owns one package decoder in the audio decode worker, configures it with the track's codec private data before its first packet, checks each block's layout and rate, and stamps blocks without a timestamp after their packet's earlier ones.

### decode/packages/

The package file that both halves share (see [Decoder packages](decoder-packages.md)).

- `DecoderPackage.ts` [main]: `loadDecoderPackage`, which compiles a package file and checks it in order, failing with a `DecoderPackageError` code and detail; the video and audio package types.
- `DecoderPackageFormat.json`: the section names and the vectors section's magic and version, which the engine and `tools/decoder-package-format.mjs` share.
- `DecoderHeader.ts`: the `//!` header syntax both kinds of manifest share, the kind a source names, and error names.
- `DecoderPackageIdentity.ts` [main and worker]: a package's identity, the form of the `id:` its header declares and the version, its id with the content hash, that the engine keys what it keeps for a package by.
- `DecoderPackageBinary.ts`: reads what the JavaScript API does not reflect from a module binary: its imports with their memory limits, and whether it defines a memory.
- `DecoderPackageImports.ts` [main and worker]: the import whitelist, the memory bound (16384 pages), the inert WASI stubs, and the instantiation that runs a reactor's `_initialize` first.
- `DecoderPackageStore.ts` [main]: a host's IndexedDB store of package files by package id, which loads each file with the engine's checks, so a package's new version replaces its old one.

## audio/

- `CustomAudioCodec.ts`: the WebCodecs, Mediabunny PCM, and package codec lists; the package codecs are those the engine has no decoder of.
- `CustomAudioSampleRate.ts`: the sample rate contract, any positive integer.
- `CustomCompressedAudioRoute.ts`: the E-AC-3, DTS, and TrueHD route tables that the input channel counts derive from, the DTS profiles, and the TrueHD rate rule.
- `CustomAudioOutputPolicy.ts`: input channels per codec, the 3.0 layout requirement for decoders without a speaker mask, and the 48 kHz 2, 6, and 8-channel output contract with its 2 s ring.
- `NativeMultichannelAudioOutput.ts`: the speaker layout setting (`selectCustomAudioSpeakerLayout`) and the output layout rule (`selectCustomAudioOutputLayout`: objects take the whole layout; otherwise three channels, 5.0, and 5.1 to 5.1, 6.1 and 7.1 to 7.1 or 5.1, else stereo).
- `AudioNormalization.ts`: TrackGain and AlbumGain decibels to linear gain.
- `AudioSampleWindow.ts`: PCM windowing at a seek.
- `SafeIntegerValidation.ts`: the positive safe integer check the audio modules share.

### audio/processing/

- `StreamingAudioResampler.ts`, `StreamingAudioLookaheadLimiter.ts`, `StreamingAudioOutputPipeline.ts`, `StreamingAudioDownmixSettings.ts` [worker]: the 48 kHz resampler with input timestamp reconciliation within 2 s (larger deviations throw, and a listener sees every correction) and a continuation across source rate changes, the 100 ms lookahead limiter, the pipeline that rebinds its source rate and enables the limiter late, and generation-scoped live gains that follow the decoded rate.
  The resampler's and the limiter's own storage and rendering are the JavaScript reference; given the output stage module, a kernel stores and renders instead, with the same bytes.
- `AudioOutputStageModule.ts` [worker]: the `audio-output-stage` WebAssembly module, loaded once per audio decode worker on its first attempt, with a once-warned fallback to the reference when it does not load, and its resampler and limiter kernels, freed on finalize, on close, or after their owner is collected.
- `PCMChannelPool.ts` [worker]: the spare channel buffers the worklet returns, each sized for the largest chunk, which the output stage writes later chunks into.
- `DecodedAudioOutputStage.ts` [worker]: binds one audio attempt's output stage to the decoded rate and layout, checks them against the decoded PCM routes, and reports each bound format; `close` frees a stopped attempt's kernels.
- `CustomAudioDownmix.ts`, `CustomAudioDownmixAlgorithm.ts`, `CustomAudioChannelLayout.ts`, `CustomWaveChannelLayout.ts`: downmix matrices per algorithm (three-channel beds have their own), algorithm IDs, layout tables with the output layouts (stereo, 5.1, 7.1, 5.1.2, 5.1.4, 7.1.2, 7.1.4) and by-name mapping and height folds into them, a 5.0 bed's mix through 5.1, and WAVE mask mapping.

### audio/output/

- `AudioWorkletController.ts` [main], `AudioWorkletProcessorSource.ts` [worklet], `AudioWorkletProtocol.ts`: the worklet node, the inline processor (which renders silence from a flush up to the first chunk), and their messages.
- `AudioOutputDevicePresence.ts` [main]: whether `enumerateDevices()` lists any audio output.
- `BrowserAudioContextPool.ts`, `BrowserAudioContextPrewarm.ts`, `BrowserAudioWorkletPool.ts`, `BrowserAudioOperation.ts` [main]: the shared 48 kHz context (never pooled when created without an output device), the prewarm lease, the leased worklet node, and timeouts.
- `BrowserCustomAudioOutput.ts` [main]: the production output: context, sink lease, worklet lease, the physical output time correction, in-place layout reconfiguration, and `sinkchange` reporting.
- `CustomDecodeAudioBridge.ts` [main]: each generation's flush and its new channel for the producer, the producer's progress against the processor's consumption, which the end-of-stream drain reads, and the processor's overflow and stale-generation failures.
- `WorkletPCMProducer.ts` [worker]: feeds one worklet processor over its own channel: it owns the credit window, checks each chunk's layout, bounds, and continuity before posting it, and passes the buffers the processor returns to the channel pool.
- `WebGPUAudioOutputManager.ts`: the page-wide sink router (`setSinkId`), with its fallback chain, `devicechange` handling, output recovery poll and sink rebuild, picker, and UI snapshot.

### audio/native/

AC-3 and E-AC-3 through a hidden `<audio>` and MSE.

- `CustomDecodeNativeAudioBridge.ts`, `OwnedNativeMediaAudioBackend.ts` [main]: the bridge and the owned media element, which parks at a late first fragment, delays `play()` by the gap, and advances by a late timer's overshoot.
- `NativeMediaAudioFMP4Remuxer.ts` [worker]: the fMP4 remux of the selected audio track.
- `NativeMediaAudioLimits.ts`: the segment caps (2 s, 2 MiB) and the pending-append caps (16 segments, 4 MiB).

## validation/

The authorization vectors are in `capability/vectors/`.

- `RawHDRPresentationAuthorization.ts`: raw route keys, readback of the route's default plan, and the per-device registry.
- `ExternalHDRPresentationAuthorization.ts`: external PQ and HLG route keys per codec, HEVC Main 10 and AV1 Main 10, each checked with its own neutralized vector.
- `DolbyVisionPresentationAuthorization.ts`, `ExternalDolbyVisionPresentationAuthorization.ts`: raw Dolby Vision keys (per raw format: single-layer, the P4 and P7 bases, and the P4 and P7 FEL) and the external P5 and P8 keys, one registry each, checked with synthetic RPU vectors.
- `GPUAuthorizationDeadline.ts`: the shared 5 s timeout, cancelled on device loss.
- `GPUCanvasReadback.ts`: bounded GPU canvas pixel readback (5 s).
- `GPUErrorScope.ts`: the error-scope cleanup the authorizations share.

## Outside src/

- `test/helpers/enginePaths.ts`: the engine root and the `node_modules` location, independent of the test runner's working directory, and the folders from `tools/constants.json`.
- `test/helpers/dolbyVisionAV1ITUTT35Payload.ts`, `test/helpers/dolbyVisionMixedRPUVector.ts`: wrap an HEVC RPU in the AV1 EMDF T.35 container, and build RPUs with mixed and linear pieces.
- `test/helpers/libraryAssets.ts`: the asset build's tables from `scripts/library-assets.mjs`, and a served binary read as bytes from the file the build copies, since tests have no server for its URL.
- `test/helpers/decoderPackages.ts`: video decoder packages for tests, assembled with the engine's package tool or built in memory, and the decoder projects' sources, vectors, and built packages.
- `test/helpers/postprocessingPasses.ts`: the pass files of the pass projects, one by project and name, or all of them as the asset build copies them.
- `test/helpers/audioDecoderPackageStubs.ts`, `test/helpers/scriptedAudioDecoderModule.ts`, `test/helpers/audioDecoderPackageResults.ts`: the smallest audio package the loader accepts; a module of the audio decoder interface scripted in JavaScript, found again after a structured clone by a custom section; and the packets and results the decoder projects' tests use.
- `test/helpers/webAssemblyModuleEncoder.ts`: encodes small WebAssembly modules without a toolchain, for the package loader's and the interfaces' tests.
- `test/helpers/fakeIndexedDB.ts`: an in-memory IndexedDB of the parts the package stores use: versioned opens with upgrades, keyed object stores, and transactions that apply their writes only when every request succeeds.
- `test/helpers/vc1Media.ts`: synthetic VC-1 and WMV3 sequence and picture headers, Matroska Video for Windows files, and MP4 `vc-1` files.
- `test/helpers/mpegVideoHeaders.ts`: synthetic MPEG-1 and MPEG-2 sequence headers, sequence extensions, and I picture packets, for tests that read a stream's sequences without decoding its pictures.
- `test/helpers/mpeg4Bitstream.ts`: synthetic MPEG-4 Part 2 video object layers, extradata, and VOP headers of each coding type, coded or not, for tests that order VOPs without decoding them.
- `test/helpers/mpeg4Vectors.ts`: the media of the `mpeg4` decoder project and the DivX packed AVI vector, with each one's codec, FourCC, size, extradata, and frame order as FFprobe reports them, and a packet credit return for frame-pool runs.
- `test/helpers/matroskaElements.ts`, `test/helpers/isoBaseMediaBoxes.ts`: EBML elements and ISO base media boxes, and a file of one video track in each, with any codec ID or sample entry, CodecPrivate or none, and boxes ahead of `ftyp`.
- `test/helpers/av1MetadataOBUs.ts`: AV1 OBUs, metadata OBUs included, that the AV1 tests build temporal units from.
- `test/helpers/hdr10PlusVectors.ts`: the HDR10+ messages of `HDR10PlusVectors.ts`, and what the HDR10+ AV1 and VP9 vectors share: the `expectations.json` reader, the coded values in the engine's units, and the check of a posted frame's HDR10+ result.
- `test/helpers/av1HDR10PlusVectors.ts`, `test/helpers/vp9HDR10PlusVectors.ts`: each set's files and its codec's known answers, such as the AV1 static HDR metadata and the VP9 BlockAddID.
- `test/helpers/ownedVideoStreamFakes.ts`: a stream run, a packet iterator, and a decoder that outputs each frame at once or holds its frames until a flush, in decode or presentation order, for the owned decode path tests.
- `test/helpers/decodeWorkerHarness.ts`: loads a fresh playback worker in a stand-in browser: a global scope that plays the session's part and waits for each run's `stopped`, so one worker can run several generations, range responses for the media it plays, a WebCodecs video decoder, and the audio decode worker run in-process (`inProcessAudioDecodeWorker.ts`) on a channel.
- `test/helpers/hevcMatroskaVector.ts`: a one-frame Matroska HEVC Main 10 track muxed from the x265 HDR10+ sample, as Annex B with in-band parameter sets or length-prefixed with an hvcC.
- `test/helpers/inProcessGPUDecoderWorkers.ts`: a package's coordinator worker and parse workers run in-process on channels, for the frame-pool route's parser tests.
- `test/helpers/fakeGPUVideoDecode.ts`: a GPU decode session without a device, which decodes each packet into a frame at once, and a queue whose submitted work completes when a test says so.
- `test/helpers/fakeWorkletProcessor.ts`, `test/helpers/decodedAudioMedia.ts`: the worklet processor's end of a producer channel, which records each chunk and returns it played, held, or dropped; and a Matroska file of the VP9 vector's video and a stereo PCM tone, which Mediabunny decodes in Node.
- `wasm/`: the engine's own WebAssembly modules and their build.
  See [WebAssembly build](decoders.md).
- `wgpud/`: the decoder projects, each of which builds one decoder package, with its tests in `test/`, and their shared build rules.
  See [WebAssembly build](decoders.md#decoder-projects).
- `wgpup/`: the pass projects, whose pass files a host offers as optional passes, and their upstream license texts in `licenses/`.
  See [Bundled passes](bundled-passes.md).
- `vendor/`: the FFmpeg and dcadec submodules (`update = none`), which `make -C wgpud sources` fetches.
- `scripts/build.mjs`: assembles `bin/libraries/`, including the esbuild worker bundles, and copies the pass projects' pass files into `bin/wgpup/`.
  `scripts/library-assets.mjs` maps each served file to its source.
- `scripts/decoder-packages.mjs`: builds the decoder projects into `bin/wgpud/`, or checks them against it.
- `scripts/codec_vector_assets/`: the Python codec vector generators, their tests in `test/`, and the local playback media generators.
  See [Codec vectors](codec-vectors.md).
- `tools/`: browser probes, the decoder package tools, the mpv shader converter and the `.cube` LUT converter with their tests in `test/` and the texture block writer they share, and `constants.json`.
  See [Tools](tools.md).
- `bin/wasm/`: the engine modules' builds from `make -C wasm`, `libdovi/` and `audio-output-stage/`, served from `libraries/`; ignored.
- `bin/wgpud/`: the decoder packages `npm run decoders` builds; ignored.
- `bin/wgpup/`: the pass files `npm run build` copies from the pass projects; ignored.
- `bin/codec_vector_assets/`: the generated codec vectors, the one committed folder in `bin/`:
  - `truehd/TrueHDExactCapabilityVectors.ts`: TrueHD and MLP access units and their expected outputs, which the `truehd` project's tests import as `#codec_vector_assets/*`, and the synthetic streams the module embeds.
  - `hevc-range-extension/`: the nine range extension streams, which the native probes fetch from `bin/libraries/` and the `hevc` project's vectors hold.
  - `av1-raw-format/`: the eight AV1 raw format streams, which the native probes fetch from `bin/libraries/` as `webgpu-player/av1-raw/`.
  - `h264-raw-format/`: the five H.264 raw format streams, which the native probes fetch from `bin/libraries/` as `webgpu-player/h264-raw/`.
  - `dolby-vision-av1/`: the Profile 10 test vectors and their `expectations.json`.
  - `hdr10plus-av1/`: the HDR10+ AV1 test vectors and their `expectations.json`.
  - `hdr10plus-vp9/`: the HDR10+ VP9 test vectors, in WebM and Matroska, and their `expectations.json`.
  - `downmix-reference/`: the deterministic 7.1-to-stereo reference.
