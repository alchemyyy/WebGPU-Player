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
- No artificial size limits (10-08).
  Nothing refuses media for its frame size, sample rate, or packet size alone.
  The bundled HEVC, JPEG 2000, and MPEG-2/VC-1 size caps, the raw-copy byte budget, the packet and container read caps, the 3 kHz to 192 kHz audio window, and the per-packet audio frame counts were removed.
  Above 192 kHz the resampler widens its kernel in proportion, so its band edge stays where the 192 kHz qualification put it.
  The real bounds remain: the level's DPB, a representable copy layout, the WASM heap (4 GiB for HEVC and MPEG-2/VC-1, 2 GiB in the prebuilt OpenJPEG decoder), the adapter's texture limit, and what a browser decoder accepts.
  Limits that pace or chunk work stay as tuning: transfer credits, queue depths, pending windows, and output chunk sizes.
  So do guards against corrupt data that no real stream reaches, such as header and RPU size bounds and the 2 MiB audio packet bound.
- Live performance adaptation is deferred to a separate runtime controller that would react to sustained drops, queue starvation, underruns, and A/V drift, with warm-up, hysteresis, and cooldown.
- One composition matrix (08-05, `9a1c3f2922`).
  `capability/CustomContainerCodecSupport.ts` decides only whether a container carries a codec.
  Each track is qualified on its own.
  Never add decoder pair blacklists.
- `hasEligibleCustomVideoRoute` answers for one item (10-06).
  Jellyfin labels some Dolby Vision streams in ranges a host's generic routes do not pair with their profile and depth, so the engine tells a host whether this item has a runtime route, and the host advertises exactly that item's route.
- Video probes run per item; audio probes always run (10-08).
  Probing every codec on the first negotiation of a page blocked PlaybackInfo for about 2.6 s, mostly on decoders the item did not contain.
  A video stream cannot change within a negotiation, since another version or item renegotiates, so the video probes follow the item's streams and run on demand.
  An audio track can change during playback, so every audio probe runs for every item.
  A probe outside the selection reads `not-probed`, never a verdict, so an unprobed codec is not advertised.
- Probe downloads run in parallel and outside the decode timeouts (10-08).
  The exact probes armed their timeouts before downloading their vectors and binaries, and the range-extension probes downloaded inside the queue's 2 s timed slot, so a slow cold link failed a capable decoder as unsupported or timed out every later probe.
  A run now starts every selected probe's downloads at once and each probe decodes only once its own are done; decoding stays one probe at a time.
  Worker scripts and glue are warmed in the HTTP cache rather than spawned early, so no worker or compile competes with a running probe's real-time-factor measurement.

## Video decode and Dolby Vision

These were settled on stock Chrome on Windows, with a Chromium 153 source audit.

- Hardware decode output is opaque.
  WebCodecs HEVC Main 10 hardware frames are P010 surfaces with `VideoFrame.format === null`, so `copyTo()` and `allocationSize()` cannot expose planes.
  Exact planes come only from the bundled software HEVC decoder (WASM, CPU).
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
  Routes are tried in this order: native P5, the native compatible base (P7, P8), RPU reconstruction, then the declared base through the ordinary routes.
  A stream fails closed only when none applies.
  Reconstruction comes before the declared base, apart from the native-base-first case, because a base without its RPU is not the graded picture.
  P20 reconstructs its MV-HEVC base view, and P10 its AV1 picture, as P5 (CCID 0 or none) or as P8.
  P9 (AVC) has no RPU route, because the engine owns no AVC decode path, and plays its declared base.
- Profile 10 decodes through the engine's own AV1 path (10-08).
  Mediabunny's `VideoSampleSink` hides the packet bytes that carry the RPU, so a P10 route reads packets with `EncodedPacketSink` and feeds its own WebCodecs decoder.
  Each temporal unit's Dolby Vision ITU-T T.35 metadata OBUs are removed before decode, so no browser decoder sees them.
  The libdovi T.35 entry point parses them in decode order.
  A temporal unit has exactly one shown frame, so its timestamp keys its RPU, as a PTS keys an HEVC RPU.
  The route profile comes from the container descriptor; the profile the crate infers from the RPU header (5 for 10.0, 8 otherwise) only validates the snapshot.
  AV1 has no native external Dolby Vision or HDR route, because nothing neutralizes an AV1 sequence header's color, so P10 reconstructs from raw I420P10 only.
