#!/usr/bin/env python3
"""Generate deterministic synthetic TrueHD/MLP exact-capability vectors."""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from engine_layout import CODEC_VECTOR_ASSETS_DIRECTORY, layout_path, typescript_import_path
from generated_output import install_or_check_output, write_or_check_output


# The encoded source streams and the generated module share one folder
VECTOR_DIRECTORY = CODEC_VECTOR_ASSETS_DIRECTORY / "truehd"
OUTPUT_FILE = VECTOR_DIRECTORY / "TrueHDExactCapabilityVectors.ts"
VECTOR_DURATION_SECONDS = 0.05
VECTOR_PACKET_COUNT = 32
FNV1A_OFFSET_BASIS = 2_166_136_261
FNV1A_PRIME = 16_777_619


@dataclass(frozen=True)
class VectorDefinition:
    name: str
    codec: str
    channel_count: int
    channel_layout: str
    channel_mask: int
    sample_rate: int


VECTOR_DEFINITIONS = (
    VectorDefinition(
        name="truehd_stereo_24_48000",
        codec="truehd",
        channel_count=2,
        channel_layout="stereo",
        channel_mask=0x0003,
        sample_rate=48_000,
    ),
    VectorDefinition(
        name="truehd_51_side_24_96000",
        codec="truehd",
        channel_count=6,
        channel_layout="5.1(side)",
        channel_mask=0x060F,
        sample_rate=96_000,
    ),
    VectorDefinition(
        name="truehd_51_side_24_192000",
        codec="truehd",
        channel_count=6,
        channel_layout="5.1(side)",
        channel_mask=0x060F,
        sample_rate=192_000,
    ),
    VectorDefinition(
        name="mlp_stereo_24_48000",
        codec="mlp",
        channel_count=2,
        channel_layout="stereo",
        channel_mask=0x0003,
        sample_rate=48_000,
    ),
)


def require_executable(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"Required executable is unavailable: {name}")
    return executable


def create_channel_expression(channel_count: int) -> str:
    expressions: list[str] = []
    for channel_index in range(channel_count):
        frequency = 220 + 110 * channel_index
        amplitude = 0.0625 + 0.0078125 * channel_index
        expressions.append(f"{amplitude}*sin(2*PI*{frequency}*t)")
    return "|".join(expressions)


def generate_source(
    ffmpeg: str,
    definition: VectorDefinition,
    destination: Path,
) -> None:
    filter_expression = (
        f"aevalsrc={create_channel_expression(definition.channel_count)}:"
        f"s={definition.sample_rate}:d={VECTOR_DURATION_SECONDS}:"
        f"c={definition.channel_layout}"
    )
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            filter_expression,
            "-map",
            "0:a:0",
            "-c:a",
            definition.codec,
            "-strict",
            "-2",
            "-sample_fmt",
            "s32p",
            "-max_interval",
            "16",
            "-f",
            definition.codec,
            "-y",
            str(destination),
        ],
        check=True,
    )


def probe_json(ffprobe: str, codec: str, source: Path, section: str) -> list[dict[str, Any]]:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-f",
            codec,
            f"-show_{section}",
            "-print_format",
            "json",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(result.stdout)
    values = data.get(section)
    if not isinstance(values, list):
        raise RuntimeError(f"ffprobe did not return {section} for {source}")
    return values


def decode_reference_pcm(ffmpeg: str, codec: str, source: Path) -> bytes:
    result = subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            codec,
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-c:a",
            "pcm_s32le",
            "-f",
            "s32le",
            "-",
        ],
        check=True,
        capture_output=True,
    )
    return result.stdout


def fnv1a(data: bytes) -> int:
    fingerprint = FNV1A_OFFSET_BASIS
    for byte in data:
        fingerprint ^= byte
        fingerprint = (fingerprint * FNV1A_PRIME) & 0xFFFFFFFF
    return fingerprint


def microseconds_from_time(value: Any) -> int:
    if not isinstance(value, str):
        raise RuntimeError("ffprobe timestamp is unavailable")
    return round(float(value) * 1_000_000)


