// The WebGPU flag namespaces a GPU decode test needs, which jsdom and Node do not define

// WebGPU defines these external names and values
/* eslint-disable @typescript-eslint/naming-convention */
const BUFFER_USAGE = {
    COPY_DST: 8,
    COPY_SRC: 4,
    INDIRECT: 256,
    MAP_READ: 1,
    MAP_WRITE: 2,
    STORAGE: 128,
    UNIFORM: 64
};
const MAP_MODE = { READ: 1, WRITE: 2 };
const SHADER_STAGE = { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 };
/* eslint-enable @typescript-eslint/naming-convention */

const GLOBAL_VALUES: ReadonlyMap<string, unknown> = new Map<string, unknown>([
    [ 'GPUBufferUsage', BUFFER_USAGE ],
    [ 'GPUMapMode', MAP_MODE ],
    [ 'GPUShaderStage', SHADER_STAGE ]
]);

/** Defines GPUBufferUsage, GPUMapMode, and GPUShaderStage, and returns a function that restores the previous globals. */
export function installWebGPUGlobals(): () => void {
    const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
    for (const [ name, value ] of GLOBAL_VALUES) {
        originalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
    }
    return (): void => {
        for (const [ name, descriptor ] of originalDescriptors) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    };
}
