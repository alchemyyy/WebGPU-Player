// The sandbox's dev server: the engine's sources through the webgpu-player alias, and its output folder at the root.
// Run it with npm run sandbox, which builds the served assets first; localhost is a secure context, so WebGPU works.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';

import { BUILT_DECODER_PACKAGES_ROUTE, type BuiltDecoderPackageEntry } from './src/session/BuiltDecoderPackageRoute';
import LAYOUT from '../tools/constants.json';

const ENGINE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SANDBOX_PORT = 5180;
const JSON_CONTENT_TYPE = 'application/json';
// The decoder package output folder's URL path, below the output folder the dev server serves as its public folder
const DECODER_OUTPUT_URL_PATH = LAYOUT.decoderOutputDirectory.slice(`${LAYOUT.outputDirectory}/`.length);

/** Lists the decoder package output folder's files at BUILT_DECODER_PACKAGES_ROUTE, freshly on each request, so the panel can add the latest builds. */
function builtDecoderPackagesPlugin(): Plugin {
    return {
        configureServer(server): void {
            server.middlewares.use(BUILT_DECODER_PACKAGES_ROUTE, (_request, response): void => {
                let fileNames: string[] = [];
                try {
                    fileNames = readdirSync(`${ENGINE_ROOT}${LAYOUT.decoderOutputDirectory}`).sort();
                } catch {
                    // No package is built yet
                    fileNames = [];
                }
                const entries: BuiltDecoderPackageEntry[] = fileNames.map((fileName: string): BuiltDecoderPackageEntry => ({
                    fileName,
                    url: `/${DECODER_OUTPUT_URL_PATH}/${fileName}`
                }));
                response.setHeader('Content-Type', JSON_CONTENT_TYPE);
                response.end(JSON.stringify(entries));
            });
        },
        name: 'sandbox-built-decoder-packages'
    };
}

export default defineConfig({
    // ffmpeg.wasm starts its worker from a URL relative to its own module, which pre-bundling would move
    optimizeDeps: { exclude: [ '@ffmpeg/ffmpeg' ] },
    plugins: [ builtDecoderPackagesPlugin() ],
    // The engine's default asset base is libraries/ beside the page, which this maps to the asset build in bin/libraries/
    publicDir: `${ENGINE_ROOT}${LAYOUT.outputDirectory}`,
    resolve: {
        alias: { 'webgpu-player': `${ENGINE_ROOT}${LAYOUT.sourceDirectory}` }
    },
    root: SANDBOX_ROOT,
    server: {
        fs: { allow: [ searchForWorkspaceRoot(process.cwd()), ENGINE_ROOT ] },
        port: SANDBOX_PORT
    },
    // ffmpeg.wasm's worker is an ES module
    worker: { format: 'es' }
});
