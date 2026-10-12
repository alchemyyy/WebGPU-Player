// The URLs Vite serves for ffmpeg.wasm's single-thread core; only these two specifiers resolve as URLs, so the engine's sources see no Vite types

declare module '@ffmpeg/core?url' {
    const coreURL: string;
    export default coreURL;
}

declare module '@ffmpeg/core/wasm?url' {
    const wasmURL: string;
    export default wasmURL;
}
