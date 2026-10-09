# Decisions

This chapter records settled decisions about the engine and its Jellyfin host.
Dates are month-day in 2026, UTC.
Commit hashes refer to the Jellyfin Web fork's `webgpu-player` branch, where the engine was developed until it became its own repository on 10-02.

## Negotiation

- No static performance gates (08-06).
  Width, Height, VideoLevel, VideoFramerate, startup throughput benchmarks, and FPS or headroom tiers were removed from every custom route (`db8dbc7622`).
  A capability means the path implements the codec, profile, and output contract, and vector geometry is output evidence only.
  The real limits stay: codec and profile, bit depth, interlacing, container, exact decoder acceptance, transfer byte bounds, and GPU texture limits.
- Bitrate is telemetry only.
  The first PlaybackInfo request omits bitrate.
  Only a bounded second request may carry it, to size a transcode that was already decided.
- Live performance adaptation is deferred to a separate runtime controller that would react to sustained drops, queue starvation, underruns, and A/V drift, with warm-up, hysteresis, and cooldown.
  It must never change the device profile during a session.
- One composition matrix (08-05, `9a1c3f2922`).
  `capability/CustomContainerCodecSupport.ts` decides only whether a container carries a codec.
  Each track is qualified on its own.
  Never add decoder pair blacklists.
- Retries use the stock HTML profile, with no custom widening.
  A custom failure that asks for renegotiation can therefore get `AudioCodecNotSupported` (for example E-AC-3) on the retry.
  Fix the trigger, not the retry profile.
- Dolby Vision is never stream-copied into HLS (08-05).
  Without a veto, the augmented profile lets Jellyfin copy Dolby Vision HEVC into HLS, which Chromium MSE rejects.
  `WebGPUPlayer.supportsVideoStreamCopy()` (host) returns false for Dolby Vision sources, and the host sends `AllowVideoStreamCopy=false`.
- The Jellyfin integration is a server plugin with a client add-on (10-04; the fork was abandoned 10-05).
  Stock Jellyfin Web stays unmodified.
  The add-on loads through Jellyfin Web's window plugin path, and stand-ins replace the PlaybackManager seams the fork had added (see [The Jellyfin host](jellyfin-host.md#host-compatible-mode)).
- A Dolby Vision item advertises its own exact route (10-06, host).
  Jellyfin labels P4 and P20 by transfer, and labels Dolby Vision over Rext, Main 12, or 8-bit Main in ranges the generic routes do not pair with that profile and depth.
  Widening the generic ranges would advertise those pairs for every item, so the profile asks the engine whether this item has a runtime route and adds exactly its VideoProfile, VideoBitDepth, and VideoRangeType.
- A declared HDR base also waits for the static HDR probes (10-06, host).
  A Dolby Vision item whose declared PQ or HLG base is not an exact native P7 or P8 base probes Dolby Vision in parallel with the static HDR routes (external first, raw only when no external key is authorized), so its base fallback can be advertised.
  Any other Dolby Vision item waits only for Dolby Vision.

## Video decode and Dolby Vision

These were settled on stock Chrome on Windows, with a Chromium 153 source audit.

- Hardware decode output is opaque.
  WebCodecs HEVC Main 10 hardware frames are P010 surfaces with `VideoFrame.format === null`, so `copyTo()` and `allocationSize()` cannot expose planes.
  Exact planes come only from the bundled software HEVC decoder (WASM, CPU).
- The software raw path is too slow for 4K.
  The bundled HEVC decoder ran at about 15.3 fps on a 23.976 fps 4K source, and plane extraction plus upload cost about 2.4 ms per frame: low frame rate, then a freeze.
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
- Every Dolby Vision profile except P10 gets a route (10-06).
  P4, P20, P7 without its EL, and P8 with an EL flag all play, as do Dolby Vision over Rext, Main 12, or 8-bit Main, MPEG-TS descriptor version 2, and compressed display metadata.
  Routes are tried in this order: native P5, the native compatible base (P7, P8), RPU reconstruction, then the declared base through the ordinary routes.
  A stream fails closed only when none applies.
  Reconstruction comes before the declared base, apart from the native-base-first case, because a base without its RPU is not the graded picture.
  P20 reconstructs its MV-HEVC base view as P5 (CCID 0 or none) or as P8.
  P9 (AVC) and P10 (AV1) have no RPU route; P9 plays its declared base, and P10 is deferred.
- Single-layer profiles discard a signaled EL (10-06).
  P5, P8, and P20 have no EL composition, so their EL flag is ignored and in-band EL NAL units are dropped.
  A P4 or P7 frame without a paired EL presents MEL exactly, because a MEL carries no residual, and FEL as its base layer: the HDR10 base for P7, and the SDR base exactly for P4, with no tone mapping or dither.
