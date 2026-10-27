"""Rewrites an FFmpeg-muxed AVI into the layouts FFmpeg's muxer does not write for a short file.

- split_into_OpenDML_RIFF_lists: the OpenDML layout FFmpeg's muxer writes past 1 GiB, with a smaller RIFF list limit.
  The first RIFF list keeps the header and an idx1 index of its own chunks; AVIX RIFF lists follow; every RIFF list's movi list ends in one standard index (ix##) per stream, and each stream's super index (indx) locates them.
- pack_DivX_B_frames: the packed bitstream DivX 5 writes, which puts each B-VOP after its reference VOP in one chunk.
  A B-VOP after the first of a run takes a chunk of its own, an N-VOP (a VOP that is not coded) holds the slot the packed B-VOP left, and DivX user data ending in 'p' marks the stream as packed.

Both keep every chunk's bytes and order otherwise, so FFmpeg reads the same packets from the rewrite: from the OpenDML file through its OpenDML indexes, and from the packed file through its mpeg4_unpack_bframes bitstream filter.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Final, Sequence

from media_tools import VectorGenerationError, pack_bit_fields


CHUNK_HEADER_SIZE: Final = 8
RIFF_FORM_TYPE_SIZE: Final = 4
AVIIF_KEYFRAME: Final = 0x10
# The standard index entry bit that marks a chunk that is not a key frame
STANDARD_INDEX_DELTA_FRAME: Final = 0x80000000
STANDARD_INDEX_HEADER_SIZE: Final = 24
SUPER_INDEX_HEADER_SIZE: Final = 24
SUPER_INDEX_ENTRY_SIZE: Final = 16
# FFmpeg reserves its super index in a JUNK chunk that starts with wLongsPerEntry 4, bIndexSubType 0, and bIndexType 0
SUPER_INDEX_RESERVATION_PREFIX: Final = b"\x04\x00\x00\x00"
# Where avih holds dwTotalFrames, which counts the first RIFF list's video frames in an OpenDML file
MAIN_HEADER_TOTAL_FRAMES_OFFSET: Final = 16
STREAM_HEADER_SAMPLE_SIZE_OFFSET: Final = 44
# MPEG-4 Part 2 start codes
START_CODE_PREFIX: Final = b"\x00\x00\x01"
VOP_START_CODE: Final = b"\x00\x00\x01\xb6"
USER_DATA_START_CODE: Final = b"\x00\x00\x01\xb2"
VIDEO_OBJECT_LAYER_START_CODES: Final = range(0x20, 0x30)
VOP_CODING_TYPE_P: Final = 1
VOP_CODING_TYPE_B: Final = 2
# The user data DivX 5.0.3 writes; its final 'p' marks a packed bitstream
DIVX_PACKED_USER_DATA: Final = b"DivX503b1393p"
EXTENDED_PAR_ASPECT_RATIO_INFO: Final = 0xF
GRAYSCALE_SHAPE: Final = 3
VBV_PARAMETER_BIT_COUNT: Final = 79


@dataclass(frozen=True)
class Chunk:
    """A RIFF chunk: its fourcc, the position of its data, and its data size."""

    fourcc: bytes
    data_position: int
    size: int


@dataclass(frozen=True)
class MovieChunk:
    """A movi chunk with its idx1 flags."""

    fourcc: bytes
    data: bytes
    flags: int


def read_chunks(data: bytes, start: int, end: int) -> list[Chunk]:
    """Returns the chunks from start to end, each padded to an even size."""

    chunks: list[Chunk] = []
    position = start
    while position + CHUNK_HEADER_SIZE <= end:
        fourcc = data[position:position + 4]
        size = struct.unpack_from("<I", data, position + 4)[0]
        chunks.append(Chunk(fourcc, position + CHUNK_HEADER_SIZE, size))
        position += CHUNK_HEADER_SIZE + size + (size & 1)
    return chunks


def find_list(data: bytes, chunks: Sequence[Chunk], list_type: bytes) -> Chunk:
    """Returns the LIST chunk of a list type."""

    for chunk in chunks:
        if chunk.fourcc == b"LIST" and data[chunk.data_position:chunk.data_position + 4] == list_type:
            return chunk
    raise VectorGenerationError(f"The AVI holds no {list_type.decode('latin-1')} list")


def find_chunk(chunks: Sequence[Chunk], fourcc: bytes) -> Chunk:
    """Returns the first chunk of a fourcc."""

    for chunk in chunks:
        if chunk.fourcc == fourcc:
            return chunk
    raise VectorGenerationError(f"The AVI holds no {fourcc.decode('latin-1')} chunk")


def read_RIFF_children(data: bytes) -> list[Chunk]:
    """Returns the chunks of an AVI's only RIFF list."""

    if data[0:4] != b"RIFF" or data[8:12] != b"AVI ":
        raise VectorGenerationError("The file is not an AVI")
    RIFF_size = struct.unpack_from("<I", data, 4)[0]
    if CHUNK_HEADER_SIZE + RIFF_size != len(data):
        raise VectorGenerationError("The AVI is not one RIFF list")
    return read_chunks(data, CHUNK_HEADER_SIZE + RIFF_FORM_TYPE_SIZE, len(data))


