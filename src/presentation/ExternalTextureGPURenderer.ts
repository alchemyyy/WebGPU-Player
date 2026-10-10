// Draws a frame that the GPU imports as an external texture, as RawYUVGPURenderer draws raw planes: the page presenter and the decode worker's renderer share it

import type { TexturePresentationGeometry } from './PresentationGeometry';

const EXTERNAL_TEXTURE_VERTEX_COUNT = 6;
// The texture transform the presentation uniform holds: its scale, then its offset
const PRESENTATION_UNIFORM_TEXTURE_SCALE_X_INDEX = 0;
const PRESENTATION_UNIFORM_TEXTURE_SCALE_Y_INDEX = 1;
const PRESENTATION_UNIFORM_TEXTURE_OFFSET_X_INDEX = 2;
const PRESENTATION_UNIFORM_TEXTURE_OFFSET_Y_INDEX = 3;
const SAMPLER_BINDING = 0;
const EXTERNAL_TEXTURE_BINDING = 1;
const PRESENTATION_UNIFORM_BINDING = 2;
const RENDER_SETTINGS_UNIFORM_BINDING = 3;
const DOLBY_VISION_RPU_STORAGE_BINDING = 4;

export type ExternalTextureDrawRequest = {
    device: GPUDevice
    /** The per-frame RPU that an external Dolby Vision pipeline binds; null on every other route */
    dolbyVisionRPUStorageBuffer: GPUBuffer | null
    pipeline: GPURenderPipeline
    presentation: TexturePresentationGeometry
    presentationUniformBuffer: GPUBuffer
    /** The caller's scratch for the texture transform, which is written to the presentation uniform */
    presentationUniformValues: Float32Array<ArrayBuffer>
    /** Bound only by an HDR-to-SDR pipeline; null otherwise */
    renderSettingsUniformBuffer: GPUBuffer | null
    sampler: GPUSampler
    source: GPUExternalTextureDescriptor['source']
    targetView: GPUTextureView
};

/** Creates the pipeline of an external-texture shader, which takes its frames through `texture_external`. */
export function createExternalTextureRenderPipeline(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    shaderCode: string
): Promise<GPURenderPipeline> {
    const shaderModule = device.createShaderModule({ code: shaderCode });
    return device.createRenderPipelineAsync({
        fragment: {
            entryPoint: 'fragmentMain',
            module: shaderModule,
            targets: [{ format: targetFormat }]
        },
        layout: 'auto',
        primitive: { topology: 'triangle-list' },
        vertex: {
            entryPoint: 'vertexMain',
            module: shaderModule
        }
    });
}

/** Writes the texture transform, imports the source as an external texture, binds it, draws it into the target, and submits. */
export function drawExternalTextureFrame(request: ExternalTextureDrawRequest): void {
    const device = request.device;
    const presentation = request.presentation;
    const presentationUniformValues = request.presentationUniformValues;
    presentationUniformValues[PRESENTATION_UNIFORM_TEXTURE_SCALE_X_INDEX] = presentation.textureScaleX;
    presentationUniformValues[PRESENTATION_UNIFORM_TEXTURE_SCALE_Y_INDEX] = presentation.textureScaleY;
    presentationUniformValues[PRESENTATION_UNIFORM_TEXTURE_OFFSET_X_INDEX] = presentation.textureOffsetX;
    presentationUniformValues[PRESENTATION_UNIFORM_TEXTURE_OFFSET_Y_INDEX] = presentation.textureOffsetY;
    device.queue.writeBuffer(request.presentationUniformBuffer, 0, presentationUniformValues);

    const externalTexture = device.importExternalTexture({
        colorSpace: 'srgb',
        source: request.source
    });
    const bindGroupEntries: GPUBindGroupEntry[] = [];
    bindGroupEntries.push({
        binding: SAMPLER_BINDING,
        resource: request.sampler
    }, {
        binding: EXTERNAL_TEXTURE_BINDING,
        resource: externalTexture
    }, {
        binding: PRESENTATION_UNIFORM_BINDING,
        resource: { buffer: request.presentationUniformBuffer }
    });
    if (request.renderSettingsUniformBuffer) {
        bindGroupEntries.push({
            binding: RENDER_SETTINGS_UNIFORM_BINDING,
            resource: { buffer: request.renderSettingsUniformBuffer }
        });
    }
    if (request.dolbyVisionRPUStorageBuffer) {
        bindGroupEntries.push({
            binding: DOLBY_VISION_RPU_STORAGE_BINDING,
            resource: { buffer: request.dolbyVisionRPUStorageBuffer }
        });
    }
    const bindGroup = device.createBindGroup({
        entries: bindGroupEntries,
        layout: request.pipeline.getBindGroupLayout(0)
    });
    const commandEncoder = device.createCommandEncoder();
    const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
            view: request.targetView
        }]
    });
    renderPass.setPipeline(request.pipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.setViewport(
        presentation.viewportX,
        presentation.viewportY,
        presentation.viewportWidth,
        presentation.viewportHeight,
        0,
        1
    );
    renderPass.draw(EXTERNAL_TEXTURE_VERTEX_COUNT);
    renderPass.end();
    device.queue.submit([ commandEncoder.finish() ]);
}
