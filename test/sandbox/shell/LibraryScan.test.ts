import { describe, expect, it, vi } from 'vitest';

import type { AccessibleDirectoryHandle } from '../../../sandbox/src/library/FileSystemAccess';
import {
    type LibraryScan,
    readLibraryFile,
    type ScannedFile,
    type ScannedMediaFile,
    scanDirectoryHandle,
    scanFolderFiles
} from '../../../sandbox/src/library/LibraryScan';

const ROOT_NAME = 'Library';
const MOVIE_NAME = 'movie.mkv';
const MOVIE_SUBTITLE_NAME = 'movie.en.srt';
const EPISODE_NAME = 'episode.mp4';
const SHOWS_FOLDER_NAME = 'Shows';
const SEASON_FOLDER_NAME = 'Season 1';
const EPISODE_PATH = 'Shows/Season 1/episode.mp4';
// Entries the scan skips: a file no rule keeps, an AppleDouble file, and a hidden folder with media inside
const SKIPPED_FILE_NAME = 'notes.txt';
const APPLE_DOUBLE_NAME = '._movie.mkv';
const HIDDEN_FOLDER_NAME = '.hidden';
const HIDDEN_MEDIA_NAME = 'secret.mkv';
const BROKEN_FOLDER_NAME = 'Broken';
const KEPT_MEDIA_NAME = 'kept.mkv';
const KEPT_MEDIA_PATH = 'Broken/kept.mkv';
const UNREADABLE_MEDIA_NAME = 'unreadable.mkv';
const MOVIE_SIZE_BYTES = 64;
const EPISODE_SIZE_BYTES = 32;
const SKIPPED_SIZE_BYTES = 1;
const LISTING_FAILURE_NAME = 'NotAllowedError';
const READ_FAILURE_NAME = 'NotReadableError';
// Failure details name the picked folder itself this way
const ROOT_PATH_DETAIL = '.';

type FakeHandle = AccessibleDirectoryHandle | FileSystemFileHandle;

/** A file handle whose file has the given size, or whose read fails with the given error. */
function createFileHandle(name: string, sizeBytes: number, readFailure: DOMException | null = null): FileSystemFileHandle {
    const getFile = (): Promise<File> => (
        readFailure === null ? Promise.resolve(new File([ new Uint8Array(sizeBytes) ], name)) : Promise.reject(readFailure)
    );
    return { getFile, kind: 'file', name } as unknown as FileSystemFileHandle;
}

/** A directory handle that lists its entries, then fails with the given error. */
function createDirectoryHandle(name: string, entries: readonly FakeHandle[], listingFailure: DOMException | null = null): AccessibleDirectoryHandle {
    async function* listEntries(): AsyncGenerator<FakeHandle> {
        for (const entry of entries) {
            yield entry;
        }
        if (listingFailure !== null) {
            throw listingFailure;
        }
    }
    return { kind: 'directory', name, values: listEntries } as unknown as AccessibleDirectoryHandle;
}

/** A file as a folder input gives it, with the picked folder's name before its library path. */
function createFolderFile(path: string, sizeBytes: number): File {
    const file = new File([ new Uint8Array(sizeBytes) ], path.slice(path.lastIndexOf('/') + 1));
    Object.defineProperty(file, 'webkitRelativePath', { value: `${ROOT_NAME}/${path}` });
    return file;
}

function compareText(firstText: string, secondText: string): number {
    return firstText.localeCompare(secondText);
}

function listPaths(scannedFiles: readonly ScannedFile[]): string[] {
    return scannedFiles.map((scannedFile: ScannedFile): string => scannedFile.path).sort(compareText);
}

/** Lists path and size pairs in path order, since the walk order is not part of the result. */
function listMediaSizes(scan: LibraryScan): [ string, number ][] {
    return [ ...scan.mediaFiles ]
        .sort((firstFile: ScannedMediaFile, secondFile: ScannedMediaFile): number => compareText(firstFile.path, secondFile.path))
        .map((mediaFile: ScannedMediaFile): [ string, number ] => [ mediaFile.path, mediaFile.sizeBytes ]);
}

