# Architecture

## Layers

```text
Jellyfin Web PlaybackManager (stock)
  getDeviceProfile -> PlaybackInfo -> player.play(); 'playbackstart' when play() resolves
   |
WebGPUPlayer (host): the only player PlaybackManager sees
   |-- HTMLPlayerDelegate (host) -> the add-on's own HtmlVideoPlayer (host): the HTML
   |     backend, and the event and UI shell of the custom path
   |-- WebGPUPresenter: its own GPUDevice, a canvas over the backend <video>
   |-- WebGPUAudioOutputManager (one per page): sink routing for every audio target
   |
   +-- (a) HTML decode, WebGPU presentation (known-SDR input only)
   |     <video> or hls.js decodes, and the media element is the clock.
   |     rVFC -> importExternalTexture -> identity WGSL -> canvas.
   |     HDR or unknown input: the presenter is off and the <video> shows.
   |
   +-- (b) Custom pipeline (eligible direct-play VOD)
         CustomPlaybackController [main]: MediaClock, startup, stall, and lag policy, fallback
          CustomDecodeSession [main]: one worker per generation, frame queue, credits
           CustomDecode.worker [worker]: Mediabunny demux, range-validated fetch
             video: WebCodecs | OwnedNativeHEVCVideoDecoder | hevc.js WASM (+ Dolby Vision EL)
                    | OwnedNativeVideoDecoder (AV1 Dolby Vision) | OpenJPEG
                    | FFmpeg MPEG-2 and VC-1 WASM
             audio: WebCodecs | @mediabunny/ac3 | E-AC-3, DTS, TrueHD WASM
                    -> downmix -> resample to 48 kHz -> limiter; or AC-3/E-AC-3 fMP4 remux
           <- 'frame': VideoFrame | raw planes in a pooled buffer (+ Dolby Vision, HDR10+ metadata)
           <- 'audio': f32 planar PCM | fMP4 segments
         video: rAF -> controller.takeCurrentFrame -> presenter.presentDecodedFrame
                (external texture | RawYUVGPURenderer) -> fused color WGSL -> canvas
         audio: CustomDecodeAudioBridge -> AudioWorklet (pooled 48 kHz context)
                | CustomDecodeNativeAudioBridge -> hidden <audio> + MSE
```

`WebGPUPlayer`, `HTMLPlayerDelegate`, and `HtmlVideoPlayer` with its hls.js runtime are host code, and the rAF loop runs in `WebGPUPlayer`.
Everything else in the diagram is engine code.

## Clock

- Decoded PCM: the worklet's render time, corrected to physical output time by `BrowserCustomAudioOutput` through `getOutputTimestamp`, re-anchors a `performance.now` `MediaClock`.
  After each flush the worklet renders silence from the flush position up to the first chunk's timestamp, so an audio track that starts later than the video still clocks from the start position.
- Native-media audio: `<audio>.currentTime`.
  A first fragment more than 40 ms after the start position parks the element at the fragment, and `play()` waits out the gap while the `MediaClock` runs alone.
- No audio: `MediaClock` alone, held while video starves.
  An audio track that ends before the video hands the clock to the `MediaClock` once its tail has played out.

Video is pulled: each rAF draws the newest frame at or before the clock.

## Startup of a custom session

1. `WebGPUPlayer.play` (host) advances the presentation generation and consumes the stock-profile proof.
   It runs `prewarmBrowserAudioContext(48000)` synchronously inside `play()` (the user-activation window), calls `presenter.startSession`, and queues `startBackendPlayback`.
2. `startCustomPlaybackBounded` (host) runs eligibility, described in [Negotiation and routes](negotiation.md).
   It waits for the raw SDR prewarm.
   An HDR range-extension source also waits for the raw HDR prewarm, and a Dolby Vision source waits for its first-use key (Profile 4, or Profile 7 or single-layer reconstruction outside I420P10).
   Other HDR and Dolby Vision routes use only keys that have already settled.
   Its 25 s bound lasts until the controller starts, and the controller's own startup bound applies after that.
