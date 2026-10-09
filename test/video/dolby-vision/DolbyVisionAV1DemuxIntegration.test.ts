// @vitest-environment node

import { createDolbyVisionAV1ITUTT35Payload, DOLBY_VISION_ITUT_T35_HEADER } from '../../helpers/dolbyVisionAV1ITUTT35Payload';
import { CODEC_VECTOR_ASSETS_DIRECTORY, ENGINE_ROOT, WASM_OUTPUT_DIRECTORY } from '../../helpers/enginePaths';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type EncodedPacket
} from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import { splitDolbyVisionAV1TemporalUnit } from 'webgpu-player/video/dolby-vision/DolbyVisionAV1Splitter';
import { DolbyVisionAV1EncodedMetadataQueue } from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadata';
import { assignISOBaseMediaDolbyVisionSampleEntryCodec } from 'webgpu-player/video/dolby-vision/ISOBaseMediaDolbyVisionSampleEntry';
import DolbyVisionRPUParser, {
    decodeDolbyVisionRPUSnapshot
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParserSession';

type DolbyVisionAV1VectorFrame = {
    /** SHA-256 of the T.35 payload from its country code to the end of its metadata OBU payload */
    ITUTT35PayloadSHA256: string
    keyFrame: boolean
    sourceRPUFileName: string
};

type DolbyVisionAV1Vector = {
    container: 'matroska' | 'mp4'
    fileName: string
    frameCount: number
    frames: readonly DolbyVisionAV1VectorFrame[]
    height: number
    sampleEntry: 'av01' | 'dav1' | null
    subProfile: string
    width: number
};

type DolbyVisionAV1Expectations = {
    sourceRPUDirectory: string
    vectors: readonly DolbyVisionAV1Vector[]
};

type TestOBU = {
    data: Uint8Array
    payload: Uint8Array
    type: number
};

const VECTOR_DIRECTORY = resolve(CODEC_VECTOR_ASSETS_DIRECTORY, 'dolby-vision-av1');
// Written by scripts/codec_vector_assets/generate_dolby_vision_AV1_vectors.py
const EXPECTATIONS = JSON.parse(
    readFileSync(resolve(VECTOR_DIRECTORY, 'expectations.json'), 'utf8')
) as DolbyVisionAV1Expectations;
const VECTORS = EXPECTATIONS.vectors;
// The generator records the RPU folder from tools/constants.json, relative to the engine root
const RPU_SOURCE_DIRECTORY = resolve(ENGINE_ROOT, EXPECTATIONS.sourceRPUDirectory);
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(
    resolve(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm')
));
// The worker's owned AV1 path reads packets with the same options
const OWNED_AV1_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
// The crate infers the RPU profile: 10.0 RPUs code like Profile 5, every other sub-profile like Profile 8
const PROFILE_10_0_RPU_PROFILE = 5;
const PROFILE_10_RPU_PROFILE = 8;
const DOLBY_VISION_AV1_SAMPLE_ENTRY_TYPE = 'dav1';
const MATROSKA_AV1_CODEC_ID = 'V_AV1';
// OBU syntax from the AV1 specification
const OBU_TYPE_SEQUENCE_HEADER = 1;
const OBU_TYPE_METADATA = 5;
const OBU_TYPE_FRAME = 6;
const OBU_TYPE_SHIFT = 3;
const OBU_TYPE_MASK = 0x0F;
const OBU_EXTENSION_FLAG = 0x04;
const OBU_HAS_SIZE_FIELD_FLAG = 0x02;
const LEB128_VALUE_MASK = 0x7F;
const LEB128_CONTINUATION_FLAG = 0x80;
const LEB128_VALUE_BIT_COUNT = 7;
// trailing_bits() after a byte-aligned OBU payload
const OBU_TRAILING_BITS_BYTE = 0x80;
const METADATA_TYPE_ITUT_T35 = 4;
// The ITU-T T.35 metadata_type, then the Dolby Vision T.35 header
const DOLBY_VISION_METADATA_PREFIX: readonly number[] = [ METADATA_TYPE_ITUT_T35, ...DOLBY_VISION_ITUT_T35_HEADER ];

async function createParser(): Promise<DolbyVisionRPUParser> {
    return DolbyVisionRPUParser.create('local-parser.wasm', {
        loadInstance: async (): Promise<WebAssembly.Instance> => {
            const result = await WebAssembly.instantiate(PARSER_WASM_BYTES, {});
            return result.instance;
        }
    });
}

function createParserSession(): DolbyVisionRPUParserSession {
    return DolbyVisionRPUParserSession.create('local-parser.wasm', {
        createParser
    });
}

function readSourceRPU(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(RPU_SOURCE_DIRECTORY, fileName)));
}

/** Returns the packed snapshot of the HEVC parse of each source RPU of a vector, each in a fresh parser. */
async function parseSourceRPUsAsHEVC(vector: DolbyVisionAV1Vector): Promise<Map<string, Uint8Array>> {
    const packedDataByFileName = new Map<string, Uint8Array>();
    for (const frame of vector.frames) {
        if (packedDataByFileName.has(frame.sourceRPUFileName)) {
            continue;
        }
        const parser = await createParser();
        try {
            packedDataByFileName.set(
                frame.sourceRPUFileName,
                new Uint8Array(parser.parse(readSourceRPU(frame.sourceRPUFileName)).packedData)
            );
        } finally {
            parser.close();
        }
    }
    return packedDataByFileName;
}

