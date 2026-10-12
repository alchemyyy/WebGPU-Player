// Builds the library tree from a scan's flat paths, finds files in it, and lists the entries a partly expanded tree shows.
import type { LibraryDirectory, LibraryEntry, LibraryFile } from '../contracts/SandboxContracts';
import {
    getLibraryEntryName,
    getParentLibraryPath,
    isSubtitleFileFor,
    LIBRARY_PATH_SEPARATOR,
    LIBRARY_ROOT_PATH
} from './LibraryFiles';

/** A media file the tree lists: its library path and size. */
export type LibraryTreeMediaFile = Readonly<{ path: string; sizeBytes: number }>;

/** An entry a partly expanded tree shows, with its depth below the root. */
export type VisibleLibraryEntry = Readonly<{ depth: number; entry: LibraryEntry }>;

type DirectoryBuilder = { children: LibraryEntry[]; kind: 'directory'; name: string; path: string };

// Natural order, so episode 2 sorts before episode 10
const ENTRY_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Orders names naturally, then by code units, so names that differ only in case keep a stable order. */
function compareEntryNames(firstName: string, secondName: string): number {
    const naturalOrder = ENTRY_NAME_COLLATOR.compare(firstName, secondName);
    if (naturalOrder !== 0 || firstName === secondName) {
        return naturalOrder;
    }
    return firstName < secondName ? -1 : 1;
}

/** Orders folders before files, then by name. */
function compareLibraryEntries(firstEntry: LibraryEntry, secondEntry: LibraryEntry): number {
    if (firstEntry.kind !== secondEntry.kind) {
        return firstEntry.kind === 'directory' ? -1 : 1;
    }
    return compareEntryNames(firstEntry.name, secondEntry.name);
}

/** Returns the folder at a path, creating it and every missing folder above it. */
function requireDirectory(directoriesByPath: Map<string, DirectoryBuilder>, path: string): DirectoryBuilder {
    const missingPaths: string[] = [];
    let ancestorPath = path;
    let ancestor = directoriesByPath.get(ancestorPath);
    // The root is always present, so the walk up ends there at the latest
    while (ancestor === undefined) {
        missingPaths.push(ancestorPath);
        ancestorPath = getParentLibraryPath(ancestorPath);
        ancestor = directoriesByPath.get(ancestorPath);
    }
    let directory = ancestor;
    for (let pathIndex = missingPaths.length - 1; pathIndex >= 0; pathIndex -= 1) {
        const childPath = missingPaths[pathIndex];
        const child: DirectoryBuilder = { children: [], kind: 'directory', name: getLibraryEntryName(childPath), path: childPath };
        directory.children.push(child);
        directoriesByPath.set(childPath, child);
        directory = child;
    }
    return directory;
}

/**
 * Builds the tree of a picked folder's media files, which leaves out folders that hold no media below them.
 * Each file lists the subtitle files beside it that isSubtitleFileFor accepts.
 */
export function buildLibraryTree(
    rootName: string,
    mediaFiles: readonly LibraryTreeMediaFile[],
    subtitlePaths: readonly string[]
): LibraryDirectory {
    const root: DirectoryBuilder = { children: [], kind: 'directory', name: rootName, path: LIBRARY_ROOT_PATH };
    const directoriesByPath = new Map<string, DirectoryBuilder>();
    directoriesByPath.set(LIBRARY_ROOT_PATH, root);
    const subtitlePathsByDirectory = new Map<string, string[]>();
    for (const subtitlePath of subtitlePaths) {
        const directoryPath = getParentLibraryPath(subtitlePath);
        const siblingPaths = subtitlePathsByDirectory.get(directoryPath);
        if (siblingPaths === undefined) {
            subtitlePathsByDirectory.set(directoryPath, [ subtitlePath ]);
        } else {
            siblingPaths.push(subtitlePath);
        }
    }
    for (const mediaFile of mediaFiles) {
        const directoryPath = getParentLibraryPath(mediaFile.path);
        const name = getLibraryEntryName(mediaFile.path);
        const matchingSubtitlePaths = (subtitlePathsByDirectory.get(directoryPath) ?? [])
            .filter((subtitlePath: string): boolean => isSubtitleFileFor(name, getLibraryEntryName(subtitlePath)))
            .sort(compareEntryNames);
        requireDirectory(directoriesByPath, directoryPath).children.push({
            kind: 'file',
            name,
            path: mediaFile.path,
            sizeBytes: mediaFile.sizeBytes,
            subtitlePaths: matchingSubtitlePaths
        });
    }
    for (const directory of directoriesByPath.values()) {
        directory.children.sort(compareLibraryEntries);
    }
    return root;
}

/** Returns the file at a library path, or null when the tree has no file there. */
export function findLibraryFile(root: LibraryDirectory, path: string): LibraryFile | null {
    let directory: LibraryDirectory = root;
    for (;;) {
        const entry = directory.children.find((child: LibraryEntry): boolean => (
            child.path === path || path.startsWith(`${child.path}${LIBRARY_PATH_SEPARATOR}`)
        ));
        if (entry === undefined) {
            return null;
        }
        switch (entry.kind) {
            case 'file':
                return entry.path === path ? entry : null;
            case 'directory':
                if (entry.path === path) {
                    return null;
                }
                directory = entry;
                break;
        }
    }
}

/** Pushes a folder's children so that its first child pops first. */
function pushChildrenInReverse(pendingEntries: VisibleLibraryEntry[], directory: LibraryDirectory, depth: number): void {
    for (let childIndex = directory.children.length - 1; childIndex >= 0; childIndex -= 1) {
        pendingEntries.push({ depth, entry: directory.children[childIndex] });
    }
}

/** Lists the entries the tree shows, in order: the root's children, and the children of every expanded folder they lead to. */
export function listVisibleLibraryEntries(root: LibraryDirectory, expandedPaths: ReadonlySet<string>): VisibleLibraryEntry[] {
    const visibleEntries: VisibleLibraryEntry[] = [];
    const pendingEntries: VisibleLibraryEntry[] = [];
    pushChildrenInReverse(pendingEntries, root, 0);
    let visibleEntry = pendingEntries.pop();
    while (visibleEntry !== undefined) {
        visibleEntries.push(visibleEntry);
        if (visibleEntry.entry.kind === 'directory' && expandedPaths.has(visibleEntry.entry.path)) {
            pushChildrenInReverse(pendingEntries, visibleEntry.entry, visibleEntry.depth + 1);
        }
        visibleEntry = pendingEntries.pop();
    }
    return visibleEntries;
}
