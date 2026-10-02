# Negotiation and Routes

How a session goes from player selection to a Jellyfin decision and a concrete
decode/presentation route. Player selection, the device profile, and the
PlaybackInfo requests are host code. Eligibility, the probes, and the route
catalog are engine code. Paths follow the [README](README.md) conventions.
`CustomDeviceProfile.ts` and `NativeDirectPlayCompatibility.ts` are in the
host's `wgp/custom/`. The "stock profile" is the HTML backend's
`getDeviceProfile` result.

## Flow

1. **Select a player (host).** `playbackmanager.js:getPlayer` orders players
   with `PreferredVideoPlayer.ts:orderVideoPlayersByPreference`, then calls
   `WebGPUPlayer.canPlayItem`. When custom decode is enabled, `canPlayItem`
   also requires the engine's metadata-only prefilter
   `CustomPlaybackEligibility.hasPotentialCustomPlaybackVideoRoute`. If that is
   false, the plain HTML player is chosen and negotiates with the stock profile.
2. **Bitrate (host).** `PlaybackBitratePolicy.getPlayerMaxStreamingBitrate`
   returns null for the `playback-selection` purpose. The `transcode-output`
   purpose gets the detected bitrate.
3. **Build the profile (host).** `WebGPUPlayer.getDeviceProfile(item, options)`:
   - A retry is `options.isRetry === true`. A retry returns the stock profile
     unchanged.
   - Otherwise it stores the stock profile as a per-item proof
     (`rememberNativeDeviceProfile`), then strips all bitrate fields and
     conditions (`createBitrateIndependentDeviceProfile`).
   - It returns early if custom decode is disabled or the engine's
     `CustomPlaybackRuntime.getCustomPlaybackRuntimeAvailability` fails (secure
     context, Worker, `navigator.gpu`, `VideoFrame`).
   - It awaits the engine's `probeCustomDecodeCapabilities` and the
     native-media audio probe. The first call on a page blocks PlaybackInfo
     until probes settle.
   - `getHDRDeviceProfileOptions` waits for the GPU authorization prewarms
     relevant to the item's HDR scope (5 s each) and returns the flags and
     route keys.
   - `CustomDeviceProfile.augmentDeviceProfileForCustomDecode` builds the
     result.
4. **Request PlaybackInfo (host).** `playbackmanager.js:getPlaybackInfo` sends
   no `MaxStreamingBitrate`. It sets `AllowVideoStreamCopy=false` when
   `WebGPUPlayer.supportsVideoStreamCopy` vetoes the source (any Dolby Vision
   descriptor). If Jellyfin picks a transcode, a second request carries the
   `transcode-output` bitrate.
5. **Start the session (host).** `WebGPUPlayer.play` consumes the stock-profile
   proof. It sets `currentPlaybackRequiresSourceRenegotiation` when the profile
   was augmented, the method is DirectPlay or DirectStream, and
   `NativeDirectPlayCompatibility.isSameSessionNativePlaybackCompatible` fails
   for the stock profile.
6. **Check eligibility (engine).** The host's `startCustomPlaybackBounded`
   (25 s) and `tryStartCustomPlayback` call the engine's
   `getCustomPlaybackEligibility`, which checks, in order:
   1. `parsePlaybackSource`: DirectPlay, not live, custom container, has a
      duration, http(s) URL.
   2. `selectVideoStream`.
   3. Rotation is 0 and `IsInterlaced === false`.
   4. `selectVideoOutput`.
   5. `selectPlaybackAudio`.
   6. `supportsCustomContainerCodecCombination`.
   7. Runtime budget.
7. **Fall back (host).** An ineligible, timed-out, or failed start falls back:
   - Without the renegotiation flag, the owned HTML player plays the same
     source in the same session.
   - With the flag, `SourceRenegotiationRequired` fires.
     `createPlaybackRetryWithTranscoding` sets `EnableDirectPlay=false`.
     `changeStream` asks `getDeviceProfile` with `isRetry`, so the retry uses
     the stock profile and is never widened.

## augmentDeviceProfileForCustomDecode order (host)

1. Strip bitrate.
2. Find the supported video and audio codecs.
3. Add one DirectPlayProfile per rule in the engine's
   `CUSTOM_CONTAINER_CODEC_RULES`.
4. Add custom subtitle profiles (vtt, ass/ssa, pgssub).
5. Scope the stock video and container conditions to non-custom containers.
6. `widenAuthorizedHDRCodecProfiles`.
7. `appendMeasuredVideoRouteProfiles`. Each route profile requires
   VideoRangeType, VideoBitDepth, `IsInterlaced=false`, and VideoProfile. Codecs
   with several routes are split with ApplyConditions.
