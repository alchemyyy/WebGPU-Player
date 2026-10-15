// Keeps decoders compiled on a device for later sessions: a session's module and pipelines depend only on its package and output format,
// so the session of the next file, of a seek that needs another session, or of a stream change to a format compiled before compiles nothing.
// A device keeps one version of each package id, so a package's new version replaces what its old one compiled; the engine book's decoder packages chapter describes it.
import type { DecoderPackageVersion } from '../../packages/DecoderPackageIdentity';
import type { GPUDecoderOutputFormat } from './GPUDecodeFormats';

/** A decoder compiled for one output format on one device: the bind group layout its sessions' bind groups take, and its pipeline for each entry point. */
export type GPUDecoderCompiledPipelines = Readonly<{
    bindGroupLayout: GPUBindGroupLayout
    pipelines: ReadonlyMap<string, GPUComputePipeline>
}>;

/** What a device keeps of one package id: the version it compiled, and that version's decoder for each output format, a compile in progress included. */
type CompiledPackage = {
    contentHash: string
    decoders: Map<GPUDecoderOutputFormat, Promise<GPUDecoderCompiledPipelines>>
};

// Each device's compiled packages by package id; a compile in progress counts, so sessions created at once share it
const compiledPackagesByDevice = new WeakMap<GPUDevice, Map<string, CompiledPackage>>();

/** Returns what a device keeps of a package version, replacing what it kept of another version of the package's id. */
function getCompiledPackage(device: GPUDevice, decoderPackage: DecoderPackageVersion): CompiledPackage {
    let compiledPackages = compiledPackagesByDevice.get(device);
    if (compiledPackages === undefined) {
        compiledPackages = new Map<string, CompiledPackage>();
        compiledPackagesByDevice.set(device, compiledPackages);
    }
    const kept = compiledPackages.get(decoderPackage.id);
    if (kept !== undefined && kept.contentHash === decoderPackage.contentHash) {
        return kept;
    }
    // Sessions of the replaced version hold their own pipelines, so dropping the version's entry ends nothing that runs
    const compiledPackage: CompiledPackage = { contentHash: decoderPackage.contentHash, decoders: new Map<GPUDecoderOutputFormat, Promise<GPUDecoderCompiledPipelines>>() };
    compiledPackages.set(decoderPackage.id, compiledPackage);
    return compiledPackage;
}

/**
 * Returns a package's decoder compiled for an output format on a device: the one the device keeps, or the one `compile` makes, which the device keeps from then on.
 * The device keeps decoders by package id and output format with the package's content hash as their version, so a new version of a package replaces every decoder of the old one.
 * A compile that fails is dropped, so the next session compiles again.
 */
export function getCompiledGPUDecoder(
    device: GPUDevice,
    decoderPackage: DecoderPackageVersion,
    format: GPUDecoderOutputFormat,
    compile: () => Promise<GPUDecoderCompiledPipelines>
): Promise<GPUDecoderCompiledPipelines> {
    const compiledPackage = getCompiledPackage(device, decoderPackage);
    const kept = compiledPackage.decoders.get(format);
    if (kept !== undefined) {
        return kept;
    }
    const compiled = compile();
    compiledPackage.decoders.set(format, compiled);
    compiled.catch((): void => {
        if (compiledPackage.decoders.get(format) === compiled) {
            compiledPackage.decoders.delete(format);
        }
    });
    return compiled;
}
