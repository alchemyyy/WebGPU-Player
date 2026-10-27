#!/usr/bin/env node
// Generates the AV1 parser's C header of the GPU record layout and the error codes from the decoder's WGSL, which declares them once for both sides:
// each `const RECORD_<NAME>: u32 = <value>u;` and `const ERROR_<NAME>: u32 = <value>u;` line becomes a `#define` of the same name.
// It fails unless the header's `//! error:` lines name exactly the error codes the WGSL declares, and its `//! packet:` line is the bound the
// RECORD_PACKET_ constants describe, which the parser evaluates for each frame, so the parser and the WGSL of one package always agree.
// Usage: node record_layout.mjs <decoder WGSL> <output header>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const USAGE = 'Usage: node record_layout.mjs <decoder WGSL> <output header>';
const CONSTANT_PATTERN = /^const ((?:RECORD|ERROR)_[A-Z0-9_]+): u32 = (\d+)u;$/;
// `//! error: <code>, <name>[, <recovery>]`; the recovery is the engine's, which the parser's constants do not carry
const ERROR_DIRECTIVE_PATTERN = /^\/\/! error:\s*(\d+)\s*,\s*([A-Za-z]\w*)\s*(?:,\s*[a-z]+\s*)?$/;
const PACKET_DIRECTIVE_PREFIX = '//! packet:';
// The constants the packet bound reads, in the order its expression names them
const PACKET_CONSTANT_NAMES = [
    'RECORD_PACKET_MINIMUM_BYTES',
    'RECORD_PACKET_MAXIMUM_BYTES',
    'RECORD_PACKET_UNIT_WORDS',
    'RECORD_PACKET_PLANE_UNIT_WORDS',
    'RECORD_PACKET_COEFFICIENT_BIT_BIAS',
    'RECORD_PACKET_MARGIN_SAMPLES',
    'RECORD_PACKET_MARGIN_BYTES'
];
const HEADER_LINE_PREFIX = '//!';
const ERROR_PREFIX = 'ERROR_';
// ERROR_ constants that are no error code
const ERROR_LAYOUT_CONSTANTS = new Set([ 'ERROR_CODE_SHIFT', 'ERROR_VALUE_MASK' ]);
const UPPERCASE_PATTERN = /[A-Z]/g;
// A replacement that puts an underscore before the matched letter
const UNDERSCORE_BEFORE_MATCH = '_$&';
const HEADER_GUARD = 'AV1_RECORD_LAYOUT_H_';
const LINE_PATTERN = /\r?\n/;

/** Converts a header error name such as `recordSize` to its constant name, `ERROR_RECORD_SIZE`. */
function toErrorConstantName(name) {
    const snakeName = name.replace(UPPERCASE_PATTERN, UNDERSCORE_BEFORE_MATCH).toUpperCase();
    return `${ERROR_PREFIX}${snakeName}`;
}

/** Returns the record and error constants of the WGSL, by name, in declaration order. */
function readConstants(lines) {
    const constants = new Map();
    for (const line of lines) {
        const match = CONSTANT_PATTERN.exec(line.trim());
        if (!match) {
            continue;
        }
        if (constants.has(match[1])) {
            throw new Error(`${match[1]} is declared twice`);
        }
        constants.set(match[1], Number(match[2]));
    }
    return constants;
}

/** Returns each `//! error: <code>, <name>[, <recovery>]` line's constant name and code. */
function readErrorDirectives(lines) {
    const directives = new Map();
    for (const line of lines) {
        if (!line.startsWith(HEADER_LINE_PREFIX)) {
            break;
        }
        const match = ERROR_DIRECTIVE_PATTERN.exec(line);
        if (match) {
            directives.set(toErrorConstantName(match[2]), Number(match[1]));
        }
    }
    return directives;
}

/**
 * Returns the packet bound the RECORD_PACKET_ constants describe as the header's expression over the pool's facts: per 4x4 luma unit (a sixteenth
 * of a luma sample's bytes) the unit words, and per plane's unit the plane words and 16 coefficients of bit depth + bias bits (half a word a bit),
 * the plane units being 1 + 2 / (chroma width divisor x chroma height divisor) per luma unit, then the margin, clamped to the minimum and maximum.
 */
function getPacketBound(constants) {
    const [ minimum, maximum, unitWords, planeUnitWords, coefficientBitBias, marginSamples, marginBytes ] = PACKET_CONSTANT_NAMES.map(name => {
        if (!constants.has(name)) {
            throw new Error(`The WGSL declares no ${name}`);
        }
        return constants.get(name);
    });
    const planeUnits = '(1 + 2 / (output.chromaWidthDivisor * output.chromaHeightDivisor))';
    const unitBytes = `(${unitWords} + ${planeUnits} * (${planeUnitWords} + (output.bitDepth + ${coefficientBitBias}) / 2)) / 4`;
    return `max(${minimum}, min(${maximum}, stream.width * stream.height * ${unitBytes} + stream.width * stream.height / ${marginSamples} + ${marginBytes}))`;
}

/** Fails unless the header's `//! packet:` line is the bound the RECORD_PACKET_ constants describe. */
function requireMatchingPacketBound(lines, constants) {
    const expected = getPacketBound(constants);
    for (const line of lines) {
        if (!line.startsWith(HEADER_LINE_PREFIX)) {
            break;
        }
        if (line.startsWith(PACKET_DIRECTIVE_PREFIX)) {
            const declared = line.slice(PACKET_DIRECTIVE_PREFIX.length).trim();
            if (declared !== expected) {
                throw new Error(`The //! packet line differs from the RECORD_PACKET_ constants' bound: ${expected}`);
            }
            return;
        }
    }
    throw new Error('The header has no //! packet line');
}

/** Fails unless the error directives and the error code constants name the same codes. */
function requireMatchingErrors(constants, directives) {
    const errorCodes = [ ...constants ].filter(([ name ]) => name.startsWith(ERROR_PREFIX) && !ERROR_LAYOUT_CONSTANTS.has(name));
    const mismatches = errorCodes.filter(([ name, code ]) => directives.get(name) !== code).map(([ name ]) => name);
    const undeclared = [ ...directives.keys() ].filter(name => !constants.has(name));
    if (mismatches.length > 0 || undeclared.length > 0 || errorCodes.length !== directives.size) {
        throw new Error(`The //! error lines and the ERROR_ constants differ: ${[ ...mismatches, ...undeclared ].join(', ') || 'counts'}`);
    }
}

function main() {
    const [ sourcePath, outputPath ] = process.argv.slice(2);
    if (!sourcePath || !outputPath) {
        throw new Error(USAGE);
    }
    const lines = readFileSync(resolve(sourcePath), 'utf8').split(LINE_PATTERN);
    const constants = readConstants(lines);
    requireMatchingErrors(constants, readErrorDirectives(lines));
    requireMatchingPacketBound(lines, constants);
    const output = [
        '// Generated by wgpud/av1/parser/record_layout.mjs from the RECORD_ and ERROR_ constants of av1.wgsl',
        `#ifndef ${HEADER_GUARD}`,
        `#define ${HEADER_GUARD}`,
        '',
        ...[ ...constants ].map(([ name, value ]) => `#define ${name} ${value}u`),
        '',
        `#endif  // ${HEADER_GUARD}`,
        ''
    ];
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    writeFileSync(resolve(outputPath), output.join('\n'));
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