def read_movie_chunks(data: bytes, children: Sequence[Chunk]) -> list[MovieChunk]:
    """Returns the movi list's chunks with the flags idx1 gives each, which lists them in order."""

    movie_list = find_list(data, children, b"movi")
    chunks = read_chunks(data, movie_list.data_position + 4, movie_list.data_position + movie_list.size)
    index = find_chunk(children, b"idx1")
    entries = [struct.unpack_from("<4sIII", data, index.data_position + offset) for offset in range(0, index.size, 16)]
    if [entry[0] for entry in entries] != [chunk.fourcc for chunk in chunks]:
        raise VectorGenerationError("idx1 does not list the movi chunks in order")
    return [
        MovieChunk(chunk.fourcc, data[chunk.data_position:chunk.data_position + chunk.size], entry[1])
        for chunk, entry in zip(chunks, entries)
    ]


@dataclass
class StreamLayout:
    """A stream's super index reservation in the header, and what the rewrite adds to it."""

    chunk_id: bytes
    super_index_position: int
    sample_size: int
    super_index_entries: list[tuple[int, int, int]]


class OpenDMLWriter:
    """Writes movi chunks as FFmpeg's muxer does, opening an AVIX RIFF list once a RIFF list outgrows its limit."""

    def __init__(self, header: bytearray, streams: list[StreamLayout], maximum_RIFF_size: int) -> None:
        self.output = bytearray(b"RIFF\x00\x00\x00\x00AVI ")
        self.output += header
        self.streams = streams
        self.maximum_RIFF_size = maximum_RIFF_size
        self.RIFF_start = 0
        self.RIFF_count = 1
        self.movie_list = self.start_list(b"movi")
        self.entries: list[list[tuple[int, int, int]]] = [[] for _ in streams]
        self.first_RIFF_index: list[tuple[bytes, int, int, int]] = []
        self.first_RIFF_video_chunk_count = 0

    def start_list(self, list_type: bytes) -> int:
        """Starts a LIST and returns the position of its type, from which its chunk offsets count."""

        self.output += b"LIST\x00\x00\x00\x00" + list_type
        return len(self.output) - RIFF_FORM_TYPE_SIZE

    def end_chunk(self, data_position: int) -> None:
        """Writes the size of the chunk or list whose data starts at data_position."""

        struct.pack_into("<I", self.output, data_position - 4, len(self.output) - data_position)

    def write_chunk(self, chunk: MovieChunk) -> None:
        if len(self.output) - self.RIFF_start > self.maximum_RIFF_size:
            self.start_AVIX_RIFF_list()
        stream_number = int(chunk.fourcc[:2])
        relative_position = len(self.output) - self.movie_list
        self.entries[stream_number].append((relative_position, len(chunk.data), chunk.flags))
        if self.RIFF_count == 1:
            self.first_RIFF_index.append((chunk.fourcc, chunk.flags, relative_position, len(chunk.data)))
            if chunk.fourcc.endswith(b"dc"):
                self.first_RIFF_video_chunk_count += 1
        self.output += chunk.fourcc + struct.pack("<I", len(chunk.data)) + chunk.data
        if len(chunk.data) & 1:
            self.output += b"\x00"

    def write_standard_indexes(self) -> None:
        """Ends the movi list with each stream's ix## chunk, and adds it to the stream's super index."""

        for stream_number, (stream, entries) in enumerate(zip(self.streams, self.entries)):
            position = len(self.output)
            self.output += b"ix%02d" % stream_number
            self.output += struct.pack("<IHBBI4sQI", len(entries) * 8 + STANDARD_INDEX_HEADER_SIZE, 2, 0, 1, len(entries), stream.chunk_id, self.movie_list, 0)
            for relative_position, size, flags in entries:
                self.output += struct.pack("<II", relative_position + CHUNK_HEADER_SIZE, size | (0 if flags & AVIIF_KEYFRAME else STANDARD_INDEX_DELTA_FRAME))
            # dwDuration counts chunks, or for a stream with a sample size its samples
            duration = sum(size for _, size, _ in entries) // stream.sample_size if stream.sample_size else len(entries)
            stream.super_index_entries.append((position, len(self.output) - position, duration))
            entries.clear()

    def write_first_RIFF_index(self) -> None:
        index_position = len(self.output) + CHUNK_HEADER_SIZE
        self.output += b"idx1\x00\x00\x00\x00"
        for fourcc, flags, relative_position, size in self.first_RIFF_index:
            self.output += struct.pack("<4sIII", fourcc, flags, relative_position, size)
        self.end_chunk(index_position)

    def end_RIFF_list(self) -> None:
        self.write_standard_indexes()
        self.end_chunk(self.movie_list)
        if self.RIFF_count == 1:
            self.write_first_RIFF_index()
        self.end_chunk(self.RIFF_start + CHUNK_HEADER_SIZE)

    def start_AVIX_RIFF_list(self) -> None:
        self.end_RIFF_list()
        self.RIFF_count += 1
        self.RIFF_start = len(self.output)
        self.output += b"RIFF\x00\x00\x00\x00AVIX"
        self.movie_list = self.start_list(b"movi")

    def finish(self) -> bytes:
        self.end_RIFF_list()
        if self.RIFF_count == 1:
            raise VectorGenerationError("The chunks fit one RIFF list; lower the RIFF list limit")
        return bytes(self.output)


