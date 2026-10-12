import { describe, expect, it, vi } from 'vitest';

import { createInitialSandboxState, type SandboxState } from '../../../sandbox/src/contracts/SandboxContracts';
import { pickFolder } from '../../../sandbox/src/library/FolderPicker';
import { createMediaLibrary } from '../../../sandbox/src/library/MediaLibrary';
import { createStore, type Store } from '../../../sandbox/src/ui/Store';

// jsdom has neither picker, so every test chooses what the pick produces; without the directory picker there is nothing to restore
vi.mock('../../../sandbox/src/library/FolderPicker', () => ({
    hasDirectoryPicker: vi.fn((): boolean => false),
    pickFolder: vi.fn()
}));

const ROOT_NAME = 'Library';
const MOVIE_PATH = 'movie.mkv';
const MOVIE_SUBTITLE_PATH = 'movie.en.srt';
const MISSING_PATH = 'missing.mkv';
const MOVIE_SIZE_BYTES = 64;
const SUBTITLE_SIZE_BYTES = 8;
const PICKER_FAILURE_NAME = 'SecurityError';

/** A file as a folder input gives it, with its path below the picked folder's parent. */
function createFolderFile(path: string, sizeBytes: number): File {
    const file = new File([ new Uint8Array(sizeBytes) ], path.slice(path.lastIndexOf('/') + 1));
    Object.defineProperty(file, 'webkitRelativePath', { value: `${ROOT_NAME}/${path}` });
    return file;
}

function createSandboxStore(): Store<SandboxState> {
    return createStore<SandboxState>(createInitialSandboxState());
}

describe('MediaLibrary', () => {
    it('publishes the files a folder input chose as a ready tree, and resolves a file with its subtitle files', async () => {
        const movieFile = createFolderFile(MOVIE_PATH, MOVIE_SIZE_BYTES);
        const subtitleFile = createFolderFile(MOVIE_SUBTITLE_PATH, SUBTITLE_SIZE_BYTES);
        vi.mocked(pickFolder).mockResolvedValueOnce({ files: [ movieFile, subtitleFile ], kind: 'folder-files' });
        const store = createSandboxStore();
        const library = createMediaLibrary(store);

        await library.pickDirectory();
        const libraryState = store.getState().library;
        expect(libraryState.status).toBe('ready');
        expect(libraryState.root?.name).toBe(ROOT_NAME);
        expect(libraryState.root?.children).toEqual([
            { kind: 'file', name: MOVIE_PATH, path: MOVIE_PATH, sizeBytes: MOVIE_SIZE_BYTES, subtitlePaths: [ MOVIE_SUBTITLE_PATH ] }
        ]);

        const media = await library.resolveMedia(MOVIE_PATH);
        expect(media).toEqual({ file: movieFile, path: MOVIE_PATH, subtitleFiles: [ { file: subtitleFile, path: MOVIE_SUBTITLE_PATH } ] });
        expect(store.getState().library.selectedPath).toBe(MOVIE_PATH);
        expect(store.getState().failures).toEqual([]);
    });

    it('changes nothing when the picker is cancelled', async () => {
        vi.mocked(pickFolder).mockResolvedValueOnce({ kind: 'cancelled' });
        const store = createSandboxStore();
        const initialState = store.getState();

        await createMediaLibrary(store).pickDirectory();
        expect(store.getState()).toBe(initialState);
    });

    it('records a failure and rejects when the browser has no picker, or the picker fails', async () => {
        const store = createSandboxStore();
        const library = createMediaLibrary(store);
        vi.mocked(pickFolder).mockResolvedValueOnce({ kind: 'unsupported' });
        await expect(library.pickDirectory()).rejects.toThrow('directory-picker-unsupported');
        vi.mocked(pickFolder).mockRejectedValueOnce(new DOMException('', PICKER_FAILURE_NAME));
        await expect(library.pickDirectory()).rejects.toThrow('directory-picker-failed');

        expect(store.getState().failures.map(({ code, detail, layer }) => ({ code, detail, layer }))).toEqual([
            { code: 'directory-picker-unsupported', detail: 'showDirectoryPicker webkitdirectory', layer: 'library' },
            { code: 'directory-picker-failed', detail: PICKER_FAILURE_NAME, layer: 'library' }
        ]);
        expect(store.getState().library.status).toBe('empty');
    });

    it('records a failure and rejects for a path the tree does not hold, keeping the selection', async () => {
        vi.mocked(pickFolder).mockResolvedValueOnce({ files: [ createFolderFile(MOVIE_PATH, MOVIE_SIZE_BYTES) ], kind: 'folder-files' });
        const store = createSandboxStore();
        const library = createMediaLibrary(store);
        await library.pickDirectory();
        await library.resolveMedia(MOVIE_PATH);

        await expect(library.resolveMedia(MISSING_PATH)).rejects.toThrow(`media-not-found: ${MISSING_PATH}`);
        expect(store.getState().failures.map(({ code, detail }) => ({ code, detail }))).toEqual([
            { code: 'media-not-found', detail: MISSING_PATH }
        ]);
        expect(store.getState().library.selectedPath).toBe(MOVIE_PATH);
    });

    it('restores nothing where the browser keeps no directory handles', async () => {
        const store = createSandboxStore();
        const initialState = store.getState();
        const library = createMediaLibrary(store);

        await library.restore(false);
        await library.restore(true);
        expect(store.getState()).toBe(initialState);
    });
});