3. The host loads the pipeline as the `webgpu-custom-playback` chunk.
   `HtmlVideoPlayer.prepareCustomPlayback` (host) returns a source-less `<video>`.
   The presenter enters push mode, and `configurePresentationColorPipeline` (host) installs the shaders and authorizes the selected route.
4. `controller.play` creates a generation, resets the clock, emits `waiting`, and starts the startup bound.
   It samples the decode counters every second and fails after 20 s without progress, or at 60 s regardless.
   The fallback message names the counters it reached, so a timeout shows where startup stalled.
   `CustomDecodeSession.start` creates the prebuilt worker `libraries/webgpu-player/CustomDecode.worker.js`, keyed per build with `?v=`.
   Video gets 4 frame credits, or 2 for raw planes.
5. The worker prepares its tracks (`canDecode`), scans static HDR SEI on the native PQ route (16 access units or 8 MiB), and posts `ready`.
   Video and audio then stream concurrently.
6. The session is ready when the first frame is queued and at least 100 ms of PCM has been submitted, or, on the native-media audio route, when the first segment is appended.
7. `completeStartupIfReady` starts audio, resumes the clock, and emits `ready` and `playing`.
   The rAF loop starts, `play()` resolves, and PlaybackManager emits `playbackstart`.

## Steady state

| Thread | Work |
| --- | --- |
| main | rAF loop, controller, session, presenter, audio bridges, sink manager, MSE `<audio>` |
| worker, one per generation | demux, decode, raw copy, Dolby Vision and HDR10+ metadata, PCM conversion, fMP4 remux |
| AudioWorklet | 1024-frame chunks in a 2 s ring, gain, play gate, periodic telemetry |
| GPU | the presenter's queue, which the authorization probes share |

Video credits:

- `takeFrame` closes and re-credits older frames.
- A presented `VideoFrame` closes after `submit()`, but its credit returns only after `queue.onSubmittedWorkDone()`.
  This keeps the decoder's surfaces from starving.
- In raw mode the pooled buffer is the credit, and it returns through `recycle-frame`.
- The owned HEVC and AV1 paths read a packet only while they hold a credit.

Audio credits:

