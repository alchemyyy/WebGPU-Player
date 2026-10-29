// @vitest-environment node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import {
    readWaveFormatAudioCodec,
    readWaveFormatAudioTrack,
    WAVE_FORMAT_HEADER_BYTE_LENGTH,
    type WaveFormatAudioTrackResult
} from 'webgpu-player/demux/WaveFormatAudioConfiguration';

import { createASF } from '../helpers/asfMedia';
import { DECODERS_DIRECTORY } from '../helpers/enginePaths';

// The wma decoder project's vectors: FFmpeg's WMA v1 and v2 in AVI and remuxed to Matroska, and FATE's WMA Pro, Lossless, and Voice in Matroska
const WMA_VECTORS_DIRECTORY = join(DECODERS_DIRECTORY, 'wma', 'vectors');
const WAVE_FORMAT_EXTENSIBLE_HEADER_TAG = 0xFFFE;

/** Opens a vector and reads its first audio track's codec, codec ID, and WAVEFORMATEX as the worker does. */
async function readVectorTrack(fileName: string): Promise<{ codec: unknown, internalCodecID: unknown, result: WaveFormatAudioTrackResult | null }> {
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(readFileSync(join(WMA_VECTORS_DIRECTORY, fileName))) });
    try {
        const [ track ] = await input.getAudioTracks();
        return { codec: await track.getCodec(), internalCodecID: await track.getInternalCodecId(), result: readWaveFormatAudioTrack(track) };
    } finally {
        input.dispose();
    }
}

describe('readWaveFormatAudioTrack on the wma project\'s vectors', () => {
    it.each([
        [ 'wmav1.mkv', 'A_MS/ACM', 'wmav1' ],
        [ 'wmav2.mkv', 'A_MS/ACM', 'wmav2' ],
        [ 'wmapro-5.1.mkv', 'A_MS/ACM', 'wmapro' ],
        [ 'wmalossless-16.mkv', 'A_MS/ACM', 'wmalossless' ],
        [ 'wmavoice.mkv', 'A_MS/ACM', 'wmavoice' ],
        // The fork keeps an AVI stream of a format tag it maps no codec to, with the tag in decimal as its codec ID
        [ 'wmav1.avi', '352', 'wmav1' ],
        [ 'wmav2.avi', '353', 'wmav2' ]
    ] as const)('reads %s, a codec-less %s track, as %s', async (fileName, internalCodecID, codec) => {
        const track = await readVectorTrack(fileName);

        expect(track).toMatchObject({ codec: null, internalCodecID, result: { codec, status: 'read' } });
    });

    it('writes an AVI stream\'s WAVEFORMATEX back as the bytes Matroska carries of the same stream', async () => {
        for (const codec of [ 'wmav1', 'wmav2' ]) {
            const [ avi, matroska ] = await Promise.all([ readVectorTrack(`${codec}.avi`), readVectorTrack(`${codec}.mkv`) ]);

            expect(avi.result?.status).toBe('read');
            expect(avi.result).toEqual(matroska.result);
        }
    });

    it.each([ 'wmav1', 'wmav2', 'wmapro-5.1', 'wmalossless-16', 'wmavoice' ])(
        'reads the WAVEFORMATEX of an ASF stream of %s as the bytes Matroska carries of the same stream',
        async (name: string) => {
            const matroska = await readVectorTrack(`${name}.mkv`);
            if (matroska.result?.status !== 'read') {
                throw new Error(`The ${name} vector has no WAVEFORMATEX`);
            }
            const asf = createASF([ { kind: 'audio', waveFormat: matroska.result.waveFormat } ], [
                { data: new Uint8Array(16), keyframe: true, streamIndex: 0, timestampMilliseconds: 0 }
            ]);
            const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(asf) });
            try {
                const [ track ] = await input.getAudioTracks();

                // The fork keeps an ASF stream of a format tag it maps no codec to, with the tag in decimal as its codec ID, as for AVI
                expect(await track.getCodec()).toBeNull();
                expect(readWaveFormatAudioTrack(track)).toEqual(matroska.result);
            } finally {
                input.dispose();
            }
        }
    );

    it('keeps a WAVE_FORMAT_EXTENSIBLE header whole, which names WMA Pro by its SubFormat', async () => {
        const { result } = await readVectorTrack('wmapro-5.1.mkv');

        expect(result?.status === 'read' && new DataView(result.waveFormat.buffer, result.waveFormat.byteOffset).getUint16(0, true))
            .toBe(WAVE_FORMAT_EXTENSIBLE_HEADER_TAG);
    });
});

// FFmpeg's libavformat/riff.c ff_codec_wav_tags
const FORMAT_TAG_CODECS = [
    [ 0x0160, 'wmav1' ],
    [ 0x0161, 'wmav2' ],
    [ 0x0162, 'wmapro' ],
    [ 0x0163, 'wmalossless' ],
    [ 0x000A, 'wmavoice' ]
] as const;
const WAVE_FORMAT_MPEG_LAYER_3 = 0x0055;
const WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
const WMA_PRO_TAG = 0x0162;
// The media subtype base, which KSDATAFORMAT_SUBTYPE GUIDs carry a format tag before
const MEDIA_SUBTYPE_BASE = [ 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71 ];
// KSDATAFORMAT_SUBTYPE_IEC61937_DOLBY_DIGITAL, a GUID of another base
const DOLBY_DIGITAL_SUBFORMAT = [ 0x2C, 0x80, 0x6D, 0xE0, 0x46, 0xDB, 0xCF, 0x11, 0xB4, 0xD1, 0x00, 0x80, 0x5F, 0x6C, 0xBB, 0xEA ];
// The 10 bytes FFmpeg's WMA v2 encoder writes as its extradata
const WMA_V2_EXTRADATA = [ 0x00, 0x00, 0x00, 0x00, 0x0F, 0x00, 0x00, 0x00, 0x00, 0x00 ];
const FIVE_POINT_ONE_BACK_CHANNEL_MASK = 0x3F;
// CodecPrivate bytes after the WAVEFORMATEX, past the 1 MiB the audio decode worker takes as codec private data
const TRAILING_BYTE_LENGTH = 2 * 1024 * 1024;

