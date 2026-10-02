# scripts/webgpu

Development, validation, and release tooling for the WebGPU player. Nothing
here ships: webpack copies nothing from this directory into `dist`. Shipped
decoders, licenses, pins, capability fixtures, and the scripts that rebuild
them live in [`vendor/webgpu`](../../vendor/webgpu/README.md).

Paths below are relative to this directory. Run commands from the repository
root.

## Release checks

| File | Purpose |
| --- | --- |
| `verify-custom-codec-artifacts.mjs` | Run after `npm run build:development`. Hash-compares every copied `dist/libraries` codec file with its source and requires the bundled decoders and licenses |
| `verify-dts-decoder-artifacts.mjs`, `verify-truehd-decoder-artifacts.mjs`, `verify-legacy-video-decoder-artifacts.mjs` | Source pins: committed runtimes, REVISION files, licenses, source archives, bridges, fixtures, and build-script markers. No build needed |

## Checks

These need no browser. Run them from the repository root:

```powershell
python -m unittest discover -s scripts/webgpu -p "*_test.py"
node --test "scripts/webgpu/*.node-test.mjs"
node scripts/webgpu/verify-dts-decoder-artifacts.mjs
node scripts/webgpu/verify-truehd-decoder-artifacts.mjs
node scripts/webgpu/verify-legacy-video-decoder-artifacts.mjs
python scripts/webgpu/generate_validation_fixture_registry.py --check
python scripts/webgpu/generate_dts_capability_fixtures.py --check
python scripts/webgpu/generate_truehd_capability_fixtures.py --check
python scripts/webgpu/generate_seven_point_one_downmix_reference.py --check
npx --no-install vite-node --script scripts/webgpu/report_dts_downmix_reference.ts --check
npm run build:development
node scripts/webgpu/verify-custom-codec-artifacts.mjs
```

The TrueHD table check needs `ffmpeg` and `ffprobe` on PATH.
`pinned_decoder_build_test.py` also covers the `vendor/webgpu` build scripts.
Real-browser playback evidence for negotiation and routes comes from the
workspace's `jellyfin-web-playback-tester`.

## Browser probes

| File | Purpose |
| --- | --- |
| `run-dolby-vision-worker-smoke.mjs`, `worker-artifact-name.mjs` | Dolby Vision decode-worker smoke against the hashed `dist` worker |
| `probe-browser-runtime.mjs` | Configuration-only browser diagnostics |
| `probe_dynamic_HDR_shader.py`, `probe-dynamic-HDR-shader-browser.mjs`, `emit_dynamic_HDR_shader.ts`, `probe_dynamic_HDR_fixture.ts` | HDR10+ WGSL shader probe |

## Media generators

These write ignored local media.

| File | Output |
| --- | --- |
| `generate_playback_smoke_media.py`, `generate_static_HDR_validation_fixtures.py`, `generate_native_HEVC_High_Tier_validation_fixture.py` | `playback-smoke-media/` |
| `create-*dolby-vision*.mjs`, `create-profile7-playback-fixture.mjs`, `create-container-only-hvce-fixture.mjs` | Dolby Vision Profile 7 variants of local media |

## Capability-fixture generators

| File | Writes |
| --- | --- |
| `generate_dts_capability_fixtures.py` | `src/plugins/webGPUPlayer/custom/DTSExactCapabilityFixtures.ts` and `validation/generated/dts.json`, from `fixtures/dts/` |
| `generate_truehd_capability_fixtures.py` | `src/plugins/webGPUPlayer/custom/TrueHDExactCapabilityFixtures.ts` and `validation/generated/truehd.json`, from `fixtures/truehd/` (needs FFmpeg) |
| `generate_jpeg2000_capability_fixture.py` | `vendor/webgpu/capability-fixtures/jpeg2000/` and its registry fragment |
| `generate_legacy_video_capability_fixture.py` | The MPEG-2 fixture in `vendor/webgpu/capability-fixtures/legacy-video/` and its registry fragment. Pass Jellyfin FFmpeg 8.1.2 with `--ffmpeg`; output that misses the pin is never installed |
| `generate_seven_point_one_downmix_reference.py` | `fixtures/downmix-reference/seven-point-one.json` |
| `report_dts_downmix_reference.ts` | DTS downmix fingerprint report (`--check`, run with vite-node) |
| `validation_fixture_registry.py`, `generate_validation_fixture_registry.py` | The content-addressed fixture registry in `validation/generated/`, built from the fragments above and checked against each fixture's pin |

Each generator accepts `--check`, which fails when its committed output is
stale. `validation/` also holds the fragment schema.

## Fixtures

`fixtures/` holds test inputs that never ship. It is `-text`, so bytes stay
exact on every checkout.

| Folder | Content |
| --- | --- |
| `fixtures/dts/` | Public-domain dcadec samples, packet tables, and reference WAVs (`PROVENANCE.txt`) |
| `fixtures/truehd/` | Synthetic TrueHD and MLP streams (`PROVENANCE.txt`) |
| `fixtures/dolby-vision-rpu/` | Dolby Vision RPU payloads for the libdovi parser tests, copied unmodified from dovi_tool `assets/tests` at the pinned libdovi revision (MIT) |
| `fixtures/downmix-reference/` | Deterministic 7.1-to-stereo reference data |
