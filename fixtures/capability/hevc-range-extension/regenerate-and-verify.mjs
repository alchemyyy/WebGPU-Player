import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PINNED_FFMPEG_VERSION =
    '2026-03-01-git-862338fe31-full_build-www.gyan.dev';
const PINNED_LIBAVCODEC_VERSION_PATTERN = /libavcodec\s+62\.\s*24\.100/u;
const PINNED_X265_VERSION = '4.1+225-1b48507eb';
const CODED_WIDTH = 192;
const CODED_HEIGHT = 192;
const FRAME_RATE = 1;
const FNV1A_OFFSET_BASIS = 2_166_136_261;
const FNV1A_PRIME = 16_777_619;
const FINGERPRINT_COLUMN_SAMPLE_COUNT = 64;
const FINGERPRINT_ROW_SAMPLE_COUNT = 36;
const GENERAL_X265_PARAMETERS = [
    'info=0',
    'pools=none',
    'frame-threads=1',
    'wpp=0',
    'log-level=error',
    'level-idc=3.1'
];
const INTER_X265_PARAMETERS = [
    'keyint=30',
    'min-keyint=30',
    'scenecut=0',
    'bframes=0',
    'repeat-headers=1'
];

const FIXTURES = Object.freeze([
    {
        accessUnitByteLengths: [ 3_452, 2_905 ],
        constraintPrefix: '9F.88',
        expectedFingerprints: [ 3_329_959_031, 201_088_281 ],
        expectedSHA256: '7cecbf5129d187d90a1434e3b80cea9c90bfb15a6156b6de5114353bf278ecc4',
        frameCount: 2,
        intraConstrained: false,
        patchProfileTierLevel: true,
        pixelFormat: 'yuv420p',
        profile: 'main',
        variant: 'rext420-8'
    },
    {
        accessUnitByteLengths: [ 4_148, 3_582 ],
        constraintPrefix: '9D.08',
        expectedFingerprints: [ 1_183_394_674, 2_295_522_323 ],
        expectedSHA256: '32a61c466d8b6daeff30637b9772d3cf93b1e9c24d01bfdee657f4a1158dc5a9',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv422p',
        profile: 'main422-10',
        variant: 'main422-8'
    },
    {
        accessUnitByteLengths: [ 3_515, 2_872 ],
        constraintPrefix: '9E.08',
        expectedFingerprints: [ 1_821_287_005, 2_492_293_762 ],
        expectedSHA256: 'aec47464fedf08340786534406f45480cfd5ea833547cf6be6fb6360c3f82cb5',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv444p',
        profile: 'main444-8',
        variant: 'main444-8'
    },
    {
        accessUnitByteLengths: [ 3_451, 3_011 ],
        constraintPrefix: '9D.88',
        expectedFingerprints: [ 913_148_567, 991_175_167 ],
        expectedSHA256: '59fbe3b5832ca72f6df3f64220ac71637760afb5f5ac8d2c227def4c93e823e2',
        frameCount: 2,
        intraConstrained: false,
        patchProfileTierLevel: true,
        pixelFormat: 'yuv420p10le',
        profile: 'main10',
        variant: 'rext420-10'
    },
    {
        accessUnitByteLengths: [ 4_181, 3_655 ],
        constraintPrefix: '9D.08',
        expectedFingerprints: [ 164_386_383, 4_284_346_653 ],
        expectedSHA256: '248eb64dbb2bb30ecd689e453a38dcf34125af51c205f7c5da8577a0228639e5',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv422p10le',
        profile: 'main422-10',
        variant: 'main422-10'
    },
    {
        accessUnitByteLengths: [ 3_519, 2_871 ],
        constraintPrefix: '9C.08',
        expectedFingerprints: [ 3_798_930_489, 1_052_002_504 ],
        expectedSHA256: '0b7da32d89ed1e00101e515ca190b4927385421a694daab05cad073a29708c57',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv444p10le',
        profile: 'main444-10',
        variant: 'main444-10'
    },
    {
        accessUnitByteLengths: [ 3_442, 3_013 ],
        constraintPrefix: '99.88',
        expectedFingerprints: [ 1_429_287_902, 2_430_170_723 ],
        expectedSHA256: '6e8c6e28a8380740cb21aef29a8864a81d56b7a686424a1944f0abe3c7b61279',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv420p12le',
        profile: 'main12',
        variant: 'main12-420'
    },
    {
        accessUnitByteLengths: [ 4_140, 3_642 ],
        constraintPrefix: '99.08',
        expectedFingerprints: [ 2_481_109_241, 654_435_566 ],
        expectedSHA256: '8f2c49f6425f8c02baff21e4bed394b0d2e6a4cfb8e9944f09531e64d6b376ee',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv422p12le',
        profile: 'main422-12',
        variant: 'main422-12'
    },
    {
        accessUnitByteLengths: [ 3_514, 2_887 ],
        constraintPrefix: '98.08',
        expectedFingerprints: [ 3_231_491_211, 339_020_665 ],
        expectedSHA256: '58d60de348dcf1be311912182920df269538d00e8a095d1733a9f683f561c442',
        frameCount: 2,
        intraConstrained: false,
        pixelFormat: 'yuv444p12le',
        profile: 'main444-12',
        variant: 'main444-12'
    }
]);

