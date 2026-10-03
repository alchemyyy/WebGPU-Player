# Architecture

Paths follow the [README](README.md) conventions: engine paths are relative to
this repository, and `wgp/` is the host's `src/plugins/webGPUPlayer/`. Symbols
are `file:symbol`.

## Layers

```text
PlaybackManager (host src/components/playback/playbackmanager.js)
  getDeviceProfile -> PlaybackInfo -> player.play(); 'playbackstart' when play() resolves
   |
WebGPUPlayer (wgp/WebGPUPlayer.ts): the only player identity PlaybackManager sees
   |-- HTMLPlayerDelegate (wgp/) -> owned HtmlVideoPlayer (host): HTML backend, and the
   |   event/UI shell for the custom path (source-less <video>, subtitles, events)
   |-- WebGPUPresenter: own GPUDevice, canvas over the backend <video>
   |-- WebGPUAudioOutputManager (page singleton): sink routing for every audio target
   |
   +-- (a) HTML decode + WebGPU presentation (known-SDR input only)
   |     <video>/hls.js decodes; clock is the media element;
   |     rVFC -> importExternalTexture -> identity WGSL -> canvas.
   |     HDR or unknown input: presenter off, native <video> visible.
   |
   +-- (b) Custom pipeline (eligible DirectPlay VOD)
         CustomPlaybackController [main]: MediaClock, startup/stall/lag policy, fallback
          CustomDecodeSession [main]: one Worker per generation, frame queue, credits
           CustomDecode.worker [worker]: Mediabunny demux + range-validated fetch
             video: WebCodecs | OwnedNativeHEVCVideoDecoder | @hevcjs WASM (+DV EL)
                    | OpenJPEG | FFmpeg WASM (MPEG-2, VC-1)
             audio: WebCodecs/@mediabunny/ac3 | E-AC-3/DTS/TrueHD WASM
                    -> downmix -> resample 48 kHz -> limiter;  or AC-3/E-AC-3 fMP4 remux
           <- 'frame': VideoFrame | raw planes in pooled buffer (+DV/HDR10+ metadata)
           <- 'audio': f32 planar PCM | fMP4 segments
         video: rAF -> controller.takeCurrentFrame -> presenter.presentDecodedFrame
                (external texture | RawYUVGPURenderer) -> fused color WGSL -> canvas
         audio: CustomDecodeAudioBridge -> AudioWorklet (pooled 48 kHz context)
                | CustomDecodeNativeAudioBridge -> hidden <audio> + MSE
```

`WebGPUPlayer`, `HTMLPlayerDelegate`, and `HtmlVideoPlayer` with its hls.js
runtime are host code, and the rAF loop runs in `WebGPUPlayer`. Everything
else in the diagram is engine code.

## Clock

- **Decoded PCM:** worklet render time, corrected to physical output time by
  `BrowserCustomAudioOutput` via `getOutputTimestamp`, re-anchors a
  `performance.now` `MediaClock`.
- **Native-media:** `<audio>.currentTime`.
- **No audio:** `MediaClock` alone, held while video starves.

Video is pulled. Each rAF draws the newest frame at or before the clock.

## Startup (custom direct play)

1. `WebGPUPlayer.play` (host) sets up the session:
   - advances the presentation generation;
   - consumes the stock-profile proof;
   - runs `prewarmBrowserAudioContext(48000)` synchronously inside `play()`
     (user-activation window);
   - calls `presenter.startSession`;
   - enqueues `startBackendPlayback`.
2. `startCustomPlaybackBounded` (host, 25 s) runs eligibility
   ([NEGOTIATION.md](NEGOTIATION.md)). It waits for the raw-SDR prewarm. RExt
   HDR also waits for the raw-HDR prewarm. Other HDR/DV routes use only
   already-settled keys.
3. The host loads the custom pipeline as the `webgpu-custom-playback` chunk.
   `HtmlVideoPlayer.prepareCustomPlayback` (host) returns the source-less
   `<video>`. The presenter enters push mode, and
   `configurePresentationColorPipeline` (host) installs the shaders and
   authorizes the exact route.
