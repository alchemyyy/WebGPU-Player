// A one-frame Matroska HEVC Main 10 vector, muxed from the first access unit of hdr10plus_tool's x265 sample
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    BufferTarget,
    EncodedPacket,
    EncodedVideoPacketSource,
    MkvOutputFormat,
    Output
} from 'mediabunny';

import { parseHEVCNALUnits, type HEVCNALUnit } from 'webgpu-player/demux/dolby-vision/DolbyVisionHEVCSplitter';
import { parseHEVCSPS } from 'webgpu-player/demux/hevc/HEVCSPSParser';

import { TEST_VECTORS_DIRECTORY } from './enginePaths';
import { encodeAnnexBNALUnits } from './hevcNALUnits';

/** How the vector's packets carry NAL units: Annex B with in-band parameter sets, as hev1 does, or length-prefixed with an hvcC, as hvc1 does. */
export type HEVCMatroskaPacketFormat = 'annex-b' | 'length-prefixed';

// hdr10plus_tool's x265 sample opens each access unit with a delimiter, and its first is an IDR picture with its parameter sets
const X265_SAMPLE_PATH = resolve(TEST_VECTORS_DIRECTORY, 'hdr10plus-tool', 'dhdr10-opt.hevc');
const HEVC_VPS_NAL_UNIT_TYPE = 32;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const HEVC_PPS_NAL_UNIT_TYPE = 34;
const HEVC_AUD_NAL_UNIT_TYPE = 35;
const HEVC_PARAMETER_SET_NAL_UNIT_TYPES: readonly number[] = [ HEVC_VPS_NAL_UNIT_TYPE, HEVC_SPS_NAL_UNIT_TYPE, HEVC_PPS_NAL_UNIT_TYPE ];
const HEVC_MAIN_10_CODEC = 'hvc1.2.4.L93.B0';
const FRAME_DURATION_SECONDS = 1 / 25;

// The sample's profile, tier, and level, as its SPS declares them: Main 10 in the High tier at level 5.1
const HVCC_CONFIGURATION_VERSION = 1;
const HVCC_PROFILE_BYTE = 0x22;
const HVCC_PROFILE_COMPATIBILITY_BYTES = [ 0x20, 0x00, 0x00, 0x00 ];
const HVCC_CONSTRAINT_BYTES = [ 0x90, 0x00, 0x00, 0x00, 0x00, 0x00 ];
const HVCC_LEVEL = 153;
// Reserved bits set, no segmentation or parallelism, 4:2:0 at 10 bits
const HVCC_FORMAT_BYTES = [ 0xF0, 0x00, 0xFC, 0xFD, 0xFA, 0xFA ];
const HVCC_AVERAGE_FRAME_RATE_BYTES = [ 0x00, 0x00 ];
// One temporal layer, nested, with four-byte NAL unit lengths
const HVCC_TEMPORAL_AND_LENGTH_BYTE = 0x0F;
const HVCC_ARRAY_COMPLETENESS = 0x80;
const NAL_UNIT_LENGTH_BYTE_LENGTH = 4;

/** Builds an hvcC that carries the parameter sets of an access unit, one array per type. */
function createHEVCDecoderConfigurationRecord(nalUnits: readonly HEVCNALUnit[]): Uint8Array {
    const bytes: number[] = [
        HVCC_CONFIGURATION_VERSION,
        HVCC_PROFILE_BYTE,
        ...HVCC_PROFILE_COMPATIBILITY_BYTES,
        ...HVCC_CONSTRAINT_BYTES,
        HVCC_LEVEL,
        ...HVCC_FORMAT_BYTES,
        ...HVCC_AVERAGE_FRAME_RATE_BYTES,
        HVCC_TEMPORAL_AND_LENGTH_BYTE,
        HEVC_PARAMETER_SET_NAL_UNIT_TYPES.length
    ];
    for (const nalUnitType of HEVC_PARAMETER_SET_NAL_UNIT_TYPES) {
        const parameterSets = nalUnits.filter((nalUnit: HEVCNALUnit): boolean => nalUnit.type === nalUnitType);
        bytes.push(HVCC_ARRAY_COMPLETENESS | nalUnitType, parameterSets.length >> 8, parameterSets.length & 0xFF);
        for (const parameterSet of parameterSets) {
            bytes.push(parameterSet.data.byteLength >> 8, parameterSet.data.byteLength & 0xFF, ...parameterSet.data);
        }
    }
    return new Uint8Array(bytes);
}