/** Returns the packed snapshot of one T.35 payload, parsed in a fresh parser. */
async function parseAV1ITUTT35InFreshParser(payload: Uint8Array): Promise<Uint8Array> {
    const parser = await createParser();
    try {
        return new Uint8Array(parser.parseAV1ITUTT35(payload).packedData);
    } finally {
        parser.close();
    }
}

async function readVectorPackets(vector: DolbyVisionAV1Vector): Promise<EncodedPacket[]> {
    // Mediabunny warns about the dav1 sample entry it leaves unmapped
    vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(readFileSync(resolve(VECTOR_DIRECTORY, vector.fileName))))
    });
    try {
        const videoTracks = await input.getVideoTracks();
        expect(videoTracks).toHaveLength(1);
        const videoTrack = videoTracks[0];
        // As the worker does, so an MP4 dav1 sample entry reads as AV1; av01 and V_AV1 already map to it
        expect(await assignISOBaseMediaDolbyVisionSampleEntryCodec(videoTrack)).toBe(
            vector.sampleEntry === DOLBY_VISION_AV1_SAMPLE_ENTRY_TYPE
        );
        expect(await videoTrack.getInternalCodecId()).toBe(vector.sampleEntry ?? MATROSKA_AV1_CODEC_ID);
        expect(await videoTrack.getCodec()).toBe('av1');
        expect([ await videoTrack.getCodedWidth(), await videoTrack.getCodedHeight() ]).toEqual([
            vector.width,
            vector.height
        ]);

        const packetSink = new EncodedPacketSink(videoTrack);
        const packets: EncodedPacket[] = [];
        for await (const packet of packetSink.packets(undefined, undefined, OWNED_AV1_PACKET_OPTIONS)) {
            packets.push(packet);
        }
        // The owned path seeks to the key packet preceding its start time
        const lastPacket = packets.at(-1);
        if (lastPacket) {
            const keyPacket = await packetSink.getKeyPacket(lastPacket.timestamp, OWNED_AV1_PACKET_OPTIONS);
            expect(keyPacket?.type).toBe('key');
        }
        return packets;
    } finally {
        input.dispose();
    }
}

function getSHA256(data: Uint8Array): string {
    return createHash('sha256').update(data).digest('hex');
}

function appendByte(data: Uint8Array, byteValue: number): Uint8Array {
    const output = new Uint8Array(data.byteLength + 1);
    output.set(data);
    output[data.byteLength] = byteValue;
    return output;
}

/** Reads one leb128 value and returns it with its byte length. */
function readLEB128(data: Uint8Array, offset: number): [ number, number ] {
    let value = 0;
    for (let byteIndex = 0; offset + byteIndex < data.byteLength; byteIndex += 1) {
        const byteValue = data[offset + byteIndex];
        value += (byteValue & LEB128_VALUE_MASK) * (2 ** (LEB128_VALUE_BIT_COUNT * byteIndex));
        if ((byteValue & LEB128_CONTINUATION_FLAG) === 0) {
            return [ value, byteIndex + 1 ];
        }
    }
    throw new RangeError('An OBU size runs past the end of its temporal unit');
}

/** Walks the OBUs of a temporal unit, whose OBUs all have size fields, independently of the engine's parser. */
function walkOBUs(data: Uint8Array): TestOBU[] {
    const obus: TestOBU[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
        const header = data[offset];
        expect(header & OBU_HAS_SIZE_FIELD_FLAG).toBe(OBU_HAS_SIZE_FIELD_FLAG);
        const sizeOffset = offset + ((header & OBU_EXTENSION_FLAG) === 0 ? 1 : 2);
        const [ payloadByteLength, sizeByteLength ] = readLEB128(data, sizeOffset);
        const payloadOffset = sizeOffset + sizeByteLength;
        const endOffset = payloadOffset + payloadByteLength;
        expect(endOffset).toBeLessThanOrEqual(data.byteLength);
        obus.push({
            data: data.subarray(offset, endOffset),
            payload: data.subarray(payloadOffset, endOffset),
            type: (header >> OBU_TYPE_SHIFT) & OBU_TYPE_MASK
        });
        offset = endOffset;
    }
    return obus;
}

function isDolbyVisionMetadataOBU(obu: TestOBU): boolean {
    return obu.type === OBU_TYPE_METADATA
        && DOLBY_VISION_METADATA_PREFIX.every((prefixByte: number, byteIndex: number): boolean => (
            obu.payload[byteIndex] === prefixByte
        ));
}