- Every AV1 track decodes through the engine's own AV1 path (10-09).
  HDR10+ and the MDCV and CLL travel in metadata OBUs, which `VideoSampleSink` hides as it hides the RPU, and Jellyfin's HDR10Plus label is not a reliable sign of them, so the route does not depend on any label.
  Each temporal unit's OBUs are walked once: its Dolby Vision RPU OBUs are removed before decode on every route, and parsed only on a Dolby Vision route, the one route that loads the RPU parser.
  Its HDR10+ T.35 messages lose their OBU trailing bits as dav1d removes them, then parse as HEVC SEI payloads do, and their OBUs stay in the unit.
  Mediabunny's decoder wrapper has no AV1 workaround, and a unit's one shown frame keeps the unit's timestamp, so frames need no timestamp reassignment.
  The one sample sink feature the owned path drops is the merge of a Matroska alpha channel (BlockAddID 1) into each frame.
  AV1 has no native PQ route, so no request names a PQ transfer for it; an AV1 track without an RPU route scans its MDCV and CLL OBUs at startup when its first sequence header signals PQ.
- Every VP9 track on the native backend decodes through the engine's own VP9 path (10-09).
  VP9 has no metadata of its own, so its HDR10+ travels beside each frame in a Matroska or WebM BlockAdditional, which `VideoSampleSink` never reads, and Jellyfin's HDR10Plus label is not a reliable sign of it, so the route does not depend on any label.
  Packets decode unchanged, and each packet's BlockAdditionals parse as the ITU-T T.35 messages of HEVC SEI do.
  WebM and MP4 put one shown frame in each packet, a superframe holding any hidden frames before it, and a `show_existing_frame` header shows a frame too, so a packet's timestamp keys its frame's metadata.
  A packet of hidden frames alone, which those containers forbid, records nothing, because the decoder outputs no frame for it.
  The sample sink's alpha merge is the one VP9 feature the owned path drops: Mediabunny decodes a BlockAddID 1 alpha channel with a second decoder and merges it into each frame, while the owned path decodes the color frames only, and the presenter's canvas is opaque.
- Raw AV1 and VP9 planes prefer software (10-08).
  Chromium's hardware AV1 and VP9 decoders return opaque 10-bit surfaces whose planes `copyTo` cannot expose, while its software decoders (dav1d, libvpx) return copyable I420P10.
  Raw-plane decode of AV1 and VP9 therefore requests `prefer-software`, in the raw probes and at runtime alike, so the raw HDR, raw SDR, and P10 routes qualify on GPUs with AV1 or VP9 hardware decode.
  HEVC keeps `no-preference`, because Chromium has no software HEVC decoder.
- Dual-layer reconstruction runs in every raw format (10-08).
  P4 and P7 over a range extension or 8-bit Main reconstruct with the BL in its own raw format and the EL in I420P10, the only format the bundled EL decoder is qualified for.
  An EL that decodes in another format or at another size than its configuration leaves the stream to its BL, as a failed EL decoder does.
  A frame whose RPU names an EL depth other than 10 bits presents without its EL, because the EL texture holds 10-bit codes.
  The FEL fallback presents the BL at the format's own depth, which the per-frame check holds equal to the RPU's BL depth.
  Each format has its own base and FEL keys; only the I420P10 Profile 7 keys are prewarmed.
- The bundled EL decoder decides whether a dual-layer route decodes its EL (10-08).
  The P4 and P7 EL is always decoded by the bundled HEVC decoder.
  Without that decoder's Main 10 qualification, dual-layer reconstruction is still selected, with `discardDolbyVisionEnhancementLayer` set, so the worker creates no EL decoder: MEL reconstructs exactly from the BL, and FEL presents its base, which the declared base route would also present.
  Before 10-08 the route started the unqualified decoder and dropped the EL only when it failed.
  Gating the route on the qualification instead would cost MEL its reconstruction and leave P7 with CCID 0 no route.
- 8-bit Main Dolby Vision reconstructs through the bundled decoder (10-08).
  Native HEVC Main decodes to hardware surfaces that no probe proves copyable, so an 8-bit Main base layer reconstructs from the bundled decoder's I420 planes, with the `I420:dovi-rpu-v1` key or the I420 dual-layer keys.
- 10-bit SDR has a raw route (10-08).
  AV1 Main and VP9 Profile 2 have no 10-bit VideoFrame route, and HEVC Main 10 has none without native decode, so 10-bit 4:2:0 SDR presents from raw I420P10 through the raw SDR keys.
  Those keys are BT.709 only, so BT.601 and BT.2020 SDR at 10 bits have no raw route.
  The same route presents a declared 10-bit SDR base, such as P10.2's.