/** Joins NAL units, each after its four-byte big-endian length, as an hvcC with lengthSizeMinusOne 3 declares. */
function encodeLengthPrefixedNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const byteLength = nalUnits.reduce((total: number, nalUnit: Uint8Array): number => total + NAL_UNIT_LENGTH_BYTE_LENGTH + nalUnit.byteLength, 0);
    const output = new Uint8Array(byteLength);
    const view = new DataView(output.buffer);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        view.setUint32(offset, nalUnit.byteLength);
        offset += NAL_UNIT_LENGTH_BYTE_LENGTH;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

// The NAL unit type of a trailing picture, which a delta packet's slice takes in place of the sample's IDR type, so key packet verification finds no IRAP picture in it
const HEVC_TRAIL_R_NAL_UNIT_TYPE = 1;
const HEVC_FIRST_IRAP_NAL_UNIT_TYPE = 16;
const HEVC_LAST_IRAP_NAL_UNIT_TYPE = 23;

/** Returns a NAL unit whose IRAP type, if it has one, became a trailing picture's. */
function demoteIRAPNALUnit(nalUnit: HEVCNALUnit): Uint8Array {
    if (nalUnit.type < HEVC_FIRST_IRAP_NAL_UNIT_TYPE || nalUnit.type > HEVC_LAST_IRAP_NAL_UNIT_TYPE) {
        return nalUnit.data;
    }
    const data = nalUnit.data.slice();
    // nal_unit_type is bits 1 to 6 of the header's first byte, after forbidden_zero_bit
    data[0] = (data[0] & 0x81) | (HEVC_TRAIL_R_NAL_UNIT_TYPE << 1);
    return data;
}

/**
 * Muxes the x265 sample's first access unit once per entry of keyframes, length-prefixed with an hvcC: a key packet as it is, a delta packet with its IDR slice
 * retyped as a trailing picture's, which a parser stub never reads, each packet one frame duration after the one before.
 * appendedNALUnits gives each packet, by index, NAL units that follow its picture's, such as a Dolby Vision RPU.
 */
export async function createHEVCMatroskaWithKeyframes(
    keyframes: readonly boolean[],
    appendedNALUnits: readonly (readonly Uint8Array[])[] = []
): Promise<Uint8Array> {
    const nalUnits = parseHEVCNALUnits(new Uint8Array(readFileSync(X265_SAMPLE_PATH)), { kind: 'annex-b' });
    const secondDelimiterIndex = nalUnits.findIndex(
        (nalUnit: HEVCNALUnit, nalUnitIndex: number): boolean => nalUnitIndex > 0 && nalUnit.type === HEVC_AUD_NAL_UNIT_TYPE
    );
    const firstAccessUnit = nalUnits.slice(0, secondDelimiterIndex);
    const sequenceParameterSet = firstAccessUnit.find((nalUnit: HEVCNALUnit): boolean => nalUnit.type === HEVC_SPS_NAL_UNIT_TYPE);
    if (!sequenceParameterSet) {
        throw new Error('The x265 sample\'s first access unit has no SPS');
    }
    const { codedHeight, codedWidth } = parseHEVCSPS(sequenceParameterSet.data);
    const pictureNALUnits = firstAccessUnit.filter((nalUnit: HEVCNALUnit): boolean => !HEVC_PARAMETER_SET_NAL_UNIT_TYPES.includes(nalUnit.type));
    const keyNALUnits = pictureNALUnits.map((nalUnit: HEVCNALUnit): Uint8Array => nalUnit.data);
    const deltaNALUnits = pictureNALUnits.map(demoteIRAPNALUnit);
    const decoderConfig: VideoDecoderConfig = {
        codec: HEVC_MAIN_10_CODEC,
        codedHeight,
        codedWidth,
        description: createHEVCDecoderConfigurationRecord(firstAccessUnit)
    };

    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const source = new EncodedVideoPacketSource('hevc');
    output.addVideoTrack(source);
    await output.start();
    for (const [ packetIndex, keyframe ] of keyframes.entries()) {
        const data = encodeLengthPrefixedNALUnits([ ...(keyframe ? keyNALUnits : deltaNALUnits), ...(appendedNALUnits[packetIndex] ?? []) ]);
        const packet = new EncodedPacket(data, keyframe ? 'key' : 'delta', packetIndex * FRAME_DURATION_SECONDS, FRAME_DURATION_SECONDS);
        await source.add(packet, packetIndex === 0 ? { decoderConfig } : undefined);
    }
    source.close();
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the Matroska vector');
    }
    return new Uint8Array(target.buffer);
}

