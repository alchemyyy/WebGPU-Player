# Decisions

This chapter records settled decisions about the engine.
The Jellyfin plugin's book records the decisions about its integration.
Dates are month-day in 2026, UTC.
Commit hashes refer to the Jellyfin Web fork's `webgpu-player` branch, where the engine was developed until it became its own repository on 10-02.

## Negotiation

- No static performance gates (08-06).
  Width, Height, VideoLevel, VideoFramerate, startup throughput benchmarks, and FPS or headroom tiers were removed from every custom route (`db8dbc7622`).
  A capability means the path implements the codec, profile, and output contract, and vector geometry is output evidence only.
  The real limits stay: codec and profile, bit depth, interlacing, container, and exact decoder acceptance.
  Since 10-15 interlacing limits only HEVC, JPEG 2000, and the Dolby Vision routes (see [Deinterlacing](#deinterlacing)).
- No artificial size limits (10-08).
  Nothing refuses media for its frame size, sample rate, or packet size alone.
  The bundled HEVC, JPEG 2000, and MPEG-2/VC-1 size caps, the raw-copy byte budget, the packet and container read caps, the 3 kHz to 192 kHz audio window, and the per-packet audio frame counts were removed.
  Above 192 kHz the resampler widens its kernel in proportion, so its band edge stays where the 192 kHz qualification put it.
  The real bounds remain: the level's DPB, a representable copy layout, a decoder package's 1 GiB memory and its own header's limits, the device's largest storage binding for a frame pool, the adapter's texture limit, and what a browser decoder accepts.
  Until the CPU decoders left (10-13), the WASM heap bounded them too: 4 GiB for HEVC and MPEG-2/VC-1, and 2 GiB in the prebuilt OpenJPEG decoder.
  Limits that pace or chunk work stay as tuning: transfer credits, queue depths, pending windows, and output chunk sizes.
  So do guards against corrupt data that no real stream reaches, such as header and RPU size bounds and the 2 MiB audio packet bound.
- Live performance adaptation is deferred to a separate runtime controller that would react to sustained drops, queue starvation, underruns, and A/V drift, with warm-up, hysteresis, and cooldown.
- One composition matrix (08-05, `9a1c3f2922`).
  `capability/CustomContainerCodecSupport.ts` decides only whether a container carries a codec.
  Each track is qualified on its own.
  Never add decoder pair blacklists.
- `hasEligibleCustomVideoRoute` answers for one item (10-06).
  Jellyfin labels some Dolby Vision streams in ranges a host's generic routes do not pair with their profile and depth, so the engine tells a host whether this item has a runtime route, and the host advertises exactly that item's route.
  Since 10-16 it judges GPU decoders by package summaries, because offers need the packages and the presenter's device, which negotiation may not have.
  Since 10-27 a summary may carry its package's header, which a host reads from a server's catalog with `parseGPUDecoderHeader` before it has the package, and the buffer limit of the device a playback would decode on.
  With them it runs the offers' fit check, `monochrome` included, so an item past the package's `accepts` conditions or the device's limit, such as an 8K Dolby Vision item on an HEVC base, is not advertised.
  A summary without a header still takes every stream of its codecs and output formats.
- Video probes run per item; audio probes always run (10-08).
  Probing every codec on the first negotiation of a page blocked PlaybackInfo for about 2.6 s, mostly on decoders the item did not contain.
  A video stream cannot change within a negotiation, since another version or item renegotiates, so the video probes follow the item's streams and run on demand.
  An audio track can change during playback, so every audio probe runs for every item.
  A probe outside the selection reads `not-probed`, never a verdict, so an unprobed codec is not advertised.
- Probe downloads run in parallel and outside the decode timeouts (10-08).
  The exact probes armed their timeouts before downloading their vectors and binaries, and the range-extension probes downloaded inside the queue's 2 s timed slot, so a slow cold link failed a capable decoder as unsupported or timed out every later probe.
  A run now starts every selected probe's downloads at once and each probe decodes only once its own are done; decoding stays one probe at a time.
  Worker scripts and glue were warmed in the HTTP cache rather than spawned early, so no worker or compile competed with a running probe's real-time-factor measurement.
  The exact probes and their measurements left with the CPU decoders (10-13), so only the range-extension probes download vectors, and nothing is warmed.
- Probes warm in idle time and their verdicts persist per fingerprint (10-27).
  Even per item, a page's first negotiation waited for its probes, about 2.6 s cold on some clients, and every page load paid it again.
  A warm-up competes with browsing, so each background step waits for an idle period with a 2 s timeout, for no playback, and for 10 s after a negotiation, the time its playback takes to start; its downloads are low priority.
  A negotiation promotes a background probe it needs and never waits behind more than the one background step in the queue; a background timeout halts only the background, so it never poisons a negotiation's probes.
  Clients that ask to save data or have fewer than four threads get no warm-up, since speculative work costs them most; their stored verdicts still rerun after use.
  Only verdicts are stored, keyed by a fingerprint of the host build, the adapter, and the full browser and OS versions, because the user agent alone carries only a major version and a frozen OS.
  What no fingerprint shows, a driver or codec pack change, the acceleration setting, or a software fallback after a GPU process crash, is caught by rerunning each stored verdict after use and by clearing the store when a start it may have admitted fails before its first frame.
- AVI carries only what the fork's AVI demuxer and the engine's routes play (10-15).
  The rule takes H.264, HEVC, VP8, VP9, and AV1 with AAC, MP3, AC-3, FLAC, Vorbis, and the PCM formats WAVEFORMATEX maps, all checked against FFmpeg-made AVI vectors.
  AVI times its chunks in decode order and keeps no presentation times, so HEVC stayed out at first, since the owned HEVC path presents packets as stamped, and on WebKit, whose sample sink orders decoded frames by their packets' timestamps, eligibility refused H.264 that could code B-frames (10-16).
  Since 10-27 the fork's demuxer stamps each H.264 and HEVC packet with its picture's presentation time, from the picture order count in its slice header as FFmpeg derives it, so no route depends on a decoder's or a sink's reordering, and both refusals are gone.
  The pictures of each group from one key frame to the next take that group's frame slots in order count order, delayed by the reorder depth the sequence parameter set declares, which gives FFmpeg's best-effort timestamps; a group's headers are read only when one of its packets is asked for.
  The fork also identifies HEVC under the zero codec tag FFmpeg's AVI muxer writes for it unless told one, by the parameter sets of its first chunk; FFmpeg itself reads such a stream as uncompressed video, so Jellyfin's metadata names it `rawvideo`.
  FLAC, Vorbis, and WAVE_FORMAT_EXTENSIBLE joined the rule once the fork read them (10-27): the fork maps the SubFormat GUID as FFmpeg's `riffdec.c` does, a format tag under the media subtype bases or AC-3 and E-AC-3 by their own GUIDs, and builds FLAC's `fLaC` description from the STREAMINFO in the extradata, while Vorbis's Xiph-laced headers are already WebCodecs's form.
  The fork times a FLAC chunk as one frame whatever block alignment the format declares: FFmpeg's muxer declares the bytes of a sample frame, which FFmpeg's own reader ignores only up to 4 bytes, so it stretches a 5.1 FLAC frame over a minute.
  The fork gives the channel mask through `InputAudioTrack.getChannelMask()`, null where the container declares none, set from the WAVE_FORMAT_EXTENSIBLE header of AVI and WAVE files; a WAVE mask rather than a list of named channels, because the engine's output stage and its decoder packages already speak masks.
  The worker lays Mediabunny-decoded channels out by that mask instead of their count, and refuses a mask the output stage does not qualify rather than play it in the wrong speakers, checked against FFmpeg's decode of 2.1 and 3.0(back) vectors whose third channel is not the front center a count of three means.
  E-AC-3 stays out of the AVI rule: FFmpeg writes it as WAVE_FORMAT_EXTENSIBLE, which the fork now maps, but no vector checks it.
  The fork's demuxer reads each stream's OpenDML index as FFmpeg's `read_odml_index` does, the `indx` super index and the `ix##` standard indexes it locates across the `AVIX` RIFF lists, and keeps a stream to `idx1` when that index cannot be read in full (10-27).
  Until then it read only `idx1`, so the worker refused an OpenDML file's video, which `idx1` covers only up to about 1 GiB, as `opendml-index-unread`.
  `AVIIndexCoverage.ts` still refuses a video track whose stream header's declared length outruns its indexed packets by more than a second, now as `avi-index-incomplete`, rather than stopping where the index ends: a truncated file, or an OpenDML file whose index is damaged.
  Since 10-27 the rule also takes MPEG-4 Part 2, H.263, and MS-MPEG4, which only the `mpeg4` decoder package decodes.
  The fork names only MPEG-4 Part 2 among them, so it keeps an AVI video track of a FourCC it names no codec for, codec-less, with the FourCC as its internal codec ID, as its Matroska demuxer keeps an unknown track, and the worker routes a track whose FourCC FFmpeg's `riff.c` gives one of the package's codecs, such as DIV3, MP42, MPG4, or H263, and refuses any other codec-less track by its FourCC.
  AVI keeps no presentation times for MPEG-4 Part 2 B-VOPs, which the fork's demuxer orders for H.264 and HEVC only, so the worker restamps them as it restamps VC-1 VfW tracks (see "Matroska VC-1 and WMV3 present in picture order").
- The fork's AVI demuxer unpacks DivX packed B-frames (10-27).
  DivX 5 and Xvid's packed bitstream puts a B-VOP after its reference VOP in one chunk and holds the slot it leaves with an N-VOP, so each chunk is one displayed frame.
  The demuxer follows FFmpeg's `mpeg4_unpack_bframes` filter on a stream that DivX user data ending in `p` marks, as FFmpeg's decoder unpacks only such a stream: a chunk of two VOPs gives its first, and the next chunk of one VOP gives the waiting B-VOP, so packets stay one VOP each, in decode order, with their chunks' timestamps.
  Packets are read in any order, so the B-VOP a packet waits on is found by reading back to the last chunk that settles it, and kept per packet.
  Unlike the filter, a key frame of one VOP drops a B-VOP whose N-VOP is missing, so a seek to a key frame reads nothing before it; only a damaged stream differs from FFmpeg's output.
- ASF plays through an ASF demuxer in the fork (10-28).
  Mediabunny reads no ASF, so `.wmv`, `.wma`, and `.asf` files, which Jellyfin names `asf` by ffprobe's format name, fell back to the host; the fork's `src/asf/` follows the ASF specification and FFmpeg's `asfdec_f.c` rather than taking a dependency.
  It reads the Header Object's File Properties (the one data packet size, the preroll, the play duration), Stream Properties (a WAVEFORMATEX, or a BITMAPINFOHEADER and its extradata), the Header Extension's Extended Stream Properties (the average time per frame, and a stream properties object it may embed), Stream Bitrate Properties, the content descriptions as metadata, and the Codec List.
  Data packets are read on demand: each media object is reassembled from its payloads, single, multiple, or compressed into sub-payloads, descrambled when its audio is spread, and timestamped by its presentation time less the preroll; a file cut short ends in the object its last fragment cuts, as FFmpeg's demuxer ends it.
  A key frame search starts from the Simple Index or Index Object when the file has one, and otherwise bisects the data packets by send time, as FFmpeg's `asf_read_pts` does, then reads back in growing windows; every lookup matched a full read of FATE's and FFmpeg's samples, whose packets and data matched `ffprobe -show_packets`.
  It refuses a DRM-protected file (Content Encryption, Extended Content Encryption, or Advanced Content Encryption Object, or a stream flagged as encrypted) and a live broadcast, whose data packets vary in size.
  ASF timestamps are in decode order, as FFmpeg reads them (as `dts`) and as its muxer writes them, so the worker restamps VC-1, WMV3, and MPEG-4 Part 2 B-frames from ASF as it restamps Matroska VfW tracks; H.264 and HEVC are left out of ASF, since the fork has no picture-order timing for them there.
  A frame lasts the Extended Stream Properties' average time per frame, or else the time between the stream's first two media objects, as FFmpeg's muxer writes no such object, so the last anchor's restamped time is a frame past the last packet.
  A stream opens as the AVI demuxer's does: `WVC1` and `WMVA` as VC-1, WMV3 and the MPEG-4, MS-MPEG4, and WMA tags codec-less with the FourCC or tag as their codec ID, and the BITMAPINFOHEADER or WAVEFORMATEX in their stream format, which `VFWStreamFormat.ts` and `WaveFormatAudioConfiguration.ts` read.
  With it, a codec-less AVI MPEG-4, H.263, or MS-MPEG4 track also gets its `strf` extradata as codec private data, rather than none, as FFmpeg's `avidec.c` hands every video stream's extradata to its decoder; FFmpeg's `M4S2` encodes in ASF carry their video object layer only there.
  The VC-1 and WMV3 routes read FourCC codec IDs from ASF streams only, as no container rule places VC-1 in AVI.
- A known codec without a route is refused as such (10-15, 10-27).
  Mediabunny identifies MPEG-4 Part 2, and until 10-27 no WebCodecs decoder or package decoded it, so eligibility answered `video-codec-without-route` for it, H.263, MS-MPEG4, and Theora, and the worker refused an MPEG-4 Part 2 track with `The selected video codec has no decode route: mpeg4`.
  Since 10-27 the `mpeg4` decoder package decodes MPEG-4 Part 2, H.263, and MS-MPEG4 v1 to v3, so they are package-only codecs and the worker's refusal is gone; Theora is the one codec left without a route.
- A track whose edit list Mediabunny cannot honor is refused (10-15).
  `getUnsupportedFeatures()` reports an MP4 or MOV edit list Mediabunny applies only in part, `multiple_edits` or `non_unit_playback_rate`, whose packets it then times as if the rest were absent.
  `UnsupportedTrackFeatures.ts` turns the first reported feature into a refusal of the video or audio track, since playing it would put the track at the wrong times.

## Video decode and Dolby Vision

These were settled on stock Chrome on Windows, with a Chromium 153 source audit.

- Hardware decode output is opaque.
  WebCodecs HEVC Main 10 hardware frames are P010 surfaces with `VideoFrame.format === null`, so `copyTo()` and `allocationSize()` cannot expose planes.
  Exact planes came only from the bundled software HEVC decoder (WASM, CPU), until GPU decoder packages replaced it (10-13); their frames stay in their frame pool.
- The software raw path is too slow for 4K.
  The bundled HEVC decoder that preceded FFmpeg's ran at about 15.3 fps on a 23.976 fps 4K source, and plane extraction plus upload cost about 2.4 ms per frame: low frame rate, then a freeze.
- The GPUExternalTexture path is 8 bits per channel in stock Chrome.
  High-bit-depth frames go through an N32 (8 bpc) surface before page shaders see them (`third_party/blink/renderer/modules/webgpu/external_texture_helper.cc`).
  `copyExternalImageToTexture`, an F16 canvas, ImageBitmap, and WebGL RGBA16F take the same path, and no flag avoids it.
  Native external HDR and Dolby Vision routes therefore tone-map 8-bit-quantized input.
- Native-base-first Dolby Vision (08-08).
  P8.1 (HDR10 base), P7 with CCID 6 (HDR10 base), and P8.4 (HLG base) prefer native `VideoFrame` presentation of the compatible base layer; the RPU and FEL are discarded, and raw reconstruction is the fallback.
  P5 has no compatible base, so it keeps RPU processing, natively through the external P5 route.
- Every Dolby Vision compatibility ID is supported (10-06).
  No 4-bit CCID is rejected.
  RPU reconstruction never reads the CCID.
  The CCID only declares a base layer that can be shown on its own: HDR10 (1) and Ultra HD Blu-ray (6) declare PQ, HLG (4) HLG, and SDR (2) SDR.
  The native base route takes the PQ and HLG bases of P7 and P8, and any declared base is the last fallback after reconstruction.
  Other IDs (0, reserved, none) declare nothing, so those streams need their RPU.
  The raw Dolby Vision route advertises DOVIInvalid for the same reason, and the MPEG-TS dual-PID dependency accepts any CCID.
- Every Dolby Vision profile gets a route (10-06, 10-08).
  P4, P20, P7 without its EL, P8 with an EL flag, and AV1 P10 all play, as do Dolby Vision over Rext, Main 12, or 8-bit Main, MPEG-TS descriptor version 2, and compressed display metadata.
  Routes are tried in this order: native HEVC P5, native AV1 P10 as P5 or P8 (10-27), the native compatible base (HEVC P7, P8), RPU reconstruction, then the declared base through the ordinary routes.
  A stream fails closed only when none applies.
  Reconstruction comes before the declared base, apart from the native-base-first case, because a base without its RPU is not the graded picture.
  P20 reconstructs its MV-HEVC base view, and P10 its AV1 picture, as P5 (CCID 0 or none) or as P8.
  P9 (AVC) has no RPU route, because the engine owns no AVC decode path, and plays its declared base.
- Profile 10 decodes through the engine's own AV1 path (10-08).
  Mediabunny's decoded video samples hide the packet bytes that carry the RPU, so a P10 route reads packets and feeds its own WebCodecs decoder.
  Each temporal unit's Dolby Vision ITU-T T.35 metadata OBUs are removed before decode, so no browser decoder sees them.
  The libdovi T.35 entry point parses them in decode order.
  A temporal unit has exactly one shown frame, so its timestamp keys its RPU, as a PTS keys an HEVC RPU.
  The route profile comes from the container descriptor; the profile the crate infers from the RPU header (5 for 10.0, 8 otherwise) only validates the snapshot.
  P10 at Main 10 reconstructs natively from the hardware AV1 decoder's frames where authorized, as P5 or as P8 whatever base its CCID declares, and otherwise from raw planes, I420P10 for Main at 10 bits, else its AV1 raw format variant's; a declared PQ or HLG base still takes the native AV1 route where its key is authorized (10-27).
  The external route keeps the RPU, where an HEVC P8 prefers its native compatible base without it (08-08), because it reconstructs the graded picture natively, and a base without its RPU is not that picture.
  Every sequence header is neutralized to limited BT.709 on this route without a color check, because the RPU, not the header, describes the picture; Chrome already treats an untagged full-range AV1 frame, as P10.0 signals, as limited BT.709.
  External P8 has its own key, `dovi-p8`, checked with the P8 synthetic RPU and authorized on first use, and the route also needs the AV1 PQ external key, whose vector proves the AV1 decoder's frames import exactly; the P5 and P8 keys check a frame Chrome builds from planes, not a decoded one.
- Every AV1 track decodes through the engine's own AV1 path (10-09).
  HDR10+ and the MDCV and CLL travel in metadata OBUs, which Mediabunny's decoded samples hide as they hide the RPU, and Jellyfin's HDR10Plus label is not a reliable sign of them, so the route does not depend on any label.
  Each temporal unit's OBUs are walked once: its Dolby Vision RPU OBUs are removed before decode on every route, and parsed only on a Dolby Vision route, the one route that loads the RPU parser.
  Its HDR10+ T.35 messages lose their OBU trailing bits as dav1d removes them, then parse as HEVC SEI payloads do, and their OBUs stay in the unit.
  Mediabunny's decoder wrapper has no AV1 workaround, and a unit's one shown frame keeps the unit's timestamp, so frames need no timestamp reassignment.
  The one feature of Mediabunny's sample decoding the owned path drops is the merge of a Matroska alpha channel (BlockAddID 1) into each frame.
  The raw route's request names no transfer, so an AV1 track without an RPU route scans its MDCV and CLL OBUs at startup when its first sequence header signals PQ, and the native external route does the same.
- Every VP9 track on the native backend decodes through the engine's own VP9 path (10-09).
  VP9 has no metadata of its own, so its HDR10+ travels beside each frame in a Matroska or WebM BlockAdditional, which Mediabunny's sample decoding never reads, and Jellyfin's HDR10Plus label is not a reliable sign of it, so the route does not depend on any label.
  Packets decode unchanged, and each packet's BlockAdditionals parse as the ITU-T T.35 messages of HEVC SEI do.
  WebM and MP4 put one shown frame in each packet, a superframe holding any hidden frames before it, and a `show_existing_frame` header shows a frame too, so a packet's timestamp keys its frame's metadata.
  A packet of hidden frames alone, which those containers forbid, records nothing, because the decoder outputs no frame for it.
  The sample sink's alpha merge is the one VP9 feature the owned path drops: Mediabunny decodes a BlockAddID 1 alpha channel with a second decoder and merges it into each frame, while the owned path decodes the color frames only, and the presenter's canvas is opaque.
- Raw AV1, H.264, and VP9 planes prefer software (10-08, 10-27, 10-28).
  Chromium's hardware AV1 and VP9 decoders return opaque 10-bit surfaces whose planes `copyTo` cannot expose, while its software decoders (dav1d, libvpx) return copyable I420P10.
  Raw-plane decode of AV1 and VP9 therefore requests `prefer-software`, in the raw probes and at runtime alike, so the raw HDR, raw SDR, and P10 routes qualify on GPUs with AV1 or VP9 hardware decode.
  Since 10-28 raw-plane H.264 does too: Chrome 156 reports every H.264 profile beyond High unsupported with `prefer-hardware`, while its software decoder, FFmpeg's, decodes them with `no-preference` or `prefer-software`.
  HEVC keeps `no-preference`, because Chromium has no software HEVC decoder.
  Chrome 156's libvpx output pads the coded width of the 4K VP9 probe vector from 3840 to 3904, so a probe that compared the coded size read raw VP9 as unqualified and no raw VP9 route was eligible; since 10-27 the raw probes compare the visible rectangle, which `copyTo` copies and the fingerprint covers.
- Dual-layer reconstruction runs in every raw format (10-08).
  P4 and P7 over a range extension reconstruct with the BL in its own raw format and the EL in I420P10, the only format the bundled EL decoder was qualified for.
  No decoder has decoded an EL since the CPU decoders left (10-13), so these routes reconstruct from the BL alone, and 8-bit Main, which only the bundled decoder read as raw planes, has no RPU route.
  An EL that decodes in another format or at another size than its configuration leaves the stream to its BL, as a failed EL decoder does.
  A frame whose RPU names an EL depth other than 10 bits presents without its EL, because the EL texture holds 10-bit codes.
  The FEL fallback presents the BL at the format's own depth, which the per-frame check holds equal to the RPU's BL depth.
  Each format has its own base and FEL keys; only the I420P10 Profile 7 keys are prewarmed.
- The bundled EL decoder decided whether a dual-layer route decodes its EL (10-08, 10-13).
  The P4 and P7 EL was always decoded by the bundled HEVC decoder.
  Without that decoder's Main 10 qualification, dual-layer reconstruction was still selected, with `discardDolbyVisionEnhancementLayer` set, so the worker created no EL decoder: MEL reconstructs exactly from the BL, and FEL presents its base, which the declared base route would also present.
  Before 10-08 the route started the unqualified decoder and dropped the EL only when it failed.
  Gating the route on the qualification instead would cost MEL its reconstruction and leave P7 with CCID 0 no route.
  Since the CPU decoders left (10-13) no decoder decodes an EL, so every dual-layer route reconstructs from its BL alone, and the flag went with the qualification it read.
  The worker still pairs a separate EL track to read its RPUs, and the presenter keeps its FEL composition for an EL decoder, which no route reaches.
- 8-bit Main Dolby Vision reconstructed through the bundled decoder (10-08), until the CPU decoders left (10-13).
  Native HEVC Main decodes to hardware surfaces that no probe proves copyable, so an 8-bit Main base layer reconstructed from the bundled decoder's I420 planes, with the `I420:dovi-rpu-v1` key or the I420 dual-layer keys.
  It had no RPU route until 10-27, when the frame-pool route began reconstructing an HEVC package's I420 frames; a declared base still plays through the ordinary routes where no package is offered.
- 10-bit SDR has a raw route (10-08, 10-27).
  AV1 Main and VP9 Profile 2 have no 10-bit VideoFrame route, and HEVC Main 10 has none without native decode, so 10-bit 4:2:0 SDR presents from raw I420P10 through the raw SDR keys.
  Those keys were BT.709 only until 10-27, so BT.601 and BT.2020 SDR at 10 bits negotiated, since a profile condition cannot express primaries, and then failed eligibility.
  Since 10-27 every matrix and primaries pair the metadata names has an SDR key in every raw format, and the raw shader converts identity SDR outside BT.709 primaries to BT.709 (`builtin.sdr-gamut`): the BT.709 curve decodes each component, the primaries' linear matrix converts it, the result clips to [0, 1], and the same curve encodes it, as FFmpeg's `colorspace` filter does when the transfer stays.
  The CPU reference does the same in `processEncodedRGB`, and the frame-pool route, which shares the color track, converts too.
  Only the BT.709 keys are prewarmed: the other 270 authorize on first use, so a host waits for the presented stream's own key before eligibility, and their vector doubles the chroma excursion, since the original vector moved BT.470 BG by only 2.4/255 under a 3/255 tolerance.
  The same route presents a declared 10-bit SDR base, such as P10.2's.
- AV1 outside Main 10 qualifies its exact raw format (10-27).
  Chrome's software decoder (dav1d, `prefer-software`) decodes AV1 Main at 8 bits, High 4:4:4 at 8 and 10 bits, and Professional 4:2:2 at 8 and 10 bits, and copies each to its exact WebCodecs format; it refuses 12-bit AV1 at `decode()`, so the 12-bit variants read unsupported there.
  Each of the eight variants has a probe of its own, as the HEVC range extensions do, with 192x192 libaom vectors of one key and one inter temporal unit and pinned libdav1d fingerprints.
  High and Professional streams present from their exact format before a GPU decoder package, and Dolby Vision Profile 10 at 8 bits or outside Main reconstructs from it, where before 10-27 it had no RPU route and played only a declared base.
  8-bit Main SDR keeps its VideoFrame route; its I420 probe serves only Dolby Vision.
- H.264 beyond 8-bit 4:2:0 qualifies its exact raw format (10-28).
  On Chrome 156.0.8078.49 on Windows, WebCodecs decodes libx264 Annex B streams of every High-family profile in software and copies each to its exact format: High 10 at 4:2:0 to I420P10, High 4:2:2 to I422 and I422P10, and High 4:4:4 Predictive to I444 and I444P10, lossless included.
  `isConfigSupported` accepts their codec strings, such as `avc1.6E000C`, `avc1.7A000C`, and `avc1.F4000C`, with `no-preference` and `prefer-software`, and refuses them with `prefer-hardware`; High at 8-bit 4:2:0 decodes to NV12 in hardware or I420 in software.
  Each of the five variants, 10-bit 4:2:0 and 4:2:2 and 4:4:4 at 8 and 10 bits, has a probe of its own with a 192x192 libx264 vector of an I, a P, and a B access unit and FFmpeg's fingerprints, since Chrome's software H.264 decoder is FFmpeg's and FFmpeg's decode is bit-exact.
  The engine's probes passed on that Chrome with those fingerprints, which hold only in presentation order, and failed with a fingerprint changed or with decode-order expectations.
  The intra profiles, the removed High 4:4:4, and CAVLC 4:4:4 decode with the same decoder, so a stream takes the variant of its pixel format under any profile beyond High that codes that chroma format.
  The worker decodes such a track through Mediabunny's sample path, as native H.264, rather than an owned path like HEVC's and AV1's, which exist to read metadata the sample path hides; the sample path already reads avcC and Annex B, orders B frames, and works around Chromium's interlaced AVC bug, and H.264 carries no metadata the raw route reads.
  10-bit PQ and HLG present through the raw HDR keys of the variant's format, as the HEVC range extensions do.
  8-bit 4:2:0 coded under a profile beyond High, such as x264's lossless High 4:4:4 Predictive, stays unsupported: it is no variant, and the native route qualifies only the profiles up to High.
  8-bit High keeps its VideoFrame route.
- Single-layer profiles discard a signaled EL (10-06).
  P5, P8, and P20 have no EL composition, so their EL flag is ignored and in-band EL NAL units are dropped.
  A P4 or P7 frame without a paired EL presents MEL exactly, because a MEL carries no residual, and FEL as its base layer: the HDR10 base for P7, and the SDR base exactly for P4, with no tone mapping or dither.
- The `dolby_vision` crate is vendored and patched (10-06, 10-08).
  It is copied from dovi_tool rev `38adec0` into `wasm/libdovi/vendor/dolby_vision/`, and its `PATCHES.md` lists every deviation.
  The bridge in `wasm/libdovi/src/lib.rs` adds what the crate lacks: a reuse cache for compressed display metadata, Profile 4's 2^30 YCC offset scale, and every mapping color space and chroma format.
  Since 10-15 it also takes the container's profile for an RPU whose header reveals none, as FFmpeg takes the configuration record's (`dovi_parser_set_container_profile`, from the worker's RPU profile); a header that reveals its profile keeps it.
  And an RPU's own header decides its layer, as FFmpeg's `use_nlq` does: a single-layer RPU that reuses a dual-layer mapping stays single-layer, and a dual-layer one that reuses a mapping stored without NLQ is a MEL whose residual adds nothing, where both were rejected before, one by the host's layer check and one by the bridge.
  Every color space and chroma format works because the composer maps the decoded components as they are and the RPU's own matrices convert them, as for Profile 5's IPT.
  The AV1 EMDF container is bounded before it sizes a buffer, and since 10-27 its payload size must lie between 6 and 512 bytes and its protection bits read 0x400, as FFmpeg requires.
  Upstream rejected syntax that FFmpeg's `dovi_rpudec.c` accepts, so the patches follow FFmpeg:
  - header limits widened to FFmpeg's (8 to 16-bit layers, coefficient precision up to 32 bits, no mapping color space or chroma check);
  - a mapping method per piece rather than per component;
  - unsupported syntax as a typed error;
  - panics returned as errors;
  - display-metadata extension blocks framed and bounded as `parse_ext_blocks` does (10-27).
    A block whose coded length runs past the data or falls short of its level's fields, an L2 `ms_weight` below -1, and more than 7 static or 25 dynamic blocks in one RPU reject it, as in FFmpeg.
    An L1 in the CM v4.0 section is kept with its fields zeroed, as FFmpeg keeps it, so an RPU whose CM v2.9 section codes no L1 presents one of zeros.
    Unknown and other misplaced levels, and L8, L9, or L10 lengths without a defined layout, are skipped, where FFmpeg keeps them zeroed or partly read, because nothing reads them.
    Until 10-27 a short block was skipped and a misplaced L1 dropped, so that any valid L1 survived, and the block count was bounded only by the input size; the parser now rejects and keeps what FFmpeg does.
  - the end of an RPU read as FFmpeg reads it (10-27).
    The CRC32 and the 0x80 terminator follow the metadata and its alignment bits at once, so leftover bits before the CRC32 reject the RPU, alignment bits of any value are skipped, and bytes after the terminator are ignored.
    The CRC32 is not verified, because FFmpeg verifies it only when asked to and even then only logs a mismatch.
    A CM v4.0 section is read when more than 48 bits remain after the CM v2.9 section, FFmpeg's test.
    Until 10-27 upstream's reading held: the last five bytes were the CRC32 and terminator, bits between them and the metadata were kept, nonzero alignment bits and a CRC32 mismatch rejected the RPU, and so did bytes after the terminator.
- Mixed pieces and linear interpolation are packed per segment (10-08).
  A component may mix polynomial and MMR pieces, as FFmpeg reads them, so the snapshot (schema 2) stores the method per segment: an MMR segment has an order above 0 in its last slot.
  Polynomial linear interpolation, which FFmpeg rejects for lack of samples and ETSI GS CCM 001 V1.1.1 does not define, is read as annex A of US 10,701,399 B2 codes it.
  A piece carries the curve's rise to its start pivot from the previous pivot's value, the first piece its start value outright, and the last piece also the rise to its end pivot.
  The annex leaves a polynomial neighbor's value undefined, so the bridge takes a polynomial piece's value at its start pivot as the value a following linear piece rises from, and ends a linear piece before a polynomial continuously with it.
  Each linear piece is packed as the order-1 polynomial between its pivots' values.
  A linear piece next to an MMR piece is rejected: an MMR piece maps all three components together, so it has no scalar value to rise from or end on.
  The revision prefix names the vendored dovi_tool commit; the schema version is what a snapshot's readers check.
- Per frame, a snapshot's header is read, not the whole snapshot (10-15).
  The worker's parser validates each whole snapshot once, curves and MMR data included, when it parses the RPU.
  The worker boundary, the EL classification, and the presenter's single- and dual-layer checks used to decode the whole 3,232 bytes again for every frame to read five header fields; `readDolbyVisionRPUSnapshotHeader` reads only those, still checking the length, the schema, the revision, and that the flags agree with the profile.
- Each HEVC packet's NAL units are walked once (10-15).
  The owned HEVC path walked every packet three times: twice in the HDR10+ queue, for its base-layer picture check and its SEI parse, and once in the Dolby Vision split, which then rebuilt the BL into a new buffer even when it removed nothing.
  The worker now walks each packet once and passes the NAL units to both, as the AV1 path passes its OBUs, and the frame-pool route's HDR10+ queue walks its packet once.
  The split returns the input itself when it removes nothing, and a view of the input's leading bytes when it removes only trailing NAL units, as Dolby Vision streams carry their RPU and an interleaved EL after the BL.
  Only a removal ahead of a BL NAL unit rebuilds the BL, with four-byte start codes.
  An Annex B packet from MPEG-TS or M2TS therefore reaches the native decoder with its own three-byte start codes, and with the zero bytes Mediabunny leaves at its end when the stream puts zeros ahead of the next start code.
  Chromium's hardware HEVC decoder takes both forms (10-27): Main 10, HDR10, and Dolby Vision Profile 8.1 streams in MPEG-TS and M2TS, unchanged packets and leading-bytes views alike, decoded every frame on the native route with the timestamps FFprobe reports.
  A buffer the engine allocated for one decode, a rebuilt BL, an AV1 temporal unit without its RPU, or a sanitized or color-neutralized access unit, moves into its `EncodedVideoChunk` through `transfer` instead of being copied.
  A packet's own bytes may share Mediabunny's read buffer, so they and any view of them are copied.
  The native decoder's own walks stay: its RASL check reads only the leading pictures after a key packet, its Chromium sanitizing only the first packet, and its color rewrite only access units whose framing and NAL unit headers show a base-layer SPS (see Native HDR neutralization below).
- Mediabunny's Dolby Vision sample entries are mapped in the engine (10-06).
  Mediabunny 1.52.2 parses `dvh1`, `dvhe`, `dva1`, `dvav`, and `dav1` but gives them no codec.
  `ISOBaseMediaDolbyVisionSampleEntry.ts` writes the wrapped codec into the track's internal info, contained the way `MatroskaVFWVideoConfiguration.ts` is, so Mediabunny itself stays unmodified.
  Mediabunny 1.61.5 still gives them no codec (10-15).
  The fork reads `dvh1` and `dvhe` as HEVC, `dva1` and `dvav` as AVC (`avc1` and `avc3`), and `dav1` as AV1 (branch `v2-isobmff-dolby-vision-sample-entries`), so `ISOBaseMediaDolbyVisionSampleEntry.ts` left, and every track's decoder configuration is the one the engine assigned (10-27).
- AV1 codec strings come from the bitstream (10-08).
  Without an `av1C` record, as in every Matroska track, Mediabunny 1.52.2 reads the first packet's sequence header, but it reads `decoder_model_info_present_flag` without timing info and the initial display delay flag once per operating point.
  Its `color_config` also skips the color description and range, and takes the Professional profile below 12 bits as 4:2:0.
  Every field after the operating points comes out wrong: a 10-bit Profile 10 Matroska vector reads as 8-bit and monochrome.
  `AV1DecoderConfiguration.ts` parses the first packet's sequence header as the specification defines it and replaces the cached decoder configuration's codec string before the first `getDecoderConfig()` or `canDecode()`, so `canDecode()` and the owned AV1 path use the stream's own string.
  It is contained the same way, and leaves a track whose first packet has no sequence header untouched.
  Mediabunny 1.61.5 reads bit depth, monochrome, and chroma format correctly (10-15), but a header without a color description still gets the optional fields with BT.709 code points it never declared, so the replacement stays and leaves them out.
  That short form was itself the defect: the AV1 ISOBMFF binding takes monochrome, chroma, and range from the sequence header and, without a color description, says the color fields should be BT.709's 01, as Mediabunny writes them, so the replacement dropped monochrome, 4:4:4 and 4:2:2 chroma, and full range, and a 4:4:4 stream's string declared 4:2:0, which the native route's chroma format then read (10-27).
  The fork also writes an explicit 2/2/2 color description as 02.02.02, where Mediabunny read it as none, and leaves the optional fields out when a reserved code point past 99 cannot fill two digits (branch `v2-av1-codec-string`), so `AV1DecoderConfiguration.ts` and `AV1CodecParameterString.ts` are gone and the worker takes Mediabunny's string (10-27).
  Chrome supports and decodes the full strings of 4:4:4, 4:2:2, monochrome, and full-range streams on every route it supported their short forms, and 4:2:0 limited-range streams keep their strings (10-27).
- Mediabunny's dropped BlockAdditionals are recovered in the engine (10-09).
  Mediabunny 1.52.2 parses every BlockMore but keeps only BlockAddID 1, the alpha channel, so VP9 HDR10+ never reaches a packet's side data.
  An upstream change would wait for a release, and a patch to the installed package is lost on every install, so `MatroskaBlockAdditions.ts` contains the fix, as `ISOBaseMediaDolbyVisionSampleEntry.ts` and `AV1DecoderConfiguration.ts` contain theirs.
  The worker's `Input` wraps its Matroska and WebM formats in place, and each demuxer they create records every finished BlockMore against its block, before it reads any cluster, at the point where Mediabunny resets its `currentBlockAdditional` field.
  A packet finds its block through the track backing's packet-to-cluster map, which Mediabunny keeps for its own navigation.
  Each internal is shape-checked: when one differs, demuxing proceeds untouched and reads no additions, with one console warning, and `test/demux/MatroskaBlockAdditions.test.ts` fails on the committed vectors.
  HDR10+ is recognized by its ITU-T T.35 header, not by BlockAddID, so no BlockAdditionMapping is needed: FFmpeg writes BlockAddID 4 with a mapping in Matroska and without one in WebM, and reads it either way.
  A laced block keeps no additions, because Mediabunny replaces it with one new block per frame; Matroska muxers lace audio, not video.
  Mediabunny 1.61.5 still keeps only BlockAddID 1 (10-15).
  The fork's Matroska demuxer keeps every BlockAdditional but alpha as packet side data, `matroskaBlockAdditions`, each frame of a laced block taking its block's (branch `v2-matroska-block-additions`), so the format wrapper, its shape checks, and its warning left, and `MatroskaBlockAdditions.ts` only reads the side data (10-16).
- Header-stripped laced Matroska blocks are split before their content is decoded (10-09).
  Older mkvmerge releases moved the leading bytes of every AC-3, DTS, and MP3 frame into the track's ContentCompression (header stripping), and laced audio by default.
  The Matroska specification scopes a block's content encoding to its frames, excluding the lacing data, and FFmpeg reads it that way.
  Mediabunny 1.52.2, and 1.61.3 and the fork's 1.61.5 too, restores the stripped bytes ahead of a laced block's lace header, so it misreads the frame count and no frame decodes.
  `CustomDecodeInputFormats.ts` gives the worker a Matroska format whose demuxer splits such a block as stored and then restores each frame's bytes, contained as `MatroskaBlockAdditions.ts` is, which wraps it in turn.
  When the internals differ, demuxing proceeds untouched with one console warning, and `test/demux/CustomDecodeInputFormats.test.ts` fails.
  Its last case fails once Mediabunny itself reads such blocks correctly, and the replacement can then go.
  The fork splits a laced block as stored and restores each frame's bytes itself (branch `fix-matroska-laced-header-stripping`), so the replacement format and its last case left; `test/demux/CustomDecodeInputFormats.test.ts` still reads every lacing through the worker's formats (10-16), and is `test/demux/MediabunnyDemuxIntegration.test.ts` since those are Mediabunny's own (10-27).
  Mediabunny 1.62 splits such a block before decoding each frame's content too, which the fork's `v2` took with upstream's `main` (10-27).
- A custom decoder's failure is reported once (10-09).
  After a Mediabunny custom decoder rejects, Mediabunny 1.52.2 queues the decoder's `close()` behind the failed call without a handler, so the same error resurfaces as an unhandled rejection and the decoder is never closed.
  The worker marks every failure it catches (`HandledDecodeFailures.ts`) and prevents the unhandled-rejection report of a marked error only, so any other unhandled rejection is still reported.
  The unclosed decoder ends with its worker: the session replaces a worker whose run failed, and a worker that suppressed such a rejection asks for its replacement in its next `stopped`.
  Mediabunny 1.61.5 still chains `close()` with `void` behind the rejected call (10-15).
  The fork closes a custom decoder even after one of its calls failed, and reports a failing `close()` as a decoder error (branch `fix-custom-decoder-close-after-failure`), so `HandledDecodeFailures.ts` and the worker's replacement for an unclosed decoder left; a run's failure still retires its worker (10-16).
  The same branch closes a custom encoder after a failed `encode()` or `flush()`, which the engine never runs (10-16).
- The bundled HEVC decoder was FFmpeg's (10-10), until the CPU decoders left (10-13).
  hevc.js (`@hevcjs/core`), the decoder before it, rejects the first slice of every stream that enables tiles (`tiles_enabled_flag`), and Ultra HD Blu-ray encodes commonly use tiles, as ATEME Titan's do.
  Such sources failed on Firefox on Windows, which always took the bundled route, and fell back to a server transcode.
  hevc.js 1.4.8 fails the same way, and its roadmap says none of its test streams uses tiles.
  The `ffmpeg-hevc` kit built FFmpeg's `hevc` decoder for `--arch=wasm` with `-O3 -flto -msimd128`, so FFmpeg's simd128 HEVC code built and the rest auto-vectorized.
  It decoded the JCT-VC tiles conformance stream `TILES_B_Cisco_1` to the suite's MD5, and a tiled 4K HDR10 Ultra HD Blu-ray remux and the 4K qualification stream to native FFmpeg's MD5s, the remux at about 28 fps on one thread in Node.
  The exact probe qualified it with the same three vectors and pinned fingerprints, because conformant decoders output identical samples.
  It ran on one thread (`--disable-pthreads`), because threads need cross-origin isolation, which Jellyfin Web does not have.
  Its heap could grow to 4 GiB, where hevc.js kept Emscripten's 2 GiB default.
  FFmpeg read each packet as the container stores it, with the HVCC record as extradata, so no Annex B conversion copied it.
  Each frame returned with its packet's timestamp and duration, so no queue sorted packet timings to match frames.
  After a random-access point the decoder dropped the leading RASL pictures and reported them dropped, as the native path does, so the stream discarded their packets' Dolby Vision and HDR10+ metadata instead of waiting for frames that never come.
  A Dolby Vision EL decoder reported every packet accepted, because its dropped leading pictures matched the BL's, and a refused EL picture would have ended EL decoding.
  The HEVC decoder project's package replaces it, on the GPU.
- A bundled HEVC frame was copied once (10-09), until the CPU decoders left (10-13).
  A drained frame's planes were views of the decoder's WASM memory, valid until its next call: bytes for Main and 16-bit words for Main 10.
  The worker used to pack them into a new buffer, `VideoSample` copied that buffer, and the raw copy or `VideoSample.toVideoFrame()` copied a third time.
  At 3840x2160 in Node 24, a 10-bit frame took about 5.9 ms and left about 50 MB of garbage, against about 0.9 ms for one row copy into a reused aligned buffer.
  The decoder then handed each frame to the owned path as it drained it, and the worker wrote the planes into the buffer it posted, whatever the decoder's row stride.
  Drained frames waited in the owned stream's queues beyond the 2 raw credits, so their buffers came from a run's pool of spares, which allocates when none fits.
  The pool, which raw copies still use, keeps 2 spares of each byte length, as many as the page can hold, so a steady stream reuses every buffer.
- Decoder instances are made once per worker (10-09).
  The bundled HEVC, FFmpeg MPEG-2/VC-1, and OpenJPEG modules were instantiated for each decoder, and the libdovi parser for each run, which a worker that outlives its runs would repeat at every seek.
  Each kit then had one instance per worker, in which every decoder or parser creates its own native context and releases only that context when it closes, so a Dolby Vision run's BL and EL decoders shared one `ffmpeg-hevc` heap.
  Since the CPU decoders left (10-13) the libdovi parser is the one kit left in `WorkerWASMInstanceCache`; decoder packages make their instances as [Decoder packages](decoder-packages.md) describes.
  An instance whose code traps is discarded, so the next parser instantiates it again rather than trust its memory; an error its code returns keeps it.
- Decoder surfaces must not starve (08-08, `ecb5a4ec09`).
  Native frame credits return after `queue.onSubmittedWorkDone()`, not after `submit()`, because Chromium holds the decoder mailbox until the GPU completes and the D3D surface pool is finite.
- Rejected alternatives.
  `ffmpeg.wasm` has no GPU decode.
  `libmpv-wasm` is CPU FFmpeg plus WebGL.
  mpv's D3D11VA P010 path is the reference design but cannot be reached from a page.
  Threaded WASM needs COOP and COEP isolation, which was not pursued.
  An FFmpeg HEVC WASM benchmark (the gate: at least 28.8 fps sustained, exact YUV420P10 hashes) was dropped when the native base route landed; FFmpeg's decoder became the bundled one later, for tiled streams rather than speed, and left with the other CPU decoders (10-13).
- If exact 10-bit is ever required, the Chromium patch options are:
  - a P010 to RGBA16F GPU copy, the narrowest patch, which fixes the N32 TODO;
  - a zero-copy P010 external texture;
  - raw R16 and RG16 plane import, the only route to bit-exact P010 and exact P7 FEL.
- Native HDR neutralization.
  The native external HDR route rewrites the color description to BT.709 so Chrome does not tone-map, and the shader recovers the YUV codes.
  An `hvcC` without an SPS defers validation to the first access unit with an SPS (08-05).
  Every access unit with a base-layer SPS is rewritten, not only key packets (10-29).
  An ISO BMFF sync-sample table may list only the IDR pictures, so each CRA, which repeats the VPS, SPS, and PPS, is a delta packet; Chrome then read the unrewritten PQ SPS of the first such CRA and decoded PQ frames, which the presenter's color check refused.
  A check of the framing and NAL unit headers alone, without parsing a payload, finds the SPS, so every packet affords it; each SPS found must still prove the route's transfer, so a mismatching SPS mid-stream fails the decode.
- Full-range PQ and HLG HEVC is presented as full range on the native HDR route (10-29).
  Until then the SPS check required limited range and refused an SPS with `video_full_range_flag` set only once decoding had started, so such a stream failed as `decode-failed` and fell back to a transcode.
  FFmpeg, mpv, and Chrome honor the flag, so the engine does too, even where the pixels look limited: Jellyfin stores no color range, so the bitstream's flag is the only declaration there is.
  The HEVC rewrite now keeps the range flag and rewrites only the primaries, transfer, and matrix, and the decoder's neutral colorSpace takes the `hvcC` SPS's range, or the configuration's own when the record has no SPS.
  Chrome then converts a full-range frame at full range and reports it as full-range BT.709, which the presenter's frame check accepts on the external HDR route; the Dolby Vision external route still requires limited.
  The shader's recovery, written for limited BT.709, then yields each full-range code's limited-range equivalent, `Y*876/1023+64` for luma and `(C-512)*896/1023+512` for chroma, which the route's limited-range metadata normalizes to exactly the full-range value, so neither the presentation metadata nor the authorization key changes.
  The authorization vector is limited range; the full-range conversion is Chrome's, unverified by a key.
- An HEVC SPS without `default_display_window_flag` is repaired before Chromium reads it (10-29).
  Some old x265 builds wrote the VUI without the flag, so Chromium's SPS parser reads the timing info that follows as a display window, fails its crop check, and the decoder reports a decoding error on the first packet.
  FFmpeg detects the pattern (`hevc/ps.c`): at the flag, at least 68 bits before the stop bit, and the next 21 bits a set `vui_timing_info_present_flag` then 20 zero bits, which a set flag would read as an implausible left offset; it then reads on as if the flag were 0.
  `repairHEVCSPSDefaultDisplayWindow` applies the same test and inserts the flag as 0, so every later field moves one bit, then writes a new stop bit and alignment and escapes the RBSP again; any other SPS is left as it is.
  The owned native HEVC decoder applies it on every route to each base-layer SPS of the `hvcC` and of every access unit that carries one, before the color rewrite on the native HDR route.
  The repaired SPS decodes to frames identical to FFmpeg's decode of the original.
- AV1 color is neutralized like HEVC's (10-27).
  Until then nothing rewrote an AV1 sequence header, so HDR AV1 decoded in software to raw I420P10, which cost CPU at 4K.
  The worker now rewrites every sequence header OBU's color description and range bit-exactly, every other field kept as it was, with the OBU size recoded only when the payload length changes, and also the codecs string's color fields, an `av1C` description, and the decoder's colorSpace.
  Chromium's AV1 decoders take a frame's color from the sequence header and fall back to the configuration, so both are rewritten; on the hardware decoder, the neutralized frame then reports limited BT.709 and stays opaque.
  Each rewritten header must itself declare limited BT.2020 with the non-constant-luminance matrix and the route's transfer, and only the HLG code point proves HLG, because AV1 has no alternative transfer characteristics message.
  The AV1 keys have their own lossless vector and authorize on first use rather than at device creation, because only AV1 HDR items need them and the HEVC keys alone shape a host's transcode ranges.
- Startup is bounded by progress, not by a fixed timer (10-07).
  A 72 Mbps 4K TrueHD source under six concurrent players produced no audio within a fixed 20 s bound and fell back to a server transcode that also stalled; the stage that stalled was not recorded.
  The controller fails after 20 s without decode progress, or at 60 s regardless, and the fallback message names the counters it reached.
  The host's 25 s setup bound ends where the controller starts, so the two bounds cannot disagree.
- An unknown duration does not block custom playback (10-07).
  Requiring `RunTimeTicks` for eligibility sent a source the server never probed through the HTML backend, although the controller and session accept a null duration.
  The decoded streams define the end; only the native media audio backend needs a duration, so such a source takes decoded PCM.
  The worker reports the duration from the container's metadata (the presented video track only, so a late audio track is never scanned) and the controller adopts it.
  Until a duration is known the player is not seekable, because Jellyfin Web seeks by percent of duration and would land at zero.
- Native decode hints match their probes (10-07).
  The SDR probes qualify with `no-preference`.
  Requesting `prefer-hardware` for every native `VideoFrame` route at runtime made VP8 sources fail after their probe passed, because Chromium on Windows has no hardware VP8 decoder and rejects that configuration.
  Only the routes that present opaque hardware output (native external HDR, the native Dolby Vision base, and external P5) prefer hardware, as their probes and authorizations do.
- Unspecified color is absent, not unknown (10-07).
  FFmpeg names an unspecified or reserved color field `unknown` or `reserved`.
  Treating those names as color values nulled the metadata and declined the item as `metadata-unsupported`.
  The engine treats such a field as absent, so the transfer's defaults apply: an SDR stream with ColorRange `unknown` is limited BT.709, and a Dolby Vision base with ColorTransfer `unknown` presents the transfer its CCID declares.
  `test/presentation/PresentationInput.test.ts` asserts both.
  Unspecified SD color defaults to BT.709; no resolution-based default is applied.
- BT.601 and BT.2020 SDR play natively (10-07).
  In field tests the engine declined H.264 and HEVC SDR tagged SMPTE 170M, and HEVC SDR tagged with the BT.2020 10-bit transfer, without logging anything.
  SMPTE 170M and SMPTE 240M primaries read as `smpte170m`, BT.470 BG as `bt470bg`, both matrices as BT.601, and the BT.2020 10 and 12-bit transfers, which use the BT.709 curve, as SDR.
  The VF-SDR route does no color math: it imports the frame with `colorSpace: 'srgb'` through the identity shader, so Chrome converts it.
  The CPU reference and the shaders are exact for all four primaries sets regardless: luminance comes from the primaries, YUV coefficients from the matrix (BT.601 is Kr 0.299, Kb 0.114), and gamut and IPT conversions go through BT.709 tables derived from the H.273 chromaticities under D65.
  Since 10-27 each matrix and primaries pair has its own raw SDR key, and the raw shaders convert the gamut of SDR outside BT.709 primaries (see [Video decode and Dolby Vision](#video-decode-and-dolby-vision)).
- The SPS VUI never rejects color (10-07).
  An HLG broadcast whose VUI signals the BT.2020 10-bit transfer (14) and whose alternative transfer characteristics SEI (payload type 147) names HLG (18) failed the native HLG route, because the SPS parser accepted only BT.709 and BT.2020 PQ or HLG.
  The parser maps every code to a WebCodecs name or to null, and only the native HDR route check is strict (limited range, BT.2020 primaries and non-constant-luminance matrix).
  Its transfer is the SEI value when the key access unit carries one and the VUI value otherwise; an HLG route also accepts VUI 14 or 15 without an SEI.
  SEI errors are not fatal, as in FFmpeg, so a malformed SEI counts as absent and the VUI alone must prove the route.
  The bundled HEVC decoder compared the container and SPS color only where both specify it (BT.470 BG equals SMPTE 170M as a matrix, and SMPTE 170M equals BT.709 as a transfer) and filled SPS gaps from the container, so a container's HLG survived a VUI 14 SPS, until the CPU decoders left (10-13).
  Chrome is assumed to report a null `VideoFrame.colorSpace.transfer` for VUI 14 and 15; the raw HLG frame check also accepts `bt709` on a BT.2020 frame in case it does not, and a null frame color member never contradicts the metadata.
- HDR10+ metadata carries forward in decode order, as in FFmpeg (10-09).
  FFmpeg keeps the last HDR10+ metadata until new metadata replaces it or the decoder flushes, also when a payload fails to parse, and hdr10plus_tool's extract fills its gaps the same way.
  x265's `--dhdr10-opt` relies on it: it writes the SEI only on IDR pictures and where the metadata differs from the picture encoded before, so 18 of the 30 access units of hdr10plus_tool's sample carry none.
  `HDR10PlusFrameMetadataQueue.enqueue` gives an absent or malformed frame the last metadata of its decode run, and a frame's status still describes its own payload.
  Conflicting or unsupported metadata ends the carry until the next valid payload, and each decode attempt and seek starts a new queue.
  Carrying in display order would be wrong: the B pictures that open a scene are shown before the scene's first decoded picture, so they would take the previous scene's metadata.
- HDR10+ profile A plays (10-09).
  Profile A has scene statistics without a Bezier curve and a targeted display of 0, and is the common shape.
  Its frames tone-map from the scene peak and average alone, a mode that never reads the targeted display.
  A curve whose targeted display is 0 is neither profile: hdr10plus_tool's validation rejects it, FFmpeg exports it unchecked, and libplacebo clamps the target into the input range before following the curve.
  With no target to adapt the curve from, such a frame is `unsupported` and tone-maps statically.

## GPU decode

- GPU decoders replace the bundled CPU video decoders (10-12, 10-13).
  Route selection tries native WebCodecs first, then a GPU decoder package the host offers.
  On 10-12 a GPU decoder replaced a bundled decoder's route whenever it took the stream; on 10-13 the CPU video decoders (FFmpeg's HEVC, MPEG-2, and VC-1, and OpenJPEG) were dropped with no compatibility shim, so a codec without a native route plays only through a package.
- Decoders are packages (10-13).
  A decoder is one `.wasm` file a host hands the engine at runtime: its module, and custom sections that carry its manifest and, for video, its WGSL and its self-test vectors.
  The engine has no decoder of its own and names none, so anyone can add a codec without changing it, and a package carries no JavaScript, so a host may load packages from anyone: the module imports only its bounded memory (1 GiB at most) and inert WASI calls.
  The decoder projects in `wgpud/` build packages without running on their own, and the engine's tests load them through the engine's loader, as a host does.
  Demuxing, the container rules, and the native routes' vectors stay in the engine, because a package decodes what the engine's demuxer hands it.
- A package's identity is the id its header declares (10-15).
  Until 10-15 a package's id was its file's SHA-256, so a rebuilt package was another package: a host's store kept both, and every engine cache keyed by it needed a count limit to bound what old versions left behind.
  Now every header declares `id:`, 1 to 64 lowercase letters, digits, and single hyphens, which its versions share, and the SHA-256 is the version, `contentHash`.
  A host's store keeps one file per id, so adding a rebuilt package replaces the old one in its place, and the engine keys what it keeps for a package by id with the content hash inside the entry, so a new version replaces the old one's entry and no cache needs a limit.
  The store's schema moved to version 2 without a migration: an earlier database opens empty.
- A video package's CPU stage is its parser (10-14).
  It was the front end until 10-14, when it took the name NVIDIA's NVDEC gives the same stage: CPU code that parses each packet's bitstream into the record the WGSL reconstructs from.
  Its header directive is `//! parser:`, its exports are `parser_*`, and a decoder project keeps it in `parser/`.
  The engine's worker that plans and finishes pictures on the coordinator instance is the coordinator worker, beside the parse workers.
  The rename kept the interface at version 1; a package built before it fails to load as `package-manifest`, because its `front-end:` directive is unknown.
- Parser interface 2 yields a packet's pictures one at a time (10-14).
  Version 1 made at most one picture of a packet, but an AV1 temporal unit holds hidden frames beside the one it shows, and each decodes into a reference of its own.
  So `parser_plan_next` and `parser_decode_next` take the packet's next picture until a call reports the last or none, and each picture is a session packet of its own: its record, events, output slot, and credit, with its packet's timestamp.
  A blocked plan_next keeps its place, because a packet's later frames depend on its earlier ones, while a blocked plan still keeps nothing and plans the packet again.
  A picture reports its visible size and its repeat counts, and configure reports the largest picture the codec private data declares, so AV1's frame size changes fit one pool and its wavefront runs only the waves a picture needs.
  The engine dropped version 1 outright: a version 1 package fails to load as `package-manifest` (`parser-version: 1, expected 2`), and the HEVC and JPEG 2000 parsers moved to version 2, where every packet is one picture.
- A session codes at the largest picture its parser declares, when the decoder fits it (10-14).
  AV1 frames may change size within a sequence, up to its sequence header's maximum, and a session sizes its pool once, so it codes at that maximum, rounded up to 64.
  A declaration can far exceed the frames: one corpus stream declares 16384x8704 for 640x360 frames.
  When the decoder's `accepts` or the device does not take the maximum, the session keeps the container's size, and eligibility checks only the container's size, so a declaration never makes a stream ineligible.
  Until 10-15 a frame that then outgrew the pool failed the session as `visible-rectangle`; since then it starts a session whose pool is the old one grown to it, as the next entry describes.
- A picture its session cannot hold starts a session of its own (10-14), sized for its own sequence (10-15).
  A session sizes its pool and compiles its pipelines for one output format once, but a later AV1 sequence header may raise the maximum frame size, as libaom's sizeup and sizedown vectors and Argon's joined sequences do, or change the bit depth or chroma subsampling, as Argon's profile switches do.
  So a parser reports each picture's output format and its sequence's largest picture, and `GPUVideoDecodeFeed` creates a session for a picture its current one cannot hold, which takes over once the current one decoded and presented its own pictures.
  Such a change comes only where the decoder needs no earlier picture, as at a key frame after a new sequence header, so the new session starts with a pool of its own while the old one's last frames still present.
  The frame pool signal reads each frame's sample size, bit depth, and chroma subsampling from its slot instead of compiling them in, so one presentation chain shows every session's frames.
  It picks the range arithmetic by the slot's bit depth among branches compiled for each depth, since computing it from the depth at run time differed from a compiled signal by an ULP on some codes on Dawn.
  Until 10-15 the new session's pool also held the container's size, and a picture that needed exactly a maximum the decoder or device had refused started no session and failed as `visible-rectangle`.
  So a later sequence large on one axis, beside a container large on the other, asked for a box no level allows, and a refused declared maximum ended the stream at its first picture beyond the pool.
  Since 10-15 the new session takes the picture's requirement alone, the larger of its sequence's maximum and its own size, since it decodes only that sequence's pictures, and falls back to the old pool grown to the picture when the decoder or the device refuses that.
  A picture its pool holds asks for no session the decoder refuses, so a stream whose sequences declare 16384x8704 for 640x360 frames decodes on in its first pool.
  Only a picture that no pool the decoder takes can hold fails, as `accepts` with the fallback's picture size and pool.
  The pictures queued while a session is created wait for it and are judged against the pool it got, since a device with small buffers can refuse the pool its request asks for, and a picture judged against that one would land beyond the smaller pool.
  Through the feed, the old sizing ended 32 of Argon's 2,524 AV1 streams within `accepts` and one own encode, and these rules with `accepts` on the picture size end none; simulated alone, the sequence-alone sizing left 16 and the unrounded `accepts` 5.
- The frame pool signal clamps its taps to the frame's visible picture (10-27).
  A pool slot holds the coded size rounded up to 64, and its rows below or right of the picture are ones no decoder wrote or, as for 1080p HEVC's conformance window, ones it crops.
  Clamping the bilinear taps to the slot's planes made a picture's last row read them: a 640x360 HEVC stream's last row differed from the raw route by up to 245 of 255 on Dawn, through its 4:2:0 chroma, which interpolated chroma row 180 of 192.
  So every tap, luma and chroma, progressive or within a field, and the frame-pool Dolby Vision read with them, clamps to the visible rectangle, widened to whole samples of a subsampled plane, as the raw route's texture of the picture and FFmpeg's scaler after cropping repeat the edge.
  A slot's frames differ in visible rectangle, as a decoder's header replaces the container's or an AV1 picture reports its own size, so the executor writes each presented frame's rectangle into its slot's layout uniform instead of the pool writing it once.
- A decoder's `accepts` judges pictures before the pool's rounding (10-15).
  `stream.width` and `stream.height` are the pool's size, rounded up to 64, which a decoder's buffers and dispatches need, but a codec's levels bound the pictures themselves.
  AV1's level 5.x allows 8,912,896 samples a picture, and a legal 7396x1205 picture of 8,912,180 samples rounds to a 7424x1216 pool of 9,027,584, which `accepts` on the pool refused.
  Raising the bound to the largest rounded pool of a legal picture, 8192x1152, would have offered the package level 6 sizes such as 4096x2304, so `accepts` gained facts of its own instead.
  `picture.width` and `picture.height` are the size before the rounding: the container's visible size at eligibility, and the size a session's pool is chosen for; size, state, and dispatch expressions cannot read them, so no fact means two things.
  The device's limits still judge the rounded pool.
  Since 10-27 AV1's `accepts` bounds the pictures by level 6.x, 16384x8704 and 35,651,584 samples, on the same facts.
- A device kept the four compiled decoders its sessions used last (10-14), until it kept one version of each package (10-15).
  A decoder's module and pipelines depend only on its package and output format, while a new session comes with each file, each seek that cannot reuse the session, and each stream change.
  Until 10-14 every session also stayed reachable from its device's lost promise after it was destroyed, which kept all its pipelines alive, so Dawn's own deduplication of identical pipelines made a second session cheap by accident and nothing bounded what stayed.
  On 10-14 the device's lost promise came to hold only its live sessions, and `GPUDecoderPipelineCache.ts` kept compiled decoders by package id, then the file's SHA-256, and format, the four used last, which covered a playback and the formats its stream changes reach.
  On 10-15 packages gained a stable id, and the cache keys each decoder by device, package id, and output format, with the content hash as its version: a package's new version replaces every decoder of its old one, so what a device keeps is bounded by the packages and formats it decoded, and the count limit and its least recently used order left.
  On Dawn's D3D12 backend in Node on the RTX 5080, a 1080p session took 0.44 s to create again without the cache for HEVC, 1.1 s for MPEG-2, 8.7 s for VC-1, and 0.42 s for JPEG 2000, and 4 to 12 ms with it.
- Each entry point compiles a module of only the declarations it reaches (10-15).
  A pipeline processes its whole module, so every entry point of a large decoder paid for all of it: AV1's small entry points spent 60 to 130 ms each on its 560 KB module.
  `GPUDecoderEntryPointModules.ts` reads the module scope with a tokenizer of its own, since comments nest and may hold braces, and keeps for each entry point what its names reach, blanking the rest while keeping every line break and the last line's width, so compile messages map as before.
  Correctness never rests on the split: code it does not understand compiles whole, and an entry point's module that reports an error makes the whole module compile, whose errors are reported or which serves every pipeline when it has none.
  On Dawn's D3D12 backend in Node on the RTX 5080, with every compile salted so the driver's cache missed and a fresh device per run, median of 5 at I420, session start fell from 3.21 to 2.62 s for AV1, 14.8 to 13.2 s for VC-1, 2.29 to 2.24 s for MPEG-2, 0.81 to 0.78 s for HEVC, and 0.62 to 0.58 s for JPEG 2000.
  Every split module of every package compiled without an error in every output format, 445 modules, and every package's vectors decode bit-exact through it.
  The VC-1 times predate its parser (10-15), which took the parse stage out of its module.
- A header's `packet:` may declare up to 512 MiB (10-14), and size it by the stream (10-27).
  The 64 MiB bound kept a ring of two packets within WebGPU's default storage binding of 128 MiB on every device.
  A record such as a lossless 2160p 4:4:4 HEVC picture's needs more, and the presenter requests the adapter's largest limits, so a header may declare up to 512 MiB; offers skip a package whose ring the device's buffer limit does not hold, and a session fails as `packet-size`.
  AV1's worst record grows with its picture, to past 512 MiB at 8K 4:4:4 12-bit, and one fixed bound would give a 1080p stream a ring of 1 GiB and keep the package from every device whose binding holds less, so since 10-27 the size may be an expression of the stream facts, as a buffer's is, evaluated for each session.
  AV1's is its record's worst case for the pool, at least the 64 MiB it declared before, and its parser checks each record against the same bound for its frame's size, which never passes the session's.
- Self-test vectors run only on an explicit call (10-13).
  A package carries at most one vector per output format, in a format it writes, and `verifyGPUDecoderPackage` runs one only when a host calls it.
  Nothing caches or persists a result, because a verdict belongs to a package and a device, which the host keys itself.
  Offers verify nothing, so playback never waits on a vector; the policy of 10-12, which offered a decoder only once its vector passed, left with the built-in decoders.
- The frame-pool route kept one packet of decode work in flight (10-12), until two (10-16).
  Decode shares the presenter's queue, so `GPUVideoDecodeFeed` submitted a packet only after the previous submission completed and its status readbacks applied, and a presented frame waited behind at most one packet's decode work.
  The GPU then idled while the page learned of each completion, a few milliseconds a packet in Chrome and up to 100 ms in Firefox (see [Firefox](#firefox)), so the feed keeps two packets in flight and submits the next as a status readback applies.
  The second packet keeps the GPU decoding across that wait, and a presentation submit queues behind at most two packets' work; the session's three readbacks would allow three.
  A presented slot returns to the decoder right after its presentation submit, because the queue orders later decode work behind it.
- A packet's decode work can submit in slices, two in flight, a switch the host sets and leaves off by default (10-16).
  The device has one queue without priorities, so a presentation submit waited behind up to two whole packets, a large picture's wavefront of hundreds of dispatches among them.
  `GPUVideoDecodeSession` lays a packet's dispatches out at its start and submits them in slices of at most 96, of about equal length, each tracked to its completion; the last copies the packet's status, whose epoch is the packet's start, so a resync while it submits makes its status stale.
  The feed keeps two slices in flight, which bounds the decode work a presentation submit waits behind to two slices, and returns a packet's credit once its work begins.
  A reset or a resync submits no more of the packet in progress: its readback is free again, and its frame drops, or repeats the last good frame in a resync; slices already submitted still run, since WebGPU cannot recall queued work.
  Slices stay large because each completion costs the page a few milliseconds to learn of, more in Firefox, and the GPU would idle between slices that run shorter.
  Slicing trades decode throughput for presentation latency: the GPU idles between slices that run shorter than the page takes to learn of a completion, as on a fast GPU in Firefox, and two slices of queued work ride out a shorter main-thread stall than two packets did.
  Unmeasured in the field, it is off unless the host turns it on through `createGPUVideoDecodeSessionFactory`'s `slicing`; off, every packet submits whole with two in flight, as before slicing, apart from pacing on the GPU's completion rather than on the status readback.
- Every packet's status reads back, and its frame presents only once it has (10-15).
  Until 10-15 a session copied the status out only when a readback buffer was free, so one readback could cover several packets, and frames presented without waiting for theirs.
  A recoverable error belongs to one packet's frame, though, as do the field flags a decoder reports for the deinterlacer, so concealment and the deinterlacer designed the status together.
  It keeps its 48 bytes: the fatal error word and the header's stream facts last until a reset, and words 9 to 11, the freed slots, the picture's most severe recoverable word, and its fields, hold one packet's reports and clear after each packet's copy.
  The session submits a packet only when a readback buffer is free for it, so every packet's block is captured, and a frame presents only once its packet's readback applied, so a recovery always reaches its frame first.
  Decoding lost no throughput, since the feed already waited for each packet's readbacks before the next submit.
  One block per packet serves both, and a later per-picture fact appends to it.
  Rejected: a fields word per output slot, the deinterlacer's first design at 176 bytes, which misattributes once a slot is reused before its capture, as AV1's discarded hidden frames are; status-wide words, which hold the union of every packet since the previous capture; a ring of per-packet records, machinery for batching that playback never does; and the pass reading the decoder's status buffer, since the presenter must know on the CPU which frames are interlaced to time their second fields.
- A damaged packet ends no playback (10-15).
  Until 10-15 every error a GPU decoder reported ended the attempt, so one damaged packet ended a playback that FFmpeg would have concealed and continued.
  Each `error:` line now declares how a playback recovers from its code: `conceal`, where the decoder concealed the damage and its frame presents; `drop`, where the frame never presents and decoding goes on; or `resync`, where the last good frame repeats until the next key packet decodes from a reset.
  Only the decoder knows what its state survives, so the recovery is its to declare: MPEG-2's damage within a picture conceals as FFmpeg's error resilience does, the bitstream and slice damage of HEVC, AV1, JPEG 2000, and VC-1 resyncs, and the uncompressed decoder drops a packet of the wrong size.
  A code without a recovery ends the attempt as before: a change the pool cannot follow, an unsupported feature, or a resource limit, which a stream could keep hitting, so a resync would hold the last good frame for the rest of it.
  A resync repeats the last good frame rather than present frames decoded from broken references, and the session repeats it at each lost frame's time, so presentation's queue keeps its timing and the controller's starvation rules never see a gap.
  A parser's failed call made no picture and leaves its instance unusable, so a failure whose code has any recovery restarts the parser at the next key packet, with no new export; a parser that can conceal outputs its record with the damage marked and lets its WGSL report a `conceal` code.
  Recoveries count in the feed's telemetry by code and error name, with the latest detail, and never as failures; a self-test vector that recovers fails, since a vector is undamaged.
- The pool takes the container's coded size rounded up to 64 (10-12).
  Containers declare the cropped picture, such as 1080 rows, while a decoder writes whole coding blocks, 1088 rows; the first header's conformance window then replaces the visible rectangle.
- A decoder's vector, not a presentation authorization, vouches for its frames (10-12, 10-13).
  The frame-pool route presents static HDR whenever the host tone-maps it (`allowFramePoolHDR`).
  Its Dolby Vision reconstruction (10-27) is gated by the RPU route's own flags (`allowDolbyVision`, `allowDolbyVisionProfile4`, `allowDolbyVisionProfile7`) instead, which a host sets only while it tone-maps and once the raw route's key of the BL format authorized.
  A paused draft (10-15) set `allowFramePoolHDR` for every Dolby Vision stream, which would have let a host's static HDR consent stand for an RPU authorization and widened the gate for streams without an RPU route; `allowFramePoolHDR` stays tied to static HDR alone.
  On 10-12 Auto offered a decoder only once its vector passed on the device, and the WGSL HEVC decoder declared no vector, so only a forced policy played it.
  Since 10-13 the host decides whether to verify a package before it offers it, and the HEVC decoder project's package carries the nine range extension vectors.
- The frame-pool route reconstructs Dolby Vision through the raw route's key (10-27).
  Its signal is the raw Dolby Vision signal's reconstruction text over the frame pool signal's read, so the raw route's base key of the BL format, whose authorization renders that reconstruction, authorizes it, and the decoder package's vector vouches for the read as for every frame-pool frame.
  The route comes after the native and raw RPU routes and after a declared base's native and raw routes, and before that base's own GPU route, so native decode still wins and a package presents the RPU rather than the base.
  A frame pool holds no EL, as no decoder decodes one, so Profiles 4 and 7 reconstruct from the BL alone as on the raw route; the paused draft's EL frame-pool binding was left out as code no route reaches.
  Each frame carries its packet's parsed RPUs from the worker through the GPU decode session, and a repeat of the last good frame during a resync carries that frame's RPUs, since a missing RPU ends the route.
  HEVC Main at 8 bits and AV1 Profile 10 reach it in the format the RPU route names, I420 and I420P10.
- The WGSL HEVC decoder parses on the CPU (10-13).
  CABAC decodes each bin from the state the previous bin left, so a GPU parses a substream on one invocation, at about 200 ns a bin.
  On a 66 Mbit/s 2160p stream with 16 tiles, parsing on the GPU took about 100 ms a picture even with each tile on its own invocation, while everything after the syntax took 3 to 4 ms.
  The HEVC decoder project's parser (`wgpud/hevc/parser/`) parses such a picture in about 40 ms on one core, and the engine's parse workers parse a picture's slices and tiles, and several pictures, at once.
  It also derives the motion vectors, which read earlier pictures' motion in decode order, so the GPU record carries final motion, coefficients, and edges, and the GPU only reconstructs and filters.
  A record holds one word per coefficient, 2 to 5 MB for such a picture; a lossless 2160p 4:4:4 picture can pass the 64 MiB packet bound, which compact coefficient blocks would lift.
- Known differences between the WGSL HEVC decoder and FFmpeg (10-12).
  Against FATE's conformance checksums, BUMPING_A, NoOutPrior_A, NoOutPrior_B, and RAP_B differ: the decoder outputs pictures that FFmpeg's output process drops, and every picture both output matches; the session has no way to decode a picture without presenting it.
  EXT_A_ericsson_3 is not compared, since FFmpeg cannot decode it.
  Against FFmpeg's decode of x265 streams, subsampled chroma that combines cu_transquant_bypass with SAO differs, because FFmpeg's `restore_tqb_pixels` passes the chroma width with the luma origin and so exempts only the CTB's top-left chroma quadrant from SAO; 4:4:4 matches.
- The HEVC intra wavefront is one entry point (10-15).
  Both dispatches of a wave pair run `predictIntra`: the even one has a workgroup column per CTB row and the odd one a column more, which returns at once, so each knows its wave counter and the wavefront compiles once, as AV1's does.
  On Dawn's D3D12 backend in Node on the RTX 5080, over four sets of 5 to 25 alternating runs with salted cold compiles, session start fell by 4 to 7%, about 30 to 60 ms of 770 ms.
  Decoding stayed within 2% either way, with no consistent direction, on a 1080p 10-bit stream with B-frames, a 2160p all-intra stream, and a 1080p 4:4:4 10-bit stream; a form that read the column count's parity instead, without the early return, decoded up to 2% slower.
  Every package vector, those three streams against FFmpeg, and the 4:0:0 checks decode bit-exact with it.
- The WGSL VC-1 decoder mirrors FFmpeg (10-13).
  It matches FFmpeg's frames bit for bit on FFmpeg's VC-1 conformance streams and its WMV3 and VC-1 samples: Simple, Main, and Advanced profiles, progressive, field, and frame pictures, B and BI pictures, intensity compensation, overlap smoothing, the loop filter, the simple IDCT of streams without RES_FASTTX, and IntraX8 pictures.
  Its references come from an FFmpeg with commit `ec8411e854`: before it, FFmpeg conceals a valid last macroblock of a Simple or Main P picture that costs one bit, and every frame after it differs up to the next keyframe.
  The package of 10-15, whose parser runs on the CPU, matches the same streams bit for bit again.
  FFmpeg's trace finds no picture with RANGEREDFRM in any of them, nor in FATE's WMV3 DRM sample, so range reduction is implemented but unverified.
  Until 10-15 a mid-stream change of coded size failed with `pictureSize`, because the session sized its pool once and the package had no parser to declare a larger picture.
  Since 10-15 its parser declares the Advanced profile's `MAX_CODED_WIDTH` and `MAX_CODED_HEIGHT`, which size the pool, and reports each picture's size, so rtvc1's pictures of 352x288, 352x224, and 352x144 decode in one session.
  At such a change FFmpeg's decoder reinitializes, which drops the anchor waiting to present and every reference, and the parser drops them too.
  rtvc1 also holds pictures FFmpeg conceals and invalid AC codes it skips without concealing, after which its frames depend on stale AC predictors; the parser fails those pictures as damage, which resyncs, until VC-1 conceals as FFmpeg does.
- The VC-1 parse is serial, and only the parse (10-13).
  Entropy decoding has no parallelism inside a slice, so one invocation decodes each parse unit, a slice or a field, and units run at once.
  The parse keeps only what its bits depend on: motion vector prediction, since hybrid prediction reads a bit, and coded block prediction.
  Intra blocks leave their DC differential and AC levels by scan index, and one workgroup predicts, scans, and dequantizes them afterwards in anti-diagonal order, so each macroblock follows its left, top, and top-left neighbors.
  That cut a 1080p I picture from 156 ms to 34 ms.
  IntraX8 cannot split this way: its orientation code is read only when the reconstructed edge samples span a wide range, so one workgroup decodes its blocks in order, one invocation parsing and all of them sharing each block's prediction, transform, and filter.
  On 10-15 the parse, intra prediction, and IntraX8 moved to the CPU, as "The VC-1 decoder parses on the CPU" below describes.
- A lone invocation's costs set the parse's layout (10-13, RTX 5080, D3D12 through Dawn).
  A dependent instruction costs about 4 cycles, a storage read-modify-write about 30 ns, and a workgroup one about 8 ns.
  A private array indexed at run time lives in local memory, where a load after a store waits about 150 ns, and an integer division costs about 35 ns.
  So the parse stages its macroblock in workgroup memory and stores the record once, writes coefficients as it decodes them, addresses the block grid with a power-of-two stride, and reads each code's run, level, and sign from one lookup and one window.
  1080p progressive decodes in about 23 ms per frame on average, 14 to 40 ms for P pictures; interlaced 1080 at broadcast rates in 17 to 25 ms.
  The parse left the GPU on 10-15, so these costs now bound only the reconstruction, overlap, and loop filter passes that stayed.
- VC-1 pipelines are many and small (10-13).
  Backends inline every call and fold no constant argument, so each picture kind has its own slice pipeline, a helper on the hot path has one call site, and the field passes share pipelines that read their pass from the picture state.
  Tint copies a constant array at each place an index reads it, and a D3D12 pipeline holds at most 64 KiB of constants, so large tables live in the decoder state, which `loadTables` entry points of 8192 words fill at each reset.
  The 31 pipelines compile in about 10 s together on Dawn, once per browser shader cache.
  On 10-15 the slice pipelines, `predictIntraBlocks`, the header stage, and the `loadTables` entry points left with the parse, and 15 entry points remain, the field passes still sharing theirs.
- The VC-1 decoder parses on the CPU (10-15).
  Real VC-1 and WMV3 streams carry no slices, so the GPU parse ran each picture's whole macroblock layer on one invocation, and `predictIntraBlocks` ran each picture's intra prediction in one workgroup.
  The package's parser (`wgpud/vc1/parser/`) does the serial work instead: the headers, bitplanes, and lookups, the macroblock layer with motion vector prediction, and intra DC and AC prediction, scan, and dequantization, which read each macroblock's left, top, and top-left neighbors.
  The WGSL keeps reconstruction, overlap smoothing, and the loop filter as they were, and `expandRecord` writes each record's macroblocks into the buffers they read; the module fell from 789,633 bytes and 34 entry points to 107,099 bytes and 15.
  IntraX8 pictures decode entirely in the parser, and their record carries the samples: X8's orientation code is read only when the reconstructed edge samples span a wide range, so its parse needs its own reconstruction, and a GPU kernel would have kept the bit reader, X8's code lookups, and a serial workgroup in the WGSL.
  A B picture's direct prediction reads the next anchor's motion, which that anchor's parse derives, so a B picture's plan waits until every earlier anchor finished, and the plan carries the motion to the parse workers.
  The output events follow FFmpeg's one anchor of delay, so the header declares `reorder: 1` where presentation in timestamp order needed 7.
- WMV3 is a codec of its own (10-13).
  The engine's codec names are FFmpeg's, and a host builds its direct-play codec lists from them, so as an alias of `vc1` WMV3 could never be advertised under `wmv3`, the name a media server reports, and every WMV3 file would transcode.
  It mirrors FFmpeg's one decoder with two codec IDs: the `vc1` project's package accepts `[vc1, wmv3]`, and a package that decodes only the Advanced profile is never offered WMV3, whose codec private data and packets differ.
  WMV3's codec private data is STRUCT_C, which holds no frame size; FFmpeg takes the size from the container, but a WGSL decoder sees only the pool's size, padded to 64.
  The worker therefore puts a 40-byte BITMAPINFOHEADER of the track's coded size and the WMV3 FourCC before it, and the package refuses a bare STRUCT_C as `configuration`.
  Eligibility accepts the Simple, Main, and Complex profiles, since the package matched FFmpeg on both Complex streams it was checked with.
- Matroska VC-1 and WMV3 present in picture order (10-13).
  A Video for Windows track stamps each block in decode order with the time of the picture a one-picture-delay decoder outputs at it, which FFmpeg reads as decode time, while the frame pool presents frames in timestamp order.
  Every B-frame VC-1 or WMV3 stream in Matroska, VC-1 Blu-ray remuxes included, presented in decode order until `VC1PresentationOrder.ts` restamped the track by FFmpeg's rule: an I or P picture takes the next I or P picture's time, and a B picture keeps its own.
  A key packet lookup steps back to the previous GOP when needed, because mkvmerge stamps the first two packets 0.
  FFmpeg-made Matroska VC-1 without B pictures therefore presents one frame later, as FFmpeg-based players show it.
- MPEG-4 Part 2 B-VOPs in AVI and Matroska VfW present in picture order (10-27).
  Both containers stamp an MPEG-4 Part 2 stream's packets in decode order, as VfW stamps VC-1, so the worker restamps the track by the same rule: an I, P, or S-VOP takes the time of the next coded VOP that is not a B-VOP, and a B-VOP keeps its own.
  An N-VOP, a VOP that is not coded, is passed over like a B-VOP, since FFmpeg outputs nothing for it and its waiting anchor outputs at the next coded anchor.
  A stream is restamped as FFmpeg's `low_delay` reads it: when its VOL's `vol_control_parameters` clear `low_delay`, or, without them, when its object type is neither Simple nor Advanced Simple or its first group (at most 300 packets from the first key packet) holds a B-VOP, at which FFmpeg clears `low_delay`; any other stream outputs each picture at once and keeps its stamps.
  The fork unpacks DivX packed bitstreams in AVI before the restamping reads them; a packed stream in Matroska keeps its two VOPs per packet, and its B-VOPs present one frame off.
- The `mpeg4` decoder project mirrors FFmpeg's decoders (10-27).
  One project decodes what FFmpeg's `mpeg4`, `h263`, `msmpeg4v1`, `msmpeg4v2`, and `msmpeg4v3` decoders decode, because they share FFmpeg's macroblock reconstruction, motion compensation, and IDCTs, and differ only in their headers and macroblock layers.
  Its parser ports FFmpeg's `mpeg4videodec.c`, `ituh263dec.c`, `msmpeg4dec.c`, and the slice loop of `h263dec.c`, with FFmpeg's encoder detection and the bug workarounds it sets, and dequantizes on the CPU as `ff_mpv_reconstruct_mb` does.
  Its record carries per macroblock the motion operations FFmpeg's `mpegvideo_motion.c` and global motion compensation would run, with their source positions and fractions, and the IDCT blocks; the WGSL runs those operations, the simple or Xvid IDCT, and the H.263 loop filter as two passes over all horizontal and then all vertical edges, which equals FFmpeg's order per macroblock.
  One picture is one parse unit, so pictures parse at once on the parse workers; a B-VOP's plan waits until every earlier anchor finished, since direct mode reads the next anchor's motion, which the plan carries.
  The parser matched a traced FFmpeg macroblock for macroblock on 48 streams: FFmpeg's and Xvid's encoders over every Advanced Simple tool they write (B-VOPs, quarter-pel, four motion vectors, global motion compensation, interlacing, data partitioning, MPEG quantization), H.263 and H.263+ annexes, MS-MPEG4 v2 and v3, and FFmpeg's samples, including MS-MPEG4 v1, a size-changing H.263 stream, and a DivX packed stream.
  The WGSL matched FFmpeg's own C functions on about 47 million randomized samples, and the decoded frames matched FFmpeg's end to end on Dawn.
  One-point global motion compensation, reversible VLC, and H.263 B and PB pictures are implemented but unverified, since no available encoder writes them.
  Quarter-pel streams of libavcodec builds before 4653, which FFmpeg decodes with its old quarter-pel filter, fail as `unsupportedFeature`.
- The `mpeg4` package's reference is FFmpeg's bit-exact, single-threaded decode (10-27).
  FFmpeg's x86 decode averages half-pel samples without rounding approximately, unless asked for bit-exact output, and with MPEG quantization its bit-exact intra dequantization adds MPEG-4's mismatch control.
  Its frame-threaded decode of interlaced MPEG-4 B-VOPs reads motion its reference frame has not written yet in field direct mode, so its output depends on the thread count.
  The vectors therefore come from `ffmpeg -threads 1 -flags +bitexact`, whose output is FFmpeg's C code.
- The `mpeg4` package's codec private data is a BITMAPINFOHEADER for every codec (10-27).
  H.263 and MS-MPEG4 carry no frame size in codec private data, and FFmpeg's MPEG-4 workarounds read the stream's FourCC, `XVID`, `DIVX`, or `UMP4` among others, so the worker puts a 40-byte BITMAPINFOHEADER of the track's coded size and FourCC before the extradata, as it does for WMV3.
  The parser picks the codec from the FourCC as FFmpeg's `riff.c` table classes it, so the FourCC of a Matroska VfW or AVI track reaches it as it was written, and a Matroska, MP4, or MOV track without one gets `mp4v`, `s263`, or `MP43`.
- VC-1 in MP4 and MOV reads its `dvc1` box through Mediabunny's internals (10-13).
  Mediabunny 1.52.2 lists a `vc-1` track and its samples but skips the `dvc1` box, so `ISOBaseMediaVC1Configuration.ts` reads it from the `moov` bytes Mediabunny keeps (`moovSlice`, `sampleTableByteOffset`), and the worker builds its packet track with the `InputVideoTrack` constructor.
  Each internal is checked, and a change fails the track with a named check; only the Advanced profile's `dvc1` is read, as FFmpeg reads it.
  Mediabunny 1.61.5 still skips `dvc1` (10-15).
  The fork reads a `vc-1` sample entry as codec `vc1`, with the `dvc1` box's sequence header and entry point as its description for the Advanced profile only, as FFmpeg reads it (branch `v2-isobmff-vc1-dvc1`), so `ISOBaseMediaVC1Configuration.ts` takes the description from the track's decoder configuration, without internals, and fails as `dvc1-missing` without one (10-27).
  The worker takes the transport stream rule only for an MPEG-TS or M2TS track, by its input format, since a `vc1` track no longer means a transport stream.
- AV1's codec private data reads through Mediabunny's internals too (10-14).
  Mediabunny 1.52.2 reads an `av1C` box only for its codec string and keeps a Matroska `V_AV1` CodecPrivate without handing it on, so an AV1 package's parser saw no sequence header before the first temporal unit and could declare no maximum frame size.
  On the frame-pool route `AV1CodecConfigurationRecord.ts` reads the CodecPrivate from the internal track, or the `av1C` box of an `av01` or `dav1` sample entry through the `moov` reader the `dvc1` path now shares (`ISOBaseMediaSampleEntryChildBox.ts`), and copies the record unchecked, as FFmpeg's demuxers do.
  A container without one hands nothing, since temporal units carry their sequence headers, and a change in the internals fails the track with a named check.
  Mediabunny 1.61.5 still keeps the CodecPrivate to itself (10-15).
  The fork hands the record on as the decoder configuration's description, a Matroska or WebM CodecPrivate or an ISO base media `av1C` box, and reads a Matroska track's codec string from its CodecPrivate when the first block has no sequence header (branch `v2-av1-codec-configuration-record`), so `AV1CodecConfigurationRecord.ts` is gone (10-27).
  The frame-pool route posts that description as codec private data, and every other route configures the browser's decoder without it, as before, since the WebCodecs AV1 registration uses no description (10-27).
- VC-1 in MPEG-TS and M2TS is unreachable (10-13).
  Mediabunny 1.52.2 drops stream type 0xEA, and its video setup and packet splitter handle only AVC and HEVC, in private methods the engine cannot wrap.
  Once Mediabunny surfaces the stream, the engine needs only the codec ID, extradata from the first key packet, and `vc1` in the transport stream rule.
  MPEG-2 in a transport stream is unreachable for the same reason.
  The fork surfaces all three since 10-15, so they play; see the entry on MPEG-1, MPEG-2, and VC-1 in transport streams.
  Since 10-28 it reads 0xEA as VC-1 with or without the `VC-1` registration descriptor, as FFmpeg does.
- MPEG-1, MPEG-2, and VC-1 play from MPEG-TS and M2TS through the fork (10-15).
  The fork reads stream types 0x01, 0x02, and 0xEA, and splits packets as FFmpeg's `mpeg1_find_frame_end` and `vc1_parse` do, so each packet is FFmpeg's, byte for byte.
  Until 10-28 it read 0xEA only under the elementary stream's `VC-1` registration descriptor or in a Blu-ray program; it now reads 0xEA as VC-1 whatever the descriptors say, as the ISO stream type table in FFmpeg's `libavformat/mpegts.c` does (10-28).
  Neither the packet splitter, the extradata, nor the track's size depends on the descriptor, so `vc1-advanced-unregistered.ts`, `vc1-advanced.ts` with its PMT stripped of the descriptor, demuxes to the same track and packets byte for byte.
  A transport stream track has no codec private data, so `MPEGTransportStreamVideoConfiguration.ts` takes the extradata of its first packet that holds a sequence header, by FFmpeg's `extract_extradata` rule: MPEG takes the sequence header and its extensions, VC-1 the sequence header and entry points.
  The fork sizes a VC-1 track by the last entry point before its first frame, as FFmpeg's decoder does, since a stream may declare a larger maximum in its sequence header.
  Fourteen MPEG-2 and VC-1 streams, remuxed by FFmpeg into MPEG-TS and M2TS, and the engine's own TS vectors, decode on Dawn bit-exact against the same streams in Matroska.
  The one difference found is a stream whose elementary source put six bytes ahead of its first start code: Mediabunny drops bytes before a packet's first start code, as it does for H.264 and HEVC, and FFmpeg's decoder decodes that first packet differently without them.
  BDAV M2TS carries neither MPEG-1 video nor MP3; FFmpeg's M2TS mode writes them as private data, which Mediabunny rightly skips.
- DTS plays from MPEG-TS and M2TS (10-16).
  Mediabunny 1.61.5 reads DTS by its stream types and descriptors, a Blu-ray program's DTS-HD types among them, and splits the same frames Matroska carries, so the TS rule takes DTS and the `dts` package decodes it as from any container.
  `dts-core.m2ts`, the DTS test vector remuxed by FFmpeg, demuxes to the Matroska vector's packets byte for byte.
  FFmpeg writes DTS in plain MPEG-TS as stream type 0x82 without the registration that names it, which Mediabunny reads as DTS but FFprobe, and so Jellyfin, as MP3, so only M2TS has a vector.
- A package's output format follows the stream's pixel format (10-13).
  It was 4:2:0 at the stream's bit depth, so a 4:2:2 or 4:4:4 MPEG-2 stream reached the decoder as I420 and failed as `chromaFormat`.
  The pixel format now names the chroma subsampling, an explicit BitDepth must agree with its samples, and one no frame pool holds, such as RGB, leaves the stream to its native routes.
  9-bit samples take the 10-bit format, shifted up one bit as FFmpeg's converter shifts them.
  11-bit JPEG 2000 has no route: FFmpeg, and so the package, leaves its samples unshifted in 12-bit planes, which would present one bit dark.
- A 4:0:0 stream decodes into 4:2:0 only on a decoder that declares monochrome (10-14).
  A 4:0:0 pixel format, `gray` to `gray12` in either byte order, takes the 4:2:0 output format of its depth, whose chroma planes the decoder fills with the neutral value, which shows FFmpeg's gray decode unchanged.
  Mapping it alone offered 8-bit grey JPEG 2000 to the JPEG 2000 package, whose parser fails it as `colourSpace: 2`, so eligibility offers a 4:0:0 stream only to a decoder whose header declares `monochrome: yes`, and a header that says nothing takes none.
  A directive keeps that silence a refusal; a stream fact for `accepts` would have made every existing condition take 4:0:0 unless it named the fact.
  The HEVC package declares it: six x265 4:0:0 streams at 8, 10, and 12 bits, with conformance cropping, B-frames, scaling lists, transform skip, and weighted prediction, decode bit-exact on Dawn against FFmpeg's luma with neutral chroma.
  The JPEG 2000 package does not, since it would need a parser that keeps greyscale pictures and vectors with neutral chroma.
- The prefilter keeps the package-only variants of AV1 and 4:0:0 HEVC potential (10-14).
  `hasPotentialCustomPlaybackVideoRoute` knows no host's packages, so it ruled out every AV1 stream outside Main and every 4:0:0 HEVC stream, which then never reached a package's fallback.
  An AV1 stream outside Main 4:2:0 at 8 or 10 bits, such as High 4:4:4, Professional 4:2:2, or 12 bits, and a 4:0:0 HEVC stream now stay potential when a frame pool holds their format, and eligibility decides with the host's offers.
  Since 10-27 every SDR color has a raw key, so AV1 Main at 10 bits in any SDR color stays potential, and the AV1 raw format probes join the packages in deciding the other AV1 variants; the other codecs with native routes keep their prefilter, since no decoder project decodes their other variants.
  Since 10-28 an H.264 stream of a raw format variant stays potential too, as a range extension does, and its probe decides it.
- Motion JPEG 2000 opens through the engine's own input format (10-13).
  ISO/IEC 15444-3 puts the JP2 signature box ahead of `ftyp`, and Mediabunny 1.52.2 recognizes an ISO base media file only by an `ftyp` first, so no `.mj2` file opened.
  `CustomDecodeInputFormats.ts` adds a format ahead of Mediabunny's own that takes the signature box and an `ftyp` of brand `mjp2`, and hands the file to Mediabunny's MP4 demuxer, which skips the signature box.
  It reads the file's first bytes through Mediabunny's internal reader, contained the way the Matroska fix is: when the reader differs, it warns once and opens nothing.
  Mediabunny 1.61.5 still requires an `ftyp` first (10-15).
  The fork's MP4 format takes a JP2 signature box followed by an `ftyp` of brand `mjp2` or `mj2s`, and still leaves a JP2 still image unopened (branch `v2-isobmff-mj2-signature`), so `CustomDecodeInputFormats.ts` left and the worker opens files with Mediabunny's own formats (10-27).
- The WGSL JPEG 2000 decoder follows FFmpeg's bitexact 9/7 path (10-13).
  FFmpeg's default irreversible 9/7 transform runs in floating point, whose rounding follows the CPU's SIMD, which WGSL's `f32` cannot reproduce.
  Its integer path, the one `-flags bitexact` selects, lifts in fixed point with defined rounding, so the decoder implements that, and the 9/7 vectors pin `-flags bitexact`.
  Playback therefore equals FFmpeg's bitexact decode and differs from its default decode only in rounding.
  Tier-1 runs on the GPU and tier-2 on the CPU, as measured: a native single-threaded CPU tier-1 and wavelet took 229 ms for a 249 Mbit/s 1080p picture, where the GPU takes about 6 ms and tier-2 1 to 7 ms.
  RGB, grey, XYZ, and palette pictures fail as `colourSpace`, because the frame pool holds only YUV; they need planar RGB formats, a luma-only format, and the DCI XYZ transform in presentation.
- MPEG-1 is a codec of its own (10-13).
  FFmpeg names it `mpeg1video`, so as an alias of `mpeg2video` a host could not advertise it, and a package that decodes MPEG-2 alone would be offered it.
  The `mpeg2` project's package accepts both, since its WGSL follows FFmpeg's MPEG-1 paths too.
  A package carries one vector per output format, so its MPEG-1 decode has no vector of its own.
- The WGSL MPEG-2 decoder follows FFmpeg's simple IDCT (10-13).
  FFmpeg's default IDCT on x86-64 is its SSE2 simple IDCT, which equals the C one except where intermediates overflow 16 bits, which valid streams never reach.
  The vectors pin `-idct simple`, and the generator checks that each decodes the same with `-cpuflags 0`, so the known answers hold on every platform.
- The WGSL MPEG-2 decoder conceals as FFmpeg's error resilience does (10-15).
  A damaged slice ends at its damage and decoding resumes at the next slice, and the macroblocks a damaged, missing, or overrun slice leaves are concealed.
  `composeMacroblocks` gives each macroblock the status FFmpeg's `ff_er_add_slice` calls leave it in slice order, which needs every slice's end, so it runs after the slices decode in parallel, an invocation per macroblock, so a packet of many slices spreads over the device.
  When two slices decoded one macroblock their records raced, so `redecodeSlices` runs every slice again, each writing only the macroblocks it decoded last.
  `markSegments` runs `ff_er_frame_end`'s marking passes, which reset at each slice start, one segment per invocation, and `decideConcealment` decides `is_intra_more_likely` on the reconstructed picture.
  FFmpeg's MPEG-2 decoder keeps no motion vectors for its error resilience, so a damaged macroblock taken for an inter one predicts from the same place, both ways in a B picture.
  One taken for an intra one gets `guess_dc`'s DCs, `filter181` over luma's, and `put_dc`'s flat blocks; then `h_block_filter` and `v_block_filter` smooth each damaged edge with an intra side.
  A picture whose slices all ended, covering it once, runs none of it: the concealment dispatches are indirect and get no workgroups.
  Header damage follows FFmpeg too: a damaged sequence header is ignored, a zero in a quantizer matrix stops that matrix, an invalid picture type takes the picture coding extension's guess or skips the picture, and a picture header after a frame picture is ignored, its slices decoding into that frame.
  Until 10-27 a change of size or chroma format ended the attempt; since then the package's parser moves a larger sequence or another chroma format to a session of its own, and a sequence its pool holds reinitializes the decoder in its session (see the entry on the MPEG-2 package's parser).
  A picture before any sequence size, a packet whose start codes or pictures overflow the decoder's tables, or a field that does not pair resyncs.
  Against FFmpeg's C code paths on one thread, 162 damaged streams decoded with no failure, and every frame picture of the 4:2:0 streams matched FFmpeg bit for bit apart from the differences the next entry lists; a 4:2:2 broadcast sample whose damaged P picture FFmpeg conceals matched over all 50 frames.
- Known differences between the WGSL MPEG-2 decoder and FFmpeg (10-13, 10-15, 10-27).
  A packet that holds no picture FFmpeg outputs, such as a skipped open-GOP B picture, repeats the latest reference, or gray before one, because the decoder outputs a frame for every packet, its parser deciding no output events.
  Since 10-15 the first field of a pair split across packets presents with its other field concealed, which the next packet's second field replaces; FFmpeg outputs the pair once, with the second packet.
  Until 10-15 damaged slices, slice gaps or overlaps, and motion vectors outside the reference ended the attempt with the error and the failing value, where FFmpeg conceals and continues.
  Since then the decoder conceals as the previous entry describes, and differs from FFmpeg only where FFmpeg's own output is undefined or misplaced.
  FFmpeg's error resilience skips field pictures, which keep what its frame buffer held; the decoder conceals them as it does frame pictures, on their own lines, from the references' fields of their parity.
  It addresses the chroma of 4:2:2 and 4:4:4 as if it were 4:2:0, concealing and smoothing the top-left quarter of other macroblocks' chroma, while the decoder conceals each macroblock's own chroma blocks.
  A slice too short or below the picture makes FFmpeg abandon the rest of the packet, which it neither conceals nor outputs; the decoder skips that slice and conceals what it would have decoded.
  Its motion guess stops at the reference's visible height, so a damaged row of macroblocks below it keeps what the buffer held; the decoder conceals it, and later pictures predict from it.
  A motion vector outside the reference makes FFmpeg skip the prediction and add the residual to what the buffer held; the decoder predicts from the reference's clamped edge and counts the macroblock as concealed.
  Damaged coefficients beyond the standard's range overflow FFmpeg's default SSE2 IDCT differently from its C one, which the decoder follows, as the IDCT entry above describes.
  Until 10-15 interlaced pictures presented woven: the decoder read the field flags, but no deinterlacer ran and no flag reached presentation, so eligibility refused interlaced streams.
  Since 10-15 the decoder reports each picture's fields and the deinterlacing pass presents them (see [Deinterlacing](#deinterlacing)).
  A sequence's last anchor before a size change presents; FFmpeg drops it, since it reinitializes at the new sequence before it outputs that anchor.
- The MPEG-2 package's parser reads only sequence headers (10-27).
  The decoder opened at the container's coded size and failed any later sequence of another size as `pictureSize`, so a broadcast transport stream that switches resolution fell back.
  A session learns a picture's size only from its parser, before the picture decodes, since a status readback arrives after later packets queued, so the package needed a parser that declares each sequence's size, as the VC-1 package's does.
  The parser (`wgpud/mpeg2/parser/`) reads the sequence headers and extensions before each packet's first picture start code, as the WGSL's header stage reads them, and hands the packet on unchanged as the picture's record.
  A full CPU parse, as VC-1's, would have moved the WGSL's header stage and slice table to the CPU for no gain, since MPEG-2 slices already decode in parallel on the GPU; a record that is the packet keeps the decode, its concealment, and its picture fields bit for bit as they were.
  It decides no output events, so frames present in timestamp order as before, and it reports each sequence's chroma format, so a change of chroma format moves to a session of its own too.
  A smaller sequence stays in its session, whose pool holds it, so the WGSL now drops its references and starts the new geometry where it failed before, as FFmpeg's `mpeg_decode_postinit` reinitializes.
  On Dawn through the playback worker and the feed, MPEG-2 transport streams and Matroska files joined from FFmpeg's 720x576 and 1920x1080 interlaced segments, up, down, up and back, at 4:2:0 and from 4:2:0 to 4:2:2, a change within one pool (720 and 736 columns), and MPEG-1 from 352x288 to 640x480 and back, presented every frame of each segment's own FFmpeg decode bit for bit, where the package without a parser failed each as `pictureSize`.
  Every earlier MPEG-2 check stream without a size change presented the same frames through the parser as without it.
- The AV1 package's parser is libaom's decoder running its parse-only pass (10-14).
  `vendor/aom` pins libaom v3.15.2, and the `av1` project builds its decoder alone to WebAssembly with four small patches: every tile parses with the parse-only flag, hooks hand each transform block, block, frame, and missing reference to a C bridge, and the decoder exports its intra edge counts, its CfL buffer extent, and its deblocking levels.
  A parser of our own would repeat libaom's entropy decoding, motion vector prediction, and reference and segmentation bookkeeping, which nothing on the GPU could check; libaom's are the reference's own.
  libaom's frame buffers point at an address no module memory maps, so the parser holds no samples, and a stray sample access traps.
- An AV1 record carries libaom's decisions, not its syntax (10-14).
  Each frame's record holds the blocks with their modes, motion, warps, transform partitions, and palettes; each superblock's intra jobs per plane in decode order, with libaom's edge counts; transform jobs with libaom's dequantized coefficients, dense or sparse, whichever is smaller; and the restoration units, CDEF indices, deblocking levels, references with their scale factors, global motion, and film grain.
  The WGSL then needs no syntax, no probability models, and no decode order beyond the wavefront, and every value it reads is the one libaom's own reconstruction would have used.
- Every AV1 frame is one picture, hidden frames included (10-14).
  A temporal unit's hidden frames decode into references of their own, so the parser makes one picture per frame through parser interface 2, and the unit's last shown frame presents, as libaom and FFmpeg's libdav1d output one frame per temporal unit at operating point 0.
  References stay in the package's own frame store, ten frame buffers the parser assigns, so the header declares `references: 0`, and only shown frames reach the frame pool.
- AV1 reconstructs in 16-bit frame buffers at every bit depth (10-14), in a store split over two buffers (10-27).
  Two samples per word keep every write owned by one invocation, since blocks and transforms start at multiples of 4 and no two filter footprints share a word; 8-bit streams pay twice the memory of 8-bit samples.
  Level 6 makes the ten frame buffers of an 8192x4352 picture 1.07 GB at 4:2:0 and 2.14 GB at 4:4:4, past many devices' largest binding, and the RTX 5080's 2 GiB under Dawn holds 4:4:4 at 8192x4352 but not every legal pool rounded up to 64.
  Bytes for 8-bit samples would halve the store, but four samples a word put two deblocking edges four samples apart into one word, which two invocations would write, so every family's sample layout and the filters' write ownership would change.
  So since 10-27 the store spans two buffers of five frame buffers each, and one comparison against the first buffer's length picks the buffer of each word; a device whose binding holds half the store decodes it, and the fit check names the buffer a device cannot hold.
- AV1's intra blocks reconstruct in a superblock wavefront (10-14).
  Inter blocks predict per 16x16 tile, and the transform passes add their residuals first; then a superblock waits for its left, top, and top-right neighbors in its tile (slope 2; IntraBC's delay rule needs slope 5 with 64x64 superblocks and 3 with 128x128), chroma runs one wave behind luma for CfL, and tiles run side by side.
  The parser reports each picture's wave pairs, so a frame without intra, IntraBC, or inter-intra blocks runs no wave.
  Both dispatches of a pair run one entry point, which picks its wave counter by its workgroup count, so the wavefront compiles once; a second copy cost 0.3 to 0.4 s of pipeline creation.
- After a seek, AV1 temporal units before the first key frame make no picture (10-14).
  libaom cannot decode them without the references they predict from, so the parser waits for a key frame from its start or reset, as libaom's own interface does.
  An inter frame after a resyncing intra-only frame that misses references makes no picture either, while a key frame's own failure is the bitstream's.
- The WGSL AV1 decoder matches libdav1d bit for bit (10-14, 10-15), up to level 6.x (10-27).
  Every frame matches FFmpeg's libdav1d on the package's nine vectors, libaom's 242 test vectors, 53 encodes of our own from libaom, SVT-AV1, and rav1e in every output format, and Argon's 2,524 conformance streams within level 5.x, 26,772 frames; stage dumps compared every decode picture's reconstruction and each filter stage with libaom's own.
  Until 10-27 the 239 Argon streams with a frame beyond level 5.x were outside `accepts`.
  Since then the 131 of them within level 6.x decode through the feed with every frame matching, 1,293 frames across 28 stream changes, and so does an 8K 10-bit SVT-AV1 encode; eight of them carry records past the old 64 MiB bound, up to 92 MiB.
  Their first run found two faults the level 5.x streams could not reach: the film grain block offsets held 16,384 32x32 blocks, fewer than an 8192x4352 picture's 34,816, and libaom refused a 16384x2176 4:4:4 frame buffer with a scaled reference's borders past an eighth of its 32-bit allocation bound.
  The other 108 have frames beyond level 6.x, up to 16640x8960 or 40,468,480 samples, which `accepts` refuses and the parser fails as `pictureSize` or, where libaom's frame size limit refuses them first, `bitstreamCorrupt`.
  A stream that changes its output format midway, as Argon's profile switches do, or whose later sequence header raises the maximum frame size past the `av1C` a session was sized from, as libaom's sizeup and Argon's joined sequences do, continues on a session made for the change, as stream changes do since 10-14.
  The runs of 10-14 decoded each run of one format on a session of its own, sized from the largest picture the parser reports; those of 10-15 go through `GPUVideoDecodeFeed` itself with the built package, an IVF without a size declaring its first frame.
  There every frame the feed delivered matched, but the feed's pool sizing first ended 32 Argon streams, 22 as `accepts` and 10 as `visible-rectangle`, and one own encode whose sequences declare 16384x8704 for 640x360 frames: `accepts` judged pools rounded up to 64, which a legal level 5.x picture such as 7396x1205 crosses, and a refused pool ended the stream even where its pictures fit a smaller one.
  With the sizing rules of 10-15 for stream changes and `accepts`, every stream of the four sets decodes through the feed, Argon's across 1,072 stream changes in 746 streams.
- AV1's parser sets its pace (10-14).
  On the RTX 5080 through Dawn, a 2160p50 10-bit SVT-AV1 stream takes 1.0 to 1.1 ms of GPU time a picture, 0.8 to 0.9 ms with 4x2 tiles, and 1080p50 8-bit streams 0.3 to 0.5 ms, while the parser takes 6.4 to 7.3 ms a picture at 2160p and 3.2 to 4.6 ms at 1080p.
  libaom parses a frame's tiles in order on one instance, so a picture plans whole on the coordinator worker with no parse units, which bounds 2160p at about 100 frames a second, at about 1.5 pictures a frame.
- AV1's pipelines take about 2.6 s to create cold (10-14, 10-15).
  The package has 17 entry points; on Dawn's D3D12 backend, which compiles with DXC, a session creates them at once in about 3.2 s cold from the 560 KB module on the RTX 5080, with about two compiling at a time, and in 2.6 s since each compiles a module of only what it reaches.
  The NVIDIA driver keeps compiled shaders on disk, so a compile it saw before is warm: the 2.0 to 2.2 s measured on 10-14 were partly warm, and a later session of a package version and format the device compiled compiles nothing.
  On 10-14 the heaviest alone were the inverse transforms, 0.93 s, the tables, 0.55 s, and the wavefront, 0.47 s; since then the wavefront's two entry points became one, the 64-point transforms moved into a kernel of their own, and the inter and transform families each read their tables from one packed array at one site, which took their loaders from 0.26 and 0.19 s to about 0.1 s.
- AV1's 64-point transforms run in a pass of their own (10-15).
  The 64-point DCT's unrolled flow graph made the one inverse transform kernel the longest compile of the package, 1.16 s.
  So the parser lists the transform jobs with a 64-point side after the others and records where they start, `inverseTransform` runs the jobs before that index, and `inverseTransformLarge` runs the rest on the same grid.
  The two kernels compile in 0.69 and 0.88 s side by side, and on the GPU the pair matches the single kernel, the pass with no jobs of its own costing 6 us.
  The large kernel runs DCT_DCT only, since libaom codes no other transform type across a 64-point side; a record that carries one, or a job on the wrong side of the index, fails as `recordInvalid` with value 10, and the job writes nothing.

## Deinterlacing

- Interlaced video deinterlaces in presentation, with yadif (10-15).
  Until 10-15 eligibility refused every stream whose metadata did not call it progressive, and the GPU decoders presented interlaced pictures woven.
  yadif is FFmpeg's default deinterlacer and fully defined, so FFmpeg's output is a known answer: it predicts each missing sample from its own field along the best of five edge directions, then clamps that around the mean of the neighbouring frames by how much the area moves, so still areas keep their full vertical detail and moving ones the spatial prediction.
  The pass, `Presentation deinterlace`, implements it from the algorithm with FFmpeg's options: `mode=send_field` or `send_frame`, `parity=auto`, `deint=interlaced`, and the spatial interlacing check of mode 0.
  A CPU reference, `test/helpers/yadifReference.ts`, matches FFmpeg's yadif bit for bit in integer arithmetic on FFmpeg-woven 576i and 480i, 1080i at 10 bits, 4:2:2, and a 9x10 4:4:4 frame, at both rates, and the WGSL pass matches its f32 arithmetic exactly on Dawn.
- It deinterlaces the signal's RGB, per channel in f32, at the frame's visible size (10-15).
  The signal is where every route's frames first meet in one form, before tone mapping and scaling, so one pass serves native `VideoFrame`s, raw planes, and frame pool slots, at 8 to 12 bits and every chroma format.
  Deinterlacing the YUV planes, as FFmpeg does, would need a pass for each plane layout, and an external texture exposes no planes at all.
  The signal renders into a ring of three `rgba16float` frames, and yadif's integer score bias of one code becomes 2^-bitDepth, one code at the signal's depth.
  The output's luma agrees with FFmpeg's YUV-domain yadif at 42 to 55 dB PSNR on MPEG-2 576i, VC-1 1080i, and H.264 1080i; the difference is yadif's clamps and edge choices, taken per channel.
- A deinterlacing plan reads 4:2:0 chroma within each field on the raw and frame-pool routes (10-15).
  An interlaced 4:2:0 frame's chroma rows alternate between its fields, so the progressive read blends the other field's colors into every row, which bleeds at moving edges once yadif keeps one field.
  The signal reads a row's own field's chroma rows at MPEG-2's interlaced siting, a quarter of a field row below the top field's luma and three quarters below the bottom field's, whenever the frame it reads is interlaced (`fieldState`'s `interlacedSignal` bit), so a progressive frame of the same stream keeps the progressive read.
  Only a deinterlacing plan's signal carries the branch, so every other plan stays as it was.
  An external texture cannot: the browser upsampled its chroma progressively before the page sees it.
- Double rate is the default (10-15).
  An interlaced frame's fields are two moments, 20 ms apart at 50 Hz, so a frame per field keeps the motion of broadcast video, where single rate halves it.
  Single rate (`send_frame`) and off, woven frames as decoded, stay a host's choice through `setDeinterlaceMode`.
- Deinterlacing takes one frame of lookahead, and the clock stays (10-15).
  yadif reads the frame after the one it shows, so the frame loop takes frames one frame duration ahead of the clock and the presenter shows the frame before the newest.
  The clock, and with it audio, never moves: decoding runs one frame further ahead within the same credits.
  A frame's second field presents at its time plus half the interval to the next frame, rounded down to a whole microsecond, as FFmpeg's yadif stamps it.
  After a reset the first frame shows at once without a next frame, and the last frame shows with itself as its next, as FFmpeg's yadif ends.
  A field drawn between new frames is a draw from history: no source, no upload, one encode.
- Each frame carries its own fields, from where they are known first (10-15).
  The picture fields word is the same in WGSL and parsers: bit 0 reported, so a reported progressive picture differs from none, bit 1 interlaced, bit 2 top field first, bit 3 repeat first field (`PICTURE_FIELDS_WORD`).
  A frame's fields are its GPU decoder's `reportPictureFields` report, else its parser's optional `parser_picture_fields` word, else its container's scan: Matroska's FlagInterlaced and FieldOrder, or an MP4 sample entry's `fiel` box.
  The fork's Matroska demuxer reads FlagInterlaced and FieldOrder and reports them as the track's field order, `getFieldOrder` (branch `v2-matroska-field-order`), so the engine's format wrapper, which recorded them while Mediabunny parsed the track entry, left (10-27).
  A GPU decoder's report reaches its frame through the decoder status's per-packet block, as "Every packet's status reads back" above describes.
  The field order codes follow FFmpeg's mapping: 9 stores the top field first and shows the bottom first, and 14 the reverse.
  A file whose MuxingApp names libavformat 57.36.100 to 57.51.100 holds 9 and 14 swapped, as that muxer wrote them, so they are read swapped back, as FFmpeg's demuxer does.
  The swap repairs what one muxer wrote rather than choosing how to present, so it moved into the fork's demuxer with the reading, and `getFieldOrder` reports the order the file means (10-27).
  A frame without fields takes the stream's scan from the host's `FieldOrder`, in ffprobe's names, else its `IsInterlaced`; an interlaced frame of unknown order presents top field first, as yadif's `parity=auto` does, and a frame of unknown scan presents as it is.
- Eligibility refuses interlaced video only where no route presents it (10-15).
  HEVC codes interlaced video as field pictures and JPEG 2000 as a codestream per field; no decoder weaves them into the frames the pass takes, so `IsInterlaced` true refuses them.
  A Dolby Vision route never deinterlaces, since the profiles are progressive, so it keeps requiring `IsInterlaced` false; a declared base layer's ordinary route deinterlaces.
  Every other codec's interlaced or unknown scan is eligible.

## Firefox

These were settled on Firefox 157 on Windows.

- WebCodecs has no HEVC on Windows (10-07).
  `IsSupportedVideoCodec` in Firefox's `dom/media/webcodecs/WebCodecsUtils.cpp` accepts HEVC only on macOS and Linux, and only with both `dom.media.webcodecs.h265.enabled` (on by default only in Nightly) and `media.hevc.enabled`.
  That second pref, on by default, lets `<video>` and MSE play HEVC through the Windows HEVC extension.
  HEVC therefore decoded in the bundled decoder until the CPU decoders left (10-13), and now plays only through a GPU decoder package; the native HEVC, external HDR, and native Dolby Vision routes never qualify on Windows.
  The hardware decoder behind `<video>` cannot feed the custom pipeline, whose frames must reach WebGPU unconverted, while a `<video>` external texture arrives as SDR sRGB.
  The bundled decoder ran on one core, about 20 fps at 4K on a fast CPU, so 4K played below real time.
  This is left as is until Firefox enables WebCodecs HEVC on Windows.
- A `VideoFrame` cannot be constructed in a high-bit-depth format (10-07): the constructor rejects `I420P10`.
  The bundled HEVC decoder's frames therefore never passed through a `VideoFrame` on the raw route: as the decoder drained a frame, the worker wrote its planes from WASM memory into the aligned raw buffer it then transferred (10-09).
  On the VideoFrame route, which 8-bit SDR took in Firefox, the worker wrote each drained frame into compact I420 planes and constructed the `VideoFrame` itself with `transfer`, with the metadata `VideoSample.toVideoFrame()` gave it; a browser that ignored `transfer` copied the planes, and the worker wrote the next frame into the same buffer.
  A GPU decoder package's frames never leave its frame pool, so the limit no longer matters to them (10-13).
  The external P5 authorization builds an `I420P10` frame and fails, but it needs WebCodecs HEVC regardless.
- Copy options name a `format` only to convert (10-10).
  The spec accepts only RGB formats there, and Firefox enforces it, rejecting even a frame's own `I420P10` in `allocationSize` and `copyTo`.
  The raw copy and its capability probe therefore leave `format` out when the frame already has the requested format.
- 10-bit AV1 decodes to 8-bit `BGRX`, and the 4K VP9 Profile 2 vector fails to decode (10-07), so raw HDR AV1 and VP9 do not qualify.
- WebGPU completes queue work only when the GPU process polls the device (10-16).
  Firefox resolves `onSubmittedWorkDone()` and `mapAsync()` inside wgpu-core's `Device::maintain`, which runs at the end of each `queue.submit` and on the GPU process's 100 ms timer (`POLL_TIME_MS` in `dom/webgpu/ipc/WebGPUParent.cpp`; [bug 1870699](https://bugzilla.mozilla.org/show_bug.cgi?id=1870699)).
  The frame-pool route waited on each packet's completion before submitting the next, and native frame credits wait on `onSubmittedWorkDone()`, so decoding advanced only as presentation submitted, and every 100 ms once the frames ran out.
  An empty submit runs the same maintenance without work, so `waitForGPUCompletion` polls the device with one every 2 ms while a completion is pending; Mozilla measured completion at 100 ms idle against 3.85 ms in Chrome, and at 21 ms with an empty submit every 20 ms.
  Chrome completes queue work within milliseconds of the GPU finishing, so the polls add only a few empty submits there.
- The Vorbis decoder emits an empty `AudioData` for the priming packet before the decoded one (10-07).
  Mediabunny skips it at runtime, and the audio probe skips empty outputs too.

## Playback robustness

- Decode-clock guard (08-07, `cde9dba045`).
  One stale or seek-preroll frame more than 2 s behind the clock is discarded and re-credited, with no immediate renegotiation.
  Sustained starvation still falls back after the bounded timeout.
- Hidden-page video follows Chromium (10-01).
  A hidden page stalled video at exhausted credits while audio ran on, and on return the lag guard replayed the backlog (frozen, then fast-forward) or tripped `playback-stalled`.
  The engine mirrors Chromium's background video track optimization: drain while hidden, release the decoder after 10 s, and on return restart video alone from the preceding keyframe.
  Audio is never touched.
  Only `native` decode is suspended; the software backends kept draining, because a keyframe resync cost up to a GOP of CPU decode, and the `gpu` backend keeps draining too (10-13).
  A full seek was rejected because it restarts audio too.
- Presenter geometry (08-07).
  Layout is invalidated on seek, resize, style and class mutations, and CSS motion events.
  Nothing reads layout per frame during an animation.
- Timing trace and presentation counters (10-09).
  Video that crawled and caught up in waves showed no dropped frames, because a frame shown late is not dropped and a clock re-anchor is not counted.
  The telemetry now counts frames shown later than their own duration while playing, the worst lag, and clock re-anchors of 16 ms or more with the largest jump, and hosts report stale discards beside skipped frames.
  `TimingTrace.ts` records render ticks, clock syncs, frame arrivals, decodes, and outputs, frame credit and read waits, fetches, GPU completion, audio clock mappings, and long tasks, but only while a host runs a trace.
  Without one, a hook costs a null check and, at most, its small field object.
  Worker events carry epoch times, `performance.timeOrigin` plus `performance.now()`, and reach the page on their own `timing-trace` message, which is merged even from a replaced generation because it explains the moments before the replacement.
- Owned decode paces its packets (10-09).
  A frame credit was held, not spent, while packets were read, so with no decoded frame waiting the pump read packets until the first output came back.
  A hardware HEVC decoder answered after a few milliseconds, by which time a whole group of pictures had reached it: 12 4K packets in 6 ms, every 12 frames.
  On an Intel Arc laptop each burst delayed the GPU work of the frame being presented by 40 to 80 ms, a visible hitch twice a second, while every frame was still chosen on time.
  Each packet now waits, up to 10 ms, for the decoder to return a picture before the next packet is read, so decode follows presentation one packet per frame.
  A decoder that needs more packets to reorder gets the next one when the 10 ms pass.
- A preroll decodes in batches the GPU keeps up with (10-27).
  On an Intel Arc laptop, resuming 4K HDR10+ HEVC mid-GOP, the first two presented frames' GPU work took 266 and 129 ms, Chrome held back two animation frames, and one frame dropped.
  Measured on an RTX 5080 in Chrome 156 with a 4K HDR10+ HEVC stream of 10 s GOPs, a seek mid-GOP decoded 123 preroll frames in about 240 ms, and its first presented frame's GPU work took 31 to 44 ms, against 11 to 17 ms for a start at 0, which has no preroll but builds and imports everything for the first time, and 2 to 5 ms in steady playback.
  A second seek in the same session, whose pipelines were built, cost the same, and a fixed 80 ms pause after the preroll brought the first frame to 2 to 5 ms, so the cost was the preroll's decode work, not the presentation pipeline.
  A Chrome trace showed why: the GPU process submits each decode in about 2 ms and the decoder returns the frame then, while the GPU decodes a frame more slowly, so the preroll left tens of milliseconds of decode queued, and the first frame's import waited behind it.
  Pacing the preroll by time would have slowed it, and a `copyTo` of a few texels of a hardware frame in the worker did not resolve in the trial, so the worker reads one texel of a batch's last frame with a WebGPU device of its own and waits for that work, which the frame's decode precedes.
  Batches of 4 frames with two batches ahead kept the first frame's GPU work at 1 to 7 ms; in a trial that waited on every batch at once, batches of 16 left 11 to 18 ms.
  The preroll took about 40 to 60 ms longer by the decoder's outputs, which is the decode work it no longer leaves queued, and the first frame presents about when it did, now without a long draw.
  A frame exactly at the start used to follow the frame before it, which the first tick then skipped for the start's frame and counted as dropped; the frame at the start now leads alone.
  The Arc's numbers are unmeasured since.
- The plan a track declares is built before its first frame, and a device keeps its compiled passes (10-27).
  The presenter learned a stream's chroma format, and its frame size where the host gave none, from the first frame, so a plan that reads them, the raw and frame-pool routes and the external ones at a declared location, an interlaced stream's deinterlacing plan, or a preset pass sized by the frame, compiled while the first frames presented, and the first frame drew with the plan before it.
  The worker reads both from the track at its ready response, so the controller hands them to the presenter between `configured` and ready, and ready waits until the executor for them is installed; on the native HDR10 HEVC route of an RTX 5080 the plan's one pipeline already compiled inside the play request, and the first frame's chroma left the plan as it was.
  Compiled passes stay on the device, most recently used first, up to 64, the size of a preset of large passes; a pipeline holds driver memory, so a bound keeps variants that come and go, such as HDR output toggles and deinterlacing modes, from growing it, and an executor keeps the passes it holds when they are dropped.
  The next session on the kept device, as the next item of a queue, then builds its executor without compiling, where each session used to compile its passes again.
  The coded size is a prediction: a frame whose visible size differs replans at the first frame, as before.
- One decode worker per session (10-09).
  Every generation, which every seek, audio track switch, and paused repaint starts, used to create its own worker and paid worker startup, script evaluation, and WASM decoder instantiation each time.
  The session now creates its worker at the first start, runs every generation in it, and terminates it only on `destroy`.
  Since 10-17 `destroy` leaves a worker fit for another generation to the page's next session from the same factory, once its runs posted `stopped`, and terminates it if none takes it within 30 s.
  Each item of a queue built its own controller and session, so every episode switch started the decode worker, its parser coordinator, its six parse workers, and its audio decode worker again and fetched their scripts and the output stage's WASM.
  The handoff waits for the runs to end because a new controller numbers its generations from 1 again, so a run still unwinding could post under the next session's generation; a session that starts first takes a new worker.
  Runs overlap since 10-16: the session posts the next `start` right behind the previous run's `stop`, and the worker starts it at once while the stopped run unwinds beside it.
  Before, a start waited for the previous run's `stopped`, and a run that did not post it within 1 s had its worker replaced, so a seek paid the wait, then a cold worker and a lost URL source; contention in the field held an unwinding run past that bound now and then.
  The wait came from the bundled HEVC decoders, whose stopping run waited for every one in its worker, the next run's included (10-13).
  Without them, a stop closes the run's decoders and audio attempt and cancels its reads at once, and the next run's parser pipeline replaces the stopped run's on the shared coordinator, so nothing the next run needs waits for the stopped run's `stopped`.
  A retired run has 10 s to post `stopped`; past that the session warns and replaces the worker at the next start, and a start that would leave more than 4 retired runs unwinding in one worker takes a new one.
  A worker is replaced rather than reused after a generation fails, a message fails validation, or the worker crashes; a retired run's failure leaves the running generation in place and replaces the worker at the next start.
  A lost audio decode worker no longer asks for the decode worker's replacement, since the next run may start before the lost one's `stopped`; the decode worker spawns another for that run instead, and `stopped` lost its `replaceWorker` field.
  A start on another video decoder backend gets a new worker too, because Mediabunny kept a decoder registration, such as the bundled HEVC adapter that `canDecode()` consulted, for the worker's life; since the CPU decoders left (10-13), the new worker keeps what one backend set up, such as a package parser's workers, from outliving it.
  Each run still opens its own input, so the read cache does not outlive a seek; since 10-16 a URL source does (below).
  After a run ends on its own, its generation stays current while the worker idles, so a native-media element that plays out after decode still ends the session.
  Before, the run's `stopped` retired the worker and with it the generation, and such a session did not end.
- Presentation stays on the page; presentation in the worker was removed (10-09).
  Its first stage (`be2cd76`) kept each decoded frame in the decode worker, which drew it with a GPU device of its own into a canvas transferred with `transferControlToOffscreen`, so no `VideoFrame` or 25 MB 4K 10-bit raw buffer crossed to the page.
  In field use it felt less responsive than the page presenter, and on an Intel Arc laptop (Meteor Lake iGPU beside an RTX 4060) 4K HDR10+ playback dropped frames after a few minutes, which the engine before it (`a3bba75`) did not.
  The cause was not isolated.
  The suspects: every draw waited on the decode worker's event loop, which also demuxes, decodes, and copies; each session took a second device on the same adapter and authorized its route again there; and a frame's credit returned only after the renderer's GPU work and the page's release.
  The persistent worker, the bundled HEVC single copy, and the audio decode worker, which landed with it, stayed; the single copy left with the CPU decoders (10-13).
  Presentation off the main thread should return only with a measured cause, and on a thread of its own rather than the decode worker's.
- The host names the paths whose cross-origin 206 hides `Content-Range` (10-14).
  `Content-Range` is not CORS-safelisted, and Jellyfin's stream endpoint does not expose it, so the range check accepted a 206 with a bounded `Content-Length` from a hard-coded Jellyfin path, which bound the engine to one host.
  A URL source now carries `hiddenContentRangePathPattern`, a RegExp without the global or sticky flag that crosses to the decode worker by structured clone, and without it every 206 must show its `Content-Range`.
  The Jellyfin plugin sets the same `/Videos/{id}/stream` pattern on the stream URL it plays, so its playback is unchanged; the sandbox sets none.
- A URL source outlives its run and reads ahead by seconds of media (10-16).
  Every seek started a run whose new source read the container's header and index again over new connections.
  Mediabunny's prefetch reached at most 8 MiB past a read, under a second of a 70 Mbit/s remux, and it aborted each response at its target, so the next read paid a new request and a TCP slow start.
  The fork's `UrlSource` keeps a response open for 4 s at its target, where a sequential reader extends it, keeps a set read-ahead past the latest read, pins what it cached outside its cache budget, and cancels waiting reads (branch `v2-url-source-read-ahead`).
  The worker keeps the last run's source for the next run over the same URL and pattern, cancels its waiting reads when a run stops, and releases it when a run fails, when a run opens other media, or when no run takes it within 5 s.
  Since runs overlap, only the run that took the source last decides its release, so a stopped run that ends after the next one took the source leaves it be.
  After the first preparation over a source, the worker pins its cache, the container's header and index among it, and sizes its read-ahead to 5 s of media and its cache to 15 s, at the media's size over the server's duration, else the container's, within 8 to 64 MiB and 32 to 192 MiB.
  The server's duration reaches the worker in the start request, whose absence asks for the container's in the ready response.
  Each run still opens its own input, because a canceled read rejects promises a kept demuxer could have memoized.

## Audio

- Output routing (08-07, `cde9dba045`).
  `WebGPUAudioOutputManager.ts` owns the sinks.
  "Default" is `setSinkId('')`.
  A suspended AudioContext that should be playing is resumed.
  Decode, worklet, and PCM queues never restart for a sink change.
  A chosen device is stored by its opaque ID, falls back to the default, and is restored when it reconnects.
- Output device recovery (10-06).
  Re-applying an unchanged sink ID does nothing: the Web Audio and Audio Output Devices specs, and Chromium, resolve a same-ID `setSinkId` without touching the output.
  An AudioContext created while Windows has no output device gets Chromium's placeholder `AUDIO_FAKE` parameters, and the audio service rebuilds its stream with them on every device change, so it never reaches a device that appears later.
  Only a new destination escapes: a real `setSinkId` change or a new context.
  Media elements request low-latency streams and follow the new default on their own.
  Chromium 134 and later send `devicechange` only to pages with microphone permission.
  Without permission, `enumerateDevices()` lists one blank `audiooutput` entry while any output exists and none when there is none.
  Engines without `AudioContext.setSinkId` hide outputs, so an empty list proves nothing there; Firefox instead gives such a context zero output channels.
  Hence the pool never reuses a context created without an output device, and the router polls enumeration and rebuilds the sink through `{ type: 'none' }`.
  Retries are unlimited but run only while the page is visible, which bounds their cost to when someone is watching; audio that plays in a hidden tab recovers when the tab is shown again.
- Live output layout switch (10-07).
  Only the output stage depends on the decoded layout: the audio decoder always produces the source layout, and the 2, 6, or 8 channel count configures the downmix, resampler, and limiter, the worklet, and `destination.channelCount`.
  A layout change therefore restarts only the audio attempt in the worker (`resync-audio`, epoch-tagged like `resync-video`) and swaps the worklet on the same context and sink.
  It never goes through the seek path, which would restart video.
  The new audio starts 250 ms ahead of the clock, so the clock keeps running and video does not stall; sound pauses for that lead.
  The page learns of a new device through `sinkchange` after a real `setSinkId` change (the recovery rebuild or a chosen device).
  Chromium does not report a default device that moves on its own, which is why the settings offer a manual re-detect.
- Downmix (08-06, `ca5ac91a5c`, `8239010d93`).
  The default is Lo/Ro (front 1.0, center and surrounds 0.707, LFE omitted) with a linked lookahead limiter: a 100 ms analysis horizon, an adaptive 3 to 10 ms attack with quintic smoothstep, a 100 ms exponential release, and a -1 dBFS sample peak.
  The limiter drains at the end of stream and resets per seek and generation.
  The alternatives are peak-normalized Lo/Ro, AC-4, RFC 7845, Dave750, and night mode.
  Downmix applies only to a stereo destination; a 5.1 or 7.1 destination takes the source by channel name (next entry), when `AudioContext.destination.maxChannelCount` allows.
- Layouts map by channel name (10-07).
  A decoded layout that differs from the output layout is mapped, not rejected, because the decoded layout can differ from the declared one the output was sized for (E-AC-3 7.1 declared as 5.1, for example).
  Mono goes to the center speaker, or to both channels of a stereo output, and stereo to the front pair.
  5.1 to 7.1 fills its sides or backs and leaves the other pair silent, and 7.1 to 5.1 folds each surround as sqrt(1/2) times side plus back.
  A 6.1 or 3.0(back) back center splits across the surround or back pair at sqrt(1/2).
  2.1, 3.0, and 3.0(back) mix to stereo through three-channel matrices taken from each algorithm's 5.1 weights, where a back center enters through both surrounds at sqrt(1/2).
  Peak-normalized Lo/Ro and RFC 7845 renormalize those weights to sum to one, because the six-channel normalization left a full-scale 3.0 bed 3 dB and 0.88 dB low; RFC 7845 3.0 then equals opusfile's matrix.
  Every fold-down runs the limiter: a stereo downmix, an output speaker that sums channels, and a block a package rendered from objects, which it sums without a limiter of its own (revised 10-28; before, a source with more channels than the output, which missed 5.1.2 on 7.1).
- The output follows the source layout (10-07).
  Three channels and 5.1 use a 5.1 output when the device has six channels; 6.1 and 7.1 use a 7.1 output with eight, or fold into 5.1 with six; anything else mixes to stereo.
  Before 10-07, a three-channel source, and 7.1 on a six-channel device, mixed to stereo.
  A live switch applies the rule to the layout the decoder reported (`audio-source-format`), not to the container's declaration, which can under-declare E-AC-3 7.1.
  Until a track decodes PCM, the host's request, which follows Jellyfin's count, stands.
- Mono and three-channel sources play (10-07).
  The mixer duplicates mono, but the route tables rejected it, so the server transcoded every mono or three-channel track.
  Every decoded PCM route admits mono.
  Decoders without a speaker mask (AAC, FLAC, Opus, Vorbis, and PCM) deliver three channels as 3.0, so their three-channel routes need Jellyfin's 3.0 layout.
  Jellyfin keeps only the part of FFmpeg's layout name before `(` (`ProbeResultNormalizer.ParseChannelLayout`), so 3.0(back) arrives as 3.0 and 7.1(wide) as 7.1.
  AC-3 2/1 and 3/0 are therefore indistinguishable, and the AC-3 decoder of 10-07 reported no mask, so three-channel AC-3 is neither advertised nor admitted and transcodes.
  An AC-3 package reports its mask (10-13), but no evidence covers either bed yet.
  AC-3 mono plays.
  A profile condition cannot express ChannelLayout, so any other three-channel layout, a 2.1 FLAC or WAV for example, is negotiated, fails eligibility when playback starts, and plays through the HTML player or renegotiates to a transcode.
  E-AC-3 and TrueHD admit mono only.
- E-AC-3 7.1 needs the layout, not only the channel count: the decoder must report the decoded channel layout (`9ca70e11ad`).
  Eligibility also required a declared `7.1` layout until E-AC-3 became a package codec (10-13); a package reports every block's mask, which now decides alone.
- The DTS envelope, until 10-13.
  DTS-HD HRA was valid at 48 and 96 kHz only.
  Above 96 kHz only 5.1 MA (or MA with a DTS:X bed) was admitted.
  Stereo DTS-HD MA was admitted up to 96 kHz.
  Mono was admitted for every direct-play profile, and three channels for MA and MA with DTS:X when Jellyfin reports a 2.1 or 3.0 layout, because libdcadec reports their speaker masks (0x4, 0xB, 0x7, and 0x103 for 3.0(back), which Jellyfin also reports as 3.0).
  Since DTS decodes through a package (10-13), eligibility checks only the channel count, which still excludes DTS-ES's seven channels, and the package's speaker mask decides the layout at runtime.
- Decoded format is authoritative (10-07).
  The declared format only screens a track at preparation.
  The output stage binds to the first decoded rate and layout and rebinds on a later change: the old resampler's tail goes through the still-running limiter, and a new resampler continues its output timeline and input expectation.
  The worklet format and the output timeline never change, and the route tables are checked against the decoded values.
  The worker reports each bound format with `audio-source-format`, which the session's telemetry and ready event prefer over the declaration.
  Declared formats were wrong in the field:
  - Mediabunny reports the Matroska SamplingFrequency, which for HE-AAC is the 24 kHz core, and never reads OutputSamplingFrequency or detects implicit SBR;
  - in MP4 the AudioSpecificConfig overwrites the sample entry, so HE-AAC declares 24 kHz and, with Parametric Stereo, mono;
  - the dec3 parse can declare a 7.1 E-AC-3 track as 6 or 7 channels.
- Timestamps are reconciled within 2 s (10-07).
  Two field failures came from containers, not from audio.
  One was a TrueHD access unit that decoded to no PCM (833 us) plus 1 ms of Matroska rounding.
  The other was a Mediabunny lace artifact: a laced block that is last in its cluster keeps duration 0, so every frame of the lace gets the block's timestamp although the PCM is correct.
  The tolerance is max(codec floor, one container tick) plus an access-unit allowance plus one source sample: the floor is 3 ms for DTS and 1 ms otherwise, and the allowance is 834 us for TrueHD and MLP.
  Within tolerance an input is absorbed, and a timestamp at or before the previous one is absorbed as non-advancing.
  A gap up to 2 s is filled with silence, and an overlap up to 2 s is trimmed, or dropped when the remainder is within tolerance.
  A larger deviation fails the audio attempt as `decode-failed`, so playback renegotiates.
  The first design rebased the expectation instead, which shifted all later audio against video.
  The audio decode worker logs every correction over 100 ms and every failure with the input timestamp, the expected timestamp, and the correction.
  Output time stays the anchor plus output frames at 48 kHz, so the bridge, limiter, worklet, and clock see one contiguous stream.
  Output chunks are capped at 12000 frames, the 2 s ring divided among the 8 credits, so even a filled burst fits the worklet ring.
- The FFmpeg wrappers stamped later frames of one packet themselves (10-07).
  FFmpeg resets the packet timestamp after a partial consume, so the E-AC-3 and TrueHD wrappers stamped a frame without one at the packet time plus the frames the packet already produced.
  Since they became packages (10-13), the engine does it: a block that reports no timestamp of its own continues from its packet's earlier blocks.
- A late first audio sample is padded, not followed (10-07).
  In two MKV files the video started at 0 s and the first audio block at 6.006 s or about 25.9 s.
  Setting the worklet's media time to the first chunk it rendered made the clock jump to the audio start and drop the earlier video (631 frames for 26.3 s at 23.976 fps).
  The worklet renders silence from the flush position to the first chunk's timestamp.
  The native-media route parks `<audio>` at its first fragment and delays `play()` by the remaining gap, because Chromium snaps a seek only to buffered data that starts within 1 s, and otherwise `play()` stays pending until startup times out.
  Hidden tabs fire that timer late, so a timer more than 20 ms late first moves the parked element and its clock baseline forward by the overshoot, within the buffered range, and audio does not trail the clock.
  Only an `AbortError` caused by the backend's own pause, seek, or teardown stays silent; any other `play()` rejection is reported.
  Mediabunny proves that a track starts after a lookup time only after two scans, so an audio start at or before zero, or after no earlier packet, takes the first packet directly.
- A starting audio output holds the clock for its latency (10-15).
  The clock started running as soon as the `AudioContext` did, but the first sample reached the speakers `baseLatency` plus `outputLatency` later, so the first correlated report pulled the clock back 72 to 81 ms against a reported 64 to 72 ms on an Intel Arc laptop, and the first frames held for about two frame durations.
  Uncorrelated reports never move the clock, so the jump came from the clock's own start, not from them.
  Wherever an audio output starts, at playback start, resume, an output switch, and an underflow recovery without a correlated report, `MediaClock.resume` holds the media time for the output's estimated latency, at most 500 ms, so video moves when its first sample is heard and the first correlated report corrects only the estimate's error.
  Without an estimate the clock holds nothing and that report re-anchors it, as before.
- Audio that ends before video is not starvation (10-07).
  Treating the final underflow as starvation started an audio wait that fell back with `playback-stalled` after 10 s.
  The worker posts `audio-ended` for the epoch.
  The final underflow releases the tail without the end-of-stream steps: video waits stay in force, and an uncorrelated output releases at once instead of pausing the clock for its latency grace, because video carries playback past the tail.
  Once the tail is out, video starvation holds the clock as it does without audio.
  The ended track also stands in for the PCM a start, seek, or resync waits for, so a seek past the end of the audio starts.
  A native-media track ends its MSE stream, so `<audio>` plays out instead of stalling at its last fragment with the clock frozen.
  Once the element has ended, the clock runs on and `play()` is not called again, because it would restart the element from its earliest position.
  A hidden page keeps decoding video once the audio ended, and a released decoder restarts at the clock, because the worker ends the run only after the video track itself ended, not when it was suspended or interrupted.
- DTS and TrueHD play from ISO BMFF too (10-07).
  Mediabunny maps no MP4 DTS or TrueHD sample entry but records it as the internal codec ID, so the worker treats `DTS ` (QuickTime's core entry, with a trailing space), `dtsc`, `dtsh`, and `dtsl` like `A_DTS` and `mlpa` like `A_TRUEHD`.
  `dtse` (LBR) and `dtsx` (DTS-UHD) are unsupported because libdcadec, which the `dts` decoder project builds, cannot decode them.
  Two sample-rate fields need recovery.
  TrueHD writes the rate as a 32-bit integer, which reads back as 16.16.
  A DTS rate above 65535 Hz does not fit the 16-bit integer part, so muxers write zero, and the worker declares the 48 kHz core until the decoder reports the real rate.
  Mediabunny 1.61.5 maps `dtsc`, `dtsh`, `dtsl`, and `dtse` itself (10-15), so the worker maps only `DTS ` and `mlpa`, and refuses a `dtse` track as `The selected audio codec has no decode route: dtse`, which `isDTSExpressTrack` tells from the core entries.
- The `dts` package builds libdcadec with SIMD and link-time optimization (10-15).
  It built at `-O3` without either, while the FFmpeg audio packages used both, so nothing of libdcadec was vectorized.
  `-msimd128` and `-flto` grow the module from 268,676 to 332,684 bytes, each about half of that, and it decodes both DTS test vectors, Master Audio 7.1 and core 5.1, to the same samples as before.
- The FFmpeg audio packages build for speed, as the `dts` package does (10-16).
  `eac3` and `truehd` built at `-Oz`, which keeps FFmpeg from inlining and unrolling its transforms and bit readers; at `-O3` they grow from 520,412 to 539,361 and from 315,165 to 326,453 bytes, 3.6% each.
  A client downloads a package once and keeps it until the server offers another, so the size costs one download, while decoding runs for every second of audio.
  Both decode Mediabunny's E-AC-3 and AC-3 test files and the TrueHD test vector to the same samples as before.
- Normalization follows the metadata.
  Jellyfin fills track and album gain for audio libraries, not movies, so video sessions normally use unity gain.
- The resampler and the limiter render in WebAssembly, byte for byte as their JavaScript reference (10-09).
  On Node 24 the JavaScript resampler took 15 ms per second of 44.1 kHz stereo and 48 to 58 ms per second of 5.1 and 7.1, and the limiter 24 to 70 ms per second under sustained limiting.
  The time went to a bounds-checked call per filter tap, to reallocating and copying the retained history on every push, and to re-deriving the attack envelope over the whole 100 ms horizon for every output chunk.
  The `audio-output-stage` kit (C, simd128) keeps each history in a ring, sums each output frame's taps in float64 in tap order with SIMD lanes across channel pairs and neighboring frames, and applies each peak's attack once, when the peak arrives.
  That attack order is exact: the reference's constraint for a frame is the minimum over every peak whose attack reaches it, and its horizon always covers the longest attack.
  Afterwards 44.1 kHz stereo took 1.6 ms per second, 5.1 and 7.1 4.3 to 4.8 ms, and sustained limiting 6 ms.
  `StreamingAudioResampler` and `StreamingAudioLookaheadLimiter` stay as the reference and the fallback, and `test/audio/processing/AudioOutputStageModule.integration.test.ts` requires the same chunks, timestamps, sample bytes, errors, and telemetry from both.
  It covers randomized timelines from 8 kHz to 768 kHz with fills, trims, drops, and rejections, one to eight channels, pushes from one frame to the 65536-frame protocol maximum, rate changes with continuation, finalize tails, and the limiter quiet, loud, and beside its ceiling.
  Exactness needs the filter table and the `Math.pow` and `Math.exp` constants computed in JavaScript, `Math.log10` imported, no fused multiply-add, the reference's order of float64 operations, float32 rounding on store, and `Math.round` reproduced for the non-negative values it sees.
  NaN payload bits are implementation-defined in ECMAScript and WebAssembly alike, so the test requires NaN in the same samples, though on V8 x64 its bits matched too.
  A 48 kHz source only passes through, so it keeps the JavaScript path, which a staging copy into the module would only slow.
  The downmix and its live settings ramps stay in JavaScript: they cost little, and moving every algorithm would add risk without gain.
  Timeline reconciliation, timestamps, and output chunking stay in TypeScript too, so both paths share them.
  The audio decode worker loads the module once, on its first attempt.
  If it does not load or instantiate, that worker warns once and every output stage renders through the reference, and a kernel the module cannot allocate falls back the same way, so playback never fails for it.
  Each attempt frees its kernels when it ends, also when a seek or a resync stops it early, because the worker outlives its runs.
- Decoded PCM goes from the worker straight to the worklet (10-09).
  The page used to receive every chunk as an `'audio'` message and post it on to the worklet, so decoded audio waited on the page's main thread.
  The page now creates the channel, hands the producer's end over with `attach-audio-output` or `resync-audio`, and learns each chunk's place and length from `audio-progress`, which readiness, telemetry, and the end-of-stream drain read.
  `WorkletPCMProducer` owns the credit window and checks each chunk as the page's bridge did, so a gap, an overlap, or an overflow still fails as `audio-output-failed`.
  The worklet returns each played chunk's buffers, and `PCMChannelPool` lends them to the output stage for later chunks.
- The worklet computes signal statistics only when a host shows them (10-15).
  Its peak, RMS, clipping, and non-finite counts took a finite check, an absolute value, a maximum, and a square for every output sample on the audio rendering thread, and only the sandbox's diagnostics read them.
  `createBrowserCustomAudioOutputFactory` takes `{ analyzeSignal: true }` to turn them on; every output sets its choice on each worklet it leases, since the pool hands one node to the next session, and telemetry carries `signal` only while they are on.
- An audio decode worker decodes and renders decoded PCM (10-09).
  The worker spawns `CustomAudioDecode.worker.js` at its first decoded PCM start and keeps it for its life; terminating the worker terminates it too.
  It runs audio decoder packages (the bundled E-AC-3, DTS, and TrueHD decoders until 10-13), the downmix, the output stage, and the producer, so video work in the worker never delays audio, and audio decoding never delays video.
  Demux stays in the worker, which reads the source once for both tracks.
  The worker sends compressed packets copied back to back, or Mediabunny's decoded samples cut to the start, in batches that close at 40 ms of media time or 64 inputs, so TrueHD's 1200 access units a second do not each cost a message.
  4 batches are in flight, and each returns its credit once rendered under the producer's window, so demux runs at most a few batches ahead.
  Progress, the decoded format, an attempt's end, and failures return through the worker, which keeps their order with `audio-ended` and `stopped` on its one channel to the page.
  A run's `stopped` waits until the audio decode worker released the run's attempts.
  Failures keep their kinds, and a lost audio decode worker fails the run as `audio-output-failed`, which falls back to HTML in the same session; the next decoded PCM run spawns another.
  Mediabunny's own decoding stays in the worker: WebCodecs decodes off the worker's thread anyway, and `@mediabunny/ac3` exposed only its Mediabunny registration until AC-3 became a package codec (10-13).
- Audio decoders are packages (10-13).
  The E-AC-3 and AC-3, TrueHD and MLP, and DTS decoders left the engine and became decoder projects (`eac3`, `truehd`, and `dts` in `wgpud/`), which build packages a host supplies; `@mediabunny/ac3` left too.
  The order is the MSE bridge, then the engine's own decoders (WebCodecs and Mediabunny's PCM), then the first package whose manifest accepts the codec, so AC-3 without MSE needs a package.
  Eligibility checks only the codec's input channel counts and rate, because a package reports every block's speaker mask, which the engine checks before it mixes, and the decoded format is authoritative anyway.
  The profile, rate, and layout rules that gated the bundled decoders on their qualification vectors therefore no longer apply: a stream the package cannot decode, such as DTS-UHD, fails its attempt as `decode-failed` and renegotiates.
  Every start and seek runs on a new instance of the package's module, so a decoder never sees a jump in its packets.
- Audio packages take codec private data, and WMA plays from Matroska, AVI, and ASF (10-28).
  FFmpeg's WMA decoders need the stream's WAVEFORMATEX before they open, as `ff_get_wav_header` hands its rate, channels, average bytes per second, block alignment, and extradata to them, while the AC-3, E-AC-3, DTS, MLP, and TrueHD decoders find everything in their packets.
  So the decode worker reads a track's codec private data with the track and sends it with the package selection in each attempt's open request, and `PackageSoftwareAudioDecoder` calls `audio_decoder_configure` once before the attempt's first packet; the codecs that need none still get no call.
  The `wma` package's configure parses the WAVEFORMATEX, refuses a short header, a format tag other than its codec's, or a failed open with named errors, and opens the decoder; a send before it fails as `unconfigured`.
  The contract is the whole WAVEFORMATEX, header and cbSize bytes, rather than the extradata alone, so the package sees the block alignment and bit rate FFmpeg's WMA decoders read, and a WAVE_FORMAT_EXTENSIBLE header names its codec by its SubFormat as `riffdec.c` reads it.
  Mediabunny maps no `A_MS/ACM` track and no WMA format tag, so the worker reads the WAVEFORMATEX itself: a Matroska track's CodecPrivate, or, from the fork's parsed `strf` fields, an AVI stream's, written back with a SubFormat on the media subtype base.
  The fork's AVI demuxer dropped an audio stream whose format tag it maps no codec to; it now keeps it codec-less with its tag as its codec ID, as it keeps a video stream of an unknown FourCC, which also keeps the engine's audio ordinals in step with Jellyfin's streams in such a file.
  Its packet times already match FFmpeg's `avidec.c` for WMA: FFmpeg's AVI muxer writes the frame size as the scale, the rate as the rate, and the block alignment as the sample size, and both demuxers time each block as one sample, which ffprobe's packet times of an FFmpeg WMA v2 AVI confirm.
  FFmpeg's WMA decoders hold frames back until their input ends, 8192 frames for 24-bit WMA Lossless, so the interface gained an optional `audio_decoder_drain` export, which the audio decode worker calls once at the end of a track before the output stage's tails; a module without it ends at its last packet's blocks, so the other packages are unchanged.
  The fork ignores Matroska's CodecDelay for every codec, and the engine leaves it so: FFmpeg's WMA v1 and v2 decoders skip their own 4096-frame delay, while FFmpeg's Matroska demuxer replaces that skip with the track's CodecDelay, 2048 frames in FFmpeg's own WMA Matroska encodes, so such a file plays 2048 frames later into the stream than FFmpeg plays it, and an AVI or a Matroska file without a CodecDelay plays as FFmpeg does.
  ASF, where WMA usually lives, had no demuxer in Mediabunny or the fork when this entry was written; the fork's ASF demuxer now reads it, and the worker reads an ASF stream's WAVEFORMATEX as it reads an AVI stream's (see "ASF plays through an ASF demuxer in the fork").
- AAC, Opus, FLAC, and Vorbis play 7.1, each on its own 7.1 probe (10-28).
  Chrome 156 on Windows decodes 8-channel AAC-LC, Opus with mapping family 1, FLAC, and Vorbis from Matroska through Mediabunny's decoder configuration into 8-channel `AudioData` whose planes are in WAVE 7.1 order, FL, FR, FC, LFE, BL, BR, SL, SR; AAC and Vorbis output `f32-planar`, Opus `f32`, and FLAC `s32`.
  A silence vector cannot show plane order, so each codec's 7.1 vector carries one sine per source channel (400, 600, 800, 60, 1000, 1200, 1400, and 1600 Hz at amplitude 0.25), and the probe measures every decoded plane over a 2048-frame Hann window centered in the decoded stream with a Goertzel filter at each tone.
  A plane passes when its own tone keeps at least 0.125, or 0.025 for the LFE, which a lossy encoder may attenuate, and is at least 10 times (20 dB) stronger than every other channel's tone; so Vorbis or Opus channel order, 7.1(wide), six channels, and silence all fail, which tests and a real-decoder run with permuted expectations confirm.
  In Chrome 156 every own tone was 30 or more times stronger than any other, the weakest being AAC's, whose encode at 512 kbit/s keeps that margin where 384 kbit/s left a back-to-side leak of only 4 times; the decoded LFE kept its full amplitude.
  The 7.1 verdicts are a probe of their own, `native-seven-point-one-audio`, kept beside the 5.1 ones in `nativeSevenPointOneAudio`, so a stored entry written before it holds no verdict under its name and a page probes only 7.1 again.
  In the sandbox on Chrome 156 with a stereo destination, 8-channel Matroska files of each codec with the same tones played the decoded PCM route at 8 channels in and 2 out, at -11.1 dBFS RMS, the level the default Lo/Ro downmix gives these tones through the 7.1 layout.
  FFmpeg's encoder writes 7.1 AAC as AudioSpecificConfig channelConfiguration 7, which FFmpeg's decoder, and Chrome's with it, reads as 7.1 with back and side pairs (`libavcodec/aac/aacdec.c`), not the specification's 7.1(wide), and Jellyfin reports either as `7.1`; the probe proves the order Chrome gives FFmpeg's encode.
  Mediabunny's PCM route stays at 5.1 and 6.1 sources stay unsupported, since no vector covers them.
- Height output layouts, a speaker layout choice, and binaural headphones (10-28).
  Atmos objects render in the packages, so the engine qualifies FFmpeg's 5.1.2 (`0x503F`), 5.1.4 (`0x2D03F`), 7.1.2 (`0x563F`), and 7.1.4 (`0x2D63F`) as decoded and output layouts of 8, 10, and 12 channels in WAVE order; 5.1.2 and 7.1 share 8 channels, so the pipeline carries a layout name, not a count.
  A height the output lacks folds into the floor pair beneath it, and every channel a speaker sums takes 1/sqrt(n) of n, sqrt(1/2) for a pair as the existing folds, which keeps the power of content common to them; a height layout mixes to stereo through its folded floor and the selected algorithm.
  The host's setting, `auto` or an explicit layout, resolves on the destination's channel count; a source a package renders as objects plays the whole layout and every other source keeps the floor rule, so beds never spread onto heights.
  Binaural is the host's opt-in, applies only on a stereo output, and switches live without rebuilding the output.
  An Atmos-profiled E-AC-3 or TrueHD stream prefers a rendering package over the browser's MSE decoder only when the target needs objects, so 5.1 and stereo outputs keep the native route; the add-on fetches the server's packages for such a track before it settles for the native route (`playbackAudioNeedsObjectRendering`).
  FFmpeg's stock E-AC-3 decode of a dependent stream that adds heights reports 5.1(side) with the top front pair, `0x560F`, which is qualified as a decoded layout and folds like 5.1.2.
  While a package renders, a live switch judges the source by its declared channels, since the blocks carry the output layout or binaural stereo; a binaural change made while a switch builds its output reaches the resync it posts.
- TrueHD Dolby Atmos objects decode with our own decoder of the 16-channel presentation (10-28).
  FFmpeg's TrueHD decoder stops at the 8-channel presentation: `max_decoded_substream` caps at substream 2, `MAX_CHANNELS` is 8, and its restart header refuses the `0x31EC` sync word of substream 3, which carries the 16-channel presentation.
  Depending on the truehd crate of truehdd, or on any other Atmos library, was ruled out, and stock FFmpeg stays unpatched, so `wgpud/truehd/truehd_presentation.c` ports FFmpeg's `mlpdec.c`, `mlpdsp.c`, `mlp.c`, and `mlp_parse.c` into one LGPL-2.1-or-later file and generalizes them to 16 channels and 4 substreams.
  What FFmpeg lacks, the `0x31EC` matrix syntax with its interpolated coefficient deltas, the substreams of each presentation, the extra channel meaning, and the Evolution frame that carries object audio metadata, is documented only by the truehd crate (Apache-2.0), which was read to learn the layouts and written anew; the file's header and `decoders.md` cite it, and the Evolution payloads follow the EMDF payload syntax of ETSI TS 102 366 Annex H.
  FFmpeg keeps its decode wherever it decodes: the package outputs FFmpeg's presentation unless the target needs objects, binaural rendering or a speaker that presentation lacks, so MLP, TrueHD without Atmos, and Atmos at a covered target play exactly as before, which the package tests check against the TrueHD qualification fingerprints at every target.
  truehdd at commit `77ddc52`, built natively, is the black-box oracle: the port decodes the 16-channel presentations of `fba_atmos_obj.mlp` (5600 frames of 16 channels), `fba_atmos_cbi.mlp` (5440 of 16), and `fba_atmos_dimtrim.mlp` (16000 of 12) bit for bit as truehdd does, and every other presentation of the crate's eight TrueHD streams and the engine's three TrueHD vectors too.
  Against FFmpeg 862338fe31, presentations 0 and 2 of all eleven streams and presentation 1 wherever FFmpeg's `downmix` option selects it are bit-exact up to FFmpeg's channel order; two streams whose presentation 1 is a stereo downmix it cannot select were compared with truehdd only.
  Every restart header's lossless check passed.
  FFmpeg keeps its prediction filter state across a restart header where the truehd crate clears it; the two agree on all these streams, and the port keeps FFmpeg's.
  The object metadata parser in `wgpud/atmos/` reads the 15 payloads of the two object streams, and the 39 metadata events truehdd writes for them match its values: positions within 3.2e-7 of a room unit, gains, ramps of 1536 samples, and active flags, with a payload's timing counted from its access unit's first sample.
  The 16 channels are the payload's objects in order, beds first, as the crate's object presentation lays them out; a presentation without metadata, such as `fba_atmos_cbi.mlp`, is the bed its major sync's 16-channel channel assignment names.
  A packet renders only when all its access units decoded and rendered, or plays FFmpeg's decode, so a switch to a target that needs objects renders from the first packet after a major sync and object metadata, every 128 access units and 1536 samples in these streams, and a switch away returns to FFmpeg's decode at once.
  In Chrome 156 on Windows, the rebuilt package under `PackageSoftwareAudioDecoder`, fed one access unit per Matroska block of the looped object and bed streams, rendered binaural stereo at mask 0x3 with `objectCount` 15 and 11 for the object streams and 0 for the bed, drained its 128-frame tail, and played through a 2-channel `AudioContext`; at 7.1.4 it rendered mask 0x2D63F, and the bed stream with binaural off played FFmpeg's 7.1 at mask 0x63F.
  Decoding and rendering took 67 to 154 ms for 4.5 to 5 seconds of audio.
- E-AC-3 Dolby Atmos objects decode with our own joint object coding decoder (10-28).
  FFmpeg's E-AC-3 decoder reads only the Atmos flag in `addbsi` and outputs the 5.1 or 7.1 core; the objects need the EMDF payloads and the JOC upmix of ETSI TS 103 420 V1.2.1, which no FFmpeg decoder has.
  Depending on OpenJOC, or on any other Atmos library, was ruled out, and stock FFmpeg stays unpatched, so `wgpud/eac3/` adds its own EMDF reader, JOC decoder, and filter bank (MIT), written from TS 103 420 clauses 6 to 8, Annex A, and its companion archive `ts_103420v010201p0.zip` (Huffman trees and filter window), and TS 102 366 V1.4.1 Annex H (EMDF).
  OpenJOC (Apache-2.0) was read to learn where Dolby's encoder writes the container, an audio block's skip field rather than the frame-end auxiliary data, and how JOC objects pair with OAMD objects: the scene's objects in payload order, the LFE taken from the core.
  Reaching a skip field exactly takes the audio block syntax up to it, mantissas included for later blocks, which would duplicate most of FFmpeg's decoder, so the bridge finds the EMDF syncword with a valid `skiple`, `skipl`, and complete container instead; on Dolby's stream it found the container at the same bit as OpenJOC's block parse in all 64 access units.
  Two texts of TS 103 420 contradict themselves, and the code follows what reconstructs: synthesis uses the matrix equation's exponent (2j - 255), since pseudocode 14's (2j - 129) does not invert the analysis, while the equation's reconstructs white noise at 78 dB after 577 samples; steep interpolation maps subbands to parameter bands, as pseudocode 6's smooth branch does.
  Sparse coding follows pseudocode 2 literally, unselected channels at the offset value, as OpenJOC does.
  OpenJOC at commit `e3e330a`, built natively, is the black-box oracle: on the same FFmpeg downmix and payloads, the objects match its decoder within 6e-8 of full scale, 129 dB or more per object, over all 64 access units and 15 objects of androidx/media's `sample_eac3joc.ec3`, and within 4e-10 on its synthetic fixtures with 5- and 7-channel downmixes, sparse and dense coding, and one or two data points.
  OpenJOC's own OAMD parser refuses the Dolby stream, so its positions could not serve as an oracle there; the shared parser reads a 5.1 bed and 10 dynamic objects.
  The filter bank delays objects by 577 samples; the bridge holds each block until later frames fill that delay and the binaural latency, rather than shifting timestamps by a fraction of a microsecond, so blocks keep their packets' timestamps and the optional drain outputs the last one.
  In Chrome 156 on Windows, the sandbox played the Dolby stream looped under H.264 in MP4 at the 2-channel destination: binaural off reported 6 channels to stereo and 0 objects, the stock decode; binaural on reported 2 channels and 10 objects, without underruns or non-finite samples.
  Under Node the package decodes and renders 0.512 s of the stream at 7.1.4 in 12 ms.
- Atmos objects render with our own OAMD parser and renderer, shared by both packages (10-28).
  Depending on OpenJOC's renderer, Cavern, the truehd crate, or any other Atmos library was ruled out, so `wgpud/atmos/` (MIT) parses object audio metadata from ETSI TS 103 420 V1.2.1 clause 5 and renders from Recommendations ITU-R BS.2051 and BS.2127; the `eac3` and `truehd` modules compile the same sources through `ATMOS_MODULE_SOURCES`, so both formats place and pan objects alike.
  TS 103 420 contradicts itself once: clause 5.5.11 tests `obj_render_info[0]` for the position, while Table 31 gives the position `[3]`, the last of the four bits.
  The parser follows the table: every other flag array of the payload carries the flag of its first-parsed field last, which Dolby's DD+ JOC stream and TrueHD streams confirm for `content_description[]` and the bed assignments, and the AC-4 form of the syntax (TS 103 190-2 clause 6.2.8.7) reads `b_obj_render_position_present` last; truehdd's `oamd` crate (Apache-2.0), read to settle this and the place of a dynamic-object program's LFE (first, as a bed object), agrees.
  OpenJOC's synthetic fixtures write that flag first and fail to parse; they come from OpenJOC's own encoder, not Dolby's.
  On Dolby's `sample_eac3joc.ec3` from androidx/media the parser reads a 5.1 bed and 10 objects, six of them on the right wall and four of those raised; the stream's JOC upmix rebuilds each of those six from the core's R and Rs alone (cross-correlation with L, C, and Ls under 0.001), so the layout is the content's, and the left heights stay silent there by design.
  The panner is room-centric and separable, the allocentric approach of BS.2127 for Cartesian positions: OAMD positions are coordinates in the room's cuboid, not directions, so panning between layers, rows, and speakers by the walls keeps an object where the mix placed it on every layout, puts an object at a speaker on that speaker alone, preserves power by construction with the sine and cosine law, and needs no triangulation per layout, which VBAP would.
  Not rendered: trim, divergence, and ISF objects (a scene with them is refused); a screen-anchored position plays as the room position it codes.
  Ramps interpolate an object's properties, with gain vectors every 32 samples and linear gains in between, so an update's values arrive at exactly its start plus its ramp duration whatever the calls' lengths, and 16 continuously moving objects cost little: under Node, 10 s of 16 objects plus an LFE at 7.1.4 render in 36 ms, or 231 ms when every object also has a size, and binaurally in 68 ms.
  The binaural set is MIT's KEMAR measurements (Gardner and Martin, 1994), diffuse-field equalized: their terms allow any use with citation, so the table can ship inside the LGPL-2.1-or-later packages without adding license terms of its own.
  The virtual heights take KEMAR's 40 degree elevation, the only one of its elevations from 30 to 50 degrees that measures azimuths 45 and 135 exactly, as BS.2051's 4+7+0 upper layer places them.
  Uniformly partitioned convolution in 128-sample blocks delays binaural output by 128 samples, which the renderer reports and the packages drain; zero latency would take a direct 128-tap head for 22 responses, about 135 million multiply-adds a second.
  The LFE enters both ears at 0.5, the LFE level of the engine's Dave750 matrix, since the default Lo/Ro omits the LFE and headphones would otherwise lose it.
  In Chrome 156 on Windows, the test module rendered a noise object circling the room in 2 s: the level difference between the ears turned from right (-11 to -14 dB binaural, -19.6 dB stereo) to left (+12 to +14 dB, +19.6 dB) as the object passed the sides, in 13 ms binaurally and 7 ms in stereo, and played through a 2-channel `AudioContext`.

## Passes

- mpv user shaders convert through naga (10-16).
  `tools/convert_mpv_shader.py` parses the `//!` headers itself and hands each pass's GLSL to naga-cli 30.0.1 inside a wrapper of stubs for the mpv shader API, then binds the stubs to the pass API, rather than translating GLSL with a parser of its own.
  The version is pinned, since the converter repairs that version's GLSL frontend: it reverses adjacent array dimensions, reads a for-loop condition that opens with a constructor as a declaration, lowers `barrier()` with a `subgroupBarrier()` WebGPU lacks by default, rejects a function that can end without a return, `dot()` of scalars, and a swizzle of a scalar, and cannot fold a ternary in a global `const`.
  Every converted pass is validated with naga before the file is written.
  71 user shaders were checked in development: Anime4K's, bjin's ravu and nnedi3 variants, FSRCNNX, KrigBilateral, SSimSuperRes, SSimDownscaler, adaptive-sharpen, FSR, CAS, NIS, and SGSR, then the Chroma from Luma prediction shaders.
  70 of the 71 converted, as did both Chroma from Luma shaders, and all of their passes planned and compiled under naga in the planner's modules on the raw, frame-pool, external, and deinterlacing routes; NVScaler's shared memory exceeds the limits below.
  ravu-zoom converted once `TEXTURE` blocks became texture blocks of the pass file.
- The engine keeps WebGPU's default compute limits, and a shader that exceeds them is modified to fit (10-16).
  Requesting an adapter's larger limits would make a pass run on some devices and not others, so the `nis` project converts NVScaler at a 32x16 block instead of 32x24, which takes 16208 bytes of workgroup storage instead of 21776 and keeps every thread's work otherwise as the port wrote it.
  The upstream files stay unmodified, and the generator changes the two lines in memory.
- Plane passes run on the signal's planes (10-16).
  mpv's `LUMA`, `CHROMA`, and `NATIVE` hooks see the decoded planes before conversion, which only the signal step reads, so the spine starts with plane stages of those names, and the converter maps the hooks onto them.
  Deriving planes from the RGB image, as the converter first did, gave `CHROMA` the image's size, so a chroma upscaler, whose `WHEN` asks for subsampled chroma, never ran, and it could not read native chroma anyway.
  `CHROMA_SCALED` still reads the RGB image, since the engine never holds chroma apart at the image's size, through the prelude's transform of the source's own matrix and range (10-16).
- The signal converts what plane passes leave (10-16).
  The fixed signal step is decode-equivalent, so the merge that converts the planes is built from the signal's own functions: its plane reads, its chroma siting, and its range and matrix.
  It reads each plane no pass replaced straight from the source, so a chroma upscaler leaves luma exactly as decoded, and a plan without plane passes is the plan it always was.
  The alternative, converting the passes' chroma into the RGB image in the converter, would need the source's matrix and range in every converted pass.
- Offsets follow libplacebo's texture rects, and no read is shifted (10-16).
  libplacebo binds every texture whole, so `NAME_pos` is the output's coordinate whatever the texture's rect, and only `OFFSET ALIGN` moves the hooked texture's position onto its rect; the rects decide where each result lands, which the plane merge and the final scaler apply.
  Folding each input's offset into its accessors would shift reads that a pass computes itself: KrigBilateral's upscaling pass reads `LOWRES_Y` at chroma texel centers it derives from the aligned `CHROMA_pos`, which a folded read would move between texels.
  So the engine gives each input its offset as `<P>_offset()`, as mpv's `NAME_off`, and places outputs as libplacebo does.
- Routes without decoded planes derive them from RGB through the conversion that made it (10-16).
  An external route imports a frame the browser already converted, so its planes come back through the stream's own matrix and range, at its bit depth, from its color metadata, which the merge inverts exactly; the identity route therefore carries the stream's metadata, and has no planes while it does not know it.
  On the external HDR route the engine itself labels the stream BT.709 for the browser, so its planes are the codes its signal recovers from that labeling, which match the signal's own codes exactly; a BT.709 assumption on every route gave a BT.601 or BT.2020 source the wrong luma and chroma.
  Preferring a plane route for a preset that needs planes would make a preset change the route.
  The Dolby Vision routes offer no planes, since reconstruction maps each pixel's base-layer codes, so they leave plane passes out as `planes-unavailable`.
- An external route's chroma takes the stream's subsampling from its decoder configuration (10-16).
  The decode worker reads it from the track's avcC (its closing chroma format, else its first SPS), hvcC, or av1C, the SPS in its first key packet where it has no record or its record no SPS, or the AV1, VP9, or VP8 codecs string, and every frame carries it, so the presenter plans with it without a host fact.
  Derived chroma is read at each chroma sample's site, as the stream's location places it, so a chroma upscaler runs on the external routes too.
- Chroma is read where the stream declares it lies (10-16), revising the engine's fixed siting, which read every planar format's subsampled chroma left and NV12's at its texel centers.
  4:2:0 chroma takes the location of H.273's six types that an H.264 or HEVC SPS's VUI declares, or an av1C's or AV1 codecs string's chroma_sample_position, and the left siting H.264 and HEVC default to where none is declared; UHD HDR encodes declare top-left, which the fixed siting read half a luma row off.
  The SPS is the first of the avcC or hvcC, else the first base-layer SPS among the first key packet's NAL units (10-27): MPEG-TS, M2TS, and Annex B AVI tracks have no record, and an avc3 or hev1 track's record may carry no SPS, so their location once kept the default.
  The worker reads that packet only for such a track, before its ready response, Annex B where the track has no record and length-prefixed where it has one.
  MPEG-1 is center-sited 4:2:0, as FFmpeg's `mpeg12dec.c` sets it for every MPEG-1 stream, which has no field that declares a location (10-27).
  4:2:2 chroma stays on its left luma column, which H.264 and HEVC fix whatever the VUI says, and 4:4:4 chroma on its luma samples.
  VP9's codecs string is not read for a location: muxers write its colocated 4:2:0 value for chroma of unknown siting, as FFmpeg does unless its source is known left, and Mediabunny names WebM's that way, so the value does not declare one.
  The HEVC location first came from the bounded SPS parser, so a stream outside its progressive Main and Main 10 bounds kept the default; since 10-27 the parser also reads any profile's SPS through its VUI without those bounds, as FFmpeg's `hevc/ps.c` reads range extensions, Main 12, and field sequences, so those streams declare theirs too.
  A deinterlacing plan's field read keeps MPEG-2's vertical field siting, which interlaced sources take, and the location's horizontal shift.
  The worker's ready response names the stream's chroma and the session attaches it to every frame, the frame pool feed to its frames, so every output mode carries it; the presenter plans again when it changes, preset or not, and a plan that does not change keeps its executor.
  The frame pool route's chain now builds its signal from the GPU decoder's output format, as the raw route's does, so its signal takes the location too.
  Read back that way, the browser's chroma is exact across, since a bilinear upsampler passes through the samples it interpolates, and down it is the 4:2:0 rows' [1, 6, 1] / 8 blur under bilinear upsampling: exact for chroma that varies linearly, about 0.0014 RMS of the plane for smooth chroma, a third of an 8-bit code, and 0.09 RMS for chroma that changes every row; the browser's own upsampler and its rounding to 8-bit RGB are unknowns on top.
- A deinterlacing plan derives its planes from the deinterlaced image (10-16).
  Plane passes once left a deinterlacing plan out, since the deinterlacer works on the signal's RGB, after the planes, so luma shaders that ran on interlaced sources through RGB-derived planes stopped running there.
  The planes now come from the deinterlaced image through the signal's transform, as mpv's shaders see the planes of a deinterlacing filter's output, and no pass after the deinterlacer reads the source, so a held field still draws from history alone.
- The planes hold the frame's samples (10-16), revising their first placement on the source's display grid.
  Plane sizes derive from the frame's visible sample size, a plan fact (`PlanFacts.sampleWidth` and `sampleHeight`, the `luma.width` and `luma.height` facts) that the presenter follows per frame and plans again on, so an anamorphic stream's planes keep its samples, as mpv's do, and the scaler takes the merged image to the display's shape.
- Chroma's rect is luma's over the subsampling divisor (10-16).
  libplacebo keeps a subsampled plane's rect at the source rect over the divisor, so an odd luma width leaves the chroma texture's last texel half outside the rect and chroma's scale exactly half luma's.
  The engine took the texture's extent as the rect, which moved chroma by up to half a chroma texel across the frame, so each plane image now carries an extent: the chroma read covers whole texels, the merge reads chroma through extent over size, and a pass's output extent scales as libplacebo scales a rect.
- mpv's linear light is 1.0 at reference white, which the engine gives passes (10-16).
  The engine's linear light is in nits, so a `LINEAR` or `SIGMOID` pass divides by the prelude's `referenceWhiteNits()`, the configured SDR white for an SDR source and BT.2408's 203 nits for HDR, and multiplies its result back; it was an SDR pass over a fixed 100 nits and an HDR pass over 203, which `hdr.source` chose.
  The prelude's `linearize()` and `delinearize()` compile from the built-in transfer decode's own code, renamed apart from it, and its exact inverse, so they are the source's transfer rather than the gamma 2.4 the converter once stood in.
  They and the plane transform are defined only in modules whose bodies call them, so no other module grows.
- Pass files carry texture blocks (10-16), replacing the converter's constant arrays of at most 4096 texels.
  A host stores one file per pass, so the texture travels inside it, in base64, and the passes that bind it read it through accessors with its filter and edge mode.
  The engine uploads a block when a plan first binds it, keyed by a content identity of its size, format, and data, which the parse computes synchronously since a plan needs the identity; uploads live until neither the installed plan nor the preset holds them, with no count or LRU limit.
  The identity is cyrb53, a 53-bit non-cryptographic hash, rather than a SHA-256: `crypto.subtle` digests asynchronously, a hand-written SHA-256 was code to keep for a cache key, and two of a preset's few blocks collide with a chance of about one in 2^53.
  A one-dimensional block is a texture one texel high, since WGSL samples a 1D texture only in fragment code, and a block beyond the device's texture size, or a linear filter on a format it cannot filter, leaves its passes out with a code of its own.
- A pass's `when` reads its own parameters (10-16).
  The plan request carries the current values, and the presenter plans again when a parameter some `when` reads changes; the executor of a plan that comes out the same keeps running, and every other parameter stays a uniform write.
  The converter once fixed parameter defaults into `when`, or ran a parameter `WHEN` every frame as a guard that presented the image unchanged; a `when` that reads the parameter replaces both.
- `const` parameters compile into the plan (10-16).
  A WGSL override constant was the alternative, but the executor builds every pipeline of a plan anyway, and a `const` may also size an array or fold into other constants, so a change builds a new plan whose modules hold the new value.
  The converter declares an mpv `CONSTANT` as a GLSL global, which naga reads by name, unless the code needs a constant expression of it; such a constant naga may fold, which a second translation at another value detects, and a folded one keeps its default.
- A `DEFINE` parameter splits its pass (10-16).
  A `DEFINE` steers the preprocessor, so no single translation serves every value; the converter translates one pass per value of the `DEFINE` parameters a pass's code reads, each under `when: <name> == <value>`, up to 16 passes, past which the parameters keep their defaults.
- `rgb.source` tells RGB sources apart (10-16).
  mpv fires `RGB` on RGB sources and `LUMA` and `CHROMA` on YUV ones, so the converter keeps both copies of a pass that hooks both, each under the fact, rather than dropping `RGB`; every route presents YUV, so the fact is 0 on each.
- Converted compute passes keep WebGPU's default limits (10-16), as the pass header does: 256 invocations per workgroup and 16 KiB of workgroup storage.
- Smooth motion is a user pass that draws at the display rate (10-27), `wgpup/smooth-motion/`, rather than a built-in step.
  It blends the two frames a refresh spans by the share each covers, as libplacebo's `oversample` does.
  It blends at `OUTPUT` in the `display` domain, linearizing the sRGB encoding, so each frame is tone mapped with its own metadata, and identity SDR routes, whose color track is empty, keep it.
  Frames are taken one refresh ahead, so the frame that starts within a refresh is in history when it draws.
  The display rate is a least-squares fit of rAF times over refresh counts, published with 0.1% hysteresis so jitter does not replan a condition that reads it.
  Whether frames blend is judged on every draw, from the refreshes a frame lasts at the clock's rate, the media time between the recent frames over the media time a refresh covers, rather than by a `when` condition at plan time, which judged once from the declared frame rate and the display rate, missed a playback rate, and kept the pass out on a whole multiple; a playback rate, a new frame rate, or another display now takes effect within frames (10-27).
  The media time between frames is a least-squares line through the frames' timestamps over frame counts rather than a mean of their durations (10-27): Matroska's millisecond timestamps put a mean of 16 durations of 24 fps video up to 0.2% off, which turned blending on and off at 144 Hz, where the line holds 6 refreshes per frame to 0.02%.
  `tolerance` defaults to 0.2%, so a 1000/1001 mismatch, which repeats a frame only every 16.7 s at 60 Hz, counts as no judder.
  A deinterlacing plan leaves it out, since its history holds fields rather than the frame after the shown one.
  Redraws start at the first display-rate pass, so a heavy pass before it, such as Anime4K, runs once per frame.

## Repository

- The engine is its own repository (10-02): [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player), MIT, with each vendored library under its own license.
  Hosts check it out as a git submodule and import it as `webgpu-player/*`.
  Its only host is the Jellyfin plugin's add-on.
- Mediabunny comes from the user's fork, vendored as a submodule and aliased, not installed (10-15).
  The fork, [alchemyyy/mediabunny](https://github.com/alchemyyy/mediabunny), is Mediabunny 1.61.5 with six upstream pull requests merged, each in a merge commit named after it with its authors' commits kept: #155 (AVI), #156 (MPEG-4 Part 2), #298 (MP4 chapters), #409 (AIFF), #443 (ASS subtitle muxing), and #495 (`getUnsupportedFeatures`).
  On top of them the fork times AVI audio chunks as FFmpeg's `get_duration` does, maps WAVE_FORMAT_EXTENSIBLE AVI audio and reports its channel mask, describes FLAC and Vorbis in AVI (`v2-avi-wave-format-extensible`, `v2-avi-flac-vorbis`), reads AVI OpenDML indexes and unpacks DivX packed B-frames (`v2-avi-opendml-index`, `v2-avi-unpack-packed-bframes`), and demuxes MPEG-1, MPEG-2, and VC-1 from MPEG-TS and M2TS.
  Fixes meant for upstream are cut from upstream's `main`, one branch per bug, and merged into the fork's `main` in a merge commit named after the branch: `fix-matroska-laced-header-stripping` and `fix-custom-decoder-close-after-failure` (10-16).
  `vendor/mediabunny` pins the fork's commit as a shallow submodule, the way the add-on pins its hls.js fork.
  A `file:` dependency would have installed the fork's development dependencies into the host's lockfile, so nothing installs it: the tsconfig `paths` entry maps `mediabunny` to the folder for tsc, esbuild, and Vitest, the sandbox's Vite config and the host's webpack and Vitest configs alias it, and both ESLint configs ignore the import.
  `scripts/mediabunny.mjs` builds the fork's `dist/` with its own pinned toolchain (`npm ci --ignore-scripts` in the folder, then its `tsc` and import-extension pass), stamps the commit in `dist/webgpu-player-build.json`, and skips the build while the stamp matches; the engine's typecheck, test, lint, and build scripts run it first.
  The version move from 1.52.2 removed the engine's G.711 decoder registration, which Mediabunny 1.61.5 decodes itself, and the ISO BMFF DTS sample entry mappings, which it maps itself.
  The fork follows Mediabunny v2, upstream's `v2` branch, since 10-16: its `v2` branch merges upstream's `main` (1.61.6) in one commit, then carries the six pull requests, the AVI timing, and the MPEG-TS video, ported where v2 changed their code (AVI, AIFF).
  It merged upstream's `main` again at 1.62.1 (10-27), with `main`'s fixes to the sinks v2 removed moved into its packet reader and PCM decoder; AVC and HEVC in MPEG-TS take their access unit's PTS since, rather than their first slice's, while MPEG-1, MPEG-2, and VC-1 keep the PTS of the PES packet their picture starts in.
  Branches meant for upstream's `v2` are cut from it with a `v2-` prefix: `v2-fix-matroska-laced-header-stripping`, `v2-fix-custom-decoder-close-after-failure`, `v2-url-source-read-ahead`, and `v2-matroska-block-additions` (10-16), and `v2-matroska-field-order`, `v2-isobmff-mj2-signature`, `v2-isobmff-dolby-vision-sample-entries`, `v2-av1-codec-configuration-record`, `v2-av1-codec-string`, and `v2-drop-avc-leading-pictures` (10-27).
  Fixes to fork-only code, such as the AVI demuxer or the fork's VC-1 codec, are cut from the fork's `v2` with the same prefix: `v2-avi-presentation-times`, `v2-avi-hevc-zero-tag`, `v2-avi-opendml-index`, `v2-avi-unpack-packed-bframes`, `v2-avi-wave-format-extensible`, `v2-avi-flac-vorbis`, `v2-avi-keep-unmapped-video-tracks`, and `v2-isobmff-vc1-dvc1` (10-27), and `v2-mpeg-ts-unregistered-vc1`, `v2-avi-keep-unmapped-audio-tracks`, and `v2-asf-demuxer` (10-28).
  `v2-drop-avc-leading-pictures`, cut from upstream's `v2`, drops the leading pictures of an open H.264 group when decoding starts at its key packet, as v2 drops RASL pictures for HEVC; Chromium's decoder drops them too, and the sample path, which hands decoded frames its input timestamps in order, otherwise gave every later frame one leading picture's timestamp too early after a seek into such a group (10-27).
  `fix-lookup-retry-fallback`, cut from upstream's `main` at 1.62.1 and merged into the fork's `v2`, keeps a Matroska lookup's retry near the block it seeks (10-28).
  1.62.1's lookups step back through the cluster position cache with doubling steps, and that cache only holds the clusters read so far, so a step past its first entry scanned the segment from its first cluster, and a step past the block's cluster landed in a group read long before.
  A seek back into a group that playback or an earlier seek had read then read the file up to that group, up to 395 MB of a 743 MB Matroska file in one seek, and stalled for seconds over the network.
  A retry now starts from the later of the stepped entry and the cue point that entry won over, and a step past the first entry stops at it.
  v2 replaces the media sinks with packet readers and cursors, so `TrackIteration.ts` gives the worker what the sinks' `packets()` and `samples()` gave: packets read about a second ahead, and decoded samples from a start time, each ending at once on `return()`.
  `VC1PresentationOrder.ts` follows v2's track backing, which writes each packet into a result value, and presents a restamped packet through Mediabunny's internal clone, which keeps where the demuxer finds the packet again.
- The engine is an npm workspace of its host (10-02).
  npm installs the engine's dependencies, so the host lists only what it uses directly.
  Inside the host the engine has no `node_modules` of its own, and its tooling finds packages by walking up from the engine root.
- The Jellyfin player stays in the host (10-02).
  Moving it would make the engine Jellyfin-aware; the plugin's book records the decision.
- Engine workers are prebuilt (10-02).
  esbuild bundles them as classic workers, which the decoder glue's `importScripts` required until the CPU decoders left (10-13).
  They are served at stable URLs under `libraries/webgpu-player/` with a per-build `?v=` key, not as host bundler chunks.
- Typed asset names replace hash pins (10-02).
  `src/EngineAssets.ts` is the typed manifest of runtime assets.
  The SHA-256 pins, verify scripts, vector registry, and per-file byte pins were removed; committed bytes and output oracle tests remain.
- Decoders build with make (10-02).
  `wasm/Makefile` (GNU Make) replaced the Python builders, and since 10-13 each decoder project's `Makefile` builds its module with the rules in `wgpud/rules.mk`.
  FFmpeg and dcadec are pinned, shallow, `update = none` submodules, which `make -C wgpud sources` fetches.
  There is no Docker and no Python of our own in the build.
  `make -C wasm check` and `npm run decoders -- --check` verify byte-reproducible outputs, and whoever distributes the LGPL packages offers their corresponding source from `make -C wgpud source-archives`.
- Decoder builds are not committed (10-05).
  `bin/` holds generated output, and only `bin/codec_vector_assets/` is committed, so `bin/wasm/`, `bin/wgpud/`, and `bin/wgpup/` are ignored.
  Each checkout builds the engine's modules with `make -C wasm all` before the asset build, and the decoder projects with `npm run decoders` before their tests.
  The decoder glue's hand-written declarations lived in `wasm/<kit>/`, where the `types` condition of the `#wasm/*` import resolved TypeScript to them, until the CPU decoders left (10-13) and took the import with them.
- Audio decoder binaries were served files (10-08), until the audio decoders became packages (10-13), which the engine does not serve.
  The DTS, TrueHD, and E-AC-3 kits linked without `SINGLE_FILE`: esbuild bundled their ES module glue into the workers, and each `.wasm` was served from `libraries/<kit>/`.
  Embedded, the binaries were base64 in every worker that imported them: 1.4 MB of the playback worker for every session, and DTS and TrueHD downloaded a second time inside their probe workers.
  A served binary was one cache entry for the probe and playback workers, compiled while it streamed, and loaded only when a decoder of its kit was created.
  The glue always got `locateFile`, or `wasmBinary` with bytes the page already fetched, through `src/DecoderWASMSource.ts`, which left with it.
- Codec vectors are generated into a committed `bin/` folder (10-05).
  `bin/codec_vector_assets/` is the one committed folder in `bin/`, so every change to a qualification stream, generated module, or reference shows in review.
  The generators are all Python, in `scripts/codec_vector_assets/`.
  `.gitattributes` stores the folder without line-ending conversion.
  Hand-made vectors live in `src/capability/vectors/`, and local playback media goes to the ignored `bin/playback_smoke_media/`.
- Known-answer media is a "vector", never a "fixture" (10-05): qualification vectors ship to the browser, test vectors feed only tests.
- Folder names live in `tools/constants.json` (10-05).
  Scripts, tests, the Makefile, and the host read paths from it instead of restating them.
- The sources are laid out by stage (10-14).
  `src/demux/` holds what reads the container and shapes packets: the media source and its fetch policy, the input formats, track selection, codec configuration records, packet restamping, and the bitstream metadata packets carry, with a folder per codec.
  `src/decode/` holds what turns packets into frames and PCM: the owned WebCodecs paths, the GPU decoder package route with its coordinator and parse workers, the audio decoders, and the package loader that video and audio share.
  A module goes where its work belongs, not where its name points: the HDR10+ frame queues pair packet metadata with decoded frames, so they are decoding, and the Dolby Vision EL geometry and the frame-pool signal, which only presentation reads, are presentation.
  `src/video/`, `src/decoders/`, and `src/audio/decoders/` left without re-export stubs, and `test/` mirrors the new folders.
- x265 gets no level-idc for the range-extension vectors (10-06).
  With CRF, x265 enforces a requested level through VBV, which it reports as non-deterministic.
  The generator encodes without a level and writes `general_level_idc` 93 (Level 3.1) into the VPS and SPS itself.
  The slices were byte-identical either way.
- Decoder kits were named for their library and codecs (10-06): `ffmpeg-eac3`, `ffmpeg-truehd`, `ffmpeg-mpeg2-vc1`, `ffmpeg-hevc`, `libdcadec-dts`, and `libdovi`.
  Their classes followed the codecs too, as in `MPEG2VC1SoftwareVideoDecoder`, and a name that covered one codec only said so, as in `bundledMPEG2` beside `bundledVC1`.
  Since 10-13 a decoder project is named for its codec, whatever library it builds (`eac3`, `truehd`, `dts`, `hevc`, `vc1`), and `libdovi` is the one kit left.
- The decoder projects live in `wgpud/` and the pass projects in `wgpup/` (10-15).
  The names mark both as module types of this player: a decoder package or a pass file is something a host loads into the engine, not engine code.
  `decoders/` became `wgpud/`, and its packages build into `bin/wgpud/`.
  `wgpup/` holds the optional passes a host may offer: the sharpen, saturation, and temporal blend examples and the Catmull-Rom scaler, which were modules of `src/presentation/passes/` that no route used, and the Anime4K upscalers.
  The engine never loads a pass itself; `npm run build` copies the pass files into `bin/wgpup/`, where a host serves them, and the sandbox lists them.
  The Anime4K passes are generated from the upstream mpv GLSL by the project's own generators and committed, so a build needs no Python.
- Our sources in `wasm/`, `wgpud/`, and `wgpup/` carry no license headers (10-06).
  The repository's `LICENSE` covers them.
- Both repositories lint the engine (10-02).
  The engine has its own ESLint config adapted from Jellyfin Web's, and the host's lint also covers the engine's `src/` and `test/`, so the engine stays clean under both.
- The documentation is this book (10-06): one mdBook in `docs/`, with no READMEs nested in other folders and no separate agent map.
  It covers only the engine (10-09); the Jellyfin plugin documents its integration in its own book.
- Diagrams are PlantUML, rendered to committed SVGs in two variants (10-09).
  They replace the text diagrams and the PlantUML activity diagrams of the Jellyfin Web fork, whose paths, line numbers, and timeouts no longer matched the code.
  One theme, adapted from the fork's Boreal theme, renders a light variant for the rust book theme and a dark one for coal, and the book shows the variant matching the reader's theme.
  The SVGs are committed so a book builds without Java; the PlantUML jar is not, and the renderer downloads it into `bin/plantuml/` against a pinned SHA-256.
