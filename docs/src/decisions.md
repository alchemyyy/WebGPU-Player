# Decisions

Each entry is a conclusion that cost real investigation. Do not reopen one
without new evidence. Dates are 2026, UTC. Commit hashes refer to the Jellyfin
Web fork's `webgpu-player` branch, where the engine was developed until it
became its own repository on 10-02.

## Negotiation

- No static performance gates (08-06). Width, Height, VideoLevel,
  VideoFramerate, startup throughput benchmarks, and FPS or headroom tiers were
  removed from every custom route (`db8dbc7622`). A capability means the path
  implements the codec, profile, and output contract, and vector geometry is
  output evidence only. The real limits stay: codec and profile, bit depth,
  interlacing, container, exact decoder acceptance, transfer byte bounds, and
  GPU texture limits.
- Bitrate is telemetry only. The first PlaybackInfo request omits bitrate. Only
  a bounded second request may carry it, to size a transcode that was already
  decided.
- Live performance adaptation is deferred, to a separate runtime controller
  (sustained drops, queue starvation, underruns, A/V drift, with warm-up,
  hysteresis, and cooldown). It must never change the device profile during a
  session.
- One composition matrix (08-05, `9a1c3f2922`).
  `capability/CustomContainerCodecSupport.ts` decides only whether a container
  carries a codec. Each track is qualified on its own. Never add decoder pair
  blacklists.
- Retries use the stock HTML profile, with no custom widening. A custom failure
  that asks for renegotiation can therefore get `AudioCodecNotSupported` (for
  example E-AC-3) on the retry. Fix the trigger, not the retry profile.
- Dolby Vision is never stream-copied into HLS (08-05). The augmented profile
  had let Jellyfin copy Dolby Vision HEVC into HLS, which Chromium MSE rejects.
  `WebGPUPlayer.supportsVideoStreamCopy()` (host) returns false for Dolby
  Vision sources, and the host sends `AllowVideoStreamCopy=false`.