- Single-layer profiles discard a signaled EL (10-06).
  P5, P8, and P20 have no EL composition, so their EL flag is ignored and in-band EL NAL units are dropped.
  A P4 or P7 frame without a paired EL presents MEL exactly, because a MEL carries no residual, and FEL as its base layer: the HDR10 base for P7, and the SDR base exactly for P4, with no tone mapping or dither.
- The `dolby_vision` crate is vendored and patched (10-06, 10-08).
  It is copied from dovi_tool rev `38adec0` into `wasm/libdovi/vendor/dolby_vision/`, and its `PATCHES.md` lists every deviation.
  The bridge in `wasm/libdovi/src/lib.rs` adds what the crate lacks: a reuse cache for compressed display metadata, Profile 4's 2^30 YCC offset scale, and every mapping color space and chroma format.
  Every color space and chroma format works because the composer maps the decoded components as they are and the RPU's own matrices convert them, as for Profile 5's IPT.
  The AV1 EMDF container is bounded before it sizes a buffer.
  Upstream rejected syntax that FFmpeg's `dovi_rpudec.c` accepts, so the patches follow FFmpeg:
  - header limits widened to FFmpeg's (8 to 16-bit layers, coefficient precision up to 32 bits, no mapping color space or chroma check);
  - a mapping method per piece rather than per component;
  - unsupported syntax as a typed error;
  - panics returned as errors;
  - display-metadata extension blocks skipped as `parse_ext_blocks` does.
    Only a block whose coded length runs past the payload rejects the RPU.
- Mixed pieces and linear interpolation are packed per segment (10-08).
  A component may mix polynomial and MMR pieces, as FFmpeg reads them, so the snapshot (schema 2) stores the method per segment: an MMR segment has an order above 0 in its last slot.
  Polynomial linear interpolation, which FFmpeg rejects for lack of samples and ETSI GS CCM 001 V1.1.1 does not define, is read as annex A of US 10,701,399 B2 codes it.
  A piece carries the curve's rise to its start pivot from the previous pivot's value, the first piece its start value outright, and the last piece also the rise to its end pivot.
  The annex leaves a polynomial neighbor's value undefined, so the bridge takes a polynomial piece's value at its start pivot as the value a following linear piece rises from, and ends a linear piece before a polynomial continuously with it.
  Each linear piece is packed as the order-1 polynomial between its pivots' values.
  A linear piece next to an MMR piece is rejected: an MMR piece maps all three components together, so it has no scalar value to rise from or end on.
  The revision prefix names the vendored dovi_tool commit; the schema version is what a snapshot's readers check.
- Mediabunny's Dolby Vision sample entries are mapped in the engine (10-06).
  Mediabunny 1.52.2 parses `dvh1`, `dvhe`, `dva1`, `dvav`, and `dav1` but gives them no codec.
  `ISOBaseMediaDolbyVisionSampleEntry.ts` writes the wrapped codec into the track's internal info, contained the way `MatroskaVFWVideoConfiguration.ts` is, so Mediabunny itself stays unmodified.
- AV1 codec strings come from the bitstream (10-08).
  Without an `av1C` record, as in every Matroska track, Mediabunny 1.52.2 reads the first packet's sequence header, but it reads `decoder_model_info_present_flag` without timing info and the initial display delay flag once per operating point.
  Its `color_config` also skips the color description and range, and takes the Professional profile below 12 bits as 4:2:0.
  Every field after the operating points comes out wrong: a 10-bit Profile 10 Matroska vector reads as 8-bit and monochrome.
  `AV1DecoderConfiguration.ts` parses the first packet's sequence header as the specification defines it and replaces the cached decoder configuration's codec string before the first `getDecoderConfig()` or `canDecode()`, so `canDecode()` and the owned AV1 path use the stream's own string.
  It is contained the same way, and leaves a track whose first packet has no sequence header untouched.