/** Muxes the x265 sample's first access unit as a one-frame Matroska HEVC Main 10 track without Dolby Vision. */
export async function createHEVCMatroska(packetFormat: HEVCMatroskaPacketFormat = 'annex-b'): Promise<Uint8Array> {
    const nalUnits = parseHEVCNALUnits(new Uint8Array(readFileSync(X265_SAMPLE_PATH)), { kind: 'annex-b' });
    const secondDelimiterIndex = nalUnits.findIndex(
        (nalUnit: HEVCNALUnit, nalUnitIndex: number): boolean => nalUnitIndex > 0 && nalUnit.type === HEVC_AUD_NAL_UNIT_TYPE
    );
    const firstAccessUnit = nalUnits.slice(0, secondDelimiterIndex);
    const sequenceParameterSet = firstAccessUnit.find((nalUnit: HEVCNALUnit): boolean => nalUnit.type === HEVC_SPS_NAL_UNIT_TYPE);
    if (!sequenceParameterSet) {
        throw new Error('The x265 sample\'s first access unit has no SPS');
    }
    const { codedHeight, codedWidth } = parseHEVCSPS(sequenceParameterSet.data);

    const target = new BufferTarget();
    const output = new Output({ format: new MkvOutputFormat(), target });
    const source = new EncodedVideoPacketSource('hevc');
    output.addVideoTrack(source);
    await output.start();
    let accessUnitData: Uint8Array;
    let decoderConfig: VideoDecoderConfig;
    switch (packetFormat) {
        case 'annex-b':
            accessUnitData = encodeAnnexBNALUnits(firstAccessUnit.map((nalUnit: HEVCNALUnit): Uint8Array => nalUnit.data));
            decoderConfig = { codec: HEVC_MAIN_10_CODEC, codedHeight, codedWidth };
            break;
        case 'length-prefixed':
            // The parameter sets move out of band into the hvcC
            accessUnitData = encodeLengthPrefixedNALUnits(firstAccessUnit
                .filter((nalUnit: HEVCNALUnit): boolean => !HEVC_PARAMETER_SET_NAL_UNIT_TYPES.includes(nalUnit.type))
                .map((nalUnit: HEVCNALUnit): Uint8Array => nalUnit.data));
            decoderConfig = { codec: HEVC_MAIN_10_CODEC, codedHeight, codedWidth, description: createHEVCDecoderConfigurationRecord(firstAccessUnit) };
            break;
    }
    await source.add(new EncodedPacket(accessUnitData, 'key', 0, FRAME_DURATION_SECONDS), { decoderConfig });
    source.close();
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the Matroska vector');
    }
    return new Uint8Array(target.buffer);
}
