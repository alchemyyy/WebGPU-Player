// The shape every overlay panel shares: it reads the store, sends commands, and owns one root element.
import type { SandboxLibraryCommands, SandboxSessionCommands, SandboxState } from '../contracts/SandboxContracts';
import type { Store } from './Store';

export type SandboxStore = Store<SandboxState>;

export type PanelContext = Readonly<{
    library: SandboxLibraryCommands
    session: SandboxSessionCommands
    store: SandboxStore
}>;

export type Panel = Readonly<{
    /** Unsubscribes from the store and releases listeners; the caller removes the element */
    destroy: () => void
    element: HTMLElement
}>;
