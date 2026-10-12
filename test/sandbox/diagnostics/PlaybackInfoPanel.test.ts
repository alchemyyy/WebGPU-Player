import { describe, expect, it } from 'vitest';

import type { SandboxFailure } from '../../../sandbox/src/contracts/SandboxContracts';
import { describePlaybackInfo, type InfoSection } from '../../../sandbox/src/ui/diagnostics/PlaybackInfoSections';
import type { PanelContext } from '../../../sandbox/src/ui/Panel';
import { createPlaybackInfoPanel } from '../../../sandbox/src/ui/panels/PlaybackInfoPanel';
import { createFakePanelContext } from '../shell/sandboxFakes';
import { createMediaDescription, createVideoTrack } from './telemetryTestState';

const MEDIA_PATH = 'films/Example.mkv';
const RENAMED_MEDIA_PATH = 'films/Other.mkv';
const FIRST_FAILURE: SandboxFailure = { code: 'scan-failed', detail: 'NotReadableError', layer: 'library', timeMilliseconds: 1_200 };
const SECOND_FAILURE: SandboxFailure = { code: 'frame-render-failed', detail: 'device lost', layer: 'presenter', timeMilliseconds: 2_400 };

const SECTION_SELECTOR = '.playback-info-section';
const TITLE_SELECTOR = '.playback-info-title';
const ROW_SELECTOR = '.playback-info-row';
const LABEL_SELECTOR = '.playback-info-label';
const VALUE_SELECTOR = '.playback-info-value';
const MEDIA_SECTION_INDEX = 0;
const FILE_ROW_INDEX = 0;
const CONTAINER_ROW_INDEX = 1;

function openMedia(context: PanelContext, path: string): void {
    context.store.setState({ media: createMediaDescription({ path, videoTracks: [ createVideoTrack() ] }) });
}

function getSections(element: HTMLElement): HTMLDetailsElement[] {
    return [ ...element.querySelectorAll<HTMLDetailsElement>(SECTION_SELECTOR) ];
}

function getRowTexts(section: HTMLElement): string[][] {
    return [ ...section.querySelectorAll<HTMLElement>(ROW_SELECTOR) ].map((row: HTMLElement): string[] => [
        row.querySelector(LABEL_SELECTOR)?.textContent ?? '',
        row.querySelector(VALUE_SELECTOR)?.textContent ?? ''
    ]);
}

describe('createPlaybackInfoPanel', () => {
    it('stays empty while it has nothing to describe, so the layout hides it', () => {
        const panel = createPlaybackInfoPanel(createFakePanelContext());

        expect(panel.element.childNodes).toHaveLength(0);
        panel.destroy();
    });

    it('shows an open section per description, with its rows toned by what they say', () => {
        const context = createFakePanelContext();
        const panel = createPlaybackInfoPanel(context);

        openMedia(context, MEDIA_PATH);
        context.store.setState({ failures: [ FIRST_FAILURE ] });
        const expectedSections = describePlaybackInfo(context.store.getState());
        const sections = getSections(panel.element);

        expect(sections.map((section: HTMLDetailsElement): string | null => section.querySelector(TITLE_SELECTOR)?.textContent ?? null))
            .toEqual(expectedSections.map((section: InfoSection): string => section.title));
        for (const [ index, section ] of expectedSections.entries()) {
            expect(sections[index].open).toBe(true);
            expect(getRowTexts(sections[index])).toEqual(section.rows.map((row): string[] => [ row.label, row.value ]));
        }
        const failureRow = sections[sections.length - 1].querySelector<HTMLElement>(ROW_SELECTOR);
        expect(failureRow?.dataset.tone).toBe('failure');
        panel.destroy();
    });

    it('updates rows in place, keeping each section, its open state, and the text that did not change', () => {
        const context = createFakePanelContext();
        const panel = createPlaybackInfoPanel(context);

        openMedia(context, MEDIA_PATH);
        const mediaSection = getSections(panel.element)[MEDIA_SECTION_INDEX];
        mediaSection.open = false;
        const containerValue = mediaSection.querySelectorAll(VALUE_SELECTOR)[CONTAINER_ROW_INDEX].firstChild;
        openMedia(context, RENAMED_MEDIA_PATH);

        expect(getSections(panel.element)[MEDIA_SECTION_INDEX]).toBe(mediaSection);
        expect(mediaSection.open).toBe(false);
        expect(getRowTexts(mediaSection)[FILE_ROW_INDEX]).toEqual([ 'File', RENAMED_MEDIA_PATH ]);
        expect(mediaSection.querySelectorAll(VALUE_SELECTOR)[CONTAINER_ROW_INDEX].firstChild).toBe(containerValue);
        panel.destroy();
    });

    it('drops the sections that no longer apply and grows and shrinks a section\'s rows', () => {
        const context = createFakePanelContext();
        const panel = createPlaybackInfoPanel(context);

        openMedia(context, MEDIA_PATH);
        context.store.setState({ failures: [ FIRST_FAILURE ] });
        context.store.setState({ media: null });

        expect(getSections(panel.element)).toHaveLength(1);
        context.store.setState({ failures: [ FIRST_FAILURE, SECOND_FAILURE ] });

        expect(getRowTexts(getSections(panel.element)[0])).toHaveLength(2);
        context.store.setState({ failures: [] });

        expect(panel.element.childNodes).toHaveLength(0);
        panel.destroy();
    });

    it('stops following the store once destroyed', () => {
        const context = createFakePanelContext();
        const panel = createPlaybackInfoPanel(context);

        panel.destroy();
        openMedia(context, MEDIA_PATH);

        expect(getSections(panel.element)).toHaveLength(0);
    });
});