4. `controller.play` creates a generation, resets the clock, emits `waiting`,
   and starts a 20 s startup timer. `CustomDecodeSession.start` creates the
   prebuilt worker `libraries/webgpu-player/CustomDecode.worker.js`, keyed per
   build with `?v=`. Frame credits are 4, or 2 for raw planes.
5. The worker prepares its tracks (`canDecode`), scans static HDR SEI on the
   native PQ route (16 AUs / 8 MiB), and posts `ready`. Video and audio streams
   then run concurrently.
6. The session is ready when the first frame is queued and at least 100 ms of
   PCM has been submitted. On the native-media route, the first segment must be
   appended instead.
7. `completeStartupIfReady` sets audio playing, resumes the clock, and emits
   `ready` and `playing`. The rAF loop starts. `play()` resolves, and
   PlaybackManager emits `playbackstart`.

## Steady state

| Thread | Work |
| --- | --- |
| main | rAF loop, controller, session, presenter, audio bridges, sink manager, MSE `<audio>` |
| worker (one per generation) | demux, decode, raw copy, DV/HDR10+ metadata, PCM conversion, fMP4 remux |
| AudioWorklet | 1024-chunk / 2 s ring, gain, play gate, periodic telemetry |
| GPU | the presenter's queue; authorization probes share it |

**Video credits:**

- `takeFrame` closes and re-credits older frames.
- The presented `VideoFrame` closes after `submit()`, but its credit returns
  only after `queue.onSubmittedWorkDone()`. This prevents decoder-surface
  starvation.
- In raw mode the pooled buffer is the credit and returns via `recycle-frame`.
- Owned HEVC reads a packet only while holding a credit.

**Audio credits:**

- PCM chunks are 40 ms to 65536 frames, with 8 credits. One credit returns per
  chunk the worklet has consumed. A gap, overlap, or overflow raises
  `audio-output-failed`.
- Native-media uses 2 MiB / 2 s segments, 2 credits, and appends at most 6 s
  ahead.

**Lag guard (`CustomPlaybackController`):**

- A frame more than 2 s behind the clock is discarded and re-credited, and a
  video wait starts.
- An empty queue for at least 100 ms while playing also starts a wait.
- Any wait of at least 10 s fails with `playback-stalled`.

**Hidden page (`setPageVisibility`, `drainBackgroundVideo`):**

- No rAF runs while hidden, so a 25 ms `WebGPUPlayer` timer (host) takes and
  discards due frames against the clock. Credits keep flowing and audio stays
  master.
- After 10 s hidden, audio-clocked `native` decode sends `suspend-video`. The
  worker unwinds only its video attempt and releases the decoder.
- On return, a suspended or more-than-2 s-behind video gets `resync-video` at
  the clock. The worker restarts video alone at the preceding keyframe and
  skips frames before the target. Waits restart, so hidden time never counts
  toward `playback-stalled`.
- Every resync or suspension advances the video epoch. Frames carry
  `videoEpoch`, and the session closes replaced-epoch frames and returns their
  credits.
- A reclaimed WebCodecs decoder (`QuotaExceededError`) posts
  `video-interrupted`. It resyncs at once when visible and on return when
  hidden.
- Audio can outlast the video track. The worker then posts `video-ended`
  before the run's `ended`, and the controller holds the last frame. It does
  not wait, stall, suspend, or resync.

**Geometry:** `WebGPUPresenter.bindLayoutHandling` invalidates layout on resize
observers, class/style mutations of the video and its ancestors, CSS motion
events, window resize, seek, and refresh. The backing size is CSS size x DPR,
capped by `maxTextureDimension2D`.

## Transitions

- **Seek:** new presentation generation, then `controller.seek`, then a new
  generation and a new worker at the target. Owned HEVC starts at the
  preceding key packet. DTS and TrueHD use a 1 s preroll. Stale results are
  dropped by `customPlaybackSeekRevision` (host).
- **Audio track switch:** eligibility runs again. Ineligible means renegotiate.
  Eligible means a `seeking` restart at the current time. Downmix gain changes
  apply live with a 20 ms ramp. Force-stereo or a new algorithm needs a new
  session.
- **Pause:** pauses the clock and gates the worklet to silence. The
  AudioContext keeps running, and the pool suspends it only when idle. A
  playback rate other than 1 with audio triggers same-session HTML fallback.
