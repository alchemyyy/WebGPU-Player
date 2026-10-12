// The sandbox's dev server: the engine's sources through the webgpu-player alias, and its output folder at the root.
// Run it with npm run sandbox, which builds the served assets first; localhost is a secure context, so WebGPU works.
import { fileURLToPath } from 'node:url';

import { defineConfig, searchForWorkspaceRoot } from 'vite';

import LAYOUT from '../tools/constants.json';

const ENGINE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SANDBOX_ROOT = fileURLToPath(new URL('.', import.meta.url));
const SANDBOX_PORT = 5180;

export default defineConfig({
    // The engine's default asset base is libraries/ beside the page, which this maps to the asset build in bin/libraries/
    publicDir: `${ENGINE_ROOT}${LAYOUT.outputDirectory}`,
    resolve: {
        alias: { 'webgpu-player': `${ENGINE_ROOT}${LAYOUT.sourceDirectory}` }
    },
    root: SANDBOX_ROOT,
    server: {
        fs: { allow: [ searchForWorkspaceRoot(process.cwd()), ENGINE_ROOT ] },
        port: SANDBOX_PORT
    }
});
