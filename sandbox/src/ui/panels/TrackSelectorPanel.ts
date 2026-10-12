// The track selectors: the open media's audio track, and its subtitle track or a subtitle file beside it.
import {
    DEFAULT_SUBTITLE_SELECTION,
    getDefaultAudioTrackIndex,
    type AudioTrackDescription,
    type LibraryDirectory,
    type LibraryFile,
    type MediaDescription,
    type SandboxState,
    type SubtitleSelection,
    type SubtitleTrackDescription,
    type TrackState
} from '../../contracts/SandboxContracts';
import { getLibraryEntryName } from '../../library/LibraryFiles';
import { findLibraryFile } from '../../library/LibraryTree';
import { reportCommandRejection } from '../commands';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { type Choice, createChoiceSelect } from './ChoiceSelect';
import { createDefaultButton, setDefaultButtonText } from './DefaultButton';
import { joinTextParts } from './PanelText';

import './TrackSelectorPanel.css';

const OFF_LABEL = 'Off';
const DEFAULT_TRACK_LABEL = 'default';
const FORCED_TRACK_LABEL = 'forced';
const CHANNEL_COUNT_SUFFIX = 'ch';

function formatAudioTrackLabel(track: AudioTrackDescription): string {
    return joinTextParts([
        `#${track.index}`,
        track.codec,
        `${track.channelCount}${CHANNEL_COUNT_SUFFIX}`,
        track.language,
        track.name,
        track.default ? DEFAULT_TRACK_LABEL : null
    ]);
}

function formatSubtitleTrackLabel(track: SubtitleTrackDescription): string {
    return joinTextParts([
        `#${track.index}`,
        track.codec,
        track.language,
        track.name,
        track.default ? DEFAULT_TRACK_LABEL : null,
        track.forced ? FORCED_TRACK_LABEL : null
    ]);
}

/** Lists the audio choices: off, then every audio track of the media. */
export function listAudioChoices(media: MediaDescription | null): Choice<number | null>[] {
    const choices: Choice<number | null>[] = [];
    choices.push({ label: OFF_LABEL, value: null });
    for (const track of media?.audioTracks ?? []) {
        choices.push({ label: formatAudioTrackLabel(track), value: track.index });
    }
    return choices;
}

/** Lists the subtitle choices: off, the media's text-based tracks, then the subtitle files beside the media in the library. */
export function listSubtitleChoices(media: MediaDescription | null, libraryFile: LibraryFile | null): Choice<SubtitleSelection | null>[] {
    const choices: Choice<SubtitleSelection | null>[] = [];
    choices.push({ label: OFF_LABEL, value: null });
    for (const track of media?.subtitleTracks ?? []) {
        if (track.textBased) {
            choices.push({ label: formatSubtitleTrackLabel(track), value: { kind: 'embedded', trackIndex: track.index } });
        }
    }
    for (const path of libraryFile?.subtitlePaths ?? []) {
        choices.push({ label: getLibraryEntryName(path), value: { kind: 'file', path } });
    }
    return choices;
}

/** Returns the label of the choice that holds a value, or the off label when none does. */
function findChoiceLabel<Value>(choices: readonly Choice<Value>[], isMatch: (value: Value) => boolean): string {
    return choices.find((choice: Choice<Value>): boolean => isMatch(choice.value))?.label ?? OFF_LABEL;
}

/** Returns whether two subtitle selections name the same source. */
export function isSameSubtitleSelection(firstSelection: SubtitleSelection | null, secondSelection: SubtitleSelection | null): boolean {
    if (firstSelection === null || secondSelection === null) {
        return firstSelection === secondSelection;
    }
    switch (firstSelection.kind) {
        case 'embedded':
            return secondSelection.kind === 'embedded' && secondSelection.trackIndex === firstSelection.trackIndex;
        case 'file':
            return secondSelection.kind === 'file' && secondSelection.path === firstSelection.path;
    }
}

export function createTrackSelectorPanel(context: PanelContext): Panel {
    const { session, store } = context;

    const renderSelections = (): void => {
        const tracks = store.getState().tracks;
        audioSelect.setValue(tracks.audioTrackIndex);
        subtitleSelect.setValue(tracks.subtitle);
    };

    // A selection the session refused leaves the select showing the session's tracks again
    const restoreSelections = (error: unknown): void => {
        reportCommandRejection(error);
        renderSelections();
    };

    const audioSelect = createChoiceSelect<number | null>((trackIndex: number | null): void => {
        session.selectAudioTrack(trackIndex).catch(restoreSelections);
    });
    const subtitleSelect = createChoiceSelect<SubtitleSelection | null>((selection: SubtitleSelection | null): void => {
        session.selectSubtitle(selection).catch(restoreSelections);
    }, isSameSubtitleSelection);
    // The defaults are what opening the file selects; a track change restarts the media, so a default button sends only a change
    const audioDefaultButton = createDefaultButton(OFF_LABEL, (): void => {
        const { media, tracks } = store.getState();
        if (media === null) {
            return;
        }
        const trackIndex = getDefaultAudioTrackIndex(media);
        if (trackIndex !== tracks.audioTrackIndex) {
            session.selectAudioTrack(trackIndex).catch(restoreSelections);
        }
    });
    const subtitleDefaultButton = createDefaultButton(OFF_LABEL, (): void => {
        if (!isSameSubtitleSelection(store.getState().tracks.subtitle, DEFAULT_SUBTITLE_SELECTION)) {
            session.selectSubtitle(DEFAULT_SUBTITLE_SELECTION).catch(restoreSelections);
        }
    });
    const element = createElement('section', { className: 'track-selector-panel' }, [
        createElement('label', { className: 'track-selector' }, [
            createElement('span', { text: 'Audio' }),
            createElement('span', { className: 'track-selector-control' }, [ audioSelect.element, audioDefaultButton ])
        ]),
        createElement('label', { className: 'track-selector' }, [
            createElement('span', { text: 'Subtitles' }),
            createElement('span', { className: 'track-selector-control' }, [ subtitleSelect.element, subtitleDefaultButton ])
        ])
    ]);

    const renderChoices = (): void => {
        const { library, media } = store.getState();
        const libraryFile = media === null || library.root === null ? null : findLibraryFile(library.root, media.path);
        const audioChoices = listAudioChoices(media);
        const subtitleChoices = listSubtitleChoices(media, libraryFile);
        const defaultTrackIndex = media === null ? null : getDefaultAudioTrackIndex(media);
        audioSelect.setChoices(audioChoices);
        subtitleSelect.setChoices(subtitleChoices);
        setDefaultButtonText(audioDefaultButton, findChoiceLabel(audioChoices, (trackIndex: number | null): boolean => trackIndex === defaultTrackIndex));
        setDefaultButtonText(subtitleDefaultButton, findChoiceLabel(subtitleChoices, (selection: SubtitleSelection | null): boolean => (
            isSameSubtitleSelection(selection, DEFAULT_SUBTITLE_SELECTION)
        )));
        for (const control of [ audioSelect.element, subtitleSelect.element, audioDefaultButton, subtitleDefaultButton ]) {
            control.disabled = media === null;
        }
        renderSelections();
    };

    const unsubscribers: (() => void)[] = [
        subscribeSelection(store, (state: SandboxState): MediaDescription | null => state.media, renderChoices),
        subscribeSelection(store, (state: SandboxState): LibraryDirectory | null => state.library.root, renderChoices),
        subscribeSelection(store, (state: SandboxState): TrackState => state.tracks, renderSelections)
    ];

    return {
        destroy: (): void => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
        element
    };
}
