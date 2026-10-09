// @vitest-environment node

import { createDolbyVisionAV1ITUTT35Payload } from '../../helpers/dolbyVisionAV1ITUTT35Payload';
import { TEST_VECTORS_DIRECTORY, WASM_OUTPUT_DIRECTORY } from '../../helpers/enginePaths';
import { encodeAnnexBNALUnits } from '../../helpers/hevcNALUnits';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EncodedPacket } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import DolbyVisionEncodedMetadataQueue from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadata';
import {
    getDolbyVisionEncodedMetadataTransferList,
    isTransferableDolbyVisionEncodedFrameMetadata,
    takeTransferableDolbyVisionEncodedFrameMetadata
} from 'webgpu-player/video/dolby-vision/DolbyVisionEncodedMetadataProtocol';
import DolbyVisionRPUParser, {
    decodeDolbyVisionRPUSnapshot
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParserSession';

const PARSER_WASM_PATH = resolve(WASM_OUTPUT_DIRECTORY, 'libdovi', 'dovi-rpu-parser.wasm');
const RPU_VECTOR_DIRECTORY = resolve(TEST_VECTORS_DIRECTORY, 'dolby-vision-rpu');
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(PARSER_WASM_PATH));

async function createActualParser(): Promise<DolbyVisionRPUParser> {
    return DolbyVisionRPUParser.create('local-parser.wasm', {
        loadInstance: async (): Promise<WebAssembly.Instance> => {
            const result = await WebAssembly.instantiate(PARSER_WASM_BYTES, {});
            return result.instance;
        }
    });
}

describe('Dolby Vision metadata integration', () => {
    it('parses an RPU before BL decode and transfers its exact PTS snapshot', async () => {
        const vector = new Uint8Array(readFileSync(resolve(
            RPU_VECTOR_DIRECTORY,
            'profile8.bin'
        )));
        const rpuNALUnit = new Uint8Array(2 + vector.byteLength - 4);
        rpuNALUnit.set([ 0x7C, 0x01 ]);
        rpuNALUnit.set(vector.subarray(4), 2);
        const baseLayerNALUnit = new Uint8Array([ 19 << 1, 1, 7, 8, 9 ]);
        const parserSession = DolbyVisionRPUParserSession.create('local-parser.wasm', {
            createParser: createActualParser
        });
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            parserSession
        );
        const packet = new EncodedPacket(
            encodeAnnexBNALUnits([ rpuNALUnit, baseLayerNALUnit ]),
            'key',
            1.25,
            1 / 24,
            7
        );

        try {
            const processedPacket = await queue.processPacket(packet);
            expect(processedPacket.hasBaseLayerVCL).toBe(true);
            const metadata = queue.takeFrameMetadata(1_250_000);
            expect(metadata?.parsedRPUData).toHaveLength(1);
            expect(decodeDolbyVisionRPUSnapshot(
                metadata?.parsedRPUData[0] ?? new ArrayBuffer(0)
            )).toMatchObject({
                profile: 8,
                sourceMaximumPQ: 3_696,
                sourceMinimumPQ: 62
            });

            const transferable = takeTransferableDolbyVisionEncodedFrameMetadata(metadata);
            expect(isTransferableDolbyVisionEncodedFrameMetadata(transferable)).toBe(true);
            expect(getDolbyVisionEncodedMetadataTransferList(transferable)).toHaveLength(1);
            queue.requireDrained();
        } finally {
            queue.clear();
            parserSession.close();
        }
    });

    it('parses an AV1 T.35 payload in the same session state as an HEVC RPU', async () => {
        const vector = new Uint8Array(readFileSync(resolve(
            RPU_VECTOR_DIRECTORY,
            'profile5.bin'
        )));
        const parserSession = DolbyVisionRPUParserSession.create('local-parser.wasm', {
            createParser: createActualParser
        });

        try {
            const hevcPackedData = await parserSession.parse(vector);
            const av1PackedData = await parserSession.parseAV1ITUTT35(
                createDolbyVisionAV1ITUTT35Payload(vector)
            );

            expect(new Uint8Array(av1PackedData)).toEqual(new Uint8Array(hevcPackedData));
            // Profile 10.0 RPUs are coded like Profile 5 and keep that profile
            expect(decodeDolbyVisionRPUSnapshot(av1PackedData)).toMatchObject({
                layerMode: 'single-layer',
                profile: 5,
                sourceMaximumPQ: 3_696,
                sourceMinimumPQ: 62
            });
        } finally {
            parserSession.close();
        }
    });
});
