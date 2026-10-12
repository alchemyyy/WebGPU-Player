// Reads a picked folder's media and subtitle files: a directory handle walked with an explicit work list, or the files a folder input chose.
import type { AccessibleDirectoryHandle } from './FileSystemAccess';
import { describeError, type LibraryFailureReporter } from './LibraryFailures';
import {
    classifyLibraryFileName,
    formatLibraryPathDetail,
    isHiddenEntryName,
    joinLibraryPath,
    LIBRARY_PATH_SEPARATOR,
    LIBRARY_ROOT_PATH
} from './LibraryFiles';

/** Where a file's contents come from: a directory handle's file, or a file the folder input chose. */
export type LibraryFileSource = File | FileSystemFileHandle;

export type ScannedFile = Readonly<{ path: string; source: LibraryFileSource }>;

export type ScannedMediaFile = ScannedFile & Readonly<{ sizeBytes: number }>;

export type LibraryScan = Readonly<{
    mediaFiles: readonly ScannedMediaFile[]
    /** The picked folder's name */
    rootName: string
    subtitleFiles: readonly ScannedFile[]
}>;

type PendingDirectory = Readonly<{ handle: AccessibleDirectoryHandle; path: string }>;

/** Returns a scanned file's contents. */
export function readLibraryFile(source: LibraryFileSource): Promise<File> {
    return source instanceof File ? Promise.resolve(source) : source.getFile();
}

/** Reads a media file's size; a file that cannot be read is reported and left out. */
async function readMediaFile(
    handle: FileSystemFileHandle,
    path: string,
    reportFailure: LibraryFailureReporter
): Promise<ScannedMediaFile | null> {
    try {
        const file = await handle.getFile();
        return { path, sizeBytes: file.size, source: handle };
    } catch (error) {
        reportFailure('file-unreadable', `${path} ${describeError(error)}`);
        return null;
    }
}

/**
 * Lists one folder, skipping hidden entries: queues its subfolders, keeps its subtitle files, and returns its media files.
 * A folder that cannot be listed is reported, keeping the entries listed before the failure.
 */
async function listDirectory(
    directory: PendingDirectory,
    pendingDirectories: PendingDirectory[],
    subtitleFiles: ScannedFile[],
    reportFailure: LibraryFailureReporter
): Promise<ScannedMediaFile[]> {
    const mediaReads: Promise<ScannedMediaFile | null>[] = [];
    try {
        for await (const entry of directory.handle.values()) {
            if (isHiddenEntryName(entry.name)) {
                continue;
            }
            const entryPath = joinLibraryPath(directory.path, entry.name);
            if (entry.kind === 'directory') {
                pendingDirectories.push({ handle: entry, path: entryPath });
                continue;
            }
            switch (classifyLibraryFileName(entry.name)) {
                case 'media':
                    mediaReads.push(readMediaFile(entry, entryPath, reportFailure));
                    break;
                case 'subtitle':
                    subtitleFiles.push({ path: entryPath, source: entry });
                    break;
                case null:
                    break;
            }
        }
    } catch (error) {
        reportFailure('directory-unreadable', `${formatLibraryPathDetail(directory.path)} ${describeError(error)}`);
    }
    const mediaFiles = await Promise.all(mediaReads);
    return mediaFiles.filter((mediaFile: ScannedMediaFile | null): mediaFile is ScannedMediaFile => mediaFile !== null);
}

/**
 * Walks a directory handle and every folder below it.
 * A folder or file that cannot be read is reported and left out, and the walk goes on.
 */
export async function scanDirectoryHandle(root: AccessibleDirectoryHandle, reportFailure: LibraryFailureReporter): Promise<LibraryScan> {
    const mediaFiles: ScannedMediaFile[] = [];
    const subtitleFiles: ScannedFile[] = [];
    const pendingDirectories: PendingDirectory[] = [];
    pendingDirectories.push({ handle: root, path: LIBRARY_ROOT_PATH });
    let directory = pendingDirectories.pop();
    while (directory !== undefined) {
        for (const mediaFile of await listDirectory(directory, pendingDirectories, subtitleFiles, reportFailure)) {
            mediaFiles.push(mediaFile);
        }
        directory = pendingDirectories.pop();
    }
    return { mediaFiles, rootName: root.name, subtitleFiles };
}

/**
 * Sorts the files a folder input chose into media and subtitle files, skipping those below hidden folders.
 * Each file's webkitRelativePath starts with the picked folder's name, which the library path drops.
 */
export function scanFolderFiles(files: readonly File[]): LibraryScan {
    const mediaFiles: ScannedMediaFile[] = [];
    const subtitleFiles: ScannedFile[] = [];
    let rootName = '';
    for (const file of files) {
        // Every file's first segment is the same picked folder
        const [ folderName, ...pathSegments ] = file.webkitRelativePath.split(LIBRARY_PATH_SEPARATOR);
        rootName = folderName;
        if (pathSegments.some(isHiddenEntryName)) {
            continue;
        }
        const path = pathSegments.join(LIBRARY_PATH_SEPARATOR);
        switch (classifyLibraryFileName(file.name)) {
            case 'media':
                mediaFiles.push({ path, sizeBytes: file.size, source: file });
                break;
            case 'subtitle':
                subtitleFiles.push({ path, source: file });
                break;
            case null:
                break;
        }
    }
    return { mediaFiles, rootName, subtitleFiles };
}
