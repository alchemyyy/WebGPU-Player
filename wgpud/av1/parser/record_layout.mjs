#!/usr/bin/env node
// Generates the AV1 parser's C header of the GPU record layout and the error codes from the decoder's WGSL, which declares them once for both sides:
// each `const RECORD_<NAME>: u32 = <value>u;` and `const ERROR_<NAME>: u32 = <value>u;` line becomes a `#define` of the same name, and the
// header's `//! packet:` bound becomes RECORD_PACKET_BYTES, the largest record the parser may emit.
// It fails unless the header's `//! error:` lines name exactly the error codes the WGSL declares, so the parser and the WGSL of one package always agree.
// Usage: node record_layout.mjs <decoder WGSL> <output header>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const USAGE = 'Usage: node record_layout.mjs <decoder WGSL> <output header>';
const CONSTANT_PATTERN = /^const ((?:RECORD|ERROR)_[A-Z0-9_]+): u32 = (\d+)u;$/;
// `//! error: <code>, <name>[, <recovery>]`; the recovery is the engine's, which the parser's constants do not carry
const ERROR_DIRECTIVE_PATTERN = /^\/\/! error:\s*(\d+)\s*,\s*([A-Za-z]\w*)\s*(?:,\s*[a-z]+\s*)?$/;
const PACKET_DIRECTIVE_PREFIX = '//! packet:';
const DECIMAL_PATTERN = /^\d+$/;
const WHITESPACE_PATTERN = /\s+/;
const PACKET_CONSTANT_NAME = 'RECORD_PACKET_BYTES';
const UNIT_BYTE_LENGTHS = new Map([ [ 'KiB', 1024 ], [ 'MiB', 1024 * 1024 ] ]);
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

/** Returns the byte length the header's `//! packet: <count> [KiB|MiB]` line bounds every packet to. */
function readPacketByteLength(lines) {
    for (const line of lines) {
        if (!line.startsWith(HEADER_LINE_PREFIX)) {
            break;
        }
        if (!line.startsWith(PACKET_DIRECTIVE_PREFIX)) {
            continue;
        }
        const [ count, unit, ...rest ] = line.slice(PACKET_DIRECTIVE_PREFIX.length).trim().split(WHITESPACE_PATTERN);
        const unitByteLength = unit === undefined ? 1 : UNIT_BYTE_LENGTHS.get(unit);
        if (!DECIMAL_PATTERN.test(count) || unitByteLength === undefined || rest.length > 0) {
            throw new Error(`The //! packet line is not a size: ${line}`);
        }
        return Number(count) * unitByteLength;
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
    if (constants.has(PACKET_CONSTANT_NAME)) {
        throw new Error(`${PACKET_CONSTANT_NAME} comes from the //! packet line`);
    }
    constants.set(PACKET_CONSTANT_NAME, readPacketByteLength(lines));
    const output = [
        '// Generated by wgpud/av1/parser/record_layout.mjs from the RECORD_ and ERROR_ constants and the packet bound of av1.wgsl',
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
