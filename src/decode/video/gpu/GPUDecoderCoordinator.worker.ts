// The parser coordinator worker of a video decoder package, which a decode worker starts with its first attempt that needs one and keeps for its life
import { createEngineWorker, type EngineWorkerPath } from '../../../EngineAssets';
import { getGPUDecoderParseWorkerCount } from './GPUDecoderParseWorkerPool';
import { type GPUDecoderCoordinatorWorkerScope, startGPUDecoderCoordinatorWorkerRuntime } from './GPUDecoderCoordinatorWorkerRuntime';

const PARSE_WORKER_PATH = 'webgpu-player/GPUDecoderParse.worker.js' satisfies EngineWorkerPath;

startGPUDecoderCoordinatorWorkerRuntime(globalThis as unknown as GPUDecoderCoordinatorWorkerScope, {
    createParseWorker: (): Worker => createEngineWorker(PARSE_WORKER_PATH),
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    parseWorkerCount: getGPUDecoderParseWorkerCount(typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency)
});
