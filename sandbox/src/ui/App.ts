// The overlay layout: it mounts every panel into its region above the full-window player surface.
import { reportCommandRejection } from './commands';
import { bindControlWheel } from './ControlWheel';
import { carriesFiles, createElement } from './dom';
import { isOverlayToggle } from './OverlayToggle';
import type { Panel, PanelContext } from './Panel';
import { createDecoderPackagePanel } from './panels/DecoderPackagePanel';
import { createFileTreePanel } from './panels/FileTreePanel';
import { createPipelineGraphPanel } from './panels/PipelineGraphPanel';
import { createPlaybackInfoPanel } from './panels/PlaybackInfoPanel';
import { createRouteOverridePanel } from './panels/RouteOverridePanel';
import { createShaderPanel } from './panels/ShaderPanel';
import { createSubtitleOverlay } from './panels/SubtitleOverlay';
import { createToneMappingPanel } from './panels/ToneMappingPanel';
import { createTrackSelectorPanel } from './panels/TrackSelectorPanel';
import { createTransportBarPanel } from './panels/TransportBarPanel';
import { getSurfaceClickAction } from './SurfaceClick';

import './App.css';

export type SandboxAppContext = PanelContext & Readonly<{
    overlay: HTMLElement
    /** The full-window element the video fills */
    surface: HTMLElement
}>;

type PanelFactory = (context: PanelContext) => Panel;

/** The layout's regions; App.css places each in its grid area. */
type RegionName = 'controls' | 'graph' | 'info' | 'library' | 'transport';

// Each region's panels, in order: top to bottom in the side columns, left to right in the bottom row
const REGION_PANELS: Readonly<Record<RegionName, readonly PanelFactory[]>> = {
    library: [ createFileTreePanel ],
    info: [ createPlaybackInfoPanel ],
    graph: [ createPipelineGraphPanel ],
    controls: [ createToneMappingPanel, createRouteOverridePanel, createDecoderPackagePanel, createShaderPanel ],
    transport: [ createTransportBarPanel, createTrackSelectorPanel ]
};
// Hides every region; the subtitle slot stays, since cues belong to the video
const PANELS_HIDDEN_CLASS = 'sandbox-panels-hidden';

/** Keeps files dropped outside a drop target from navigating away from the sandbox, since the browser would open them in place of the page. */
function guardWindowFileDrops(): void {
    for (const type of [ 'dragover', 'drop' ]) {
        window.addEventListener(type, (event: Event): void => {
            if (event instanceof DragEvent && carriesFiles(event)) {
                event.preventDefault();
            }
        });
    }
}

/** Mounts the layout and every panel into the overlay, for the page's lifetime. */
export function mountSandboxApp(context: SandboxAppContext): void {
    const panelContext: PanelContext = { library: context.library, session: context.session, store: context.store };
    const layout = createElement('div', { className: 'sandbox-layout' });
    for (const [ regionName, panelFactories ] of Object.entries(REGION_PANELS)) {
        const panelElements = panelFactories.map((createPanel: PanelFactory): HTMLElement => createPanel(panelContext).element);
        layout.append(createElement('div', { className: `sandbox-region sandbox-region-${regionName}` }, panelElements));
    }
    layout.append(createElement('div', { className: 'sandbox-subtitle-slot' }, [ createSubtitleOverlay(panelContext).element ]));
    context.overlay.append(layout);
    bindControlWheel(layout);
    guardWindowFileDrops();
    window.addEventListener('keydown', (event: KeyboardEvent): void => {
        if (isOverlayToggle(event)) {
            layout.classList.toggle(PANELS_HIDDEN_CLASS);
        }
    });
    // The overlay, the canvas, and the hidden video let clicks through, so a click on the video outside the panels lands on the surface
    context.surface.addEventListener('click', (): void => {
        switch (getSurfaceClickAction(context.store.getState().playback.status)) {
            case 'pause':
                context.session.pause();
                break;
            case 'resume':
                context.session.play().catch(reportCommandRejection);
                break;
            case null:
                break;
        }
    });
}
