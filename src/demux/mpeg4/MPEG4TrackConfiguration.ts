import { PacketReader, type InputVideoTrack, type VideoCodec } from 'mediabunny';

import { BITMAP_INFO_HEADER_BYTE_LENGTH, createBitmapInfoHeaderCodecPrivate, formatFourCC } from '../BitmapInfoHeader';
import { readMatroskaMPEGVideoDecoderDescription } from '../mpeg/MatroskaMPEGVideoConfiguration';
import { MATROSKA_VFW_CODEC_ID, readMatroskaVFWCodecPrivate } from '../vc1/MatroskaVFWVideoConfiguration';
import { createMPEG4PresentationOrderTrack, readMPEG4VideoObjectLayerSyntax } from './MPEG4PresentationOrder';

/** The engine's codecs of the decoders FFmpeg builds on its MPEG-4 Part 2 code: MPEG-4 Part 2 itself, H.263, and the three MS-MPEG4 versions. */
export type MPEG4TrackCodec = 'h263' | 'mpeg4' | 'msmpeg4v1' | 'msmpeg4v2' | 'msmpeg4v3';

/** What the GPU decoder of these codecs reads for a track: its codec private data and the track its packets come from, or the check that failed, as `code: detail`. */
export type MPEG4TrackConfiguration =
    | Readonly<{ description: Uint8Array, status: 'read', videoTrack: InputVideoTrack }>
    | Readonly<{ failure: string, status: 'failed' }>;

/** Where a track is read from, as the worker opened it: an AVI track's codec ID is its strf FourCC. */
export type MPEG4TrackSource = Readonly<{
    avi: boolean
    codedHeight: number
    codedWidth: number
    /** The codec Mediabunny names for the track, mpeg4 for the MPEG-4 Part 2 tracks it maps, or null */
    containerCodec: VideoCodec | null
    internalCodecID: string
}>;

/** The FourCC and extradata the codec private data carries, and whether the track stamps its packets in decode order. */
type MPEG4TrackStream =
    | Readonly<{ decodeOrder: boolean, extradata: Uint8Array, fourCC: string, status: 'read' }>
    | Readonly<{ failure: string, status: 'failed' }>;

// Matroska's codec IDs of MPEG-4 Part 2 in the Simple, Advanced Simple, and Advanced profiles, which Mediabunny names mpeg4, and of MS-MPEG4 version 3
const MATROSKA_MPEG4_PART2_CODEC_IDS: readonly string[] = Object.freeze([ 'V_MPEG4/ISO/SP', 'V_MPEG4/ISO/ASP', 'V_MPEG4/ISO/AP' ]);
const MATROSKA_MSMPEG4V3_CODEC_ID = 'V_MPEG4/MS/V3';
// ISO base media sample entries: mp4v, which Mediabunny names mpeg4 when its esds declares MPEG-4 Visual, and H.263's s263 and h263
const ISO_BASE_MEDIA_MPEG4_PART2_SAMPLE_ENTRY = 'mp4v';
const ISO_BASE_MEDIA_H263_SAMPLE_ENTRIES: readonly string[] = Object.freeze([ 's263', 'h263' ]);
// The FourCCs FFmpeg's codec_tag holds for tracks that carry none: its MPEG-4 Part 2 and H.263 sample entries, and MS-MPEG4 version 3's FourCC
const MPEG4_PART2_DEFAULT_FOURCC = 'mp4v';
const H263_DEFAULT_FOURCC = 's263';
const MSMPEG4V3_DEFAULT_FOURCC = 'MP43';
const EMPTY_EXTRADATA = new Uint8Array(0);

/** The codec IDs of the tracks besides AVI's each codec's route reads: Matroska's own and VfW tracks, and ISO base media sample entries. */
export const MPEG4_TRACK_INTERNAL_CODEC_IDS: Readonly<Record<MPEG4TrackCodec, readonly string[]>> = Object.freeze({
    h263: Object.freeze([ MATROSKA_VFW_CODEC_ID, ...ISO_BASE_MEDIA_H263_SAMPLE_ENTRIES ]),
    mpeg4: Object.freeze([ ...MATROSKA_MPEG4_PART2_CODEC_IDS, MATROSKA_VFW_CODEC_ID, ISO_BASE_MEDIA_MPEG4_PART2_SAMPLE_ENTRY ]),
    msmpeg4v1: Object.freeze([ MATROSKA_VFW_CODEC_ID ]),
    msmpeg4v2: Object.freeze([ MATROSKA_VFW_CODEC_ID ]),
    msmpeg4v3: Object.freeze([ MATROSKA_VFW_CODEC_ID, MATROSKA_MSMPEG4V3_CODEC_ID ])
});

