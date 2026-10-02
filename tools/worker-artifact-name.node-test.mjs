import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCustomDecodeWorkerAssetName } from './worker-artifact-name.mjs';

test('selects one content-addressed custom decode worker', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'main.jellyfin.bundle.js',
        'CustomDecode.worker.0123456789abcdef.bundle.js'
    ]), 'CustomDecode.worker.0123456789abcdef.bundle.js');
});

test('ignores unhashed worker names next to the content-addressed worker', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.bundle.js',
        'CustomDecode.worker.fedcba9876543210.bundle.js'
    ]), 'CustomDecode.worker.fedcba9876543210.bundle.js');
});

test('fails closed for ambiguous content-addressed workers', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.0123456789abcdef.bundle.js',
        'CustomDecode.worker.fedcba9876543210.bundle.js'
    ]), null);
});

test('rejects unhashed and unrelated artifacts', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.bundle.js'
    ]), null);
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.short.bundle.js',
        'HEVCExactCapabilityProbe.worker.0123456789abcdef.bundle.js'
    ]), null);
});

test('rejects malformed artifact lists', () => {
    assert.throws(
        () => selectCustomDecodeWorkerAssetName([ 'worker.js', 1 ]),
        /string array/u
    );
});
