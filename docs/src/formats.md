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
| Matroska | H.264, HEVC, VP8, VP9, AV1, MPEG-1, MPEG-2, VC-1, WMV3, MPEG-4 Part 2, H.263, MS-MPEG4, JPEG 2000 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, DTS, TrueHD, MLP, WMA, PCM |
| WebM | VP8, VP9, AV1 | Opus, Vorbis |
| MP4, M4V, MOV, 3GP, 3G2 | H.264, HEVC, VP8, VP9, AV1, VC-1, MPEG-4 Part 2, H.263 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, DTS, TrueHD, PCM |
| MOV, MJ2 | JPEG 2000 | AAC, Opus, FLAC, MP3, Vorbis, AC-3, E-AC-3, PCM |
| MPEG-TS, M2TS, MTS | H.264, HEVC, MPEG-1, MPEG-2, VC-1 | AAC, MP3, AC-3, E-AC-3, DTS |
| AVI | H.264, HEVC, VP8, VP9, AV1, MPEG-4 Part 2, H.263, MS-MPEG4 | AAC, MP3, AC-3, FLAC, Vorbis, WMA, PCM |
| ASF (ASF, WMV, WMA files) | VC-1, WMV3, MPEG-4 Part 2, H.263, MS-MPEG4 | AAC, MP3, AC-3, FLAC, Vorbis, WMA, PCM |
| FLV, MPEG program streams (MPG, VOB), Ogg, RealMedia, MXF, and every other container | Not supported | Not supported |

PCM in Matroska is 8-bit unsigned, 16, 24, or 32-bit integer in either byte order, or little-endian 32 or 64-bit float.
PCM in MP4, M4V, and MOV is 16, 24, or 32-bit integer or 32 or 64-bit float, in either byte order; MOV also carries 8-bit, mu-law, and A-law PCM.
PCM in AVI is 8-bit unsigned, little-endian 16, 24, or 32-bit integer or 32 or 64-bit float, mu-law, or A-law, under its own format tag or as the SubFormat of WAVE_FORMAT_EXTENSIBLE, which FFmpeg writes for a layout other than mono or stereo, a rate above 48 kHz, or integer samples wider than 16 bits.
FLAC and Vorbis in AVI play when their `strf` extradata holds the STREAMINFO block or the three Xiph-laced Vorbis headers, as FFmpeg's muxer writes them.
WMA plays from a Matroska `A_MS/ACM` track and from an AVI or ASF stream, whose WAVEFORMATEX names it by its format tag: 0x0160 WMA v1, 0x0161 WMA v2, 0x0162 WMA Pro, 0x0163 WMA Lossless, and 0x000A WMA Voice, as FFmpeg's RIFF tags do, under its own tag or as the SubFormat of WAVE_FORMAT_EXTENSIBLE.
Any other tag in these containers is refused by its tag.
An AVI audio stream whose format tag the fork names no codec for opens codec-less with its tag, in decimal, as its codec ID, as a video stream of an unknown FourCC does, and keeps its packets timed as FFmpeg's demuxer times them.
The rows come from `capability/CustomContainerCodecSupport.ts`.

