#!/usr/bin/env node
// Writes wgpud/atmos/atmos_hrir.c, the head-related impulse responses the object audio renderer's binaural stage convolves with:
// one left and right ear pair per virtual 7.1.4 speaker, from the diffuse-field equalized MIT KEMAR set, resampled to 48 kHz.
// The set: Bill Gardner and Keith Martin, "HRTF Measurements of a KEMAR Dummy-Head Microphone", MIT Media Lab, 1994,
// https://sound.media.mit.edu/resources/KEMAR.html. "This data is Copyright 1994 by the MIT Media Laboratory. It is provided free
// with no restrictions on use, provided the authors are cited when the data is used in any research or commercial application."
// Usage: node scripts/generate-atmos-hrir.mjs [<path to diffuse.zip>]
//   Without a path it downloads the archive; either way the archive must match its recorded SHA-256.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { ENGINE_ROOT, LAYOUT } from '../tools/constants.mjs';

const SOURCE_URL = 'https://sound.media.mit.edu/resources/KEMAR/diffuse.zip';
const SOURCE_SHA256 = 'a48e73137390626ef1e45d1de6a4d98530c6aa570e71b40f7c4442241ed5fa22';
const OUTPUT_FILE = join(ENGINE_ROOT, LAYOUT.decodersDirectory, 'atmos', 'atmos_hrir.c');

const SOURCE_RATE = 44_100;
const TARGET_RATE = 48_000;
// The taps the table keeps, as atmos_internal.h declares ATMOS_HRIR_LENGTH; the 128-tap responses span about 140 at 48 kHz
const TARGET_LENGTH = 160;
// The last taps fade out with a raised cosine
const FADE_LENGTH = 16;
// The resampler: a Kaiser-windowed sinc with its cutoff below the source's Nyquist frequency
const CUTOFF_HZ = 21_000;
const KERNEL_HALF_WIDTH = 32;
const KAISER_BETA = 8.6;
// The mean energy per ear over the virtual speakers, so a source keeps about the level a stereo pan gives each channel
const MEAN_EAR_ENERGY = 0.5;
const SIGNIFICANT_DIGITS = 9;

// The virtual 7.1.4 speakers in WAVE plane order without the LFE, with the measurement each takes: KEMAR's azimuths run clockwise
// from the front, and the set holds only the right half, so a left speaker swaps the ears of its mirror image.
// Directions follow ITU-R BS.2051 System J (4+7+0): M+-30, M0, M+-135, M+-90, and U+-45, U+-135, the upper ones at KEMAR's 40 degree elevation
const VIRTUAL_SPEAKERS = Object.freeze([
    { name: 'FL', file: 'elev0/H0e030a.wav', swap: true },
    { name: 'FR', file: 'elev0/H0e030a.wav', swap: false },
    { name: 'FC', file: 'elev0/H0e000a.wav', swap: false },
    { name: 'BL', file: 'elev0/H0e135a.wav', swap: true },
    { name: 'BR', file: 'elev0/H0e135a.wav', swap: false },
    { name: 'SL', file: 'elev0/H0e090a.wav', swap: true },
    { name: 'SR', file: 'elev0/H0e090a.wav', swap: false },
    { name: 'TFL', file: 'elev40/H40e045a.wav', swap: true },
    { name: 'TFR', file: 'elev40/H40e045a.wav', swap: false },
    { name: 'TBL', file: 'elev40/H40e135a.wav', swap: true },
    { name: 'TBR', file: 'elev40/H40e135a.wav', swap: false }
]);

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

