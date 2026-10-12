// The proof decoder of the GPU decode route: each packet is one uncompressed planar frame, which it copies into the output slot.
// A packet holds the planes in order, luma then the two chroma planes, rows tightly packed and 16-bit samples little-endian, as FFmpeg's rawvideo stores yuv420p and yuv420p10le.
// It exercises the packet ring, the dispatch sequence, slots, and presentation order without any codec of its own.
import { BYTES_PER_WORD } from '../../../presentation/WebGPUConstants';
import { getGPUDecoderFormatFacts, GPU_DECODER_OUTPUT_PLANE_COUNT, type GPUDecoderOutputFormat } from '../GPUDecodeFormats';
import { MEBIBYTE } from '../GPUDecodeLimits';

/** The Matroska codec ID of uncompressed video. */
export const UNCOMPRESSED_PLANAR_CODEC_IDENTIFIER = 'V_UNCOMPRESSED';

/** The largest coded width the proof decoder accepts. */
export const UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH = 4096;

/** The largest coded height the proof decoder accepts. */
export const UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT = 2304;

/** The error the decoder reports for a packet that is not exactly one frame of its format and the stream's size. */
export const UNCOMPRESSED_PLANAR_PACKET_SIZE_ERROR = 1;

const COPY_WORKGROUP_SIZE = 64;

/** Returns the bytes of one packed frame of a format and size. */
export function getUncompressedPlanarFrameByteLength(format: GPUDecoderOutputFormat, width: number, height: number): number {
    const formatFacts = getGPUDecoderFormatFacts(format);
    const chromaSampleCount = Math.ceil(width / formatFacts.chromaWidthDivisor) * Math.ceil(height / formatFacts.chromaHeightDivisor);
    return (width * height + 2 * chromaSampleCount) * formatFacts.bytesPerSample;
}

function createCopySamplesWGSL(bytesPerSample: 1 | 2): string {
    switch (bytesPerSample) {
        case 1:
            return `    let rowStart = getPacketPlaneOffset(planeIndex) + row * plane.width;
    var samples = vec4u(0u);
    for (var lane = 0u; lane < 4u; lane += 1u) {
        if (firstSample + lane < plane.width) {
            samples[lane] = readPacketByte(rowStart + firstSample + lane);
        }
    }
    writeOutputSamples8(planeIndex, firstSample, row, samples);`;
        case 2:
            return `    let rowStart = getPacketPlaneOffset(planeIndex) + row * plane.width * 2u;
    var samples = vec2u(0u);
    for (var lane = 0u; lane < 2u; lane += 1u) {
        if (firstSample + lane < plane.width) {
            let byteIndex = rowStart + (firstSample + lane) * 2u;
            samples[lane] = readPacketByte(byteIndex) | (readPacketByte(byteIndex + 1u) << 8u);
        }
    }
    writeOutputSamples16(planeIndex, firstSample, row, samples);`;
    }
}

/**
 * Returns the proof decoder's source for one planar format.
 * It declares no conformance vector, so it reports as unverified until the engine has a vector check.
 */
export function createUncompressedPlanarDecoderSource(format: GPUDecoderOutputFormat): string {
    const formatFacts = getGPUDecoderFormatFacts(format);
    const samplesPerWord = BYTES_PER_WORD / formatFacts.bytesPerSample;
    const samplesPerWorkgroupRow = COPY_WORKGROUP_SIZE * samplesPerWord;
    const largestFrameByteLength = getUncompressedPlanarFrameByteLength(
        format,
        UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH,
        UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT
    );
    const header = [
        `//! name: Uncompressed planar ${format}`,
        '//! decoder: video',
        `//! accepts: codec in [${UNCOMPRESSED_PLANAR_CODEC_IDENTIFIER}], stream.width <= ${UNCOMPRESSED_PLANAR_MAXIMUM_WIDTH}, `
            + `stream.height <= ${UNCOMPRESSED_PLANAR_MAXIMUM_HEIGHT}, stream.bitDepth == ${formatFacts.bitDepth}`,
        `//! output: ${format}`,
        '//! references: 0',
        '//! reorder: 0',
        `//! packet: ${Math.ceil(largestFrameByteLength / MEBIBYTE)} MiB`,
        // One invocation per output word, one row per workgroup row, and one plane per z
        `//! dispatch: copyPlanes, ceil(stream.width / ${samplesPerWorkgroupRow}), stream.height, ${GPU_DECODER_OUTPUT_PLANE_COUNT}`
    ];
    return `${header.join('\n')}

// The packet byte offset of a plane: the packed planes before it
fn getPacketPlaneOffset(planeIndex: u32) -> u32 {
    var byteOffset = 0u;
    for (var earlierPlaneIndex = 0u; earlierPlaneIndex < planeIndex; earlierPlaneIndex += 1u) {
        let earlierPlane = stream.planes[earlierPlaneIndex];
        byteOffset += earlierPlane.width * earlierPlane.height * stream.bytesPerSample;
    }
    return byteOffset;
}

@compute @workgroup_size(${COPY_WORKGROUP_SIZE})
fn copyPlanes(@builtin(global_invocation_id) invocation: vec3u) {
    if (packet.byteLength != getPacketPlaneOffset(stream.planeCount)) {
        reportDecodeError(${UNCOMPRESSED_PLANAR_PACKET_SIZE_ERROR}u);
        return;
    }
    let planeIndex = invocation.z;
    let plane = stream.planes[planeIndex];
    let firstSample = invocation.x * ${samplesPerWord}u;
    let row = invocation.y;
    if (firstSample >= plane.width || row >= plane.height) {
        return;
    }
${createCopySamplesWGSL(formatFacts.bytesPerSample)}
}
`;
}