- **GPUDevice loss:** one recovery per session. The new device must
  re-authorize the active HDR/DV/raw route before drawing. On failure,
  `device-recovery-failed` falls back to HTML.
- **Sink change (`WebGPUAudioOutputManager`):** default is `setSinkId('')`.
  The fallback chain is selected device, then default, then the first
  enumerated device. `devicechange` re-applies the routes. Decode, worklet,
  and queues are never restarted.
- **End of stream:** the worker flushes the resampler and limiter tails and
  posts `ended`. The controller then waits until all of these hold:
  - the bridge and worklet queues are empty;
  - output time has reached the end;
  - the video queues are empty.

  Only then does it emit `ended`.
- **Stop:** `controller.destroy` stops the worker (terminated after 1 s),
  releases the worklet and sink lease (1.5 s cap), and ends the presenter
  session. The delegate stops the backend synchronously so `stopped` stays in
  order.

## Fallback and renegotiation

`custom/CustomPlaybackController.ts:getFallbackDisposition`:

| Disposition | Reasons |
| --- | --- |
| same-session HTML | audio-output-failed, audio-output-unavailable, lifecycle-failed, playback-rate-unsupported |
| renegotiate source | decode-failed, ended-before-ready, network-failed, playback-stalled, range-unsupported, source-unsupported, startup-timeout |

- When `currentPlaybackRequiresSourceRenegotiation` (host) is set, every
  reason renegotiates.
- Wrapper-side failures (presenter, frame submission, rAF) are
  `lifecycle-failed`.
- `PlayerEvent.SourceRenegotiationRequired` (host) fires once per session.
  `accept()` counts only if called synchronously during dispatch. Otherwise
  `PlayerEvent.Error` is raised.
- Fallback never re-selects a player.

**Generation and revision guards (stale-work protection):**

- WebGPUPlayer (host): presentation, backend-session, setup, seek,
  audio-selection, frame, and terminal-error revisions.
- Delegate (host): forwarding generation.
- Controller: `activeGeneration` and `fallbackGeneration`.
- One worker record per generation.
- Worklet flush generation.
- Presenter: `deviceResourceEpoch`, color and layout revisions, and the
  `fallbackLatched` flag.

## Gotchas

- External textures of high-bit-depth frames are 8-bit (Chromium N32 copy). See
  [DECISIONS.md](DECISIONS.md). Authorization tolerances: external HDR 10/255,
  external DV 8/255, raw 3/255.
- Native external HDR rewrites SPS color to limited BT.709. The shader
  recovers 10-bit codes (Y*876+64, C*896+512). A frame with a non-neutral
  colorSpace latches `decoded-frame-color-mismatch`.
- WebGPU presentation on the HTML path is SDR-only: a `<video>` external
  texture is browser-converted sRGB.
- `HtmlVideoPlayer.play()` (host) runs synchronously only when custom decode is
  off and no teardown is pending. With custom decode on, it runs after async
  eligibility.
- Worker track indices are container ordinals, not Jellyfin
  `MediaStream.Index`.
- Every seek, audio switch, and paused repaint spawns a new worker and reopens
  the input. The 32 MiB cache is per worker.
- Decoded-PCM gain (volume^3 x normalization) is uncapped and applied after the
  limiter, so boosts can clip; clipping is counted. Native-media caps gain at 1.
- `DecodedVideoGeometry` locks the first decoded size per run (64 px
  tolerance). A later size change fails the session.
- Negotiated `maximumCoded*` is Jellyfin's cropped `Width`/`Height`, but
  containers and decoders report block-aligned coded sizes (mkvmerge HEVC can
  declare 2080 lines for a 2076-line picture). Route checks allow the same
  64 px through `exceedsNegotiatedCodedSize`.
- Jellyfin's cross-origin 206 hides `Content-Range`. It is accepted only for
  `/Videos/{id}/stream` with a bounded `Content-Length` (`HTTPRangeResponse.ts`).
- The player preference (Auto/WebGPU/HTML) is the host's
  `userSettings.preferredVideoPlayer` (`PreferredVideoPlayer.ts`), not
  `WebGPUUserSettings`.
