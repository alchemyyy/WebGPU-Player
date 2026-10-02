# Integration, Build, and Tooling

Engine paths are relative to this repository. Host paths are relative to the
Jellyfin Web fork's root, where this repository is the `vendor/webgpu-player/`
submodule and an npm workspace.

## Engine build and checks

From the engine root, after `npm ci`:

- `npm run typecheck`: `tsc --noEmit` over `src/` and `test/`.
- `npm test`: the Vitest suites (jsdom). Decoder integration tests run the
  committed WebAssembly in Node.
- `npm run lint`: the engine's ESLint config, adapted from Jellyfin Web's.
- `npm run build`: writes `dist/libraries/` and `dist/build-info.json`.
  `npm run build -- --production` minifies the workers.
- Tooling checks (generator `--check` modes, Python and node tests) are listed
  in `tools/README.md`.
- Decoder rebuilds use `make -C codecs` (Git Bash on Windows); see
  `codecs/README.md`.

Inside the fork, the engine is an npm workspace without a `node_modules` of its
own. Run the same scripts from the fork root with `-w webgpu-player`, for
example `npm test -w webgpu-player`. `npm ci` inside the engine folder would act
on the fork's workspace, not on the engine alone.

## Served assets

- **Asset build.** `scripts/build.mjs` writes `dist/libraries/`:
  - it bundles the six engine workers with esbuild as classic workers;
  - it copies the decoders, licenses, bridge sources, LGPL source notices, and
    qualification streams.

  It also writes `dist/build-info.json`, whose `assetKey` is a hash of every
  served file. The host serves `dist/libraries/` unmodified.
- **Stable worker URLs.** Engine workers are served at
  `libraries/webgpu-player/<Name>.worker.js`, not as host bundler chunks.
  Assets carry the per-build `?v=` key and resolve relative to the worker's own
  URL inside workers.
- **Asset manifest.** `src/EngineAssets.ts` names every runtime asset.
  `scripts/library-assets.mjs` maps each served file to its source, and the
  `EngineAssets` test keeps the two in agreement.
- **Decoders.** The decoder builds are committed in `codecs/dist/`.
- **Qualification streams.** These live in `fixtures/capability/` and are
  served as `.bin`, because Jellyfin's static file provider rejects unknown
  extensions.

## The host: Jellyfin Web fork

### Submodule workflow

`vendor/webgpu-player/` in the fork is this repository at a pinned commit.
Commit an engine change here first, then commit the new pointer in the fork. Push the
engine before the fork, so the fork never pins an unpublished commit.

### Footprint outside the plugin

Diff base: `git merge-base HEAD upstream/master` in the fork.