/** Returns the archive's files by name, read from its central directory. */
function readZipEntries(archive) {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let end = archive.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== ZIP_END_SIGNATURE) {
        end--;
    }
    if (end < 0) {
        throw new Error('The archive has no end of central directory');
    }
    const entryCount = view.getUint16(end + 10, true);
    let position = view.getUint32(end + 16, true);
    const entries = new Map();
    for (let index = 0; index < entryCount; index++) {
        if (view.getUint32(position, true) !== ZIP_CENTRAL_SIGNATURE) {
            throw new Error('The archive\'s central directory is malformed');
        }
        const method = view.getUint16(position + 10, true);
        const compressedSize = view.getUint32(position + 20, true);
        const nameLength = view.getUint16(position + 28, true);
        const extraLength = view.getUint16(position + 30, true);
        const commentLength = view.getUint16(position + 32, true);
        const localOffset = view.getUint32(position + 42, true);
        const name = new TextDecoder().decode(archive.subarray(position + 46, position + 46 + nameLength));
        entries.set(name, { method, compressedSize, localOffset });
        position += 46 + nameLength + extraLength + commentLength;
    }
    return { view, entries };
}

/** Returns one file of the archive. */
function readZipFile(archive, zip, name) {
    const entry = zip.entries.get(name);
    if (entry === undefined) {
        throw new Error(`The archive has no ${name}`);
    }
    if (zip.view.getUint32(entry.localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error(`The archive's local header of ${name} is malformed`);
    }
    const dataStart = entry.localOffset + 30 + zip.view.getUint16(entry.localOffset + 26, true) + zip.view.getUint16(entry.localOffset + 28, true);
    const data = archive.subarray(dataStart, dataStart + entry.compressedSize);
    if (entry.method === ZIP_STORED) {
        return data;
    }
    if (entry.method === ZIP_DEFLATED) {
        return inflateRawSync(data);
    }
    throw new Error(`${name} uses compression method ${entry.method}`);
}

/** Returns a 16-bit stereo WAVE file's left and right channels as floats. */
function readStereoWave(bytes, name) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let position = 12;
    let format = null;
    while (position + 8 <= bytes.byteLength) {
        const id = new TextDecoder().decode(bytes.subarray(position, position + 4));
        const size = view.getUint32(position + 4, true);
        if (id === 'fmt ') {
            format = { channels: view.getUint16(position + 10, true), rate: view.getUint32(position + 12, true), bits: view.getUint16(position + 22, true) };
        } else if (id === 'data') {
            if (format?.channels !== 2 || format.rate !== SOURCE_RATE || format.bits !== 16) {
                throw new Error(`${name} is not 16-bit stereo at ${SOURCE_RATE} Hz`);
            }
            const frameCount = size / 4;
            const left = new Float64Array(frameCount);
            const right = new Float64Array(frameCount);
            for (let frame = 0; frame < frameCount; frame++) {
                left[frame] = view.getInt16(position + 8 + frame * 4, true) / 32_768;
                right[frame] = view.getInt16(position + 8 + frame * 4 + 2, true) / 32_768;
            }
            return { left, right };
        }
        position += 8 + size + (size & 1);
    }
    throw new Error(`${name} has no data chunk`);
}

/** The zeroth-order modified Bessel function of the first kind, by its series. */
function besselI0(value) {
    let sum = 1;
    let term = 1;
    for (let index = 1; index < 64; index++) {
        term *= (value / (2 * index)) ** 2;
        sum += term;
    }
    return sum;
}

/** Resamples an impulse response from the source rate to the target rate with a Kaiser-windowed sinc, keeping the target length. */
function resample(input) {
    const output = new Float64Array(TARGET_LENGTH);
    const cutoff = CUTOFF_HZ / SOURCE_RATE;
    const windowNormalization = besselI0(KAISER_BETA);
    for (let index = 0; index < TARGET_LENGTH; index++) {
        const time = index * SOURCE_RATE / TARGET_RATE;
        let sum = 0;
        const first = Math.max(0, Math.ceil(time - KERNEL_HALF_WIDTH));
        const last = Math.min(input.length - 1, Math.floor(time + KERNEL_HALF_WIDTH));
        for (let tap = first; tap <= last; tap++) {
            const offset = time - tap;
            const argument = 2 * cutoff * offset;
            const sinc = argument === 0 ? 1 : Math.sin(Math.PI * argument) / (Math.PI * argument);
            const ratio = offset / KERNEL_HALF_WIDTH;
            const window = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - ratio * ratio))) / windowNormalization;
            sum += input[tap] * 2 * cutoff * sinc * window;
        }
        output[index] = sum;
    }
    for (let index = 0; index < FADE_LENGTH; index++) {
        output[TARGET_LENGTH - FADE_LENGTH + index] *= 0.5 * (1 + Math.cos(Math.PI * (index + 1) / FADE_LENGTH));
    }
    return output;
}

