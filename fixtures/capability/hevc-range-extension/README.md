# HEVC range-extension capability fixtures

These Annex B HEVC files are deterministic WebCodecs capability probes. They
are 192x192 because common NVIDIA HEVC decoders reject smaller coded sizes.
They prove only that the exact codec configuration decodes, copies to the
expected WebCodecs raw format, and produces the expected fingerprints. They do
not prove playback performance, resolution/level limits, seeking, or media
transport behavior.

## Toolchain

- FFmpeg: `2026-03-01-git-862338fe31-full_build-www.gyan.dev`
- libavcodec: `62.24.100`
- libx265: `4.1+225-1b48507eb`

The synthetic source is FFmpeg `testsrc2` at 192x192, one frame per second.
All nine fixtures contain one IDR access unit followed by one P access unit,
which qualifies general inter decode for the exact range-extension tuple. x265
does not directly emit general Profile-IDC 4 for 4:2:0 8/10, so the
generator starts with conforming Main/Main10 syntax and rewrites the VPS and
SPS profile-tier-level fields to Profile-IDC 4, compatibility flag 4, and
exact general constraints `9F.88`/`9D.88`. It removes and reinserts Annex B
emulation-prevention bytes around the rewritten RBSP.

## Regeneration

`tools/generate-HEVC-range-extension-fixtures.mjs` runs the commands below in a
temporary directory with the toolchain above on PATH. For every fixture it
verifies FFprobe access-unit lengths and I/P types, VPS profile-tier-level
constraint flags, and production-equivalent raw plane fingerprints. It does
not run in normal unit tests. From the engine root:

```powershell
node tools/generate-HEVC-range-extension-fixtures.mjs --check
```

`--check` fails when a regenerated file differs from the committed bytes.
Without `--check`, the generator replaces each committed file once its checks
pass. `--inspect` prints the measured evidence without comparing or writing.

Use the following common x265 settings:

```text
-preset fast -crf 32
-x265-params info=0:pools=none:frame-threads=1:wpp=0:log-level=error:level-idc=3.1
```

Generate two frames for every row and append
`keyint=30:min-keyint=30:scenecut=0:bframes=0:repeat-headers=1`. The script then
performs the documented profile-tier-level rewrite for `rext420-8` and
`rext420-10` only.

| File | Pixel format | x265 profile | Frames |
| --- | --- | --- | ---: |
| `rext420-8.hevc` | `yuv420p` | `main` plus PTL rewrite | 2 |
| `main422-8.hevc` | `yuv422p` | `main422-10` | 2 |
| `main444-8.hevc` | `yuv444p` | `main444-8` | 2 |
| `rext420-10.hevc` | `yuv420p10le` | `main10` plus PTL rewrite | 2 |
| `main422-10.hevc` | `yuv422p10le` | `main422-10` | 2 |
| `main444-10.hevc` | `yuv444p10le` | `main444-10` | 2 |
| `main12-420.hevc` | `yuv420p12le` | `main12` | 2 |
| `main422-12.hevc` | `yuv422p12le` | `main422-12` | 2 |
| `main444-12.hevc` | `yuv444p12le` | `main444-12` | 2 |

Example two-frame command:

```powershell
ffmpeg -f lavfi -i "testsrc2=size=192x192:rate=1:duration=2" `
  -frames:v 2 -pix_fmt yuv422p10le -c:v libx265 `
  -profile:v main422-10 -preset fast -crf 32 `
  -x265-params "info=0:pools=none:frame-threads=1:wpp=0:log-level=error:keyint=30:min-keyint=30:scenecut=0:bframes=0:repeat-headers=1:level-idc=3.1" `
  -f hevc -y main422-10.hevc
```

`info=0` prevents the x265 user-data SEI; there is no post-encode SEI
stripping step. `test/custom/HEVCRangeExtensionCapabilities.test.ts` verifies
the VPS constraint bytes, intra/one-picture flags, access-unit lengths, and the
expected I/P slice sequence. Fingerprints use the production 32-bit FNV-1a
sampler in `src/custom/CustomDecodeCapabilities.ts`: plane dimensions followed
by a 64 by 36 uniform sample grid over each native output plane.

Re-encoding with another toolchain may not be byte-identical. Do not update an
access-unit length, constraint string, or fingerprint until the static fixture
tests and decoded raw output have been inspected together.