function runTextCommand(command, argumentsList) {
    const result = spawnSync(command, argumentsList, {
        encoding: 'utf8',
        maxBuffer: 16 * 1_024 * 1_024,
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
    }
    return { stderr: result.stderr, stdout: result.stdout };
}

function runBinaryCommand(command, argumentsList) {
    const result = spawnSync(command, argumentsList, {
        maxBuffer: 256 * 1_024 * 1_024,
        windowsHide: true
    });
    if (result.status !== 0) {
        throw new Error(`${command} failed:\n${String(result.stderr)}`);
    }
    return result.stdout;
}

function requireEqual(actual, expected, label) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
        );
    }
}

function hashBytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function getX265Parameters(fixture) {
    return [
        ...GENERAL_X265_PARAMETERS,
        ...(fixture.frameCount === 1 ? [ 'keyint=1' ] : INTER_X265_PARAMETERS)
    ].join(':');
}

async function generateFixture(fixture, outputPath) {
    runTextCommand('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${CODED_WIDTH}x${CODED_HEIGHT}:rate=${FRAME_RATE}:duration=${fixture.frameCount}`,
        '-frames:v',
        String(fixture.frameCount),
        '-pix_fmt',
        fixture.pixelFormat,
        '-c:v',
        'libx265',
        '-profile:v',
        fixture.profile,
        '-preset',
        'fast',
        '-crf',
        '32',
        '-x265-params',
        getX265Parameters(fixture),
        '-f',
        'hevc',
        '-y',
        outputPath
    ]);
    if (fixture.patchProfileTierLevel === true) {
        const encodedBytes = await readFile(outputPath);
        await writeFile(
            outputPath,
            patchProfileTierLevelToRangeExtension(
                encodedBytes,
                fixture.constraintPrefix
            )
        );
    }
}

function getPacketByteLengths(inputPath) {
    const result = runTextCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=size',
        '-of',
        'csv=p=0',
        inputPath
    ]);
    return result.stdout.trim().split(/\r?\n/u).map(Number);
}

function getPictureTypes(inputPath) {
    const result = runTextCommand('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=pict_type',
        '-of',
        'csv=p=0',
        inputPath
    ]);
    return result.stdout.trim().split(/\r?\n/u);
}

function removeEmulationPreventionBytes(bytes) {
    const output = [];
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        if (
            byteIndex >= 2
            && bytes[byteIndex] === 3
            && bytes[byteIndex - 1] === 0
            && bytes[byteIndex - 2] === 0
        ) {
            continue;
        }
        output.push(bytes[byteIndex]);
    }
    return Buffer.from(output);
}