def create_vector_record(
    ffmpeg: str,
    ffprobe: str,
    definition: VectorDefinition,
    source: Path,
) -> dict[str, Any]:
    source_data = source.read_bytes()
    packets = probe_json(ffprobe, definition.codec, source, "packets")
    frames = probe_json(ffprobe, definition.codec, source, "frames")
    if len(packets) < VECTOR_PACKET_COUNT or len(frames) < VECTOR_PACKET_COUNT:
        raise RuntimeError(f"Vector {definition.name} has too few packets or frames")
    packets = packets[:VECTOR_PACKET_COUNT]
    frames = frames[:VECTOR_PACKET_COUNT]
    reference_pcm = decode_reference_pcm(ffmpeg, definition.codec, source)

    encoded_packets: list[str] = []
    expected_outputs: list[dict[str, int]] = []
    pcm_offset = 0
    for packet, frame in zip(packets, frames, strict=True):
        packet_position = int(packet["pos"])
        packet_size = int(packet["size"])
        frame_position = int(frame["pkt_pos"])
        if packet_position != frame_position:
            raise RuntimeError("TrueHD reference frame does not match its encoded packet")
        packet_data = source_data[packet_position:packet_position + packet_size]
        if len(packet_data) != packet_size:
            raise RuntimeError("TrueHD packet range exceeds its source vector")
        encoded_packets.append(base64.b64encode(packet_data).decode("ascii"))

        frame_count = int(frame["nb_samples"])
        pcm_byte_length = frame_count * definition.channel_count * 4
        frame_pcm = reference_pcm[pcm_offset:pcm_offset + pcm_byte_length]
        if len(frame_pcm) != pcm_byte_length:
            raise RuntimeError("Decoded TrueHD reference PCM is truncated")
        pcm_offset += pcm_byte_length
        expected_outputs.append(
            {
                "frameCount": frame_count,
                "mediaTimeMicroseconds": microseconds_from_time(frame["pts_time"]),
                "pcmFingerprint": fnv1a(frame_pcm),
            }
        )

    return {
        "accessUnitsBase64": encoded_packets,
        "bitsPerSample": 24,
        "channelCount": definition.channel_count,
        "channelMask": definition.channel_mask,
        "codec": definition.codec,
        "expectedOutputs": expected_outputs,
        "majorSyncRecoveryStartIndex": 1,
        "sampleRate": definition.sample_rate,
        "source": source.name,
    }


