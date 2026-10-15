// The decode worker's parser coordinator worker, which every attempt of the decode worker shares; each attempt opens its own pipeline on it.
import type { DecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import { createEngineWorker, type EngineWorkerPath } from '../../../EngineAssets';
import type { GPUDecoderParserModule } from './GPUDecoderParser';
import GPUDecoderCoordinatorHost, { type GPUDecoderParserRemotePipeline } from './GPUDecoderCoordinatorHost';

const COORDINATOR_WORKER_PATH = 'webgpu-player/GPUDecoderCoordinator.worker.js' satisfies EngineWorkerPath;

let host: GPUDecoderCoordinatorHost | null = null;

/** Opens an attempt's parser pipeline on the decode worker's coordinator worker, which starts on first use. */
export function openGPUDecoderParser(
    parser: GPUDecoderParserModule,
    packageVersion: DecoderPackageVersion,
    codecPrivate: Uint8Array | null
): Promise<GPUDecoderParserRemotePipeline> {
    host ??= new GPUDecoderCoordinatorHost((): Worker => createEngineWorker(COORDINATOR_WORKER_PATH));
    return host.open(parser, packageVersion, codecPrivate);
}