AVI plays every packet its indexes list, read as FFmpeg reads them: a stream's OpenDML index when it has one (its `indx` super index and the `ix##` standard index that index locates in each RIFF list), else `idx1`, which covers only the first RIFF list.
An OpenDML file past about 1 GiB, whose later `AVIX` RIFF lists only the OpenDML indexes cover, therefore plays to its end and seeks there.
A video stream that still outruns its index, as in a truncated file or one whose OpenDML index cannot be read in full, is refused rather than stopped where the index ends.
MPEG-4 Part 2 in the packed bitstream of DivX 5 and Xvid, which DivX user data ending in `p` marks, is unpacked to one VOP per packet as FFmpeg's `mpeg4_unpack_bframes` filter does.
AVI keeps no presentation times, only each chunk's slot in decode order, so the fork's AVI demuxer gives H.264 and HEVC packets their pictures' presentation times from the picture order counts in their slice headers, as FFmpeg does, and B-frames play in order on every browser.
The worker restamps MPEG-4 Part 2's B-VOPs into presentation order itself, as it does for Matroska Video for Windows tracks (see [Eligibility and routes](routes.md)).
A video stream whose FourCC the fork names no codec for, such as `DIV3`, `MP42`, or `H263`, opens codec-less with its FourCC as its codec ID, so the MPEG-4 decoder package's route takes it by that FourCC and any other route refuses it by its FourCC.
HEVC in AVI plays under the HEVC, H265, hvc1, and hev1 tags, and under the zero tag FFmpeg's AVI muxer writes unless told one, which the fork recognizes by the parameter sets of the first chunk; FFmpeg, and so Jellyfin, reads such a stream as uncompressed video.
ASF is read by the fork's ASF demuxer, as FFmpeg's `asfdec_f.c` reads it: the Header Object's streams, and each media object reassembled from its payloads (compressed payloads and audio spread included), timestamped by its presentation time less the preroll.
Those timestamps are in decode order, as FFmpeg reads them and as its muxer writes them, so the worker restamps VC-1, WMV3, and MPEG-4 Part 2 B-frames into presentation order, as for Matroska Video for Windows tracks; H.264 and HEVC in ASF, which the fork would hand on in decode order, are refused.
A stream opens by its FourCC or format tag as an AVI stream does: `WVC1` and `WMVA` as VC-1, and WMV3, WMA, and the MPEG-4 Part 2 and MS-MPEG4 FourCCs codec-less, with the FourCC or the tag, in decimal, as its codec ID.
A DRM-protected ASF file (a Content Encryption, Extended Content Encryption, or Advanced Content Encryption Object, or a stream flagged as encrypted) is refused, and so is a live broadcast, whose data packets vary in size; WMV1 and WMV2 have no route.
A `.wma` file is audio only, so it falls back to the host as every audio-only file does.
An AIFF file opens, but the pipeline plays only sources with video, so AIFF, like every audio-only file, falls back to the host.
A track whose edit list Mediabunny cannot honor, as `getUnsupportedFeatures()` reports, is refused rather than played out of sync.

## Video

| Codec | Plays | Decoder | Does not play |
| --- | --- | --- | --- |
| H.264 | Constrained Baseline, Baseline, Main, and High, at 8 bits 4:2:0; High 10, High 4:2:2, High 4:4:4 Predictive, their Intra profiles, High 4:4:4, and CAVLC 4:4:4 at 10-bit 4:2:0, and at 4:2:2 and 4:4:4 at 8 and 10 bits, from raw planes: SDR, and at 10 bits HDR10 and HLG | WebCodecs; the profiles beyond High in software | 8-bit 4:2:0 coded under a profile beyond High, 9, 12, and 14 bits, monochrome, RGB (`gbrp`), and the Multiview, Stereo, and Extended profiles |
| HEVC | Main and Main 10: SDR, HDR10, HDR10+, HLG, and Dolby Vision; the 9 range extensions, 4:2:0, 4:2:2, and 4:4:4 at 8, 10, and 12 bits | WebCodecs, or a GPU decoder package | 14 and 16 bits, monochrome, Screen Content Coding, High Throughput, Main Still Picture, and the named Intra profiles |
| VP8 | Profile 0 | WebCodecs | |
| VP9 | Profile 0 at 8 bits: SDR; Profile 2 at 10 bits: SDR, HDR10, HDR10+, and HLG | WebCodecs; Profile 2 in software | Profiles 1 and 3 (4:2:2 and 4:4:4) |
| AV1 | Main at 8 bits: SDR; Main at 10 bits: SDR, HDR10, HDR10+, HLG, and Dolby Vision Profile 10; High 4:4:4 at 8 and 10 bits and Professional 4:2:2 at 8 and 10 bits from raw planes, Dolby Vision Profile 10 among them | WebCodecs; 10 bits and the High and Professional profiles in software | Professional at 12 bits, which Chrome's WebCodecs refuses, outside a decoder package |
| MPEG-1 | In Matroska and MPEG-TS | A GPU decoder package | Program streams (MPG, VOB), which nothing demuxes |
| MPEG-2 | Every profile, at 4:2:0, 4:2:2, and 4:4:4, in Matroska, MPEG-TS, and M2TS | A GPU decoder package | MP4 and program streams, whose MPEG-2 streams Mediabunny does not read |
| VC-1 | Advanced profile (`WVC1` and `WMVA`), in Matroska, MP4, MOV, MPEG-TS, M2TS, and ASF, in a transport stream with or without its `VC-1` registration descriptor | A GPU decoder package | The Simple and Main profiles, which FFmpeg names `wmv3` (the WMV3 row) |
| WMV3 | The Simple, Main, and Complex profiles, in Matroska and ASF | A GPU decoder package | AVI, MP4, and MPEG-TS |
| MPEG-4 Part 2 | Every profile FFmpeg's decoder decodes at 8 bits, B-VOPs, quarter-pel, and global motion compensation among them, in Matroska (its own tracks and Video for Windows), MP4, MOV, 3GP, AVI, and ASF | A GPU decoder package | Studio profiles and deeper streams, and MPEG-TS, which Mediabunny does not demux it from |
| H.263 | What FFmpeg's `h263` decoder decodes, the H.263+ annexes among them, in Matroska Video for Windows tracks, MP4, MOV, 3GP, AVI, and ASF | A GPU decoder package | A stream FFmpeg names `h263p` or `h263i` |
| MS-MPEG4 | Versions 1, 2, and 3 (DivX 3), in Matroska, AVI, and ASF | A GPU decoder package | MP4 and MOV |
| JPEG 2000 | YUV at 4:2:0, 4:2:2, and 4:4:4, at 8, 9, 10, and 12 bits, and the Digital Cinema profiles' X'Y'Z' at 12 bits, in MOV, MJ2, and Matroska Video for Windows tracks | A GPU decoder package | RGB, grey, and palette pictures, X'Y'Z' below 12 bits or tagged other than BT.709, 11-bit and deeper YUV samples, 4:4:0, 4:1:1, and 4:1:0 chroma, and HTJ2K |