| Path | What the fork changes |
| --- | --- |
| `src/components/playback/playbackmanager.js` | Preference-ordered player selection; generation-guarded play and stream changes (`PLAYBACK_SUPERSEDED`); bitrate-free negotiation for players whose `getMaxStreamingBitrate()` is null; `AllowVideoStreamCopy` veto; `sourcerenegotiationrequired` becomes one transcode retry |
| `src/components/playback/{PlaybackStreamCopyPolicy,PlaybackBitratePolicy,PreferredVideoPlayer,PlaybackRequestGate,PlaybackChangeTracker,PlaybackRecoveryPosition}.ts`, `src/constants/playbackResult.ts` | Seams that playbackmanager uses: stream-copy veto, bitrate purposes (`playback-selection` / `transcode-output`), Auto/WebGPU/HTML ordering, request generations, stop ordering, retry position |
| `src/components/playback/playersettingsmenu.js` | Generic `player.getSettingsMenuItems()` seam (adds "WebGPU Settings") |
| `src/components/playerstats/playerstats.js` | Session matched by playback identity, generation-guarded requests, rows from the active player's `getStats()` |
| `src/plugins/htmlVideoPlayer/plugin.js` | Usable as an owned backend: `getPresentationSurface`, `prepareCustomPlayback`, `notifyCustomPlayback*` event bridge, play and subtitle generations, ASS canvas and libbitsub bitmap subtitles driven by the custom clock through `timeOffset`. `useWebGPUHLSRuntime` now only selects the 6 s / 30 s buffers |
| `src/plugins/htmlVideoPlayer/HLSRenditionPreference.ts` | HDR rendition preference; `plugin.js` imports the one hls.js runtime (`hls.js/dist/hls.js`) directly |
| `src/components/htmlMediaHelper.js`, `HLSAppendFailurePolicy.ts`, `HLSRecoveryPosition.ts`, `src/plugins/htmlAudioPlayer/plugin.js` | Per-instance HLS recovery that replaces the global `window.Hls` |
| `src/plugins/syncPlay/ui/players/HtmlVideoPlayer.js`, `src/apps/legacy/.../playback/*` | `PlaybackRate` support check; OSD listener leak fix; `PlayerEvent.SourceRenegotiationRequired` |
| `src/components/playbackSettings/*`, `src/scripts/settings/userSettings.js` | Preferred video player and downmix algorithm settings, stored locally only |
| `src/scripts/settings/webSettings.js`, `src/types/webConfig.ts`, `src/config.json` | `enableWebGPU*` flags; `getPlugins()` always places `webGPUPlayer/plugin` before `htmlVideoPlayer/plugin` |
| `vendor/webgpu-player/`, `vendor/webgpu-player-hls/`, `.gitmodules` | Two submodules: this engine, imported as `webgpu-player/*`, and the patched hls.js (`alchemyyy/hls.js`, branch `fix/cals2`) |
| `vendor/webgpu-player-integ-tests/` | The fork's integration tests; upstream keeps its tests beside the sources in `src` |
| `tsconfig.json`, `webpack.common.js` | Resolve `webgpu-player/*` to `vendor/webgpu-player/src/*` (Vitest follows the tsconfig paths). `tsc` checks `src`, the engine's `src`, and the integration tests |
| `vite.config.ts` | Excludes both submodules; the engine and hls.js run their own suites |
| `webpack.common.js` | Runs `vendor/webgpu-player/scripts/build.mjs` at config load (`--production` for production builds), copies `vendor/webgpu-player/dist/libraries` to `dist/libraries/`, and defines `__WEBGPU_PLAYER_ASSET_KEY__` from `vendor/webgpu-player/dist/build-info.json`; keeps `new URL()` module assets out of babel so the libbitsub worker can import its verbatim glue (`dist/libbitsub.*.js`) |
| `eslint.config.mjs` | Lints the integration tests and the engine's `src` and `test` with the app rules; ignores the engine's tooling, codecs, and build output, and all of hls.js |
| `.npmrc` | `install-links=true`, so npm copies the vendored hls.js into `node_modules` instead of linking it. A link to a folder inside the project would also install hls.js's dev dependencies |
| `.escheckrc` | Excludes the engine-served `dist/libraries/` subtrees, which run only in WebGPU-capable browsers |
| `src/global.d.ts`, `src/types/webgpu.d.ts` | Declare `__WEBGPU_PLAYER_ASSET_KEY__` and load the `@webgpu/types` declarations |
| `package.json` | `"workspaces": ["vendor/webgpu-player"]`, so npm installs the engine's dependencies, including `esbuild` for its asset build; `@webgpu/types` for the fork's own type check; `"hls.js": "file:vendor/webgpu-player-hls"` plus an `overrides` entry that resolves libbitsub's optional `hls.js` peer to the same package |

Enhancements unrelated to the WebGPU player live on the fork's `master` branch,
not here: the About section, client-side HDR tone mapping for HLS, the detected
aspect ratio option, and the HLS resume, startup timeout, and worker path fixes.

### Registration and selection

- `wgp/plugin.ts` exports `WebGPUPlayer` (id `webgpuplayer`, priority 0,
  `syncPlayWrapAs = 'htmlvideoplayer'`). It owns an `HtmlVideoPlayer`
  (priority 1).
- `wgp/plugin.ts` also configures the engine: `configureEngineAssets` with the
  per-build asset key, and `configureEngineFeatureFlags` with the HDR tone
  mapping setting from `webSettings`.
- `getPlayer()` sorts by priority, then applies
  `userSettings.preferredVideoPlayer()` (localStorage
  `<userId>-preferredVideoPlayer`, default `auto`):
  - `html` puts HTML first, so WebGPU is never selected.
  - `auto` and `webgpu` leave WebGPU first.
- WebGPU in-player settings live in localStorage
  `<userId>-webGPUPlaybackSettings`. Each browser profile, including each
  tester worker profile, has its own copy.
