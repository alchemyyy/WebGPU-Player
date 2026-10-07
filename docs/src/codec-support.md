# HEVC and Dolby Vision support

This chapter says which HEVC and Dolby Vision sources play through the custom
pipeline, by which route, and on what evidence. It comes from the source and
the unit tests, not from playback. The host's
`jellyfin-webgpu-client.tests/custom/HEVCDirectPlaySupportMatrix.test.ts`
(host) asserts every row:

- negotiation: `isSameSessionNativePlaybackCompatible`, a conservative model of
  Jellyfin's codec profile evaluation, against the profile from
  `augmentDeviceProfileForCustomDecode`, scoped to the item as the host scopes
  it;
- runtime eligibility: `getCustomPlaybackEligibility`;
- DirectPlay, which is both together;
- the exact route selected when every probe and authorization passes.

For representative rows it also asserts the fallback routes, once with native
VideoFrame HDR and Dolby Vision presentation withheld and once without native
HEVC decode.

Read every "Yes" as conditional. The evidence listed for at least one of the
row's routes must pass on the running browser and GPU, the user's Custom decode
setting must be on, and HDR and Dolby Vision rows also need the HDR tone mapping
setting. A retry is never widened. HEVC is advertised only in the containers
that `capability/CustomContainerCodecSupport.ts` pairs with it (MP4, M4V, MOV,
Matroska, MPEG-TS, M2TS). Resolution, level, frame rate, and bitrate are never
gates.

When Jellyfin direct-plays a row that is negotiated but not eligible, the
client rejects it at runtime. It falls back to the HTML player in the same
session when the stock profile covers the source, and otherwise asks for one
renegotiation.

## Plain HEVC

| Variant | Negotiated | Eligible | Route, then fallback | Evidence |
| --- | --- | --- | --- | --- |
| SDR, Main, 8-bit | Yes | Yes | VF-SDR native, then VF-SDR bundled | Native: `video.hevc` or `nativeUltraHDVideo.hevc`. Bundled: `bundledHEVC` Main |
| SDR, Main 10, 10-bit | Yes | Yes | VF-SDR native | `nativeHDRHEVC` |
| HDR10 or HDR10Plus, Main 10, 10-bit | Yes | Yes | VF-PQ, then RAW I420P10 PQ | VF: `nativeHDRHEVC` and `ext-pq`. RAW: `rawHDRVideo.hevc` and `I420P10:bt2020-ncl:bt2020:limited:pq` |
| HLG, Main 10, 10-bit | Yes | Yes | VF-HLG, then RAW I420P10 HLG | VF: `nativeHDRHEVC` and `ext-hlg`. RAW: `rawHDRVideo.hevc` and `I420P10:bt2020-ncl:bt2020:limited:hlg` |
| Unknown range | No | No | None | None |

## Range extensions

| Variant | Negotiated | Eligible | Route | Evidence |
| --- | --- | --- | --- | --- |
| SDR, Rext or a named alias, any of the 9 variants | Yes | Yes | RAW in the variant's exact format, SDR | `hevcRangeExtensions[variant]` and `<format>:bt709:bt709:<limited or full>:sdr`; negotiation needs both the limited and the full key |
| HDR10, HDR10Plus, or HLG, Rext or a named alias, the 6 variants of 10 or 12 bits | Yes | Yes | RAW in the variant's exact format, PQ or HLG | `hevcRangeExtensions[variant]` and `<format>:bt2020-ncl:bt2020:limited:<pq or hlg>` |
| Rext with BitDepth omitted but PixelFormat present | No: the required VideoBitDepth condition cannot match | Yes: the depth is read from PixelFormat | RAW in the variant's exact format | As the matching row |
| Generic Rext monochrome (`gray12le`), or a PixelFormat that contradicts BitDepth | Yes, when the generic Rext depth is advertised | No, `codec-unsupported` | None | None |

Jellyfin reports the generic `Rext` profile, and a profile condition cannot
express chroma format. Generic `Rext` is therefore advertised for a bit depth
and range only when all three chroma formats at that depth pass. Named aliases
are exact per variant. At runtime the PixelFormat must be exact, and an
explicit BitDepth must agree with it.