function addEmulationPreventionBytes(bytes) {
    const output = [ bytes[0], bytes[1] ];
    let consecutiveZeroCount = 0;
    for (let byteIndex = 2; byteIndex < bytes.length; byteIndex += 1) {
        const value = bytes[byteIndex];
        if (consecutiveZeroCount >= 2 && value <= 3) {
            output.push(3);
            consecutiveZeroCount = 0;
        }
        output.push(value);
        consecutiveZeroCount = value === 0 ? consecutiveZeroCount + 1 : 0;
    }
    return Buffer.from(output);
}

function findAnnexBStartCodes(bytes) {
    const startCodes = [];
    for (let byteIndex = 0; byteIndex + 3 < bytes.length; byteIndex += 1) {
        if (bytes[byteIndex] !== 0 || bytes[byteIndex + 1] !== 0) {
            continue;
        }
        if (bytes[byteIndex + 2] === 1) {
            startCodes.push({ byteOffset: byteIndex, byteLength: 3 });
            byteIndex += 2;
            continue;
        }
        if (bytes[byteIndex + 2] === 0 && bytes[byteIndex + 3] === 1) {
            startCodes.push({ byteOffset: byteIndex, byteLength: 4 });
            byteIndex += 3;
        }
    }
    return startCodes;
}

function patchProfileTierLevelToRangeExtension(bytes, constraintPrefix) {
    const constraintBytes = constraintPrefix.split('.').map(value => (
        Number.parseInt(value, 16)
    ));
    const startCodes = findAnnexBStartCodes(bytes);
    if (startCodes.length === 0 || startCodes[0].byteOffset !== 0) {
        throw new Error('Generated fixture is not Annex B HEVC');
    }
    const outputParts = [];
    let patchedVPSCount = 0;
    let patchedSPSCount = 0;
    for (let unitIndex = 0; unitIndex < startCodes.length; unitIndex += 1) {
        const startCode = startCodes[unitIndex];
        const nalUnitOffset = startCode.byteOffset + startCode.byteLength;
        const nalUnitEndOffset = unitIndex + 1 < startCodes.length ?
            startCodes[unitIndex + 1].byteOffset :
            bytes.length;
        const nalUnit = bytes.subarray(nalUnitOffset, nalUnitEndOffset);
        const nalUnitType = (nalUnit[0] >> 1) & 0x3F;
        outputParts.push(bytes.subarray(startCode.byteOffset, nalUnitOffset));
        if (nalUnitType !== 32 && nalUnitType !== 33) {
            outputParts.push(nalUnit);
            continue;
        }

        const RBSP = removeEmulationPreventionBytes(nalUnit);
        const profileTierLevelOffset = nalUnitType === 32 ? 6 : 3;
        if (RBSP.length < profileTierLevelOffset + 11) {
            throw new Error('Generated VPS/SPS is too short to patch profile-tier-level');
        }
        RBSP[profileTierLevelOffset] = 4;
        RBSP.set([ 0x08, 0, 0, 0 ], profileTierLevelOffset + 1);
        RBSP.set([
            constraintBytes[0],
            constraintBytes[1],
            0,
            0,
            0,
            0
        ], profileTierLevelOffset + 5);
        outputParts.push(addEmulationPreventionBytes(RBSP));
        if (nalUnitType === 32) {
            patchedVPSCount += 1;
        } else {
            patchedSPSCount += 1;
        }
    }
    if (patchedVPSCount !== 1 || patchedSPSCount !== 1) {
        throw new Error(
            `Expected one VPS/SPS, patched ${patchedVPSCount}/${patchedSPSCount}`
        );
    }
    return Buffer.concat(outputParts);
}

