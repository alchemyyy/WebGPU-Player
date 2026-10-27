// Waits for the GPU to finish a native decoder's work up to a decoded frame, through a small WebGPU device of the decode worker's own.
// A hardware decoder returns a frame once its decode is queued, not once the GPU ran it, so a seek preroll that reads on at the pace the decoder
// returns frames queues decode work faster than the GPU finishes it, and the first presented frame then waits behind that backlog.
// Any device that reads a decoded frame waits for its decode first, so one texel read of the frame, once its work completes, marks where the
// GPU's decode work stands (see the engine book's Decisions, Playback robustness).
import { waitForGPUCompletion } from '../../../GPUCompletion';

// Reads one texel of the frame into a buffer, the least work that still waits for the frame's decode
const FENCE_SHADER_CODE = `
@group(0) @binding(0) var decodedFrame: texture_external;
@group(0) @binding(1) var<storage, read_write> texel: vec4f;

@compute @workgroup_size(1)
fn main() {
    texel = textureLoad(decodedFrame, vec2u(0u, 0u));
}
`;
const FENCE_ENTRY_POINT = 'main';
const FENCE_LABEL = 'video decode fence';
const FENCE_TEXEL_BYTE_LENGTH = 16;
const FRAME_BINDING = 0;
const TEXEL_BINDING = 1;

/**
 * A fence over a native decoder's frames.
 * `wait` takes ownership of a frame, closes it, and resolves once the GPU has finished decoding it, or at once while no device serves fences:
 * before the first device is ready, and for good once the browser refuses one or loses it.
 */
export type VideoDecodeFence = {
    /** Starts creating the fence's device, so the fences of a preroll about to start find it ready */
    prewarm: () => void
    wait: (frame: VideoFrame) => Promise<void>
};

type FenceDevice = Readonly<{
    device: GPUDevice
    pipeline: GPUComputePipeline
    texelBuffer: GPUBuffer
}>;

type FenceState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { fenceDevice: FenceDevice; kind: 'ready' }
    | { kind: 'unavailable' };

async function createFenceDevice(gpu: GPU): Promise<FenceDevice> {
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
        throw new Error('requestAdapter: null');
    }
    const device = await adapter.requestDevice({ label: FENCE_LABEL });
    const pipeline = await device.createComputePipelineAsync({
        compute: { entryPoint: FENCE_ENTRY_POINT, module: device.createShaderModule({ code: FENCE_SHADER_CODE, label: FENCE_LABEL }) },
        label: FENCE_LABEL,
        layout: 'auto'
    });
    const texelBuffer = device.createBuffer({ label: FENCE_LABEL, size: FENCE_TEXEL_BYTE_LENGTH, usage: GPUBufferUsage.STORAGE });
    return { device, pipeline, texelBuffer };
}

/** Submits the one texel read of a frame; it throws when the device cannot import the frame. */
function submitFrameRead(fenceDevice: FenceDevice, frame: VideoFrame): void {
    const { device, pipeline, texelBuffer } = fenceDevice;
    const bindGroup = device.createBindGroup({
        entries: [
            { binding: FRAME_BINDING, resource: device.importExternalTexture({ label: FENCE_LABEL, source: frame }) },
            { binding: TEXEL_BINDING, resource: { buffer: texelBuffer } }
        ],
        label: FENCE_LABEL,
        layout: pipeline.getBindGroupLayout(0)
    });
    const encoder = device.createCommandEncoder({ label: FENCE_LABEL });
    const pass = encoder.beginComputePass({ label: FENCE_LABEL });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([ encoder.finish() ]);
}

/**
 * Creates the fence of a decode worker, whose device is created at the first prewarm or wait and kept for the worker's life.
 * Without WebGPU in the worker every wait resolves at once, so decode runs as it would without fences.
 */
export function createVideoDecodeFence(gpu: GPU | undefined): VideoDecodeFence {
    let state: FenceState = gpu ? { kind: 'idle' } : { kind: 'unavailable' };

    const prewarm = (): void => {
        if (state.kind !== 'idle' || !gpu) {
            return;
        }
        state = { kind: 'pending' };
        createFenceDevice(gpu).then((fenceDevice: FenceDevice): void => {
            state = { fenceDevice, kind: 'ready' };
            void fenceDevice.device.lost.then((): void => {
                state = { kind: 'unavailable' };
            });
        }, (): void => {
            state = { kind: 'unavailable' };
        });
    };

    const wait = async (frame: VideoFrame): Promise<void> => {
        if (state.kind !== 'ready') {
            prewarm();
            frame.close();
            return;
        }
        const { device } = state.fenceDevice;
        try {
            submitFrameRead(state.fenceDevice, frame);
            await waitForGPUCompletion(device, device.queue.onSubmittedWorkDone());
        } catch {
            // A device that cannot read the decoder's frames serves no fence
            state = { kind: 'unavailable' };
        } finally {
            frame.close();
        }
    };

    return { prewarm, wait };
}
