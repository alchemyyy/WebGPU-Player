#!/usr/bin/env python3
"""Generate the WMA decoder project's vectors and FFmpeg's known answers for them, or verify both with --check.

FFmpeg's wmav1 and wmav2 encoders write two short stereo tones into AVI, and FFmpeg remuxes each AVI into a Matroska A_MS/ACM track,
so both containers carry the same packets and no Matroska CodecDelay, whose skip FFmpeg's decode would take instead of the decoder's own delay.
FFmpeg has no WMA Pro, WMA Lossless, or WMA Voice encoder, so the generator downloads FFmpeg's FATE samples of them over HTTPS,
requires each to have its pinned SHA-256, and remuxes its first packets into Matroska with -c copy.

The known answers are FFmpeg's whole decode of each vector with its C code (-cpuflags 0), as interleaved 32-bit float, the frames its
decoder holds back until the end of the stream included, which the package outputs once the engine drains it.

The encoders' bytes depend on the FFmpeg build, so the generator refuses any but the pinned one, and an existing vector is only compared,
never replaced. The known answers are rewritten from the committed vectors, and with --check must match.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Sequence

from engine_layout import DECODERS_DIRECTORY
from generated_output import GeneratedOutputError, install_or_check_output, write_or_check_output
from media_tools import (
    REQUIRED_FFMPEG_VERSION,
    MediaTools,
    ToolError,
    VectorGenerationError,
    check_toolchain,
    execute_tool,
    require_equal,
    resolve_FFmpeg_tool,
)


VECTOR_DIRECTORY: Final = DECODERS_DIRECTORY / "wma" / "vectors"
KNOWN_ANSWERS_FILE_NAME: Final = "known-answers.json"
FATE_SUITE_URL: Final = "https://fate-suite.ffmpeg.org/"
DOWNLOAD_TIMEOUT_SECONDS: Final = 120
# The FATE server answers slowly and drops some connections, so a download is tried this many times, waiting longer before each retry
DOWNLOAD_ATTEMPT_COUNT: Final = 5
DOWNLOAD_RETRY_DELAY_SECONDS: Final = 10
# The reference decode: FFmpeg's C code, without the assembly a CPU's flags select
REFERENCE_DECODER_OPTIONS: Final = ("-cpuflags", "0")
FLOAT_BYTE_LENGTH: Final = 4
# A tone per channel, so a decode in the wrong channel order shows
TONE_SOURCE: Final = "aevalsrc=exprs=0.5*sin(2*PI*440*t)|0.25*sin(2*PI*660*t):sample_rate={rate}:duration=0.5:channel_layout=stereo"
BITEXACT_ARGUMENTS: Final = ("-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact")
# The video beside the WMA 2 packets of the engine's decode worker tests, which play only sources with video: a few small H.264 frames,
# from libx264 in one thread, so the encode is deterministic
VIDEO_SOURCE: Final = "testsrc2=size=64x64:rate=10"
VIDEO_FRAME_COUNT: Final = 5
VIDEO_ARGUMENTS: Final = (
    "-frames:v", str(VIDEO_FRAME_COUNT), "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-g", str(VIDEO_FRAME_COUNT),
    "-threads", "1", "-flags:v", "+bitexact",
)
# The WAVE channel masks of the layouts FFprobe names for the vectors' decoded frames, by FFmpeg's libavutil/channel_layout.c names,
# and the masks of FFmpeg's default layouts of a channel count, which the bridge reports for a layout without a mask
NAMED_LAYOUT_MASKS: Final = {"mono": 0x4, "stereo": 0x3, "5.1": 0x3F, "5.1(side)": 0x60F}
DEFAULT_LAYOUT_MASKS: Final = {1: 0x4, 2: 0x3}


@dataclass(frozen=True)
class FATESample:
    """A sample of FFmpeg's FATE suite: its path below the suite's root and its pinned SHA-256."""

    path: str
    sha256: str


@dataclass(frozen=True)
class Vector:
    """One vector: its file, its codec by FFmpeg's name, and what FFprobe must read of it.

    It is an encode of the tone at its rate, a Matroska remux of another vector, the first packets of a FATE sample remuxed into Matroska,
    or another vector's packets beside an H.264 encode, which has no known answer.
    """

    file_name: str
    codec: str
    sample_rate: int
    channel_count: int
    packet_count: int
    encoder_arguments: tuple[str, ...] = ()
    remux_of: str | None = None
    fate_sample: FATESample | None = None
    with_video: bool = False


WMAPRO_SAMPLE: Final = FATESample(
    "wmapro/latin_192_mulitchannel_cut.wma", "3f3a18ce22ac061d4abc38b553a1d00cfe6795d76e2366c1aa5aa7a4c8c230b8"
)
WMALOSSLESS_16_SAMPLE: Final = FATESample(
    "lossless-audio/luckynight-partial.wma", "33d7dc28f717abcc8ef7f35c1c836840503e2d888c3dec833c53314eba81aa1b"
)
WMALOSSLESS_24_SAMPLE: Final = FATESample(
    "lossless-audio/Mega_Weird_Audio_Test_24bit.wma", "1ce71dcd98db91d23896e84c602c774fc93eeb6afc94fd762382744d680d2bbd"
)
WMAVOICE_SAMPLE: Final = FATESample(
    "wmavoice/streaming_CBR-7K.wma", "049a5a4c758b07b874af9a8a2473ff2a3cc8234f79e387dfd6daf6780a58c6d5"
)

# Each remux follows the vector it remuxes
VECTORS: Final = (
    Vector("wmav1.avi", "wmav1", 48_000, 2, 12, encoder_arguments=("-c:a", "wmav1", "-b:a", "96k")),
    Vector("wmav1.mkv", "wmav1", 48_000, 2, 12, remux_of="wmav1.avi"),
    Vector("wmav2.avi", "wmav2", 44_100, 2, 11, encoder_arguments=("-c:a", "wmav2", "-b:a", "128k")),
    Vector("wmav2.mkv", "wmav2", 44_100, 2, 11, remux_of="wmav2.avi"),
    # 5.1, two packets of 8192 bytes, which a WAVE_FORMAT_EXTENSIBLE header with its channel mask describes in Matroska
    Vector("wmapro-5.1.mkv", "wmapro", 48_000, 6, 2, fate_sample=WMAPRO_SAMPLE),
    # 16-bit, which the decoder writes as S16P
    Vector("wmalossless-16.mkv", "wmalossless", 44_100, 2, 2, fate_sample=WMALOSSLESS_16_SAMPLE),
    # 24-bit, which the decoder writes as S32P; the whole sample
    Vector("wmalossless-24.mkv", "wmalossless", 48_000, 2, 2, fate_sample=WMALOSSLESS_24_SAMPLE),
    # Mono at 8 kHz, which the decoder writes as packed float
    Vector("wmavoice.mkv", "wmavoice", 8_000, 1, 4, fate_sample=WMAVOICE_SAMPLE),
    # The WMA 2 packets beside H.264 video, each muxed from wmav2.avi, so the Matroska one has no CodecDelay either
    Vector("wmav2-h264.avi", "wmav2", 44_100, 2, 11, remux_of="wmav2.avi", with_video=True),
    Vector("wmav2-h264.mkv", "wmav2", 44_100, 2, 11, remux_of="wmav2.avi", with_video=True),
)


def parse_arguments(command_arguments: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Fail unless the committed vectors and known answers match a fresh run")
    parser.add_argument("--ffmpeg", help="The FFmpeg executable, ffmpeg on PATH by default")
    parser.add_argument("--ffprobe", help="The FFprobe executable, ffprobe on PATH by default")
    return parser.parse_args(command_arguments)


def download_FATE_sample(sample: FATESample, directory: Path) -> Path:
    """Downloads a FATE sample once into the directory, requiring its pinned SHA-256."""

    path = directory / Path(sample.path).name
    if not path.exists():
        content = read_FATE_sample(sample)
        digest = hashlib.sha256(content).hexdigest()
        if digest != sample.sha256:
            raise VectorGenerationError(f"FATE sample {sample.path} has SHA-256 {digest}, not {sample.sha256}")
        path.write_bytes(content)
    return path


def read_FATE_sample(sample: FATESample) -> bytes:
    """Reads a FATE sample's bytes, trying again after a failed connection or a timeout."""

    for attempt in range(1, DOWNLOAD_ATTEMPT_COUNT + 1):
        try:
            with urllib.request.urlopen(FATE_SUITE_URL + sample.path, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
                return response.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            if attempt == DOWNLOAD_ATTEMPT_COUNT:
                raise VectorGenerationError(f"FATE sample {sample.path} failed {DOWNLOAD_ATTEMPT_COUNT} downloads: {error}") from error
            time.sleep(DOWNLOAD_RETRY_DELAY_SECONDS * attempt)
    raise AssertionError("unreachable")


def get_media_arguments(vector: Vector, directory: Path) -> list[str]:
    """Returns FFmpeg's arguments that write a vector into the directory: an encode, or a remux with -c copy, beside an H.264 encode or alone."""

    output_arguments = [*BITEXACT_ARGUMENTS, "-f", "avi" if vector.file_name.endswith(".avi") else "matroska", str(directory / vector.file_name)]
    if vector.remux_of is not None and vector.with_video:
        return [
            "-f", "lavfi", "-i", VIDEO_SOURCE, "-i", str(directory / vector.remux_of), "-map", "0:v", "-map", "1:a",
            *VIDEO_ARGUMENTS, "-c:a", "copy", *output_arguments,
        ]
    if vector.remux_of is not None:
        return ["-i", str(directory / vector.remux_of), "-map", "0:a", "-c", "copy", *output_arguments]
    if vector.fate_sample is not None:
        source_path = download_FATE_sample(vector.fate_sample, directory)
        return ["-i", str(source_path), "-map", "0:a", "-c", "copy", "-frames:a", str(vector.packet_count), *output_arguments]
    source = TONE_SOURCE.format(rate=vector.sample_rate)
    return ["-f", "lavfi", "-i", source, *vector.encoder_arguments, *output_arguments]


def write_vector(tools: MediaTools, vector: Vector, directory: Path) -> Path:
    """Writes one vector into the directory with the pinned FFmpeg."""

    execute_tool(tools.FFmpeg_path, ["-hide_banner", "-loglevel", "error", "-y", *get_media_arguments(vector, directory)])
    return directory / vector.file_name


def read_packet_hashes(tools: MediaTools, path: Path) -> list[str]:
    """Returns the SHA-256 of each audio packet FFprobe reads from a file."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-select_streams", "a", "-show_data_hash", "SHA256",
        "-show_entries", "packet=data_hash", "-of", "json", str(path),
    ]))
    return [packet["data_hash"] for packet in probe["packets"]]


def verify_vector(tools: MediaTools, vector: Vector, path: Path) -> None:
    """Requires FFprobe to read the vector's audio stream with its codec, rate, channels, and packets, after its H.264 stream if it has one.

    A remux must carry its source's audio packets.
    """

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-count_packets",
        "-show_entries", "stream=codec_type,codec_name,sample_rate,channels,nb_read_packets", "-of", "json", str(path),
    ]))
    streams = probe["streams"]
    expected_types = ["video", "audio"] if vector.with_video else ["audio"]
    require_equal([stream["codec_type"] for stream in streams], expected_types, f"{vector.file_name} stream types")
    if vector.with_video:
        require_equal(streams[0]["codec_name"], "h264", f"{vector.file_name} video codec")
        require_equal(int(streams[0]["nb_read_packets"]), VIDEO_FRAME_COUNT, f"{vector.file_name} video packets")
    stream = streams[-1]
    require_equal(stream["codec_name"], vector.codec, f"{vector.file_name} codec")
    require_equal(int(stream["sample_rate"]), vector.sample_rate, f"{vector.file_name} sample rate")
    require_equal(stream["channels"], vector.channel_count, f"{vector.file_name} channels")
    require_equal(int(stream["nb_read_packets"]), vector.packet_count, f"{vector.file_name} packets")
    if vector.remux_of is not None:
        require_equal(read_packet_hashes(tools, path), read_packet_hashes(tools, path.with_name(vector.remux_of)), f"{vector.file_name} packets")


def read_decoded_frames(tools: MediaTools, vector: Vector, path: Path) -> tuple[int, str]:
    """Returns the frames FFmpeg decodes from a vector, its drain included, and the one layout FFprobe names for them."""

    probe = json.loads(execute_tool(tools.FFprobe_path, [
        "-hide_banner", "-loglevel", "error", "-show_frames", "-show_entries", "frame=nb_samples,channels,channel_layout",
        "-of", "json", str(path),
    ]))
    frame_count = sum(int(frame["nb_samples"]) for frame in probe["frames"])
    layouts = {(int(frame["channels"]), frame.get("channel_layout", "")) for frame in probe["frames"]}
    if frame_count == 0 or len(layouts) != 1:
        raise VectorGenerationError(f"{vector.file_name} decodes {frame_count} frames in the layouts {sorted(layouts)}")
    channel_count, layout = layouts.pop()
    require_equal(channel_count, vector.channel_count, f"{vector.file_name} decoded channels")
    return frame_count, layout


def get_channel_mask(vector: Vector, layout: str) -> int:
    """Returns the WAVE channel mask of a decoded layout FFprobe names, or of FFmpeg's default layout of the channel count for one without a mask."""

    if layout in NAMED_LAYOUT_MASKS:
        return NAMED_LAYOUT_MASKS[layout]
    if vector.channel_count in DEFAULT_LAYOUT_MASKS and layout in ("", "unknown", f"{vector.channel_count} channels"):
        return DEFAULT_LAYOUT_MASKS[vector.channel_count]
    raise VectorGenerationError(f"{vector.file_name} decodes in the layout {layout!r}, which has no mask here")


def create_known_answer(tools: MediaTools, vector: Vector, path: Path, directory: Path) -> dict[str, Any]:
    """Returns a vector's known answer: its decoded rate, channels, and channel mask, and the frame count and SHA-256 of FFmpeg's PCM."""

    frame_count, layout = read_decoded_frames(tools, vector, path)
    PCM_path = directory / f"{vector.file_name}.f32"
    execute_tool(tools.FFmpeg_path, [
        "-hide_banner", "-loglevel", "error", "-y", *REFERENCE_DECODER_OPTIONS, "-c:a", vector.codec, "-i", str(path),
        "-f", "f32le", str(PCM_path),
    ])
    PCM = PCM_path.read_bytes()
    require_equal(len(PCM), frame_count * vector.channel_count * FLOAT_BYTE_LENGTH, f"{vector.file_name} PCM bytes")
    return {
        "channelCount": vector.channel_count,
        "channelMask": get_channel_mask(vector, layout),
        "codec": vector.codec,
        "file": vector.file_name,
        "frameCount": frame_count,
        "pcmSHA256": hashlib.sha256(PCM).hexdigest(),
        "sampleRate": vector.sample_rate,
    }


def format_known_answers(known_answers: list[dict[str, Any]]) -> bytes:
    """Returns the known answers file: the FFmpeg build and decoder options, then each vector's answer."""

    document = {
        "decoderOptions": list(REFERENCE_DECODER_OPTIONS),
        "ffmpeg": REQUIRED_FFMPEG_VERSION,
        "vectors": known_answers,
    }
    return (json.dumps(document, indent=4) + "\n").encode("utf-8")


def main(command_arguments: Sequence[str] | None = None) -> int:
    arguments = parse_arguments(command_arguments)
    try:
        tools = MediaTools(resolve_FFmpeg_tool("ffmpeg", arguments.ffmpeg), resolve_FFmpeg_tool("ffprobe", arguments.ffprobe))
        check_toolchain(tools)
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            for vector in VECTORS:
                path = write_vector(tools, vector, directory)
                verify_vector(tools, vector, path)
                written = install_or_check_output(VECTOR_DIRECTORY / vector.file_name, path.read_bytes(), check=arguments.check)
                print(f"{'Wrote' if written else 'Matched'} {vector.file_name}")
            known_answers = [
                create_known_answer(tools, vector, VECTOR_DIRECTORY / vector.file_name, directory)
                for vector in VECTORS if not vector.with_video
            ]
            write_or_check_output(VECTOR_DIRECTORY / KNOWN_ANSWERS_FILE_NAME, format_known_answers(known_answers), check=arguments.check)
            print(f"{'Matched' if arguments.check else 'Wrote'} {KNOWN_ANSWERS_FILE_NAME}")
    except (GeneratedOutputError, OSError, ToolError, VectorGenerationError) as error:
        print(f"generate_wma_decoder_vectors: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