function getProfileTierLevelEvidence(bytes, expectedNALUnitType) {
    const startCodes = findAnnexBStartCodes(bytes);
    const unitIndex = startCodes.findIndex(startCode => {
        const nalUnitOffset = startCode.byteOffset + startCode.byteLength;
        return ((bytes[nalUnitOffset] >> 1) & 0x3F) === expectedNALUnitType;
    });
    if (unitIndex < 0) {
        throw new Error(`Fixture has no NAL unit type ${expectedNALUnitType}`);
    }
    const startCode = startCodes[unitIndex];
    const nalUnitOffset = startCode.byteOffset + startCode.byteLength;
    const nalUnitEndOffset = unitIndex + 1 < startCodes.length ?
        startCodes[unitIndex + 1].byteOffset :
        bytes.length;
    const nalUnit = bytes.subarray(nalUnitOffset, nalUnitEndOffset);
    const RBSP = removeEmulationPreventionBytes(nalUnit);
    const profileTierLevelOffset = expectedNALUnitType === 32 ? 6 : 3;
    if (RBSP.length < profileTierLevelOffset + 11) {
        throw new Error('Fixture parameter set is too short for profile-tier-level constraints');
    }
    const profileIDC = RBSP[profileTierLevelOffset] & 0x1F;
    const compatibilityFlags = RBSP.subarray(
        profileTierLevelOffset + 1,
        profileTierLevelOffset + 5
    );
    const firstConstraintByte = RBSP[profileTierLevelOffset + 5];
    const secondConstraintByte = RBSP[profileTierLevelOffset + 6];
    return {
        compatibilityFlags: compatibilityFlags.toString('hex').toUpperCase(),
        constraintPrefix: [ firstConstraintByte, secondConstraintByte ]
            .map(value => value.toString(16).padStart(2, '0').toUpperCase())
            .join('.'),
        intraConstrained: (secondConstraintByte & 0x20) !== 0,
        onePictureOnly: (secondConstraintByte & 0x10) !== 0,
        profileIDC
    };
}

function mixFingerprintValue(fingerprint, value) {
    let mixedFingerprint = Math.imul(
        (fingerprint ^ (value & 0xFF)) >>> 0,
        FNV1A_PRIME
    ) >>> 0;
    mixedFingerprint = Math.imul(
        (mixedFingerprint ^ ((value >>> 8) & 0xFF)) >>> 0,
        FNV1A_PRIME
    ) >>> 0;
    return mixedFingerprint;
}

function mixPlaneFingerprint(
    fingerprint,
    frame,
    planeOffset,
    width,
    height,
    bytesPerComponent
) {
    const stride = width * bytesPerComponent;
    let mixedFingerprint = mixFingerprintValue(fingerprint, width);
    mixedFingerprint = mixFingerprintValue(mixedFingerprint, height);
    for (
        let rowSampleIndex = 0;
        rowSampleIndex < FINGERPRINT_ROW_SAMPLE_COUNT;
        rowSampleIndex += 1
    ) {
        const rowIndex = Math.floor(
            rowSampleIndex * (height - 1) / (FINGERPRINT_ROW_SAMPLE_COUNT - 1)
        );
        for (
            let columnSampleIndex = 0;
            columnSampleIndex < FINGERPRINT_COLUMN_SAMPLE_COUNT;
            columnSampleIndex += 1
        ) {
            const columnIndex = Math.floor(
                columnSampleIndex * (width - 1)
                    / (FINGERPRINT_COLUMN_SAMPLE_COUNT - 1)
            );
            const byteOffset = planeOffset
                + (rowIndex * stride)
                + (columnIndex * bytesPerComponent);
            const sample = bytesPerComponent === 1 ?
                frame[byteOffset] :
                frame.readUInt16LE(byteOffset);
            mixedFingerprint = mixFingerprintValue(mixedFingerprint, sample);
        }
    }
    return mixedFingerprint;
}

