import { waitForBrowserAudioOperation } from './BrowserAudioOperation';

/** Whether device enumeration lists any audio output */
export type AudioOutputDevicePresence = 'absent' | 'present' | 'unknown';

/**
 * Classifies one enumeration.
 * Chromium lists one blank audiooutput entry while any output exists, even without permission, so an empty list there means no output device.
 * Engines that hide outputs without permission make an empty list inconclusive, so callers act on absence only where AudioContext sink selection marks a Chromium-family engine.
 */
export function getAudioOutputDevicePresence(devices: readonly MediaDeviceInfo[]): 'absent' | 'present' {
    return devices.some(device => device.kind === 'audiooutput') ? 'present' : 'absent';
}

/** Enumerates once; unavailable, failed, or stalled enumeration is unknown */
export async function probeAudioOutputDevicePresence(mediaDevices: MediaDevices | null): Promise<AudioOutputDevicePresence> {
    if (typeof mediaDevices?.enumerateDevices !== 'function') {
        return 'unknown';
    }

    try {
        const devices = await waitForBrowserAudioOperation(mediaDevices.enumerateDevices(), 'Audio output device enumeration');
        return getAudioOutputDevicePresence(devices);
    } catch {
        return 'unknown';
    }
}

/** Probes the page's own media devices */
export function probeDefaultAudioOutputDevicePresence(): Promise<AudioOutputDevicePresence> {
    // eslint-disable-next-line compat/compat -- Feature-detected secure-context API
    return probeAudioOutputDevicePresence(globalThis.navigator?.mediaDevices ?? null);
}
