import { describe, expect, it, vi } from 'vitest';

import type { DolbyVisionRPUSnapshot } from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParser';
import DolbyVisionRPUParserSession, {
    type DolbyVisionRPUParserPort
} from 'webgpu-player/video/dolby-vision/DolbyVisionRPUParserSession';

function createDeferred<Value>(): {
    promise: Promise<Value>
    resolve: (value: Value) => void
} {
    let promiseResolver: ((value: Value) => void) | null = null;
    const promise = new Promise<Value>(resolve => {
        promiseResolver = resolve;
    });
    return {
        promise,
        resolve: (value: Value): void => {
            if (!promiseResolver) {
                throw new Error('Deferred promise was not initialized');
            }
            promiseResolver(value);
        }
    };
}

function createParserPort(
    packedData = new ArrayBuffer(32),
    av1PackedData = new ArrayBuffer(32)
): DolbyVisionRPUParserPort & {
    close: ReturnType<typeof vi.fn>
    parse: ReturnType<typeof vi.fn>
    parseAV1ITUTT35: ReturnType<typeof vi.fn>
    reset: ReturnType<typeof vi.fn>
} {
    return {
        close: vi.fn(),
        parse: vi.fn((): DolbyVisionRPUSnapshot => ({
            packedData
        } as DolbyVisionRPUSnapshot)),
        parseAV1ITUTT35: vi.fn((): DolbyVisionRPUSnapshot => ({
            packedData: av1PackedData
        } as DolbyVisionRPUSnapshot)),
        reset: vi.fn()
    };
}

describe('DolbyVisionRPUParserSession', () => {
    it('waits for lazy initialization and returns owned packed data', async () => {
        const deferredParser = createDeferred<DolbyVisionRPUParserPort>();
        const packedData = new ArrayBuffer(32);
        const parser = createParserPort(packedData);
        const createParser = vi.fn(() => deferredParser.promise);
        const session = DolbyVisionRPUParserSession.create('parser.wasm', { createParser });
        const rpuNALUnit = new Uint8Array([ 124, 1, 25, 8, 9 ]);
        const parsePromise = session.parse(rpuNALUnit);

        deferredParser.resolve(parser);

        await expect(parsePromise).resolves.toBe(packedData);
        expect(createParser).toHaveBeenCalledWith('parser.wasm');
        expect(parser.parse).toHaveBeenCalledWith(rpuNALUnit);
        session.close();
        expect(parser.reset).toHaveBeenCalledTimes(1);
        expect(parser.close).toHaveBeenCalledTimes(1);
    });

    it('routes AV1 T.35 payloads to the same lazily created parser', async () => {
        const deferredParser = createDeferred<DolbyVisionRPUParserPort>();
        const packedData = new ArrayBuffer(32);
        const av1PackedData = new ArrayBuffer(32);
        const parser = createParserPort(packedData, av1PackedData);
        const createParser = vi.fn(() => deferredParser.promise);
        const session = DolbyVisionRPUParserSession.create('parser.wasm', { createParser });
        const payload = new Uint8Array([ 0xB5, 0x00, 0x3B, 0x00, 0x00, 0x08, 0x00 ]);
        const rpuNALUnit = new Uint8Array([ 124, 1, 25, 8, 9 ]);
        const av1ParsePromise = session.parseAV1ITUTT35(payload);
        const parsePromise = session.parse(rpuNALUnit);

        deferredParser.resolve(parser);

        await expect(av1ParsePromise).resolves.toBe(av1PackedData);
        await expect(parsePromise).resolves.toBe(packedData);
        expect(createParser).toHaveBeenCalledTimes(1);
        expect(parser.parseAV1ITUTT35).toHaveBeenCalledWith(payload);
        expect(parser.parse).toHaveBeenCalledWith(rpuNALUnit);
        session.close();
        await expect(session.parseAV1ITUTT35(payload)).rejects.toThrow(
            'parser session is closed'
        );
        expect(parser.close).toHaveBeenCalledTimes(1);
    });

    it('retires a parser that resolves after its generation closes', async () => {
        const deferredParser = createDeferred<DolbyVisionRPUParserPort>();
        const parser = createParserPort();
        const session = DolbyVisionRPUParserSession.create('parser.wasm', {
            createParser: (): Promise<DolbyVisionRPUParserPort> => deferredParser.promise
        });

        session.close();
        session.close();
        deferredParser.resolve(parser);
        await Promise.resolve();
        await Promise.resolve();

        expect(parser.reset).toHaveBeenCalledTimes(1);
        expect(parser.close).toHaveBeenCalledTimes(1);
        expect(() => session.close()).not.toThrow();
        await expect(session.parse(new Uint8Array([ 1 ]))).rejects.toThrow(
            'parser session is closed'
        );
    });

    it('propagates initialization and parse failures without an unhandled rejection', async () => {
        const initializationFailure = new Error('parser initialization failed');
        const failedInitialization = DolbyVisionRPUParserSession.create('parser.wasm', {
            createParser: (): Promise<DolbyVisionRPUParserPort> => (
                Promise.reject(initializationFailure)
            )
        });
        await expect(failedInitialization.parse(new Uint8Array([ 1 ]))).rejects.toBe(
            initializationFailure
        );
        failedInitialization.close();

        const parseFailure = new Error('RPU parse failed');
        const parser = createParserPort();
        parser.parse.mockImplementation((): never => {
            throw parseFailure;
        });
        const failedParse = DolbyVisionRPUParserSession.create('parser.wasm', {
            createParser: async (): Promise<DolbyVisionRPUParserPort> => parser
        });
        await expect(failedParse.parse(new Uint8Array([ 2 ]))).rejects.toBe(parseFailure);
        failedParse.close();
    });
});
