// @vitest-environment node

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createHEVCExactCapabilityAccessUnit,
    type HEVCExactCapabilityVector
} from 'webgpu-player/capability/vectors/HEVCExactCapabilityVectors';

const EXPECTED_SHA256: Readonly<Record<HEVCExactCapabilityVector, string>> = Object.freeze({
    'main-1080p': 'bf986f9ccad3a8d5a7883ab04056fef9f7190fa4fe82ec8a6e70e14e68355f04',
    'main10-4k': '6973492c6975cd8857a241d88a69b5603c413bfe63749c1aec756156637dfe74'
});

describe('HEVC exact capability vectors', () => {
    it.each(Object.keys(EXPECTED_SHA256) as HEVCExactCapabilityVector[])('creates the exact %s access unit', vector => {
        const accessUnit = new Uint8Array(createHEVCExactCapabilityAccessUnit(vector));

        expect(createHash('sha256').update(accessUnit).digest('hex')).toBe(EXPECTED_SHA256[vector]);
    });
});
