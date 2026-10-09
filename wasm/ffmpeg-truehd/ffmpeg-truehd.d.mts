export type FFmpegTrueHDModule = {
    HEAP16: Int16Array
    HEAP32: Int32Array
    HEAPU8: Uint8Array
    cwrap: (
        name: string,
        returnType: 'number' | null,
        argumentTypes: readonly 'number'[]
    ) => (...arguments_: number[]) => number | void
};

export type FFmpegTrueHDModuleOptions = {
    // Names ffmpeg-truehd.wasm's URL; a glue bundled into a worker cannot derive it
    locateFile: (path: string, scriptDirectory: string) => string
    // Bytes the caller already fetched, instantiated instead of the located URL
    wasmBinary?: ArrayBuffer
};

declare const createFFmpegTrueHDModule: (options: FFmpegTrueHDModuleOptions) => Promise<FFmpegTrueHDModule>;

export default createFFmpegTrueHDModule;
