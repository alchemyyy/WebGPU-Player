// The runtime of a parser's parse worker: it parses the units of planned pictures, one job at a time, on its own parser instance.
// The coordinator plans pictures in decode order and finishes them; parse workers let pictures, and a picture's tiles, parse in parallel.
import GPUDecoderParserInstance, { GPUDecoderParserError, type GPUDecoderParserModule } from './GPUDecoderParser';
import { type GPUDecoderParseResponse, isGPUDecoderParseRequest } from './GPUDecoderParseProtocol';

/** The end of the channel the runtime answers on: the worker's global scope, or a message port in tests. */
export type GPUDecoderParseWorkerScope = {
    onmessage: ((event: MessageEvent<unknown>) => void) | null
    postMessage: (message: GPUDecoderParseResponse, transfer: Transferable[]) => void
};

function describeFailure(id: number, error: unknown): GPUDecoderParseResponse {
    if (error instanceof GPUDecoderParserError) {
        return { code: error.code, id, message: error.message, type: 'failed', value: error.value };
    }
    return { code: 0, id, message: error instanceof Error ? `${error.name}: ${error.message}` : String(error), type: 'failed', value: 0 };
}

/** Answers parse requests on the scope until the worker ends. */
export function startGPUDecoderParseWorkerRuntime(scope: GPUDecoderParseWorkerScope): void {
    let parserModule: GPUDecoderParserModule | null = null;
    let instance: Promise<GPUDecoderParserInstance> | null = null;

    const getInstance = (): Promise<GPUDecoderParserInstance> | null => {
        if (!instance && parserModule) {
            instance = GPUDecoderParserInstance.create(parserModule);
        }
        return instance;
    };

    scope.onmessage = (event: MessageEvent<unknown>): void => {
        const request = event.data;
        if (!isGPUDecoderParseRequest(request)) {
            return;
        }
        if (request.type === 'start') {
            parserModule = request.parser;
            instance = null;
            void getInstance();
            return;
        }
        const pending = getInstance();
        if (!pending) {
            scope.postMessage(describeFailure(request.id, new Error('parse before start')), []);
            return;
        }
        void pending.then(
            (parser: GPUDecoderParserInstance): void => {
                try {
                    const job = parser.parse(new Uint8Array(request.plan), request.firstUnit, request.unitCount);
                    scope.postMessage({ id: request.id, job, type: 'parsed' }, [ job ]);
                } catch (error) {
                    // A trap leaves the instance's memory mid-operation, so the next job gets a fresh instance
                    if (!(error instanceof GPUDecoderParserError)) {
                        instance = null;
                    }
                    scope.postMessage(describeFailure(request.id, error), []);
                }
            },
            (error: unknown): void => {
                instance = null;
                scope.postMessage(describeFailure(request.id, error), []);
            }
        );
    };
}
