# Sandbox

The sandbox is a local web app for testing the engine against local media.
It plays files from a folder you pick on a full-window surface, and every control and diagnostic is an overlay panel above it.
It lives in `sandbox/` and never ships.

## Run it

You need:

- A checkout set up as in [Set up a checkout](setup.md), with the decoders built, since the sandbox serves the engine's assets.
- A browser with WebGPU and WebCodecs.

Steps:

1. From the engine root, run `npm run sandbox`.
   It builds the served assets with `node scripts/build.mjs`, then starts the Vite dev server from `sandbox/vite.config.ts` on port 5180.
   Inside a host workspace, run `npm run sandbox -w webgpu-player` from the host root.
2. Open `http://localhost:5180/`.
   `localhost` is a secure context, so WebGPU works without HTTPS.
3. Click Pick folder and choose a folder of media.

The library panel then lists the folder's playable files, and clicking one plays it.

## Layout

| Region | Panels |
| --- | --- |
| Left | The library: the picked folder's tree of playable files |
| Right of the library | Playback info |
| Top | The pipeline graph of the active presentation plan |
| Right | Tone mapping, the route override, and the WGSL shader passes |
| Bottom | The transport bar, with the audio and subtitle selectors |

Subtitle cues show at the bottom center of the video, above the transport bar.
Press H to hide every panel and see the video unobstructed, and press it again to show them.
Subtitles stay while the panels are hidden.
The key is ignored while an input, a select, or a text area has focus, and it is `OVERLAY_TOGGLE_KEY` in `sandbox/src/ui/OverlayToggle.ts`.

## The library

- A file is listed when the engine's container rules in `capability/CustomContainerCodecSupport.ts` accept its extension, through `isCustomPlaybackContainer`, so the list follows the engine's container table.
- Entries whose names start with `.` are skipped with everything below them, which covers `.git` and the `._` files macOS writes beside media on other file systems.
- A `.srt`, `.vtt`, `.ass`, or `.ssa` file in the same folder belongs to a media file when its base name is the media's base name, or starts with it and a `.`, ignoring case.
  `movie.en.srt` belongs to `movie.mkv`, and `movie 2.srt` does not.
- Where the browser has `showDirectoryPicker`, as Chromium does, the picked folder's handle is remembered in IndexedDB.
  After a reload the library reopens it, or shows Grant access when the browser wants a click before it allows reading again.
- Elsewhere, as in Firefox, the library picks the folder through a folder file input (`webkitdirectory`), and nothing is remembered across reloads.
- A folder or file that cannot be read is recorded as a failure and left out, and the scan goes on.

## How a file plays

1. Clicking a file opens an audio context while the click's user activation lasts, since the probe's waits would outlast it.
2. The session probes the file with ffprobe compiled to WebAssembly, from ffmpeg.wasm.
   One command reads the streams and the container format, and a second reads the first video frame's side data, where HDR10+ metadata shows.
   A first frame that cannot be read is recorded as `first-frame-unreadable`, and the file plays without HDR10+.
3. `sandbox/src/session/PlaybackMediaSource.ts` turns the probe into the media description the engine's eligibility reads: the container, and each video and audio stream with its codec, profile, level, size, bit depth, color, and dynamic range.
   The dynamic range is Dolby Vision when the stream has a Dolby Vision configuration record, else PQ, HLG, or SDR from its transfer, and PQ is HDR10+ when the first frame carries HDR10+ metadata.
4. The route starts on the audio track marked default, else the first, through the engine modules a host uses: the capability probes, the presentation authorizations and color pipeline from `presentation/PresentationSetup.ts`, the eligibility, `CustomPlaybackController`, and `CustomPlaybackFrameLoop`.
   The controller reads the picked file itself, as a `file` source, and takes the duration from the container.

When things go wrong:

- A route that fails to start records why, and stops with everything it set up.
- The controller's request to fall back to a browser player, which the sandbox does not have, is recorded as `fallback` with its reason and media time, and stops the route.
- Changing the audio track or the route override restarts the media where its clock stopped, after a fallback too.

About ffmpeg.wasm:

- Its core is about 32 MB of WebAssembly, which loads on the first probe.
- It runs in its own worker, one command at a time, and each command reads the file in place through a WORKERFS mount instead of copying it into memory.
- `@ffmpeg/ffmpeg` and `@ffmpeg/core` are dev dependencies of the engine.
  `@ffmpeg/core` is GPL-2.0-or-later, and only the sandbox serves it, so nothing that ships includes it.

## Playback controls

