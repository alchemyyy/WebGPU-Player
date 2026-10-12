// The parts of ffprobe's JSON output the probe reads, validated from unknown input into typed records, and ffprobe's names for what they hold.
import { type Microseconds, MICROSECONDS_PER_SECOND } from 'webgpu-player/MediaTime';
import { requireMicroseconds } from 'webgpu-player/TimeMath';

export type FFprobeSideData = Readonly<{
    blPresentFlag: number | null
    dvBlSignalCompatibilityId: number | null
    dvLevel: number | null
    dvProfile: number | null
    dvVersionMajor: number | null
    dvVersionMinor: number | null
    elPresentFlag: number | null
    rotation: number | null
    rpuPresentFlag: number | null
    sideDataType: string
}>;

export type FFprobeStream = Readonly<{
    averageFrameRate: string | null
    bitRate: string | null
    bitsPerRawSample: number | null
    bitsPerSample: number | null
    channelLayout: string | null
    channels: number | null
    codecName: string | null
    codecTag: string | null
    codecType: string | null
    codedHeight: number | null
    codedWidth: number | null
    colorPrimaries: string | null
    colorRange: string | null
    colorSpace: string | null
    colorTransfer: string | null
    disposition: Readonly<Record<string, number>>
    fieldOrder: string | null
    height: number | null
    index: number
    level: number | null
    pixelFormat: string | null
    profile: string | null
    realFrameRate: string | null
    sampleRate: string | null
    sideData: readonly FFprobeSideData[]
    tags: Readonly<Record<string, string>>
    width: number | null
}>;

export type FFprobeFormat = Readonly<{
    /** Seconds as ffprobe prints them, a decimal with microsecond digits */
    duration: string | null
    formatName: string | null
}>;

export type FFprobeOutput = Readonly<{
    format: FFprobeFormat
    streams: readonly FFprobeStream[]
}>;

/** A decoded frame's side data, which tells HDR10+ metadata apart from its absence. */
export type FFprobeFrame = Readonly<{
    sideDataTypes: readonly string[]
    streamIndex: number
}>;

/** ffprobe's codec types. */
export const FFPROBE_CODEC_TYPES = Object.freeze({
    audio: 'audio',
    subtitle: 'subtitle',
    video: 'video'
});

/** ffprobe's names for the transfers that make a stream HDR. */
export const FFPROBE_TRANSFERS = Object.freeze({
    hlg: 'arib-std-b67',
    pq: 'smpte2084'
});

/** ffprobe's side data types that the probe reads. */
export const FFPROBE_SIDE_DATA_TYPES = Object.freeze({
    displayMatrix: 'Display Matrix',
    dolbyVision: 'DOVI configuration record',
    hdr10Plus: 'HDR Dynamic Metadata SMPTE2094-40 (HDR10+)'
});

/** ffprobe's stream dispositions that the probe reads. */
export const FFPROBE_DISPOSITIONS = Object.freeze({
    attachedPicture: 'attached_pic',
    default: 'default',
    forced: 'forced'
});

/** ffprobe's tags that name a stream. */
export const FFPROBE_TAGS = Object.freeze({
    language: 'language',
    title: 'title'
});

// ffprobe prints some numbers as strings, such as bits_per_raw_sample
const INTEGER_TEXT_PATTERN = /^-?\d+$/;
const SET_DISPOSITION = 1;
const RATE_SEPARATOR = '/';
// ffprobe prints seconds as a decimal with microsecond digits, which parses exactly into integer microseconds
const DECIMAL_SECONDS_PATTERN = /^(\d+)(?:\.(\d+))?$/;
const MICROSECOND_DIGIT_COUNT = 6;

/** Returns whether a stream has a disposition, such as default or forced. */
export function hasFFprobeDisposition(stream: FFprobeStream, disposition: string): boolean {
    return stream.disposition[disposition] === SET_DISPOSITION;
}