def find_stream_layouts(data: bytes, children: Sequence[Chunk], header_start: int) -> list[StreamLayout]:
    """Returns each stream's chunk ID, sample size, and super index reservation, relative to the header's start."""

    header_list = find_list(data, children, b"hdrl")
    streams: list[StreamLayout] = []
    for chunk in read_chunks(data, header_list.data_position + 4, header_list.data_position + header_list.size):
        if chunk.fourcc != b"LIST" or data[chunk.data_position:chunk.data_position + 4] != b"strl":
            continue
        stream_chunks = read_chunks(data, chunk.data_position + 4, chunk.data_position + chunk.size)
        stream_header = find_chunk(stream_chunks, b"strh")
        sample_size = struct.unpack_from("<I", data, stream_header.data_position + STREAM_HEADER_SAMPLE_SIZE_OFFSET)[0]
        reservation = next(
            (stream_chunk for stream_chunk in stream_chunks
             if stream_chunk.fourcc == b"JUNK" and data[stream_chunk.data_position:stream_chunk.data_position + 4] == SUPER_INDEX_RESERVATION_PREFIX),
            None,
        )
        if reservation is None:
            raise VectorGenerationError("A stream list holds no super index reservation")
        chunk_id = data[reservation.data_position + 8:reservation.data_position + 12]
        streams.append(StreamLayout(chunk_id, reservation.data_position - header_start, sample_size, []))
    return streams


