// A parse worker of a video decoder package's parser, which the parser coordinator worker starts for a package and keeps while the package plays
import { type GPUDecoderParseWorkerScope, startGPUDecoderParseWorkerRuntime } from './GPUDecoderParseWorkerRuntime';

startGPUDecoderParseWorkerRuntime(globalThis as unknown as GPUDecoderParseWorkerScope);