- The `dolby_vision` crate is vendored and patched (10-06).
  It is copied from dovi_tool rev `38adec0` into `wasm/libdovi/vendor/dolby_vision/`, and its `PATCHES.md` lists every deviation.
  The bridge in `wasm/libdovi/src/lib.rs` adds what the crate lacks: a reuse cache for compressed display metadata, Profile 4's 2^30 YCC offset scale, and mapping chroma formats up to 4:4:4.
  Upstream rejected syntax that FFmpeg's `dovi_rpudec.c` accepts, so the patches follow FFmpeg:
  - header limits widened to FFmpeg's (8 to 16-bit layers, coefficient precision up to 32 bits, no mapping color space or chroma check);
  - unsupported syntax as a typed error;
  - panics returned as errors;
  - display-metadata extension blocks skipped as `parse_ext_blocks` does.
    Only a block whose coded length runs past the payload rejects the RPU.
- Mediabunny's Dolby Vision sample entries are mapped in the engine (10-06).
  Mediabunny 1.52.2 parses `dvh1`, `dvhe`, `dva1`, `dvav`, and `dav1` but gives them no codec.
  `ISOBaseMediaDolbyVisionSampleEntry.ts` writes the wrapped codec into the track's internal info, contained the way `MatroskaVFWVideoConfiguration.ts` is, so Mediabunny itself stays unmodified.
- Decoder surfaces must not starve (08-08, `ecb5a4ec09`).
  Native frame credits return after `queue.onSubmittedWorkDone()`, not after `submit()`, because Chromium holds the decoder mailbox until the GPU completes and the D3D surface pool is finite.
- Rejected alternatives.
  `ffmpeg.wasm` has no GPU decode.
  `libmpv-wasm` is CPU FFmpeg plus WebGL.
  mpv's D3D11VA P010 path is the reference design but cannot be reached from a page.
  Threaded WASM needs COOP and COEP isolation, which was not pursued.
  An FFmpeg HEVC WASM benchmark (the gate: at least 28.8 fps sustained, exact YUV420P10 hashes) was dropped when the native base route landed.
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
  The worker copies the bundled decoders' sample planes straight into the raw buffer instead of through `VideoSample.toVideoFrame()`, which also saves a copy in Chromium.
  The external P5 authorization builds an `I420P10` frame and fails, but it needs WebCodecs HEVC regardless.
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
- No asynchronous work before an ordinary HTML start (08-05, host).
  With custom decode off, `HtmlVideoPlayer.play()` starts synchronously.
  Normalization gain moves only on a fallback from the custom path to HTML.
  Seek completions are revision-guarded, and retired native audio is muted before its asynchronous cleanup.
- Parallel probe sessions cause false failures.
  Three concurrent sessions produced spurious `DirectPlayError`s.
  Diagnose one session at a time.

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
  The worker logs every correction over 100 ms and every failure with the input timestamp, the expected timestamp, and the correction.
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

## Repository

- The engine is its own repository (10-02): [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player), MIT, with each vendored decoder under its own license.
  Hosts check it out as a git submodule and import it as `webgpu-player/*`.
  Its only host is the Jellyfin plugin's add-on.
- The engine is an npm workspace of its host (10-02).
  npm installs the engine's dependencies, so the host lists only what it uses directly.
  Inside the host the engine has no `node_modules` of its own, and its tooling finds packages by walking up from the engine root.
- `WebGPUPlayer.ts` stays in the host (10-02).
  It implements Jellyfin Web's player contract: events, superseded starts, device profiles, the HTML delegate, and user settings.
  Moving it would make the engine Jellyfin-aware, or need a wide host-injection layer.
  A later refactor may move its host-neutral orchestration into an engine session class.
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
- Decoder kits are named for their library and codecs (10-06): `ffmpeg-eac3`, `ffmpeg-truehd`, `ffmpeg-mpeg2-vc1`, `libdcadec-dts`, and `libdovi`.
  Their classes follow the codecs too, as in `MPEG2VC1SoftwareVideoDecoder`, and a name that covers one codec only says so, as in `bundledMPEG2` beside `bundledVC1`.
- Our sources in `wasm/` carry no license headers (10-06).
  The repository's `LICENSE` covers them.
- Both repositories lint the engine (10-02).
  The engine has its own ESLint config adapted from Jellyfin Web's, and the host's lint also covers the engine's `src/` and `test/`, so the engine stays clean under both.
- The documentation is this book (10-06): one mdBook in `docs/`, with no READMEs nested in other folders and no separate agent map.
- libbitsub replaces libpgs (10-02, host).
  This follows upstream and adds VobSub support.
  The custom path drives it through `timeOffset`, measured against the source-less video.

## Transport

- hls.js is a local fork (08-09, host).
  The fork streams a partial `mdat` after a complete `moof` and `mdat` header, to stay under the MSE quota on very high bitrate fMP4.
- hls.js is vendored as a submodule (10-02, host): `alchemyyy/hls.js`, branch `fix/cals2`, at `jellyfin-webgpu-client/vendor/webgpu-player-hls/`.
  The add-on aliases `hls.js` to it, and builds its `dist` when it is missing.
  It replaced a sibling checkout whose `dist` had silently gone stale.
