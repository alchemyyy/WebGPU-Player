import {
    getAV1ITUTT35Message,
    hasAV1FrameHeader,
    parseAV1OBUs
} from '../av1/AV1OBUParser';

// itu_t_t35_country_code (United States), terminal provider code (Dolby), and terminal provider oriented code
const DOLBY_VISION_ITUT_T35_HEADER: readonly number[] = [ 0xB5, 0x00, 0x3B, 0x00, 0x00, 0x08, 0x00 ];

export type DolbyVisionAV1SplitResult = {
    /** The temporal unit without its Dolby Vision metadata OBUs; the input itself when it carries none */
    decoderData: Uint8Array
    /** Whether the unit carries a frame header, so the decoder outputs a frame for it */
    hasFrame: boolean
    /** Each Dolby Vision ITU-T T.35 message, from its country code to the end of its OBU payload, in unit order */
    rpuPayloads: readonly Uint8Array[]
};

function isDolbyVisionITUTT35Message(message: Uint8Array): boolean {
    return message.byteLength >= DOLBY_VISION_ITUT_T35_HEADER.length
        && DOLBY_VISION_ITUT_T35_HEADER.every((headerByte: number, byteIndex: number): boolean => (
            message[byteIndex] === headerByte
        ));
}

function concatenateOBUs(obus: readonly Uint8Array[], byteLength: number): Uint8Array {
    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    for (const obu of obus) {
        output.set(obu, outputOffset);
        outputOffset += obu.byteLength;
    }
    return output;
}

/**
 * Removes the Dolby Vision RPU metadata OBUs of one AV1 temporal unit and returns owned copies of their T.35 messages.
 * Every other OBU stays in order and untouched, other T.35 metadata such as HDR10+ included.
 * A unit without an RPU is returned without a copy.
 */
export function splitDolbyVisionAV1TemporalUnit(data: Uint8Array): DolbyVisionAV1SplitResult {
    const retainedOBUs: Uint8Array[] = [];
    const rpuPayloads: Uint8Array[] = [];
    let retainedByteLength = 0;
    let hasFrame = false;
    for (const obu of parseAV1OBUs(data)) {
        hasFrame ||= hasAV1FrameHeader(obu);
        const message = getAV1ITUTT35Message(obu);
        if (message && isDolbyVisionITUTT35Message(message)) {
            rpuPayloads.push(message.slice());
            continue;
        }
        retainedOBUs.push(obu.data);
        retainedByteLength += obu.data.byteLength;
    }

    return {
        decoderData: rpuPayloads.length === 0 ? data : concatenateOBUs(retainedOBUs, retainedByteLength),
        hasFrame,
        rpuPayloads
    };
}
