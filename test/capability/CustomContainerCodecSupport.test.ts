import { describe, expect, it } from 'vitest';

import {
    CUSTOM_CONTAINER_CODEC_RULES,
    getCustomAudioCodecProfileContainers,
    isCustomPlaybackContainer,
    supportsCustomContainerCodecCombination
} from 'webgpu-player/capability/CustomContainerCodecSupport';

describe('CustomContainerCodecSupport', () => {
    it('accepts the complete audio and video cross product declared by every rule', () => {
        for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
            const containers: readonly string[] = [
                ...rule.profileContainers,
                ...rule.containerAliases
            ];
            for (const container of containers) {
                expect(isCustomPlaybackContainer(container)).toBe(true);
                for (const videoCodec of rule.videoCodecs) {
                    expect(supportsCustomContainerCodecCombination([ container ], videoCodec, null)).toBe(true);
                    for (const audioCodec of rule.audioCodecs) {
                        expect(supportsCustomContainerCodecCombination([ container ], videoCodec, audioCodec)).toBe(true);
                    }
                }
            }
        }
    });

    it.each([
        [ 'mp4', 'dts' ],
        [ 'mov', 'truehd' ],
        [ 'm4v', 'dts' ],
        [ '3gp', 'truehd' ]
    ] as const)('carries %s %s through the ISO BMFF sample entries the worker maps', (container, audioCodec) => {
        expect(supportsCustomContainerCodecCombination([ container ], 'hevc', audioCodec)).toBe(true);
    });

    it('lists every profile container that can carry an audio codec', () => {
        expect(getCustomAudioCodecProfileContainers('dts')).toEqual([ 'mp4', 'm4v', 'mov', 'mkv', 'ts', 'm2ts', 'mts' ]);
        expect(getCustomAudioCodecProfileContainers('truehd')).toEqual([ 'mp4', 'm4v', 'mov', 'mkv' ]);
        expect(getCustomAudioCodecProfileContainers('mlp')).toEqual([ 'mkv' ]);
    });

    it.each([
        [ 'h264', 'mp3' ],
        [ 'vp8', 'pcm_s16le' ],
        [ 'vp9', 'aac' ],
        [ 'av1', 'ac3' ],
        [ 'h264', 'pcm_alaw' ],
        [ 'h264', 'pcm_s24le' ],
        [ 'h264', 'pcm_f32le' ],
        [ 'h264', 'flac' ],
        [ 'vp9', 'vorbis' ]
    ] as const)('carries %s with %s in AVI, which the fork demuxes', (videoCodec, audioCodec) => {
        expect(supportsCustomContainerCodecCombination([ 'avi' ], videoCodec, audioCodec)).toBe(true);
    });

    it.each([
        [ 'ts', 'mpeg1video', 'mp3' ],
        [ 'ts', 'mpeg2video', 'ac3' ],
        [ 'm2ts', 'mpeg2video', 'aac' ],
        [ 'mts', 'vc1', 'eac3' ],
        [ 'm2ts', 'vc1', 'ac3' ],
        [ 'm2ts', 'hevc', 'dts' ],
        [ 'ts', 'h264', 'dts' ]
    ] as const)('carries %s %s with %s, which the fork demuxes', (container, videoCodec, audioCodec) => {
        expect(supportsCustomContainerCodecCombination([ container ], videoCodec, audioCodec)).toBe(true);
    });

    it.each([
        [ 'avi', 'hevc', 'ac3' ],
        [ 'avi', 'h264', 'eac3' ],
        [ 'avi', 'mpeg2video', 'mp3' ],
        [ 'mkv', 'jpeg2000', 'flac' ],
        [ 'webm', 'h264', 'opus' ],
        [ 'webm', 'vp9', 'ac3' ],
        [ 'ts', 'wmv3', 'ac3' ],
        [ 'mp4', 'h264', 'mlp' ],
        [ 'm2ts', 'hevc', 'truehd' ]
    ] as const)(
        'rejects the undeclared %s/%s/%s container combination',
        (container, videoCodec, audioCodec) => {
            expect(supportsCustomContainerCodecCombination([ container ], videoCodec, audioCodec)).toBe(false);
        }
    );
});