/** Returns whether a stream is a video track of the container, not a cover picture, which ffprobe also lists as video. */
export function isContainerVideoStream(stream: FFprobeStream): boolean {
    return stream.codecType === FFPROBE_CODEC_TYPES.video && !hasFFprobeDisposition(stream, FFPROBE_DISPOSITIONS.attachedPicture);
}

/** Returns a stream's side data of one type, or null. */
export function findFFprobeSideData(stream: FFprobeStream, sideDataType: string): FFprobeSideData | null {
    return stream.sideData.find((sideData: FFprobeSideData): boolean => sideData.sideDataType === sideDataType) ?? null;
}

/** Parses a positive integer ffprobe prints as a string, such as a sample rate; null otherwise. */
export function parseFFprobePositiveInteger(text: string | null): number | null {
    const value = Number(text);
    return text !== null && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Parses a rate ffprobe prints as a ratio, such as the frame rate 24000/1001; null for 0/0 and malformed text. */
export function parseFFprobeRate(text: string | null): number | null {
    if (text === null) {
        return null;
    }
    const [ dividendText, divisorText ] = text.split(RATE_SEPARATOR);
    const dividend = Number(dividendText);
    const divisor = Number(divisorText);
    return Number.isInteger(dividend) && Number.isInteger(divisor) && divisor > 0 ? dividend / divisor : null;
}

/** Parses seconds as ffprobe prints them into integer microseconds, without floating point; null when the text is not a decimal. */
export function parseFFprobeSeconds(text: string | null): Microseconds | null {
    const match = text === null ? null : DECIMAL_SECONDS_PATTERN.exec(text);
    if (!match) {
        return null;
    }
    // Digits beyond microseconds are dropped; ffprobe prints none
    const fractionDigits = (match[2] ?? '').slice(0, MICROSECOND_DIGIT_COUNT).padEnd(MICROSECOND_DIGIT_COUNT, '0');
    return requireMicroseconds(Number(match[1]) * MICROSECONDS_PER_SECOND + Number(fractionDigits), 'ffprobe seconds');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads an integer printed as a number or as a string. */
function readInteger(record: Record<string, unknown>, key: string): number | null {
    const value = record[key];
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? value : null;
    }
    if (typeof value === 'string' && INTEGER_TEXT_PATTERN.test(value)) {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

/** Parses ffprobe's JSON output as an object, and throws the error section `-show_error` prints for a file ffprobe cannot read. */
function readFFprobeJSON(text: string): Record<string, unknown> {
    const output: unknown = JSON.parse(text);
    if (!isRecord(output)) {
        throw new TypeError('ffprobe-output-invalid: not an object');
    }
    if (isRecord(output.error)) {
        throw new Error(`ffprobe-error: ${readString(output.error, 'string') ?? 'no message'} (${readInteger(output.error, 'code') ?? 'no code'})`);
    }
    return output;
}

function readRecordList(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
    const value = record[key];
    const records: Record<string, unknown>[] = [];
    if (!Array.isArray(value)) {
        return records;
    }
    for (const item of value) {
        if (isRecord(item)) {
            records.push(item);
        }
    }
    return records;
}

function readIntegerMap(record: Record<string, unknown>, key: string): Record<string, number> {
    const value = record[key];
    const entries: Array<[string, number]> = [];
    if (!isRecord(value)) {
        return Object.fromEntries(entries);
    }
    for (const entryKey of Object.keys(value)) {
        const entryValue = readInteger(value, entryKey);
        if (entryValue !== null) {
            entries.push([ entryKey, entryValue ]);
        }
    }
    return Object.fromEntries(entries);
}

function readStringMap(record: Record<string, unknown>, key: string): Record<string, string> {
    const value = record[key];
    const entries: Array<[string, string]> = [];
    if (!isRecord(value)) {
        return Object.fromEntries(entries);
    }
    for (const entryKey of Object.keys(value)) {
        const entryValue = readString(value, entryKey);
        if (entryValue !== null) {
            entries.push([ entryKey, entryValue ]);
        }
    }
    return Object.fromEntries(entries);
}

function readSideData(record: Record<string, unknown>): FFprobeSideData | null {
    const sideDataType = readString(record, 'side_data_type');
    if (sideDataType === null) {
        return null;
    }
    return {
        blPresentFlag: readInteger(record, 'bl_present_flag'),
        dvBlSignalCompatibilityId: readInteger(record, 'dv_bl_signal_compatibility_id'),
        dvLevel: readInteger(record, 'dv_level'),
        dvProfile: readInteger(record, 'dv_profile'),
        dvVersionMajor: readInteger(record, 'dv_version_major'),
        dvVersionMinor: readInteger(record, 'dv_version_minor'),
        elPresentFlag: readInteger(record, 'el_present_flag'),
        rotation: readInteger(record, 'rotation'),
        rpuPresentFlag: readInteger(record, 'rpu_present_flag'),
        sideDataType
    };
}

function readStream(record: Record<string, unknown>): FFprobeStream | null {
    const index = readInteger(record, 'index');
    if (index === null) {
        return null;
    }
    const sideData: FFprobeSideData[] = [];
    for (const sideDataRecord of readRecordList(record, 'side_data_list')) {
        const parsedSideData = readSideData(sideDataRecord);
        if (parsedSideData !== null) {
            sideData.push(parsedSideData);
        }
    }
    return {
        averageFrameRate: readString(record, 'avg_frame_rate'),
        bitRate: readString(record, 'bit_rate'),
        bitsPerRawSample: readInteger(record, 'bits_per_raw_sample'),
        bitsPerSample: readInteger(record, 'bits_per_sample'),
        channelLayout: readString(record, 'channel_layout'),
        channels: readInteger(record, 'channels'),
        codecName: readString(record, 'codec_name'),
        codecTag: readString(record, 'codec_tag_string'),
        codecType: readString(record, 'codec_type'),
        codedHeight: readInteger(record, 'coded_height'),
        codedWidth: readInteger(record, 'coded_width'),
        colorPrimaries: readString(record, 'color_primaries'),
        colorRange: readString(record, 'color_range'),
        colorSpace: readString(record, 'color_space'),
        colorTransfer: readString(record, 'color_transfer'),
        disposition: readIntegerMap(record, 'disposition'),
        fieldOrder: readString(record, 'field_order'),
        height: readInteger(record, 'height'),
        index,
        level: readInteger(record, 'level'),
        pixelFormat: readString(record, 'pix_fmt'),
        profile: readString(record, 'profile'),
        realFrameRate: readString(record, 'r_frame_rate'),
        sampleRate: readString(record, 'sample_rate'),
        sideData,
        tags: readStringMap(record, 'tags'),
        width: readInteger(record, 'width')
    };
}

/** Parses `ffprobe -show_format -show_streams -of json` output; a stream without an index is skipped. */
export function parseFFprobeOutput(text: string): FFprobeOutput {
    const output = readFFprobeJSON(text);
    const format = isRecord(output.format) ? output.format : {};
    const streams: FFprobeStream[] = [];
    for (const streamRecord of readRecordList(output, 'streams')) {
        const stream = readStream(streamRecord);
        if (stream !== null) {
            streams.push(stream);
        }
    }
    return {
        format: { duration: readString(format, 'duration'), formatName: readString(format, 'format_name') },
        streams
    };
}

/** Parses `ffprobe -show_frames -of json` output into each frame's side data types. */
export function parseFFprobeFrames(text: string): FFprobeFrame[] {
    const output = readFFprobeJSON(text);
    const frames: FFprobeFrame[] = [];
    for (const frameRecord of readRecordList(output, 'frames')) {
        const streamIndex = readInteger(frameRecord, 'stream_index');
        if (streamIndex === null) {
            continue;
        }
        const sideDataTypes: string[] = [];
        for (const sideDataRecord of readRecordList(frameRecord, 'side_data_list')) {
            const sideDataType = readString(sideDataRecord, 'side_data_type');
            if (sideDataType !== null) {
                sideDataTypes.push(sideDataType);
            }
        }
        frames.push({ sideDataTypes, streamIndex });
    }
    return frames;
}