| Variant | PixelFormat | Raw format | Named alias |
| --- | --- | --- | --- |
| rext420-8 | yuv420p | I420 | None |
| main422-8 | yuv422p | I422 | Main 4:2:2 10 |
| main444-8 | yuv444p | I444 | Main 4:4:4 |
| rext420-10 | yuv420p10le | I420P10 | None |
| main422-10 | yuv422p10le | I422P10 | Main 4:2:2 10 |
| main444-10 | yuv444p10le | I444P10 | Main 4:4:4 10 |
| main12-420 | yuv420p12le | I420P12 | Main 12 |
| main422-12 | yuv422p12le | I422P12 | Main 4:2:2 12 |
| main444-12 | yuv444p12le | I444P12 | Main 4:4:4 12 |

## Dolby Vision

A variant is written as Jellyfin's range label; the Dolby Vision profile and
compatibility ID (CCID); the HEVC profile. Main 10 at 10 bits unless stated.
"Item route" means only the item's own exact route advertises it (see
[Negotiation and routes](negotiation.md#what-the-profile-advertises)).

| Variant | Negotiated | Eligible | Route, then fallback | Evidence |
| --- | --- | --- | --- | --- |
| DOVI, or HDR10 for a CCID outside Jellyfin's set; P5, any CCID or none | Yes | Yes | VF-DV5, then RAW-DV P5 | VF: `nativeDolbyVisionHEVC` and `dovi-p5`. RAW: `rawHDRVideo.hevc` and `dovi-rpu` |
| DOVIWithEL or DOVIWithELHDR10Plus; P7, CCID 6 or 1, MEL or FEL, with or without the EL | Yes | Yes | DV base PQ, then RAW-DV7, then the declared PQ base through RAW | Base: `nativeHDRHEVC`, `ext-pq`, and exact BT.2020 PQ base metadata. RAW-DV7: `rawHDRVideo.hevc` within the two-layer budget and `dovi-p7-base`; the FEL residual also needs `dovi-p7-fel` |
| DOVIWithEL, or HDR10 for a CCID outside Jellyfin's set; P7, any other CCID or none | Yes | Yes | RAW-DV7 only; the CCID declares no base | As RAW-DV7 above |
| DOVIWithHDR10 or DOVIWithHDR10Plus; P8.1, with or without an EL flag | Yes | Yes | DV base PQ, then RAW-DV P8, then the declared PQ base through RAW | Base: as for P7. RAW-DV: `rawHDRVideo.hevc` and `dovi-rpu` |
| DOVIInvalid; P8, CCID 6 (an Ultra HD Blu-ray HDR10 base) | Yes | Yes | As P8.1 | As P8.1; DOVIInvalid comes with the raw Dolby Vision route |
| DOVIWithSDR; P8.2 | Yes | Yes | RAW-DV P8, then the declared SDR base through VF-SDR native | RAW-DV: as P8.1. VF-SDR: `nativeHDRHEVC` |
| DOVIWithHLG; P8.4 | Yes | Yes | DV base HLG, then RAW-DV P8, then the declared HLG base through RAW | Base: `nativeHDRHEVC`, `ext-hlg`, and exact limited BT.2020 HLG base metadata. RAW-DV: as P8.1 |
| DOVIInvalid, or a label by transfer; P8, CCID 0, reserved, none, or a base whose color contradicts its CCID (Jellyfin 12) | Yes | Yes | RAW-DV P8 only | As P8.1 |
| SDR, or HDR10 or HLG by transfer (SDR under a `dvhe` sample entry); P4, CCID 2, MEL or FEL, with or without the EL | Yes | Yes | RAW-DV4, then the declared SDR base through VF-SDR native | RAW-DV4: `rawHDRVideo.hevc` within the two-layer budget and `dovi-p4-base`; the FEL residual also needs `dovi-p4-fel`. VF-SDR: `nativeHDRHEVC` |
| HDR10, HLG, or SDR by transfer (SDR under a `dvh1` sample entry); P20 MV-HEVC, CCID 1, 2, 4, 6, or reserved | Yes | Yes | RAW-DV P8 on the base view, then the declared base through the static routes | As P8.1 |
| As above; P20, CCID 0 or none | Yes | Yes | VF-DV5 on the base view, then RAW-DV P5 | As P5 |
| Any label; P5, P8, or P20 over Rext or a named alias | Item route | Yes | RAW-DV in the variant's exact format, then the declared base through RAW in that format | `hevcRangeExtensions[variant]` and `<format>:dovi-rpu-v1` |
| Any label; P4 or P7 over Rext or a named alias | Item route, when the CCID declares a base | Likewise | The declared base through RAW in the variant's format; dual-layer reconstruction is I420P10 only | As the matching range-extension row |
| DOVIWithSDR or SDR; any profile with CCID 2 over 8-bit Main | Item route | Yes | The declared SDR base through VF-SDR native, then VF-SDR bundled | As SDR Main |

Dolby Vision outside HEVC:

- Profile 9 (AVC, 8-bit) has no RPU route, because the engine owns no AVC
  decode path. Its declared SDR base plays through the H.264 routes. Jellyfin
  labels it by transfer, or SDR under a `dvav` or `dva1` sample entry.
- Profile 10 (AV1) is deferred and never negotiated. The plugin repository's
  `DOLBY_VISION_PROFILE_10_AV1.md` (host) records why, and the work list.
- The retired Profiles 0 to 3 and 6 have no RPU route and present only a
  declared base.

## Rejected at runtime

| Variant | Negotiated | Eligible |
| --- | --- | --- |
| Any DOVI label, DOVIInvalid included, without Dolby Vision configuration fields | Yes | No, `metadata-unsupported` |
| Dolby Vision over 8-bit Main without a declared SDR base | No | No, `hdr-codec-unsupported`: no RPU route reads 8-bit Main |
| A Dolby Vision configuration without an integer profile, without the base layer flag, or with a CCID that is not a 4-bit integer; several video tracks other than a separate P7 pair | Yes, as the reported label | No, `video-track-unavailable` |

## Routes

A route is the eligibility output: `videoOutputMode`, `videoDecoderBackend`,
`rawVideoFrameFormat`, `dolbyVisionProfile`, and `nativeHDRTransfer`.
`WebGPUPlayer.configurePresentationColorPipeline` (host) maps it to a presenter
input mode.

| Route | Eligibility output | Input mode | Notes |
| --- | --- | --- | --- |
| VF-SDR | `video-frame`; `native`, or `bundled-hevc` (hevc.js) for Main only | `external-texture`, identity | |
| VF-PQ, VF-HLG | `video-frame`; `native`; SPS and VUI neutralized to BT.709; transfer `pq` or `hlg` | `external-hdr` | Chrome samples external textures at 8 bits per channel. PQ also applies static mastering metadata |
| DV base PQ, DV base HLG | As VF-PQ or VF-HLG, with `dolbyVisionProfile` null | `external-hdr` | P7 and P8 only. RPU and EL discarded. Preferred over RAW-DV whenever authorized |
| Declared base | An ordinary route, with `dolbyVisionProfile` null | As that route | Used only when no RPU route is selected. RPU and EL discarded |
| VF-DV5 | `video-frame`; `native`; `dolbyVisionProfile` 5 | `external-dolby-vision` | Per-frame Profile 5 RPU, also for a P20 with CCID 0 or none |
| RAW | `raw-planes` in the exact format; `native` (WebCodecs `copyTo`), or `bundled-hevc` for Main 10 I420P10 only | `raw-yuv` | |
| RAW-DV | `raw-planes` in I420P10 for Main 10, or a range-extension variant's exact format; `dolbyVisionProfile` 5 or 8 | `raw-dolby-vision` | RPU reconstruction. A P20 reports the profile it reconstructs as. A signaled EL is discarded |
| RAW-DV7, RAW-DV4 | I420P10 `raw-planes`; `dolbyVisionProfile` 7 or 4 | `raw-dolby-vision`, Profile 7 or 4 | The EL is always decoded by the bundled WASM decoder. MEL reshapes; the FEL residual needs the FEL key and a paired EL frame. Without a paired EL, MEL is still exact and FEL presents its base: the HDR10 base for P7, and the SDR base exactly for P4 (limited BT.709, no tone mapping or dither) |

HDR10+ dynamic metadata is applied on VF-PQ, DV base PQ, and RAW PQ, and
ignored on VF-DV5 and the RAW-DV routes.

## Evidence

Probes, all in `capability/CustomDecodeCapabilities.ts`:

| Probe | Passes on |
| --- | --- |
| `video.hevc` | 1080p Main decode output |
| `nativeUltraHDVideo.hevc` | 4K Main decode output |
| `nativeHDRHEVC` | 4K Main 10 decode output |
| `nativeDolbyVisionHEVC` | The `hev1.2.4.H150.B0` configuration plus Main 10 decode |
| `rawHDRVideo.hevc` | An I420P10 `copyTo` fingerprint, or a bundled Main 10 qualification |
| `bundledHEVC` | hevc.js Main and Main 10 qualifications with pinned fingerprints |
| `hevcRangeExtensions[variant]` | The exact configuration, the two-frame vector, the exact copy format, and pinned fingerprints |

GPU authorizations, all in `validation/`:

| Name | Route key | File |
| --- | --- | --- |
| `ext-pq` | `external-hevc-main10-bt709-limited:pq-v1` | `ExternalHDRPresentationAuthorization.ts` |
| `ext-hlg` | `external-hevc-main10-bt709-limited:hlg-v1` | `ExternalHDRPresentationAuthorization.ts` |
| Raw keys | `<format>:...`, as written in the tables | `RawHDRPresentationAuthorization.ts` |
| `dovi-rpu` | `<format>:dovi-rpu-v1`, one per raw format from I420 to I444P12 | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p4-base`, `dovi-p4-fel` | `I420P10:dovi-profile4-base-v1`, `I420P10:dovi-profile4-fel-v1` | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p7-base`, `dovi-p7-fel` | `I420P10:dovi-profile7-base-v1`, `I420P10:dovi-profile7-fel-v1` | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p5` | `external-I420P10-bt709-limited:dovi-p5-rpu-v1` | `ExternalDolbyVisionPresentationAuthorization.ts` |

`I420P10:dovi-rpu-v1` and the Profile 7 keys are part of the default Dolby
Vision prewarm. The Profile 4 keys and the single-layer keys of other formats
authorize on first use, and the host waits for them before building the profile
and before eligibility, so a stream that needs one is never offered or started
on an unsettled probe.

Other conditions:

- Native VideoFrame HDR and the DV base routes also need explicit
  ColorTransfer, ColorPrimaries, and ColorSpace values.
- The DV base ranges are negotiated per item. Without an exact item match,
  those ranges are advertised only through RAW-DV.
- P20 is MV-HEVC. NAL units with a `nuh_layer_id` above 0, the second view, are
  dropped before decode, and SEI of other layers is ignored.
- A separate-track P7 (a base track and an EL track) selects the same routes.
  `test/capability/CustomPlaybackEligibility.test.ts` covers it; the matrix
  does not, because its negotiation model reads a single video stream.
- An RPU the parser rejects ends the custom session, which then falls back.
  The parser follows FFmpeg's `dovi_rpudec.c`: unknown, misplaced, short, or
  padded display-metadata extension blocks are skipped, and only a block whose
  coded length runs past the payload rejects the RPU.

## Not supported

Each item is neither negotiated nor eligible, unless the tables above say it
is negotiated only.

- HDR10, HDR10Plus, or HLG at 8 bits, under any profile.
- Profile and bit depth contradictions: Main at 10 bits, Main 10 at 8 bits,
  Main 10 at 12 bits.
- 14-bit and 16-bit range extensions.
- Monochrome range extensions, which generic Rext negotiates and the runtime
  rejects.
- High Throughput 4:4:4 profiles, Screen Content Coding (`Screen-Extended`)
  profiles, Main Still Picture, and named Intra aliases such as
  `Main 4:4:4 10 Intra`. Generic Rext with an intra constraint is the ordinary
  variant.
- Interlaced HEVC of any profile or range.
- Dolby Vision:
  - the invalid configurations in the rejected table;
  - Dolby Vision over 8-bit Main without a declared SDR base;
  - dual-layer (P4, P7) reconstruction outside I420P10, where only a declared
    base plays;
  - RPU reconstruction for AVC Profile 9, and all of AV1 Profile 10;
  - RPUs the parser rejects: a component that mixes polynomial and MMR pieces
    (the crate keeps one mapping method per component), polynomial linear
    interpolation, a mapping color space other than YCbCr, or a mapping chroma
    format above 4:4:4.

## Known issues

- The P4 and P7 EL is always decoded by the bundled WASM decoder, but
  eligibility never checks that decoder's qualification. If it fails, playback
  silently drops to the base layer.
- The bundled HEVC decoder's 3840x2160 limit is not modelled in eligibility. A
  larger source on the `bundled-hevc` route fails at decode time instead of
  being declined.
- Firefox on Windows has no WebCodecs HEVC (see
  [Decisions](decisions.md#firefox)), so every row takes its bundled route.
  Main 8-bit SDR plays through `bundled-hevc`, and HDR10, HLG, and Dolby
  Vision through RAW, below real time at 4K. Main 10 SDR and the range
  extensions have no bundled route and are not eligible there.
