/** Decodes the base64 text that the capability vectors store inline into a new byte array that the caller owns. */
export function decodeBase64(base64: string): Uint8Array {
    const decoded: string = globalThis.atob(base64);
    const bytes: Uint8Array = new Uint8Array(decoded.length);
    for (let byteIndex = 0; byteIndex < decoded.length; byteIndex += 1) {
        bytes[byteIndex] = decoded.charCodeAt(byteIndex);
    }
    return bytes;
}