- `src/config.json` flags:
  - `enableWebGPUCustomDecode` turns on the custom pipeline and profile
    augmentation. When off, WebGPU only presents known-SDR HTML playback.
  - `enableWebGPUHDRToneMapping` turns on HDR/DV routes and their
    authorization.

### Host tests and checks

From the fork root:

- `npm test`: Vitest (jsdom). Fork integration tests live under
  `vendor/webgpu-player-integ-tests`, upstream tests beside their sources in
  `src`.
- `npm test -- <files>`: focused test run.
- `npm test -w webgpu-player`, `npm run typecheck -w webgpu-player`, and
  `npm run lint -w webgpu-player`: the engine's own checks, run in its folder
  against the fork's `node_modules`.
- `npm run build:check`: `tsc --noEmit` over `src`, the integration tests, and
  the engine's `src`, but not the engine's tests.
- `npm run lint` (whole repo) or `npm run lint -- <files>`. Engine sources and
  tests must pass both this and the engine's own lint.
- `npm run build:development`, `npm run build:production` (production adds
  `serviceworker.js`), and `npm run build:es-check`.

## Local integration loop (Dreadnought workspace)

From the workspace's `@jellyfin_local_testing_server/`:

```bat
..\build_hls.bat                        :: first, and after every vendored hls.js change
build_all.bat webgpu                    :: backend publish + web build/deploy (server stopped)
launch_server.bat                       :: Jellyfin 127.0.0.1:8096 + Caddy HTTPS localhost:8920 (/web/)
build_web.bat webgpu                    :: incremental dev build + deploy, no restart
build_web.bat webgpu --mode production  :: also emits serviceworker.js
server_status.bat & stop_server.bat
```

From the workspace's `jellyfin-web-playback-tester/`. Its config and
credentials live in the ignored `.runtime/`; never create or edit them for the
user.

```bat
run_movies_local.bat --item "LOCAL_ITEM_ID" --parallel-sessions 1
uv run python src\launch.py --credentials-file .runtime\local-credentials.json run --config .runtime\local-config.toml --items-file .runtime\items.txt --parallel-sessions 3
```

Reports go to `.runtime\local-reports\<UTC-run-id>\` (`report.md`,
`report.json`, gzipped evidence sidecars). The exit code reflects proof only,
so read `quality_status`.

## Gotchas

- Fully reload the browser after a web-only deploy. Open pages keep their old
  bundles; engine workers and decoders change their `?v=` key with each build.
- Clone the fork with submodules (`git submodule update --init`). Without
  `vendor/webgpu-player/`, the webpack config fails at load.
- `node_modules/webgpu-player` is npm's workspace junction to
  `vendor/webgpu-player`. Remove it alone (`rmdir`) before deleting
  `node_modules` with a tool that might follow it, or it deletes the engine
  checkout.
- `webpack serve` builds the engine assets only at config load. Restart it
  after editing an engine worker.
- WebGPU needs a secure context. Over LAN HTTP the WebGPU player is still
  selected but plays as HTML pass-through, which proves nothing.
- Development builds lack `serviceworker.js`. The 404 marks every tester item
  `degraded`. Deploy `--mode production` or compare like with like.
- Build `vendor/webgpu-player-hls` (`npm ci`, then `npm run build` or the
  workspace's `build_hls.bat`) before the first `npm ci` of the fork. npm
  copies its `dist` at install time, so a stale or missing `dist` ships
  silently. The workspace's `build_jellyfin_web.bat` builds it when `dist` is
  missing and refreshes the copy in `node_modules` before every build.
- Inside the fork, hls.js's own type build fails: TypeScript's automatic
  `@types` lookup walks up into the fork's `node_modules` and finds a
  conflicting `@types/dom-webcodecs`. The fork needs only the JavaScript
  bundles, so `build_hls.bat` runs `rollup --config` alone.
- hls.js's `package.json` has no `version`, so without the `overrides` entry
  `npm install` fails with ERESOLVE on libbitsub's optional `hls.js >=1.0.0`
  peer.
- `scripts/build.mjs` fails when an asset it maps is missing, which also stops
  the host's webpack build.
- The tester parses the `getStats()` labels `Playback pipeline`,
  `Decoded / presented frames`, and `Dropped / queued frames`. Renaming them
  breaks playback proof.
- `run_movies_local.bat` defaults to 4 parallel workers. Diagnose with
  `--parallel-sessions 1`, because concurrency causes false `DirectPlayError`s.
