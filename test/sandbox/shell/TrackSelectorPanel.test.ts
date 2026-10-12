import { describe, expect, it } from 'vitest';

import type {
    AudioTrackDescription,
    LibraryFile,
    MediaDescription,
    SubtitleSelection,
    SubtitleTrackDescription
} from '../../../sandbox/src/contracts/SandboxContracts';
import {
    createTrackSelectorPanel,
    isSameSubtitleSelection,
    listAudioChoices,
    listSubtitleChoices
} from '../../../sandbox/src/ui/panels/TrackSelectorPanel';
import { createFakePanelContext } from './sandboxFakes';

const MEDIA_PATH = 'Shows/episode.mkv';
const SUBTITLE_FILE_PATH = 'Shows/episode.en.srt';
const OTHER_SUBTITLE_FILE_PATH = 'Shows/episode.fr.srt';
const MEDIA_SIZE_BYTES = 1_000;
const STEREO_CHANNEL_COUNT = 2;
const SURROUND_CHANNEL_COUNT = 6;
const SAMPLE_RATE = 48_000;
const TEXT_TRACK_INDEX = 2;
const IMAGE_TRACK_INDEX = 3;
const OTHER_TEXT_TRACK_INDEX = 4;

const AUDIO_TRACKS: readonly AudioTrackDescription[] = [
    { channelCount: SURROUND_CHANNEL_COUNT, codec: 'eac3', default: true, index: 1, language: 'eng', name: null, profile: null, sampleRate: SAMPLE_RATE },
    { channelCount: STEREO_CHANNEL_COUNT, codec: 'aac', default: false, index: 5, language: null, name: 'Commentary', profile: 'LC', sampleRate: SAMPLE_RATE }
];
const SUBTITLE_TRACKS: readonly SubtitleTrackDescription[] = [
    { codec: 'subrip', default: true, forced: false, index: TEXT_TRACK_INDEX, language: 'eng', name: null, textBased: true },
    // Image subtitles have no text for the overlay
    { codec: 'hdmv_pgs_subtitle', default: false, forced: false, index: IMAGE_TRACK_INDEX, language: 'eng', name: null, textBased: false },
    { codec: 'ass', default: false, forced: true, index: OTHER_TEXT_TRACK_INDEX, language: null, name: 'Signs', textBased: true }
];
const MEDIA: MediaDescription = {
    audioTracks: AUDIO_TRACKS,
    container: 'mkv',
    durationMicroseconds: null,
    path: MEDIA_PATH,
    sizeBytes: MEDIA_SIZE_BYTES,
    subtitleTracks: SUBTITLE_TRACKS,
    videoTracks: []
};
const LIBRARY_FILE: LibraryFile = {
    kind: 'file',
    name: 'episode.mkv',
    path: MEDIA_PATH,
    sizeBytes: MEDIA_SIZE_BYTES,
    subtitlePaths: [ SUBTITLE_FILE_PATH ]
};
const EMBEDDED_SELECTION: SubtitleSelection = { kind: 'embedded', trackIndex: TEXT_TRACK_INDEX };
const OTHER_EMBEDDED_SELECTION: SubtitleSelection = { kind: 'embedded', trackIndex: OTHER_TEXT_TRACK_INDEX };
const FILE_SELECTION: SubtitleSelection = { kind: 'file', path: SUBTITLE_FILE_PATH };
const OTHER_FILE_SELECTION: SubtitleSelection = { kind: 'file', path: OTHER_SUBTITLE_FILE_PATH };
// The media opens on its track marked default, with subtitles off
const DEFAULT_AUDIO_TRACK_INDEX = 1;
const COMMENTARY_TRACK_INDEX = 5;
const DEFAULT_AUDIO_TITLE = 'Default: #1 eac3 6ch eng default';
const DEFAULT_SUBTITLE_TITLE = 'Default: Off';
const DEFAULT_BUTTON_SELECTOR = '.default-button';

describe('TrackSelectorPanel choices', () => {
    it('offers off, then every audio track with its known details', () => {
        expect(listAudioChoices(MEDIA)).toEqual([
            { label: 'Off', value: null },
            { label: '#1 eac3 6ch eng default', value: 1 },
            { label: '#5 aac 2ch Commentary', value: 5 }
        ]);
        expect(listAudioChoices(null)).toEqual([ { label: 'Off', value: null } ]);
    });

    it('offers off, the text-based tracks, then the subtitle files beside the media', () => {
        expect(listSubtitleChoices(MEDIA, LIBRARY_FILE)).toEqual([
            { label: 'Off', value: null },
            { label: '#2 subrip eng default', value: EMBEDDED_SELECTION },
            { label: '#4 ass Signs forced', value: OTHER_EMBEDDED_SELECTION },
            { label: 'episode.en.srt', value: FILE_SELECTION }
        ]);
        expect(listSubtitleChoices(MEDIA, null)).toHaveLength(3);
        expect(listSubtitleChoices(null, null)).toEqual([ { label: 'Off', value: null } ]);
    });

    it('compares subtitle selections by source', () => {
        expect(isSameSubtitleSelection(EMBEDDED_SELECTION, { ...EMBEDDED_SELECTION })).toBe(true);
        expect(isSameSubtitleSelection(FILE_SELECTION, { ...FILE_SELECTION })).toBe(true);
        expect(isSameSubtitleSelection(null, null)).toBe(true);
        expect(isSameSubtitleSelection(EMBEDDED_SELECTION, OTHER_EMBEDDED_SELECTION)).toBe(false);
        expect(isSameSubtitleSelection(FILE_SELECTION, OTHER_FILE_SELECTION)).toBe(false);
        expect(isSameSubtitleSelection(EMBEDDED_SELECTION, FILE_SELECTION)).toBe(false);
        expect(isSameSubtitleSelection(FILE_SELECTION, null)).toBe(false);
        expect(isSameSubtitleSelection(null, EMBEDDED_SELECTION)).toBe(false);
    });
});

describe('TrackSelectorPanel default buttons', () => {
    it('return the audio track and the subtitles to what opening the file selects, sending only a change', () => {
        const context = createFakePanelContext();
        const panel = createTrackSelectorPanel(context);
        const [ audioDefaultButton, subtitleDefaultButton ] = panel.element.querySelectorAll<HTMLButtonElement>(DEFAULT_BUTTON_SELECTOR);
        expect(audioDefaultButton.disabled).toBe(true);

        context.store.setState({ media: MEDIA, tracks: { audioTrackIndex: COMMENTARY_TRACK_INDEX, subtitle: EMBEDDED_SELECTION, videoTrackIndex: null } });
        audioDefaultButton.click();
        subtitleDefaultButton.click();

        expect(audioDefaultButton.title).toBe(DEFAULT_AUDIO_TITLE);
        expect(subtitleDefaultButton.title).toBe(DEFAULT_SUBTITLE_TITLE);
        expect(context.session.selectAudioTrack).toHaveBeenCalledWith(DEFAULT_AUDIO_TRACK_INDEX);
        expect(context.session.selectSubtitle).toHaveBeenCalledWith(null);

        context.store.setState({ tracks: { audioTrackIndex: DEFAULT_AUDIO_TRACK_INDEX, subtitle: null, videoTrackIndex: null } });
        audioDefaultButton.click();
        subtitleDefaultButton.click();

        expect(context.session.selectAudioTrack).toHaveBeenCalledOnce();
        expect(context.session.selectSubtitle).toHaveBeenCalledOnce();
        panel.destroy();
    });
});
