// The route override: forces the video decoder and the frame transport, sets where decoded audio plays, and shows the route the session plays.
import type { CustomAudioSpeakerLayout } from 'webgpu-player/audio/NativeMultichannelAudioOutput';
import {
    DEFAULT_AUDIO_OUTPUT_SETTINGS,
    DEFAULT_ROUTE_OVERRIDE,
    type ActiveRoute,
    type AudioOutputSettings,
    type DecoderOverride,
    type FrameTransportOverride,
    type RouteOverride,
    type SandboxState
} from '../../contracts/SandboxContracts';
import { reportCommandRejection } from '../commands';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { createChoiceSelect, listRecordChoices } from './ChoiceSelect';
import { createDefaultButton } from './DefaultButton';
import { joinTextParts } from './PanelText';

import './RouteOverridePanel.css';

// The record types make each list cover every override the contract declares
const DECODER_OVERRIDE_LABELS: Readonly<Record<DecoderOverride, string>> = {
    auto: 'Auto',
    gpu: 'GPU (package)',
    native: 'Native (WebCodecs)'
};
const TRANSPORT_OVERRIDE_LABELS: Readonly<Record<FrameTransportOverride, string>> = {
    auto: 'Auto',
    'raw-planes': 'Raw planes',
    'video-frame': 'VideoFrame'
};
/* eslint-disable @typescript-eslint/naming-convention -- speaker layouts take FFmpeg's names */
const SPEAKER_LAYOUT_LABELS: Readonly<Record<CustomAudioSpeakerLayout, string>> = {
    '5.1': '5.1',
    '5.1.2': '5.1.2',
    '5.1.4': '5.1.4',
    '7.1': '7.1',
    '7.1.2': '7.1.2',
    '7.1.4': '7.1.4',
    auto: 'Auto',
    stereo: 'Stereo'
};
/* eslint-enable @typescript-eslint/naming-convention */
type BinauralChoice = 'off' | 'on';
const BINAURAL_LABELS: Readonly<Record<BinauralChoice, string>> = {
    off: 'Off',
    on: 'On (headphones)'
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
        joinTextParts([ 'decoder', route.videoDecoderBackend, route.gpuVideoDecoder?.decoderId ?? null ]),
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
    // An override change restarts the media, so a default button sends only a change
    const decoderDefaultButton = createDefaultButton(DECODER_OVERRIDE_LABELS[DEFAULT_ROUTE_OVERRIDE.decoder], (): void => {
        const override = store.getState().route.override;
        if (override.decoder !== DEFAULT_ROUTE_OVERRIDE.decoder) {
            sendOverride({ ...override, decoder: DEFAULT_ROUTE_OVERRIDE.decoder });
        }
    });
    const transportDefaultButton = createDefaultButton(TRANSPORT_OVERRIDE_LABELS[DEFAULT_ROUTE_OVERRIDE.transport], (): void => {
        const override = store.getState().route.override;
        if (override.transport !== DEFAULT_ROUTE_OVERRIDE.transport) {
            sendOverride({ ...override, transport: DEFAULT_ROUTE_OVERRIDE.transport });
        }
    });
    const renderAudioOutput = (settings: AudioOutputSettings): void => {
        speakerLayoutSelect.setValue(settings.speakerLayout);
        binauralSelect.setValue(settings.binauralHeadphones ? 'on' : 'off');
    };
    const sendAudioOutput = (settings: AudioOutputSettings): void => {
        session.setAudioOutputSettings(settings).catch((error: unknown): void => {
            reportCommandRejection(error);
            renderAudioOutput(store.getState().audioOutput);
        });
    };
    const speakerLayoutSelect = createChoiceSelect<CustomAudioSpeakerLayout>((speakerLayout: CustomAudioSpeakerLayout): void => {
        sendAudioOutput({ ...store.getState().audioOutput, speakerLayout });
    });
    speakerLayoutSelect.setChoices(listRecordChoices(SPEAKER_LAYOUT_LABELS));
    const binauralSelect = createChoiceSelect<BinauralChoice>((choice: BinauralChoice): void => {
        sendAudioOutput({ ...store.getState().audioOutput, binauralHeadphones: choice === 'on' });
    });
    binauralSelect.setChoices(listRecordChoices(BINAURAL_LABELS));
    const speakerLayoutDefaultButton = createDefaultButton(SPEAKER_LAYOUT_LABELS[DEFAULT_AUDIO_OUTPUT_SETTINGS.speakerLayout], (): void => {
        const settings = store.getState().audioOutput;
        if (settings.speakerLayout !== DEFAULT_AUDIO_OUTPUT_SETTINGS.speakerLayout) {
            sendAudioOutput({ ...settings, speakerLayout: DEFAULT_AUDIO_OUTPUT_SETTINGS.speakerLayout });
        }
    });
    const activeRouteElement = createElement('div', { className: 'route-override-active' });

    const element = createElement('section', { className: 'route-override-panel' }, [
        createElement('header', { className: 'route-override-header', text: 'Route' }),
        createElement('label', { className: 'route-override-row' }, [ createElement('span', { text: 'Decoder' }), decoderSelect.element, decoderDefaultButton ]),
        createElement('label', { className: 'route-override-row' }, [ createElement('span', { text: 'Transport' }), transportSelect.element, transportDefaultButton ]),
        createElement('label', { className: 'route-override-row' }, [
            createElement('span', { text: 'Speakers' }),
            speakerLayoutSelect.element,
            speakerLayoutDefaultButton
        ]),
        createElement('label', { className: 'route-override-row' }, [ createElement('span', { text: 'Binaural' }), binauralSelect.element ]),
        activeRouteElement
    ]);

    const unsubscribers: (() => void)[] = [
        subscribeSelection(store, (state: SandboxState): RouteOverride => state.route.override, renderOverride),
        subscribeSelection(store, (state: SandboxState): AudioOutputSettings => state.audioOutput, renderAudioOutput),
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
