# WebGPU Player Project Map

Orientation for agents and developers working on the WebGPU Player engine and
its Jellyfin Web integration. Read this folder before investigating the code.

## What the engine is

The engine adds two playback layers to a browser host:

1. **A client-owned custom pipeline** for qualified direct-play sources:
   Mediabunny demux in a worker, WebCodecs or bundled WASM decoders, WebGPU
   presentation, and AudioWorklet output with a client-owned clock.
2. **WebGPU presentation** of frames that the host's HTML video element
   decodes, for tone mapping and color control.

Its host is the
[Jellyfin Web fork](https://github.com/alchemyyy/jellyfin-web). The fork checks
the engine out as its `webgpu-player/` submodule and imports it as
`webgpu-player/*`. It registers a `WebGPU Player` that wraps an owned Jellyfin
HTML video player. The device profile sent to Jellyfin is augmented with
exactly the routes this browser has proven it can decode and present. The HTML
player is always the same-session fallback.

Negotiation, startup, and fallback span both repositories, so these documents
cover the engine and the host integration together.

## Path conventions

- Engine paths are relative to this repository's root. `custom/`, `color/`,
  and `validation/` are short for `src/custom/`, `src/color/`, and
  `src/validation/`.
- Host paths are relative to the fork's root and marked (host). `wgp/` is the
  host's `src/plugins/webGPUPlayer/`.
- Symbols are `file:symbol` or `Class.method`.

## Reading order

| File | Use it for |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, runtime flow, threading, fallback |
| [NEGOTIATION.md](NEGOTIATION.md) | Capability probes, device profile, eligibility, route catalog |
| [CODEC_SUPPORT.md](CODEC_SUPPORT.md) | HEVC / Dolby Vision DirectPlay support matrix |
| [MODULE_MAP.md](MODULE_MAP.md) | Where each responsibility lives, one line per file |
| [INTEGRATION.md](INTEGRATION.md) | Engine build and checks, the host's changes and checks, the local loop |
| [DECISIONS.md](DECISIONS.md) | Settled investigations and policies; do not redo these |

Older and more verbose design records live in the Dreadnought workspace's
`.agents/reference/webgpu/`. Current source and tests override any document.

## Hard invariants

- Negotiation advertises only what the selected path implements and has
  exact-output evidence for. Never gate on resolution, level, frame rate,
  bitrate, or a throughput benchmark.
- `custom/CustomContainerCodecSupport.ts` is the only container/codec
  composition matrix. No decoder-backend pair blacklists.
- Any custom failure falls back to the owned HTML player in the same session,
  or requests one PlaybackManager renegotiation. Never select a player
  recursively.
- Validate WebGPU only over HTTPS (secure context) against the locally built
  server. Negotiation success is not playback success.

## Keeping this folder useful

- Update the relevant file whenever a decision, route, or module boundary
  changes, in either repository. Keep entries short and keep
  [DECISIONS.md](DECISIONS.md) append-only in spirit.
- Record durable facts only. Git already tracks working-tree state.
- No credentials, server addresses, item IDs, media titles/paths, or absolute
  machine paths. Use repository- or workspace-relative paths.
