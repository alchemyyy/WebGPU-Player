// The transport bar: play and pause, a timeline that seeks on click and drag, the current and total time, and volume.
import type { Microseconds } from 'webgpu-player/MediaTime';

import {
    DEFAULT_VOLUME,
    type MediaDescription,
    type PlaybackState,
    type PlaybackStatus,
    type SandboxState
} from '../../contracts/SandboxContracts';
import { createAnimationLoop } from '../AnimationLoop';
import { reportCommandRejection } from '../commands';
import { createElement } from '../dom';
import { OVERLAY_TOGGLE_KEY } from '../OverlayToggle';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { formatMediaTime } from '../TimeFormat';
import { createDefaultButton } from './DefaultButton';
import { getPointerFraction, getTimeAtFraction, getTimeFraction } from './TimelinePosition';

import './TransportBarPanel.css';

// Dragging the timeline seeks at most this often, and once more where the drag ends
const SCRUB_SEEK_INTERVAL_MILLISECONDS = 200;
const PRIMARY_POINTER_BUTTON = 0;
// The contract's volume runs from 0 to 1
const MINIMUM_VOLUME = 0;
const MAXIMUM_VOLUME = 1;
const VOLUME_STEP = 0.01;
// The stylesheet places the progress bar and the playhead from this property
const TIMELINE_FRACTION_PROPERTY = '--timeline-fraction';
const SEEKABLE_CLASS = 'is-seekable';
const START_TIME = 0 as Microseconds;

/** Returns the status worth showing beside the time; idle, paused, and playing speak for themselves. */
function describePlaybackStatus(status: PlaybackStatus): string {
    switch (status) {
        case 'ended':
        case 'failed':
        case 'loading':
        case 'seeking':
            return status;
        case 'idle':
        case 'paused':
        case 'playing':
            return '';
    }
}

