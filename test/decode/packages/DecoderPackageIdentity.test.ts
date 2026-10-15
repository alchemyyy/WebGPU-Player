// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
    DECODER_PACKAGE_ID_MAXIMUM_LENGTH,
    findDecoderPackageIdFailure,
    isDecoderPackageVersion,
    isSameDecoderPackageVersion
} from 'webgpu-player/decode/packages/DecoderPackageIdentity';

const LONGEST_ID = 'a'.repeat(DECODER_PACKAGE_ID_MAXIMUM_LENGTH);
const OVERLONG_ID = `${LONGEST_ID}a`;
const CONTENT_HASH = '9e'.repeat(32);
const OTHER_CONTENT_HASH = '9f'.repeat(32);
const PACKAGE_ID = 'hevc';

describe('findDecoderPackageIdFailure', () => {
    it.each([
        [ 'a codec name', 'av1' ],
        [ 'a project name with digits', 'jpeg2000' ],
        [ 'hyphenated words', 'hevc-main-10' ],
        [ 'a leading digit', '3d-video' ],
        [ 'one character', 'a' ],
        [ 'the longest id', LONGEST_ID ]
    ])('takes %s', (_description, id) => {
        expect(findDecoderPackageIdFailure(id)).toBeNull();
    });

    it.each([
        [ 'an empty id', '' ],
        [ 'an uppercase letter', 'HEVC' ],
        [ 'a leading hyphen', '-hevc' ],
        [ 'a trailing hyphen', 'hevc-' ],
        [ 'two hyphens in a row', 'hevc--main' ],
        [ 'an underscore', 'hevc_main' ],
        [ 'a dot', 'hevc.main' ],
        [ 'a space', 'hevc main' ],
        [ 'a non-ASCII letter', 'hévc' ]
    ])('refuses %s as id-syntax with the quoted value', (_description, id) => {
        expect(findDecoderPackageIdFailure(id)).toEqual({ code: 'id-syntax', detail: `'${id}'` });
    });

    it('refuses an id past the longest as id-length with its length', () => {
        expect(findDecoderPackageIdFailure(OVERLONG_ID)).toEqual({
            code: 'id-length',
            detail: `${OVERLONG_ID.length} > ${DECODER_PACKAGE_ID_MAXIMUM_LENGTH}`
        });
    });
});

describe('package versions', () => {
    it('takes an object with an id and a content hash as a version', () => {
        expect(isDecoderPackageVersion({ contentHash: CONTENT_HASH, id: PACKAGE_ID })).toBe(true);
        expect(isDecoderPackageVersion({ contentHash: CONTENT_HASH, id: PACKAGE_ID, name: 'HEVC' })).toBe(true);
    });

    it.each([
        [ 'no object', PACKAGE_ID ],
        [ 'null', null ],
        [ 'an id alone', { id: PACKAGE_ID } ],
        [ 'a content hash alone', { contentHash: CONTENT_HASH } ],
        [ 'a numeric id', { contentHash: CONTENT_HASH, id: 1 } ]
    ])('refuses %s as a version', (_description, value) => {
        expect(isDecoderPackageVersion(value)).toBe(false);
    });

    it('tells one version of a package from another version and from another package', () => {
        const version = { contentHash: CONTENT_HASH, id: PACKAGE_ID };

        expect(isSameDecoderPackageVersion(version, { ...version })).toBe(true);
        expect(isSameDecoderPackageVersion(version, { contentHash: OTHER_CONTENT_HASH, id: PACKAGE_ID })).toBe(false);
        expect(isSameDecoderPackageVersion(version, { contentHash: CONTENT_HASH, id: 'mpeg2' })).toBe(false);
    });
});
