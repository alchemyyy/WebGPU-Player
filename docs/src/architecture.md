# Architecture

## Layers

<div class="diagram">
<a class="diagram-light" href="diagrams/architecture-layers.light.svg"><img src="diagrams/architecture-layers.light.svg" alt="Architecture layers: the host, the engine's main thread, its decode worker, its AudioWorklet, and the GPU"></a>
<a class="diagram-dark" href="diagrams/architecture-layers.dark.svg"><img src="diagrams/architecture-layers.dark.svg" alt="Architecture layers: the host, the engine's main thread, its decode worker, its AudioWorklet, and the GPU"></a>
</div>

A session takes one of two paths:

- (a) HTML decode with WebGPU presentation, for known-SDR input only.
  The `<video>` element or hls.js decodes, and the media element is the clock.
  Frames go rVFC, `importExternalTexture`, identity WGSL, canvas.
  For HDR or unknown input the presenter is off and the `<video>` shows.
- (b) The custom pipeline, for eligible direct-play VOD.
  The worker posts `'frame'` messages (a `VideoFrame`, or raw planes in a pooled buffer, with Dolby Vision and HDR10+ metadata), and fMP4 segments for native-media audio.
  Decoded PCM goes from the worker's audio decode worker straight to the AudioWorklet, over a channel the page hands over, and the page learns only each chunk's place and length (`audio-progress`).
  The host's rAF loop takes the controller's current frame and presents it.
  With presentation in the worker, the worker keeps each frame and posts only its descriptor, and the presenter asks the worker's renderer to draw the selected frame into a canvas the worker owns.
  Decoded audio plays through an AudioWorklet in a pooled 48 kHz context, and AC-3 and E-AC-3 can play through a hidden `<audio>` element and MSE.

The host player, its HTML backend with any hls.js runtime, and the rAF loop are host code.
Everything else in the diagram is engine code.
The plugin's book follows the Jellyfin host's half of a session.

## Clock

- Decoded PCM: the worklet's render time, corrected to physical output time by `BrowserCustomAudioOutput` through `getOutputTimestamp`, re-anchors a `performance.now` `MediaClock`.
  After each flush the worklet renders silence from the flush position up to the first chunk's timestamp, so an audio track that starts later than the video still clocks from the start position.
- Native-media audio: `<audio>.currentTime`.
  A first fragment more than 40 ms after the start position parks the element at the fragment, and `play()` waits out the gap while the `MediaClock` runs alone.
- No audio: `MediaClock` alone, held while video starves.
  An audio track that ends before the video hands the clock to the `MediaClock` once its tail has played out.

Video is pulled: each rAF draws the newest frame at or before the clock.

<div class="diagram">
<a class="diagram-light" href="diagrams/frame-presentation.light.svg"><img src="diagrams/frame-presentation.light.svg" alt="How the clock is chosen and how each tick selects, presents, or waits for a frame"></a>
<a class="diagram-dark" href="diagrams/frame-presentation.dark.svg"><img src="diagrams/frame-presentation.dark.svg" alt="How the clock is chosen and how each tick selects, presents, or waits for a frame"></a>
</div>

## Startup of a custom session

<div class="diagram">
<a class="diagram-light" href="diagrams/custom-session-startup.light.svg"><img src="diagrams/custom-session-startup.light.svg" alt="Sequence of a custom session's startup"></a>
<a class="diagram-dark" href="diagrams/custom-session-startup.dark.svg"><img src="diagrams/custom-session-startup.dark.svg" alt="Sequence of a custom session's startup"></a>
</div>

1. The host runs `prewarmBrowserAudioContext(48000)` synchronously inside its play call (the user-activation window) and calls `presenter.startSession`.
2. The host runs eligibility, described in [Eligibility and routes](routes.md), once the authorization keys the source needs have settled.
   Its own setup bound should end where the controller starts, so the controller's startup bound applies after that.
3. The host gives the presenter a source-less `<video>`.
   The presenter enters push mode, and the host installs the shaders and authorizes the selected route through the presenter.