async function readSourceArchive(path) {
    if (path !== undefined) {
        return new Uint8Array(readFileSync(path));
    }
    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
        throw new Error(`Downloading ${SOURCE_URL} failed with status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

function formatFloat(value) {
    const text = Number(value.toPrecision(SIGNIFICANT_DIGITS)).toString();
    const literal = text.includes('.') || text.includes('e') ? text : `${text}.0`;
    return `${literal}f`;
}

const archive = await readSourceArchive(process.argv[2]);
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== SOURCE_SHA256) {
    throw new Error(`The archive's SHA-256 is ${digest}, not ${SOURCE_SHA256}`);
}
const zip = readZipEntries(archive);
const responses = VIRTUAL_SPEAKERS.map(speaker => {
    const wave = readStereoWave(readZipFile(archive, zip, speaker.file), speaker.file);
    const [ left, right ] = speaker.swap ? [ wave.right, wave.left ] : [ wave.left, wave.right ];
    return { speaker, ears: [ resample(left), resample(right) ] };
});
const energies = responses.flatMap(response => response.ears.map(ear => ear.reduce((sum, tap) => sum + tap * tap, 0)));
const scale = Math.sqrt(MEAN_EAR_ENERGY / (energies.reduce((sum, energy) => sum + energy, 0) / energies.length));

const lines = [
    '/*',
    ' * Head-related impulse responses of the binaural stage, which scripts/generate-atmos-hrir.mjs writes; do not edit.',
    ' * Source: the diffuse-field equalized HRTFs of Bill Gardner and Keith Martin, "HRTF Measurements of a KEMAR Dummy-Head Microphone",',
    ' * MIT Media Lab, 1994, https://sound.media.mit.edu/resources/KEMAR.html, archive diffuse.zip,',
    ` * SHA-256 ${SOURCE_SHA256}.`,
    ' * "This data is Copyright 1994 by the MIT Media Laboratory. It is provided free with no restrictions on use, provided the authors',
    ' * are cited when the data is used in any research or commercial application."',
    ` * Each 128-tap 44.1 kHz response is resampled to 48 kHz with a Kaiser-windowed sinc (cutoff ${CUTOFF_HZ} Hz, beta ${KAISER_BETA},`,
    ` * ${KERNEL_HALF_WIDTH} source taps each side), kept to ${TARGET_LENGTH} taps with a ${FADE_LENGTH}-tap raised cosine fade, and scaled by ${scale.toPrecision(6)}`,
    ` * so the mean energy per ear is ${MEAN_EAR_ENERGY}. Left speakers use the mirrored measurement with the ears swapped.`,
    ' */',
    '',
    '#include "atmos_internal.h"',
    '',
    'const float atmos_hrir[ATMOS_HRIR_SPEAKER_COUNT][2][ATMOS_HRIR_LENGTH] = {'
];
for (const [ index, response ] of responses.entries()) {
    lines.push(`    /* ${response.speaker.name}: ${response.speaker.file}${response.speaker.swap ? ', ears swapped' : ''} */`, '    {');
    for (const [ ear, taps ] of response.ears.entries()) {
        lines.push('        {');
        const values = Array.from(taps, tap => formatFloat(tap * scale));
        for (let start = 0; start < values.length; start += 8) {
            lines.push(`            ${values.slice(start, start + 8).join(', ')}${start + 8 < values.length ? ',' : ''}`);
        }
        lines.push(`        }${ear === 0 ? ',' : ''}`);
    }
    lines.push(`    }${index + 1 < responses.length ? ',' : ''}`);
}
lines.push('};', '');
writeFileSync(OUTPUT_FILE, lines.join('\n'));
console.log(`Wrote ${OUTPUT_FILE}`);
