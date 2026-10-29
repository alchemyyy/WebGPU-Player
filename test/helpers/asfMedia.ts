// A synthetic ASF file builder, as the ASF specification lays one out: a Header Object of File Properties and Stream Properties Objects, then a Data
// Object of fixed-size data packets of one payload each, a media object split across packets as needed

import { concatenate } from './byteArrays';

/** A stream of a synthetic ASF file, by its format: a BITMAPINFOHEADER and its extradata, or a WAVEFORMATEX and its extradata. */
export type SyntheticASFStream =
    | Readonly<{ bitmapInfoHeader: Uint8Array, codedHeight: number, codedWidth: number, kind: 'video' }>
    | Readonly<{ kind: 'audio', waveFormat: Uint8Array }>;

/** A media object of a synthetic ASF file, in the stream at an index of the file's streams. */
export type SyntheticASFObject = Readonly<{
    data: Uint8Array
    keyframe: boolean
    streamIndex: number
    /** Milliseconds, before the preroll the file adds */
    timestampMilliseconds: number
}>;

// The GUIDs of the ASF specification, as a file stores them
const HEADER_OBJECT = [ 0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C ];
const DATA_OBJECT = [ 0x36, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C ];
const FILE_PROPERTIES_OBJECT = [ 0xA1, 0xDC, 0xAB, 0x8C, 0x47, 0xA9, 0xCF, 0x11, 0x8E, 0xE4, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65 ];
const STREAM_PROPERTIES_OBJECT = [ 0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65 ];
const AUDIO_MEDIA = [ 0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B ];
const VIDEO_MEDIA = [ 0xC0, 0xEF, 0x19, 0xBC, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B ];
const NO_ERROR_CORRECTION = [ 0x00, 0x57, 0xFB, 0x20, 0x55, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B ];
const OBJECT_HEADER_BYTE_LENGTH = 24;
const FILE_PROPERTIES_BYTE_LENGTH = 104;
const DATA_OBJECT_HEADER_BYTE_LENGTH = 50;
const STREAM_PROPERTIES_FIELDS_BYTE_LENGTH = 54;
const VIDEO_TYPE_SPECIFIC_HEADER_BYTE_LENGTH = 11;
const SEEKABLE_FLAG = 0x02;
const PACKET_BYTE_LENGTH = 512;
const PREROLL_MILLISECONDS = 3_100;
// The payload parsing information: a word of padding length, no sequence, and the packet's length implicit; then byte stream numbers, byte media
// object numbers, double word offsets, and byte replicated data lengths
const LENGTH_TYPE_FLAGS = 0x10;
const PROPERTY_FLAGS = 0x5D;
const PACKET_HEADER_BYTE_LENGTH = 10;
const REPLICATED_DATA_BYTE_LENGTH = 8;
const PAYLOAD_HEADER_BYTE_LENGTH = 7 + REPLICATED_DATA_BYTE_LENGTH;
const PAYLOAD_CAPACITY = PACKET_BYTE_LENGTH - PACKET_HEADER_BYTE_LENGTH - PAYLOAD_HEADER_BYTE_LENGTH;
const KEY_FRAME_FLAG = 0x80;

function writeObject(guid: readonly number[], body: Uint8Array): Uint8Array {
    const object = new Uint8Array(OBJECT_HEADER_BYTE_LENGTH + body.byteLength);
    object.set(guid);
    new DataView(object.buffer).setBigUint64(16, BigInt(object.byteLength), true);
    object.set(body, OBJECT_HEADER_BYTE_LENGTH);
    return object;
}

function createFileProperties(packetCount: number, playDurationMilliseconds: number): Uint8Array {
    const body = new Uint8Array(FILE_PROPERTIES_BYTE_LENGTH - OBJECT_HEADER_BYTE_LENGTH);
    const view = new DataView(body.buffer);
    // The file ID, file size, and creation date stay zero
    view.setBigUint64(32, BigInt(packetCount), true);
    view.setBigUint64(40, BigInt((playDurationMilliseconds + PREROLL_MILLISECONDS) * 10_000), true);
    view.setBigUint64(48, BigInt(playDurationMilliseconds * 10_000), true);
    view.setBigUint64(56, BigInt(PREROLL_MILLISECONDS), true);
    view.setUint32(64, SEEKABLE_FLAG, true);
    view.setUint32(68, PACKET_BYTE_LENGTH, true);
    view.setUint32(72, PACKET_BYTE_LENGTH, true);
    return writeObject(FILE_PROPERTIES_OBJECT, body);
}