Every other video codec is not supported, among them WMV1, WMV2, Theora, VVC, ProRes, DNxHD, and Motion JPEG.
Eligibility refuses Theora as a known codec with no route (`video-codec-without-route`), and the others as unsupported (`codec-unsupported`).
WebCodecs is the browser's own decoder.
A GPU decoder package is WGSL a host loads, which decodes on the presenter's device; it plays only what no native route plays, and the decoder projects in `wgpud/` build one for HEVC, MPEG-1 with MPEG-2, VC-1 with WMV3, MPEG-4 Part 2 with H.263 and MS-MPEG4, and JPEG 2000.
A package's frames take the format that holds the stream's pixel format, so 4:2:2 and 4:4:4 streams keep their chroma.
The JPEG 2000 package converts X'Y'Z' (`xyz12le`) to R'G'B' as FFmpeg's converter does, gamma 2.6, the XYZ to BT.709 matrix, then gamma 1/2.2, and writes it as limited-range BT.709 Y'CbCr at 12-bit 4:4:4, which presents as an untagged SDR stream's BT.709.

| Property | Plays | Does not play |
| --- | --- | --- |
| Scan | Progressive; interlaced H.264, MPEG-2, MPEG-4 Part 2, VC-1, and WMV3, deinterlaced at double or single rate (see [Architecture](architecture.md#deinterlacing)) | Interlaced HEVC, coded as field pictures, interlaced JPEG 2000, coded as a codestream per field, and interlaced video on a Dolby Vision route |
| Rotation | 0 | Any other rotation |
| Frame size, frame rate, level, and bitrate | Whatever the decoder accepts; none of them is a gate | |
| Color | BT.709, BT.601, and BT.2020 primaries and matrices, raw planes included, which convert SDR outside BT.709 to BT.709; an unknown or unspecified tag takes its transfer's default | Any other tag value |

## HDR

| Format | Plays | Does not play |
| --- | --- | --- |
| HDR10 | HEVC Main 10 and the 10 and 12-bit range extensions, VP9 Profile 2, and AV1 Main at 10 bits | HDR10 at 8 bits |
| HDR10+ | As HDR10, with per-frame metadata from HEVC SEI, AV1 metadata OBUs, or a VP9 track's Matroska or WebM BlockAdditionals | Per-frame metadata for VP9 in MP4, which carries none and plays as HDR10 |
| HLG | As HDR10 | HLG at 8 bits |
| Dolby Vision | Profiles 4, 5, 7 (MEL and FEL), 8, and 20 over HEVC, and Profile 10 over AV1 in any raw format the browser qualifies | RPU reconstruction for Profile 9 (AVC), the retired Profiles 0 to 3 and 6, and Profile 10 at 12 bits in Chrome, which play only a declared base layer |

## Audio

| Codec | Plays | Decoder | Does not play |
| --- | --- | --- | --- |
| AAC | Mono, stereo, 3.0, 5.1, and 7.1, each surround layout once the browser's decoder passes its probe; FFmpeg's channelConfiguration 7 decodes as 7.1 with back and side pairs | WebCodecs | 6.1, and more than 8 channels |
| Opus, FLAC, Vorbis | Mono, stereo, 3.0, 5.1, and 7.1, each surround layout once the browser's decoder passes its probe | WebCodecs | 6.1, and more than 8 channels |
| MP3 | Mono and stereo | WebCodecs | |
| AC-3 | Mono, stereo, 4.1, 5.0, and 5.1; a 5.0 track may gain its LFE mid-stream | The browser's own decoder through MSE when it has one (stereo and 5.1), or an audio decoder package | Three channels; 2/2 with an LFE, whose speaker mask has no layout |
| E-AC-3 | Mono, stereo, 5.1, and 7.1; Dolby Atmos with joint object coding renders its objects into a layout with a speaker its core lacks, heights included, or into binaural stereo, through the `eac3` package, and otherwise plays its core | The browser's own decoder through MSE when it has one, or an audio decoder package | Atmos objects in a stream whose OAMD the parser refuses, which plays its core |
| DTS | Mono, stereo, three channels, 4.1, 5.0, 5.1, 6.1, and 7.1, in every profile the package decodes, DTS-ES included; DTS:X plays its channel bed | An audio decoder package | Four channels (4.0); DTS Express in MP4, which Mediabunny maps but no package decodes; and DTS-UHD in MP4, whose sample entry nothing reads |
| TrueHD | Mono, stereo, and 5.1; 7.1 at 48 kHz; Dolby Atmos renders its 16-channel presentation, bed and objects, into a height layout or binaural stereo, and otherwise plays its 7.1 or 5.1 presentation | An audio decoder package | Atmos objects in the intermediate spatial format, which the renderer refuses; binaural rendering of Atmos at other rates than 48 kHz |
| MLP | Mono and stereo, in Matroska | An audio decoder package | |
| WMA | WMA v1 and v2 in mono and stereo; WMA Pro and WMA Lossless in mono, stereo, three channels, 5.1, and 7.1; WMA Voice in mono; in Matroska, AVI, and ASF (WMV and WMA files) | An audio decoder package | WMA Pro and WMA Lossless in 6.1 |
| PCM | Integer, float, mu-law, and A-law PCM, in mono, stereo, 3.0, or 5.1 | Mediabunny | |

Every other audio codec is not supported, among them MP2, ALAC, AMR, and Speex.
A source whose selected audio track is not supported does not play through the pipeline.
Every route resamples to 48 kHz.
The host's speaker layout setting picks the output layout: `auto` takes 7.1.4 on a device with 12 channels, 7.1.2 with 10, 7.1 with 8, 5.1 with 6, and stereo below; 5.1.2 and 5.1.4 play only when chosen.
Dolby Atmos a package renders as objects plays to the whole layout, or to binaural stereo for headphones when the host asks for it on a stereo output.
Every other source plays within the layout's floor: a three-channel or 5.1 source outputs 5.1, a 7.1 source 7.1, or 5.1 on a 5.1 floor, and everything else downmixes to stereo.

## Subtitles

The engine reads no subtitle track and renders no subtitles, and a source's subtitle tracks never affect its eligibility.
The host draws subtitles over the video: `style.css` keeps the host's subtitle layers (`.videoSubtitles`, libass canvases, and other canvases) above the WebGPU canvas.
