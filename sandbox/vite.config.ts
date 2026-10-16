// The sandbox's dev server: the engine's sources through the webgpu-player alias, and its output folder at the root.
// Run it with npm run sandbox, which builds the served assets first; localhost is a secure context, so WebGPU works.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig, searchForWorkspaceRoot, type Plugin } from 'vite';

import { BUILT_DECODER_PACKAGES_ROUTE, BUILT_PASSES_ROUTE, type BuiltOutputEntry } from './src/session/BuiltOutputRoutes';
import LAYOUT from '../tools/constants.json';

const ENGINE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SANDBOX_PORT = 5180;
const JSON_CONTENT_TYPE = 'application/json';

/**
 * Lists an output folder's files at a route, freshly on each request, so a panel can add the latest builds.
 * The folder lies below the output folder the dev server serves as its public folder, which gives each file's URL.
 */
function listOutputFolderPlugin(route: string, outputDirectory: string, name: string): Plugin {
    const urlPath = outputDirectory.slice(`${LAYOUT.outputDirectory}/`.length);
    return {
        configureServer(server): void {
            server.middlewares.use(route, (_request, response): void => {
                let fileNames: string[] = [];
                try {
                    fileNames = readdirSync(`${ENGINE_ROOT}${outputDirectory}`).sort();
                } catch {
                    // Nothing is built yet
                    fileNames = [];
                }
                const entries: BuiltOutputEntry[] = fileNames.map((fileName: string): BuiltOutputEntry => ({
                    fileName,
                    url: `/${urlPath}/${fileName}`
                }));
                response.setHeader('Content-Type', JSON_CONTENT_TYPE);
                response.end(JSON.stringify(entries));
            });
        },
        name
    };
}

export default defineConfig({
    // ffmpeg.wasm starts its worker from a URL relative to its own module, which pre-bundling would move
    optimizeDeps: { exclude: [ '@ffmpeg/ffmpeg' ] },
    plugins: [
        listOutputFolderPlugin(BUILT_DECODER_PACKAGES_ROUTE, LAYOUT.decoderOutputDirectory, 'sandbox-built-decoder-packages'),
        listOutputFolderPlugin(BUILT_PASSES_ROUTE, LAYOUT.passOutputDirectory, 'sandbox-built-passes')
    ],
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
