export type FFmpegEAC3Module = {
    HEAPF32: Float32Array
    HEAPU8: Uint8Array
    cwrap: (
        name: string,
        returnType: 'number' | null,
        argumentTypes: readonly 'number'[]
    ) => (...arguments_: number[]) => number | void
};

export type FFmpegEAC3ModuleOptions = {
    // Names ffmpeg-eac3.wasm's URL; a glue bundled into a worker cannot derive it
    locateFile: (path: string, scriptDirectory: string) => string
    // Bytes the caller already fetched, instantiated instead of the located URL
    wasmBinary?: ArrayBuffer
};

declare const createFFmpegEAC3Module: (options: FFmpegEAC3ModuleOptions) => Promise<FFmpegEAC3Module>;

export default createFFmpegEAC3Module;
