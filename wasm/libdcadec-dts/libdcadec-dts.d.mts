export type LibDCADECModule = {
    HEAP32: Int32Array
    HEAPU8: Uint8Array
    cwrap: (
        name: string,
        returnType: 'number' | null,
        argumentTypes: readonly 'number'[]
    ) => (...arguments_: number[]) => number | void
};

export type LibDCADECModuleOptions = {
    // Names libdcadec-dts.wasm's URL; a glue bundled into a worker cannot derive it
    locateFile: (path: string, scriptDirectory: string) => string
    // Bytes the caller already fetched, instantiated instead of the located URL
    wasmBinary?: ArrayBuffer
};

declare const createLibDCADECModule: (options: LibDCADECModuleOptions) => Promise<LibDCADECModule>;

export default createLibDCADECModule;
