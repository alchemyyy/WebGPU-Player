// Verifies a video decoder package on a device against its own self-test vectors: a vector for one output format decodes to the vector's hash.
// Verification is optional and explicit: it runs only when a host calls it, such as to let the user test a package on their GPU, and playback never waits on it.
// A package's parser runs on a coordinator worker of its own here too, so a module that loops is ended by the watchdog.
import type { VideoDecoderPackage } from '../../packages/DecoderPackage';
import { createEngineWorker, type EngineWorkerPath } from '../../../EngineAssets';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';
import { getGPUDecoderParserModule, type GPUDecoderParserOutput } from './GPUDecoderParser';
import GPUDecoderCoordinatorHost from './GPUDecoderCoordinatorHost';
import { checkGPUDecoderVector, type GPUDecoderVectorCheckResult } from './GPUDecoderVectorCheck';
import { parseGPUDecoderVectorSet, type GPUDecoderVector } from './GPUDecoderVectorSet';

/** Runs a package's parser over a vector's packets and returns each packet's output, its pictures and trailing events, in order. */
export type GPUDecoderVectorParserRunner = (decoderPackage: VideoDecoderPackage, vector: GPUDecoderVector) => Promise<GPUDecoderParserOutput[]>;

const COORDINATOR_WORKER_PATH = 'webgpu-player/GPUDecoderCoordinator.worker.js' satisfies EngineWorkerPath;

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Runs a package's parser on a coordinator worker of its own, which ends with the run. */
export async function runGPUDecoderVectorParser(decoderPackage: VideoDecoderPackage, vector: GPUDecoderVector): Promise<GPUDecoderParserOutput[]> {
    const host = new GPUDecoderCoordinatorHost((): Worker => createEngineWorker(COORDINATOR_WORKER_PATH));
    try {
        const pipeline = await host.open(getGPUDecoderParserModule(decoderPackage), decoderPackage, vector.codecPrivate);
        // Each packet's bytes transfer to the worker, so the vector keeps its own
        const outputs = await Promise.all(vector.packets.map((packet): Promise<GPUDecoderParserOutput> => pipeline.submit(packet.data.slice(0))));
        pipeline.close();
        return outputs;
    } finally {
        host.destroy();
    }
}

/** Returns the output formats a package carries a self-test vector for, in the order it writes them. */
export function getGPUDecoderVectorFormats(decoderPackage: VideoDecoderPackage): GPUDecoderOutputFormat[] {
    if (!decoderPackage.vectors) {
        return [];
    }
    const vectors = parseGPUDecoderVectorSet(decoderPackage.vectors);
    return decoderPackage.manifest.outputFormats.filter((format: GPUDecoderOutputFormat): boolean => vectors.has(format));
}

/**
 * Decodes a package's self-test vector for one output format on a device and returns the check's outcome: 'unverified' when it carries no vector for the format.
 * Each call checks again. Every failed check is a coded result, a parser that fails included; it rejects only on an unexpected error.
 */
export async function verifyGPUDecoderPackage(
    device: GPUDevice,
    decoderPackage: VideoDecoderPackage,
    format: GPUDecoderOutputFormat,
    runParser: GPUDecoderVectorParserRunner = runGPUDecoderVectorParser
): Promise<GPUDecoderVectorCheckResult> {
    // The loader checked the section, so it parses
    const vector = decoderPackage.vectors ? parseGPUDecoderVectorSet(decoderPackage.vectors).get(format) : undefined;
    if (!vector) {
        return { code: 'unverified', detail: format };
    }
    const manifest = decoderPackage.manifest;
    let parserOutputs: GPUDecoderParserOutput[] | null = null;
    if (manifest.parser !== null) {
        try {
            parserOutputs = await runParser(decoderPackage, vector);
        } catch (error) {
            return { code: 'parser-failed', detail: describeError(error) };
        }
    }
    return checkGPUDecoderVector(device, manifest, vector, parserOutputs);
}