8. `appendMeasuredAudioRouteProfiles`.
9. `splitOriginalAudioRouteProfiles`.

## Probes and caching

- **Main thread:** WebCodecs config and decoded-output probes, raw `copyTo`
  fingerprints, the H.264 per-profile probe, and the MSE AC-3/E-AC-3 probe.
- **Dedicated workers:** bundled HEVC (`@hevcjs/core`), DTS (libdcadec),
  TrueHD/MLP (FFmpeg), JPEG 2000 (OpenJPEG), MPEG-2/VC-1 (FFmpeg).
- **GPU:** presentation authorization runs readback through the production
  shaders. Results are cached per `GPUDevice`, canvas format, and shader
  signature, and dropped on device loss.
- **Caching:** each probe is one module-level promise for the page lifetime and
  is never invalidated. `SerializedHeavyCapabilityProbeScheduler` runs heavy
  probes serially, and one timeout makes later heavy probes report a timeout
  until reload.

## Route catalog

| Backend literal | Output | Qualifying evidence | Gate |
| --- | --- | --- | --- |
| `native` SDR | `video-frame` | H.264 per-profile keyframes; HEVC 1080p AU; VP8/VP9/AV1 64x64; 4K variants | `getOrdinarySDRVideoSelection` |
| `native` HEVC Main10 HDR / DV base | `video-frame` plus `nativeHDRTransfer` pq/hlg, neutralized | 4K Main10 AU decode plus external HDR/DV GPU authorization | `supportsNativeMain10HEVC`, `selectNativeDolbyVisionBaseOutput` |
| `native` raw | `raw-planes` I420P10 (HDR/DV), I420..I444P12 (RExt) | `copyTo` plane fingerprints; 9 RExt 192x192 two-AU probes; raw GPU authorization | `supportsRawHDRVideo`, `selectHEVCRangeExtensionVideoOutput` |
| `bundled-hevc` | `video-frame` (Main SDR), `raw-planes` I420P10 | Worker probe: 8-frame fingerprints for main-1080p, main10-1080p, main10-4k | `hasSupportedBundledHEVCProfile` (native wins) |
| `legacy-software` | `video-frame` I420 | MPEG-2 Main / VC-1 Advanced, 12 frames, MKV only | `getLegacyVideoSDRSelection` |
| `openjpeg` | `video-frame` RGBA | 960x540 sRGB fixture, MOV/MJ2 | `getJPEG2000SDRVideoSelection` |
| DTS libdcadec | `decoded-pcm` | 7 fixtures, downmix fingerprints, real-time factor at least 2 | `isSupportedDTSInputRoute` |
| TrueHD/MLP FFmpeg | `decoded-pcm` | 4 fixtures, major-sync recovery, real-time factor at least 2 | `isSupportedTrueHDMetadataRoute` |
| E-AC-3 FFmpeg / AC-3 Mediabunny / PCM | `decoded-pcm` | None at runtime (always marked supported) | `isSupportedEAC3InputRoute` |
| MSE AC-3/E-AC-3 bridge | `native-media` | `isTypeSupported`, fMP4 append, playback advances; 2/6 ch at 48 kHz | `getSupportedNativeMediaAudioRoute` (checked first) |
| WebCodecs aac/opus/flac/mp3/vorbis | `decoded-pcm` | Stereo 48 kHz silence fixtures; separate 5.1 fixtures | `capabilities.audio[codec]` |

## Video route selection (`selectVideoOutput`)

1. **Dolby Vision descriptor** (`PresentationInput.getDolbyVisionPresentationSelection`
   accepts P5 CCID 0/absent, P7 CCID 6 with EL, and P8 CCID 1/2/4; anything else
   is rejected). Routes are tried in this order:
   1. P5 native external.
   2. Native compatible base for P7 HDR10, P8.1 HDR10, or P8.4 HLG. RPU and EL
      are ignored. This needs exact BT.2020 limited base metadata and explicit
      transfer, primaries, and matrix.
   3. Raw RPU reconstruction (`raw-planes` I420P10). P7 runs the FEL shader
      only when `I420P10:dovi-profile7-fel-v1` is authorized.
2. **No color metadata:** `metadata-unsupported`.
3. **HEVC RExt:** an exact variant capability and raw key are required. RExt
   never falls through to the remaining steps.
4. **SDR:** `native`, native Main10 SDR, `bundled-hevc` Main,
   `legacy-software`, or `openjpeg`.
