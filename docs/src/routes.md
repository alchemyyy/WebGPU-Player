# Eligibility and routes

This chapter follows a source from the engine's capability evidence to a concrete decode and presentation route.
The host turns the same evidence into what it advertises to its server; the Jellyfin plugin's book describes its device profile.

## Host entry points

A host calls these, in this order, for each playback:

1. `CustomPlaybackEligibility.hasPotentialCustomPlaybackVideoRoute`, the metadata-only prefilter, when it chooses a player.
   The prefilter declines a source whose containers no route in `CUSTOM_CONTAINER_CODEC_RULES` carries, such as AVI, FLV, ASF, or an MPEG program stream.
   It also declines a video codec no route decodes, such as MPEG-4 Part 2 (DivX, Xvid), H.263, MS-MPEG4, MPEG-1, or Theora, rotated video, and interlaced HEVC and JPEG 2000, which code their fields apart (see [Interlaced video](#interlaced-video)).
2. `CustomPlaybackRuntime.getCustomPlaybackRuntimeAvailability`, which fails without a secure context, Worker, `navigator.gpu`, or `VideoFrame`.
3. `probeCustomDecodeCapabilities(item)`, the native-media audio probe, and the GPU authorizations the item needs (5 s each), before it advertises anything; see [Probes and caching](#probes-and-caching).
4. `hasEligibleCustomVideoRoute`, to ask whether the runtime would present one item with the measured capabilities and authorizations.
5. `getCustomPlaybackEligibility`, when the session starts, with the route flags and authorized keys of `CustomPlaybackEligibilityOptions`.
   `allowRawSDR` needs only a settled `:sdr` raw key.
   `gpuVideoDecoders` holds the GPU decoder packages the host offers, from `PresentationSetup.getGPUVideoDecoderOffers`, and `allowFramePoolHDR` lets them present HDR; see [GPU decoders](#gpu-decoders).
   `audioDecoders` holds the host's audio decoder packages; see [Audio routes](#audio-routes).

## Eligibility

`getCustomPlaybackEligibility` checks in order:

1. `parsePlaybackSource`: DirectPlay, not live, a custom container, and a media `source`: a `File`, or a credential-free http(s) URL, which it resolves against the page.
   A URL source keeps the host's `hiddenContentRangePathPattern`, the paths whose cross-origin 206 hides `Content-Range` (see [Architecture](architecture.md)).
   A missing or zero `RunTimeTicks` is an unknown duration, not a rejection.
   Playback then ends with the streams, audio takes the decoded-PCM route because the native media backend needs a duration, and the worker reports the container's duration on `ready`.
2. `selectVideoStream`, and a codec the engine names.
   A codec it knows but nothing decodes, MPEG-4 Part 2, MS-MPEG4, H.263, or Theora, reads `video-codec-without-route`; any other unnamed codec reads `codec-unsupported`.
3. Rotation 0, and a codec that keeps an interlaced stream's fields together in frames (`codesInterlacedFieldsApart`, from `presentsInterlacedVideo`).
   On WebKit, H.264 in AVI only when its profile codes no B-frames (`presentsInDecodeOrder`), as `presentation-order-unsupported`.
4. `selectVideoOutput` (below), and a route that presents the stream's scan (`refusesVideoScan`).
5. `selectPlaybackAudio`.
6. `supportsCustomContainerCodecCombination`.
7. The runtime budget.

An ineligible result carries its reason, and the host falls back.

The worker refuses what only the file shows, with a message that names the check: an MPEG-4 Part 2 track (`no decode route: mpeg4`), a track whose edit list Mediabunny cannot honor (`getUnsupportedFeatures()`), an AVI video track that outruns its `idx1` index (`opendml-index-unread`), HEVC in AVI (`no presentation order: hevc`), and a DTS Express audio track (`no decode route: dtse`).
On the frame-pool route an MPEG-TS or M2TS track of MPEG-1, MPEG-2, or VC-1 must carry the negotiated codec (`container-codec`), and takes its first sequence header's extradata as codec private data (`sequence-header-missing` when none of its first 64 packets has one).

## Probes and caching

- Main thread: WebCodecs configuration and decoded-output probes, raw `copyTo` fingerprints, the per-profile H.264 probe, and the MSE AC-3/E-AC-3 probe.
  The engine has no decoder of its own to probe: Mediabunny's PCM decoding is always supported, and a codec only a package decodes reads `unsupported` with the reason `no-engine-decoder`.
- GPU: presentation authorization reads back renders of the production shaders.
  Results are cached per `GPUDevice`, canvas format, and shader signature, and dropped on device loss.
- `selectCustomDecodeProbes(item)` picks the probes an item needs.
  Every audio probe runs for every item, because a playing item can switch to any of its audio tracks.
  The video probes follow the union of the video streams across the item's sources: the codec picks its native probes, a range extension picks its own variants, a stream beyond 8-bit SDR adds the raw-plane and native HDR probes, and a range that is neither SDR nor static HDR adds the Dolby Vision probe.
  JPEG 2000, MPEG-2, and VC-1 streams pick none, since only a GPU decoder package decodes them.
  An HDR item also runs the HEVC and AV1 probes, because an HDR transcode targets those codecs and their ranges bound it.
  An item without stream metadata, or with a video stream that names no codec, runs every probe.
- A probe the item does not select reads `not-probed`, which no profile rule or eligibility check treats as support, and its H.264 profile result is absent; `probeStates` records which probes a result ran.
  At eligibility, the host keeps the negotiated result when `hasProbedCustomDecodeSelection` says it covers the played source, and otherwise probes that source.
- A range-extension probe downloads its vector before its decode timeout starts, under its own 30 s bound (`capability/CapabilityAssetLoading.ts`), so a slow link never reads as a slow decoder or trips the queue's timeout.
  A download that fails with a network error, 408, 429, or 5xx is retried after 250 ms and again after 1 s, inside the same 30 s bound; any other HTTP failure, or the bound ending, is final and reports `asset-unavailable` with an unknown status.
- Each probe is one module-level promise for the page's lifetime and is never invalidated, so a later item runs only the probes no earlier item ran.
  `SerializedHeavyCapabilityProbeScheduler` runs the heavy probes one at a time, audio first; after one times out, later heavy probes report a timeout until the page reloads.

## Route catalog

| Backend literal | Output | Qualifying evidence | Gate |
| --- | --- | --- | --- |
| `native` SDR | `video-frame` | H.264 per-profile keyframes; HEVC 1080p access unit; VP8, VP9, AV1 64x64; 4K variants | `getOrdinarySDRVideoSelection` |
| `native` HEVC Main 10 HDR, Dolby Vision base | `video-frame`, with `nativeHDRTransfer` pq or hlg, neutralized | 4K Main 10 access unit decode, plus external HDR or Dolby Vision GPU authorization | `supportsNativeMain10HEVC`, `selectNativeDolbyVisionBaseOutput` |
| `native` raw | `raw-planes`: I420P10 for HDR, 10-bit SDR, and Dolby Vision (HEVC Main 10, AV1 Main, VP9 Profile 2), I420 to I444P12 for range extensions | `copyTo` plane fingerprints; nine 192x192 two-access-unit range-extension probes; raw GPU authorization | `supportsRawHDRVideo`, `selectHEVCRangeExtensionVideoOutput` |
| `gpu` | `frame-pool`: I420 to I444P12, the stream's own format | None at eligibility: a host offers its GPU decoder packages, whose own vectors run only when the host verifies one | `selectGPUVideoOutput`; native wins |
| Audio decoder package | `decoded-pcm` | None at eligibility: a host offers its audio decoder packages | `findAudioDecoderPackage`, for a codec no engine decoder supports |
| Mediabunny PCM | `decoded-pcm` | None at runtime; always marked supported | `isSupportedCustomAudioInputLayout` |
| MSE AC-3/E-AC-3 bridge | `native-media` | `isTypeSupported`, an fMP4 append, playback advancing; 2 or 6 channels at 48 kHz | `getSupportedNativeMediaAudioRoute`, checked first |
| WebCodecs aac, opus, flac, mp3, vorbis | `decoded-pcm` | Stereo 48 kHz silence vectors; separate 5.1 vectors | `capabilities.audio[codec]` |

## Video route selection

`selectVideoOutput` tries these in order.

<div class="diagram">
<a class="diagram-light" href="diagrams/video-route-selection.light.svg"><img src="diagrams/video-route-selection.light.svg" alt="Video route selection order"></a>
<a class="diagram-dark" href="diagrams/video-route-selection.dark.svg"><img src="diagrams/video-route-selection.dark.svg" alt="Video route selection order"></a>
</div>

1. A Dolby Vision descriptor.
   `PresentationInput.getDolbyVisionPresentationSelection` accepts any integer profile with the base layer flag set, a valid bit depth, and any 4-bit compatibility ID (CCID) or none; the EL flag never rejects.
   The descriptor names the RPU route (`reconstructionProfile`): Profiles 4, 5, 7, and 8 as signaled; Profiles 10 (AV1) and 20 as 5 with CCID 0 or none and as 8 otherwise; none for Profile 9, the retired profiles, or a stream without an RPU.
   RPU reconstruction ignores the CCID, which only declares a base layer that can be shown on its own.
   The Dolby Vision routes, in order:
   1. Native external Profile 5: a 10-bit P5, or a P20 that reconstructs as P5.
   2. The native compatible base, when the CCID declares one: HDR10 (1) or Ultra HD Blu-ray (6) for P7 and P8, and HLG (4) for P8.
      The RPU and EL are ignored.
      This needs exact BT.2020 limited base metadata with explicit transfer, primaries, and matrix.
      A separate-track P7 base is a standalone HDR10 track, so it qualifies whatever CCID the EL track reports.
   3. Raw RPU reconstruction.
      The base layer decodes natively to `raw-planes`: I420P10 for HEVC Main 10 and for AV1 Main at 10 bits, or the exact format of any range-extension variant.
      HEVC Main at 8 bits has no native raw route, so its RPU route is ineligible.
      Single-layer routes (P5, P8, P10, P20) discard a signaled EL.
      No decoder decodes an EL, so dual-layer routes (P4, P7, HEVC only) reconstruct from the base layer alone: MEL is exact, and FEL presents its base layer.
      The worker still pairs a separate EL track to read its RPUs, and the presenter keeps its FEL composition for an EL decoder, which no route reaches.
   4. The declared base layer (`getDolbyVisionBaseColorMetadata`), through the ordinary steps below.
      CCID 1 or 6 declares PQ, 4 HLG, and 2 SDR, never for P5 or a P20 that reconstructs as P5.
      An explicit ColorTransfer must agree with the CCID; VideoRange and VideoRangeType are ignored.
   5. Otherwise the source is ineligible, with the reason from the reconstruction step.
2. No color metadata: `metadata-unsupported`.
   `PresentationInput.parseVideoStreamColorMetadata` reads ColorTransfer, ColorPrimaries, ColorSpace, and ColorRange.
   A field that is `unknown`, `unspecified`, or `reserved` is absent and takes its transfer's default: BT.709 for SDR, BT.2020 for PQ and HLG, and limited range.
   The BT.2020 10 and 12-bit transfers read as SDR, SMPTE 170M and SMPTE 240M primaries as `smpte170m`, BT.470 BG primaries as `bt470bg`, and the SMPTE 170M and BT.470 BG matrices as BT.601.
   Any other value is unrecognized and fails.
3. An HEVC range extension needs its exact variant capability and raw key.
   A range extension never falls through to steps 4 and 5.
4. SDR: `native`, or native Main 10 SDR.
   Then, for 10-bit 4:2:0 SDR that neither decodes (AV1 Main, VP9 Profile 2, or HEVC Main 10 without native decode), raw I420P10 through the raw SDR keys, which are BT.709 only.
   JPEG 2000, MPEG-1, MPEG-2, VC-1, and WMV3 have no native route (`CUSTOM_PACKAGE_VIDEO_CODECS`).
5. PQ or HLG: native external (`external-hevc-main10-bt709-limited:<pq|hlg>-v1`) first, then raw (`<I420P10|I420P12>:bt2020-ncl:bt2020:limited:<pq|hlg>`).
6. When steps 3 to 5 chose no route, a GPU decoder package the host offers takes the stream, if one does; otherwise the source is ineligible with the reason those steps gave.

## GPU decoders

The `gpu` backend decodes on the presenter's device with a GPU decoder package's WGSL; the `frame-pool` output presents its pool slots without a copy.
A package may carry a parser module (`//! parser:`), which the selection carries to the decode worker's start as `gpuVideoParser`: the HEVC decoder project's parser parses each packet into the GPU record its WGSL reads.
`PresentationSetup.getGPUVideoDecoderOffers` offers the host's packages that accept the stream's codec and write its output format, in the host's order, with the presenter's buffer limit; it verifies nothing.
`selectGPUVideoOutput` takes the first offer for the stream's codec that meets each of these:

- The output format: a range extension's own, else the one that holds the stream's pixel format (`getGPUDecoderPixelFormatHolding`: yuv422p is I422, and 9-bit samples take the 10-bit format, shifted up), else 4:2:0 at the stream's bit depth.
  An explicit BitDepth must agree with the pixel format's samples, and a pixel format no frame pool holds, such as RGB or 4:1:1, has no route.
- For a 4:0:0 pixel format, such as gray10le, which takes the 4:2:0 format of its depth: a decoder whose header declares `monochrome`.
- The decoder's stream constraint, over the pool's coded size and the format's bit depth.
  The pool takes the container's coded size rounded up to 64 (`GPU_DECODE_POOL_CODED_SIZE_ALIGNMENT`), the largest coding block, and the decoder's header crops it, such as by a conformance window.
  A session may code larger, at the largest picture its parser declares (see [How a session decodes](decoder-packages.md#how-a-session-decodes)), but eligibility checks the container's size.
- The frame pool, the decoder's `state` and `buffer:`s, and its packet ring each fit the device's buffer limit (`maximumBufferByteLength`), the smaller of its largest buffer and its largest storage binding: the HEVC decoder project's package holds 29 slots, which in I420P10 at 3840x2176 is about 727 MB.
  `findGPUDecoderStreamFitFailure` checks them.

HDR needs `allowFramePoolHDR`, which the host sets when it tone-maps.
The route carries no Dolby Vision reconstruction or native color handling, so a compatible Dolby Vision base layer reaches it through step 1.4, and Profile 5 never does.

A package's self-test vectors run only when a host calls `verifyGPUDecoderPackage` (see [Decoder packages](decoder-packages.md)); eligibility never waits on them, and offering an unverified package is the host's choice.

An AV1, VP9, or HEVC range-extension source presents HDR only through raw planes, so a host must settle the raw HDR keys for it whatever the external result.
The Dolby Vision keys a source needs on first use (Profile 4 in any format, or Profile 7 or single-layer reconstruction in a format other than I420P10) must settle before eligibility.

## Interlaced video

Every route but Dolby Vision's presents interlaced video through the deinterlacing pass (see [Architecture](architecture.md#deinterlacing)), so eligibility refuses interlaced video only where no route can present it, as `interlaced-video-unsupported`:

- `IsInterlaced` true on HEVC, which codes interlaced video as field pictures, and on JPEG 2000, which codes a codestream per field: no decoder weaves their fields into frames, and the pass deinterlaces frames whose rows alternate between the fields.
  The check runs before route selection, and the prefilter declines the same streams.
- A Dolby Vision route, whose profiles are progressive and which never deinterlaces, unless `IsInterlaced` is false.
  A Dolby Vision stream whose declared base layer takes an ordinary route presents through that route's deinterlacing.

H.264, MPEG-2, VC-1, and WMV3 decode interlaced video into woven frames, so they are eligible whatever `IsInterlaced` says, and a missing or malformed `IsInterlaced` is an unknown scan, which each frame's own fields settle.
MPEG-1, VP8, VP9, and AV1 have no interlaced coding.
`presentsInterlacedVideo(codec)` exports the per-codec answer, so a host's negotiation offers interlaced streams of exactly those codecs, outside its Dolby Vision labels.

| Route | Interlaced video | Field order from |
| --- | --- | --- |
| Native `VideoFrame` (`external-texture`, `external-hdr`) | Deinterlaced; the browser upsampled its chroma progressively | The container's scan, else the host's `FieldOrder` and `IsInterlaced` |
| Raw planes (`raw-yuv`) | Deinterlaced, 4:2:0 chroma read within each field | As the native route |
| GPU (`frame-pool`) | Deinterlaced, 4:2:0 chroma read within each field | The decoder's `reportPictureFields`, else its parser's `parser_picture_fields`, else as the native route |
| Dolby Vision (`external-dolby-vision`, `raw-dolby-vision`) | Refused unless `IsInterlaced` is false | None |

## Route keys

- Raw: `<I420P10..I444P12>:bt2020-ncl:bt2020:limited:<pq|hlg>` and `<I420..I444P12>:bt709:bt709:<full|limited>:sdr`.
- External HDR: `external-hevc-main10-bt709-limited:<pq|hlg>-v1`.
- Dolby Vision raw, each per BL format from I420 to I444P12: `<format>:dovi-rpu-v1`, `<format>:dovi-profile4-base-v1`, `<format>:dovi-profile4-fel-v1`, `<format>:dovi-profile7-base-v1`, and `<format>:dovi-profile7-fel-v1`.
  Only `I420P10:dovi-rpu-v1` and the I420P10 Profile 7 keys are prewarmed; the others authorize on first use.
- Dolby Vision external: `external-I420P10-bt709-limited:dovi-p5-rpu-v1`.

## Audio routes

<div class="diagram">
<a class="diagram-light" href="diagrams/audio-output.light.svg"><img src="diagrams/audio-output.light.svg" alt="Audio route choice and the decoded PCM and native-media output paths"></a>
<a class="diagram-dark" href="diagrams/audio-output.dark.svg"><img src="diagrams/audio-output.dark.svg" alt="Audio route choice and the decoded PCM and native-media output paths"></a>
</div>

- Track: `DefaultAudioStreamIndex`, else the first audio stream.
  Codec aliases: DCA is dts, EC-3 is eac3, TRUE-HD is truehd.
- Order: the native-media MSE bridge for AC-3 and E-AC-3 (2 or 6 channels, exactly 48 kHz) comes first.
  Otherwise `decoded-pcm`: through the engine's own decoders when the codec capability and the input layout qualify, the browser's for WebCodecs codecs and Mediabunny's for PCM.
  A codec no engine decoder supports, AC-3, E-AC-3, DTS, TrueHD, and MLP among them, takes the first of the host's audio decoder packages whose manifest accepts it.
- Input channels, as declared by Jellyfin.
  The decoded format is authoritative at runtime, and any decoded layout maps to the output by channel name:

  | Codec | Channels |
  | --- | --- |
  | PCM | 1, 2, 3, 6 (3 needs a `3.0` layout) |
  | aac, flac, opus, vorbis | 1, 2, 3, 6 (3 needs a `3.0` layout; 3 and 6 are advertised only with the 5.1 probe, and 6 needs it) |
  | ac3 | 1, 2, 6 (2/1 and 3/0 both arrive as `3.0`, and no evidence covers either) |
  | eac3 | 1, 2, 6, 8 |
  | mp3 | 1, 2 |
  | dts | 1, 2, 3, 6, 8 |
  | truehd | 1, 2, 6, 8 (8 only at 48 kHz) |
  | mlp | 1, 2 |

  Jellyfin keeps only the part of FFmpeg's layout name before `(`, so `3.0(back)` arrives as `3.0` and `7.1(wide)` as `7.1`.
  A package reports each block's speaker mask, so the mask, not the declared layout, tells them apart at runtime: a DTS 3.0(back) plays with its back center on the surrounds, and a mask with no output layout fails the attempt as `decode-failed`, which renegotiates.
  DTS-ES carries the only 6.1 bed, whose reported geometry failed validation, so seven channels have no route.
- DTS and TrueHD play from Matroska and from MP4, M4V, and MOV (the `DTS `, `dtsc`, `dtsh`, `dtsl`, and `mlpa` sample entries); MLP plays only from Matroska.
- Rates: any positive integer, resampled to 48 kHz.
  Past 192 kHz the resampler's kernel widens in proportion, so its band edge stays as sharp as at 192 kHz.
  A browser decoder judges its own rates per item, and a rate it refuses falls back.
- Output channels: `selectCustomAudioOutputChannelCountForMaximum` (`audio/NativeMultichannelAudioOutput.ts`) gives a three-channel or 5.1 source 6 when `destination.maxChannelCount` is at least 6, and a 6.1 or 7.1 source 8 when it is at least 8, else 6 when it is at least 6.
  Everything else downmixes to 2 with the selected algorithm.
  A host may force 2.
  A live layout switch applies the same rule to the decoded layout.

## Gotchas

- Native decode uses the hint its probes measured (`getCustomDecodeHardwareAcceleration`).
  Only the routes that present the decoder's opaque hardware output (native external HDR, the native Dolby Vision base, and external Profile 5) prefer hardware.
  Raw-plane AV1 and VP9 prefer software, because Chromium's hardware decoders return opaque 10-bit surfaces.
  Every other native route uses `no-preference`, so a codec without a hardware decoder, such as VP8 in Chromium on Windows, decodes in software.
  One exception: 10-bit SDR HEVC has no probe of its own.
  The native HDR HEVC probe gates it with `prefer-hardware`, while the SDR route requests `no-preference`.
  Chromium decodes HEVC only in hardware, so both resolve to the same decoder.
- Eligibility checks no audio profile: a stream a package cannot decode, such as DTS-UHD in a DTS package, fails its attempt at runtime as `decode-failed`.
- The raw SDR keys are BT.709 only, so 10-bit SDR AV1 or VP9 tagged BT.601 or BT.2020 is not eligible.
