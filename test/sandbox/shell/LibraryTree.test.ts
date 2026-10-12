import { describe, expect, it } from 'vitest';

import type { LibraryDirectory } from '../../../sandbox/src/contracts/SandboxContracts';
import { LIBRARY_ROOT_PATH } from '../../../sandbox/src/library/LibraryFiles';
import {
    buildLibraryTree,
    findLibraryFile,
    type LibraryTreeMediaFile,
    listVisibleLibraryEntries,
    type VisibleLibraryEntry
} from '../../../sandbox/src/library/LibraryTree';

const ROOT_NAME = 'Library';
const MOVIE_SIZE_BYTES = 4_000_000;
const EPISODE_SIZE_BYTES = 1_000_000;
const SHORT_SIZE_BYTES = 200_000;
const MOVIE_PATH = 'movie.mkv';
const SHORT_PATH = 'Animation/short.webm';
const EARLY_EPISODE_PATH = 'Shows/Season 2/episode 2.mkv';
const LATE_EPISODE_PATH = 'Shows/Season 2/episode 10.mkv';
const LATER_SEASON_EPISODE_PATH = 'Shows/Season 10/episode 1.mkv';
const MOVIE_SUBTITLE_PATH = 'movie.srt';
const MOVIE_LANGUAGE_SUBTITLE_PATH = 'movie.en.srt';
const EPISODE_SUBTITLE_PATH = 'Shows/Season 2/episode 2.en.vtt';
// A subtitle file named for the movie in another folder, which is not beside it
const OTHER_FOLDER_SUBTITLE_PATH = 'Subtitles/movie.srt';
const ORPHAN_SUBTITLE_PATH = 'trailer.srt';
const SHOWS_PATH = 'Shows';
const SEASON_TWO_PATH = 'Shows/Season 2';
const MISSING_PATH = 'missing.mkv';
const BELOW_FILE_PATH = 'movie.mkv/extra.mkv';

// Scanned in walk order, which the tree does not keep
const MEDIA_FILES: readonly LibraryTreeMediaFile[] = [
    { path: LATER_SEASON_EPISODE_PATH, sizeBytes: EPISODE_SIZE_BYTES },
    { path: MOVIE_PATH, sizeBytes: MOVIE_SIZE_BYTES },
    { path: LATE_EPISODE_PATH, sizeBytes: EPISODE_SIZE_BYTES },
    { path: SHORT_PATH, sizeBytes: SHORT_SIZE_BYTES },
    { path: EARLY_EPISODE_PATH, sizeBytes: EPISODE_SIZE_BYTES }
];
const SUBTITLE_PATHS: readonly string[] = [
    MOVIE_SUBTITLE_PATH,
    OTHER_FOLDER_SUBTITLE_PATH,
    EPISODE_SUBTITLE_PATH,
    MOVIE_LANGUAGE_SUBTITLE_PATH,
    ORPHAN_SUBTITLE_PATH
];

const EXPECTED_TREE: LibraryDirectory = {
    children: [
        {
            children: [
                { kind: 'file', name: 'short.webm', path: SHORT_PATH, sizeBytes: SHORT_SIZE_BYTES, subtitlePaths: [] }
            ],
            kind: 'directory',
            name: 'Animation',
            path: 'Animation'
        },
        {
            children: [
                {
                    children: [
                        {
                            kind: 'file',
                            name: 'episode 2.mkv',
                            path: EARLY_EPISODE_PATH,
                            sizeBytes: EPISODE_SIZE_BYTES,
                            subtitlePaths: [ EPISODE_SUBTITLE_PATH ]
                        },
                        { kind: 'file', name: 'episode 10.mkv', path: LATE_EPISODE_PATH, sizeBytes: EPISODE_SIZE_BYTES, subtitlePaths: [] }
                    ],
                    kind: 'directory',
                    name: 'Season 2',
                    path: SEASON_TWO_PATH
                },
                {
                    children: [
                        {
                            kind: 'file',
                            name: 'episode 1.mkv',
                            path: LATER_SEASON_EPISODE_PATH,
                            sizeBytes: EPISODE_SIZE_BYTES,
                            subtitlePaths: []
                        }
                    ],
                    kind: 'directory',
                    name: 'Season 10',
                    path: 'Shows/Season 10'
                }
            ],
            kind: 'directory',
            name: 'Shows',
            path: SHOWS_PATH
        },
        {
            kind: 'file',
            name: 'movie.mkv',
            path: MOVIE_PATH,
            sizeBytes: MOVIE_SIZE_BYTES,
            subtitlePaths: [ MOVIE_LANGUAGE_SUBTITLE_PATH, MOVIE_SUBTITLE_PATH ]
        }
    ],
    kind: 'directory',
    name: ROOT_NAME,
    path: LIBRARY_ROOT_PATH
};