// FFmpeg's FourCCs of each codec in libavformat/riff.c, and s263 from isom_tags.c, upper-cased as its tag lookups compare them
const MPEG4_TRACK_CODEC_FOURCCS: Readonly<Record<MPEG4TrackCodec, readonly string[]>> = Object.freeze({
    h263: Object.freeze([ 'H263', 'X263', 'T263', 'L263', 'VX1K', 'ZYGO', 'M263', 'LSVM', 'U263', 'VSM4', 'S263' ]),
    mpeg4: Object.freeze([
        'FMP4', 'DIVX', 'DX50', 'XVID', 'MP4S', 'M4S2', 'ZMP4', 'DIV1', 'BLZ0', 'MP4V', 'UMP4', 'WV1F', 'SEDG', 'RMP4', '3IV2', 'WAWV', 'FFDS',
        'FVFW', 'DCOD', 'MVXM', 'PM4V', 'SMP4', 'DXGM', 'VIDM', 'M4T3', 'GEOX', 'G264', 'HDX4', 'DM4V', 'DMK2', 'DYM4', 'DIGI', 'EPHV', 'EM4A',
        'M4CC', 'SN40', 'VSPX', 'ULDX', 'GEOV', 'SIPP', 'SM4V', 'XVIX', 'DREX', 'QMP4', 'PLV1', 'GLV4', 'GMP4', 'MNM4', 'GTM4'
    ]),
    msmpeg4v1: Object.freeze([ 'MPG4', 'MP41' ]),
    msmpeg4v2: Object.freeze([ 'MP42', 'DIV2' ]),
    msmpeg4v3: Object.freeze([ 'MP43', 'DIV3', 'MPG3', 'DIV5', 'DIV6', 'DIV4', 'DVX3', 'AP41', 'COL1', 'COL0' ])
});

function fail(failure: string): Readonly<{ failure: string, status: 'failed' }> {
    return { failure, status: 'failed' };
}

/** Returns whether a FourCC is one FFmpeg maps to a codec, compared upper-cased as FFmpeg's avpriv_toupper4 compares it. */
function isCodecFourCC(codec: MPEG4TrackCodec, fourCC: string): boolean {
    return MPEG4_TRACK_CODEC_FOURCCS[codec].includes(fourCC.toUpperCase());
}

/** Returns a copy of the decoder description Mediabunny gives a track it names: MPEG-4 Part 2's CodecPrivate, esds DecoderSpecificInfo, or strf extradata. */
async function readMediabunnyExtradata(track: InputVideoTrack): Promise<Uint8Array> {
    const description = (await track.getDecoderConfig())?.description;
    if (description === undefined) {
        return EMPTY_EXTRADATA;
    }
    return ArrayBuffer.isView(description) ?
        new Uint8Array(description.buffer, description.byteOffset, description.byteLength).slice() :
        new Uint8Array(description).slice();
}

/** Reads an AVI track: its FourCC must be one of the codec's, and only a track Mediabunny names has its strf extradata as a description. */
async function readAVITrackStream(codec: MPEG4TrackCodec, track: InputVideoTrack, source: MPEG4TrackSource): Promise<MPEG4TrackStream> {
    if (!isCodecFourCC(codec, source.internalCodecID)) {
        return fail(`fourcc: ${formatFourCC(source.internalCodecID)}`);
    }
    const extradata = source.containerCodec === null ? EMPTY_EXTRADATA : await readMediabunnyExtradata(track);
    return { decodeOrder: true, extradata, fourCC: source.internalCodecID, status: 'read' };
}