- The Jellyfin integration is a server plugin with a client add-on (10-04; the
  fork was abandoned 10-05). Stock Jellyfin Web stays unmodified. The add-on
  loads through Jellyfin Web's window plugin path, and stand-ins replace the
  PlaybackManager seams the fork had added (see
  [The Jellyfin host](jellyfin-host.md#host-compatible-mode)).
- A Dolby Vision item advertises its own exact route (10-06, host). Jellyfin
  labels P4 and P20 by transfer, and labels Dolby Vision over Rext, Main 12, or
  8-bit Main in ranges the generic routes do not pair with that profile and
  depth. Widening the generic ranges would advertise those pairs for every
  item, so the profile asks the engine whether this item has a runtime route
  and adds exactly its VideoProfile, VideoBitDepth, and VideoRangeType.
- A declared HDR base also waits for the static HDR probes (10-06, host). A
  Dolby Vision item whose declared PQ or HLG base is not an exact native P7 or
  P8 base probes Dolby Vision in parallel with the static HDR routes (external
  first, raw only when no external key is authorized), so its base fallback can
  be advertised. Any other Dolby Vision item waits only for Dolby Vision.

## Video decode and Dolby Vision

These were settled on stock Chrome on Windows, with a Chromium 153 source
audit.

- Hardware decode output is opaque. WebCodecs HEVC Main 10 hardware frames are
  P010 surfaces with `VideoFrame.format === null`, so `copyTo()` and
  `allocationSize()` cannot expose planes. Exact planes come only from the
  bundled software HEVC decoder (WASM, CPU).
- The software raw path is too slow for 4K. The bundled HEVC decoder ran at
  about 15.3 fps on a 23.976 fps 4K source, and plane extraction plus upload
  cost about 2.4 ms per frame: low frame rate, then a freeze.
- The GPUExternalTexture path is 8 bits per channel in stock Chrome.
  High-bit-depth frames go through an N32 (8 bpc) surface before page shaders
  see them (`third_party/blink/renderer/modules/webgpu/external_texture_helper.cc`).
  `copyExternalImageToTexture`, an F16 canvas, ImageBitmap, and WebGL RGBA16F
  take the same path, and no flag avoids it. Native external HDR and Dolby
  Vision routes therefore tone-map 8-bit-quantized input.
- Native-base-first Dolby Vision (08-08, accepted by the owner). P8.1 (HDR10
  base), P7 with CCID 6 (HDR10 base), and P8.4 (HLG base) prefer native
  `VideoFrame` presentation of the compatible base layer; the RPU and FEL are
  discarded, and raw reconstruction is the fallback. P5 has no compatible base,
  so it keeps RPU processing, natively through the external P5 route.
- Every Dolby Vision compatibility ID is supported (10-06). The owner's goal is
  to support everything, so no 4-bit CCID is rejected. RPU reconstruction never
  reads the CCID. The CCID only declares a base layer that can be shown on its
  own: HDR10 (1) and Ultra HD Blu-ray (6) declare PQ, HLG (4) HLG, and SDR (2)
  SDR. The native base route takes the PQ and HLG bases of P7 and P8, and any
  declared base is the last fallback after reconstruction. Other IDs (0,
  reserved, none) declare nothing, so those streams need their RPU. The raw
  Dolby Vision route advertises DOVIInvalid for the same reason, and the
  MPEG-TS dual-PID dependency accepts any CCID.
- Every Dolby Vision profile gets a route (10-06). P4, P20, P7 without its EL,
  P8 with an EL flag, Dolby Vision over Rext, Main 12, or 8-bit Main, MPEG-TS
  descriptor version 2, and compressed display metadata all play. Routes are
  tried as native P5, the native compatible base (P7, P8), RPU reconstruction,
  then the declared base through the ordinary routes, and a stream fails closed
  only when none applies. Reconstruction comes before the declared base, apart
  from the native-base-first case, because a base without its RPU is not the
  graded picture. P20 reconstructs its MV-HEVC base view as P5 (CCID 0 or none)
  or as P8. P9 (AVC) and P10 (AV1) have no RPU route; P9 plays its declared
  base, and P10 is deferred.
- Single-layer profiles discard a signaled EL (10-06). P5, P8, and P20 have no
  EL composition, so their EL flag is ignored and in-band EL NAL units are
  dropped. A P4 or P7 frame without a paired EL presents MEL exactly, because a
  MEL carries no residual, and FEL as its base layer: the HDR10 base for P7,
  and the SDR base exactly for P4, with no tone mapping or dither.
- The `dolby_vision` crate is vendored and patched (10-06). It is copied from
  dovi_tool rev `38adec0` into `wasm/libdovi/vendor/dolby_vision/`, and its
  `PATCHES.md` lists every deviation. Upstream rejected syntax that FFmpeg's
  `dovi_rpudec.c` accepts, so the patches follow FFmpeg: header limits widened
  to FFmpeg's (8 to 16-bit layers, coefficient precision up to 32 bits, no
  mapping color space or chroma check), unsupported syntax as a typed error,
  panics returned as errors, and display-metadata extension blocks skipped as
  `parse_ext_blocks` does. Only a block whose coded length runs past the
  payload rejects the RPU. The bridge in `wasm/libdovi/src/lib.rs` adds the
  rest: a reuse cache for compressed display metadata, Profile 4's 2^30 YCC
  offset scale, and mapping chroma formats up to 4:4:4.
- Mediabunny's Dolby Vision sample entries are mapped in the engine (10-06).
  Mediabunny 1.52.2 parses `dvh1`, `dvhe`, `dva1`, `dvav`, and `dav1` but gives
  them no codec. `ISOBaseMediaDolbyVisionSampleEntry.ts` writes the wrapped
  codec into the track's internal info, contained the way
  `MatroskaVFWVideoConfiguration.ts` is, so Mediabunny itself stays unmodified.
- Decoder surfaces must not starve (08-08, `ecb5a4ec09`). Native frame credits
  return after `queue.onSubmittedWorkDone()`, not after `submit()`, because
  Chromium holds the decoder mailbox until the GPU completes and the D3D
  surface pool is finite.
- Rejected alternatives. `ffmpeg.wasm` has no GPU decode. `libmpv-wasm` is CPU
  FFmpeg plus WebGL. mpv's D3D11VA P010 path is the reference design but cannot
  be reached from a page. Threaded WASM needs COOP and COEP isolation, which
  was not pursued. An FFmpeg HEVC WASM benchmark (the gate: at least 28.8 fps
  sustained, exact YUV420P10 hashes) was dropped when the native base route
  landed.
- If exact 10-bit is ever required, the Chromium patch options are: (1) a P010
  to RGBA16F GPU copy, the narrowest patch, which fixes the N32 TODO; (2) a
  zero-copy P010 external texture; (3) raw R16 and RG16 plane import, the only
  route to bit-exact P010 and exact P7 FEL.
- Native HDR neutralization. The native external HDR route rewrites the SPS
  color to limited BT.709 so Chrome does not tone-map, and the shader recovers
  the YUV codes. An `hvcC` without an SPS defers validation to the first key
  access unit (08-05).
- Native decode hints match their probes (10-07). The SDR probes qualify with
  `no-preference`, but the runtime used to request `prefer-hardware` for every
  native `VideoFrame` route. Chromium on Windows has no hardware VP8 decoder
  and rejects that configuration, so VP8 sources failed after their probe
  passed. Only the routes that present opaque hardware output (native external
  HDR, the native Dolby Vision base, and external P5) prefer hardware, as
  their probes and authorizations do.

## Firefox

These were settled on Firefox 157 on Windows.

- WebCodecs has no HEVC on Windows (10-07). `IsSupportedVideoCodec` in
  Firefox's `dom/media/webcodecs/WebCodecsUtils.cpp` accepts HEVC only on macOS
  and Linux, and only with both `dom.media.webcodecs.h265.enabled` (on by
  default only in Nightly) and `media.hevc.enabled`. That second pref, on by
  default, lets `<video>` and MSE play HEVC through the Windows HEVC
  extension. HEVC therefore decodes in the bundled decoder, and the native
  HEVC, external HDR, and native Dolby Vision routes never qualify on Windows.
  The hardware decoder behind `<video>` cannot feed the custom pipeline, whose
  frames must reach WebGPU unconverted, while a `<video>` external texture
  arrives as SDR sRGB. The bundled decoder runs on one core, about 20 fps at
  4K on a fast CPU, so 4K plays below real time. This is left as is until
  Firefox enables WebCodecs HEVC on Windows.
- A `VideoFrame` cannot be constructed in a high-bit-depth format (10-07): the
  constructor rejects `I420P10`. The worker copies the bundled decoders' sample
  planes straight into the raw buffer instead of through
  `VideoSample.toVideoFrame()`, which also saves a copy in Chromium. The
  external P5 authorization builds an `I420P10` frame and fails, but it needs
  WebCodecs HEVC regardless.
- 10-bit AV1 decodes to 8-bit `BGRX`, and the 4K VP9 Profile 2 vector fails to
  decode (10-07), so raw HDR AV1 and VP9 do not qualify.
- The Vorbis decoder emits an empty `AudioData` for the priming packet before
  the decoded one (10-07). Mediabunny skips it at runtime, and the audio probe
  skips empty outputs too.

## Playback robustness

- Decode-clock guard (08-07, `cde9dba045`). One stale or seek-preroll frame
  more than 2 s behind the clock is discarded and re-credited, with no
  immediate renegotiation. Sustained starvation still falls back after the
  bounded timeout.
- Hidden-page video follows Chromium (10-01). A hidden page used to stall
  video at exhausted credits while audio ran on, and on return the lag guard
  replayed the backlog (frozen, then fast-forward) or tripped
  `playback-stalled`. The fix mirrors Chromium's background video track
  optimization: drain while hidden, release the decoder after 10 s, and on
  return restart video alone from the preceding keyframe. Audio is never
  touched. Only `native` decode is suspended; software backends keep draining,
  because a keyframe resync costs up to a GOP of CPU decode. A full seek was
  rejected because it restarts audio too.
- Presenter geometry (08-07). Layout is invalidated on seek, resize, style and
  class mutations, and CSS motion events. Nothing reads layout per frame during
  an animation.
- No asynchronous work before an ordinary HTML start (08-05, host). With custom
  decode off, `HtmlVideoPlayer.play()` starts synchronously. Normalization gain
  moves only on a fallback from the custom path to HTML. Seek completions are
  revision-guarded, and retired native audio is muted before its asynchronous
  cleanup.
- Parallel probe sessions cause false failures. Three concurrent sessions
  produced spurious `DirectPlayError`s. Diagnose one session at a time.

## Audio

- Output routing (08-07, `cde9dba045`). `WebGPUAudioOutputManager.ts` owns the
  sinks. "Default" is `setSinkId('')`. A suspended AudioContext that should be
  playing is resumed. Decode, worklet, and PCM queues never restart for a sink
  change. A chosen device is stored by its opaque ID, falls back to the
  default, and is restored when it reconnects.
- Output device recovery (10-06). Re-applying an unchanged sink ID does
  nothing: the Web Audio and Audio Output Devices specs, and Chromium, resolve
  a same-ID `setSinkId` without touching the output. An AudioContext created
  while Windows has no output device gets Chromium's placeholder `AUDIO_FAKE`
  parameters, and the audio service rebuilds its stream with them on every
  device change, so it never reaches a device that appears later. Only a new
  destination escapes: a real `setSinkId` change or a new context. Media
  elements request low-latency streams and follow the new default on their
  own. Chromium 134 and later send `devicechange` only to pages with microphone
  permission. Without permission, `enumerateDevices()` lists one blank
  `audiooutput` entry while any output exists and none when there is none.
  Engines without `AudioContext.setSinkId` hide outputs, so an empty list
  proves nothing there; Firefox instead gives such a context zero output
  channels. Hence the pool never reuses a context created without an output
  device, and the router polls enumeration and rebuilds the sink through
  `{ type: 'none' }`. Retries are unlimited but run only while the page is
  visible, which bounds their cost to when someone is watching; audio that
  plays in a hidden tab recovers when the tab is shown again.
- Live output layout switch (10-07). Only the output stage depends on the
  decoded layout: the audio decoder always produces the source layout, and the
  2, 6, or 8 channel count configures the downmix, resampler, and limiter, the
  worklet, and `destination.channelCount`. A layout change therefore restarts
  only the audio attempt in the worker (`resync-audio`, epoch-tagged like
  `resync-video`) and swaps the worklet on the same context and sink. It never
  goes through the seek path, which would restart video. The new audio starts
  250 ms ahead of the clock, so the clock keeps running and video does not
  stall; sound pauses for that lead. The page learns of a new device through
  `sinkchange` after a real `setSinkId` change (the recovery rebuild or a
  chosen device). Chromium does not report a default device that moves on its
  own, which is why the settings offer a manual re-detect.
- Downmix (08-06, `ca5ac91a5c`, `8239010d93`). The default is Lo/Ro (front 1.0,
  center and surrounds 0.707, LFE omitted) with a linked lookahead limiter: a
  100 ms analysis horizon, an adaptive 3 to 10 ms attack with quintic
  smoothstep, a 100 ms exponential release, and a -1 dBFS sample peak. The
  limiter drains at the end of stream and resets per seek and generation. The
  alternatives are peak-normalized Lo/Ro, AC-4, RFC 7845, Dave750, and night
  mode. Downmix applies only to a stereo destination; otherwise 5.1 and 7.1
  pass through when `AudioContext.destination.maxChannelCount` allows.
- E-AC-3 7.1 needs the layout, not just the channel count: the decoder must
  report the decoded channel layout (`9ca70e11ad`).
- The DTS envelope. DTS-HD HRA is valid at 48 and 96 kHz only. Above 96 kHz
  only 5.1 MA (or MA with a DTS:X bed) is admitted. Stereo DTS-HD MA is
  admitted up to 96 kHz. The Matroska lace timestamp tolerance is 3 ms plus one
  sample, for DTS only.
- Normalization follows the metadata. Jellyfin fills track and album gain for
  audio libraries, not movies, so video sessions normally use unity gain.

## Repository

- The engine is its own repository (10-02):
  [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player), MIT, with each
  vendored decoder under its own license. Hosts check it out as a git submodule
  and import it as `webgpu-player/*`; today that host is the Jellyfin plugin's
  add-on.
- The engine is an npm workspace of its host (10-02). npm installs the
  engine's dependencies, so the host lists only what it uses directly. Inside
  the host the engine has no `node_modules` of its own, and its tooling finds
  packages by walking up from the engine root.
- `WebGPUPlayer.ts` stays in the host (10-02). It implements Jellyfin Web's
  player contract: events, superseded starts, device profiles, the HTML
  delegate, and user settings. Moving it would make the engine Jellyfin-aware,
  or need a wide host-injection layer. A later refactor may move its
  host-neutral orchestration into an engine session class.
- Engine workers are prebuilt (10-02). esbuild bundles them as classic
  workers, because the decoder glue loads through `importScripts`. They are
  served at stable URLs under `libraries/webgpu-player/` with a per-build `?v=`
  key, not as host bundler chunks.
- Typed asset names replace hash pins (10-02). `src/EngineAssets.ts` is the
  typed manifest of runtime assets. The SHA-256 pins, verify scripts, vector
  registry, and per-file byte pins are gone; committed bytes and output oracle
  tests remain.
- Decoders build with make (10-02). `wasm/Makefile` (GNU Make) replaced the
  Python builders. FFmpeg and dcadec are pinned, shallow, `update = none`
  submodules. There is no Docker and no Python of our own in the build.
  `make check` verifies byte-reproducible outputs, and each release attaches
  the LGPL corresponding source from `make source-archives`.
- Decoder builds are not committed (10-05). `bin/` holds only build outputs, so
  `bin/wasm/` is ignored like the rest. Each checkout builds the decoders with
  `make -C wasm sources all` before the tests and the asset build. Their
  hand-written declarations live in `wasm/<kit>/`, and the `types` condition of
  the `#wasm/*` import resolves TypeScript to them, so type checks and lint
  need no build.
- Codec vectors are generated into a committed `bin/` folder (10-05).
  `bin/codec_vector_assets/` is the one committed folder in `bin/`, so every
  change to a qualification stream, generated module, or reference shows in
  review. The generators are all Python, in `scripts/codec_vector_assets/`.
  `.gitattributes` stores the folder without line-ending conversion. Hand-made
  vectors stay in `src/capability/vectors/`, and local playback media goes to
  the ignored `bin/playback_smoke_media/`.
- Known-answer media is a "vector", never a "fixture" (10-05): qualification
  vectors ship to the browser, test vectors feed only tests.
- Folder names live in `tools/constants.json` (10-05). Scripts, tests, the
  Makefile, and the host read paths from it instead of restating them.
- x265 gets no level-idc for the range-extension vectors (10-06). With CRF,
  x265 enforces a requested level through VBV, which it reports as
  non-deterministic. The generator encodes without a level and writes
  `general_level_idc` 93 (Level 3.1) into the VPS and SPS itself. The slices
  were byte-identical either way.
- Decoder kits are named for their library and codecs (10-06): `ffmpeg-eac3`,
  `ffmpeg-truehd`, `ffmpeg-mpeg2-vc1`, `libdcadec-dts`, and `libdovi`. Their
  classes follow the codecs too, as in `MPEG2VC1SoftwareVideoDecoder`, and a
  name that covers one codec only says so, as in `bundledMPEG2` beside
  `bundledVC1`.
- Our sources in `wasm/` carry no license headers (10-06). The repository's
  `LICENSE` covers them.
- Both repositories lint the engine (10-02). The engine has its own ESLint
  config adapted from Jellyfin Web's, and the host's lint also covers the
  engine's `src/` and `test/`, so the engine stays clean under both.
- The documentation is this book (10-06): one mdBook in `docs/`, for people
  and coding agents alike, with no READMEs nested in other folders and no
  separate agent map.
- libbitsub replaces libpgs (10-02, host). This follows upstream and adds
  VobSub support. The custom path drives it through `timeOffset`, measured
  against the source-less video.

## Transport

- hls.js is a local fork (08-09, host). The fork streams a partial `mdat` after
  a complete `moof` and `mdat` header, to stay under the MSE quota on very high
  bitrate fMP4.
- hls.js is vendored as a submodule (10-02, host): `alchemyyy/hls.js`, branch
  `fix/cals2`, at `jellyfin-webgpu-client/vendor/webgpu-player-hls/`. The
  add-on aliases `hls.js` to it, and builds its `dist` when it is missing. It
  replaced a sibling checkout whose `dist` had silently gone stale.
