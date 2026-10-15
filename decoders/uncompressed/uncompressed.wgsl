//! id: uncompressed
//! name: Uncompressed planar
//! decoder: video
//! accepts: codec in [uncompressed], stream.width <= 4096, stream.height <= 2304
//! output: I420, I420P10, I420P12, I422, I422P10, I422P12, I444, I444P10, I444P12
//! references: 0
//! reorder: 0
//! packet: 54 MiB
//! error: 1, packetSize
//! dispatch: copyPlanes, ceil(stream.width * output.bytesPerSample / 256), stream.height, 3

// The smallest complete video decoder, and a template for new ones: each packet is one uncompressed planar frame, which it copies into the output slot.
// A packet holds the planes in order, luma then the two chroma planes, rows tightly packed and 16-bit samples little-endian,
// as FFmpeg's rawvideo stores yuv420p and yuv420p10le.
// No demuxer maps a track to the uncompressed codec, so it decodes only the packets a test or a tool hands it.
// One invocation writes one output word, a workgroup covers 64 words of one row, and each plane takes its own z.

const PACKET_SIZE_ERROR: u32 = 1u;
const ERROR_CODE_SHIFT: u32 = 24u;

// The packet byte offset of a plane: the packed planes before it
fn getPacketPlaneOffset(planeIndex: u32) -> u32 {
    var byteOffset = 0u;
    for (var earlierPlaneIndex = 0u; earlierPlaneIndex < planeIndex; earlierPlaneIndex += 1u) {
        let earlierPlane = stream.planes[earlierPlaneIndex];
        byteOffset += earlierPlane.width * earlierPlane.height * SAMPLE_BYTES;
    }
    return byteOffset;
}

@compute @workgroup_size(64)
fn copyPlanes(@builtin(global_invocation_id) invocation: vec3u) {
    let expectedByteLength = getPacketPlaneOffset(stream.planeCount);
    if (packet.byteLength != expectedByteLength) {
        reportDecodeError((PACKET_SIZE_ERROR << ERROR_CODE_SHIFT) | min(packet.byteLength, (1u << ERROR_CODE_SHIFT) - 1u));
        return;
    }
    let planeIndex = invocation.z;
    let plane = stream.planes[planeIndex];
    let firstSample = invocation.x * SAMPLES_PER_WORD;
    let row = invocation.y;
    if (firstSample >= plane.width || row >= plane.height) {
        return;
    }
    let rowStart = getPacketPlaneOffset(planeIndex) + row * plane.width * SAMPLE_BYTES;
    if (SAMPLE_BYTES == 1u) {
        var samples = vec4u(0u);
        for (var lane = 0u; lane < 4u; lane += 1u) {
            if (firstSample + lane < plane.width) {
                samples[lane] = readPacketByte(rowStart + firstSample + lane);
            }
        }
        writeOutputSamples8(planeIndex, firstSample, row, samples);
        return;
    }
    var samples = vec2u(0u);
    for (var lane = 0u; lane < 2u; lane += 1u) {
        if (firstSample + lane < plane.width) {
            let byteIndex = rowStart + (firstSample + lane) * 2u;
            samples[lane] = readPacketByte(byteIndex) | (readPacketByte(byteIndex + 1u) << 8u);
        }
    }
    writeOutputSamples16(planeIndex, firstSample, row, samples);
}
