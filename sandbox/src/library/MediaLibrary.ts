// The media library: a picked folder's playable files as a tree, remembered across reloads where the browser keeps directory handles.
import {
    appendSandboxFailure,
    describeError,
    type LibraryState,
    type SandboxLibraryCommands,
    type SandboxMediaFile,
    type SandboxState
} from '../contracts/SandboxContracts';
import type { SandboxStore } from '../ui/Panel';
import type { AccessibleDirectoryHandle, FileSystemHandlePermissionDescriptor } from './FileSystemAccess';
import { type FolderPick, hasDirectoryPicker, pickFolder } from './FolderPicker';
import type { LibraryFailureCode } from './LibraryFailures';
import {
    type LibraryFileSource,
    type LibraryScan,
    readLibraryFile,
    type ScannedFile,
    scanDirectoryHandle,
    scanFolderFiles
} from './LibraryScan';
import { buildLibraryTree, findLibraryFile } from './LibraryTree';
import { readRememberedDirectory, rememberDirectory } from './RememberedDirectory';

const READ_PERMISSION: FileSystemHandlePermissionDescriptor = Object.freeze({ mode: 'read' });
// Neither picker exists: the failure detail names both
const PICKER_APIS_DETAIL = 'showDirectoryPicker webkitdirectory';
// The error a read of a path the last scan did not find rejects with
const NOT_SCANNED_MESSAGE = 'not-scanned';

type ResolvedSubtitleFile = SandboxMediaFile['subtitleFiles'][number];

export function createMediaLibrary(store: SandboxStore): SandboxLibraryCommands {
    // The remembered folder, kept so that restore(true) asks for access while the click's activation lasts
    let rememberedDirectory: AccessibleDirectoryHandle | null = null;
    // Every media and subtitle file of the last scan, by library path
    let fileSources = new Map<string, LibraryFileSource>();
    // Bumped by every scan, so that a scan which a newer one replaced publishes nothing
    let scanGeneration = 0;

    const publishLibrary = (update: Partial<LibraryState>): void => {
        store.setState((state: SandboxState): Partial<SandboxState> => ({ library: { ...state.library, ...update } }));
    };

    const recordFailure = (code: LibraryFailureCode, detail: string): void => {
        store.setState((state: SandboxState): Partial<SandboxState> => ({
            failures: appendSandboxFailure(state.failures, { code, detail, layer: 'library', timeMilliseconds: performance.now() })
        }));
    };

    /** Records a failure and returns the error the command rejects with. */
    const failCommand = (code: LibraryFailureCode, detail: string): Error => {
        recordFailure(code, detail);
        return new Error(`${code}: ${detail}`);
    };

    const publishScan = (scan: LibraryScan): void => {
        const sources = new Map<string, LibraryFileSource>();
        for (const scannedFile of [ ...scan.mediaFiles, ...scan.subtitleFiles ]) {
            sources.set(scannedFile.path, scannedFile.source);
        }
        fileSources = sources;
        const subtitlePaths = scan.subtitleFiles.map((subtitleFile: ScannedFile): string => subtitleFile.path);
        publishLibrary({ root: buildLibraryTree(scan.rootName, scan.mediaFiles, subtitlePaths), selectedPath: null, status: 'ready' });
    };

    const scanDirectory = async (directory: AccessibleDirectoryHandle): Promise<void> => {
        scanGeneration += 1;
        const generation = scanGeneration;
        publishLibrary({ root: null, selectedPath: null, status: 'scanning' });
        const scan = await scanDirectoryHandle(directory, recordFailure);
        if (generation === scanGeneration) {
            publishScan(scan);
        }
    };

    /** Remembers a picked directory; a folder that cannot be remembered still plays this session. */
    const rememberPickedDirectory = async (directory: AccessibleDirectoryHandle): Promise<void> => {
        rememberedDirectory = directory;
        try {
            await rememberDirectory(directory);
        } catch (error) {
            recordFailure('remembered-directory-unsaved', `${directory.name} ${describeError(error)}`);
        }
    };

    const loadRememberedDirectory = async (): Promise<AccessibleDirectoryHandle | null> => {
        try {
            return await readRememberedDirectory();
        } catch (error) {
            throw failCommand('remembered-directory-unreadable', describeError(error));
        }
    };

    /** Reads a file of the last scan by library path. */
    const readScannedFile = (path: string): Promise<File> => {
        const source = fileSources.get(path);
        return source === undefined ? Promise.reject(new Error(NOT_SCANNED_MESSAGE)) : readLibraryFile(source);
    };

    const pickDirectory = async (): Promise<void> => {
        let pick: FolderPick;
        try {
            pick = await pickFolder();
        } catch (error) {
            throw failCommand('directory-picker-failed', describeError(error));
        }
        switch (pick.kind) {
            case 'cancelled':
                return;
            case 'unsupported':
                throw failCommand('directory-picker-unsupported', PICKER_APIS_DETAIL);
            case 'directory-handle':
                await Promise.all([ rememberPickedDirectory(pick.handle), scanDirectory(pick.handle) ]);
                return;
            case 'folder-files':
                // The files are already read, so this replaces any directory scan still running
                scanGeneration += 1;
                publishScan(scanFolderFiles(pick.files));
                return;
        }
    };

    const restore = async (requestPermission: boolean): Promise<void> => {
        // Only the directory picker's handles persist, so a browser without it has nothing to restore
        if (!hasDirectoryPicker()) {
            return;
        }
        const directory = rememberedDirectory ?? await loadRememberedDirectory();
        if (directory === null) {
            return;
        }
        rememberedDirectory = directory;
        let permission: PermissionState;
        try {
            permission = await (requestPermission ?
                directory.requestPermission(READ_PERMISSION) :
                directory.queryPermission(READ_PERMISSION));
        } catch (error) {
            throw failCommand('permission-request-failed', `${directory.name} ${describeError(error)}`);
        }
        switch (permission) {
            case 'granted':
                await scanDirectory(directory);
                return;
            case 'denied':
            case 'prompt':
                publishLibrary({ root: null, selectedPath: null, status: 'permission-needed' });
                if (requestPermission) {
                    throw failCommand('permission-denied', `${directory.name} ${permission}`);
                }
                return;
        }
    };

    /** Resolves a file of the tree with its subtitle files, and selects it; a subtitle file that cannot be read is reported and left out. */
    const resolveMedia = async (path: string): Promise<SandboxMediaFile> => {
        const root = store.getState().library.root;
        const libraryFile = root === null ? null : findLibraryFile(root, path);
        if (libraryFile === null) {
            throw failCommand('media-not-found', path);
        }
        // Selecting before the reads keeps the selection on the last click
        publishLibrary({ selectedPath: path });
        let file: File;
        try {
            file = await readScannedFile(path);
        } catch (error) {
            throw failCommand('media-unreadable', `${path} ${describeError(error)}`);
        }
        const subtitleFiles: ResolvedSubtitleFile[] = [];
        for (const subtitlePath of libraryFile.subtitlePaths) {
            try {
                subtitleFiles.push({ file: await readScannedFile(subtitlePath), path: subtitlePath });
            } catch (error) {
                recordFailure('subtitle-unreadable', `${subtitlePath} ${describeError(error)}`);
            }
        }
        return { file, path, subtitleFiles };
    };

    return { pickDirectory, resolveMedia, restore };
}
