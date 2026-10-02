import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute engine repository root, independent of the test runner's working directory. */
export const ENGINE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// A dependency every engine install has; tool caches can create node_modules without it
const INSTALLED_DEPENDENCY_MARKER = join('mediabunny', 'package.json');

/** Finds the nearest installed node_modules, which is the host's when the engine is a submodule. */
function findNodeModulesRoot(startDirectory: string): string {
    let directory = startDirectory;
    for (;;) {
        const candidate = join(directory, 'node_modules');
        if (existsSync(join(candidate, INSTALLED_DEPENDENCY_MARKER))) {
            return candidate;
        }
        const parentDirectory = dirname(directory);
        if (parentDirectory === directory) {
            throw new Error(`No node_modules directory above ${startDirectory}`);
        }
        directory = parentDirectory;
    }
}

/** Directory that holds the engine's installed npm dependencies. */
export const NODE_MODULES_ROOT = findNodeModulesRoot(ENGINE_ROOT);