- PCM chunks are 40 ms to 12000 frames, with 8 credits, so the credits can never hold more than the 2 s worklet ring.
  One credit returns per chunk the worklet consumes.
  The worker reconciles decoder timestamps within 2 s before the resampler (see [Decisions](decisions.md#audio)), and fails the attempt as `decode-failed` beyond that.
  A gap, an overlap, or an overflow that reaches the bridge is therefore an engine fault, and raises `audio-output-failed`.
- Native-media audio uses 2 MiB or 2 s segments, 2 credits, and appends at most 6 s ahead.

Lag guard, in `CustomPlaybackController`:

- A frame more than 2 s behind the clock is discarded and re-credited, and a video wait starts.
- An empty queue for at least 100 ms while playing also starts a wait.
- A wait of 10 s or more fails with `playback-stalled`.

Hidden page, through `setPageVisibility` and `drainBackgroundVideo`:

- No rAF runs while the page is hidden, so a 25 ms timer in `WebGPUPlayer` (host) takes and discards due frames against the clock.
  Credits keep flowing and audio stays the master.
- After 10 s hidden, audio-clocked `native` decode sends `suspend-video`.
  The worker unwinds only its video attempt and releases the decoder.
  Once the audio track has ended, only video can reach the end of the stream, so video is no longer suspended and `audio-ended` resyncs a suspended decoder at once.
- On return, a suspended video, or one more than 2 s behind, gets `resync-video` at the clock.
  The worker restarts video alone at the preceding keyframe and skips frames before the target.
  Waits restart, so hidden time never counts toward `playback-stalled`.
- Every resync or suspension advances the video epoch.
  Frames carry `videoEpoch`, and the session closes frames of a replaced epoch and returns their credits.
- A reclaimed WebCodecs decoder (`QuotaExceededError`) posts `video-interrupted`.
  Video resyncs at once when visible, and on return when hidden.
- When audio outlasts the video track, the worker posts `video-ended` before the run's `ended`, and the controller holds the last frame without waiting, stalling, suspending, or resyncing.

Geometry: `WebGPUPresenter.bindLayoutHandling` invalidates layout on resize observers, class and style mutations of the video and its ancestors, CSS motion events, window resize, seek, and refresh.
The backing size is the CSS size times the device pixel ratio, capped by `maxTextureDimension2D`.

## Transitions

- Seek: a new presentation generation, then `controller.seek`, then a new generation and a new worker at the target.
  The owned HEVC and AV1 paths start at the preceding key packet.
  DTS and TrueHD use a 1 s preroll.
  Stale results are dropped by `customPlaybackSeekRevision` (host).
- Audio track switch: eligibility runs again.
  If the source is no longer eligible, the session renegotiates; otherwise it restarts as a seek at the current time.
  Downmix gain changes apply live with a 20 ms ramp.
- Audio output layout switch (`controller.reconfigureAudioOutput`): a new device layout, force stereo, or a new downmix algorithm restarts only decoded audio while video keeps playing.
  The requested channel count is a ceiling applied to the decoded source layout, which the worker reports with `audio-source-format`: three channels and 5.1 take 5.1, 6.1 and 7.1 take 7.1 or fold into 5.1, and anything else mixes to stereo.
  A request that keeps the layout only records its downmix for later restarts, and a newer request replaces a pending switch.
  1. The controller stops the output and picks a target 250 ms ahead of the clock (the current time when paused or waiting on an audio underflow).
  2. `session.resyncAudio` stops the old bridge and advances the audio epoch.
     `BrowserCustomAudioOutput.reconfigure` retires the worklet, sets `destination.channelCount`, and leases a worklet with the new channel count on the same context and sink.
  3. The worker gets `resync-audio`: its audio attempt unwinds, and a new one starts at the target with a rebuilt downmix, resampler, and limiter (DTS and TrueHD keep their preroll).
     Samples and credits are tagged with the epoch, so stale ones are dropped.
  4. Once the new epoch has buffered 100 ms, the output starts when the clock reaches the target.
     Audio telemetry does not move the clock in between.
     A clock that waited on the old output's underflow resumes at this point, because the new output starts full and never reports a recovery.
     A pause holds the start, and resume counts down to the target again.

  A failure, or a fill that exceeds 5 s, falls back to HTML in the same session.
  The host triggers the switch when the output reports `sinkchange` with a different channel count, and when force stereo or the algorithm changes.
- Pause: the clock pauses and the worklet is gated to silence.
  The AudioContext keeps running; the pool suspends it only when idle.
  A playback rate other than 1 with audio falls back to the HTML player in the same session.
- GPU device loss: one recovery per session.
  The new device must re-authorize the active HDR, Dolby Vision, or raw route before it draws.
  If that fails, `device-recovery-failed` falls back to HTML.
- Audio sink change (`WebGPUAudioOutputManager`): the default sink is `setSinkId('')`.
  The fallback chain is the selected device, then the default, then the first enumerated device.
  A route whose sink ID is unchanged is left alone, because browsers ignore a same-ID `setSinkId`.
  Decode, worklet, and queues never restart for a sink change.
- Output device recovery: Chromium binds an AudioContext created with no output device to a fake output for its whole life.
  The pool detects such a context at creation and closes it on release instead of pooling it.
  While one is in use, or a context has reported `error`, the router polls `enumerateDevices()` once a second, because Chromium sends `devicechange` only with microphone permission.
  Each poll that lists an output runs a recovery pass, without a retry limit: it rebuilds the sink with `setSinkId({ type: 'none' })` and then the requested sink, and resumes.
  Polling runs only while the page is visible; a hidden page stops it and probes again as soon as it becomes visible.
  The rebuilt sink reports `sinkchange`, so a surround device switches the session's layout at once.
- Re-detect output (WebGPU settings, host): rebuilds every AudioContext sink so the browser re-reads the device.
  Chromium moves a default output to a new device without telling the page, which leaves a stale channel count until a rebuild.
- End of stream: the worker flushes the resampler and limiter tails and posts `ended`.
  The controller emits `ended` once the bridge and worklet queues are empty, the output time has reached the end, and the video queues are empty.
- Audio ends first: the worker posts `audio-ended` (epoch-tagged) when an audio attempt finishes while video continues, and ends the run only once the video track itself has ended.
  The worklet's final underflow releases the audio tail instead of starting an audio wait that would end in `playback-stalled`.
  Unlike the end of stream drain, video waits stay in force and an uncorrelated output does not pause the clock; once the tail is out, video starvation holds the clock.
  The end also completes a start or audio resync that has no PCM left to wait for.
  A native-media session sends `endOfStream`, so `<audio>` plays out, and the clock then runs without the element.
- Stop: `controller.destroy` stops the worker (terminated after 1 s), releases the worklet and the sink lease (1.5 s cap), and ends the presenter session.
  The delegate stops the backend synchronously, so `stopped` stays in order.

## Fallback and renegotiation

`pipeline/CustomPlaybackController.ts:getFallbackDisposition` decides what a failure does:

| Disposition | Reasons |
| --- | --- |
| HTML player, same session | audio-output-failed, audio-output-unavailable, lifecycle-failed, playback-rate-unsupported |
| Renegotiate the source | decode-failed, ended-before-ready, network-failed, playback-stalled, range-unsupported, source-unsupported, startup-timeout |

- When `currentPlaybackRequiresSourceRenegotiation` (host) is set, every reason renegotiates, because the stock profile does not cover the source.
- Failures in the wrapper itself (presenter, frame submission, rAF) are `lifecycle-failed`.
- Renegotiation fires `sourcerenegotiationrequired` once per session.
  A listener accepts it only by calling `accept()` synchronously during dispatch.
  Stock Jellyfin Web has no listener, so the player raises `PlayerEvent.Error` instead and PlaybackManager's error retry ladder asks for a transcode.
  During a start, `play()` resolves first and the error follows.
- Fallback never selects another player.

Every stale callback is dropped by a generation or revision check:

- `WebGPUPlayer` (host): the presentation, backend session, setup, seek, audio selection, frame, and terminal error revisions.
- `HTMLPlayerDelegate` (host): the forwarding generation.
- The controller: `activeGeneration` and `fallbackGeneration`.
- The session: one worker record per generation.
- The worklet: its flush generation.
- The presenter: `deviceResourceEpoch`, the color and layout revisions, and `fallbackLatched`.

## Gotchas

- External textures of high-bit-depth frames are 8 bits per channel in Chromium (see [Decisions](decisions.md)).
  Authorization tolerances follow: external HDR 10/255, external Dolby Vision 8/255, raw 3/255.
- The native external HDR route rewrites the SPS color to limited BT.709, and the shader recovers the 10-bit codes (`Y*876+64`, `C*896+512`).
  A frame with a colorSpace that is not neutral latches `decoded-frame-color-mismatch`.
- The raw route checks each frame's colorSpace against the metadata, and a null member is unspecified, so it never contradicts.
  SDR also matches a `smpte170m` transfer, and HLG a `bt709` transfer on BT.2020 primaries.
- WebGPU presentation on the HTML path is SDR only: a `<video>` external texture is browser-converted sRGB.
- The add-on's `HtmlVideoPlayer.play()` (host) runs synchronously only when custom decode is off and no teardown is pending.
  Otherwise it runs after the asynchronous eligibility check.
- Worker track indices are container ordinals, not Jellyfin `MediaStream.Index`.
- Every seek, audio switch, and paused repaint starts a new worker that reopens the input.
  The 32 MiB read cache belongs to one worker.
- Decoded PCM gain (volume cubed times normalization) is applied after the limiter and is not capped, so a boost can clip; clipping is counted.
  The native-media route caps gain at 1.
- `DecodedVideoGeometry` locks the first decoded size of a run, with a 64 px tolerance.
  A later size change fails the session.
- The negotiated `maximumCoded*` is Jellyfin's cropped `Width` and `Height`, while containers and decoders report block-aligned sizes (mkvmerge can declare 2080 lines for a 2076-line HEVC picture).
  Route checks allow the same 64 px through `exceedsNegotiatedCodedSize`.
- Jellyfin's cross-origin 206 hides `Content-Range`.
  It is accepted only for `/Videos/{id}/stream` with a bounded `Content-Length` (`pipeline/HTTPRangeResponse.ts`).
