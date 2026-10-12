// The media library: a picked folder's playable files as a tree, remembered across reloads.
import type { SandboxLibraryCommands } from '../contracts/SandboxContracts';
import type { SandboxStore } from '../ui/Panel';

/* eslint-disable @typescript-eslint/no-unused-vars -- A placeholder that the library work replaces */
export function createMediaLibrary(store: SandboxStore): SandboxLibraryCommands {
    const notImplemented = (): never => {
        throw new Error('not-implemented: library');
    };
    return {
        pickDirectory: notImplemented,
        resolveMedia: notImplemented,
        restore: notImplemented
    };
}
/* eslint-enable @typescript-eslint/no-unused-vars */