4. `controller.play` creates a generation, resets the clock, emits `waiting`, and starts the startup bound.
   It samples the decode counters every second and fails after 20 s without progress, or at 60 s regardless.
   The fallback message names the counters it reached, so a timeout shows where startup stalled.
   `CustomDecodeSession.start` posts the generation's `start` to the session's decode worker, the prebuilt `libraries/webgpu-player/CustomDecode.worker.js` keyed per build with `?v=`, which the session's first start creates.
   A new worker first gets the host's renderer attachment, a canvas the presenter transferred and a channel to the presenter, and its first start waits for the renderer's status, at most 2 s.
   An available renderer makes every start of that worker ask for presentation in the worker; otherwise the worker's frames present on the page.
   The worker's first start with decoded PCM audio spawns its audio decode worker, the prebuilt `CustomAudioDecode.worker.js` beside it, which it keeps for its life.
   Video gets 4 frame credits, or 2 for raw planes.
5. The worker prepares its tracks (`canDecode`), scans the static HDR metadata of the first 16 access units or 8 MiB, and posts `ready`.
   It scans HEVC SEI on the native PQ route, and AV1 MDCV and CLL metadata OBUs when the first sequence header signals PQ and no RPU route is selected.
   Video and audio then stream concurrently.
6. The session is ready when the first frame is queued and at least 100 ms of PCM has been submitted, or, on the native-media audio route, when the first segment is appended.
7. `completeStartupIfReady` starts audio, resumes the clock, and emits `ready` and `playing`.
   The host then starts its rAF loop.

## Steady state

| Thread | Work |
| --- | --- |
| main | rAF loop, controller, session, presenter, audio bridges, sink manager, MSE `<audio>` |
| worker, one per session | demux, video decode, raw copy, Dolby Vision and HDR10+ metadata, Mediabunny's audio decoding (WebCodecs and `@mediabunny/ac3`), fMP4 remux; with presentation in the worker, the renderer's uploads and draws |
| audio decode worker, one per worker | the bundled E-AC-3, DTS, and TrueHD decoders, the downmix in JavaScript, the resampler and limiter in WebAssembly, and the producer that feeds the worklet |
| AudioWorklet | 1024-frame chunks in a 2 s ring, gain, play gate, periodic telemetry |
| GPU | the presenter's queue, which the authorization probes share; with presentation in the worker, the renderer's own device |

Video credits:

- `takeFrame` closes and re-credits older frames.
- A presented `VideoFrame` closes after `submit()`, but its credit returns only after `queue.onSubmittedWorkDone()`.
  This keeps the decoder's surfaces from starving.
- In raw mode the posted buffer is the credit, and it returns through `recycle-frame`.
- A worker frame keeps its credit until the page releases it with `release-frames`, once its draw completed or the page dropped or discarded it.
  Its descriptor holds the credit on the page, so the queued and the selected descriptors together stay within the start's credits.
