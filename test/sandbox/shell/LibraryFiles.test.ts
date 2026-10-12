import { describe, expect, it } from 'vitest';

import { CUSTOM_CONTAINER_CODEC_RULES } from 'webgpu-player/capability/CustomContainerCodecSupport';

import {
    classifyLibraryFileName,
    formatLibraryPathDetail,
    getBaseName,
    getFileExtension,
    getLibraryEntryName,
    getParentLibraryPath,
    isHiddenEntryName,
    isSubtitleFileFor,
    joinLibraryPath,
    LIBRARY_ROOT_PATH,
    SUBTITLE_FILE_EXTENSIONS
} from '../../../sandbox/src/library/LibraryFiles';

const MEDIA_BASE_NAME = 'movie';
const MEDIA_NAME = 'movie.mkv';
const UPPERCASE_MEDIA_NAME = 'Movie.MKV';
const NAME_WITHOUT_EXTENSION = 'README';
// A hidden file whose whole name looks like an extension
const DOTFILE_NAME = '.mkv';
// The resource fork file macOS writes beside media on other file systems
const APPLE_DOUBLE_NAME = '._movie.mkv';
const HIDDEN_FOLDER_NAME = '.git';
// Files no container rule carries
const NON_MEDIA_NAMES: readonly string[] = [ 'movie.nfo', 'poster.jpg', 'notes.txt' ];
const SAME_BASE_SUBTITLE_NAME = 'movie.srt';
const FLAGGED_SUBTITLE_NAME = 'movie.en.forced.srt';
const UPPERCASE_FLAGGED_SUBTITLE_NAME = 'movie.EN.ass';
// Names that start with the media's base name without the '.' boundary
const SEQUEL_SUBTITLE_NAME = 'movie 2.srt';
const PLURAL_SUBTITLE_NAME = 'movies.srt';
const PART_MEDIA_NAME = 'movie.part1.mkv';
const PART_SUBTITLE_NAME = 'movie.part1.en.srt';
const NESTED_DIRECTORY_PATH = 'Shows/Season 1';
const NESTED_FILE_NAME = 'episode.mkv';
const NESTED_FILE_PATH = 'Shows/Season 1/episode.mkv';
const ROOT_PATH_DETAIL = '.';

describe('LibraryFiles', () => {
    it('reads extensions in lowercase, and none from a name without one or a dotfile', () => {
        expect(getFileExtension(UPPERCASE_MEDIA_NAME)).toBe('mkv');
        expect(getFileExtension(FLAGGED_SUBTITLE_NAME)).toBe('srt');
        expect(getFileExtension(NAME_WITHOUT_EXTENSION)).toBe('');
        expect(getFileExtension(DOTFILE_NAME)).toBe('');
        expect(getBaseName(FLAGGED_SUBTITLE_NAME)).toBe('movie.en.forced');
        expect(getBaseName(NAME_WITHOUT_EXTENSION)).toBe(NAME_WITHOUT_EXTENSION);
    });

    it('keeps every container the engine rules carry as media, in any case', () => {
        for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
            for (const container of [ ...rule.profileContainers, ...rule.containerAliases ]) {
                expect(classifyLibraryFileName(`${MEDIA_BASE_NAME}.${container}`)).toBe('media');
                expect(classifyLibraryFileName(`${MEDIA_BASE_NAME}.${container.toUpperCase()}`)).toBe('media');
            }
        }
    });

    it('keeps subtitle files and skips everything else', () => {
        for (const extension of SUBTITLE_FILE_EXTENSIONS) {
            expect(classifyLibraryFileName(`${MEDIA_BASE_NAME}.${extension}`)).toBe('subtitle');
        }
        for (const name of NON_MEDIA_NAMES) {
            expect(classifyLibraryFileName(name)).toBeNull();
        }
        expect(classifyLibraryFileName(NAME_WITHOUT_EXTENSION)).toBeNull();
        expect(classifyLibraryFileName(DOTFILE_NAME)).toBeNull();
    });

    it('treats dot-prefixed entries as hidden, including AppleDouble files', () => {
        expect(isHiddenEntryName(APPLE_DOUBLE_NAME)).toBe(true);
        expect(isHiddenEntryName(HIDDEN_FOLDER_NAME)).toBe(true);
        expect(isHiddenEntryName(MEDIA_NAME)).toBe(false);
    });

    it('attaches subtitle files whose base name is the media base name or extends it after a dot, ignoring case', () => {
        expect(isSubtitleFileFor(MEDIA_NAME, SAME_BASE_SUBTITLE_NAME)).toBe(true);
        expect(isSubtitleFileFor(MEDIA_NAME, FLAGGED_SUBTITLE_NAME)).toBe(true);
        expect(isSubtitleFileFor(UPPERCASE_MEDIA_NAME, UPPERCASE_FLAGGED_SUBTITLE_NAME)).toBe(true);
        expect(isSubtitleFileFor(PART_MEDIA_NAME, PART_SUBTITLE_NAME)).toBe(true);
    });

    it('leaves out subtitle files that only share a prefix with the media base name', () => {
        expect(isSubtitleFileFor(MEDIA_NAME, SEQUEL_SUBTITLE_NAME)).toBe(false);
        expect(isSubtitleFileFor(MEDIA_NAME, PLURAL_SUBTITLE_NAME)).toBe(false);
        expect(isSubtitleFileFor(PART_MEDIA_NAME, SAME_BASE_SUBTITLE_NAME)).toBe(false);
    });

    it('joins and splits library paths', () => {
        expect(joinLibraryPath(LIBRARY_ROOT_PATH, MEDIA_NAME)).toBe(MEDIA_NAME);
        expect(joinLibraryPath(NESTED_DIRECTORY_PATH, NESTED_FILE_NAME)).toBe(NESTED_FILE_PATH);
        expect(getParentLibraryPath(NESTED_FILE_PATH)).toBe(NESTED_DIRECTORY_PATH);
        expect(getParentLibraryPath(MEDIA_NAME)).toBe(LIBRARY_ROOT_PATH);
        expect(getLibraryEntryName(NESTED_FILE_PATH)).toBe(NESTED_FILE_NAME);
        expect(getLibraryEntryName(MEDIA_NAME)).toBe(MEDIA_NAME);
    });

    it('names the picked folder itself in failure details', () => {
        expect(formatLibraryPathDetail(LIBRARY_ROOT_PATH)).toBe(ROOT_PATH_DETAIL);
        expect(formatLibraryPathDetail(NESTED_FILE_PATH)).toBe(NESTED_FILE_PATH);
    });
});