/** Reads a Matroska or ISO base media track by its codec ID; a VfW track's FourCC must be one of the codec's, and the others get FFmpeg's default. */
async function readContainerTrackStream(codec: MPEG4TrackCodec, track: InputVideoTrack, source: MPEG4TrackSource): Promise<MPEG4TrackStream> {
    if (!MPEG4_TRACK_INTERNAL_CODEC_IDS[codec].includes(source.internalCodecID)) {
        return fail(`codec-id: ${source.internalCodecID}`);
    }
    if (source.internalCodecID === MATROSKA_VFW_CODEC_ID) {
        const codecPrivate = readMatroskaVFWCodecPrivate(track);
        if (codecPrivate.status === 'failed') {
            return codecPrivate;
        }
        if (!isCodecFourCC(codec, codecPrivate.fourCC)) {
            return fail(`fourcc: ${codecPrivate.fourCC}`);
        }
        return { decodeOrder: true, extradata: codecPrivate.extradata, fourCC: codecPrivate.fourCC, status: 'read' };
    }
    if (source.internalCodecID === MATROSKA_MSMPEG4V3_CODEC_ID) {
        const extradata = readMatroskaMPEGVideoDecoderDescription(track) ?? EMPTY_EXTRADATA;
        return { decodeOrder: false, extradata, fourCC: MSMPEG4V3_DEFAULT_FOURCC, status: 'read' };
    }
    if (codec === 'h263') {
        return { decodeOrder: false, extradata: EMPTY_EXTRADATA, fourCC: H263_DEFAULT_FOURCC, status: 'read' };
    }
    // Mediabunny names MPEG-4 Part 2 in V_MPEG4/ISO tracks, and in mp4v sample entries whose esds declares MPEG-4 Visual
    if (source.containerCodec !== 'mpeg4') {
        return fail(`container-codec: ${String(source.containerCodec)}`);
    }
    return { decodeOrder: false, extradata: await readMediabunnyExtradata(track), fourCC: MPEG4_PART2_DEFAULT_FOURCC, status: 'read' };
}

/** Returns the track an MPEG-4 Part 2 stream in decode order presents through, by the video object layer of its extradata or else its first key packet. */
async function createPresentationTrack(track: InputVideoTrack, extradata: Uint8Array): Promise<InputVideoTrack | null> {
    let syntax = readMPEG4VideoObjectLayerSyntax(extradata);
    if (!syntax) {
        const keyPacket = await new PacketReader(track).getFirstKey();
        syntax = keyPacket ? readMPEG4VideoObjectLayerSyntax(keyPacket.data) : null;
    }
    // A stream without a video object layer cannot be decoded, and its decoder reports that
    return syntax ? createMPEG4PresentationOrderTrack(track, syntax) : track;
}

/**
 * Returns the codec private data an MPEG-4 Part 2, H.263, or MS-MPEG4 track gives its GPU decoder, and the track to read its packets from.
 * The codec private data is a 40-byte BITMAPINFOHEADER of the container's coded size and the track's FourCC, by which the decoder picks its codec and
 * FFmpeg's workarounds, then the track's extradata.
 * AVI and Matroska VfW tracks stamp their packets in decode order, so MPEG-4 Part 2 from them comes through a track that restamps B-VOP streams in
 * presentation order, as FFmpeg's decoder outputs them; H.263 and MS-MPEG4 code no B pictures, and the other tracks stamp presentation times.
 */
export async function readMPEG4TrackConfiguration(
    codec: MPEG4TrackCodec,
    track: InputVideoTrack,
    source: MPEG4TrackSource
): Promise<MPEG4TrackConfiguration> {
    const stream = source.avi ? await readAVITrackStream(codec, track, source) : await readContainerTrackStream(codec, track, source);
    if (stream.status === 'failed') {
        return stream;
    }
    const description = createBitmapInfoHeaderCodecPrivate(
        stream.fourCC,
        source.codedWidth,
        source.codedHeight,
        stream.extradata,
        BITMAP_INFO_HEADER_BYTE_LENGTH
    );
    if (codec !== 'mpeg4' || !stream.decodeOrder) {
        return { description, status: 'read', videoTrack: track };
    }
    const videoTrack = await createPresentationTrack(track, stream.extradata);
    if (!videoTrack) {
        return fail('presentation-order: unexpected track backing');
    }
    return { description, status: 'read', videoTrack };
}
