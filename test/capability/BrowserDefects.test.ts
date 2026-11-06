import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    findKnownBrowserDefect,
    readBrowserIdentity,
    type BrowserIdentity
} from 'webgpu-player/capability/BrowserDefects';
import type {
    AudioCapabilityProbeStep,
    CapabilityProbeStepKind,
    VideoCapabilityProbeStep
} from 'webgpu-player/capability/CapabilityProbeSteps';

const APPLE_VENDOR = 'Apple Computer, Inc.';
const GOOGLE_VENDOR = 'Google Inc.';

const IPHONE_SAFARI_26 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/26.0 Mobile/15E148 Safari/604.1';
const IPHONE_SAFARI_26_6 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/26.6.1 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_SAFARI_26 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/26.2 Safari/605.1.15';
const MAC_SAFARI_26 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/26.3.1 Safari/605.1.15';
const MAC_SAFARI_27 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/27.0 Safari/605.1.15';
const MAC_WEB_VIEW = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IOS_WEB_VIEW_FROZEN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Mobile/15E148';
const IOS_17_WEB_VIEW = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1';
const IOS_FIREFOX = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'FxiOS/143.0 Mobile/15E148 Safari/605.1.15';
const IOS_EDGE_26 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) '
    + 'Version/26.0 EdgiOS/141.0.3537.57 Mobile/15E148 Safari/605.1.15';
const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/141.0.0.0 Safari/537.36';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/141.0.0.0 Safari/537.36';
const DESKTOP_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
    + 'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57';
const DESKTOP_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0';

const SAFARI_26: BrowserIdentity = { engine: 'webkit', majorVersion: 26 };
const SAFARI_27: BrowserIdentity = { engine: 'webkit', majorVersion: 27 };
const WEBKIT_UNKNOWN: BrowserIdentity = { engine: 'webkit', majorVersion: null };
const CHROMIUM: BrowserIdentity = { engine: 'other', majorVersion: null };

function audioStep(kind: CapabilityProbeStepKind, codec: string, numberOfChannels: number): AudioCapabilityProbeStep {
    return {
        media: 'audio',
        kind,
        codec,
        numberOfChannels,
        sampleRate: 48_000,
        label: `${kind} ${codec} ${numberOfChannels}ch 48000Hz`,
        cost: { bytes: 0, decoders: 1 }
    };
}

function videoStep(codec: string): VideoCapabilityProbeStep {
    return {
        media: 'video',
        kind: 'decode',
        codec,
        codedWidth: 1920,
        codedHeight: 1080,
        hardwareAcceleration: 'no-preference',
        copyFormat: null,
        label: `decode ${codec} 1920x1080`,
        cost: { bytes: 0, decoders: 1 }
    };
}

describe('readBrowserIdentity', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it.each([
        [ 'iPhone Safari 26', IPHONE_SAFARI_26, 26 ],
        [ 'iPhone Safari 26.6 with a later frozen OS token', IPHONE_SAFARI_26_6, 26 ],
        [ 'desktop-class iPadOS Safari 26', IPAD_DESKTOP_SAFARI_26, 26 ],
        [ 'macOS Safari 26', MAC_SAFARI_26, 26 ],
        [ 'macOS Safari 27', MAC_SAFARI_27, 27 ],
        [ 'Edge on iOS, which states the Safari release', IOS_EDGE_26, 26 ]
    ])('reads %s as WebKit with the Version/ major', (_name, userAgent, majorVersion) => {
        expect(readBrowserIdentity({ userAgent, vendor: APPLE_VENDOR })).toEqual({ engine: 'webkit', majorVersion });
    });

    it.each([
        [ 'iOS WKWebView', IOS_WEB_VIEW_FROZEN ],
        [ 'Chrome on iOS', IOS_CHROME ],
        [ 'Firefox on iOS', IOS_FIREFOX ]
    ])('treats the frozen OS 18 token of %s as unknown when AudioDecoder exists', (_name, userAgent) => {
        vi.stubGlobal('AudioDecoder', class {});
        expect(readBrowserIdentity({ userAgent, vendor: APPLE_VENDOR })).toEqual(WEBKIT_UNKNOWN);
    });

    it('trusts an OS 18 token on iOS without AudioDecoder, which only a real iOS 18 lacks', () => {
        vi.stubGlobal('AudioDecoder', undefined);
        expect(readBrowserIdentity({ userAgent: IOS_CHROME, vendor: APPLE_VENDOR })).toEqual({ engine: 'webkit', majorVersion: 18 });
    });

    it('trusts an iOS token below the frozen release', () => {
        vi.stubGlobal('AudioDecoder', class {});
        expect(readBrowserIdentity({ userAgent: IOS_17_WEB_VIEW, vendor: APPLE_VENDOR })).toEqual({ engine: 'webkit', majorVersion: 17 });
    });

    it('reads a macOS web view without Version/ as WebKit of unknown release', () => {
        expect(readBrowserIdentity({ userAgent: MAC_WEB_VIEW, vendor: APPLE_VENDOR })).toEqual(WEBKIT_UNKNOWN);
    });

    it.each([
        [ 'desktop Chrome', DESKTOP_CHROME, GOOGLE_VENDOR ],
        [ 'macOS Chrome', MAC_CHROME, GOOGLE_VENDOR ],
        [ 'desktop Edge', DESKTOP_EDGE, GOOGLE_VENDOR ],
        [ 'desktop Firefox', DESKTOP_FIREFOX, '' ],
        [ 'macOS Firefox', MAC_FIREFOX, '' ]
    ])('reads %s as another engine', (_name, userAgent, vendor) => {
        expect(readBrowserIdentity({ userAgent, vendor })).toEqual(CHROMIUM);
    });

    it('does not take a non-Apple vendor with a bare AppleWebKit token for WebKit', () => {
        expect(readBrowserIdentity({ userAgent: MAC_SAFARI_26, vendor: GOOGLE_VENDOR }).engine).toBe('other');
    });

    it('reads an absent navigator or user agent as another engine', () => {
        vi.stubGlobal('navigator', undefined);
        expect(readBrowserIdentity()).toEqual(CHROMIUM);
        expect(readBrowserIdentity({})).toEqual(CHROMIUM);
    });

    it('reads the global navigator by default', () => {
        vi.stubGlobal('navigator', { userAgent: MAC_SAFARI_27, vendor: APPLE_VENDOR });
        expect(readBrowserIdentity()).toEqual(SAFARI_27);
    });
});

