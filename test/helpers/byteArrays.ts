// Byte array builders shared by the container and bitstream tests

/** Joins the parts into one new array. */
export function concatenate(parts: readonly Uint8Array[]): Uint8Array {
    const byteLength = parts.reduce(
        (totalByteLength: number, part: Uint8Array): number => totalByteLength + part.byteLength,
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

/** Decodes a string of hex digit pairs. */
export function createBytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = Number.parseInt(hex.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
    }
    return bytes;
}
