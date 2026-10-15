// The panel of the user's decoder packages, which playbacks prefer in the order added, each with its codecs, formats, version, and vector checks on this device.
// A row stands for a package id, so a rebuilt package added again replaces its row's version and drops the old version's checks.
import { DECODER_PACKAGE_FILE_EXTENSION } from 'webgpu-player/decode/packages/DecoderPackage';

import type {
    SandboxDecoderPackage,
    SandboxDecoderVerification,
    SandboxSessionCommands,
    SandboxState
} from '../../contracts/SandboxContracts';
import { fetchBuiltDecoderPackages } from '../../session/BuiltDecoderPackages';
import { reportCommandRejection } from '../commands';
import { createElement, reconcileKeyedChildren, replaceChildren, setTextContent } from '../dom';
import { listenForDroppedFiles } from '../FileDrop';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';

import './DecoderPackagePanel.css';

const DRAG_ACTIVE_CLASS = 'decoder-panel-drag-active';
const TITLE_TEXT = 'Decoder packages';
const OPEN_FILES_TEXT = 'Open packages...';
const LOAD_BUILT_TEXT = 'Load built packages';
const VERIFY_TEXT = 'Verify';
const REMOVE_TEXT = 'Remove';
const FILE_TEXT = 'from';
const VERSION_TEXT = 'version';
// The leading hexadecimal digits of a content hash the summary shows; the name's tooltip holds the whole hash
const VERSION_DIGIT_COUNT = 12;
const DROP_HINT_TEXT = 'Drop .wasm decoder packages here; the next start of the media decodes with them where WebCodecs cannot. A package of an id already listed replaces it';
const NO_VECTOR_TEXT = 'no self-test vectors';
const NOT_VERIFIED_TEXT = 'vectors not checked on this device';
const LIST_SEPARATOR = ', ';
const PASSED_CODE = 'passed';
const UNVERIFIED_CODE = 'unverified';

type PackageRowView = Readonly<{
    element: HTMLLIElement
    name: HTMLElement
    summary: HTMLElement
    verifications: HTMLElement
    verify: HTMLButtonElement
}>;

function describeSummary(decoderPackage: SandboxDecoderPackage): string {
    const parts = [ `${decoderPackage.kind}: ${decoderPackage.codecs.join(LIST_SEPARATOR)}` ];
    if (decoderPackage.outputFormats.length > 0) {
        parts.push(`writes ${decoderPackage.outputFormats.join(LIST_SEPARATOR)}`);
    }
    parts.push(`${FILE_TEXT} ${decoderPackage.fileName}`);
    parts.push(`${VERSION_TEXT} ${decoderPackage.contentHash.slice(0, VERSION_DIGIT_COUNT)}`);
    return parts.join('; ');
}

/** Returns the name's tooltip: the package's id and its whole content hash. */
function describeIdentity(decoderPackage: SandboxDecoderPackage): string {
    return `${decoderPackage.id} ${decoderPackage.contentHash}`;
}

function getVerificationTone(code: string): string {
    switch (code) {
        case PASSED_CODE:
            return 'success';
        case UNVERIFIED_CODE:
            return 'warning';
        default:
            return 'failure';
    }
}

function createVerificationLines(decoderPackage: SandboxDecoderPackage): HTMLElement[] {
    if (decoderPackage.kind === 'audio') {
        return [];
    }
    if (decoderPackage.vectorFormats.length === 0) {
        return [ createElement('div', { attributes: { 'data-tone': 'warning' }, className: 'decoder-package-state', text: NO_VECTOR_TEXT }) ];
    }
    if (decoderPackage.verifications.length === 0) {
        return [ createElement('div', { attributes: { 'data-tone': 'muted' }, className: 'decoder-package-state', text: NOT_VERIFIED_TEXT }) ];
    }
    return decoderPackage.verifications.map((verification: SandboxDecoderVerification): HTMLElement => createElement('div', {
        attributes: { 'data-tone': getVerificationTone(verification.code), title: verification.detail },
        className: 'decoder-package-state',
        text: `${verification.format}: ${verification.code}`
    }));
}

