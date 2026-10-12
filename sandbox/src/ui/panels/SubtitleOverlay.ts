// The subtitle overlay: the text of the cues active at the playback clock, read every animation frame, over the bottom center of the video.
import type { Microseconds } from 'webgpu-player/MediaTime';

import type { SandboxState, SubtitleCue } from '../../contracts/SandboxContracts';
import { createAnimationLoop } from '../AnimationLoop';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';

import './SubtitleOverlay.css';

const CUE_SEPARATOR = '\n';

/**
 * Returns the text of every cue active at a time, in cue order and one per line, or '' when none is.
 * A cue is active from its start up to, but not including, its end.
 */
export function getActiveCueText(cues: readonly SubtitleCue[], timeMicroseconds: Microseconds): string {
    const activeTexts: string[] = [];
    for (const cue of cues) {
        if (cue.startMicroseconds <= timeMicroseconds && timeMicroseconds < cue.endMicroseconds) {
            activeTexts.push(cue.text);
        }
    }
    return activeTexts.join(CUE_SEPARATOR);
}

export function createSubtitleOverlay(context: PanelContext): Panel {
    const { session, store } = context;
    let cues: readonly SubtitleCue[] = [];
    let shownText = '';
    const element = createElement('div', { className: 'subtitle-overlay' });
    element.hidden = true;

    const showText = (text: string): void => {
        if (text === shownText) {
            return;
        }
        shownText = text;
        element.textContent = text;
        element.hidden = text === '';
    };

    const cueLoop = createAnimationLoop((): void => {
        showText(getActiveCueText(cues, session.getCurrentTimeMicroseconds()));
    });

    const unsubscribe = subscribeSelection(store, (state: SandboxState): readonly SubtitleCue[] => state.subtitleCues, (nextCues: readonly SubtitleCue[]): void => {
        cues = nextCues;
        if (cues.length > 0) {
            cueLoop.start();
            return;
        }
        cueLoop.stop();
        showText('');
    });

    return {
        destroy: (): void => {
            cueLoop.stop();
            unsubscribe();
        },
        element
    };
}
