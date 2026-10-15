import { describe, expect, it } from 'vitest';

import type { VideoDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackage';
import type { GPUDecoderOutputFormat } from 'webgpu-player/decode/video/gpu/GPUDecodeFormats';
import { parseGPUDecoderManifest } from 'webgpu-player/decode/video/gpu/GPUDecoderManifest';
import { createGPUVideoDecoderOffer } from 'webgpu-player/decode/video/gpu/GPUVideoDecoderCatalog';

import { readDecoderProjectSource } from '../../../helpers/decoderPackages';

const BUFFER_BYTE_LIMIT = 2 ** 31;
// The lowercase hexadecimal SHA-256 of a package file, which tells its versions apart
const CONTENT_HASH = '5f2b'.repeat(16);
// The smallest WebAssembly module, the magic and version, as a package without code holds
const EMPTY_MODULE_BYTES = Uint8Array.of(0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00);
const TEN_BIT_FORMAT: GPUDecoderOutputFormat = 'I420P10';
const EIGHT_BIT_FORMAT: GPUDecoderOutputFormat = 'I420';
// The HEVC decoder project, a decoder with references, reordering, and a stream constraint, and the id its header declares
const HEVC_DECODER_PROJECT = 'hevc';
const HEVC_PACKAGE_ID = 'hevc';
const HEVC_CODEC_FAMILY = 'hevc';
const UNCONSTRAINED_CODEC_FAMILIES = [ 'uncompressed', 'raw-planar' ];
// A decoder without references, reordering, or a stream constraint
const UNCONSTRAINED_SOURCE = `//! id: unconstrained
//! name: Unconstrained
//! decoder: video
//! accepts: codec in [${UNCONSTRAINED_CODEC_FAMILIES.join(', ')}]
//! output: ${EIGHT_BIT_FORMAT}, ${TEN_BIT_FORMAT}
//! packet: 4096
//! dispatch: copyPlanes, 1

@compute @workgroup_size(1)
fn copyPlanes() {
}
`;

/** Returns a video package of a decoder source, as loadDecoderPackage returns one, without a vectors section. */
function createVideoPackage(source: string): VideoDecoderPackage {
    const manifest = parseGPUDecoderManifest(source);
    return {
        contentHash: CONTENT_HASH,
        id: manifest.id,
        kind: 'video',
        manifest,
        memory: null,
        module: new WebAssembly.Module(EMPTY_MODULE_BYTES),
        name: manifest.name,
        vectors: null
    };
}

describe('createGPUVideoDecoderOffer', () => {
    const hevcPackage = createVideoPackage(readDecoderProjectSource(HEVC_DECODER_PROJECT));

    it('offers one output format of a package with its codec families, id, and the device\'s buffer limit', () => {
        const offer = createGPUVideoDecoderOffer(hevcPackage, TEN_BIT_FORMAT, BUFFER_BYTE_LIMIT);

        expect(offer).toEqual({
            codecs: [ HEVC_CODEC_FAMILY ],
            decoderId: HEVC_PACKAGE_ID,
            format: TEN_BIT_FORMAT,
            maximumBufferByteLength: BUFFER_BYTE_LIMIT,
            package: hevcPackage
        });
    });

    it('offers every codec family a decoder accepts', () => {
        const unconstrainedPackage = createVideoPackage(UNCONSTRAINED_SOURCE);

        const offer = createGPUVideoDecoderOffer(unconstrainedPackage, EIGHT_BIT_FORMAT, BUFFER_BYTE_LIMIT);

        expect(offer.codecs).toEqual(UNCONSTRAINED_CODEC_FAMILIES);
        expect(offer.format).toBe(EIGHT_BIT_FORMAT);
    });
});