def patch_OpenDML_header(header: bytearray, streams: Sequence[StreamLayout], total_frames: int, first_RIFF_frames: int) -> None:
    """Turns the header's reservations into the super indexes and the odml list, as FFmpeg's muxer does at its end."""

    for stream in streams:
        position = stream.super_index_position
        header[position - CHUNK_HEADER_SIZE:position - 4] = b"indx"
        struct.pack_into("<I", header, position + 4, len(stream.super_index_entries))
        for entry_number, (offset, size, duration) in enumerate(stream.super_index_entries):
            struct.pack_into("<QII", header, position + SUPER_INDEX_HEADER_SIZE + entry_number * SUPER_INDEX_ENTRY_SIZE, offset, size, duration)
    odml_position = header.find(b"odmldmlh")
    if odml_position < CHUNK_HEADER_SIZE or header[odml_position - CHUNK_HEADER_SIZE:odml_position - 4] != b"JUNK":
        raise VectorGenerationError("The header holds no odml reservation")
    header[odml_position - CHUNK_HEADER_SIZE:odml_position - 4] = b"LIST"
    struct.pack_into("<I", header, odml_position + 12, total_frames)
    main_header_position = header.find(b"avih") + CHUNK_HEADER_SIZE
    struct.pack_into("<I", header, main_header_position + MAIN_HEADER_TOTAL_FRAMES_OFFSET, first_RIFF_frames)


def split_into_OpenDML_RIFF_lists(data: bytes, maximum_RIFF_size: int) -> bytes:
    """Rewrites a one-RIFF FFmpeg AVI as FFmpeg's muxer writes an OpenDML file, with a RIFF list limit of maximum_RIFF_size bytes."""

    children = read_RIFF_children(data)
    movie_list = find_list(data, children, b"movi")
    header_start = CHUNK_HEADER_SIZE + RIFF_FORM_TYPE_SIZE
    header = bytearray(data[header_start:movie_list.data_position - CHUNK_HEADER_SIZE])
    streams = find_stream_layouts(data, children, header_start)
    movie_chunks = read_movie_chunks(data, children)

    writer = OpenDMLWriter(header, streams, maximum_RIFF_size)
    for chunk in movie_chunks:
        writer.write_chunk(chunk)
    output = bytearray(writer.finish())
    header_view = output[header_start:header_start + len(header)]
    total_frames = sum(1 for chunk in movie_chunks if chunk.fourcc.endswith(b"dc"))
    patch_OpenDML_header(header_view, streams, total_frames, writer.first_RIFF_video_chunk_count)
    output[header_start:header_start + len(header)] = header_view
    return bytes(output)


class BitReader:
    """Reads bits most significant first."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.position = 0

    def read(self, bit_count: int) -> int:
        value = 0
        for _ in range(bit_count):
            byte = self.data[self.position >> 3]
            value = (value << 1) | ((byte >> (7 - (self.position & 7))) & 1)
            self.position += 1
        return value


def read_VOP_time_increment_bit_count(chunk: bytes) -> int:
    """Returns the bits of vop_time_increment, from the video object layer header a key frame chunk carries."""

    position = chunk.find(START_CODE_PREFIX)
    while position >= 0 and chunk[position + 3] not in VIDEO_OBJECT_LAYER_START_CODES:
        position = chunk.find(START_CODE_PREFIX, position + 3)
    if position < 0:
        raise VectorGenerationError("The first chunk carries no video object layer header")
    reader = BitReader(chunk[position + 4:])
    reader.read(1 + 8)  # random_accessible_vol, video_object_type_indication
    verid = 1
    if reader.read(1):  # is_object_layer_identifier
        verid = reader.read(4)
        reader.read(3)
    if reader.read(4) == EXTENDED_PAR_ASPECT_RATIO_INFO:
        reader.read(16)
    if reader.read(1):  # vol_control_parameters
        reader.read(2 + 1)
        if reader.read(1):
            reader.read(VBV_PARAMETER_BIT_COUNT)
    if reader.read(2) == GRAYSCALE_SHAPE and verid != 1:
        reader.read(4)
    reader.read(1)
    resolution = reader.read(16)
    return max(1, (resolution - 1).bit_length())


def create_N_VOP(time_increment_bit_count: int) -> bytes:
    """Returns a P-VOP that is not coded, which holds a packed B-VOP's slot."""

    return VOP_START_CODE + pack_bit_fields(
        (
            (VOP_CODING_TYPE_P, 2),
            (0, 1),  # modulo_time_base
            (1, 1),
            (0, time_increment_bit_count),
            (1, 1),
            (0, 1),  # vop_coded
            (0, 1),  # stuffing starts with a zero bit, then ones to the byte boundary
        ),
        padding_bit=1,
    )