describe('LibraryScan', () => {
    it('walks every folder below the root, keeping media and subtitle files and skipping hidden entries', async () => {
        const root = createDirectoryHandle(ROOT_NAME, [
            createFileHandle(MOVIE_NAME, MOVIE_SIZE_BYTES),
            createFileHandle(MOVIE_SUBTITLE_NAME, SKIPPED_SIZE_BYTES),
            createFileHandle(SKIPPED_FILE_NAME, SKIPPED_SIZE_BYTES),
            createFileHandle(APPLE_DOUBLE_NAME, SKIPPED_SIZE_BYTES),
            createDirectoryHandle(HIDDEN_FOLDER_NAME, [ createFileHandle(HIDDEN_MEDIA_NAME, SKIPPED_SIZE_BYTES) ]),
            createDirectoryHandle(SHOWS_FOLDER_NAME, [
                createDirectoryHandle(SEASON_FOLDER_NAME, [ createFileHandle(EPISODE_NAME, EPISODE_SIZE_BYTES) ])
            ])
        ]);
        const reportFailure = vi.fn();
        const scan = await scanDirectoryHandle(root, reportFailure);

        expect(scan.rootName).toBe(ROOT_NAME);
        expect(listMediaSizes(scan)).toEqual([
            [ MOVIE_NAME, MOVIE_SIZE_BYTES ],
            [ EPISODE_PATH, EPISODE_SIZE_BYTES ]
        ]);
        expect(listPaths(scan.subtitleFiles)).toEqual([ MOVIE_SUBTITLE_NAME ]);
        expect(reportFailure).not.toHaveBeenCalled();
    });

    it('reports an unreadable folder and file, and keeps everything else, including entries listed before the failure', async () => {
        const root = createDirectoryHandle(ROOT_NAME, [
            createDirectoryHandle(
                BROKEN_FOLDER_NAME,
                [ createFileHandle(KEPT_MEDIA_NAME, EPISODE_SIZE_BYTES) ],
                new DOMException('', LISTING_FAILURE_NAME)
            ),
            createFileHandle(UNREADABLE_MEDIA_NAME, SKIPPED_SIZE_BYTES, new DOMException('', READ_FAILURE_NAME)),
            createFileHandle(MOVIE_NAME, MOVIE_SIZE_BYTES)
        ]);
        const reportFailure = vi.fn();
        const scan = await scanDirectoryHandle(root, reportFailure);

        expect(listMediaSizes(scan)).toEqual([
            [ KEPT_MEDIA_PATH, EPISODE_SIZE_BYTES ],
            [ MOVIE_NAME, MOVIE_SIZE_BYTES ]
        ]);
        expect(reportFailure).toHaveBeenCalledTimes(2);
        expect(reportFailure).toHaveBeenCalledWith('directory-unreadable', `${BROKEN_FOLDER_NAME} ${LISTING_FAILURE_NAME}`);
        expect(reportFailure).toHaveBeenCalledWith('file-unreadable', `${UNREADABLE_MEDIA_NAME} ${READ_FAILURE_NAME}`);
    });

    it('names the picked folder as . when the root itself cannot be listed', async () => {
        const root = createDirectoryHandle(ROOT_NAME, [], new DOMException('', LISTING_FAILURE_NAME));
        const reportFailure = vi.fn();
        const scan = await scanDirectoryHandle(root, reportFailure);

        expect(scan.mediaFiles).toEqual([]);
        expect(reportFailure).toHaveBeenCalledWith('directory-unreadable', `${ROOT_PATH_DETAIL} ${LISTING_FAILURE_NAME}`);
    });

    it('drops the picked folder from folder input paths, and skips hidden files and everything below hidden folders', () => {
        const movieFile = createFolderFile(MOVIE_NAME, MOVIE_SIZE_BYTES);
        const scan = scanFolderFiles([
            movieFile,
            createFolderFile(MOVIE_SUBTITLE_NAME, SKIPPED_SIZE_BYTES),
            createFolderFile(SKIPPED_FILE_NAME, SKIPPED_SIZE_BYTES),
            createFolderFile(APPLE_DOUBLE_NAME, SKIPPED_SIZE_BYTES),
            createFolderFile(`${HIDDEN_FOLDER_NAME}/${HIDDEN_MEDIA_NAME}`, SKIPPED_SIZE_BYTES),
            createFolderFile(`${SHOWS_FOLDER_NAME}/${HIDDEN_FOLDER_NAME}/${HIDDEN_MEDIA_NAME}`, SKIPPED_SIZE_BYTES),
            createFolderFile(EPISODE_PATH, EPISODE_SIZE_BYTES)
        ]);

        expect(scan.rootName).toBe(ROOT_NAME);
        expect(listMediaSizes(scan)).toEqual([
            [ MOVIE_NAME, MOVIE_SIZE_BYTES ],
            [ EPISODE_PATH, EPISODE_SIZE_BYTES ]
        ]);
        expect(listPaths(scan.subtitleFiles)).toEqual([ MOVIE_SUBTITLE_NAME ]);
        expect(scan.mediaFiles.find((mediaFile: ScannedMediaFile): boolean => mediaFile.path === MOVIE_NAME)?.source).toBe(movieFile);
    });

    it('reads a chosen file as itself, and a handle through getFile', async () => {
        const chosenFile = createFolderFile(MOVIE_NAME, MOVIE_SIZE_BYTES);
        expect(await readLibraryFile(chosenFile)).toBe(chosenFile);
        expect((await readLibraryFile(createFileHandle(MOVIE_NAME, MOVIE_SIZE_BYTES))).size).toBe(MOVIE_SIZE_BYTES);
    });
});
