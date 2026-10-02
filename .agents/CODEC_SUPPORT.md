# HEVC and Dolby Vision DirectPlay Support

This table is derived from static analysis of the current source plus unit
tests; it is not playback evidence. The host's
`webgpu-player-integ-tests/plugins/webGPUPlayer/custom/HEVCDirectPlaySupportMatrix.test.ts`
asserts every row: negotiation (`isSameSessionNativePlaybackCompatible`, a
conservative client model of Jellyfin codec-profile evaluation, against the
`augmentDeviceProfileForCustomDecode` profile), runtime eligibility
(`getCustomPlaybackEligibility`), their conjunction (DirectPlay), and the exact
selected route with every probe and authorization passing. For representative
rows it also asserts the fallback routes with native VideoFrame HDR and Dolby
Vision presentation withheld, and with native HEVC decode absent. Every Yes is
conditional: the named evidence must pass on the running client and GPU device,
`enableWebGPUCustomDecode` must be on, and HDR and Dolby Vision rows also need
`enableWebGPUHDRToneMapping`. Retry negotiation is never widened. HEVC is
advertised only in the containers that `custom/CustomContainerCodecSupport.ts`
pairs with it (MP4/M4V/MOV, Matroska, MPEG-TS/M2TS), and resolution, level,
frame rate, and bitrate are never gates.

## Table

Variant format: VideoRangeType; DV profile and compatibility ID (CCID); HEVC
profile; chroma; bit depth. `Yes*` means yes only when every item in the last
column passes for at least one listed route; otherwise the cell is No.

| Variant | Negotiated | Runtime eligible | Presentation route: preferred, then fallback | DirectPlay | Required evidence |
| --- | --- | --- | --- | --- | --- |
| SDR; no DV; Main; 4:2:0; 8 | Yes* | Yes* | VF-SDR native, then VF-SDR bundled | Yes* | Native: `video.hevc` or `nativeUltraHDVideo.hevc`. Bundled: `bundledHEVC` Main |
| SDR; no DV; Main 10; 4:2:0; 10 | Yes* | Yes* | VF-SDR native only | Yes* | `nativeHDRHEVC` |
| HDR10, HDR10Plus; no DV; Main 10; 4:2:0; 10 | Yes* | Yes* | VF-PQ, then RAW I420P10 PQ | Yes* | VF: `nativeHDRHEVC` + `ext-pq`. RAW: `rawHDRVideo.hevc` + `I420P10:bt2020-ncl:bt2020:limited:pq` |
| HLG; no DV; Main 10; 4:2:0; 10 | Yes* | Yes* | VF-HLG, then RAW I420P10 HLG | Yes* | VF: `nativeHDRHEVC` + `ext-hlg`. RAW: `rawHDRVideo.hevc` + `I420P10:bt2020-ncl:bt2020:limited:hlg` |
| DOVI; P5, CCID 0 or absent; Main 10; 4:2:0; 10 | Yes* | Yes* | VF-DV5, then RAW-DV RPU P5 | Yes* | VF: `nativeDolbyVisionHEVC` + `dovi-p5`. RAW: `rawHDRVideo.hevc` + `dovi-rpu` |
| DOVIWithEL, DOVIWithELHDR10Plus; P7, CCID 6, MEL or FEL, one track; Main 10; 4:2:0; 10 | Yes* | Yes* | DV base PQ, then RAW-DV7 | Yes* | Base: `nativeHDRHEVC` + `ext-pq` + exact BT.2020 PQ base metadata. RAW: `rawHDRVideo.hevc` within the two-layer budget + `dovi-p7-base`; FEL residual also needs `dovi-p7-fel` |
| DOVIWithHDR10, DOVIWithHDR10Plus; P8.1, CCID 1; Main 10; 4:2:0; 10 | Yes* | Yes* | DV base PQ, then RAW-DV RPU P8 | Yes* | Base: `nativeHDRHEVC` + `ext-pq` + exact BT.2020 PQ base metadata. RAW: `rawHDRVideo.hevc` + `dovi-rpu` |
| DOVIWithSDR; P8.2, CCID 2; Main 10; 4:2:0; 10 | Yes* | Yes* | RAW-DV RPU P8 only; no native SDR base route exists | Yes* | `rawHDRVideo.hevc` + `dovi-rpu` |
| DOVIWithHLG; P8.4, CCID 4; Main 10; 4:2:0; 10 | Yes* | Yes* | DV base HLG, then RAW-DV RPU P8 | Yes* | Base: `nativeHDRHEVC` + `ext-hlg` + exact limited BT.2020 HLG base metadata with the EL flag false. RAW: `rawHDRVideo.hevc` + `dovi-rpu` |
| SDR; no DV; Rext or named alias; 4:2:0, 4:2:2, 4:4:4; 8, 10, 12 (9 variants) | Yes* | Yes* | RAW in the variant's exact format, SDR identity | Yes* | `hevcRangeExtensions[variant]` + `<format>:bt709:bt709:<limited or full>:sdr`; negotiation needs both the limited and full keys |
| HDR10, HDR10Plus, HLG; no DV; Rext or named alias; 4:2:0, 4:2:2, 4:4:4; 10, 12 (6 variants) | Yes* | Yes* | RAW in the variant's exact format, PQ or HLG | Yes* | `hevcRangeExtensions[variant]` + `<format>:bt2020-ncl:bt2020:limited:<pq or hlg>` |
| Rext or named alias with BitDepth omitted (PixelFormat present) | No; the required VideoBitDepth condition cannot match | Yes*; the exact depth is inferred from PixelFormat | RAW in the variant's exact format | No | As for the matching Rext row |
| Any DOVI range type except DOVIInvalid, without DV configuration fields; Main 10; 10 | Yes* | No, `metadata-unsupported` | None | No | None |
| P7 with CCID other than 6; P7 without EL; P5 with nonzero CCID; P8.1 with EL; DV P4 (Jellyfin reports SDR); other DV profiles such as 20 | Yes*, as the reported range | No, `video-track-unavailable` | None | No | None |
| Generic Rext monochrome (`gray12le`); Rext PixelFormat that contradicts BitDepth | Yes*, when the generic Rext depth is advertised | No, `codec-unsupported` | None | No | None |
| DOVIInvalid (for example P8 with CCID 6); Unknown range | No | No | None | No | None |

