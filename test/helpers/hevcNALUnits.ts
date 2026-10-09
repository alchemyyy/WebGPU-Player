// Synthetic HEVC NAL units, SEI fields, and Annex B streams shared by the video tests

/** Builds a NAL unit header with nuh_layer_id 0 and nuh_temporal_id_plus1 1, then the payload. */
export function createNALUnit(type: number, payload: readonly number[]): Uint8Array {
    return new Uint8Array([ (type & 0x3F) << 1, 1, ...payload ]);
}

/** Joins the NAL units into one Annex B stream with four-byte start codes. */
export function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const startCode = new Uint8Array([ 0, 0, 0, 1 ]);
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        output.set(startCode, offset);
        offset += startCode.byteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

/** Appends an SEI payload type or size: one 0xFF byte per whole 255, then the remainder. */
export function appendExtendedValue(output: number[], value: number): void {
    let remainingValue = value;
    while (remainingValue >= 0xFF) {
        output.push(0xFF);
        remainingValue -= 0xFF;
    }
    output.push(remainingValue);
}

/** Converts RBSP bytes to NAL unit payload bytes by inserting an emulation prevention byte after two zeros that precede a byte of 3 or less. */
export function addEmulationPreventionBytes(data: readonly number[]): number[] {
    const output: number[] = [];
    let zeroCount = 0;
    for (const byteValue of data) {
        if (zeroCount >= 2 && byteValue <= 3) {
            output.push(3);
            zeroCount = 0;
        }
        output.push(byteValue);
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return output;
}