def format_typescript(vectors: list[dict[str, Any]]) -> str:
    definitions: list[str] = []
    for vector in vectors:
        access_units = ",\n".join(
            f"            '{access_unit}'"
            for access_unit in vector["accessUnitsBase64"]
        )
        expected_outputs = ",\n".join(
            "            Object.freeze({\n"
            f"                frameCount: {output['frameCount']},\n"
            "                mediaTimeMicroseconds: "
            f"{output['mediaTimeMicroseconds']},\n"
            f"                pcmFingerprint: {output['pcmFingerprint']}\n"
            "            })"
            for output in vector["expectedOutputs"]
        )
        definitions.append(
            "    Object.freeze({\n"
            "        accessUnitsBase64: Object.freeze([\n"
            f"{access_units}\n"
            "        ]),\n"
            f"        bitsPerSample: {vector['bitsPerSample']},\n"
            f"        channelCount: {vector['channelCount']},\n"
            f"        channelMask: {vector['channelMask']},\n"
            f"        codec: '{vector['codec']}',\n"
            "        expectedOutputs: Object.freeze([\n"
            f"{expected_outputs}\n"
            "        ]),\n"
            "        majorSyncRecoveryStartIndex: "
            f"{vector['majorSyncRecoveryStartIndex']},\n"
            f"        sampleRate: {vector['sampleRate']},\n"
            f"        source: '{vector['source']}'\n"
            "    })"
        )
    encoded_definitions = ",\n".join(definitions)
    generator_path = layout_path("codecVectorScriptsDirectory", Path(__file__).name)
    provenance_path = layout_path("testVectorsDirectory", "truehd", "PROVENANCE.txt")
    media_time_import = typescript_import_path("MediaTime", OUTPUT_FILE.parent)
    decoder_import = typescript_import_path("audio/decoders/TrueHDSoftwareAudioDecoder", OUTPUT_FILE.parent)
    return f"""// Generated by {generator_path}
// Sources are deterministic synthetic tones; see {provenance_path}

import type {{ Microseconds }} from '{media_time_import}';
import type {{ TrueHDDecoderCodec }} from '{decoder_import}';

export type TrueHDExactCapabilityExpectedOutput = Readonly<{{
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    pcmFingerprint: number
}}>;

export type TrueHDExactCapabilityVector = Readonly<{{
    accessUnits: readonly Uint8Array[]
    bitsPerSample: 24
    channelCount: 2 | 6
    channelMask: number
    codec: TrueHDDecoderCodec
    expectedOutputs: readonly TrueHDExactCapabilityExpectedOutput[]
    majorSyncRecoveryStartIndex: 1
    sampleRate: 48_000 | 96_000 | 192_000
    source: string
}}>;

type EncodedTrueHDExactCapabilityVector = Omit<
    TrueHDExactCapabilityVector,
    'accessUnits' | 'expectedOutputs'
> & Readonly<{{
    accessUnitsBase64: readonly string[]
    expectedOutputs: readonly Readonly<{{
        frameCount: number
        mediaTimeMicroseconds: number
        pcmFingerprint: number
    }}>[]
}}>;

const ENCODED_TRUEHD_EXACT_CAPABILITY_VECTORS = Object.freeze([
{encoded_definitions}
]) satisfies readonly EncodedTrueHDExactCapabilityVector[];

function decodeBase64(value: string): Uint8Array {{
    const decoded = globalThis.atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let byteIndex = 0; byteIndex < decoded.length; byteIndex += 1) {{
        bytes[byteIndex] = decoded.charCodeAt(byteIndex);
    }}
    return bytes;
}}

/** Creates isolated exact-output vectors for the pinned TrueHD/MLP decoder. */
export function createTrueHDExactCapabilityVectors(): readonly TrueHDExactCapabilityVector[] {{
    const vectors: TrueHDExactCapabilityVector[] = [];
    for (const vector of ENCODED_TRUEHD_EXACT_CAPABILITY_VECTORS) {{
        vectors.push(Object.freeze({{
            accessUnits: Object.freeze(vector.accessUnitsBase64.map(decodeBase64)),
            bitsPerSample: vector.bitsPerSample,
            channelCount: vector.channelCount,
            channelMask: vector.channelMask,
            codec: vector.codec,
            expectedOutputs: Object.freeze(vector.expectedOutputs.map(output => Object.freeze({{
                frameCount: output.frameCount,
                mediaTimeMicroseconds: output.mediaTimeMicroseconds as Microseconds,
                pcmFingerprint: output.pcmFingerprint
            }}))),
            majorSyncRecoveryStartIndex: vector.majorSyncRecoveryStartIndex,
            sampleRate: vector.sampleRate,
            source: vector.source
        }}));
    }}
    return Object.freeze(vectors);
}}
"""


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--regenerate-sources",
        action="store_true",
        help=(
            "Re-encode the source streams with FFmpeg and fail unless they match "
            "the committed sources; a missing source is installed, except with --check"
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if any committed output differs from the regenerated output",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_FILE,
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    ffmpeg = require_executable("ffmpeg")
    ffprobe = require_executable("ffprobe")

    vector_records: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="webgpu-truehd-vectors-") as temporary_directory:
        temporary_root = Path(temporary_directory)
        for definition in VECTOR_DEFINITIONS:
            source = VECTOR_DIRECTORY / f"{definition.name}.{definition.codec}"
            if arguments.regenerate_sources:
                generated_source = temporary_root / source.name
                generate_source(ffmpeg, definition, generated_source)
                # Another FFmpeg build may encode different bytes, so a re-encode never replaces a committed source
                install_or_check_output(
                    source,
                    generated_source.read_bytes(),
                    check=arguments.check,
                )
            if not source.is_file():
                raise RuntimeError(
                    f"Missing {source}; rerun with --regenerate-sources"
                )
            vector_records.append(
                create_vector_record(ffmpeg, ffprobe, definition, source)
            )

    output_path = arguments.output.resolve()
    write_or_check_output(
        output_path,
        format_typescript(vector_records).encode("ascii"),
        check=arguments.check,
    )
    action = "Verified" if arguments.check else "Generated"
    print(
        f"{action} {len(vector_records)} TrueHD/MLP exact capability vectors "
        f"in {output_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