function getFormatGeometry(pixelFormat) {
    const bytesPerComponent = pixelFormat.includes('10le') || pixelFormat.includes('12le') ?
        2 :
        1;
    const chromaWidthDivisor = pixelFormat.startsWith('yuv444') ? 1 : 2;
    const chromaHeightDivisor = pixelFormat.startsWith('yuv420') ? 2 : 1;
    const chromaWidth = Math.ceil(CODED_WIDTH / chromaWidthDivisor);
    const chromaHeight = Math.ceil(CODED_HEIGHT / chromaHeightDivisor);
    const lumaByteLength = CODED_WIDTH * CODED_HEIGHT * bytesPerComponent;
    const chromaByteLength = chromaWidth * chromaHeight * bytesPerComponent;
    return {
        bytesPerComponent,
        chromaByteLength,
        chromaHeight,
        chromaWidth,
        frameByteLength: lumaByteLength + (2 * chromaByteLength),
        lumaByteLength
    };
}

function createFrameFingerprint(frame, geometry) {
    let fingerprint = mixPlaneFingerprint(
        FNV1A_OFFSET_BASIS,
        frame,
        0,
        CODED_WIDTH,
        CODED_HEIGHT,
        geometry.bytesPerComponent
    );
    fingerprint = mixPlaneFingerprint(
        fingerprint,
        frame,
        geometry.lumaByteLength,
        geometry.chromaWidth,
        geometry.chromaHeight,
        geometry.bytesPerComponent
    );
    return mixPlaneFingerprint(
        fingerprint,
        frame,
        geometry.lumaByteLength + geometry.chromaByteLength,
        geometry.chromaWidth,
        geometry.chromaHeight,
        geometry.bytesPerComponent
    );
}

function getDecodedFingerprints(inputPath, fixture) {
    const decodedBytes = runBinaryCommand('ffmpeg', [
        '-v',
        'error',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-pix_fmt',
        fixture.pixelFormat,
        '-f',
        'rawvideo',
        'pipe:1'
    ]);
    const geometry = getFormatGeometry(fixture.pixelFormat);
    if (decodedBytes.length !== geometry.frameByteLength * fixture.frameCount) {
        throw new Error(`${fixture.variant} decoded raw byte length is unexpected`);
    }
    const fingerprints = [];
    for (let frameIndex = 0; frameIndex < fixture.frameCount; frameIndex += 1) {
        const byteOffset = frameIndex * geometry.frameByteLength;
        const frame = decodedBytes.subarray(byteOffset, byteOffset + geometry.frameByteLength);
        fingerprints.push(createFrameFingerprint(frame, geometry));
    }
    return fingerprints;
}

async function checkToolchain(temporaryDirectory) {
    const FFmpegVersion = runTextCommand('ffmpeg', [ '-version' ]).stdout;
    if (!FFmpegVersion.startsWith(`ffmpeg version ${PINNED_FFMPEG_VERSION}`)
        || !PINNED_LIBAVCODEC_VERSION_PATTERN.test(FFmpegVersion)) {
        throw new Error('The installed FFmpeg/libavcodec version is not pinned');
    }
    const FFprobeVersion = runTextCommand('ffprobe', [ '-version' ]).stdout;
    if (!FFprobeVersion.startsWith(`ffprobe version ${PINNED_FFMPEG_VERSION}`)) {
        throw new Error('The installed FFprobe version is not pinned');
    }

    const x265ProbePath = join(temporaryDirectory, 'x265-version.hevc');
    const result = runTextCommand('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=size=${CODED_WIDTH}x${CODED_HEIGHT}:rate=1:duration=1`,
        '-frames:v',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx265',
        '-profile:v',
        'main444-8',
        '-x265-params',
        'info=0:pools=none:frame-threads=1:wpp=0:log-level=info:keyint=1:level-idc=3.1',
        '-f',
        'hevc',
        '-y',
        x265ProbePath
    ]);
    if (!result.stderr.includes(`HEVC encoder version ${PINNED_X265_VERSION}`)) {
        throw new Error('The installed x265 version is not pinned');
    }
}

