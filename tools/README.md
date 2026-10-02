# Tools

Development and validation tooling for the engine. Nothing here ships.
`scripts/build.mjs` assembles the served assets, and the decoders are built
from `codecs/`; see [codecs/README.md](../codecs/README.md).

Run every command from the engine root.

## Checks

These need no browser:

```sh
python -m unittest discover -s tools -p "*_test.py"
node --test "tools/*.node-test.mjs"
python tools/generate_dts_capability_fixtures.py --check
python tools/generate_truehd_capability_fixtures.py --check
python tools/generate_seven_point_one_downmix_reference.py --check
npx --no-install vite-node --script tools/report_dts_downmix_reference.ts --check
python tools/generate_jpeg2000_capability_fixture.py --check
python tools/generate_legacy_video_capability_fixture.py --check
node tools/generate-HEVC-range-extension-fixtures.mjs --check
```

Each check needs some external tools:

- The TrueHD tables need `ffmpeg` and `ffprobe` on PATH.
- The JPEG 2000 fixture and the HEVC range-extension fixtures were encoded by
  FFmpeg `2026-03-01-git-862338fe31-full_build-www.gyan.dev`. The
  range-extension generator refuses any other build.
- The MPEG-2 fixture was encoded by Jellyfin FFmpeg 8.1.2. Pass another
  executable with `--ffmpeg`.

Real-browser playback evidence comes from the host application, not from these
checks.

## Generated outputs

Generators work in one of two modes. The repository commits the output either
way, so no hash pins are needed.

- **Deterministic generators** rewrite their outputs. With `--check`, they fail
  when a committed output differs from a fresh run. These are the DTS and
  TrueHD capability tables, the 7.1 downmix reference, and the DTS downmix
  report.
- **Encoder-dependent generators** (JPEG 2000, MPEG-2) compare a fresh encode
  with the committed bytes. Another encoder build writes different bytes, so a
  differing encode never replaces a committed fixture. A missing one is
  installed.
  - To revise a fixture, delete it and regenerate it with the build named
    above.
  - With `--check`, a missing fixture fails as well.
- **The HEVC range-extension generator** refuses any FFmpeg build except the
  one named above. It validates each encode before writing it, against:
  - the access-unit lengths, picture types, and profile, tier, and level that
    the probe definitions record;
  - the decoded fingerprints.

| File | Writes |
| --- | --- |
| `generate_dts_capability_fixtures.py` | `src/custom/DTSExactCapabilityFixtures.ts`, from `fixtures/test/dts/` |
| `generate_truehd_capability_fixtures.py` | `src/custom/TrueHDExactCapabilityFixtures.ts`, from `fixtures/test/truehd/` |
| `generate_seven_point_one_downmix_reference.py` | `fixtures/test/downmix-reference/seven-point-one.json` |
| `report_dts_downmix_reference.ts` | Prints the DTS downmix fingerprint report; `--check` compares it with the committed reference |
| `generate_jpeg2000_capability_fixture.py` | `fixtures/capability/jpeg2000/srgb-960x540.jp2` |
| `generate_legacy_video_capability_fixture.py` | `fixtures/capability/legacy-video/mpeg2-progressive-1920x1080.mkv` |
| `generate-HEVC-range-extension-fixtures.mjs` | `fixtures/capability/hevc-range-extension/*.hevc`; `--inspect` prints the evidence that `src/custom/HEVCRangeExtensionCapabilities.ts` records |
| `generated_output.py` | Shared write, check, and install helpers |

## Browser probes

| File | Purpose |
| --- | --- |
| `run-dolby-vision-worker-smoke.mjs` | Runs a Dolby Vision Profile 7 FEL decode in the prebuilt custom decode worker, by default `libraries/webgpu-player/CustomDecode.worker.js` relative to `--frontend-url`, through Chromium remote debugging |
| `probe-browser-runtime.mjs` | Configuration-only browser diagnostics |
| `probe_dynamic_HDR_shader.py`, `probe-dynamic-HDR-shader-browser.mjs`, `emit_dynamic_HDR_shader.ts`, `probe_dynamic_HDR_fixture.ts` | Compiles the production HDR10+ WGSL in headless Chromium |

## Local media generators

These write ignored media into `tools/playback-smoke-media/`.

| File | Output |
| --- | --- |
| `generate_playback_smoke_media.py` | HDR10 and HLG HEVC Main 10 playback fixtures and audio-switch variants |
| `generate_static_HDR_validation_fixtures.py` | Static HDR validation fixtures |
| `generate_native_HEVC_High_Tier_validation_fixture.py` | A native HEVC High Tier fixture |
| `create-*dolby-vision*.mjs`, `create-profile7-playback-fixture.mjs`, `create-container-only-hvce-fixture.mjs` | Dolby Vision Profile 7 variants of local media |

## Fixtures

`fixtures/test/` holds inputs that only tests use. `fixtures/capability/` holds
the qualification streams that browsers fetch at runtime.

| Folder | Content |
| --- | --- |
| `fixtures/test/dts/` | Public-domain dcadec samples, packet tables, and reference WAVs (`PROVENANCE.txt`) |
| `fixtures/test/truehd/` | Synthetic TrueHD and MLP streams (`PROVENANCE.txt`) |
| `fixtures/test/dolby-vision-rpu/` | Dolby Vision RPU payloads for the libdovi parser tests, copied unmodified from dovi_tool `assets/tests` (MIT) |
| `fixtures/test/downmix-reference/` | Deterministic 7.1-to-stereo reference data |
| `fixtures/capability/` | HEVC, HEVC range-extension, JPEG 2000, and legacy video qualification streams |