- Mediabunny's dropped BlockAdditionals are recovered in the engine (10-09).
  Mediabunny 1.52.2 parses every BlockMore but keeps only BlockAddID 1, the alpha channel, so VP9 HDR10+ never reaches a packet's side data.
  An upstream change would wait for a release, and a patch to the installed package is lost on every install, so `MatroskaBlockAdditions.ts` contains the fix, as `ISOBaseMediaDolbyVisionSampleEntry.ts` and `AV1DecoderConfiguration.ts` contain theirs.
  The worker's `Input` wraps its Matroska and WebM formats in place, and each demuxer they create records every finished BlockMore against its block, before it reads any cluster, at the point where Mediabunny resets its `currentBlockAdditional` field.
  A packet finds its block through the track backing's packet-to-cluster map, which Mediabunny keeps for its own navigation.
  Each internal is shape-checked: when one differs, demuxing proceeds untouched and reads no additions, with one console warning, and `test/video/MatroskaBlockAdditions.test.ts` fails on the committed vectors.
  HDR10+ is recognized by its ITU-T T.35 header, not by BlockAddID, so no BlockAdditionMapping is needed: FFmpeg writes BlockAddID 4 with a mapping in Matroska and without one in WebM, and reads it either way.
  A laced block keeps no additions, because Mediabunny replaces it with one new block per frame; Matroska muxers lace audio, not video.
- Header-stripped laced Matroska blocks are split before their content is decoded (10-09).
  Older mkvmerge releases moved the leading bytes of every AC-3, DTS, and MP3 frame into the track's ContentCompression (header stripping), and laced audio by default.
  The Matroska specification scopes a block's content encoding to its frames, excluding the lacing data, and FFmpeg reads it that way.
  Mediabunny 1.52.2, and 1.61.3 too, restores the stripped bytes ahead of a laced block's lace header, so it misreads the frame count and no frame decodes.
  `CustomDecodeInputFormats.ts` gives the worker a Matroska format whose demuxer splits such a block as stored and then restores each frame's bytes, contained as `MatroskaBlockAdditions.ts` is, which wraps it in turn.
  When the internals differ, demuxing proceeds untouched with one console warning, and `test/pipeline/CustomDecodeInputFormats.test.ts` fails.
  Its last case fails once Mediabunny itself reads such blocks correctly, and the replacement can then go.
- A custom decoder's failure is reported once (10-09).
  After a Mediabunny custom decoder rejects, Mediabunny 1.52.2 queues the decoder's `close()` behind the failed call without a handler, so the same error resurfaces as an unhandled rejection and the decoder is never closed.
  The worker marks every failure it catches (`HandledDecodeFailures.ts`) and prevents the unhandled-rejection report of a marked error only, so any other unhandled rejection is still reported.
  The unclosed decoder ends with its worker: the session replaces a worker whose run failed, and a worker that suppressed such a rejection asks for its replacement in its next `stopped`.
