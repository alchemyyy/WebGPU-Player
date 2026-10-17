// Keeps the uploads of pass files' texture blocks on one device, by content identity, so a block uploads once whatever plans bind it.
// A new version of a block has a new identity, and retain() drops the old one once nothing uses it; there is no count or LRU limit.
import type { PassTexture, PlannedPassTexture, PresentationPlan } from './PassTypes';

const UPLOAD_LABEL_PREFIX = 'Presentation texture block';

/** Uploads texture blocks when a plan first binds them, and keeps them until retain() leaves them out. */
export class PassTextureCache {
    private readonly device: GPUDevice;
    private readonly uploads = new Map<string, { texture: GPUTexture; view: GPUTextureView }>();

    constructor(device: GPUDevice) {
        this.device = device;
    }

    /**
     * Returns the views of a plan's texture blocks by identity, uploading each block the first time a plan binds it.
     * A new upload's data comes from the passes that hold the block; a planned block neither uploaded nor held throws a RangeError.
     */
    acquire(plan: PresentationPlan, textures: ReadonlyMap<string, PassTexture>): Map<string, GPUTextureView> {
        const views = new Map<string, GPUTextureView>();
        for (const planned of plan.passTextures) {
            const existing = this.uploads.get(planned.id);
            if (existing !== undefined) {
                views.set(planned.id, existing.view);
                continue;
            }
            const texture = textures.get(planned.id);
            if (texture === undefined) {
                throw new RangeError(`texture-upload: no pass holds texture block ${planned.id}`);
            }
            views.set(planned.id, this.upload(planned, texture));
        }
        return views;
    }

    /** Destroys every upload whose identity the set lacks, as the blocks of a replaced preset and of passes no plan uses. */
    retain(identities: ReadonlySet<string>): void {
        for (const [ identity, upload ] of this.uploads) {
            if (!identities.has(identity)) {
                upload.texture.destroy();
                this.uploads.delete(identity);
            }
        }
    }

    destroy(): void {
        this.retain(new Set<string>());
    }

    private upload(planned: PlannedPassTexture, texture: PassTexture): GPUTextureView {
        const [ width, height, depth ] = planned.size;
        const gpuTexture = this.device.createTexture({
            dimension: planned.dimension,
            format: planned.format,
            label: `${UPLOAD_LABEL_PREFIX} '${texture.name}'`,
            size: { depthOrArrayLayers: depth, height, width },
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        const bytesPerTexel = texture.data.byteLength / (width * height * depth);
        this.device.queue.writeTexture(
            { texture: gpuTexture },
            texture.data,
            { bytesPerRow: width * bytesPerTexel, rowsPerImage: height },
            { depthOrArrayLayers: depth, height, width }
        );
        const view = gpuTexture.createView({ dimension: planned.dimension });
        this.uploads.set(planned.id, { texture: gpuTexture, view });
        return view;
    }
}

/** Returns the texture blocks of passes by identity, the data a cache uploads. */
export function collectPassTextures(passes: readonly { textures: readonly PassTexture[] }[]): Map<string, PassTexture> {
    const textures = new Map<string, PassTexture>();
    for (const pass of passes) {
        for (const texture of pass.textures) {
            textures.set(texture.identity, texture);
        }
    }
    return textures;
}
