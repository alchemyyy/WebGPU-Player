// The panel that shows detailed playback info: media, route, clock, and presentation telemetry.
import type { SandboxState } from '../../contracts/SandboxContracts';
import {
    describePlaybackInfo,
    type InfoRow,
    type InfoSection,
    type PlaybackInfoState
} from '../diagnostics/PlaybackInfoSections';
import { createTupleSelector } from '../diagnostics/TupleSelector';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';

import './PlaybackInfoPanel.css';

type PlaybackInfoSlices = readonly [
    failures: PlaybackInfoState['failures'],
    media: PlaybackInfoState['media'],
    playback: PlaybackInfoState['playback'],
    presentation: PlaybackInfoState['presentation'],
    route: PlaybackInfoState['route'],
    telemetry: PlaybackInfoState['telemetry'],
    tracks: PlaybackInfoState['tracks']
];

type RowView = Readonly<{
    element: HTMLElement
    label: HTMLElement
    value: HTMLElement
}>;

/** One section's elements, kept across refreshes so its open state and any selected text survive them. */
type SectionView = {
    readonly element: HTMLDetailsElement
    readonly rowList: HTMLElement
    readonly rows: RowView[]
    readonly summary: HTMLElement
};

export function createPlaybackInfoPanel(context: PanelContext): Panel {
    const element = createElement('section', { className: 'playback-info-panel' });
    let sectionViews = new Map<string, SectionView>();
    const destroy = subscribeSelection(
        context.store,
        createTupleSelector((state: SandboxState): PlaybackInfoSlices => [
            state.failures,
            state.media,
            state.playback,
            state.presentation,
            state.route,
            state.telemetry,
            state.tracks
        ]),
        ([ failures, media, playback, presentation, route, telemetry, tracks ]: PlaybackInfoSlices): void => {
            const sections = describePlaybackInfo({ failures, media, playback, presentation, route, telemetry, tracks });
            sectionViews = renderSections(element, sectionViews, sections);
        }
    );
    return { destroy, element };
}

/**
 * Brings the panel to the sections' order, reusing each section's elements by its id.
 * Stale sections go first, so sections that stay are moved only when the order changed.
 */
function renderSections(
    container: HTMLElement,
    previousViews: ReadonlyMap<string, SectionView>,
    sections: readonly InfoSection[]
): Map<string, SectionView> {
    const views = new Map<string, SectionView>();
    const placements: (readonly [InfoSection, SectionView])[] = [];
    for (const section of sections) {
        const view = previousViews.get(section.id) ?? createSectionView();
        views.set(section.id, view);
        placements.push([ section, view ]);
    }
    for (const [ sectionId, view ] of previousViews) {
        if (!views.has(sectionId)) {
            container.removeChild(view.element);
        }
    }
    for (const [ index, [ section, view ] ] of placements.entries()) {
        updateSectionView(view, section);
        const currentChild = container.children.item(index);
        if (currentChild !== view.element) {
            container.insertBefore(view.element, currentChild);
        }
    }
    return views;
}

function createSectionView(): SectionView {
    const summary = createElement('summary', { className: 'playback-info-title' });
    const rowList = createElement('dl', { className: 'playback-info-rows' });
    const element = createElement('details', { className: 'playback-info-section' }, [ summary, rowList ]);
    element.open = true;
    return { element, rowList, rows: [], summary };
}

/** Updates a section's rows by position, changing only the text that changed. */
function updateSectionView(view: SectionView, section: InfoSection): void {
    setText(view.summary, section.title);
    for (const [ index, row ] of section.rows.entries()) {
        let rowView = view.rows.at(index);
        if (rowView === undefined) {
            rowView = createRowView();
            view.rows.push(rowView);
            view.rowList.appendChild(rowView.element);
        }
        updateRowView(rowView, row);
    }
    while (view.rows.length > section.rows.length) {
        const surplusRow = view.rows.pop();
        if (surplusRow) {
            view.rowList.removeChild(surplusRow.element);
        }
    }
}

function createRowView(): RowView {
    const label = createElement('dt', { className: 'playback-info-label' });
    const value = createElement('dd', { className: 'playback-info-value' });
    const element = createElement('div', { className: 'playback-info-row' }, [ label, value ]);
    return { element, label, value };
}

function updateRowView(view: RowView, row: InfoRow): void {
    setText(view.label, row.label);
    setText(view.value, row.value);
    if (view.element.dataset.tone !== row.tone) {
        view.element.dataset.tone = row.tone;
    }
}

function setText(element: HTMLElement, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}
