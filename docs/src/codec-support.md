# HEVC and Dolby Vision support

This chapter says which HEVC and Dolby Vision sources, AV1 Profile 10 included, play through the custom pipeline, by which route, and on what evidence.
It comes from the source and the unit tests, not from playback.
`jellyfin-webgpu-client.tests/custom/HEVCDirectPlaySupportMatrix.test.ts` and `jellyfin-webgpu-client.tests/custom/AV1DirectPlaySupportMatrix.test.ts` (host) assert every row except the `metadata-unsupported` and `video-track-unavailable` rejections:

- negotiation: `isSameSessionNativePlaybackCompatible`, a conservative model of Jellyfin's codec profile evaluation, against the profile from `augmentDeviceProfileForCustomDecode`, scoped to the item as the host scopes it;
- runtime eligibility: `getCustomPlaybackEligibility`;
- DirectPlay, which is both together;
- the exact route selected when every probe and authorization passes.

For representative rows it also asserts the fallback routes, once with native VideoFrame HDR and Dolby Vision presentation withheld and once without native HEVC decode.

Read every "Yes" as conditional:

- the evidence listed for at least one of the row's routes must pass on the running browser and GPU;
- the user's Custom decode setting must be on;
- HDR and Dolby Vision rows also need the HDR tone mapping setting.

A retry is never widened.
HEVC is advertised only in the containers that `capability/CustomContainerCodecSupport.ts` pairs with it (MP4, M4V, MOV, Matroska, MPEG-TS, M2TS, MTS).
Resolution, level, frame rate, and bitrate are never gates.

When Jellyfin direct-plays a row that is negotiated but not eligible, the client rejects it at runtime.
It falls back to the HTML player in the same session when the stock profile covers the source, and otherwise asks for one renegotiation.

## Plain HEVC

| Variant | Negotiated | Eligible | Route, then fallback | Evidence |
| --- | --- | --- | --- | --- |
| SDR, Main, 8-bit | Yes | Yes | VF-SDR native, then VF-SDR bundled | Native: `video.hevc` or `nativeUltraHDVideo.hevc`. Bundled: `bundledHEVC` Main |
| SDR, Main 10, 10-bit | Yes | Yes | VF-SDR native, then RAW I420P10 SDR | VF-SDR: `nativeHDRHEVC`. RAW: `rawHDRVideo.hevc` and `I420P10:bt709:bt709:<limited or full>:sdr`; negotiation needs both keys |
| HDR10 or HDR10Plus, Main 10, 10-bit | Yes | Yes | VF-PQ, then RAW I420P10 PQ | VF: `nativeHDRHEVC` and `ext-pq`. RAW: `rawHDRVideo.hevc` and `I420P10:bt2020-ncl:bt2020:limited:pq` |
| HLG, Main 10, 10-bit | Yes | Yes | VF-HLG, then RAW I420P10 HLG | VF: `nativeHDRHEVC` and `ext-hlg`. RAW: `rawHDRVideo.hevc` and `I420P10:bt2020-ncl:bt2020:limited:hlg` |
| Unknown range | No | No | None | None |

The SDR rows cover every transfer the engine reads as SDR: BT.709, SMPTE 170M, sRGB, and the BT.2020 10 and 12-bit transfers, which use the BT.709 curve.
They take BT.709, BT.601 (SMPTE 170M, SMPTE 240M, or BT.470 BG), or BT.2020 primaries and matrix.
The VF-SDR routes leave the color conversion to Chrome, while the raw SDR keys stay BT.709 only, so Main 10 SDR in BT.601 or BT.2020 color has no raw fallback.