async function getFixtureEvidence(fixture, generatedPath) {
    await generateFixture(fixture, generatedPath);
    const generatedBytes = await readFile(generatedPath);
    return {
        accessUnitByteLengths: getPacketByteLengths(generatedPath),
        decodedFingerprints: getDecodedFingerprints(generatedPath, fixture),
        pictureTypes: getPictureTypes(generatedPath),
        PTL: {
            SPS: getProfileTierLevelEvidence(generatedBytes, 33),
            VPS: getProfileTierLevelEvidence(generatedBytes, 32)
        },
        SHA256: hashBytes(generatedBytes)
    };
}

async function verifyFixture(fixture, generatedPath, writeFixtures) {
    const evidence = await getFixtureEvidence(fixture, generatedPath);
    const generatedBytes = await readFile(generatedPath);
    requireEqual(evidence.SHA256, fixture.expectedSHA256, `${fixture.variant} SHA-256`);
    requireEqual(
        evidence.accessUnitByteLengths,
        fixture.accessUnitByteLengths,
        `${fixture.variant} access-unit lengths`
    );
    requireEqual(
        evidence.pictureTypes,
        fixture.frameCount === 1 ? [ 'I' ] : [ 'I', 'P' ],
        `${fixture.variant} picture types`
    );
    const PTLEvidence = evidence.PTL.VPS;
    requireEqual(evidence.PTL.SPS, PTLEvidence, `${fixture.variant} VPS/SPS PTL`);
    requireEqual(PTLEvidence.profileIDC, 4, `${fixture.variant} profile IDC`);
    requireEqual(
        PTLEvidence.compatibilityFlags,
        '08000000',
        `${fixture.variant} compatibility flags`
    );
    requireEqual(PTLEvidence.constraintPrefix, fixture.constraintPrefix, `${fixture.variant} PTL`);
    requireEqual(
        PTLEvidence.intraConstrained,
        fixture.intraConstrained,
        `${fixture.variant} intra constraint`
    );
    requireEqual(PTLEvidence.onePictureOnly, false, `${fixture.variant} one-picture constraint`);
    requireEqual(
        evidence.decodedFingerprints,
        fixture.expectedFingerprints,
        `${fixture.variant} decoded fingerprints`
    );

    const checkedInPath = join(FIXTURE_DIRECTORY, `${fixture.variant}.hevc`);
    if (writeFixtures) {
        await copyFile(generatedPath, checkedInPath);
    } else {
        const checkedInBytes = await readFile(checkedInPath);
        requireEqual(
            hashBytes(checkedInBytes),
            fixture.expectedSHA256,
            `${fixture.variant} checked-in SHA-256`
        );
        if (!checkedInBytes.equals(generatedBytes)) {
            throw new Error(`${fixture.variant} checked-in bytes differ from regeneration`);
        }
    }
}

async function main() {
    const argumentsList = process.argv.slice(2);
    if (argumentsList.some(argument => argument !== '--write' && argument !== '--inspect')
        || new Set(argumentsList).size !== argumentsList.length
        || argumentsList.length > 1) {
        throw new Error('Usage: node regenerate-and-verify.mjs [--inspect|--write]');
    }
    const writeFixtures = argumentsList.includes('--write');
    const inspectFixtures = argumentsList.includes('--inspect');
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'jellyfin-hevc-rext-'));
    try {
        await checkToolchain(temporaryDirectory);
        for (const fixture of FIXTURES) {
            const generatedPath = join(temporaryDirectory, `${fixture.variant}.hevc`);
            if (inspectFixtures) {
                const evidence = await getFixtureEvidence(fixture, generatedPath);
                process.stdout.write(`${JSON.stringify({
                    ...evidence,
                    variant: fixture.variant
                })}\n`);
            } else {
                await verifyFixture(fixture, generatedPath, writeFixtures);
            }
        }
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
    if (!inspectFixtures) {
        process.stdout.write(
            `Verified ${FIXTURES.length} deterministic HEVC range-extension fixtures.\n`
        );
    }
}

await main();
