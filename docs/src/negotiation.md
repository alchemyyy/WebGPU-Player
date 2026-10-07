# Negotiation and routes

How a playback goes from player selection to a Jellyfin decision and then to a
concrete decode and presentation route. Player selection, the device profile,
and the PlaybackInfo requests are host code. Eligibility, the probes, and the
route catalog are engine code. The stock profile is the one the add-on's HTML
backend returns from `getDeviceProfile`.

## Flow

1. Select a player (host). PlaybackManager offers the item to players in
   priority order, and `WebGPUPlayer` (priority 0) comes first.
   `HostCompatibleWebGPUPlayer.canPlayItem` declines when the user prefers the
   HTML player or inside a native app shell. With custom decode enabled,
   `WebGPUPlayer.canPlayItem` also requires the engine's metadata-only
   prefilter, `CustomPlaybackEligibility.hasPotentialCustomPlaybackVideoRoute`.
   When it declines, PlaybackManager picks the plain HTML player, which
   negotiates with the stock profile.
2. Build the device profile (host), in `WebGPUPlayer.getDeviceProfile(item,
   options)`:
   - A retry (`options.isRetry === true`) returns the stock profile unchanged.
   - Otherwise it adopts the stored playback preferences, keeps the stock
     profile as a per-item proof (`rememberNativeDeviceProfile`), and strips
     every bitrate field and condition (`createBitrateIndependentDeviceProfile`).
   - It stops there when custom decode is off or the engine's
     `CustomPlaybackRuntime.getCustomPlaybackRuntimeAvailability` fails (secure
     context, Worker, `navigator.gpu`, `VideoFrame`).
   - It awaits the engine's `probeCustomDecodeCapabilities` and the native-media
     audio probe. The first call on a page blocks PlaybackInfo until the probes
     settle.
   - `getHDRDeviceProfileOptions` waits for the GPU authorizations the item's
     HDR scope needs (5 s each; see [Probe scopes](#probe-scopes)) and returns
     the flags and route keys.
   - `CustomDeviceProfile.augmentDeviceProfileForCustomDecode` builds the
     profile, and `HostCompatibleWebGPUPlayer` marks it so the PlaybackInfo
     interceptor recognizes the request.
3. Request PlaybackInfo (host). The add-on's axios interceptor
   (`compat/PlaybackInfoInterceptor.ts`) applies the player's request rules
   (`compat/PlaybackInfoPolicy.ts`) to the body that stock PlaybackManager
   built:
   - The selection request carries no `MaxStreamingBitrate`.
   - `AllowVideoStreamCopy` becomes false when `WebGPUPlayer.supportsVideoStreamCopy`
     vetoes the source, which it does for any Dolby Vision descriptor.
   - When the selected source will transcode, a second request sizes the
     transcode with the detected bitrate.
4. Start the session (host). `WebGPUPlayer.play` consumes the stock-profile
   proof. It sets `currentPlaybackRequiresSourceRenegotiation` when the profile
   was augmented, the method is DirectPlay or DirectStream, and
   `NativeDirectPlayCompatibility.isSameSessionNativePlaybackCompatible` fails
   for the stock profile.
5. Check eligibility (engine). The host's `startCustomPlaybackBounded` (25 s)
   calls `getCustomPlaybackEligibility`, which checks in order:
   1. `parsePlaybackSource`: DirectPlay, not live, a custom container, a
      duration, and an http(s) URL.
   2. `selectVideoStream`.
   3. Rotation 0 and `IsInterlaced === false`.
   4. `selectVideoOutput` (below).
   5. `selectPlaybackAudio`.
   6. `supportsCustomContainerCodecCombination`.
   7. The runtime budget.
6. Fall back (host). An ineligible, timed-out, or failed start falls back.
   Without the renegotiation flag, the add-on's HTML player plays the same
   source in the same session. With it, the player asks for a renegotiation;
   on stock Jellyfin Web that is the error retry ladder, whose `changeStream`
   passes `isRetry`, so the retry negotiates with the stock profile and is
   never widened.

## How the profile is augmented

`augmentDeviceProfileForCustomDecode` (host), in order:

1. Strip bitrate.
2. Find the supported video and audio codecs.
3. Add one DirectPlayProfile per rule in the engine's
   `CUSTOM_CONTAINER_CODEC_RULES`.
4. Add the custom subtitle profiles (vtt, ass/ssa, pgssub).
5. Scope the stock video and container conditions to non-custom containers.
6. `widenAuthorizedHDRCodecProfiles`.
7. `appendMeasuredVideoRouteProfiles`. Each route profile requires
   VideoRangeType, VideoBitDepth, `IsInterlaced=false`, and VideoProfile. A
   codec with several routes is split with ApplyConditions.
8. `appendMeasuredAudioRouteProfiles`.
9. `splitOriginalAudioRouteProfiles`.

## Probes and caching

- Main thread: WebCodecs configuration and decoded-output probes, raw `copyTo`
  fingerprints, the per-profile H.264 probe, and the MSE AC-3/E-AC-3 probe.
- Dedicated workers: bundled HEVC (`@hevcjs/core`), DTS (libdcadec),
  TrueHD/MLP (FFmpeg), JPEG 2000 (OpenJPEG), and MPEG-2/VC-1 (FFmpeg).
- GPU: presentation authorization reads back renders of the production
  shaders. Results are cached per `GPUDevice`, canvas format, and shader
  signature, and dropped on device loss.
- Each probe is one module-level promise for the page's lifetime and is never
  invalidated. `SerializedHeavyCapabilityProbeScheduler` runs the heavy probes
  one at a time; after one times out, later heavy probes report a timeout until
  the page reloads.

## Route catalog

| Backend literal | Output | Qualifying evidence | Gate |
| --- | --- | --- | --- |
| `native` SDR | `video-frame` | H.264 per-profile keyframes; HEVC 1080p access unit; VP8, VP9, AV1 64x64; 4K variants | `getOrdinarySDRVideoSelection` |
| `native` HEVC Main 10 HDR, Dolby Vision base | `video-frame`, with `nativeHDRTransfer` pq or hlg, neutralized | 4K Main 10 access unit decode, plus external HDR or Dolby Vision GPU authorization | `supportsNativeMain10HEVC`, `selectNativeDolbyVisionBaseOutput` |
| `native` raw | `raw-planes`: I420P10 for HDR and Dolby Vision, I420 to I444P12 for range extensions | `copyTo` plane fingerprints; nine 192x192 two-access-unit range-extension probes; raw GPU authorization | `supportsRawHDRVideo`, `selectHEVCRangeExtensionVideoOutput` |
| `bundled-hevc` | `video-frame` (Main SDR), `raw-planes` I420P10 | A worker probe: 8-frame fingerprints for main-1080p, main10-1080p, main10-4k | `hasSupportedBundledHEVCProfile`; native wins |
| `ffmpeg-mpeg2-vc1` | `video-frame` I420 | MPEG-2 Main and VC-1 Advanced, 12 frames, Matroska only | `getMPEG2VC1SDRSelection` |
| `openjpeg` | `video-frame` RGBA | A 960x540 sRGB vector, MOV/MJ2 | `getJPEG2000SDRVideoSelection` |
| DTS, libdcadec | `decoded-pcm` | 7 vectors, downmix fingerprints, real-time factor of at least 2 | `isSupportedDTSInputRoute` |
| TrueHD/MLP, FFmpeg | `decoded-pcm` | 4 vectors, major-sync recovery, real-time factor of at least 2 | `isSupportedTrueHDMetadataRoute` |
| E-AC-3 (FFmpeg), AC-3 (Mediabunny), PCM | `decoded-pcm` | None at runtime; always marked supported | `isSupportedEAC3InputRoute` |
| MSE AC-3/E-AC-3 bridge | `native-media` | `isTypeSupported`, an fMP4 append, playback advancing; 2 or 6 channels at 48 kHz | `getSupportedNativeMediaAudioRoute`, checked first |
| WebCodecs aac, opus, flac, mp3, vorbis | `decoded-pcm` | Stereo 48 kHz silence vectors; separate 5.1 vectors | `capabilities.audio[codec]` |

## Video route selection

`selectVideoOutput` tries these in order.

1. A Dolby Vision descriptor.
   `PresentationInput.getDolbyVisionPresentationSelection` accepts any integer
   profile with the base layer flag set, a valid bit depth, and any 4-bit
   compatibility ID (CCID) or none; the EL flag never rejects. The descriptor
   names the RPU route (`reconstructionProfile`): Profiles 4, 5, 7, and 8 as
   signaled; Profile 20 as 5 with CCID 0 or none and as 8 otherwise; none for
   Profiles 9 and 10, the retired profiles, or a stream without an RPU. RPU
   reconstruction ignores the CCID, which only declares a base layer that can
   be shown on its own. The Dolby Vision routes, in order:
   1. Native external Profile 5: a 10-bit P5, or a P20 that reconstructs as P5.
   2. The native compatible base, when the CCID declares one: HDR10 (1) or
      Ultra HD Blu-ray (6) for P7 and P8, and HLG (4) for P8. The RPU and EL
      are ignored. This needs exact BT.2020 limited base metadata with explicit
      transfer, primaries, and matrix. A separate-track P7 base is a
      standalone HDR10 track, so it qualifies whatever CCID the EL track
      reports.
   3. Raw RPU reconstruction. Single-layer routes (P5, P8, P20) decode
      `raw-planes` I420P10 for Main 10, or the exact format of any
      range-extension variant, and discard a signaled EL. Dual-layer routes
      (P4, P7) decode I420P10 within the two-layer budget, and run the FEL
      shader only when their FEL key is authorized. Without a paired EL frame,
      MEL is still exact and FEL presents its base layer.
   4. The declared base layer (`getDolbyVisionBaseColorMetadata`), through the
      ordinary steps below. CCID 1 or 6 declares PQ, 4 HLG, and 2 SDR, never
      for P5 or a P20 that reconstructs as P5. An explicit ColorTransfer must
      agree with the CCID; VideoRange and VideoRangeType are ignored.
   5. Otherwise the source is ineligible, with the reason from the
      reconstruction step.
2. No color metadata: `metadata-unsupported`.
3. An HEVC range extension needs its exact variant capability and raw key. A
   range extension never falls through to the steps below.
4. SDR: `native`, native Main 10 SDR, `bundled-hevc` Main, `ffmpeg-mpeg2-vc1`,
   or `openjpeg`.
5. PQ or HLG: native external
   (`external-hevc-main10-bt709-limited:<pq|hlg>-v1`) first, then raw
   (`<I420P10|I420P12>:bt2020-ncl:bt2020:limited:<pq|hlg>`).

Every HDR and Dolby Vision flag also requires the user's HDR tone mapping
setting. `allowRawSDR` needs only a settled `:sdr` raw key.

## What the profile advertises

The profile advertises ranges per item HDR scope. A known-SDR item gets no HDR
routes, and an item with missing metadata is scoped `unknown` and gets all of
them. The raw Dolby Vision route also advertises DOVIInvalid, Jellyfin's label
for P8 outside CCIDs 1, 2, and 4 (and, on Jellyfin 12, for a base whose color
contradicts its CCID), because RPU reconstruction presents any CCID. The full
HEVC matrix is in [HEVC and Dolby Vision support](codec-support.md).

Jellyfin labels many Dolby Vision streams the engine can present outside the
generic Dolby Vision ranges: P4 and P20 by transfer (SDR under a `dvhe` or
`dvh1` sample entry), and DV over Rext, Main 12, or 8-bit Main under a profile
and depth the generic ranges do not pair with that label. For a non-retry
Dolby Vision item, `getHDRDeviceProfileOptions` (host) passes the item's
streams as `itemMediaSource`. `CustomDeviceProfile` asks the engine's
`hasEligibleCustomVideoRoute` whether the runtime would present the item with
the measured capabilities and authorizations, and if it would, advertises the
item's exact VideoProfile (as the existing route token), VideoBitDepth, and
VideoRangeType as one more HEVC route.

## Probe scopes

`getHDRDeviceProfileProbeScope` (host) picks the GPU authorizations an item
waits for:

| Scope | Waits for |
| --- | --- |
| `none` | Nothing: a known-SDR item |
| `static-hdr` | Native external HDR, and raw HDR only when no external key is authorized |
| `dolby-vision` | Dolby Vision only; the item declares no HDR base |
| `dolby-vision-profile7`, `dolby-vision-profile8-hdr10-base`, `dolby-vision-profile8-hlg-base` | Dolby Vision and native external HDR, for the exact native base |
| `dolby-vision-hdr-base` | Dolby Vision, in parallel with the `static-hdr` waits, for a declared PQ or HLG base outside those exact shapes |
| `unknown` | Native external HDR, raw HDR, and Dolby Vision |

The Dolby Vision wait also settles the item's first-use key: Profile 4, or
single-layer reconstruction in a format other than I420P10. Every non-retry
profile also waits for the raw SDR authorization, whatever the scope, and an
HDR range-extension item waits for raw HDR as well.

## Route keys

- Raw: `<I420P10..I444P12>:bt2020-ncl:bt2020:limited:<pq|hlg>` and
  `<I420..I444P12>:bt709:bt709:<full|limited>:sdr`.
- External HDR: `external-hevc-main10-bt709-limited:<pq|hlg>-v1`.
- Dolby Vision raw: `<I420..I444P12>:dovi-rpu-v1`,
  `I420P10:dovi-profile4-base-v1`, `I420P10:dovi-profile4-fel-v1`,
  `I420P10:dovi-profile7-base-v1`, `I420P10:dovi-profile7-fel-v1`.
- Dolby Vision external: `external-I420P10-bt709-limited:dovi-p5-rpu-v1`.

## Audio routes

- Track: `DefaultAudioStreamIndex`, else the first audio stream. Codec aliases:
  DCA is dts, EC-3 is eac3, TRUE-HD is truehd.
- Order: the native-media MSE bridge for AC-3 and E-AC-3 (2 or 6 channels,
  exactly 48 kHz) comes first. Otherwise `decoded-pcm`, when the codec
  capability and the input layout qualify.
- Input channels:

  | Codec | Channels |
  | --- | --- |
  | PCM | 1, 2, 6 |
  | aac, flac, opus, vorbis | 2, 6 (6 needs the 5.1 probe) |
  | ac3 | 2, 6 |
  | eac3 | 2, 6, 8 (8 needs a `7.1` layout) |
  | mp3 | 2 |
  | dts | 2, 6, 8 |
  | truehd | 2, 6, 8 (8 only at 48 kHz with a `7.1` layout) |
  | mlp | 2 |

- DTS by profile: Core 6; 96/24 6; HRA 6 or 8; MA and MA+X 2, 6, or 8. DTS-ES
  is excluded, and above 96 kHz only 6-channel MA is allowed. DTS, TrueHD, and
  MLP play only from Matroska.
- Rates: any integer from 3000 to 192000 Hz, resampled to 48 kHz. The profile
  uses `AudioSampleRate NotEquals 0`, because Jellyfin reuses conditions as
  transcode targets.
- Output channels: `WebGPUPlayer.selectDecodedAudioOutputChannelCount` (host)
  returns 2 when stereo is forced. It returns 6 or 8 when the source has that
  many channels and `destination.maxChannelCount` allows it, and otherwise
  downmixes to 2 with the user's algorithm.

## Gotchas

- Jellyfin ANDs the conditions of every matching CodecProfile
  (`StreamBuilder`). A looser added profile cannot override a stricter one, so
  stock profiles are split by container, and codecs with several routes use
  ApplyConditions.
- Width, Height, VideoLevel, and VideoFramerate are removed only for custom
  containers. Bitrate is stripped everywhere on non-retry profiles.
- HEVC routes expand to every (VideoProfile, VideoRangeType) pair, with
  `VideoBitDepth Equals 0` as the value that always fails. VP9, AV1, and H.264
  are not expanded.
- Generic `Rext` advertises a bit depth only when 4:2:0, 4:2:2, and 4:4:4 at
  that depth are all authorized (`hasCompleteRextBitDepthEnvelope`, host).
- The native external route needs explicit color fields that a profile cannot
  express. Such a source can negotiate DirectPlay and then take the raw route
  or fall back.
- Native decode uses the hint its probes measured
  (`getCustomDecodeHardwareAcceleration`). Only the routes that present the
  decoder's opaque hardware output (native external HDR, the native Dolby
  Vision base, and external Profile 5) prefer hardware. Every other native
  route uses `no-preference`, so a codec without a hardware decoder, such as
  VP8 in Chromium on Windows, decodes in software.
- AC-3, E-AC-3, and PCM have no runtime probe, so the host's
  `appendMeasuredNativeAudioRouteProfiles` never emits its 48 kHz profile.
- These composed routes have no probe vector: DTS 2-channel MA, DTS 6-channel
  HRA, and TrueHD 7.1 at 48 kHz.
- The raw-planes budget (128 MiB per frame or Dolby Vision pair, 2 in flight)
  is enforced only at eligibility and is never advertised.
- `customProfileAugmentationAvailable` (host) stays set for the lifetime of the
  player instance.
- Dolby Vision sources always disable HLS video stream copy, so an HLS fallback
  re-encodes the video.