- The bundled HEVC decoder is FFmpeg's (10-10).
  hevc.js (`@hevcjs/core`), the decoder before it, rejects the first slice of every stream that enables tiles (`tiles_enabled_flag`), and Ultra HD Blu-ray encodes commonly use tiles, as ATEME Titan's do.
  Such sources failed on Firefox on Windows, which always takes the bundled route, and fell back to a server transcode.
  hevc.js 1.4.8 fails the same way, and its roadmap says none of its test streams uses tiles.
  The `ffmpeg-hevc` kit builds FFmpeg's `hevc` decoder for `--arch=wasm` with `-O3 -flto -msimd128`, so FFmpeg's simd128 HEVC code builds and the rest auto-vectorizes (see [WebAssembly decoders](decoders.md#how-the-build-works)).
  It decodes the JCT-VC tiles conformance stream `TILES_B_Cisco_1` to the suite's MD5, and a tiled 4K HDR10 Ultra HD Blu-ray remux and the 4K qualification stream to native FFmpeg's MD5s, the remux at about 28 fps on one thread in Node.
  The exact probe qualifies it with the same three vectors and pinned fingerprints, because conformant decoders output identical samples.
  It runs on one thread (`--disable-pthreads`), because threads need cross-origin isolation, which Jellyfin Web does not have.
  Its heap may grow to 4 GiB, where hevc.js kept Emscripten's 2 GiB default.
  FFmpeg reads each packet as the container stores it, with the HVCC record as extradata, so no Annex B conversion copies it.
  Each frame returns with its packet's timestamp and duration, so no queue sorts packet timings to match frames.
  After a random-access point the decoder drops the leading RASL pictures and reports them dropped, as the native path does, so the stream discards their packets' Dolby Vision and HDR10+ metadata instead of waiting for frames that never come.
  A Dolby Vision EL decoder reports every packet accepted, because its dropped leading pictures match the BL's, and a refused EL picture would end EL decoding.
- A bundled HEVC frame is copied once (10-09).
  A drained frame's planes are views of the decoder's WASM memory, valid until its next call: bytes for Main and 16-bit words for Main 10.
  The worker used to pack them into a new buffer, `VideoSample` copied that buffer, and the raw copy or `VideoSample.toVideoFrame()` copied a third time.
  At 3840x2160 in Node 24, a 10-bit frame took about 5.9 ms and left about 50 MB of garbage, against about 0.9 ms for one row copy into a reused aligned buffer.
  The decoder now hands each frame to the owned path as it drains it, and the worker writes the planes into the buffer it posts, whatever the decoder's row stride.
  Drained frames wait in the owned stream's queues beyond the 2 raw credits, so their buffers come from a run's pool of spares, which allocates when none fits.
  The pool keeps 2 spares of each byte length, as many as the page can hold, so a steady stream reuses every buffer.
  Mediabunny's adapter still outputs packed `VideoSample`s, as its `registerDecoder` contract requires.
  A Dolby Vision BL and EL are still copied once more, into their compound buffer.
- Decoder instances are made once per worker (10-09).
  The bundled HEVC, FFmpeg MPEG-2/VC-1, and OpenJPEG modules were instantiated for each decoder, and the libdovi parser for each run, which a worker that outlives its runs would repeat at every seek.
  Each kit now has one instance per worker, in which every decoder or parser creates its own native context and releases only that context when it closes, so a Dolby Vision run's BL and EL decoders share one `ffmpeg-hevc` heap.
  An instance whose code traps is discarded, so the next decoder instantiates it again rather than trust its memory; an error its code returns keeps it.
- Decoder surfaces must not starve (08-08, `ecb5a4ec09`).
  Native frame credits return after `queue.onSubmittedWorkDone()`, not after `submit()`, because Chromium holds the decoder mailbox until the GPU completes and the D3D surface pool is finite.
- Rejected alternatives.
  `ffmpeg.wasm` has no GPU decode.
  `libmpv-wasm` is CPU FFmpeg plus WebGL.
  mpv's D3D11VA P010 path is the reference design but cannot be reached from a page.
  Threaded WASM needs COOP and COEP isolation, which was not pursued.
  An FFmpeg HEVC WASM benchmark (the gate: at least 28.8 fps sustained, exact YUV420P10 hashes) was dropped when the native base route landed; FFmpeg's decoder became the bundled one later, for tiled streams rather than speed.
- If exact 10-bit is ever required, the Chromium patch options are:
  - a P010 to RGBA16F GPU copy, the narrowest patch, which fixes the N32 TODO;
  - a zero-copy P010 external texture;
  - raw R16 and RG16 plane import, the only route to bit-exact P010 and exact P7 FEL.
- Native HDR neutralization.
  The native external HDR route rewrites the SPS color to limited BT.709 so Chrome does not tone-map, and the shader recovers the YUV codes.
  An `hvcC` without an SPS defers validation to the first key access unit (08-05).
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
  The raw SDR keys are BT.709 only, so BT.601 and BT.2020 SDR never reach the raw shaders.
- The SPS VUI never rejects color (10-07).
  An HLG broadcast whose VUI signals the BT.2020 10-bit transfer (14) and whose alternative transfer characteristics SEI (payload type 147) names HLG (18) failed the native HLG route, because the SPS parser accepted only BT.709 and BT.2020 PQ or HLG.
  The parser maps every code to a WebCodecs name or to null, and only the native HDR route check is strict (limited range, BT.2020 primaries and non-constant-luminance matrix).
  Its transfer is the SEI value when the key access unit carries one and the VUI value otherwise; an HLG route also accepts VUI 14 or 15 without an SEI.
  SEI errors are not fatal, as in FFmpeg, so a malformed SEI counts as absent and the VUI alone must prove the route.
  The bundled HEVC decoder compares the container and SPS color only where both specify it (BT.470 BG equals SMPTE 170M as a matrix, and SMPTE 170M equals BT.709 as a transfer) and fills SPS gaps from the container, so a container's HLG survives a VUI 14 SPS.
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

## Firefox

These were settled on Firefox 157 on Windows.

- WebCodecs has no HEVC on Windows (10-07).
  `IsSupportedVideoCodec` in Firefox's `dom/media/webcodecs/WebCodecsUtils.cpp` accepts HEVC only on macOS and Linux, and only with both `dom.media.webcodecs.h265.enabled` (on by default only in Nightly) and `media.hevc.enabled`.
  That second pref, on by default, lets `<video>` and MSE play HEVC through the Windows HEVC extension.
  HEVC therefore decodes in the bundled decoder, and the native HEVC, external HDR, and native Dolby Vision routes never qualify on Windows.
  The hardware decoder behind `<video>` cannot feed the custom pipeline, whose frames must reach WebGPU unconverted, while a `<video>` external texture arrives as SDR sRGB.
  The bundled decoder runs on one core, about 20 fps at 4K on a fast CPU, so 4K plays below real time.
  This is left as is until Firefox enables WebCodecs HEVC on Windows.
- A `VideoFrame` cannot be constructed in a high-bit-depth format (10-07): the constructor rejects `I420P10`.
  The bundled HEVC decoder's frames therefore never pass through a `VideoFrame` on the raw route: as the decoder drains a frame, the worker writes its planes from WASM memory into the aligned raw buffer it then transfers (10-09).
  On the VideoFrame route, which 8-bit SDR takes in Firefox, the worker writes each drained frame into compact I420 planes and constructs the `VideoFrame` itself with `transfer`, with the metadata `VideoSample.toVideoFrame()` gave it; a browser that ignores `transfer` copies the planes, and the worker writes the next frame into the same buffer.
  The external P5 authorization builds an `I420P10` frame and fails, but it needs WebCodecs HEVC regardless.
- Copy options name a `format` only to convert (10-10).
  The spec accepts only RGB formats there, and Firefox enforces it, rejecting even a frame's own `I420P10` in `allocationSize` and `copyTo`.
  The raw copy and its capability probe therefore leave `format` out when the frame already has the requested format.
- 10-bit AV1 decodes to 8-bit `BGRX`, and the 4K VP9 Profile 2 vector fails to decode (10-07), so raw HDR AV1 and VP9 do not qualify.
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
  Only `native` decode is suspended; software backends keep draining, because a keyframe resync costs up to a GOP of CPU decode.
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
- One decode worker per session (10-09).
  Every generation, which every seek, audio track switch, and paused repaint starts, used to create its own worker and paid worker startup, script evaluation, and WASM decoder instantiation each time.
  The session now creates its worker at the first start, runs every generation in it, and terminates it only on `destroy`.
  Runs never overlap: the session sends a `start` only after the previous run acknowledged `stopped`, and the worker starts a run only after the previous one posted it.
  An overlap would stall the handoff, because a stopping run waits for every bundled HEVC decoder in its worker, the next run's included, before it acknowledges.
  A worker is replaced rather than reused after a generation fails, a message fails validation, the worker crashes, or a retired run does not acknowledge within the 1 s stop bound.
  It is also replaced when a run's `stopped` carries `replaceWorker`, which the worker sets once it suppressed the rejection of a custom decoder that Mediabunny left open.
  A start on another video decoder backend gets a new worker too, because Mediabunny keeps a decoder registration, such as the bundled HEVC adapter that `canDecode()` consults, for the worker's life.
  Each run still opens its own input, so the read cache does not outlive a seek.
  After a run ends on its own, its generation stays current while the worker idles, so a native-media element that plays out after decode still ends the session.
  Before, the run's `stopped` retired the worker and with it the generation, and such a session did not end.
- Presentation stays on the page; presentation in the worker was removed (10-09).
  Its first stage (`be2cd76`) kept each decoded frame in the decode worker, which drew it with a GPU device of its own into a canvas transferred with `transferControlToOffscreen`, so no `VideoFrame` or 25 MB 4K 10-bit raw buffer crossed to the page.
  In field use it felt less responsive than the page presenter, and on an Intel Arc laptop (Meteor Lake iGPU beside an RTX 4060) 4K HDR10+ playback dropped frames after a few minutes, which the engine before it (`a3bba75`) did not.
  The cause was not isolated.
  The suspects: every draw waited on the decode worker's event loop, which also demuxes, decodes, and copies; each session took a second device on the same adapter and authorized its route again there; and a frame's credit returned only after the renderer's GPU work and the page's release.
  The persistent worker, the bundled HEVC single copy, and the audio decode worker, which landed with it, stay.
  Presentation off the main thread should return only with a measured cause, and on a thread of its own rather than the decode worker's.

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
  Every fold-down, a source with more channels than the output, runs the limiter.
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
  AC-3 2/1 and 3/0 are therefore indistinguishable, and the browser's AC-3 decoder reports no mask, so three-channel AC-3 is neither advertised nor admitted and transcodes.
  AC-3 mono plays.
  A profile condition cannot express ChannelLayout, so any other three-channel layout, a 2.1 FLAC or WAV for example, is negotiated, fails eligibility when playback starts, and plays through the HTML player or renegotiates to a transcode.
  E-AC-3 and TrueHD admit mono only.
- E-AC-3 7.1 needs the layout, not only the channel count: the decoder must report the decoded channel layout (`9ca70e11ad`).
- The DTS envelope.
  DTS-HD HRA is valid at 48 and 96 kHz only.
  Above 96 kHz only 5.1 MA (or MA with a DTS:X bed) is admitted.
  Stereo DTS-HD MA is admitted up to 96 kHz.
  Mono is admitted for every direct-play profile, and three channels for MA and MA with DTS:X when Jellyfin reports a 2.1 or 3.0 layout, because libdcadec reports their speaker masks (0x4, 0xB, 0x7, and 0x103 for 3.0(back), which Jellyfin also reports as 3.0).
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
- The FFmpeg wrappers stamp later frames of one packet themselves (10-07).
  FFmpeg resets the packet timestamp after a partial consume, so the E-AC-3 and TrueHD wrappers stamp a frame without one at the packet time plus the frames the packet already produced.
- A late first audio sample is padded, not followed (10-07).
  In two MKV files the video started at 0 s and the first audio block at 6.006 s or about 25.9 s.
  Setting the worklet's media time to the first chunk it rendered made the clock jump to the audio start and drop the earlier video (631 frames for 26.3 s at 23.976 fps).
  The worklet renders silence from the flush position to the first chunk's timestamp.
  The native-media route parks `<audio>` at its first fragment and delays `play()` by the remaining gap, because Chromium snaps a seek only to buffered data that starts within 1 s, and otherwise `play()` stays pending until startup times out.
  Hidden tabs fire that timer late, so a timer more than 20 ms late first moves the parked element and its clock baseline forward by the overshoot, within the buffered range, and audio does not trail the clock.
  Only an `AbortError` caused by the backend's own pause, seek, or teardown stays silent; any other `play()` rejection is reported.
  Mediabunny proves that a track starts after a lookup time only after two scans, so an audio start at or before zero, or after no earlier packet, takes the first packet directly.
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
  `dtse` (LBR) and `dtsx` (DTS-UHD) are unsupported because libdcadec cannot decode them.
  Two sample-rate fields need recovery.
  TrueHD writes the rate as a 32-bit integer, which reads back as 16.16.
  A DTS rate above 65535 Hz does not fit the 16-bit integer part, so muxers write zero, and the worker declares the 48 kHz core until the decoder reports the real rate.
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
- An audio decode worker decodes and renders decoded PCM (10-09).
  The worker spawns `CustomAudioDecode.worker.js` at its first decoded PCM start and keeps it for its life; terminating the worker terminates it too.
  It runs the bundled E-AC-3, DTS, and TrueHD decoders, the downmix, the output stage, and the producer, so a long software video decode never delays audio, and audio decoding never delays video.
  Demux stays in the worker, which reads the source once for both tracks.
  The worker sends compressed packets copied back to back, or Mediabunny's decoded samples cut to the start, in batches that close at 40 ms of media time or 64 inputs, so TrueHD's 1200 access units a second do not each cost a message.
  4 batches are in flight, and each returns its credit once rendered under the producer's window, so demux runs at most a few batches ahead.
  Progress, the decoded format, an attempt's end, and failures return through the worker, which keeps their order with `audio-ended` and `stopped` on its one channel to the page.
  A run's `stopped` waits until the audio decode worker released the run's attempts.
  Failures keep their kinds, and a lost audio decode worker fails the run as `audio-output-failed`, which falls back to HTML in the same session, and asks for a fresh worker.
  Mediabunny's own decoding stays in the worker: WebCodecs decodes off the worker's thread anyway, and `@mediabunny/ac3` exposes only its Mediabunny registration.

## Repository

- The engine is its own repository (10-02): [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player), MIT, with each vendored decoder under its own license.
  Hosts check it out as a git submodule and import it as `webgpu-player/*`.
  Its only host is the Jellyfin plugin's add-on.
- The engine is an npm workspace of its host (10-02).
  npm installs the engine's dependencies, so the host lists only what it uses directly.
  Inside the host the engine has no `node_modules` of its own, and its tooling finds packages by walking up from the engine root.
- The Jellyfin player stays in the host (10-02).
  Moving it would make the engine Jellyfin-aware; the plugin's book records the decision.
- Engine workers are prebuilt (10-02).
  esbuild bundles them as classic workers, because the decoder glue loads through `importScripts`.
  They are served at stable URLs under `libraries/webgpu-player/` with a per-build `?v=` key, not as host bundler chunks.
- Typed asset names replace hash pins (10-02).
  `src/EngineAssets.ts` is the typed manifest of runtime assets.
  The SHA-256 pins, verify scripts, vector registry, and per-file byte pins were removed; committed bytes and output oracle tests remain.
- Decoders build with make (10-02).
  `wasm/Makefile` (GNU Make) replaced the Python builders.
  FFmpeg and dcadec are pinned, shallow, `update = none` submodules.
  There is no Docker and no Python of our own in the build.
  `make check` verifies byte-reproducible outputs, and each release attaches the LGPL corresponding source from `make source-archives`.
- Decoder builds are not committed (10-05).
  `bin/` holds generated output, and only `bin/codec_vector_assets/` is committed, so `bin/wasm/` is ignored.
  Each checkout builds the decoders with `make -C wasm sources all` before the tests and the asset build.
  Their hand-written declarations live in `wasm/<kit>/`, and the `types` condition of the `#wasm/*` import resolves TypeScript to them, so type checks and lint need no build.
- Audio decoder binaries are served files (10-08).
  The DTS, TrueHD, and E-AC-3 kits link without `SINGLE_FILE`: esbuild bundles their ES module glue into the workers, and each `.wasm` is served from `libraries/<kit>/`.
  Embedded, the binaries were base64 in every worker that imported them: 1.4 MB of the playback worker for every session, and DTS and TrueHD downloaded a second time inside their probe workers.
  A served binary is one cache entry for the probe and playback workers, compiles while it streams, and loads only when a decoder of its kit is created.
  The glue always gets `locateFile`, or `wasmBinary` with bytes the page already fetched, through `src/DecoderWASMSource.ts`.
- Codec vectors are generated into a committed `bin/` folder (10-05).
  `bin/codec_vector_assets/` is the one committed folder in `bin/`, so every change to a qualification stream, generated module, or reference shows in review.
  The generators are all Python, in `scripts/codec_vector_assets/`.
  `.gitattributes` stores the folder without line-ending conversion.
  Hand-made vectors live in `src/capability/vectors/`, and local playback media goes to the ignored `bin/playback_smoke_media/`.
- Known-answer media is a "vector", never a "fixture" (10-05): qualification vectors ship to the browser, test vectors feed only tests.
- Folder names live in `tools/constants.json` (10-05).
  Scripts, tests, the Makefile, and the host read paths from it instead of restating them.
- x265 gets no level-idc for the range-extension vectors (10-06).
  With CRF, x265 enforces a requested level through VBV, which it reports as non-deterministic.
  The generator encodes without a level and writes `general_level_idc` 93 (Level 3.1) into the VPS and SPS itself.
  The slices were byte-identical either way.
- Decoder kits are named for their library and codecs (10-06): `ffmpeg-eac3`, `ffmpeg-truehd`, `ffmpeg-mpeg2-vc1`, `ffmpeg-hevc`, `libdcadec-dts`, and `libdovi`.
  Their classes follow the codecs too, as in `MPEG2VC1SoftwareVideoDecoder`, and a name that covers one codec only says so, as in `bundledMPEG2` beside `bundledVC1`.
- Our sources in `wasm/` carry no license headers (10-06).
  The repository's `LICENSE` covers them.
- Both repositories lint the engine (10-02).
  The engine has its own ESLint config adapted from Jellyfin Web's, and the host's lint also covers the engine's `src/` and `test/`, so the engine stays clean under both.
- The documentation is this book (10-06): one mdBook in `docs/`, with no READMEs nested in other folders and no separate agent map.
  It covers only the engine (10-09); the Jellyfin plugin documents its integration in its own book.
- Diagrams are PlantUML, rendered to committed SVGs in two variants (10-09).
  They replace the text diagrams and the PlantUML activity diagrams of the Jellyfin Web fork, whose paths, line numbers, and timeouts no longer matched the code.
  One theme, adapted from the fork's Boreal theme, renders a light variant for the rust book theme and a dark one for coal, and the book shows the variant matching the reader's theme.
  The SVGs are committed so a book builds without Java; the PlantUML jar is not, and the renderer downloads it into `bin/plantuml/` against a pinned SHA-256.
