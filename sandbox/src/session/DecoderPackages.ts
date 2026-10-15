// The sandbox's decoder packages: the ones the user adds, kept in IndexedDB across reloads by the id each header declares,
// with the vector checks the user runs on the presenter's device. Adding a rebuilt package replaces the stored version of its id.
import {
    DECODER_PACKAGE_FILE_EXTENSION,
    DecoderPackageError,
    type AudioDecoderPackage,
    type DecoderPackage,
    type VideoDecoderPackage
} from 'webgpu-player/decode/packages/DecoderPackage';
import DecoderPackageStore, { DecoderPackageStoreError, type StoredDecoderPackage } from 'webgpu-player/decode/packages/DecoderPackageStore';
import { getGPUDecoderVectorFormats, verifyGPUDecoderPackage } from 'webgpu-player/decode/video/gpu/GPUDecoderVerification';

import { describeError, type SandboxDecoderPackage, type SandboxDecoderVerification } from '../contracts/SandboxContracts';

// The sandbox's own database, apart from any host's
const DECODER_PACKAGE_DATABASE_NAME = 'webgpu-player-sandbox-decoders';

export type SandboxDecoderPackagesOptions = Readonly<{
    publish: (packages: readonly SandboxDecoderPackage[]) => void
    recordFailure: (code: string, detail: string) => void
}>;

/** A package version's vector checks: the content hash of the version that ran them, and their results. */
type PackageVerifications = Readonly<{
    contentHash: string
    results: readonly SandboxDecoderVerification[]
}>;

export type SandboxDecoderPackages = Readonly<{
    /** Checks and stores package files, each replacing a stored package of its id; each file the engine refuses is reported and skipped */
    add: (files: readonly File[]) => Promise<void>
    /** The user's audio packages, in the order the user added them */
    getAudioDecoders: () => readonly AudioDecoderPackage[]
    /** The user's video packages, in the order the user added them */
    getVideoDecoders: () => readonly VideoDecoderPackage[]
    remove: (packageId: string) => Promise<void>
    /** Loads the stored packages */
    restore: () => Promise<void>
    /** Runs a video package's vector check of every format it carries a vector for */
    verify: (packageId: string, device: GPUDevice) => Promise<void>
}>;

function describeAddFailure(error: unknown): { code: string; detail: string } {
    if (error instanceof DecoderPackageError || error instanceof DecoderPackageStoreError) {
        const [ code, ...detail ] = error.message.split(': ');
        return { code, detail: detail.join(': ') };
    }
    return { code: 'package-add-failed', detail: describeError(error) };
}

function getOutputFormats(decoderPackage: DecoderPackage): readonly string[] {
    return decoderPackage.kind === 'video' ? decoderPackage.manifest.outputFormats : [];
}

function getVectorFormats(decoderPackage: DecoderPackage): readonly string[] {
    return decoderPackage.kind === 'video' ? getGPUDecoderVectorFormats(decoderPackage) : [];
}

function getCodecs(decoderPackage: DecoderPackage): readonly string[] {
    return decoderPackage.kind === 'video' ? decoderPackage.manifest.accepts.codecs : decoderPackage.manifest.codecs;
}

export function createSandboxDecoderPackages(options: SandboxDecoderPackagesOptions): SandboxDecoderPackages {
    const store = new DecoderPackageStore(DECODER_PACKAGE_DATABASE_NAME);
    let userPackages: readonly StoredDecoderPackage[] = [];
    // Checks by package id; a check of another version than the stored one no longer applies
    const verifications = new Map<string, PackageVerifications>();

    const getVerifications = (decoderPackage: DecoderPackage): readonly SandboxDecoderVerification[] => {
        const kept = verifications.get(decoderPackage.id);
        return kept?.contentHash === decoderPackage.contentHash ? kept.results : [];
    };

    const describePackage = (stored: StoredDecoderPackage): SandboxDecoderPackage => ({
        codecs: getCodecs(stored.decoderPackage),
        contentHash: stored.decoderPackage.contentHash,
        fileName: stored.fileName,
        id: stored.decoderPackage.id,
        kind: stored.decoderPackage.kind,
        name: stored.decoderPackage.name,
        outputFormats: getOutputFormats(stored.decoderPackage),
        vectorFormats: getVectorFormats(stored.decoderPackage),
        verifications: getVerifications(stored.decoderPackage)
    });

    const publish = (): void => {
        options.publish(userPackages.map(describePackage));
    };

    const reloadUserPackages = async (): Promise<void> => {
        const stored = await store.loadAll();
        for (const failure of stored.failures) {
            options.recordFailure('package-stale', `${failure.fileName} ${failure.detail}`);
        }
        userPackages = stored.packages;
    };

    const getPackages = (): readonly DecoderPackage[] => userPackages.map((stored: StoredDecoderPackage): DecoderPackage => stored.decoderPackage);

    return {
        add: async (files: readonly File[]): Promise<void> => {
            for (const file of files) {
                if (!file.name.toLowerCase().endsWith(DECODER_PACKAGE_FILE_EXTENSION)) {
                    options.recordFailure('package-file-unsupported', file.name);
                    continue;
                }
                try {
                    await store.add(file.name, await file.arrayBuffer());
                } catch (error) {
                    const failure = describeAddFailure(error);
                    options.recordFailure(failure.code, `${file.name} ${failure.detail}`);
                }
            }
            await reloadUserPackages();
            publish();
        },
        getAudioDecoders: (): readonly AudioDecoderPackage[] => getPackages()
            .filter((decoderPackage: DecoderPackage): decoderPackage is AudioDecoderPackage => decoderPackage.kind === 'audio'),
        getVideoDecoders: (): readonly VideoDecoderPackage[] => getPackages()
            .filter((decoderPackage: DecoderPackage): decoderPackage is VideoDecoderPackage => decoderPackage.kind === 'video'),
        remove: async (packageId: string): Promise<void> => {
            await store.remove(packageId);
            verifications.delete(packageId);
            await reloadUserPackages();
            publish();
        },
        restore: async (): Promise<void> => {
            await reloadUserPackages();
            publish();
        },
        verify: async (packageId: string, device: GPUDevice): Promise<void> => {
            const decoderPackage = getPackages().find((candidate: DecoderPackage): boolean => candidate.id === packageId);
            if (decoderPackage?.kind !== 'video') {
                options.recordFailure('package-verify-failed', `no video package ${packageId}`);
                return;
            }
            const results: SandboxDecoderVerification[] = [];
            for (const format of getGPUDecoderVectorFormats(decoderPackage)) {
                const result = await verifyGPUDecoderPackage(device, decoderPackage, format);
                results.push({ code: result.code, detail: result.detail, format });
                verifications.set(packageId, { contentHash: decoderPackage.contentHash, results: [ ...results ] });
                publish();
            }
        }
    };
}