- The owned HEVC, AV1, and VP9 paths read a packet only while they hold a credit, then wait up to 10 ms for the decoder to return a frame before reading the next.
  The credit is spent only when a frame is posted, so without that wait a hardware decoder, which answers a few milliseconds after taking a packet, received a whole group of pictures at once (see [Decisions](decisions.md#playback-robustness)).
  Steady playback therefore decodes one packet per presented frame, while seek preroll still runs at decoder speed, because each returned frame ends the wait.

Presentation in the worker:

- The session queues each `worker-frame` descriptor (frame ID, media time, duration, video epoch, display size) as it queues any frame, and the controller selects it with the same clock, lag, catch-up, starvation, and end policies.
- `presentDecodedFrame` posts `present` with the frame's ID on the renderer's channel, after a `layout` whenever the canvas geometry changed.
  Its completion handler runs once the renderer answers `presented`, after the frame's GPU work completed or failed, and the host then acknowledges or discards the frame.
- The presenter lays out the worker's canvas as its own: CSS size and position, backing size, and texture transform.
  The renderer sizes the backing store, which a transferred canvas keeps in the worker.
- `configureColorPipeline` prepares and authorizes the pipeline on the presenter's device as before, sends its shader and route as `configure`, and resumes presentation once the renderer accepts it.
  Live HDR controls follow as `settings`.
- The renderer reports each frame's Dolby Vision layer mode and HDR10+ result, which the presenter counts as it counts its own frames.
- One canvas shows at a time: the one that presented the latest frame.
- The session's telemetry reports `presentationMode`, and `rendererUnavailableReason` when a worker that was offered a renderer presents on the page.
- In the worker, `WorkerFrameStore` keeps each frame under an ID unique for the worker's life, with its Dolby Vision and HDR10+ metadata.
  The descriptor carries only a summary of that metadata, for the session's telemetry.
- A raw frame's planes upload into a texture slot of the renderer's device as the frame is kept, so its buffer returns to the run's pool at once.
  A Dolby Vision pair uploads its BL and EL into the slot's two texture sets, and a released frame's slot serves a later frame, with at most 2 spares kept.
- A kept `VideoFrame` waits in the store until it presents, and closes after `submit()`, as on the page.
- The renderer takes a device of its own through the presenter's device request, configures the transferred canvas as the presenter configures its own, and accepts a `configure` only once its own authorization registries authorized the route on that device.
- Each `present` runs the presenter's per-frame checks (color and descriptor, Dolby Vision RPU and layers, HDR10+ settings) and validates a new pipeline's first submission.
  A frame that breaks its route posts `failed` with the presenter's reason, and a frame the store no longer keeps answers `presented` with `ok` false.
- The renderer records each frame's GPU wait as `gpu-work-done` in the worker's timing trace.

Raw planes:

- A decoded `VideoFrame` is copied into a buffer of 256-byte-aligned rows, which the `frame` message transfers to the page.
- The bundled HEVC decoder hands each frame over as it drains it, while its planes are in WASM memory.
  On the raw route the worker writes them into that aligned layout, and the transfer takes the buffer as it is; on the VideoFrame route it writes compact planes and constructs the `VideoFrame` with `transfer`.
  A frame is copied once on its way to the page, and a Dolby Vision BL and EL once more, into their compound buffer.
- A run keeps spare buffers: those the page recycled and those of frames closed unposted.
  A drained frame or a copy takes a spare of its byte length, or a new buffer when none fits, and at most 2 spares of each byte length are kept, as many as the page can hold; a 4K 10-bit frame is about 25 MB.

Audio credits:

- Decoded PCM: the audio decode worker's `WorkletPCMProducer` owns the worklet's credit window.
  Chunks are 40 ms to 12000 frames, with 8 credits, so the credits can never hold more than the 2 s worklet ring.
  One credit returns per chunk the worklet consumes, with the chunk's buffers, which later chunks reuse.
  The audio decode worker reconciles decoder timestamps within 2 s before the resampler (see [Decisions](decisions.md#audio)), and fails the attempt as `decode-failed` beyond that.
  A gap, an overlap, or an overflow that reaches the producer is therefore an engine fault, and raises `audio-output-failed`.
- The worker sends each decoded PCM attempt's input in batches that close at 40 ms of media time or 64 inputs: compressed packets for a bundled decoder, or Mediabunny's decoded samples cut to the start.
  4 batches are in flight at once, and each returns its credit once the audio decode worker has rendered it, so demux runs at most a few batches ahead of the worklet's window.
- Native-media audio uses 2 MiB or 2 s segments, 2 credits, and appends at most 6 s ahead.

Lag guard, in `CustomPlaybackController`:

- A frame more than 2 s behind the clock is discarded and re-credited, and a video wait starts.
- An empty queue for at least 100 ms while playing also starts a wait.
- A wait of 10 s or more fails with `playback-stalled`.

Hidden page, through `setPageVisibility` and `drainBackgroundVideo`:

- No rAF runs while the page is hidden, so the host takes and discards due frames against the clock on a timer (25 ms in the Jellyfin host).
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
A worker canvas gets the same layout, which the presenter posts to the renderer with a new revision whenever it changes.

## Transitions

- Seek: a new presentation generation, then `controller.seek`, which stops the running generation and starts a new one at the target in the same worker.
  The owned HEVC, AV1, and VP9 paths start at the preceding key packet.
  DTS and TrueHD use a 1 s preroll.
  The host drops stale seek results by its own revision.
- Audio track switch: eligibility runs again.
  If the source is no longer eligible, the session renegotiates; otherwise it restarts as a seek at the current time.
  Downmix gain changes apply live with a 20 ms ramp.
- Audio output layout switch (`controller.reconfigureAudioOutput`): a new device layout, force stereo, or a new downmix algorithm restarts only decoded audio while video keeps playing.
  The requested channel count is a ceiling applied to the decoded source layout, which the worker reports with `audio-source-format`: three channels and 5.1 take 5.1, 6.1 and 7.1 take 7.1 or fold into 5.1, and anything else mixes to stereo.
  A request that keeps the layout only records its downmix for later restarts, and a newer request replaces a pending switch.
  1. The controller stops the output and picks a target 250 ms ahead of the clock (the current time when paused or waiting on an audio underflow).
  2. `session.resyncAudio` stops the old bridge and advances the audio epoch.
     `BrowserCustomAudioOutput.reconfigure` retires the worklet, sets `destination.channelCount`, and leases a worklet with the new channel count on the same context and sink.
  3. The worker gets `resync-audio`: it closes the audio decode worker's attempt, whose channel to the replaced worklet closes at once, and opens a new one at the target with the new worklet's channel and a rebuilt downmix, resampler, and limiter (DTS and TrueHD keep their preroll).
     Samples and credits are tagged with the epoch, so stale ones are dropped.
  4. Once the new epoch has buffered 100 ms, the output starts when the clock reaches the target.
     Audio telemetry does not move the clock in between.
     A clock that waited on the old output's underflow resumes at this point, because the new output starts full and never reports a recovery.
     A pause holds the start, and resume counts down to the target again.

  A failure, or a fill that exceeds 5 s, falls back to HTML in the same session.
  The host triggers the switch, for example when the output reports `sinkchange` with a different channel count.
- Pause: the clock pauses and the worklet is gated to silence.
  The AudioContext keeps running; the pool suspends it only when idle.
  A playback rate other than 1 with audio falls back to the HTML player in the same session.
- GPU device loss: one recovery per session.
  The new device must re-authorize the active HDR, Dolby Vision, or raw route before it draws.
  If that fails, `device-recovery-failed` falls back to HTML.
  The worker renderer's device is its own, and a failure the renderer reports with `failed` falls back as the presenter's own does.
  The renderer recovers one loss of its device for the worker's life: a new device, the canvas configured with it, and the newest `configure` authorized and installed again.
  Frames uploaded to the lost device answer `presented` with `ok` false, and a second loss or a failed recovery posts `failed` with `device-recovery-failed`.
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
- Re-detect output (`WebGPUAudioOutputManager.redetectAudioOutputs`, offered by the host's settings): rebuilds every AudioContext sink so the browser re-reads the device.
  Chromium moves a default output to a new device without telling the page, which leaves a stale channel count until a rebuild.
- End of stream: the audio decode worker flushes the resampler and limiter tails, and the worker posts `ended`.
  The controller emits `ended` once the bridge and worklet queues are empty, the output time has reached the end, and the video queues are empty.
- Audio ends first: the worker posts `audio-ended` (epoch-tagged) when an audio attempt finishes while video continues, and ends the run only once the video track itself has ended.
  The worklet's final underflow releases the audio tail instead of starting an audio wait that would end in `playback-stalled`.
  Unlike the end of stream drain, video waits stay in force and an uncorrelated output does not pause the clock; once the tail is out, video starvation holds the clock.
  The end also completes a start or audio resync that has no PCM left to wait for.
  A native-media session sends `endOfStream`, so `<audio>` plays out, and the clock then runs without the element.
- Generation handoff: the session's worker runs one generation at a time, and every run posts `stopped` last.
  A new `start` goes out only after the previous run acknowledged `stopped`, or after the session replaced a worker whose run did not acknowledge within 1 s.
  The worker also starts a run only after the previous one posted `stopped`, because a stopping run waits for every bundled HEVC decoder in the worker.
  A run's `stopped` also waits until the audio decode worker released the run's decoded PCM attempts.
  A worker is replaced, never reused, after a generation fails, a message fails validation, the worker crashes, or a run's `stopped` asks for it with `replaceWorker`; a start on another video decoder backend also gets a new worker.
  A lost audio decode worker fails its run's decoded PCM as `audio-output-failed`, and the run's `stopped` asks for replacement.
  A worker's renderer and canvas serve all its runs.
  A replacement worker gets a new attachment, whose canvas replaces the old one on the page and stays blank until its first frame presents.
- Worker frames at a handoff: a run's frames outlive it until the page releases them, so the frames that finish a run still present.
  The session releases the frames a stopped, seeking, or failed generation leaves, and the worker's next start frees any it still holds.
  A stopped or failed run also frees its own frames before its `stopped`, and the renderer's `detach` frees every kept frame.
  A worker whose ended run asked for replacement stays until its generation retires, and a worker lost while the page still holds its frames fails the generation.
- Stop: `controller.destroy` stops the generation (its run has 1 s to acknowledge), terminates the decode worker and with it its audio decode worker, releases the worklet and the sink lease (1.5 s cap), and ends the presenter session.

## Fallback and renegotiation

`pipeline/CustomPlaybackController.ts:getFallbackDisposition` decides what a failure does:

| Disposition | Reasons |
| --- | --- |
| HTML player, same session | audio-output-failed, audio-output-unavailable, lifecycle-failed, playback-rate-unsupported |
| Renegotiate the source | decode-failed, ended-before-ready, network-failed, playback-stalled, range-unsupported, source-unsupported, startup-timeout |

- The host carries out each disposition, and may renegotiate on every reason when its HTML player cannot play the source.
- Failures in the host's wrapper (presenter, frame submission, rAF) are `lifecycle-failed`.
- Fallback never selects another player.

Every stale callback is dropped by a generation or revision check:

- The host: its own generations and revisions.
- The controller: `activeGeneration` and `fallbackGeneration`.
- The session: a generation record per generation, which its worker's messages must match.
- The worklet: its flush generation.
- The presenter: `deviceResourceEpoch`, the color and layout revisions, `fallbackLatched`, and the renderer attachment a message arrives on.

## Gotchas

- External textures of high-bit-depth frames are 8 bits per channel in Chromium (see [Decisions](decisions.md)).
  Authorization tolerances follow: external HDR 10/255, external Dolby Vision 8/255, raw 3/255.
- The native external HDR route rewrites the SPS color to limited BT.709, and the shader recovers the 10-bit codes (`Y*876+64`, `C*896+512`).
  A frame with a colorSpace that is not neutral latches `decoded-frame-color-mismatch`.
- The raw route checks each frame's colorSpace against the metadata, and a null member is unspecified, so it never contradicts.
  SDR also matches a `smpte170m` transfer, and HLG a `bt709` transfer on BT.2020 primaries.
- WebGPU presentation on the HTML path is SDR only: a `<video>` external texture is browser-converted sRGB.
- Worker track indices are container ordinals, not Jellyfin `MediaStream.Index`.
- Every seek, audio switch, and paused repaint starts a new run in the session's worker, and each run opens the input again.
  The 32 MiB read cache belongs to one run, so a seek reads its range anew.
- Decoded PCM gain (volume cubed times normalization) is applied after the limiter and is not capped, so a boost can clip; clipping is counted.
  The native-media route caps gain at 1.
- `DecodedVideoGeometry` locks the first decoded size of a run, with a 64 px tolerance.
  A later size change fails the session.
- The negotiated `maximumCoded*` is Jellyfin's cropped `Width` and `Height`, while containers and decoders report block-aligned sizes (mkvmerge can declare 2080 lines for a 2076-line HEVC picture).
  Route checks allow the same 64 px through `exceedsNegotiatedCodedSize`.
- Jellyfin's cross-origin 206 hides `Content-Range`.
  It is accepted only for `/Videos/{id}/stream` with a bounded `Content-Length` (`pipeline/HTTPRangeResponse.ts`).
