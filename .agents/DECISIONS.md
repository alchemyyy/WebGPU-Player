# Decisions and Settled Investigations

Each entry is a conclusion that cost real investigation. Do not reopen one
without new evidence. Dates are 2026, UTC. Commit hashes are in the Jellyfin
Web fork's `webgpu-player` branch, where the engine was developed until the
10-02 split.

## Negotiation policy

- **No static performance gates (08-06).** Width, Height, VideoLevel,
  VideoFramerate, startup-throughput benchmarks, and FPS/headroom tiers were
  removed from every custom route (`db8dbc7622`). Capability means "this path
  implements the codec/profile/output contract". Fixture geometry is output
  evidence only. Real limits stay: codec/profile, bit depth, interlace,
  container, exact decoder acceptance, transfer-byte bounds, GPU texture
  limits.
- **Bitrate is telemetry only.** The first WebGPU PlaybackInfo request omits
  bitrate. Only a bounded second request may carry it, to size a transcode that
  was already decided.
- **Live performance adaptation is deferred**, as a separate runtime controller
  (sustained drops, queue starvation, underruns, A/V drift, with warm-up,
  hysteresis, and cooldown). It must never mutate the device profile mid-session.
- **One composition matrix (08-05, `9a1c3f2922`).**
  `custom/CustomContainerCodecSupport.ts` decides only whether a container
  carries a codec. Each track is qualified independently. Never add
  decoder-backend pair blacklists.
- **Retries use the stock HTML profile, with no custom widening.** So a custom
  failure that requests renegotiation can legitimately produce
  `AudioCodecNotSupported` (for example E-AC-3) on the retry. Fix the trigger,
  not the retry profile.
- **DV over HLS stream-copy is blocked (08-05).** The augmented profile had let
  Jellyfin stream-copy DV HEVC into HLS, which Chromium MSE rejects. In the
  host, `WebGPUPlayer.supportsVideoStreamCopy()` returns false for DV sources,
  and `playbackmanager.js` then sends `AllowVideoStreamCopy=false` through
  `src/components/playback/PlaybackStreamCopyPolicy.ts`.

## Video decode and Dolby Vision (stock Chrome, Windows; Chromium 153 source audit)

- **Hardware decode output is opaque.** WebCodecs HEVC Main10 hardware frames
  are P010 surfaces with `VideoFrame.format === null`. `copyTo()` and
  `allocationSize()` cannot expose planes. Exact planes come only from the
  bundled software HEVC (WASM, CPU).
- **The software raw path is too slow for 4K.** The bundled HEVC decoder ran
  about 15.3 fps on a 23.976 fps 4K source, and plane extraction plus upload
  costs about 2.4 ms/frame. That causes low FPS, then a freeze.
- **The GPUExternalTexture path is 8-bit in stock Chrome.** High-bit-depth
  frames are converted through an N32 (8 bpc) surface before page shaders see
  them (`third_party/blink/renderer/modules/webgpu/external_texture_helper.cc`).
  `copyExternalImageToTexture`, F16 canvas, ImageBitmap, and WebGL RGBA16F take
  the same path. No flag avoids it. Native external HDR/DV routes therefore
  tone-map 8-bit-quantized input.
- **Native-base-first DV, user accepted (08-08).** P8.1 (HDR10 base), P7 CCID6
  (HDR10 base), and P8.4 (HLG base) prefer native `VideoFrame` presentation of
  the compatible base layer. RPU/FEL reconstruction is discarded, and raw
  reconstruction remains the fallback. P8.1 went into `ecb5a4ec09`. P5 has no
  compatible base, so it keeps RPU processing (a
  native external-texture P5 route exists).
- **Decoder-surface starvation fix (08-08, `ecb5a4ec09`).** Native frame credits
  return after `queue.onSubmittedWorkDone()`, not after `submit()`. Chromium
  holds the decoder mailbox until GPU completion, and the D3D surface pool is
  finite.
- **Rejected alternatives.** `ffmpeg.wasm` has no GPU decode. `libmpv-wasm` is
  CPU FFmpeg plus WebGL. mpv's D3D11VA P010 path is the reference design but is
  not reachable from a page. Threaded WASM needs COOP/COEP isolation (not
  pursued). An FFmpeg HEVC WASM benchmark (gate: at least 28.8 fps sustained,
  exact YUV420P10 hashes) was abandoned when the native-base route landed.
- **Chromium patch options, if exact 10-bit is ever required:**
  (1) P010 to RGBA16F GPU copy, the narrowest patch, which fixes the N32 TODO;
  (2) a zero-copy P010 external texture; (3) raw R16/RG16 plane import, the
  only route that gives bit-exact P010 and exact P7 FEL.
- **Native HDR neutralization.** The native external HDR route rewrites SPS
  color to limited BT.709 so Chrome does not tone-map, and the shader recovers
  the YUV codes. SPS-free HVCC defers validation to the first key AU (08-05).

## Playback robustness

- **Decode-clock guard (08-07, `cde9dba045`).** One stale or seek-preroll frame
  more than 2 s behind the clock is discarded and re-credited, with no
  immediate renegotiation. Sustained starvation still falls back after the
  bounded timeout.
- **Hidden-page video follows Chromium (10-01).** A hidden page used to stall
  video at exhausted credits while audio ran on. On return, the lag guard then
  replayed the backlog (frozen, then fast-forward) or tripped
  `playback-stalled`. The fix mirrors Chromium's background video track
  optimization: drain while hidden, release the decoder after 10 s, and on
  return restart video alone from the preceding keyframe. Audio is never
  touched. Only `native` decode is suspended. Software backends keep draining
  because a keyframe resync costs up to one GOP of CPU decode. A full seek was
  rejected because it restarts audio too.