- The timeline seeks on click.
  While it is dragged, it seeks at most once per `SCRUB_SEEK_INTERVAL_MILLISECONDS`, in `sandbox/src/ui/panels/TransportBarPanel.ts`, and once more where the drag ends.
- The playhead and the time follow the session clock every animation frame, while the rest of the state refreshes a few times a second.
- The audio selector lists the media's audio tracks.
  The subtitle selector lists its text-based subtitle tracks and the subtitle files beside it, and leaves out image-based tracks such as PGS and DVD subtitles.
  Both have an Off choice.
- A selected subtitle track or file is converted to WebVTT with ffmpeg and shows as plain-text cues, without styling tags.
- The tone mapping panel edits `HDRToSDRRenderSettings` within `HDR_RENDER_SETTING_RANGES`, both from `presentation/RenderSettings.ts`, and switches HDR output.
  It checks every change with `assertValidRenderSettings` before sending it, and shows the engine's reason for a value it rejects.
- The route override asks for a frame transport, raw planes or a `VideoFrame`, and a video decoder, WebCodecs or the bundled software decoder.
  The session then restarts the media where its clock stopped.
  The panel shows the route the session plays and the reason for its choice.

## The route override

The override narrows what the engine's eligibility may choose from rather than replacing its choice, so the eligibility still validates every route the session plays.
It is in `sandbox/src/session/RouteOverride.ts`.

- A transport override withdraws the presentation authorizations of the other transport.
  `VideoFrame` withdraws every raw-plane route, Dolby Vision reconstruction included, and raw planes withdraw the native HDR, native Dolby Vision, and external HDR routes.
  An SDR `VideoFrame` route needs no authorization, so raw planes cannot withdraw it.
- A decoder override marks the capabilities of the other decoder unsupported.
  It chooses only among the decoders the capability probes qualified for the file, so it cannot force a decoder the probes rejected.
- When the chosen route leaves part of the override unmet, the session records `route-override-unmet` with what was asked and what was chosen, and plays the route anyway.

## Diagnostics

- The pipeline graph draws the active presentation plan from left to right: the source with its route, one node per planned pass with its kind, targets, and color steps, and the canvas with its format and tone mapping.
  Edges follow each texture from the pass that writes it to every pass that reads it, and history reads are dashed and labeled with their offset, such as `[-1]`.
  The passes the plan left out are listed beside the graph as `reason: detail`.
- Playback info groups the media and its tracks, the route and the override, the clock, video decode, audio, presentation, authorization, and the failure log, newest first.
  Its sections collapse, and stay collapsed across refreshes.
- The shader panel adds passes from the examples, from files, or by dropping files on it.
  It lists each pass with its plan state, its order controls, and an input per parameter, which applies when committed.
- Files dropped anywhere but the shader panel are ignored, so a stray drop never navigates away from the sandbox.

## How it is built

| Path | Holds |
| --- | --- |
| `sandbox/src/contracts/SandboxContracts.ts` | The contract between the layers: the state the session and the library publish, and the commands the panels send |
| `sandbox/src/ui/Store.ts` | One immutable state object, shallow-merged updates, and selector subscriptions |
| `sandbox/src/library/` | The media library: the folder pickers, the scan, the tree, and the remembered folder |
| `sandbox/src/session/` | The playback session, which drives the engine, and the ffprobe probe with its translation into the engine's media description |
| `sandbox/src/ui/App.ts` | The layout, which mounts each panel into its region and toggles them |
| `sandbox/src/ui/panels/` | One module per panel, each with its own stylesheet |
| `sandbox/src/ui/diagnostics/` | What the diagnostics panels show, as pure functions of the state: the graph layout, the playback info sections, and the shader pass rows |
| `sandbox/src/ui/theme.css` | The shared variables every stylesheet reads instead of restating colors |
| `test/sandbox/` | The sandbox's unit tests, which `npm test` runs with the engine's |

Every part follows these rules:

- Panels read the state and send commands; they never call the engine.
- Media time is integer microseconds, `Microseconds` from `src/MediaTime.ts`, and `sandbox/src/ui/TimeFormat.ts` formats it.
- A failure is a code and a terse detail with the failing value, recorded in the state's failures with the layer that failed.
  A command records its failure before it rejects, and panels end command promises with `reportCommandRejection` from `sandbox/src/ui/commands.ts`, which only logs.
- `sandbox/src/ui/App.css` draws every panel's box and the shared control look at zero specificity, so a panel stylesheet styles its contents and overrides only what it needs.