Jellyfin direct-plays rows that are negotiated but not runtime eligible, and the
client then rejects them. It falls back to the same-session HTML player when the
original HTML profile covers the source, and otherwise requests one
renegotiation.

### Routes

A route is the eligibility output (`videoOutputMode`, `videoDecoderBackend`,
`rawVideoFrameFormat`, `dolbyVisionProfile`, `nativeHDRTransfer`). The host's
`WebGPUPlayer.configurePresentationColorPipeline` maps it to a presenter input
mode.

| Route | Eligibility output | Input mode | Notes |
| --- | --- | --- | --- |
| VF-SDR | `video-frame`; `native`, or `bundled-hevc` (hevc.js WASM) for Main only | `external-texture` identity | None |
| VF-PQ, VF-HLG | `video-frame`; `native`; SPS and VUI neutralized to BT.709; transfer `pq` or `hlg` | `external-hdr` | Chrome samples external textures at 8 bits per channel; PQ also applies static mastering metadata |
| DV base PQ, DV base HLG | Same as VF-PQ or VF-HLG with `dolbyVisionProfile` null | `external-hdr` | RPU and EL discarded; preferred over RAW-DV whenever authorized |
| VF-DV5 | `video-frame`; `native`; `dolbyVisionProfile` 5 | `external-dolby-vision` | Per-frame Profile 5 RPU |
| RAW | `raw-planes` in the exact format; `native` WebCodecs `copyTo`, or `bundled-hevc` for Main 10 I420P10 only | `raw-yuv` | None |
| RAW-DV RPU | I420P10 `raw-planes`; `dolbyVisionProfile` 5 or 8 | `raw-dolby-vision` | RPU reconstruction |
| RAW-DV7 | I420P10 `raw-planes`; `dolbyVisionProfile` 7 | `raw-dolby-vision` Profile 7 | EL always decoded by bundled WASM; MEL reshaping; FEL residual only with `dovi-p7-fel` and a paired EL frame, otherwise base fallback |

HDR10+ dynamic metadata is applied on VF-PQ, DV base PQ, and RAW PQ. It is
ignored on VF-DV5 and RAW-DV routes.

### Evidence

**Probes**, all in `custom/CustomDecodeCapabilities.ts`:

| Probe | What passes it |
| --- | --- |
| `video.hevc` | 1080p Main decode output |
| `nativeUltraHDVideo.hevc` | 4K Main decode output |
| `nativeHDRHEVC` | 4K Main 10 decode output |
| `nativeDolbyVisionHEVC` | `hev1.2.4.H150.B0` config plus Main 10 decode |
| `rawHDRVideo.hevc` | I420P10 `copyTo` fingerprint, or a bundled Main 10 qualification |
| `bundledHEVC` | hevc.js Main and Main 10 qualifications with pinned fingerprints |
| `hevcRangeExtensions[variant]` | Exact config, the two-frame fixture, the exact copy format, and pinned fingerprints |

**Authorizations**, all in `validation/`:

| Short name | Route key | File |
| --- | --- | --- |
| `ext-pq` | `external-hevc-main10-bt709-limited:pq-v1` | `ExternalHDRPresentationAuthorization.ts` |
| `ext-hlg` | `external-hevc-main10-bt709-limited:hlg-v1` | `ExternalHDRPresentationAuthorization.ts` |
| Raw keys (`<format>:...`) | As written in the table | `RawHDRPresentationAuthorization.ts` |
| `dovi-rpu` | `I420P10:dovi-rpu-v1` | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p7-base` | `I420P10:dovi-profile7-base-v1` | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p7-fel` | `I420P10:dovi-profile7-fel-v1` | `DolbyVisionPresentationAuthorization.ts` |
| `dovi-p5` | `external-I420P10-bt709-limited:dovi-p5-rpu-v1` | `ExternalDolbyVisionPresentationAuthorization.ts` |

**Other conditions:**

- Native VideoFrame HDR and DV base routes also need explicit ColorTransfer,
  ColorPrimaries, and ColorSpace values.
- Negotiation of the DV base ranges is item scoped. Without an exact item match,
  those ranges are advertised only through RAW-DV.
- Profile 7 separate base-layer and EL track pairs select the same routes.
  `test/custom/CustomPlaybackEligibility.test.ts` covers them. They are not
  matrix rows, because the negotiation model evaluates a single video stream.

### Range-extension variants

Jellyfin reports the generic `Rext` profile, and profile conditions cannot
express chroma format. Generic `Rext` is therefore advertised for a bit depth
and range only when all three chroma variants at that depth pass. Named aliases
are exact per variant. Runtime matching requires an exact PixelFormat, and an
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

## Unsupported boundaries

Each item is neither negotiated nor runtime eligible, unless the table lists it
as negotiated only.

- HDR10, HDR10Plus, or HLG at 8 bits, under any profile.
- Profile and bit-depth contradictions: Main at 10 bits, Main 10 at 8 bits, and
  Main 10 at 12 bits.
- 14-bit and 16-bit range extensions.
- Monochrome range extensions, which are negotiated under generic Rext but
  rejected at runtime.
- High Throughput 4:4:4 profiles, Screen Content Coding (`Screen-Extended`)
  profiles, Main Still Picture, and named Intra aliases such as
  `Main 4:4:4 10 Intra`. Generic Rext with an intra constraint is still the
  normal variant.
- Interlaced HEVC of any profile or range. SDR Main, HDR10 Main 10, Rext, and
  Dolby Vision are each asserted.
- Dolby Vision:
  - DOVIInvalid, Profile 4, and profiles other than 5, 7, and 8;
  - the invalid descriptor shapes in the table;
  - any DV range type on 8-bit Main;
  - DV configuration on Rext or Main 12 sources;
  - base layers that are not 10-bit.

## Known issues

- The Profile 7 EL is always decoded by the bundled WASM decoder, but
  eligibility never checks that decoder's qualification. If it fails, playback
  silently drops to the base layer.
- The bundled HEVC decoder's 3840x2160 limit is not modelled in eligibility. A
  larger source on the `bundled-hevc` route fails at decode time instead of
  being declined.
- `WebGPUPresenter.isRawDolbyVisionPresentationAuthorized()` defaults to the
  active DV profile. During a live Profile 7 session it therefore checks the
  Profile 7 authorization instead of the single-layer one.

## How to extend

Engine paths are relative to this repository; host paths are marked.

1. **Capability.**
   - Add an exact-output probe in `src/custom/CustomDecodeCapabilities.ts`.
   - For range extensions:
     - add the definition in `src/custom/HEVCRangeExtensionCapabilities.ts`;
     - add the fixture to `tools/generate-HEVC-range-extension-fixtures.mjs`,
       and generate it into `fixtures/capability/hevc-range-extension/`;
     - add its served path to `src/EngineAssets.ts`. The asset build serves
       every fixture in that folder, and the `EngineAssets` test checks the
       two agree.
2. **Presentation.**
   - Add the route key in `src/validation/RawHDRPresentationAuthorization.ts`,
     or in the external or DV authorization in the same folder.
   - Add the shader in `src/color/ColorPipelineShader.ts`.
   - Add uploads in `src/RawYUVGPURenderer.ts` and
     `src/custom/RawVideoFrameCopy.ts`.
   - Add raw formats in `src/custom/DecodeWorkerProtocol.ts`.
3. **Negotiation.**
   - `wgp/custom/CustomDeviceProfile.ts` (host) maps evidence to CodecProfile
     conditions.
   - Container pairing stays only in `src/custom/CustomContainerCodecSupport.ts`.
   - Add no resolution, level, frame-rate, or bitrate gates, and no
     decoder-backend pair blacklists.
4. **Runtime.**
   - `src/custom/CustomPlaybackEligibility.ts` selects the route.
   - `src/PresentationInput.ts` parses color and DV descriptors.
   - `wgp/WebGPUPlayer.ts` (host) derives the option flags and configures the
     color pipeline.
5. **Tests.**
   - Add the row, with its expected route and fallbacks, to the host's
     `webgpu-player-integ-tests/plugins/webGPUPlayer/custom/HEVCDirectPlaySupportMatrix.test.ts`.
   - Then update this file.