/** Reduces visible entries to depth and path pairs, which read as the expected outline. */
function outline(visibleEntries: readonly VisibleLibraryEntry[]): [ number, string ][] {
    return visibleEntries.map((visibleEntry: VisibleLibraryEntry): [ number, string ] => [ visibleEntry.depth, visibleEntry.entry.path ]);
}

describe('LibraryTree', () => {
    it('nests scanned paths into folders, folders first and in natural order, with the subtitle files beside each file', () => {
        expect(buildLibraryTree(ROOT_NAME, MEDIA_FILES, SUBTITLE_PATHS)).toEqual(EXPECTED_TREE);
    });

    it('leaves out folders that hold only subtitle files, and builds an empty root from an empty scan', () => {
        const tree = buildLibraryTree(ROOT_NAME, [], SUBTITLE_PATHS);
        expect(tree).toEqual({ children: [], kind: 'directory', name: ROOT_NAME, path: LIBRARY_ROOT_PATH });
    });

    it('finds files at any depth, and nothing at a folder, a missing path, or below a file', () => {
        const tree = buildLibraryTree(ROOT_NAME, MEDIA_FILES, SUBTITLE_PATHS);
        expect(findLibraryFile(tree, EARLY_EPISODE_PATH)?.subtitlePaths).toEqual([ EPISODE_SUBTITLE_PATH ]);
        expect(findLibraryFile(tree, MOVIE_PATH)?.sizeBytes).toBe(MOVIE_SIZE_BYTES);
        expect(findLibraryFile(tree, SEASON_TWO_PATH)).toBeNull();
        expect(findLibraryFile(tree, MISSING_PATH)).toBeNull();
        expect(findLibraryFile(tree, BELOW_FILE_PATH)).toBeNull();
        expect(findLibraryFile(tree, LIBRARY_ROOT_PATH)).toBeNull();
    });

    it('shows the root children, and the children of folders expanded all the way down', () => {
        const tree = buildLibraryTree(ROOT_NAME, MEDIA_FILES, SUBTITLE_PATHS);
        expect(outline(listVisibleLibraryEntries(tree, new Set<string>()))).toEqual([
            [ 0, 'Animation' ],
            [ 0, SHOWS_PATH ],
            [ 0, MOVIE_PATH ]
        ]);
        // A folder inside a collapsed one stays hidden, even when expanded itself
        expect(outline(listVisibleLibraryEntries(tree, new Set<string>([ SEASON_TWO_PATH ])))).toEqual([
            [ 0, 'Animation' ],
            [ 0, SHOWS_PATH ],
            [ 0, MOVIE_PATH ]
        ]);
        expect(outline(listVisibleLibraryEntries(tree, new Set<string>([ SHOWS_PATH, SEASON_TWO_PATH ])))).toEqual([
            [ 0, 'Animation' ],
            [ 0, SHOWS_PATH ],
            [ 1, SEASON_TWO_PATH ],
            [ 2, EARLY_EPISODE_PATH ],
            [ 2, LATE_EPISODE_PATH ],
            [ 1, 'Shows/Season 10' ],
            [ 0, MOVIE_PATH ]
        ]);
    });
});