The HLG row includes HLG-compatible streams, whose VUI signals the BT.2020 10-bit transfer and whose alternative transfer characteristics SEI names HLG (see [Other conditions](#evidence)).

## Range extensions

| Variant | Negotiated | Eligible | Route | Evidence |
| --- | --- | --- | --- | --- |
| SDR, Rext or a named alias, any of the 9 variants | Yes | Yes | RAW in the variant's exact format, SDR | `hevcRangeExtensions[variant]` and `<format>:bt709:bt709:<limited or full>:sdr`; negotiation needs both the limited and the full key |
| HDR10, HDR10Plus, or HLG, Rext or a named alias, the 6 variants of 10 or 12 bits | Yes | Yes | RAW in the variant's exact format, PQ or HLG | `hevcRangeExtensions[variant]` and `<format>:bt2020-ncl:bt2020:limited:<pq or hlg>` |
| Rext with BitDepth omitted but PixelFormat present | No: the required VideoBitDepth condition cannot match | Yes: the depth is read from PixelFormat | RAW in the variant's exact format | As the matching row |
| Generic Rext monochrome (`gray12le`), or a PixelFormat that contradicts BitDepth | Yes, when the generic Rext depth is advertised | No: `codec-unsupported`, or for an HDR label `hdr-codec-unsupported`, or `hdr-presentation-unavailable` when the raw HDR key is not authorized | None | None |

Jellyfin reports the generic `Rext` profile, and a profile condition cannot express chroma format.
Generic `Rext` is therefore advertised for a bit depth and range only when all three chroma formats at that depth pass.
Named aliases are exact per variant.
At runtime the PixelFormat must be exact, and an explicit BitDepth must agree with it.

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

A variant is written as Jellyfin's range label; the Dolby Vision profile and compatibility ID (CCID); the HEVC profile.
Main 10 at 10 bits unless stated.
"Item route" means only the item's own exact route advertises it (see [Negotiation and routes](negotiation.md#what-the-profile-advertises)).

| Variant | Negotiated | Eligible | Route, then fallback | Evidence |
| --- | --- | --- | --- | --- |
| DOVI, or HDR10 for a CCID outside Jellyfin's set; P5, any CCID or none | Yes | Yes | VF-DV5, then RAW-DV P5 | VF: `nativeDolbyVisionHEVC` and `dovi-p5`. RAW: `rawHDRVideo.hevc` and `dovi-rpu` |
| DOVIWithEL or DOVIWithELHDR10Plus; P7, CCID 6 or 1, MEL or FEL, with or without the EL | Yes | Yes | DV base PQ, then RAW-DV7, then the declared PQ base through RAW | Base: `nativeHDRHEVC`, `ext-pq`, and exact BT.2020 PQ base metadata. RAW-DV7: `rawHDRVideo.hevc` and `dovi-p7-base`; decoding the EL needs the bundled Main 10 qualification, and the FEL residual also needs `dovi-p7-fel` |
| DOVIWithEL, or HDR10 for a CCID outside Jellyfin's set; P7, any other CCID or none | Yes | Yes | RAW-DV7 only; the CCID declares no base | As RAW-DV7 above |
| DOVIWithHDR10 or DOVIWithHDR10Plus; P8.1, with or without an EL flag | Yes | Yes | DV base PQ, then RAW-DV P8, then the declared PQ base through RAW | Base: as for P7. RAW-DV: `rawHDRVideo.hevc` and `dovi-rpu` |
| DOVIInvalid; P8, CCID 6 (an Ultra HD Blu-ray HDR10 base) | Yes | Yes | As P8.1 | As P8.1; DOVIInvalid comes with the raw Dolby Vision route |
| DOVIWithSDR; P8.2 | Yes | Yes | RAW-DV P8, then the declared SDR base through VF-SDR native | RAW-DV: as P8.1. VF-SDR: `nativeHDRHEVC` |
| DOVIWithHLG; P8.4 | Yes | Yes | DV base HLG, then RAW-DV P8, then the declared HLG base through RAW | Base: `nativeHDRHEVC`, `ext-hlg`, and exact limited BT.2020 HLG base metadata. RAW-DV: as P8.1 |
| DOVIInvalid, or a label by transfer; P8, CCID 0, reserved, none, or a base whose color contradicts its CCID (Jellyfin 12) | Yes | Yes | RAW-DV P8 only | As P8.1 |
| SDR, or HDR10 or HLG by transfer (SDR under a `dvhe` sample entry); P4, CCID 2, MEL or FEL, with or without the EL | Yes | Yes | RAW-DV4, then the declared SDR base through VF-SDR native | RAW-DV4: `rawHDRVideo.hevc` and `dovi-p4-base`; decoding the EL needs the bundled Main 10 qualification, and the FEL residual also needs `dovi-p4-fel`. VF-SDR: `nativeHDRHEVC` |
| HDR10, HLG, or SDR by transfer (SDR under a `dvh1` sample entry); P20 MV-HEVC, CCID 1, 2, 4, 6, or reserved | Yes | Yes | RAW-DV P8 on the base view, then the declared base through the static routes | As P8.1 |
| As above; P20, CCID 0 or none | Yes | Yes | VF-DV5 on the base view, then RAW-DV P5 | As P5 |
| Any label; P5, P8, or P20 over Rext or a named alias | Item route | Yes | RAW-DV in the variant's exact format, then the declared base through RAW in that format | `hevcRangeExtensions[variant]` and `<format>:dovi-rpu-v1` |
| Any label; P4 or P7 over Rext or a named alias | Item route | Yes | RAW-DV4 or RAW-DV7 with the BL in the variant's exact format, then the declared base through RAW in that format | `hevcRangeExtensions[variant]` and `<format>:dovi-profile4-base-v1` or `<format>:dovi-profile7-base-v1`; decoding the EL needs the bundled Main 10 qualification, and the FEL residual also needs the matching FEL key |
| Any label; P5, P8, or P20 over 8-bit Main | Item route | Yes | RAW-DV in I420 through `bundled-hevc`, then (CCID 2) the declared SDR base through VF-SDR native, then VF-SDR bundled | RAW-DV: `bundledHEVC` Main and `I420:dovi-rpu-v1`. VF-SDR: as SDR Main |
| Any label; P4 or P7 over 8-bit Main | Item route | Yes | RAW-DV4 or RAW-DV7 with an I420 BL, both layers through `bundled-hevc`, then the declared base | `bundledHEVC` Main and the I420 dual-layer keys; decoding the EL needs `bundledHEVC` Main 10 |

## Dolby Vision over AV1

Profile 10 is single-layer: the RPU travels in an ITU-T T.35 metadata OBU of each temporal unit, and the base layer is AV1 Main at 10 bits.
RAW-DV here decodes through the engine's own AV1 path, natively in software, into I420P10.
Every AV1 track takes that path, whatever its route, so the declared base of a DOVIWithHDR10Plus stream applies its HDR10+ metadata OBUs too (see [Decisions](decisions.md#video-decode-and-dolby-vision)).
Only an RPU route loads the RPU parser; any other route removes the RPU OBUs without parsing them.

| Variant | Negotiated | Eligible | Route, then fallback | Evidence |
| --- | --- | --- | --- | --- |
| DOVI; P10.0, CCID 0 (an IPT base) | Yes | Yes | RAW-DV P5 only; the CCID declares no base | `rawHDRVideo.av1` and `dovi-rpu` |
| DOVIWithHDR10 or DOVIWithHDR10Plus; P10.1 | Yes | Yes | RAW-DV P8, then the declared PQ base through RAW I420P10 PQ | RAW-DV: as P10.0. Base: `rawHDRVideo.av1` and `I420P10:bt2020-ncl:bt2020:limited:pq` |
| DOVIWithSDR; P10.2 | Yes | Yes | RAW-DV P8, then the declared SDR base through RAW I420P10 SDR | RAW-DV: as P10.0. Base: `rawHDRVideo.av1` and the I420P10 BT.709 SDR keys |
| DOVIWithHLG; P10.4 | Yes | Yes | RAW-DV P8, then the declared HLG base through RAW I420P10 HLG | RAW-DV: as P10.0. Base: `rawHDRVideo.av1` and `I420P10:bt2020-ncl:bt2020:limited:hlg` |
| DOVIInvalid; P10 with CCID 6, a reserved CCID, or a base whose color contradicts its CCID | Yes | Yes | RAW-DV P8; CCID 6 then falls back to its PQ base | As P10.1 |
| HDR10, HLG, or SDR by transfer; P10 without a CCID (Matroska) | Yes | Yes | RAW-DV P5 only; the stream declares no base | As P10.0 |
| Any label; P10 at 8 bits, or outside the Main profile | Item route, with a declared SDR base | Only with a declared SDR base | The declared SDR base through native VF-SDR; no RPU route, because raw AV1 qualifies at 10 bits only | As 8-bit AV1 SDR |

The MP4 `dav1` sample entry of a 10.0 stream maps to no codec in FFmpeg, and so in Jellyfin's probe, so the server never offers such a file for direct play.
The engine maps `dav1` to AV1 itself (see [Decisions](decisions.md#video-decode-and-dolby-vision)), and Matroska 10.0 plays.

Dolby Vision outside HEVC and AV1:

- Profile 9 (AVC, 8-bit) has no RPU route, because the engine owns no AVC decode path.
  Its declared SDR base plays through the H.264 routes.
  Jellyfin labels it by transfer, or SDR under a `dvav` or `dva1` sample entry.
- The retired Profiles 0 to 3 and 6 have no RPU route and present only a declared base.

## Rejected at runtime

| Variant | Negotiated | Eligible |
| --- | --- | --- |
| Any DOVI label, DOVIInvalid included, without Dolby Vision configuration fields | Yes | No, `metadata-unsupported` |
| Dolby Vision over 8-bit Main without a declared SDR base, when the bundled decoder's Main qualification failed | No | No, `hdr-codec-unsupported`: only the bundled decoder reads 8-bit Main raw planes |
| A Dolby Vision configuration without an integer profile, without the base layer flag, or with a CCID that is not a 4-bit integer; several video tracks other than a separate P7 pair | Yes, as the reported label | No, `video-track-unavailable` |

## Routes

A route is the eligibility output: `videoOutputMode`, `videoDecoderBackend`, `rawVideoFrameFormat`, `dolbyVisionProfile`, and `nativeHDRTransfer`, plus `discardDolbyVisionEnhancementLayer` for a dual-layer route without a qualified EL decoder.
`WebGPUPlayer.configurePresentationColorPipeline` (host) maps it to a presenter input mode.

| Route | Eligibility output | Input mode | Notes |
| --- | --- | --- | --- |
| VF-SDR | `video-frame`; `native`, or `bundled-hevc` (hevc.js) for Main only | `external-texture`, identity | |
| VF-PQ, VF-HLG | `video-frame`; `native`; SPS and VUI neutralized to BT.709; transfer `pq` or `hlg` | `external-hdr` | Chrome samples external textures at 8 bits per channel. PQ also applies static mastering metadata |
| DV base PQ, DV base HLG | As VF-PQ or VF-HLG, with `dolbyVisionProfile` null | `external-hdr` | P7 and P8 only. RPU and EL discarded. Preferred over RAW-DV whenever authorized |
| Declared base | An ordinary route, with `dolbyVisionProfile` null | As that route | Used only when no RPU route is selected. RPU and EL discarded |
| VF-DV5 | `video-frame`; `native`; `dolbyVisionProfile` 5 | `external-dolby-vision` | Per-frame Profile 5 RPU, also for a P20 with CCID 0 or none |
| RAW | `raw-planes` in the exact format; `native` (WebCodecs `copyTo`), or `bundled-hevc` for Main 10 I420P10 only | `raw-yuv` | Also 10-bit SDR, through the BT.709 raw SDR keys. AV1 PQ also applies the static mastering metadata of its MDCV and CLL metadata OBUs |
| RAW-DV | `raw-planes` in I420P10 for HEVC Main 10 and AV1, I420 for HEVC Main through `bundled-hevc`, or a range-extension variant's exact format; `dolbyVisionProfile` 5 or 8 | `raw-dolby-vision` | RPU reconstruction. A P10 or P20 reports the profile it reconstructs as. A signaled EL is discarded |
| RAW-DV7, RAW-DV4 | `raw-planes` with the BL in I420P10, in I420 through `bundled-hevc`, or in a range-extension variant's exact format, and an I420P10 EL; `dolbyVisionProfile` 7 or 4 | `raw-dolby-vision`, Profile 7 or 4 | The EL is always decoded by the bundled WASM decoder; without its Main 10 qualification the route discards the EL. MEL reshapes; the FEL residual needs the FEL key and a paired EL frame. Without a paired EL, MEL is still exact and FEL presents its base at the BL's depth: the HDR10 base for P7, and the SDR base exactly for P4 (limited BT.709, no tone mapping or dither) |

HDR10+ dynamic metadata is applied on VF-PQ, DV base PQ, and RAW PQ, and ignored on VF-DV5 and the RAW-DV routes.
HEVC carries it in SEI, and AV1 in ITU-T T.35 metadata OBUs, whose trailing bits the engine removes as dav1d does: it drops the trailing zero bytes, then the byte holding the trailing one bit, which must be 0x80, or the frame's metadata is malformed.
VP9 has no metadata of its own, so Matroska and WebM carry each frame's ITU-T T.35 message beside it in a BlockAdditional, and VP9 in MP4 carries none.
The engine recognizes the message by its T.35 header whatever its BlockAddID, so WebM, which has no BlockAdditionMapping, reads like Matroska, which maps FFmpeg's BlockAddID 4 to the ITU-T T.35 type.
A frame with a Bezier curve follows the curve; a frame without one, such as every profile A frame, tone-maps from its scene peak and average and never reads the targeted display.
A frame without HDR10+ metadata of its own, or whose payload fails to parse, takes the last metadata before it in decode order, as in FFmpeg (see [Decisions](decisions.md#video-decode-and-dolby-vision)).
Conflicting metadata, unsupported metadata, and a curve with a targeted display of 0 tone-map their frame statically and end the carried metadata until the next valid payload.
Each decode attempt and each seek starts without carried metadata.

## Evidence

Probes, all in `capability/CustomDecodeCapabilities.ts`:

| Probe | Passes on |
| --- | --- |
| `video.hevc` | 1080p Main decode output |
| `nativeUltraHDVideo.hevc` | 4K Main decode output |
| `nativeHDRHEVC` | 4K Main 10 decode output |
| `nativeDolbyVisionHEVC` | The `hev1.2.4.H150.B0` configuration plus Main 10 decode |
| `rawHDRVideo.hevc` | An I420P10 `copyTo` fingerprint, or a bundled Main 10 qualification |
| `rawHDRVideo.av1` | A 4K AV1 Main 10 keyframe decoded with `prefer-software` and its I420P10 `copyTo` fingerprint |
| `bundledHEVC` | hevc.js Main and Main 10 qualifications with pinned fingerprints |
| `hevcRangeExtensions[variant]` | The exact configuration, the two-frame vector, the exact copy format, and pinned fingerprints |

GPU authorizations, all in `validation/`:

| Name | Route key | File |
| --- | --- | --- |
| `ext-pq` | `external-hevc-main10-bt709-limited:pq-v1` | `ExternalHDRPresentationAuthorization.ts` |
| `ext-hlg` | `external-hevc-main10-bt709-limited:hlg-v1` | `ExternalHDRPresentationAuthorization.ts` |
| Raw keys | `<format>:...`, as written in the tables | `RawHDRPresentationAuthorization.ts` |
| `dovi-rpu` | `<format>:dovi-rpu-v1`, one per raw format from I420 to I444P12 | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p4-base`, `dovi-p4-fel` | `<format>:dovi-profile4-base-v1`, `<format>:dovi-profile4-fel-v1`, one pair per BL format from I420 to I444P12 | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p7-base`, `dovi-p7-fel` | `<format>:dovi-profile7-base-v1`, `<format>:dovi-profile7-fel-v1`, one pair per BL format from I420 to I444P12 | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p5` | `external-I420P10-bt709-limited:dovi-p5-rpu-v1` | `ExternalDolbyVisionPresentationAuthorization.ts` |

`I420P10:dovi-rpu-v1` and the I420P10 Profile 7 keys are part of the default Dolby Vision prewarm.
The Profile 4 keys in any format, and the Profile 7 and single-layer keys of other formats, authorize on first use, and the host waits for them before building the profile and before eligibility, so a stream that needs one is never offered or started on an unsettled probe.

Other conditions:

- Native VideoFrame HDR and the DV base routes also need explicit ColorTransfer, ColorPrimaries, and ColorSpace values.
- The SPS parser never rejects a VUI color description.
  It maps each code to a WebCodecs name or to unspecified (null), and an SPS without VUI has unspecified color.
  Only the native HDR route check is strict: limited range, BT.2020 primaries, the BT.2020 non-constant-luminance matrix, and the route's transfer.
- The transfer that check reads is the key access unit's alternative transfer characteristics SEI value (payload type 147) when one is present, and the VUI transfer otherwise.
  Without the SEI, VF-HLG and DV base HLG also accept the BT.2020 10 and 12-bit VUI transfers (14 and 15) of HLG-compatible streams.
  An SEI naming another transfer rejects the HLG route, and a malformed SEI counts as absent, as in FFmpeg.
- The DV base ranges are negotiated per item.
  Without an exact item match, those ranges are advertised only through RAW-DV.
- P20 is MV-HEVC.
  NAL units with a `nuh_layer_id` above 0, the second view, are dropped before decode, and SEI of other layers is ignored.
- A separate-track P7 (a base track and an EL track) selects the same routes.
  `test/capability/CustomPlaybackEligibility.test.ts` covers it; the matrix does not, because its negotiation model reads a single video stream.
- An RPU the parser rejects ends the custom session, which then falls back.
  The parser follows FFmpeg's `dovi_rpudec.c`: unknown, misplaced, short, or padded display-metadata extension blocks are skipped, and only a block whose coded length runs past the payload rejects the RPU.
  It also reads what FFmpeg does not: polynomial and MMR pieces mixed within one component, polynomial linear interpolation (see [Decisions](decisions.md#video-decode-and-dolby-vision)), and any mapping color space or chroma format.

## Not supported

Each item is neither negotiated nor eligible, unless the tables above say it is negotiated only.

- HDR10, HDR10Plus, or HLG at 8 bits, under any profile.
- Profile and bit depth contradictions: Main at 10 bits, Main 10 at 8 bits, Main 10 at 12 bits.
- 14-bit and 16-bit range extensions.
- Monochrome range extensions, which generic Rext negotiates and the runtime rejects.
- High Throughput 4:4:4 profiles, Screen Content Coding (`Screen-Extended`) profiles, Main Still Picture, and named Intra aliases such as `Main 4:4:4 10 Intra`.
  Generic Rext with an intra constraint is the ordinary variant.
- Interlaced HEVC of any profile or range.
- Dolby Vision:
  - the invalid configurations in the rejected table;
  - Dolby Vision over 8-bit Main without a declared SDR base, when the bundled decoder's Main qualification failed;
  - RPU reconstruction for AVC Profile 9, and for AV1 Profile 10 at 8 bits or outside the Main profile;
  - RPUs the parser rejects: a linear interpolation piece next to an MMR piece, an RPU format extension, missing sequence information, display metadata compression above method 1, and a header from which no profile is inferred.

## Known issues

- Firefox on Windows has no WebCodecs HEVC (see [Decisions](decisions.md#firefox)), so an HEVC row plays there only through a bundled route.
  Main 8-bit SDR plays through `bundled-hevc`, and Main 10 SDR, HDR10, HLG, and Dolby Vision through RAW, below real time at 4K.
  The range extensions have no bundled route and are not eligible there.
  Firefox decodes 10-bit AV1 to 8-bit `BGRX`, so no raw AV1 route, P10 included, qualifies there.
