# Supported formats

This chapter lists what the custom pipeline plays, and what it does not.
A source plays when its container, its video track, and its selected audio track all appear below, and the running browser and GPU pass the route's evidence.
A codec whose decoder is a package plays only when the host loaded a [decoder package](decoder-packages.md) for it.
Anything else is ineligible, and the host falls back.
[HEVC and Dolby Vision support](codec-support.md) holds the full HEVC and Dolby Vision matrix, and [Eligibility and routes](routes.md) the checks, routes, and evidence behind every row.

The pipeline plays a direct-play file over http(s), or a local `File` the host holds.
It does not play live streams, HLS or DASH, or a server transcode.

## Containers

| Container | Video | Audio |
| --- | --- | --- |
| Matroska | H.264, HEVC, VP8, VP9, AV1, MPEG-1, MPEG-2, VC-1, WMV3 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, DTS, TrueHD, MLP, PCM |
| WebM | VP8, VP9, AV1 | Opus, Vorbis |
| MP4, M4V, MOV, 3GP, 3G2 | H.264, HEVC, VP8, VP9, AV1, VC-1 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, DTS, TrueHD, PCM |
| MOV, MJ2 | JPEG 2000 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, PCM |
| MPEG-TS, M2TS, MTS | H.264, HEVC, MPEG-1, MPEG-2, VC-1 | AAC, MP3, AC-3, E-AC-3, DTS |
| AVI | H.264, VP8, VP9, AV1 | AAC, MP3, AC-3, PCM |
| FLV, ASF (WMV), MPEG program streams (MPG, VOB), Ogg, RealMedia, MXF, and every other container | Not supported | Not supported |

PCM in Matroska is 8-bit unsigned, 16, 24, or 32-bit integer in either byte order, or little-endian 32 or 64-bit float.
PCM in MP4, M4V, and MOV is 16, 24, or 32-bit integer or 32 or 64-bit float, in either byte order; MOV also carries 8-bit, mu-law, and A-law PCM.
PCM in AVI is 8-bit unsigned, little-endian 16, 24, or 32-bit integer or 32 or 64-bit float, mu-law, or A-law.
The rows come from `capability/CustomContainerCodecSupport.ts`.

AVI plays only what its `idx1` index covers: a file whose video stream outruns the index, as an OpenDML file past about 1 GiB does, is refused, since Mediabunny reads no OpenDML index.
AVI keeps no presentation times, so HEVC, whose owned path presents packets as stamped, is refused in AVI; H.264 with B-frames relies on Mediabunny's sample sink to reorder, which WebKit's does not, so on WebKit only Baseline H.264 plays from AVI.
An AIFF file opens, but the pipeline plays only sources with video, so AIFF, like every audio-only file, falls back to the host.
A track whose edit list Mediabunny cannot honor, as `getUnsupportedFeatures()` reports, is refused rather than played out of sync.

## Video

| Codec | Plays | Decoder | Does not play |
| --- | --- | --- | --- |
| H.264 | Constrained Baseline, Baseline, Main, and High, at 8 bits 4:2:0 | WebCodecs | High 10, High 4:2:2, High 4:4:4, and every other profile |
| HEVC | Main and Main 10: SDR, HDR10, HDR10+, HLG, and Dolby Vision; the 9 range extensions, 4:2:0, 4:2:2, and 4:4:4 at 8, 10, and 12 bits | WebCodecs, or a GPU decoder package | 14 and 16 bits, monochrome, Screen Content Coding, High Throughput, Main Still Picture, and the named Intra profiles |
| VP8 | Profile 0 | WebCodecs | |
| VP9 | Profile 0 at 8 bits: SDR; Profile 2 at 10 bits: SDR, HDR10, HDR10+, and HLG | WebCodecs; Profile 2 in software | Profiles 1 and 3 (4:2:2 and 4:4:4) |
| AV1 | Main at 8 bits: SDR; Main at 10 bits: SDR, HDR10, HDR10+, HLG, and Dolby Vision Profile 10 | WebCodecs; 10 bits in software | The High and Professional profiles |
| MPEG-1 | In Matroska and MPEG-TS | A GPU decoder package | Program streams (MPG, VOB), which nothing demuxes |
| MPEG-2 | Every profile, at 4:2:0, 4:2:2, and 4:4:4, in Matroska, MPEG-TS, and M2TS | A GPU decoder package | MP4 and program streams, whose MPEG-2 streams Mediabunny does not read |
| VC-1 | Advanced profile (`WVC1` and `WMVA`), in Matroska, MP4, MOV, MPEG-TS, and M2TS | A GPU decoder package | A transport stream VC-1 stream without its registration descriptor, which Mediabunny skips |
| WMV3 | The Simple, Main, and Complex profiles, in Matroska | A GPU decoder package | ASF (WMV) files, which nothing demuxes |
| JPEG 2000 | YUV at 4:2:0, 4:2:2, and 4:4:4, at 8, 9, 10, and 12 bits, in MOV and MJ2 | A GPU decoder package | RGB, grey, XYZ, and palette pictures, 11-bit and deeper samples, 4:4:0, 4:1:1, and 4:1:0 chroma, and HTJ2K |