def get_VOP_coding_type(chunk: bytes) -> int | None:
    position = chunk.find(VOP_START_CODE)
    return None if position < 0 else chunk[position + len(VOP_START_CODE)] >> 6


def mark_packed(chunk: bytes) -> bytes:
    """Puts the packed bitstream's DivX user data before the VOP of a chunk that carries a video object layer header."""

    position = chunk.find(VOP_START_CODE)
    return chunk[:position] + USER_DATA_START_CODE + DIVX_PACKED_USER_DATA + chunk[position:]


def pack_DivX_B_frames(data: bytes) -> bytes:
    """Rewrites a one-RIFF FFmpeg AVI of MPEG-4 Part 2 with B-frames as the packed bitstream DivX 5 writes.

    Each reference VOP followed by B-VOPs takes the first B-VOP into its chunk, each further B-VOP keeps a chunk, and an N-VOP chunk follows the run, so the chunk count stays.
    Every chunk with a video object layer header gains the packed user data, and idx1 is rewritten for the new sizes.
    """

    children = read_RIFF_children(data)
    movie_chunks = read_movie_chunks(data, children)
    video_chunks = [chunk for chunk in movie_chunks if chunk.fourcc.endswith(b"dc")]
    time_increment_bit_count = read_VOP_time_increment_bit_count(video_chunks[0].data)
    N_VOP = create_N_VOP(time_increment_bit_count)

    packed_video: list[MovieChunk] = []
    pending_B_VOP_count = 0
    for chunk in video_chunks:
        chunk_data = mark_packed(chunk.data) if chunk.flags & AVIIF_KEYFRAME else chunk.data
        if get_VOP_coding_type(chunk.data) == VOP_CODING_TYPE_B:
            if pending_B_VOP_count == 0 and packed_video:
                reference = packed_video[-1]
                packed_video[-1] = MovieChunk(reference.fourcc, reference.data + chunk_data, reference.flags)
            else:
                packed_video.append(MovieChunk(chunk.fourcc, chunk_data, chunk.flags))
            pending_B_VOP_count += 1
            continue
        if pending_B_VOP_count:
            packed_video.append(MovieChunk(chunk.fourcc, N_VOP, 0))
            pending_B_VOP_count = 0
        packed_video.append(MovieChunk(chunk.fourcc, chunk_data, chunk.flags))
    if pending_B_VOP_count:
        packed_video.append(MovieChunk(video_chunks[-1].fourcc, N_VOP, 0))
    if len(packed_video) != len(video_chunks):
        raise VectorGenerationError("Packing changed the video chunk count")

    # The packed video chunks take the video chunks' places among the audio chunks
    packed_iterator = iter(packed_video)
    rewritten = [next(packed_iterator) if chunk.fourcc.endswith(b"dc") else chunk for chunk in movie_chunks]
    return rewrite_movie_list(data, children, rewritten)


def rewrite_movie_list(data: bytes, children: Sequence[Chunk], movie_chunks: Sequence[MovieChunk]) -> bytes:
    """Returns the AVI with new movi chunks and an idx1 index that lists them, keeping everything before movi."""

    movie_list = find_list(data, children, b"movi")
    output = bytearray(data[:movie_list.data_position - CHUNK_HEADER_SIZE])
    output += b"LIST\x00\x00\x00\x00movi"
    movie_list_position = len(output) - RIFF_FORM_TYPE_SIZE
    index = bytearray()
    for chunk in movie_chunks:
        index += struct.pack("<4sIII", chunk.fourcc, chunk.flags, len(output) - movie_list_position, len(chunk.data))
        output += chunk.fourcc + struct.pack("<I", len(chunk.data)) + chunk.data
        if len(chunk.data) & 1:
            output += b"\x00"
    struct.pack_into("<I", output, movie_list_position - 4, len(output) - movie_list_position)
    output += b"idx1" + struct.pack("<I", len(index)) + index
    struct.pack_into("<I", output, 4, len(output) - CHUNK_HEADER_SIZE)
    return bytes(output)