export function createTransportBarPanel(context: PanelContext): Panel {
    const { session, store } = context;
    let durationMicroseconds: Microseconds | null = null;
    let playing = false;
    // The fraction under the pointer while the timeline is dragged
    let scrubFraction: number | null = null;
    let lastSeekFraction: number | null = null;
    let lastSeekMilliseconds = 0;
    let shownFraction: number | null = null;
    let shownTimeText = '';

    const timelineElement = createElement('div', { className: 'transport-timeline' }, [
        createElement('div', { className: 'transport-timeline-track' }, [ createElement('div', { className: 'transport-timeline-progress' }) ]),
        createElement('div', { className: 'transport-timeline-playhead' })
    ]);
    const playButton = createElement('button', { className: 'transport-play' });
    const timeElement = createElement('span', { className: 'transport-time' });
    const statusElement = createElement('span', { className: 'transport-status' });
    const muteButton = createElement('button', { className: 'transport-mute' });
    const volumeInput = createElement('input', {
        attributes: { max: String(MAXIMUM_VOLUME), min: String(MINIMUM_VOLUME), step: String(VOLUME_STEP), title: 'Volume', type: 'range' },
        className: 'transport-volume'
    });
    const element = createElement('section', { className: 'transport-bar-panel' }, [
        timelineElement,
        createElement('div', { className: 'transport-controls' }, [
            playButton,
            timeElement,
            statusElement,
            createElement('span', { className: 'transport-spacer' }),
            muteButton,
            volumeInput,
            createDefaultButton(String(DEFAULT_VOLUME), (): void => {
                session.setVolume(DEFAULT_VOLUME);
            }),
            createElement('span', { className: 'transport-hint', text: `${OVERLAY_TOGGLE_KEY.toUpperCase()} hides panels` })
        ])
    ]);

    const renderPosition = (timeMicroseconds: Microseconds): void => {
        const fraction = getTimeFraction(timeMicroseconds, durationMicroseconds);
        if (fraction !== shownFraction) {
            shownFraction = fraction;
            timelineElement.style.setProperty(TIMELINE_FRACTION_PROPERTY, String(fraction));
        }
        const timeText = `${formatMediaTime(timeMicroseconds, durationMicroseconds)} / ${formatMediaTime(durationMicroseconds)}`;
        if (timeText !== shownTimeText) {
            shownTimeText = timeText;
            timeElement.textContent = timeText;
        }
    };

    /** Returns the time the playhead shows: the pointer's while the timeline is dragged, else the playback clock. */
    const readShownTime = (): Microseconds => {
        if (scrubFraction !== null && durationMicroseconds !== null) {
            return getTimeAtFraction(scrubFraction, durationMicroseconds);
        }
        return session.getCurrentTimeMicroseconds();
    };

    const playheadLoop = createAnimationLoop((): void => {
        renderPosition(readShownTime());
    });

    const seekToFraction = (fraction: number): void => {
        if (durationMicroseconds === null) {
            return;
        }
        lastSeekFraction = fraction;
        lastSeekMilliseconds = performance.now();
        session.seek(getTimeAtFraction(fraction, durationMicroseconds));
    };

    const readPointerFraction = (event: PointerEvent): number => {
        const bounds = timelineElement.getBoundingClientRect();
        return getPointerFraction(event.clientX, bounds.left, bounds.width);
    };

    timelineElement.addEventListener('pointerdown', (event: PointerEvent): void => {
        if (durationMicroseconds === null || event.button !== PRIMARY_POINTER_BUTTON) {
            return;
        }
        timelineElement.setPointerCapture(event.pointerId);
        scrubFraction = readPointerFraction(event);
        seekToFraction(scrubFraction);
    });
    timelineElement.addEventListener('pointermove', (event: PointerEvent): void => {
        if (scrubFraction === null) {
            return;
        }
        scrubFraction = readPointerFraction(event);
        if (performance.now() - lastSeekMilliseconds >= SCRUB_SEEK_INTERVAL_MILLISECONDS) {
            seekToFraction(scrubFraction);
        }
    });
    timelineElement.addEventListener('pointerup', (event: PointerEvent): void => {
        if (scrubFraction === null) {
            return;
        }
        scrubFraction = readPointerFraction(event);
        if (scrubFraction !== lastSeekFraction) {
            seekToFraction(scrubFraction);
        }
        scrubFraction = null;
    });
    // A cancelled drag keeps its last seek; losing the capture ends any drag
    timelineElement.addEventListener('lostpointercapture', (): void => {
        scrubFraction = null;
    });

    playButton.addEventListener('click', (): void => {
        if (playing) {
            session.pause();
            return;
        }
        session.play().catch(reportCommandRejection);
    });
    muteButton.addEventListener('click', (): void => {
        session.setMuted(!store.getState().playback.muted);
    });
    volumeInput.addEventListener('input', (): void => {
        session.setVolume(volumeInput.valueAsNumber);
    });

    const renderPlayback = (playback: PlaybackState): void => {
        durationMicroseconds = playback.durationMicroseconds;
        playing = playback.status === 'playing';
        playButton.textContent = playing ? 'Pause' : 'Play';
        statusElement.textContent = describePlaybackStatus(playback.status);
        muteButton.textContent = playback.muted ? 'Unmute' : 'Mute';
        muteButton.setAttribute('aria-pressed', String(playback.muted));
        volumeInput.value = String(playback.volume);
        timelineElement.classList.toggle(SEEKABLE_CLASS, durationMicroseconds !== null);
    };

    const renderMedia = (media: MediaDescription | null): void => {
        playButton.disabled = media === null;
        if (media !== null) {
            playheadLoop.start();
            return;
        }
        playheadLoop.stop();
        renderPosition(START_TIME);
    };

    const unsubscribers: (() => void)[] = [
        subscribeSelection(store, (state: SandboxState): PlaybackState => state.playback, renderPlayback),
        subscribeSelection(store, (state: SandboxState): MediaDescription | null => state.media, renderMedia)
    ];

    return {
        destroy: (): void => {
            playheadLoop.stop();
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
        element
    };
}
