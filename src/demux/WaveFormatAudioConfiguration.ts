import type { InputAudioTrack } from 'mediabunny';

/** Matroska's codec ID of an Audio Compression Manager track, whose CodecPrivate is a WAVEFORMATEX and then the codec's extradata. */
export const MATROSKA_ACM_CODEC_ID = 'A_MS/ACM';
/** The WAVEFORMATEX's length up to and including cbSize, which counts the bytes after it. */
export const WAVE_FORMAT_HEADER_BYTE_LENGTH = 18;
const WAVE_FORMAT_EXTENSIBLE_TAG = 0xFFFE;
// wValidBitsPerSample, dwChannelMask, and the SubFormat GUID
const WAVE_FORMAT_EXTENSIBLE_BYTE_LENGTH = 22;
// The WAVEFORMATEX fields, little-endian
const FORMAT_TAG_OFFSET = 0;
const CHANNELS_OFFSET = 2;
const SAMPLES_PER_SECOND_OFFSET = 4;
const AVERAGE_BYTES_PER_SECOND_OFFSET = 8;
const BLOCK_ALIGN_OFFSET = 12;
const BITS_PER_SAMPLE_OFFSET = 14;
const EXTENSION_SIZE_OFFSET = 16;
// The WAVE_FORMAT_EXTENSIBLE fields after the header
const VALID_BITS_PER_SAMPLE_OFFSET = WAVE_FORMAT_HEADER_BYTE_LENGTH;
const CHANNEL_MASK_OFFSET = WAVE_FORMAT_HEADER_BYTE_LENGTH + 2;
const SUBFORMAT_OFFSET = WAVE_FORMAT_HEADER_BYTE_LENGTH + 6;
const SUBFORMAT_TAG_BYTE_LENGTH = 4;
const SUBFORMAT_BYTE_LENGTH = 16;
const MAXIMUM_EXTENSION_BYTE_LENGTH = 0xFFFF;
const HEXADECIMAL_RADIX = 16;
const FORMAT_TAG_DIGITS = 4;
// The last 12 bytes of the SubFormat GUIDs whose first 4 bytes are a format tag, as FFmpeg's libavformat/riffdec.c reads them:
// the media subtype base, the ambisonic base, and a broken base some muxers write. The first is the one a rebuilt header carries
const SUBFORMAT_TAG_BASE_GUIDS: readonly (readonly number[])[] = Object.freeze([
    Object.freeze([ 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 ]),
    Object.freeze([ 0x21, 0x07, 0xD3, 0x11, 0x86, 0x44, 0xC8, 0xC1, 0xCA, 0x00, 0x00, 0x00 ]),
    Object.freeze([ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA ])
]);

/** The codecs the engine reads from a WAVEFORMATEX's format tag, by FFmpeg's names, which ffprobe and so Jellyfin give their streams. */
export const WAVE_FORMAT_AUDIO_CODECS = [ 'wmav1', 'wmav2', 'wmapro', 'wmalossless', 'wmavoice' ] as const;
export type WaveFormatAudioCodec = typeof WAVE_FORMAT_AUDIO_CODECS[number];

// FFmpeg's libavformat/riff.c ff_codec_wav_tags
const FORMAT_TAG_CODECS: ReadonlyMap<number, WaveFormatAudioCodec> = new Map<number, WaveFormatAudioCodec>([
    [ 0x000A, 'wmavoice' ],
    [ 0x0160, 'wmav1' ],
    [ 0x0161, 'wmav2' ],
    [ 0x0162, 'wmapro' ],
    [ 0x0163, 'wmalossless' ]
]);

/** A codec-less track's codec and its WAVEFORMATEX, which its decoder package configures with, or the check it failed, as `code: detail`. */
export type WaveFormatAudioTrackResult =
    | Readonly<{ codec: WaveFormatAudioCodec, status: 'read', waveFormat: Uint8Array }>
    | Readonly<{ failure: string, status: 'failed' }>;

