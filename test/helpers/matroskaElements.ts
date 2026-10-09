// EBML element builders shared by the synthetic Matroska tests

import { concatenate } from './byteArrays';

const FLOAT_ELEMENT_BYTE_LENGTH = 8;

/** Encodes an element ID with its length marker bits, as written in the Matroska specification. */
export function encodeElementID(id: number): Uint8Array {
    let byteLength = 1;
    while (id >= 256 ** byteLength) {
        byteLength += 1;
    }
    const output = new Uint8Array(byteLength);
    let remainingValue = id;
    for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex -= 1) {
        output[byteIndex] = remainingValue % 256;
        remainingValue = Math.floor(remainingValue / 256);
    }
    return output;
}

/** Encodes a known element size in the shortest variable-length integer. */
export function encodeElementSize(byteLength: number): Uint8Array {
    for (let encodedByteLength = 1; encodedByteLength <= 8; encodedByteLength += 1) {
        const maximumValue = (2 ** (7 * encodedByteLength)) - 2;
        if (byteLength > maximumValue) {
            continue;
        }
        let encodedValue = byteLength + (2 ** (7 * encodedByteLength));
        const output = new Uint8Array(encodedByteLength);
        for (let byteIndex = encodedByteLength - 1; byteIndex >= 0; byteIndex -= 1) {
            output[byteIndex] = encodedValue % 256;
            encodedValue = Math.floor(encodedValue / 256);
        }
        return output;
    }
    throw new RangeError('The synthetic EBML element is too large');
}

export function createElement(id: number, payload: Uint8Array): Uint8Array {
    return concatenate([
        encodeElementID(id),
        encodeElementSize(payload.byteLength),
        payload
    ]);
}

export function createUnsignedIntegerElement(id: number, value: number): Uint8Array {
    const bytes: number[] = [];
    let remainingValue = value;
    do {
        bytes.unshift(remainingValue % 256);
        remainingValue = Math.floor(remainingValue / 256);
    } while (remainingValue > 0);
    return createElement(id, new Uint8Array(bytes));
}

export function createFloatElement(id: number, value: number): Uint8Array {
    const payload = new Uint8Array(FLOAT_ELEMENT_BYTE_LENGTH);
    new DataView(payload.buffer).setFloat64(0, value);
    return createElement(id, payload);
}

export function createASCIIElement(id: number, value: string): Uint8Array {
    return createElement(
        id,
        new Uint8Array(Array.from(value, (character: string): number => character.charCodeAt(0)))
    );
}
