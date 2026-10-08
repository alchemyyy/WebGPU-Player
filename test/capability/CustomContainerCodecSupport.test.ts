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
                    expect(supportsCustomContainerCodecCombination(
                        [ container ],
                        videoCodec,
                        null
                    )).toBe(true);
                    for (const audioCodec of rule.audioCodecs) {
                        expect(supportsCustomContainerCodecCombination(
                            [ container ],
                            videoCodec,
                            audioCodec
                        )).toBe(true);
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
        expect(getCustomAudioCodecProfileContainers('dts')).toEqual([ 'mp4', 'm4v', 'mov', 'mkv' ]);
        expect(getCustomAudioCodecProfileContainers('truehd')).toEqual([ 'mp4', 'm4v', 'mov', 'mkv' ]);
        expect(getCustomAudioCodecProfileContainers('mlp')).toEqual([ 'mkv' ]);
    });

    it.each([
        [ 'mkv', 'jpeg2000', 'flac' ],
        [ 'webm', 'h264', 'opus' ],
        [ 'webm', 'vp9', 'ac3' ],
        [ 'ts', 'vc1', 'ac3' ],
        [ 'mp4', 'h264', 'mlp' ],
        [ 'ts', 'hevc', 'dts' ]
    ] as const)(
        'rejects the undeclared %s/%s/%s container combination',
        (container, videoCodec, audioCodec) => {
            expect(supportsCustomContainerCodecCombination(
                [ container ],
                videoCodec,
                audioCodec
            )).toBe(false);
        }
    );
});
