// Parses an audio decoder package's `//!` header: what it decodes, the attributes it reports, the options it takes, and its error names.
// The header follows the video decoder header's syntax; the engine's book describes both.
import { DecoderHeaderError, readDecoderHeader, type DecoderHeaderDirective } from '../packages/DecoderHeader';
import { findDecoderPackageIdFailure } from '../packages/DecoderPackageIdentity';
import { KIBIBYTE, MEBIBYTE } from '../video/gpu/GPUDecodeLimits';

/** A parsed audio decoder header. */
export type AudioDecoderManifest = Readonly<{
    /** Codec-specific facts the module reports, by key, such as `bitsPerSample` with each block */
    attributes: ReadonlyMap<number, string>
    /** The codecs it decodes, by the engine's codec names; create() takes the position of one */
    codecs: readonly string[]
    /** The names of its error codes */
    errors: ReadonlyMap<number, string>
    /** The package's id, which its versions share, and which hosts store it by */
    id: string
    name: string
    /** Codec-specific settings a host may set, by key, such as an exact qualification's `pcmFingerprint` */
    options: ReadonlyMap<number, string>
    /** The largest packet it takes */
    packetByteLength: number
}>;

/** The option an object audio package declares to take the WAVE channel mask of the playback's output layout, which it renders object audio into */
export const AUDIO_DECODER_RENDER_CHANNEL_MASK_OPTION = 'renderChannelMask';
/** The option an object audio package declares to render binaural stereo for headphones: 1 on, 0 off */
export const AUDIO_DECODER_RENDER_BINAURAL_OPTION = 'renderBinaural';
/** The attribute an object audio package reports per block: how many dynamic objects it rendered, 0 for a stock decode */
export const AUDIO_DECODER_OBJECT_COUNT_ATTRIBUTE = 'objectCount';

/** The most dynamic objects a block may report rendering; a larger `objectCount` is corrupt */
export const AUDIO_DECODER_MAXIMUM_OBJECT_COUNT = 1_024;

/** Validates a block's `objectCount`: a whole number of objects within AUDIO_DECODER_MAXIMUM_OBJECT_COUNT. */
export function isAudioDecoderObjectCount(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= AUDIO_DECODER_MAXIMUM_OBJECT_COUNT;
}

/** Reports whether a manifest declares an option, such as an object audio package's `renderChannelMask`. */
export function declaresAudioDecoderOption(manifest: AudioDecoderManifest, name: string): boolean {
    return [ ...manifest.options.values() ].includes(name);
}

/** The check an audio decoder header failed. */
export type AudioDecoderManifestErrorCode =
    | 'accepts-syntax'
    | 'attribute-duplicate'
    | 'attribute-syntax'
    | 'codec-duplicate'
    | 'codec-syntax'
    | 'decoder-kind'
    | 'directive-missing'
    | 'directive-repeated'
    | 'directive-unknown'
    | 'error-duplicate'
    | 'error-syntax'
    | 'header-missing'
    | 'header-syntax'
    | 'id-length'
    | 'id-syntax'
    | 'name-empty'
    | 'option-duplicate'
    | 'option-syntax'
    | 'packet-size'
    | 'packet-syntax';

/** A malformed audio decoder header: the failed check, a terse detail, and the 1-based source line. */
export class AudioDecoderManifestError extends Error {
    readonly code: AudioDecoderManifestErrorCode;
    readonly detail: string;
    readonly line: number;

    constructor(code: AudioDecoderManifestErrorCode, detail: string, line: number) {
        super(`${code}: ${detail}`);
        this.name = 'AudioDecoderManifestError';
        this.code = code;
        this.detail = detail;
        this.line = line;
    }
}

/** The largest packet an audio decoder takes unless its header says otherwise. */
export const AUDIO_DECODER_DEFAULT_PACKET_BYTE_LENGTH = 2 * MEBIBYTE;

/** The largest packet an audio decoder may declare. */
export const AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH = 16 * MEBIBYTE;

const AUDIO_DECODER_KIND = 'audio';
const ACCEPTS_PATTERN = /^codec\s+in\s+\[([^\]]*)\]$/;
const CODEC_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*$/;
const COUNT_PATTERN = /^\d+$/;
const SIZE_PATTERN = /^(\d+)\s*(B|KiB|MiB)?$/;
const PAIR_PART_COUNT = 2;
const MINIMUM_KEY = 1;
const MAXIMUM_KEY = 255;
const MINIMUM_PACKET_BYTE_LENGTH = 1;
const REPEATABLE_DIRECTIVES: ReadonlySet<string> = new Set([ 'attribute', 'error', 'option' ]);
const REQUIRED_DIRECTIVES: readonly string[] = [ 'id', 'name', 'decoder', 'accepts' ];

type ManifestDraft = {
    attributes: Map<number, string>
    codecs: string[] | null
    errors: Map<number, string>
    id: string
    name: string
    options: Map<number, string>
    packetByteLength: number
};

function quote(text: string): string {
    return `'${text}'`;
}

function splitList(text: string): string[] {
    return text.split(',').map((part: string): string => part.trim());
}

function parseCodecs(value: string, line: number): string[] {
    const match = ACCEPTS_PATTERN.exec(value);
    if (!match) {
        throw new AudioDecoderManifestError('accepts-syntax', quote(value), line);
    }
    const codecs: string[] = [];
    for (const codec of splitList(match[1])) {
        if (!CODEC_PATTERN.test(codec)) {
            throw new AudioDecoderManifestError('codec-syntax', quote(codec), line);
        }
        if (codecs.includes(codec)) {
            throw new AudioDecoderManifestError('codec-duplicate', quote(codec), line);
        }
        codecs.push(codec);
    }
    return codecs;
}