// The fields of the fork's AVI and ASF stream formats that a WAVEFORMATEX holds; src/avi/avi-misc.ts in Mediabunny parses them from an AVI strf chunk
// and an ASF Stream Properties Object
type AVIWaveFormat = {
    avgBytesPerSec: number
    bitsPerSample: number
    blockAlign: number
    channels: number
    extensible?: { channelMask: number, subFormatTag: number | null, validBitsPerSample: number }
    extraData?: Uint8Array
    formatTag: number
    samplesPerSec: number
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function fail(failure: string): Readonly<{ failure: string, status: 'failed' }> {
    return { failure, status: 'failed' };
}

function formatTag(tag: number): string {
    return `0x${tag.toString(HEXADECIMAL_RADIX).toUpperCase().padStart(FORMAT_TAG_DIGITS, '0')}`;
}

/** Returns the engine's codec of a WAVEFORMATEX format tag, or null for a tag no decoder package of the engine's codecs decodes. */
export function getWaveFormatTagAudioCodec(tag: number): WaveFormatAudioCodec | null {
    return FORMAT_TAG_CODECS.get(tag) ?? null;
}

/** Returns the format tag a SubFormat GUID carries in its first 4 bytes, or null when its other 12 bytes are no tag-carrying base. */
function readSubFormatTag(subFormat: Uint8Array): number | null {
    const base = subFormat.subarray(SUBFORMAT_TAG_BYTE_LENGTH);
    const carriesTag = SUBFORMAT_TAG_BASE_GUIDS.some((candidate: readonly number[]): boolean => (
        candidate.every((byte: number, index: number): boolean => base[index] === byte)
    ));
    return carriesTag ? new DataView(subFormat.buffer, subFormat.byteOffset, SUBFORMAT_TAG_BYTE_LENGTH).getUint32(0, true) : null;
}

/**
 * Checks a WAVEFORMATEX, and names its codec by its format tag, or by its SubFormat's for WAVE_FORMAT_EXTENSIBLE, as FFmpeg's ff_get_wav_header does.
 * The header must hold its 18 bytes and the cbSize bytes it declares after them; the result keeps a copy of just those, all a decoder reads,
 * so bytes a CodecPrivate carries after them never reach the decoder.
 */
export function readWaveFormatAudioCodec(waveFormat: Uint8Array): WaveFormatAudioTrackResult {
    if (waveFormat.byteLength < WAVE_FORMAT_HEADER_BYTE_LENGTH) {
        return fail(`wave-format-size: ${waveFormat.byteLength}`);
    }
    const view = new DataView(waveFormat.buffer, waveFormat.byteOffset, waveFormat.byteLength);
    const extensionByteLength = view.getUint16(EXTENSION_SIZE_OFFSET, true);
    if (WAVE_FORMAT_HEADER_BYTE_LENGTH + extensionByteLength > waveFormat.byteLength) {
        return fail(`wave-format-size: ${waveFormat.byteLength}, cbSize ${extensionByteLength}`);
    }
    let tag: number | null = view.getUint16(FORMAT_TAG_OFFSET, true);
    if (tag === WAVE_FORMAT_EXTENSIBLE_TAG) {
        if (extensionByteLength < WAVE_FORMAT_EXTENSIBLE_BYTE_LENGTH) {
            return fail(`wave-format-extensible-size: ${extensionByteLength}`);
        }
        tag = readSubFormatTag(waveFormat.subarray(SUBFORMAT_OFFSET, SUBFORMAT_OFFSET + SUBFORMAT_BYTE_LENGTH));
        if (tag === null) {
            return fail('format-tag: SubFormat GUID');
        }
    }
    const codec = getWaveFormatTagAudioCodec(tag);
    if (!codec) {
        return fail(`format-tag: ${formatTag(tag)}`);
    }
    // A copy, since a Node Buffer's slice shares its memory
    return { codec, status: 'read', waveFormat: new Uint8Array(waveFormat.subarray(0, WAVE_FORMAT_HEADER_BYTE_LENGTH + extensionByteLength)) };
}

function isAVIWaveFormat(value: unknown): value is AVIWaveFormat {
    return isRecord(value)
        && [ value.formatTag, value.channels, value.samplesPerSec, value.avgBytesPerSec, value.blockAlign, value.bitsPerSample ]
            .every((field: unknown): boolean => Number.isSafeInteger(field))
        && (value.extraData === undefined || value.extraData instanceof Uint8Array)
        && (value.extensible === undefined || isRecord(value.extensible));
}

/**
 * Writes the WAVEFORMATEX an AVI strf chunk held back from the fields the fork parsed: the header, the WAVE_FORMAT_EXTENSIBLE fields when it had them,
 * then the extradata. A SubFormat that carried a format tag is written on the media subtype base.
 */
function createAVIWaveFormat(format: AVIWaveFormat): Uint8Array | null {
    const extradata = format.extraData ?? new Uint8Array();
    const extensible = format.extensible;
    const extensionByteLength = (extensible ? WAVE_FORMAT_EXTENSIBLE_BYTE_LENGTH : 0) + extradata.byteLength;
    if (extensionByteLength > MAXIMUM_EXTENSION_BYTE_LENGTH) {
        return null;
    }
    const waveFormat = new Uint8Array(WAVE_FORMAT_HEADER_BYTE_LENGTH + extensionByteLength);
    const view = new DataView(waveFormat.buffer);
    view.setUint16(FORMAT_TAG_OFFSET, format.formatTag, true);
    view.setUint16(CHANNELS_OFFSET, format.channels, true);
    view.setUint32(SAMPLES_PER_SECOND_OFFSET, format.samplesPerSec, true);
    view.setUint32(AVERAGE_BYTES_PER_SECOND_OFFSET, format.avgBytesPerSec, true);
    view.setUint16(BLOCK_ALIGN_OFFSET, format.blockAlign, true);
    view.setUint16(BITS_PER_SAMPLE_OFFSET, format.bitsPerSample, true);
    view.setUint16(EXTENSION_SIZE_OFFSET, extensionByteLength, true);
    let extradataOffset = WAVE_FORMAT_HEADER_BYTE_LENGTH;
    if (extensible) {
        if (extensible.subFormatTag === null) {
            return null;
        }
        view.setUint16(VALID_BITS_PER_SAMPLE_OFFSET, extensible.validBitsPerSample, true);
        view.setUint32(CHANNEL_MASK_OFFSET, extensible.channelMask, true);
        view.setUint32(SUBFORMAT_OFFSET, extensible.subFormatTag, true);
        waveFormat.set(SUBFORMAT_TAG_BASE_GUIDS[0], SUBFORMAT_OFFSET + SUBFORMAT_TAG_BYTE_LENGTH);
        extradataOffset += WAVE_FORMAT_EXTENSIBLE_BYTE_LENGTH;
    }
    waveFormat.set(extradata, extradataOffset);
    return waveFormat;
}

/**
 * Reads a codec-less audio track's WAVEFORMATEX and the codec its format tag names: a Matroska A_MS/ACM track's CodecPrivate, or the strf chunk
 * of an AVI audio stream or the Stream Properties Object of an ASF one, whose format tag Mediabunny maps to no codec.
 * Returns null for a track of another container or codec ID, which has no WAVEFORMATEX.
 */
export function readWaveFormatAudioTrack(track: InputAudioTrack): WaveFormatAudioTrackResult | null {
    // Mediabunny keeps these tracks codec-less but exposes neither CodecPrivate nor the strf chunk through getDecoderConfig(), so contain the backing access here
    const backing = (track as unknown as { _backing?: unknown })._backing;
    if (!isRecord(backing)) {
        return null;
    }
    const internalTrack = backing.internalTrack;
    if (isRecord(internalTrack) && internalTrack.codecId === MATROSKA_ACM_CODEC_ID) {
        const codecPrivate = internalTrack.codecPrivate;
        if (!(codecPrivate instanceof Uint8Array)) {
            return fail(`codec-private-missing: ${codecPrivate === null ? 'null' : typeof codecPrivate}`);
        }
        return readWaveFormatAudioCodec(codecPrivate);
    }
    const streamInfo = backing.streamInfo;
    if (!isRecord(streamInfo) || !isAVIWaveFormat(streamInfo.format)) {
        return null;
    }
    const waveFormat = createAVIWaveFormat(streamInfo.format);
    return waveFormat ? readWaveFormatAudioCodec(waveFormat) : fail(`format-tag: ${formatTag(streamInfo.format.formatTag)}`);
}