function createStreamProperties(stream: SyntheticASFStream, streamNumber: number): Uint8Array {
    let typeSpecific: Uint8Array;
    if (stream.kind === 'video') {
        typeSpecific = new Uint8Array(VIDEO_TYPE_SPECIFIC_HEADER_BYTE_LENGTH + stream.bitmapInfoHeader.byteLength);
        const view = new DataView(typeSpecific.buffer);
        view.setUint32(0, stream.codedWidth, true);
        view.setUint32(4, stream.codedHeight, true);
        view.setUint8(8, 2);
        view.setUint16(9, stream.bitmapInfoHeader.byteLength, true);
        typeSpecific.set(stream.bitmapInfoHeader, VIDEO_TYPE_SPECIFIC_HEADER_BYTE_LENGTH);
    } else {
        typeSpecific = stream.waveFormat;
    }
    const fields = new Uint8Array(STREAM_PROPERTIES_FIELDS_BYTE_LENGTH);
    fields.set(stream.kind === 'video' ? VIDEO_MEDIA : AUDIO_MEDIA);
    fields.set(NO_ERROR_CORRECTION, 16);
    const view = new DataView(fields.buffer);
    view.setUint32(40, typeSpecific.byteLength, true);
    view.setUint16(48, streamNumber, true);
    return writeObject(STREAM_PROPERTIES_OBJECT, concatenate([ fields, typeSpecific ]));
}

/** Writes a media object into data packets, one payload each, its fragments carrying the object's size and presentation time. */
function createDataPackets(object: SyntheticASFObject, streamNumber: number, objectNumber: number): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const presentationTime = object.timestampMilliseconds + PREROLL_MILLISECONDS;
    for (let offset = 0; offset < object.data.byteLength || offset === 0; offset += PAYLOAD_CAPACITY) {
        const fragment = object.data.subarray(offset, offset + PAYLOAD_CAPACITY);
        const packet = new Uint8Array(PACKET_BYTE_LENGTH);
        const view = new DataView(packet.buffer);
        view.setUint8(0, LENGTH_TYPE_FLAGS);
        view.setUint8(1, PROPERTY_FLAGS);
        view.setUint16(2, PAYLOAD_CAPACITY - fragment.byteLength, true);
        // A packet is sent as the presentation time less the preroll, so sent no later than presented
        view.setUint32(4, object.timestampMilliseconds, true);
        const payload = PACKET_HEADER_BYTE_LENGTH;
        view.setUint8(payload, streamNumber | (object.keyframe ? KEY_FRAME_FLAG : 0));
        view.setUint8(payload + 1, objectNumber & 0xFF);
        view.setUint32(payload + 2, offset, true);
        view.setUint8(payload + 6, REPLICATED_DATA_BYTE_LENGTH);
        view.setUint32(payload + 7, object.data.byteLength, true);
        view.setUint32(payload + 11, presentationTime, true);
        packet.set(fragment, PACKET_HEADER_BYTE_LENGTH + PAYLOAD_HEADER_BYTE_LENGTH);
        packets.push(packet);
    }
    return packets;
}

/** Returns an ASF file of the streams, numbered from 1 in order, and their media objects in file order. */
export function createASF(streams: readonly SyntheticASFStream[], objects: readonly SyntheticASFObject[]): Uint8Array {
    const objectCounts = streams.map((): number => 0);
    const packets = objects.flatMap((object: SyntheticASFObject): Uint8Array[] => {
        const objectNumber = objectCounts[object.streamIndex];
        objectCounts[object.streamIndex] = objectNumber + 1;
        return createDataPackets(object, object.streamIndex + 1, objectNumber);
    });
    const playDuration = Math.max(0, ...objects.map((object: SyntheticASFObject): number => object.timestampMilliseconds));
    const headerChildren = [
        createFileProperties(packets.length, playDuration),
        ...streams.map((stream: SyntheticASFStream, index: number): Uint8Array => createStreamProperties(stream, index + 1))
    ];
    const headerFields = new Uint8Array(6);
    new DataView(headerFields.buffer).setUint32(0, headerChildren.length, true);
    headerFields.set([ 1, 2 ], 4);
    const header = writeObject(HEADER_OBJECT, concatenate([ headerFields, ...headerChildren ]));

    const dataFields = new Uint8Array(DATA_OBJECT_HEADER_BYTE_LENGTH - OBJECT_HEADER_BYTE_LENGTH);
    new DataView(dataFields.buffer).setBigUint64(16, BigInt(packets.length), true);
    const data = writeObject(DATA_OBJECT, concatenate([ dataFields, ...packets ]));
    return concatenate([ header, data ]);
}