/** Parses `<key>, <name>` with a key from 1 to 255 into a map that names each key once. */
function parseNamedKey(
    value: string,
    line: number,
    names: Map<number, string>,
    syntaxCode: AudioDecoderManifestErrorCode,
    duplicateCode: AudioDecoderManifestErrorCode
): void {
    const parts = splitList(value);
    if (parts.length !== PAIR_PART_COUNT || !COUNT_PATTERN.test(parts[0]) || !IDENTIFIER_PATTERN.test(parts[1])) {
        throw new AudioDecoderManifestError(syntaxCode, quote(value), line);
    }
    const key = Number(parts[0]);
    if (key < MINIMUM_KEY || key > MAXIMUM_KEY) {
        throw new AudioDecoderManifestError(syntaxCode, `${key} outside [${MINIMUM_KEY}, ${MAXIMUM_KEY}]`, line);
    }
    if (names.has(key) || [ ...names.values() ].includes(parts[1])) {
        throw new AudioDecoderManifestError(duplicateCode, quote(value), line);
    }
    names.set(key, parts[1]);
}

function parsePacketByteLength(value: string, line: number): number {
    const match = SIZE_PATTERN.exec(value);
    if (!match) {
        throw new AudioDecoderManifestError('packet-syntax', quote(value), line);
    }
    let unitByteLength = 1;
    if (match[2] === 'KiB') {
        unitByteLength = KIBIBYTE;
    } else if (match[2] === 'MiB') {
        unitByteLength = MEBIBYTE;
    }
    const byteLength = Number(match[1]) * unitByteLength;
    if (byteLength < MINIMUM_PACKET_BYTE_LENGTH || byteLength > AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH) {
        throw new AudioDecoderManifestError('packet-size', `${byteLength} outside [${MINIMUM_PACKET_BYTE_LENGTH}, ${AUDIO_DECODER_MAXIMUM_PACKET_BYTE_LENGTH}]`, line);
    }
    return byteLength;
}

function applyDirective(draft: ManifestDraft, directive: DecoderHeaderDirective): void {
    const { line, value } = directive;
    switch (directive.name) {
        case 'id': {
            const failure = findDecoderPackageIdFailure(value);
            if (failure) {
                throw new AudioDecoderManifestError(failure.code, failure.detail, line);
            }
            draft.id = value;
            return;
        }
        case 'name':
            if (value.length === 0) {
                throw new AudioDecoderManifestError('name-empty', quote(value), line);
            }
            draft.name = value;
            return;
        case 'decoder':
            if (value !== AUDIO_DECODER_KIND) {
                throw new AudioDecoderManifestError('decoder-kind', quote(value), line);
            }
            return;
        case 'accepts':
            draft.codecs = parseCodecs(value, line);
            return;
        case 'attribute':
            parseNamedKey(value, line, draft.attributes, 'attribute-syntax', 'attribute-duplicate');
            return;
        case 'error':
            parseNamedKey(value, line, draft.errors, 'error-syntax', 'error-duplicate');
            return;
        case 'option':
            parseNamedKey(value, line, draft.options, 'option-syntax', 'option-duplicate');
            return;
        case 'packet':
            draft.packetByteLength = parsePacketByteLength(value, line);
            return;
        default:
            throw new AudioDecoderManifestError('directive-unknown', quote(directive.name), line);
    }
}

/** Reads the header, reporting a line that is no directive as the 'header-syntax' check. */
function readHeader(lines: readonly string[]): DecoderHeaderDirective[] {
    try {
        return readDecoderHeader(lines).directives;
    } catch (error) {
        if (error instanceof DecoderHeaderError) {
            throw new AudioDecoderManifestError('header-syntax', error.detail, error.line);
        }
        throw error;
    }
}

/** Parses an audio decoder's `//!` header; anything after it is ignored, since an audio decoder has no WGSL. Throws an AudioDecoderManifestError. */
export function parseAudioDecoderManifest(source: string): AudioDecoderManifest {
    const lines = source.split(/\r?\n/);
    const directives = readHeader(lines);
    if (directives.length === 0) {
        throw new AudioDecoderManifestError('header-missing', quote(lines[0] ?? ''), 1);
    }
    const seen = new Set<string>();
    for (const directive of directives) {
        if (seen.has(directive.name) && !REPEATABLE_DIRECTIVES.has(directive.name)) {
            throw new AudioDecoderManifestError('directive-repeated', quote(directive.name), directive.line);
        }
        seen.add(directive.name);
    }
    for (const required of REQUIRED_DIRECTIVES) {
        if (!seen.has(required)) {
            throw new AudioDecoderManifestError('directive-missing', quote(required), 1);
        }
    }
    const draft: ManifestDraft = {
        attributes: new Map<number, string>(),
        codecs: null,
        errors: new Map<number, string>(),
        id: '',
        name: '',
        options: new Map<number, string>(),
        packetByteLength: AUDIO_DECODER_DEFAULT_PACKET_BYTE_LENGTH
    };
    for (const directive of directives) {
        applyDirective(draft, directive);
    }
    if (!draft.codecs) {
        throw new AudioDecoderManifestError('directive-missing', quote('accepts'), 1);
    }
    return {
        attributes: draft.attributes,
        codecs: draft.codecs,
        errors: draft.errors,
        id: draft.id,
        name: draft.name,
        options: draft.options,
        packetByteLength: draft.packetByteLength
    };
}
