// Browser defects that kill the page rather than fail a call. A probe cannot learn these by trying: the crash takes the
// page down before any result is recorded, so each one is declared here and the matching step is blocked up front.
// Browser and version checks belong only to a declared defect.

import type { CapabilityProbeStep } from './CapabilityProbeSteps';

/** The rendering engine and its release major: Safari's version for WebKit, null when the user agent does not reveal it. */
export type BrowserIdentity = Readonly<{ engine: 'webkit' | 'other', majorVersion: number | null }>;

/** A browser defect that crashes a probe step, with the browsers it affects and the steps that trigger it. */
export type KnownBrowserDefect = Readonly<{
    bug: string
    summary: string
    affects: (browser: BrowserIdentity) => boolean
    matches: (step: CapabilityProbeStep) => boolean
}>;

type BrowserUserAgentSource = Readonly<{ userAgent?: string, vendor?: string }>;

// Every browser on iOS and iPadOS is required to use WebKit, whatever it calls itself (CriOS, FxiOS, EdgiOS)
const IOS_DEVICE = /\b(?:iPhone|iPad|iPod)\b/u;
const APPLE_WEBKIT = /\bAppleWebKit\//u;
// Engines that carry an AppleWebKit token for compatibility while being Blink or Gecko
const NON_WEBKIT_ENGINE = /\b(?:Chrome|Chromium|Edg|Firefox)\//u;
const APPLE_VENDOR = /\bApple\b/u;
// Safari, desktop-class iPadOS Safari, and Edge on iOS state the Safari release as Version/<major>.<minor>
const SAFARI_VERSION = /\bVersion\/(\d+)/u;
// "CPU iPhone OS 18_6 like Mac OS X" or "CPU OS 17_0 like Mac OS X"
const IOS_VERSION = /\bOS (\d+)_\d+/u;
// From Safari 26 on, WebKit on iOS, iPadOS, and visionOS freezes the operating system version in the user agent at
// 18.x (18_6, later 18_7) instead of the running release, in Safari and in every WKWebView-based browser alike:
// https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#update-to-ua-string ("user agent string no longer lists
// the current version of the operating system"), https://bugs.webkit.org/show_bug.cgi?id=298260 ("Safari 26 reports iOS 26
// version as 18.6"), https://docs.uaparser.dev/guides/how-to-detect-ios-26-using-javascript.html.
// A real iOS 18 has no AudioDecoder (WebCodecs audio arrived in Safari 26), so an 18.x token is genuine only without it.
const FROZEN_IOS_USER_AGENT_MAJOR = 18;

/** AAC in MP4 (RFC 6381 section 3.3): `mp4a.40.<audio object type>`. */
const AAC_CODEC_PREFIX = 'mp4a.40.';
// More than stereo makes AudioToolbox need a channel layout from the AudioSpecificConfig
const STEREO_CHANNEL_COUNT = 2;
// WebKit bug 308322 is fixed in Safari 27 (WebKit 625)
const WEBKIT_308322_FIXED_MAJOR = 27;

function readIOSWebKitMajor(userAgent: string): number | null {
    const match = IOS_VERSION.exec(userAgent);
    if (!match) {
        return null;
    }
    const major = Number(match[1]);
    if (major === FROZEN_IOS_USER_AGENT_MAJOR && typeof globalThis.AudioDecoder === 'function') {
        return null;
    }
    return major;
}

function readSafariMajor(userAgent: string): number | null {
    const match = SAFARI_VERSION.exec(userAgent);
    return match ? Number(match[1]) : null;
}

/**
 * Reads the engine and its release major from a navigator's user agent and vendor. WebKit is any iOS or iPadOS browser,
 * and desktop Safari or a WebKit web view; the major comes from `Version/<n>`, or on iOS without it from the OS token
 * when that token is not the frozen one.
 */
export function readBrowserIdentity(browser: BrowserUserAgentSource | undefined = globalThis.navigator): BrowserIdentity {
    const userAgent = browser?.userAgent ?? '';
    if (IOS_DEVICE.test(userAgent)) {
        return { engine: 'webkit', majorVersion: readSafariMajor(userAgent) ?? readIOSWebKitMajor(userAgent) };
    }
    const vendor = browser?.vendor;
    const isWebKit = APPLE_WEBKIT.test(userAgent)
        && !NON_WEBKIT_ENGINE.test(userAgent)
        && (vendor === undefined || APPLE_VENDOR.test(vendor));
    if (!isWebKit) {
        return { engine: 'other', majorVersion: null };
    }
    return { engine: 'webkit', majorVersion: readSafariMajor(userAgent) };
}

const KNOWN_BROWSER_DEFECTS: readonly KnownBrowserDefect[] = [
    {
        bug: 'https://bugs.webkit.org/show_bug.cgi?id=308322',
        summary: 'WebKit before Safari 27 (rdar://170845543): AudioToolbox returns no format description for the raw '
            + 'AudioSpecificConfig of AAC with more than 2 channels, and the first decode dereferences it, killing the page; '
            + 'fixed in Safari 27 (WebKit 625).',
        // An unknown release is assumed affected: no feature reveals the fix
        affects: (browser) => browser.engine === 'webkit'
            && (browser.majorVersion === null || browser.majorVersion < WEBKIT_308322_FIXED_MAJOR),
        matches: (step) => step.media === 'audio'
            && step.kind === 'decode'
            && step.codec.startsWith(AAC_CODEC_PREFIX)
            && step.numberOfChannels > STEREO_CHANNEL_COUNT
    }
];

/** Returns the declared defect that crashes the step on the browser, or null when none does. */
export function findKnownBrowserDefect(step: CapabilityProbeStep, browser: BrowserIdentity = readBrowserIdentity()): KnownBrowserDefect | null {
    return KNOWN_BROWSER_DEFECTS.find((defect) => defect.affects(browser) && defect.matches(step)) ?? null;
}
