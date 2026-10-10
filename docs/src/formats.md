# Supported formats

This chapter lists what the custom pipeline plays, and what it does not.
A source plays when its container, its video track, and its selected audio track all appear below, and the running browser and GPU pass the route's evidence.
Anything else is ineligible, and the host falls back.
[HEVC and Dolby Vision support](codec-support.md) holds the full HEVC and Dolby Vision matrix, and [Eligibility and routes](routes.md) the checks, routes, and evidence behind every row.

The pipeline plays a direct-play file over http(s).
It does not play live streams, HLS or DASH, or a server transcode.

## Containers

| Container | Video | Audio |
| --- | --- | --- |
| Matroska | H.264, HEVC, VP8, VP9, AV1, MPEG-2, VC-1 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, DTS, TrueHD, MLP, PCM |
| WebM | VP8, VP9, AV1 | Opus, Vorbis |
| MP4, M4V, MOV, 3GP, 3G2 | H.264, HEVC, VP8, VP9, AV1 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, DTS, TrueHD, PCM |
| MOV, MJ2 | JPEG 2000 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, PCM |
| MPEG-TS, M2TS, MTS | H.264, HEVC | AAC, MP3, AC-3, E-AC-3 |
| AVI, FLV, ASF (WMV), MPEG program streams (MPG, VOB), Ogg, RealMedia, MXF, and every other container | Not supported | Not supported |

PCM in Matroska is 8-bit unsigned, 16, 24, or 32-bit integer in either byte order, or little-endian 32 or 64-bit float.
PCM in MP4, M4V, and MOV is 16, 24, or 32-bit integer or 32 or 64-bit float, in either byte order; MOV also carries 8-bit, mu-law, and A-law PCM.
The rows come from `capability/CustomContainerCodecSupport.ts`.

## Video

| Codec | Plays | Decoder | Does not play |
| --- | --- | --- | --- |
| H.264 | Constrained Baseline, Baseline, Main, and High, at 8 bits 4:2:0 | WebCodecs | High 10, High 4:2:2, High 4:4:4, and every other profile |
| HEVC | Main and Main 10: SDR, HDR10, HDR10+, HLG, and Dolby Vision; the 9 range extensions, 4:2:0, 4:2:2, and 4:4:4 at 8, 10, and 12 bits | WebCodecs, or FFmpeg for Main and Main 10 | 14 and 16 bits, monochrome, Screen Content Coding, High Throughput, Main Still Picture, and the named Intra profiles |
| VP8 | Profile 0 | WebCodecs | |
| VP9 | Profile 0 at 8 bits: SDR; Profile 2 at 10 bits: SDR, HDR10, HDR10+, and HLG | WebCodecs; Profile 2 in software | Profiles 1 and 3 (4:2:2 and 4:4:4) |
| AV1 | Main at 8 bits: SDR; Main at 10 bits: SDR, HDR10, HDR10+, HLG, and Dolby Vision Profile 10 | WebCodecs; 10 bits in software | The High and Professional profiles |
| MPEG-2 | Main profile, in Matroska | FFmpeg | Other profiles, and other containers |
| VC-1 | Advanced profile, in Matroska | FFmpeg | The Simple and Main profiles, and other containers |
| JPEG 2000 | 8 bits, in MOV and MJ2 | OpenJPEG | Other bit depths |

Every other video codec is not supported, among them MPEG-4 Part 2 (DivX, Xvid), H.263, MS-MPEG4, MPEG-1, Theora, VVC, ProRes, DNxHD, and Motion JPEG.
WebCodecs is the browser's own decoder; FFmpeg and OpenJPEG run in the engine as WebAssembly.

| Property | Plays | Does not play |
| --- | --- | --- |
| Scan | Progressive | Interlaced, in any codec |
| Rotation | 0 | Any other rotation |
| Frame size, frame rate, level, and bitrate | Whatever the decoder accepts; none of them is a gate | |
| Color | BT.709, BT.601, and BT.2020 primaries and matrices; an unknown or unspecified tag takes its transfer's default | Any other tag value, and 10-bit SDR AV1 or VP9 outside BT.709, whose only route is raw planes |

## HDR

| Format | Plays | Does not play |
| --- | --- | --- |
| HDR10 | HEVC Main 10 and the 10 and 12-bit range extensions, VP9 Profile 2, and AV1 Main at 10 bits | HDR10 at 8 bits |
| HDR10+ | As HDR10, with per-frame metadata from HEVC SEI, AV1 metadata OBUs, or a VP9 track's Matroska or WebM BlockAdditionals | Per-frame metadata for VP9 in MP4, which carries none and plays as HDR10 |
| HLG | As HDR10 | HLG at 8 bits |
| Dolby Vision | Profiles 4, 5, 7 (MEL and FEL), 8, and 20 over HEVC, and Profile 10 over AV1 Main at 10 bits | RPU reconstruction for Profile 9 (AVC), the retired Profiles 0 to 3 and 6, and Profile 10 at 8 bits or outside Main, which play only a declared base layer |

## Audio

| Codec | Plays | Decoder | Does not play |
| --- | --- | --- | --- |
| AAC | Mono, stereo, 3.0, and 5.1 | WebCodecs | More than 6 channels |
| Opus, FLAC, Vorbis | Mono, stereo, 3.0, and 5.1 | WebCodecs | More than 6 channels |
| MP3 | Mono and stereo | WebCodecs | |
| AC-3 | Mono, stereo, and 5.1 | FFmpeg (`@mediabunny/ac3`), or the browser's own decoder through MSE when it has one | Three channels, because 2/1 and 3/0 cannot be told apart |
| E-AC-3 | Mono, stereo, 5.1, and 7.1; Dolby Atmos plays its channel bed | FFmpeg, or the browser's own decoder through MSE when it has one | Atmos objects |
| DTS | Core and 96/24 in mono or 5.1; HRA in mono, 5.1, or 7.1; MA, and MA with DTS:X, in mono, stereo, three channels, 5.1, or 7.1 | libdcadec | DTS-ES, DTS Express, DTS-UHD, and above 96 kHz anything but 5.1 MA |
| TrueHD | Mono, stereo, 5.1, and 7.1 at 48 kHz; Dolby Atmos plays its channel bed | FFmpeg | Atmos objects |
| MLP | Mono and stereo, in Matroska | FFmpeg | |
| PCM | Integer, float, mu-law, and A-law PCM, in mono, stereo, 3.0, or 5.1 | Mediabunny | |

Every other audio codec is not supported, among them MP2, WMA, ALAC, AMR, and Speex.
A source whose selected audio track is not supported does not play through the pipeline.
Every route resamples to 48 kHz.
A three-channel or 5.1 source outputs 5.1 on a device with 6 channels or more.
A 7.1 source outputs 7.1 on a device with 8 channels, and 5.1 on one with 6 or 7.
Everything else downmixes to stereo.

## Subtitles

The engine reads no subtitle track and renders no subtitles, and a source's subtitle tracks never affect its eligibility.
The host draws subtitles over the video: `style.scss` keeps the host's subtitle layers (`.videoSubtitles`, libass canvases, and other canvases) above the WebGPU canvas.