describe('findKnownBrowserDefect', () => {
    it.each([
        [ 'AAC-LC 5.1', 'mp4a.40.2', 6 ],
        [ 'AAC-LC 7.1', 'mp4a.40.2', 8 ],
        [ 'HE-AAC 5.1', 'mp4a.40.5', 6 ],
        [ 'AAC 3.0', 'mp4a.40.2', 3 ]
    ])('blocks the %s decode on affected WebKit', (_name, codec, channels) => {
        const step = audioStep('decode', codec, channels);
        for (const browser of [ SAFARI_26, WEBKIT_UNKNOWN ]) {
            expect(findKnownBrowserDefect(step, browser)?.bug).toBe('https://bugs.webkit.org/show_bug.cgi?id=308322');
        }
    });

    it('blocks the multichannel AAC decode on WebKit identities read from real user agents', () => {
        const step = audioStep('decode', 'mp4a.40.2', 6);
        for (const userAgent of [ IPHONE_SAFARI_26, IPAD_DESKTOP_SAFARI_26, MAC_SAFARI_26, IOS_CHROME, IOS_WEB_VIEW_FROZEN ]) {
            expect(findKnownBrowserDefect(step, readBrowserIdentity({ userAgent, vendor: APPLE_VENDOR }))).not.toBeNull();
        }
    });

    it.each([
        [ 'stereo AAC decode', audioStep('decode', 'mp4a.40.2', 2) ],
        [ 'mono AAC decode', audioStep('decode', 'mp4a.40.2', 1) ],
        [ 'AAC 5.1 config check', audioStep('check', 'mp4a.40.2', 6) ],
        [ 'Opus 5.1 decode', audioStep('decode', 'opus', 6) ],
        [ 'FLAC 7.1 decode', audioStep('decode', 'flac', 8) ],
        [ 'MP3 decode', audioStep('decode', 'mp4a.6B', 6) ],
        [ 'video decode', videoStep('avc1.640028') ]
    ])('does not block a %s on affected WebKit', (_name, step) => {
        expect(findKnownBrowserDefect(step, SAFARI_26)).toBeNull();
        expect(findKnownBrowserDefect(step, WEBKIT_UNKNOWN)).toBeNull();
    });

    it.each([
        [ 'Safari 27', SAFARI_27 ],
        [ 'macOS Safari 27 user agent', readBrowserIdentity({ userAgent: MAC_SAFARI_27, vendor: APPLE_VENDOR }) ],
        [ 'a non-WebKit engine', CHROMIUM ],
        [ 'desktop Chrome user agent', readBrowserIdentity({ userAgent: DESKTOP_CHROME, vendor: GOOGLE_VENDOR }) ],
        [ 'desktop Firefox user agent', readBrowserIdentity({ userAgent: DESKTOP_FIREFOX, vendor: '' }) ]
    ])('does not block multichannel AAC decode on %s', (_name, browser) => {
        expect(findKnownBrowserDefect(audioStep('decode', 'mp4a.40.2', 6), browser)).toBeNull();
    });
});