function createButton(text: string, onClick: () => void): HTMLButtonElement {
    const button = createElement('button', { attributes: { type: 'button' }, text });
    button.addEventListener('click', onClick);
    return button;
}

function createRowView(decoderPackage: SandboxDecoderPackage, session: SandboxSessionCommands): PackageRowView {
    const summary = createElement('div', { className: 'decoder-package-summary' });
    const verifications = createElement('div', { className: 'decoder-package-states' });
    const verify = createButton(VERIFY_TEXT, (): void => {
        session.verifyDecoderPackage(decoderPackage.id).catch(reportCommandRejection);
    });
    const remove = createButton(REMOVE_TEXT, (): void => {
        session.removeDecoderPackage(decoderPackage.id).catch(reportCommandRejection);
    });
    const name = createElement('span', { className: 'decoder-package-name' });
    const element = createElement('li', { className: 'decoder-package' }, [
        createElement('div', { className: 'decoder-package-header' }, [
            name,
            createElement('div', { className: 'decoder-package-actions' }, [ verify, remove ])
        ]),
        summary,
        verifications
    ]);
    return { element, name, summary, verifications, verify };
}

function updateRowView(view: PackageRowView, decoderPackage: SandboxDecoderPackage): void {
    // A new version of the row's id may bring another name
    setTextContent(view.name, decoderPackage.name);
    view.name.title = describeIdentity(decoderPackage);
    setTextContent(view.summary, describeSummary(decoderPackage));
    replaceChildren(view.verifications, createVerificationLines(decoderPackage));
    view.verify.hidden = decoderPackage.kind !== 'video' || decoderPackage.vectorFormats.length === 0;
}

function createHeader(session: SandboxSessionCommands): HTMLElement {
    const fileInput = createElement('input', {
        attributes: { accept: DECODER_PACKAGE_FILE_EXTENSION, multiple: '', type: 'file' },
        className: 'decoder-panel-file-input'
    });
    fileInput.hidden = true;
    fileInput.addEventListener('change', (): void => {
        const files = Array.from(fileInput.files ?? []);
        // Clearing the input lets the same files be chosen again
        fileInput.value = '';
        if (files.length > 0) {
            session.addDecoderPackages(files).catch(reportCommandRejection);
        }
    });
    return createElement('div', { className: 'decoder-panel-header' }, [
        createElement('h3', { className: 'decoder-panel-title', text: TITLE_TEXT }),
        createButton(OPEN_FILES_TEXT, (): void => {
            fileInput.click();
        }),
        // Every package the engine's decoder build wrote, each replacing a stored package of its id
        createButton(LOAD_BUILT_TEXT, (): void => {
            fetchBuiltDecoderPackages()
                .then((files: File[]): Promise<void> => session.addDecoderPackages(files))
                .catch(reportCommandRejection);
        }),
        fileInput
    ]);
}

export function createDecoderPackagePanel(context: PanelContext): Panel {
    const session = context.session;
    const packageList = createElement('ol', { className: 'decoder-package-list' });
    const element = createElement('section', { className: 'decoder-panel' }, [
        createHeader(session),
        packageList,
        createElement('p', { className: 'decoder-panel-hint', text: DROP_HINT_TEXT })
    ]);
    // The session reports each dropped file that is no package or that the engine refuses
    listenForDroppedFiles(element, DRAG_ACTIVE_CLASS, (files: File[]): void => {
        session.addDecoderPackages(files).catch(reportCommandRejection);
    });
    let rowViews = new Map<string, PackageRowView>();
    const destroy = subscribeSelection(
        context.store,
        (state: SandboxState): readonly SandboxDecoderPackage[] => state.decoders.packages,
        (packages: readonly SandboxDecoderPackage[]): void => {
            rowViews = reconcileKeyedChildren(packageList, rowViews, packages, {
                createView: (decoderPackage: SandboxDecoderPackage): PackageRowView => createRowView(decoderPackage, session),
                getElement: (view: PackageRowView): Element => view.element,
                getKey: (decoderPackage: SandboxDecoderPackage): string => decoderPackage.id,
                updateView: (view: PackageRowView, decoderPackage: SandboxDecoderPackage): void => {
                    updateRowView(view, decoderPackage);
                }
            });
        }
    );
    return { destroy, element };
}
