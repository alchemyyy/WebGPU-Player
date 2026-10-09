import {
    getAV1ITUTT35Message,
    stripAV1TrailingBits,
    type AV1OBU
} from '../av1/AV1OBUParser';
import {
    isHDR10PlusITUTT35Message,
    parseHDR10PlusITUTT35Messages,
    type HDR10PlusFrameMetadata
} from './HDR10PlusMetadata';

/**
 * Parses the HDR10+ metadata of one AV1 temporal unit from its OBUs.
 * Each HDR10+ ITU-T T.35 message is read without its OBU trailing bits, as dav1d reads it, and a message without a valid trailing one bit makes the frame malformed.
 * Messages of other providers, Dolby Vision RPUs included, are ignored.
 */
export function parseAV1HDR10PlusMetadata(obus: readonly AV1OBU[]): HDR10PlusFrameMetadata {
    const messages: Uint8Array[] = [];
    for (const obu of obus) {
        const message = getAV1ITUTT35Message(obu);
        if (!message || !isHDR10PlusITUTT35Message(message)) {
            continue;
        }
        const strippedMessage = stripAV1TrailingBits(message);
        if (!strippedMessage) {
            return { metadata: null, status: 'malformed' };
        }
        messages.push(strippedMessage);
    }
    return parseHDR10PlusITUTT35Messages(messages);
}
