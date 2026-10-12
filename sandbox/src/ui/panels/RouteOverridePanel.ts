// The route override: forces the video decoder and the frame transport, and shows the route the session plays.
import type {
    ActiveRoute,
    DecoderOverride,
    FrameTransportOverride,
    RouteOverride,
    SandboxState
} from '../../contracts/SandboxContracts';
import { reportCommandRejection } from '../commands';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { createChoiceSelect, listRecordChoices } from './ChoiceSelect';
import { joinTextParts } from './PanelText';

import './RouteOverridePanel.css';

// The record types make each list cover every override the contract declares
const DECODER_OVERRIDE_LABELS: Readonly<Record<DecoderOverride, string>> = {
    auto: 'Auto',
    native: 'Native (WebCodecs)',
    software: 'Software (bundled)'
};
const TRANSPORT_OVERRIDE_LABELS: Readonly<Record<FrameTransportOverride, string>> = {
    auto: 'Auto',
    'raw-planes': 'Raw planes',
    'video-frame': 'VideoFrame'
};
const NO_ROUTE_TEXT = 'No active route';
const NONE_TEXT = 'none';
const NEUTRALIZED_METADATA_TEXT = 'metadata neutralized';
const LINE_SEPARATOR = '\n';

/** Describes the active route in terse lines: decoder, transport, audio, HDR handling, and the reason for the choice. */
export function describeActiveRoute(route: ActiveRoute | null): string {
    if (route === null) {
        return NO_ROUTE_TEXT;
    }
    return [
        joinTextParts([ 'decoder', route.videoDecoderBackend ]),
        joinTextParts([ 'transport', route.videoOutputMode, route.rawVideoFrameFormat ]),
        joinTextParts([ 'audio', route.audioOutputMode ?? NONE_TEXT ]),
        joinTextParts([ 'dolby vision', route.dolbyVisionProfile ?? NONE_TEXT ]),
        joinTextParts([ 'native hdr', route.nativeHDRTransfer ?? NONE_TEXT, route.neutralizeHDRColorMetadata ? NEUTRALIZED_METADATA_TEXT : null ]),
        route.selection
    ].join(LINE_SEPARATOR);
}

export function createRouteOverridePanel(context: PanelContext): Panel {
    const { session, store } = context;

    const renderOverride = (override: RouteOverride): void => {
        decoderSelect.setValue(override.decoder);
        transportSelect.setValue(override.transport);
    };

    const sendOverride = (override: RouteOverride): void => {
        session.setRouteOverride(override).catch((error: unknown): void => {
            reportCommandRejection(error);
            renderOverride(store.getState().route.override);
        });
    };

    const decoderSelect = createChoiceSelect<DecoderOverride>((decoder: DecoderOverride): void => {
        sendOverride({ ...store.getState().route.override, decoder });
    });
    decoderSelect.setChoices(listRecordChoices(DECODER_OVERRIDE_LABELS));
    const transportSelect = createChoiceSelect<FrameTransportOverride>((transport: FrameTransportOverride): void => {
        sendOverride({ ...store.getState().route.override, transport });
    });
    transportSelect.setChoices(listRecordChoices(TRANSPORT_OVERRIDE_LABELS));
    const activeRouteElement = createElement('div', { className: 'route-override-active' });

    const element = createElement('section', { className: 'route-override-panel' }, [
        createElement('header', { className: 'route-override-header', text: 'Route' }),
        createElement('label', { className: 'route-override-row' }, [ createElement('span', { text: 'Decoder' }), decoderSelect.element ]),
        createElement('label', { className: 'route-override-row' }, [ createElement('span', { text: 'Transport' }), transportSelect.element ]),
        activeRouteElement
    ]);

    const unsubscribers: (() => void)[] = [
        subscribeSelection(store, (state: SandboxState): RouteOverride => state.route.override, renderOverride),
        subscribeSelection(store, (state: SandboxState): ActiveRoute | null => state.route.active, (route: ActiveRoute | null): void => {
            activeRouteElement.textContent = describeActiveRoute(route);
        })
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