5. **PQ/HLG:** native external
   (`external-hevc-main10-bt709-limited:<pq|hlg>-v1`) first, then raw
   (`<I420P10|I420P12>:bt2020-ncl:bt2020:limited:<pq|hlg>`).

Every HDR/DV flag also requires the user's HDR tone-mapping setting.
`allowRawSDR` only needs a settled `:sdr` raw key. The profile advertises
ranges per item HDR scope. A known-SDR item gets no HDR routes. An item with
missing metadata is scoped "unknown" and gets all of them. The full HEVC
matrix is in [CODEC_SUPPORT.md](CODEC_SUPPORT.md).

**Route keys:**

- Raw: `<I420P10..I444P12>:bt2020-ncl:bt2020:limited:<pq|hlg>` and
  `<I420..I444P12>:bt709:bt709:<full|limited>:sdr`.
- External HDR: `external-hevc-main10-bt709-limited:<pq|hlg>-v1`.
- Dolby Vision raw: `I420P10:dovi-rpu-v1`, `I420P10:dovi-profile7-base-v1`,
  `I420P10:dovi-profile7-fel-v1`.
- Dolby Vision external: `external-I420P10-bt709-limited:dovi-p5-rpu-v1`.

## Audio routes

- **Track:** `DefaultAudioStreamIndex`, else the first audio stream. Codec
  aliases: DCA -> dts, EC-3 -> eac3, TRUE-HD -> truehd.
- **Route order:** the native-media MSE bridge for AC-3/E-AC-3 (2/6 ch, exactly
  48 kHz) comes first. Otherwise `decoded-pcm` when the codec capability and
  input layout qualify.
- **Input channels:**

  | Codec | Channels |
  | --- | --- |
  | PCM | 1/2/6 |
  | aac, flac, opus, vorbis | 2/6 (6 needs the 5.1 probe) |
  | ac3 | 2/6 |
  | eac3 | 2/6/8 (8 needs a `7.1` layout) |
  | mp3 | 2 |
  | dts | 2/6/8 |
  | truehd | 2/6/8 (8 only at 48 kHz with a `7.1` layout) |
  | mlp | 2 |

- **DTS by profile:**
  - Core: 6.
  - 96/24: 6.
  - HRA: 6/8.
  - MA and MA+X: 2/6/8.
  - DTS-ES is excluded.
  - Above 96 kHz only 6-channel MA is allowed.
  - DTS, TrueHD, and MLP are MKV-only.
- **Rates:** any integer from 3000 to 192000 Hz, resampled to 48 kHz. The
  profile uses `AudioSampleRate NotEquals 0`, because Jellyfin reuses
  conditions as transcode targets.
- **Output channels:** the host's
  `WebGPUPlayer.selectDecodedAudioOutputChannelCount` returns 2 if stereo is
  forced. It returns 6 or 8 when the source has that many channels and
  `destination.maxChannelCount` allows it. Otherwise it downmixes to 2 with the
  user's algorithm.

## Gotchas

- Jellyfin ANDs the conditions of every matching CodecProfile
  (`StreamBuilder`). A looser added profile cannot override a stricter one, so
  stock profiles are split by container and multi-route codecs use
  ApplyConditions.
- Width, Height, VideoLevel, and VideoFramerate are removed only for custom
  containers. Bitrate is stripped everywhere on non-retry profiles.
- HEVC routes expand to every (VideoProfile, VideoRangeType) pair, using
  `VideoBitDepth Equals 0` as an always-fail value. VP9, AV1, and H.264 are not
  expanded.
- Generic `Rext` advertises a bit depth only if 4:2:0, 4:2:2, and 4:4:4 at that
  depth are all authorized (`hasCompleteRextBitDepthEnvelope`, host).
- The native external route needs explicit color fields that a profile cannot
  express. Such a source can negotiate DirectPlay and then go raw or fall back.
- Probes use `no-preference` but runtime native decode uses `prefer-hardware`
  (effect unverified).
- AC-3, E-AC-3, and PCM have no runtime probe, so the host's
  `appendMeasuredNativeAudioRouteProfiles` never emits its 48 kHz profile.
- These composed routes have no probe fixture: DTS 2-ch MA, DTS 6-ch HRA,
  TrueHD 7.1 at 48 kHz.
- The raw-planes budget (128 MiB per frame or DV pair, 2 in flight) is enforced
  only at eligibility and is never advertised.
- `customProfileAugmentationAvailable` (host) stays set for the player
  instance's lifetime.
- Dolby Vision sources always disable HLS video stream copy, so any HLS
  fallback re-encodes video.