Every other video codec is not supported, among them MPEG-4 Part 2 (DivX, Xvid), H.263, MS-MPEG4, WMV1, WMV2, Theora, VVC, ProRes, DNxHD, and Motion JPEG.
Mediabunny identifies MPEG-4 Part 2, but no decoder decodes it, so eligibility refuses it as a known codec with no route (`video-codec-without-route`), as it does H.263, MS-MPEG4, and Theora.
WebCodecs is the browser's own decoder.
A GPU decoder package is WGSL a host loads, which decodes on the presenter's device; it plays only what no native route plays, and the decoder projects in `wgpud/` build one for HEVC, MPEG-1 with MPEG-2, VC-1 with WMV3, and JPEG 2000.
A package's frames take the format that holds the stream's pixel format, so 4:2:2 and 4:4:4 streams keep their chroma.

| Property | Plays | Does not play |
| --- | --- | --- |
| Scan | Progressive; interlaced H.264, MPEG-2, VC-1, and WMV3, deinterlaced at double or single rate (see [Architecture](architecture.md#deinterlacing)) | Interlaced HEVC, coded as field pictures, interlaced JPEG 2000, coded as a codestream per field, and interlaced video on a Dolby Vision route |
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
| AC-3 | Mono, stereo, and 5.1 | The browser's own decoder through MSE when it has one, or an audio decoder package | Three channels |
| E-AC-3 | Mono, stereo, 5.1, and 7.1; Dolby Atmos plays its channel bed | The browser's own decoder through MSE when it has one, or an audio decoder package | Atmos objects |
| DTS | Mono, stereo, three channels, 5.1, and 7.1, in every profile the package decodes; DTS:X plays its channel bed | An audio decoder package | DTS-ES (6.1); DTS Express in MP4, which Mediabunny maps but no package decodes; and DTS-UHD in MP4, whose sample entry nothing reads |
| TrueHD | Mono, stereo, and 5.1; 7.1 at 48 kHz; Dolby Atmos plays its channel bed | An audio decoder package | Atmos objects |
| MLP | Mono and stereo, in Matroska | An audio decoder package | |
| PCM | Integer, float, mu-law, and A-law PCM, in mono, stereo, 3.0, or 5.1 | Mediabunny | |

Every other audio codec is not supported, among them MP2, WMA, ALAC, AMR, and Speex.
A source whose selected audio track is not supported does not play through the pipeline.
Every route resamples to 48 kHz.
A three-channel or 5.1 source outputs 5.1 on a device with 6 channels or more.
A 7.1 source outputs 7.1 on a device with 8 channels, and 5.1 on one with 6 or 7.
Everything else downmixes to stereo.

## Subtitles

The engine reads no subtitle track and renders no subtitles, and a source's subtitle tracks never affect its eligibility.
The host draws subtitles over the video: `style.css` keeps the host's subtitle layers (`.videoSubtitles`, libass canvases, and other canvases) above the WebGPU canvas.