/** Requires the decoder data to be the temporal unit without its one Dolby Vision OBU, every other OBU intact. */
function requireRetainedOBUs(temporalUnit: Uint8Array, decoderData: Uint8Array, keyFrame: boolean): void {
    const obus = walkOBUs(temporalUnit);
    const retainedOBUs = walkOBUs(decoderData);
    expect(obus.filter(isDolbyVisionMetadataOBU)).toHaveLength(1);
    expect(retainedOBUs.filter(isDolbyVisionMetadataOBU)).toHaveLength(0);
    expect(retainedOBUs.map(obu => obu.data)).toEqual(
        obus.filter(obu => !isDolbyVisionMetadataOBU(obu)).map(obu => obu.data)
    );
    // libaom writes a sequence header into each key frame's temporal unit, and the muxers drop the delimiters
    expect(retainedOBUs.map(obu => obu.type)).toEqual(
        keyFrame ? [ OBU_TYPE_SEQUENCE_HEADER, OBU_TYPE_FRAME ] : [ OBU_TYPE_FRAME ]
    );
}

/** Splits one temporal unit, requires its RPU to be its frame's source RPU, and returns its decoder data. */
async function requireSplitTemporalUnit(
    packet: EncodedPacket,
    expectedFrame: DolbyVisionAV1VectorFrame,
    expectedPackedData: Uint8Array | undefined
): Promise<Uint8Array> {
    expect(packet.type === 'key').toBe(expectedFrame.keyFrame);
    const splitResult = splitDolbyVisionAV1TemporalUnit(packet.data);
    expect(splitResult.hasFrame).toBe(true);
    expect(splitResult.rpuPayloads).toHaveLength(1);
    const payload = splitResult.rpuPayloads[0];
    expect(getSHA256(payload)).toBe(expectedFrame.ITUTT35PayloadSHA256);
    // The generator and the test helper write the same T.35 container; the OBU's trailing bits follow it
    expect(payload).toEqual(appendByte(
        createDolbyVisionAV1ITUTT35Payload(readSourceRPU(expectedFrame.sourceRPUFileName)),
        OBU_TRAILING_BITS_BYTE
    ));
    // A fresh parser reads the T.35 payload to the same snapshot as the source RPU parsed as HEVC NAL unit 62
    expect(await parseAV1ITUTT35InFreshParser(payload)).toEqual(expectedPackedData);

    const resplitResult = splitDolbyVisionAV1TemporalUnit(splitResult.decoderData);
    expect(resplitResult.rpuPayloads).toHaveLength(0);
    expect(resplitResult.decoderData).toBe(splitResult.decoderData);
    requireRetainedOBUs(packet.data, splitResult.decoderData, expectedFrame.keyFrame);
    return splitResult.decoderData;
}

describe('Dolby Vision AV1 demux integration', () => {
    it('covers each sub-profile in MP4 and Matroska', () => {
        expect(VECTORS.map(vector => [ vector.subProfile, vector.container, vector.sampleEntry ])).toEqual([
            [ '10.0', 'mp4', 'dav1' ],
            [ '10.0', 'matroska', null ],
            [ '10.1', 'mp4', 'av01' ],
            [ '10.1', 'matroska', null ],
            [ '10.2', 'mp4', 'av01' ],
            [ '10.2', 'matroska', null ],
            [ '10.4', 'mp4', 'av01' ],
            [ '10.4', 'matroska', null ]
        ]);
    });

    it.each(VECTORS.map(vector => [ vector.fileName, vector ] as const))(
        'strips and parses the RPU of every temporal unit of %s',
        async (_fileName: string, vector: DolbyVisionAV1Vector) => {
            const expectedPackedDataByFileName = await parseSourceRPUsAsHEVC(vector);
            const packets = await readVectorPackets(vector);
            const parserSession = createParserSession();
            const queue = new DolbyVisionAV1EncodedMetadataQueue(parserSession);

            try {
                expect(vector.frames).toHaveLength(vector.frameCount);
                expect(packets).toHaveLength(vector.frameCount);
                for (let frameIndex = 0; frameIndex < packets.length; frameIndex += 1) {
                    const packet = packets[frameIndex];
                    const expectedFrame = vector.frames[frameIndex];
                    const expectedPackedData = expectedPackedDataByFileName.get(expectedFrame.sourceRPUFileName);
                    const decoderData = await requireSplitTemporalUnit(packet, expectedFrame, expectedPackedData);

                    const processedUnit = await queue.processTemporalUnit(packet);
                    expect(processedUnit.decoderPacket.data).toEqual(decoderData);
                    expect(processedUnit.decoderPacket.type).toBe(packet.type);
                    const metadata = queue.takeFrameMetadata(packet.microsecondTimestamp);
                    expect(metadata?.parsedRPUData).toHaveLength(1);
                    const parsedRPUData = metadata?.parsedRPUData[0] as ArrayBuffer;
                    // The session parses in decode order, as playback does, to the snapshot of the HEVC parse
                    expect(new Uint8Array(parsedRPUData)).toEqual(expectedPackedData);
                    expect(decodeDolbyVisionRPUSnapshot(parsedRPUData)).toMatchObject({
                        layerMode: 'single-layer',
                        profile: vector.subProfile === '10.0' ?
                            PROFILE_10_0_RPU_PROFILE :
                            PROFILE_10_RPU_PROFILE
                    });
                }
                queue.requireDrained();
            } finally {
                parserSession.close();
            }
        }
    );
});