- **Playback Info (08-07, host).** Stats requests are generation-guarded, the
  session cache is keyed by playback identity, and the `sessions[0]` fallback
  was removed. "Player sizes" became "Player dimensions" and "Video
  resolution".
- **Presenter geometry (08-07).** Layout is invalidated on seek, resize,
  style/class mutation, and CSS motion events. There are no per-frame layout
  reads during animation.
- **No async work before ordinary HTML start (08-05, host).** With custom
  decode off, `HtmlVideoPlayer.play()` starts synchronously (covered by the
  overlapping-play lifecycle tests). The pre-play normalization import was
  removed. Normalization gain is transferred only on custom-to-HTML fallback.
  Seek completions are revision-guarded, and retired native audio is muted
  before async cleanup.
- **Parallel probe sessions cause false failures.** Three concurrent sessions
  produced spurious `DirectPlayError`s. Diagnose serially.

## Audio

- **Output routing (08-07, `cde9dba045`).** `WebGPUAudioOutputManager.ts` owns
  sinks. "Default" is `setSinkId('')`, reapplied on `devicechange`. A
  suspended, playing `AudioContext` is resumed. Decode, worklet, and PCM queues
  are never restarted for a sink change. A chosen device is persisted by opaque
  ID, with fallback to default and restore on reconnect.
- **Downmix (08-06, `ca5ac91a5c`, `8239010d93`).** The default is Lo/Ro
  (front 1.0, center and surrounds 0.707, LFE omitted) plus a linked lookahead
  limiter: 100 ms analysis horizon, adaptive 3-10 ms attack with quintic
  smoothstep, 100 ms exponential release, -1 dBFS sample peak. The limiter
  drains at EOS and resets per seek/generation. Selectable alternatives:
  peak-normalized Lo/Ro, AC-4, RFC 7845, Dave750, night mode. Downmix applies
  only when the destination is stereo; otherwise 5.1/7.1 passes through when
  `AudioContext.destination.maxChannelCount` allows.
- **E-AC-3 7.1 needs layout identity.** The decoder must expose the decoded
  channel layout, not just the count (`9ca70e11ad`).
- **DTS envelope.** DTS-HD HRA is valid at 48/96 kHz only. Above 96 kHz only
  5.1 MA (or MA + DTS:X bed) is admitted. Stereo DTS-HD MA is admitted up to
  96 kHz. The Matroska lace timestamp tolerance is 3 ms plus one sample,
  DTS only.
- **Normalization is metadata-driven.** Jellyfin populates track/album gain
  for audio libraries, not movies, so video sessions normally use unity gain.

## Repository layout

- **The engine is its own repository (10-02).**
  - The WebGPU/WebCodecs engine lives in
    [WebGPU Player](https://github.com/alchemyyy/WebGPU-Player). It is MIT;
    vendored decoders keep their own licenses.
  - The fork checks it out as the `webgpu-player/` submodule and imports it as
    `webgpu-player/*`. The fork keeps only the Jellyfin integration in
    `src/plugins/webGPUPlayer/`.
  - Engine code cannot live under the host's `src/plugins`. The plugin
    loader's `` import(`../plugins/${pluginSpec}`) `` context makes webpack
    bundle every file there.
  - This project map moved with the engine, from the fork's `.agents_webgpu/`.
    It keeps documenting the host side, marked (host).
- **`WebGPUPlayer.ts` stays in the fork (10-02).** It implements jellyfin-web's
  player contract: events, `PLAYBACK_SUPERSEDED`, device profiles, the HTML
  delegate, and user settings. Moving it would make the engine Jellyfin-aware,
  or need a wide host-injection layer. A later refactor may move its
  host-neutral orchestration into an engine session class.
- **Engine workers are prebuilt (10-02).** esbuild bundles them as classic
  workers, because the decoder glue loads through `importScripts`. They are
  served at stable URLs under `libraries/webgpu-player/` with a per-build `?v=`
  key, instead of as host-bundled worker-loader chunks.
- **Typed asset names replace hash pins (10-02).** `src/EngineAssets.ts` is
  the typed manifest of runtime assets. The SHA-256 pins, verify scripts,
  fixture registry, and `-text` byte pins are gone. Committed bytes and
  output-oracle tests remain.
- **Codecs build with make (10-02).** `codecs/Makefile` (GNU Make) replaced
  the Python builders. Details:
  - FFmpeg and dcadec are pinned submodules, shallow and with `update = none`.
  - No Docker, and no Python of our own.
  - `make check` verifies byte-reproducible outputs.
  - Each release attaches the LGPL corresponding source from
    `make source-archives`.
- **Both repositories lint the engine (10-02).** The engine has its own ESLint
  config adapted from Jellyfin Web's. The host's lint also covers the engine's
  `src/` and `test/`, so the engine stays clean under both.
- **libbitsub replaces libpgs (10-02, host).** This follows upstream and adds
  VobSub support.
  - The custom path drives it through `timeOffset`, measured against the
    source-less video.
  - Babel skips its worker glue, which the worker imports as a module.
  - On the native path, PGS no longer follows the player's Cover/Fill, matching
    upstream.

## Transport

- **hls.js is a local fork (08-09, host).** The host's `package.json` uses
  `"hls.js": "file:../hls.js"` (sibling repository, branch `fix/cals2`). The
  fork streams partial `mdat` after a complete `moof` plus `mdat` header to
  stay under the MSE quota on very high bitrate fMP4. The `hls.js-webgpu` alias
  was removed. Build `../hls.js` first (`build_hls.bat`). This dependency does
  not resolve on a clean clone.
