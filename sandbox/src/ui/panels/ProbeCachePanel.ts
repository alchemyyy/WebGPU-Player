// The capability probe store: the stored verdicts' fingerprint and age, the latest start's probe wait, and buttons that clear the store and warm the probes.
import {
    clearStoredCapabilityProbeVerdicts,
    readStoredCapabilityProbeVerdictState,
    type CapabilityProbeStoreState
} from 'webgpu-player/capability/CapabilityProbeStore';
import { warmCustomDecodeCapabilities } from 'webgpu-player/capability/CustomDecodeCapabilities';

import type { SandboxState } from '../../contracts/SandboxContracts';
import { createElement } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { joinTextParts } from './PanelText';

import './ProbeCachePanel.css';

const NOTHING_STORED_TEXT = 'Nothing stored';
const NO_NEGOTIATION_TEXT = 'No start yet';
const NO_ADAPTER_TEXT = 'no adapter';
const WARM_UP_SKIPPED_TEXT = 'Warm-up skipped: constrained client';
const LINE_SEPARATOR = '\n';
// The age only needs to follow the clock to the second
const AGE_REFRESH_MILLISECONDS = 1_000;
const MILLISECONDS_PER_SECOND = 1_000;

type BrandVersion = Readonly<{ brand?: unknown, version?: unknown }>;

/** Names the browser the verdicts were measured on by its full version, else its user agent. */
function describeBrowser(state: CapabilityProbeStoreState): string {
    const fullVersionList = state.fingerprint.userAgentData?.fullVersionList;
    if (Array.isArray(fullVersionList)) {
        const brands = (fullVersionList as readonly BrandVersion[])
            .filter((entry: BrandVersion): boolean => typeof entry.brand === 'string' && !entry.brand.includes('Not'))
            .map((entry: BrandVersion): string => `${String(entry.brand)} ${String(entry.version)}`);
        const platformVersion = state.fingerprint.userAgentData?.platformVersion;
        return joinTextParts([ brands.join(', '), typeof platformVersion === 'string' ? `platform ${platformVersion}` : null ]);
    }
    return state.fingerprint.userAgent;
}

/** Describes the stored verdicts in terse lines: their count and age, the build key, the adapter, and the browser. */
export function describeStoredProbeVerdicts(state: CapabilityProbeStoreState | null): string {
    if (state === null) {
        return NOTHING_STORED_TEXT;
    }
    const adapterInfo = state.fingerprint.adapter?.info;
    return [
        joinTextParts([ `${state.probes.length} verdicts`, `${Math.round(state.ageMilliseconds / MILLISECONDS_PER_SECOND)} s old` ], ', '),
        joinTextParts([ 'build', state.fingerprint.buildKey ]),
        joinTextParts([
            'adapter',
            adapterInfo ? joinTextParts([ String(adapterInfo.vendor ?? ''), String(adapterInfo.architecture ?? '') ]) : NO_ADAPTER_TEXT
        ]),
        describeBrowser(state)
    ].join(LINE_SEPARATOR);
}

/** Describes how long the latest start waited for its probes. */
export function describeNegotiation(negotiationMilliseconds: number | null): string {
    return negotiationMilliseconds === null ? NO_NEGOTIATION_TEXT : `Latest start waited ${negotiationMilliseconds.toFixed(1)} ms for its probes`;
}

export function createProbeCachePanel(context: PanelContext): Panel {
    const { store } = context;
    const storedElement = createElement('div', { className: 'probe-cache-text' });
    const negotiationElement = createElement('div', { className: 'probe-cache-text' });
    const renderStored = (): void => {
        storedElement.textContent = describeStoredProbeVerdicts(readStoredCapabilityProbeVerdictState());
    };
    const clearButton = createElement('button', { attributes: { type: 'button' }, text: 'Clear probe cache' });
    clearButton.addEventListener('click', (): void => {
        clearStoredCapabilityProbeVerdicts();
        renderStored();
    });
    const warmUpButton = createElement('button', { attributes: { type: 'button' }, text: 'Warm up probes' });
    warmUpButton.addEventListener('click', (): void => {
        if (!warmCustomDecodeCapabilities()) {
            negotiationElement.textContent = WARM_UP_SKIPPED_TEXT;
        }
        warmUpButton.disabled = true;
    });

    const element = createElement('section', { className: 'probe-cache-panel' }, [
        createElement('header', { className: 'probe-cache-header', text: 'Capability probes' }),
        storedElement,
        negotiationElement,
        createElement('div', { className: 'probe-cache-buttons' }, [ clearButton, warmUpButton ])
    ]);
    renderStored();
    const refreshTimer = globalThis.setInterval(renderStored, AGE_REFRESH_MILLISECONDS);
    const unsubscribe = subscribeSelection(
        store,
        (state: SandboxState): number | null => state.capabilityProbes.negotiationMilliseconds,
        (negotiationMilliseconds: number | null): void => {
            negotiationElement.textContent = describeNegotiation(negotiationMilliseconds);
            renderStored();
        }
    );

    return {
        destroy: (): void => {
            globalThis.clearInterval(refreshTimer);
            unsubscribe();
        },
        element
    };
}