/** Writes a WAVEFORMATEX of 44.1 kHz stereo with a tag, then the bytes cbSize counts, whose cbSize may be given apart from them. */
function createWaveFormat(tag: number, extension: readonly number[], declaredExtensionByteLength = extension.length): Uint8Array {
    const waveFormat = new Uint8Array(WAVE_FORMAT_HEADER_BYTE_LENGTH + extension.length);
    const view = new DataView(waveFormat.buffer);
    view.setUint16(0, tag, true);
    view.setUint16(2, 2, true);
    view.setUint32(4, 44_100, true);
    view.setUint32(8, 8_000, true);
    view.setUint16(12, 371, true);
    view.setUint16(14, 16, true);
    view.setUint16(16, declaredExtensionByteLength, true);
    waveFormat.set(extension, WAVE_FORMAT_HEADER_BYTE_LENGTH);
    return waveFormat;
}

/** Writes WAVE_FORMAT_EXTENSIBLE's fields: valid bits, a channel mask, and a SubFormat GUID. */
function createExtensibleFields(subFormat: readonly number[]): number[] {
    const fields = new Uint8Array(6);
    const view = new DataView(fields.buffer);
    view.setUint16(0, 16, true);
    view.setUint32(2, FIVE_POINT_ONE_BACK_CHANNEL_MASK, true);
    return [ ...fields, ...subFormat ];
}

describe('readWaveFormatAudioCodec', () => {
    it.each(FORMAT_TAG_CODECS)('names format tag %i %s, as FFmpeg\'s RIFF tags do, and keeps the WAVEFORMATEX whole', (tag, codec) => {
        const waveFormat = createWaveFormat(tag, WMA_V2_EXTRADATA);

        expect(readWaveFormatAudioCodec(waveFormat)).toEqual({ codec, status: 'read', waveFormat });
    });

    it('names a WAVE_FORMAT_EXTENSIBLE header by the tag its SubFormat carries', () => {
        const subFormat = [ WMA_PRO_TAG & 0xFF, WMA_PRO_TAG >> 8, 0x00, 0x00, ...MEDIA_SUBTYPE_BASE ];
        const waveFormat = createWaveFormat(WAVE_FORMAT_EXTENSIBLE, [ ...createExtensibleFields(subFormat), ...WMA_V2_EXTRADATA ]);

        expect(readWaveFormatAudioCodec(waveFormat)).toEqual({ codec: 'wmapro', status: 'read', waveFormat });
    });

    it('keeps only the header and the cbSize bytes after it, as a copy, so bytes after them, however many, never reach the decoder', () => {
        const waveFormat = createWaveFormat(WMA_PRO_TAG, WMA_V2_EXTRADATA);
        const codecPrivate = new Uint8Array(waveFormat.byteLength + TRAILING_BYTE_LENGTH);
        codecPrivate.set(waveFormat);

        const result = readWaveFormatAudioCodec(codecPrivate);
        codecPrivate.fill(0);

        expect(result).toEqual({ codec: 'wmapro', status: 'read', waveFormat });
    });

    it('refuses a tag no package of the engine\'s codecs decodes, and a SubFormat that carries no tag', () => {
        expect(readWaveFormatAudioCodec(createWaveFormat(WAVE_FORMAT_MPEG_LAYER_3, []))).toEqual({ failure: 'format-tag: 0x0055', status: 'failed' });
        expect(readWaveFormatAudioCodec(createWaveFormat(WAVE_FORMAT_EXTENSIBLE, createExtensibleFields(DOLBY_DIGITAL_SUBFORMAT))))
            .toEqual({ failure: 'format-tag: SubFormat GUID', status: 'failed' });
    });

    it('refuses a header shorter than its 18 bytes, extension bytes it declares but lacks, and WAVE_FORMAT_EXTENSIBLE without its fields', () => {
        const shortWaveFormat = createWaveFormat(WMA_PRO_TAG, []).subarray(0, WAVE_FORMAT_HEADER_BYTE_LENGTH - 2);

        expect(readWaveFormatAudioCodec(shortWaveFormat)).toEqual({ failure: 'wave-format-size: 16', status: 'failed' });
        expect(readWaveFormatAudioCodec(createWaveFormat(WMA_PRO_TAG, WMA_V2_EXTRADATA, WMA_V2_EXTRADATA.length + 1)))
            .toEqual({ failure: 'wave-format-size: 28, cbSize 11', status: 'failed' });
        expect(readWaveFormatAudioCodec(createWaveFormat(WAVE_FORMAT_EXTENSIBLE, WMA_V2_EXTRADATA)))
            .toEqual({ failure: `wave-format-extensible-size: ${WMA_V2_EXTRADATA.length}`, status: 'failed' });
    });
});
