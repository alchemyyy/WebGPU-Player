// Which files the library keeps, how library paths are built, and which subtitle files belong to a media file.
import { isCustomPlaybackContainer } from 'webgpu-player/capability/CustomContainerCodecSupport';

/** Separates the folders of a library path, which is relative to the picked folder. */
export const LIBRARY_PATH_SEPARATOR = '/';
/** The library path of the picked folder itself. */
export const LIBRARY_ROOT_PATH = '';
/** The subtitle file formats the library keeps beside media files; the session reads their cues as plain text. */
export const SUBTITLE_FILE_EXTENSIONS: readonly string[] = Object.freeze([ 'ass', 'srt', 'ssa', 'vtt' ]);

const EXTENSION_SEPARATOR = '.';
// Hidden entries, such as .git and the AppleDouble ._ files macOS writes beside media on other file systems
const HIDDEN_ENTRY_PREFIX = '.';
// Failure details name the picked folder itself this way, since its library path is empty
const ROOT_PATH_DETAIL = '.';

/** What the library keeps a file as: media that the engine's container rules carry, or a subtitle file. */
export type LibraryFileKind = 'media' | 'subtitle';

/** Returns a file name's extension in lowercase, or '' when it has none. */
export function getFileExtension(name: string): string {
    const separatorIndex = name.lastIndexOf(EXTENSION_SEPARATOR);
    return separatorIndex <= 0 ? '' : name.slice(separatorIndex + 1).toLowerCase();
}

/** Returns a file name without its extension. */
export function getBaseName(name: string): string {
    const separatorIndex = name.lastIndexOf(EXTENSION_SEPARATOR);
    return separatorIndex <= 0 ? name : name.slice(0, separatorIndex);
}

/** Returns whether a folder or file is hidden, which the library skips with everything below it. */
export function isHiddenEntryName(name: string): boolean {
    return name.startsWith(HIDDEN_ENTRY_PREFIX);
}

/** Returns what the library keeps a file as, by its extension, or null when it skips the file. */
export function classifyLibraryFileName(name: string): LibraryFileKind | null {
    const extension = getFileExtension(name);
    if (extension === '') {
        return null;
    }
    if (isCustomPlaybackContainer(extension)) {
        return 'media';
    }
    return SUBTITLE_FILE_EXTENSIONS.includes(extension) ? 'subtitle' : null;
}

/**
 * Returns whether a subtitle file in the same folder belongs to a media file, ignoring case.
 * Its base name must be the media's base name, or start with it and a '.', so movie.en.srt belongs to movie.mkv and movie 2.srt does not.
 */
export function isSubtitleFileFor(mediaName: string, subtitleName: string): boolean {
    const mediaBaseName = getBaseName(mediaName).toLowerCase();
    const subtitleBaseName = getBaseName(subtitleName).toLowerCase();
    return subtitleBaseName === mediaBaseName || subtitleBaseName.startsWith(`${mediaBaseName}${EXTENSION_SEPARATOR}`);
}

/** Returns the library path of an entry in a folder. */
export function joinLibraryPath(directoryPath: string, name: string): string {
    return directoryPath === LIBRARY_ROOT_PATH ? name : `${directoryPath}${LIBRARY_PATH_SEPARATOR}${name}`;
}

/** Returns the library path of the folder that holds an entry. */
export function getParentLibraryPath(path: string): string {
    const separatorIndex = path.lastIndexOf(LIBRARY_PATH_SEPARATOR);
    return separatorIndex < 0 ? LIBRARY_ROOT_PATH : path.slice(0, separatorIndex);
}

/** Returns the name of the entry at a library path. */
export function getLibraryEntryName(path: string): string {
    return path.slice(path.lastIndexOf(LIBRARY_PATH_SEPARATOR) + 1);
}

/** Returns a library path as a failure detail shows it. */
export function formatLibraryPathDetail(path: string): string {
    return path === LIBRARY_ROOT_PATH ? ROOT_PATH_DETAIL : path;
}
