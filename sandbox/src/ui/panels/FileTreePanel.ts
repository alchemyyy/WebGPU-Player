// The library panel: picks a folder, grants access to the remembered one again, and opens files from the folder's tree.
import type { LibraryDirectory, LibraryEntry, LibraryState, SandboxState } from '../../contracts/SandboxContracts';
import { listVisibleLibraryEntries, type VisibleLibraryEntry } from '../../library/LibraryTree';
import { reportCommandRejection } from '../commands';
import { createElement, replaceChildren } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';

import './FileTreePanel.css';

const SELECTED_ROW_CLASS = 'is-selected';
// Indents a row by its depth below the root
const DEPTH_PROPERTY = '--file-tree-depth';
// The title until the picked folder has a name
const UNNAMED_LIBRARY_TITLE = 'Library';

/** Returns the status line for a library state, or '' when the tree speaks for itself. */
function describeLibraryStatus(library: LibraryState): string {
    switch (library.status) {
        case 'empty':
            return 'Pick a folder of media';
        case 'permission-needed':
            return 'Grant access to the remembered folder';
        case 'scanning':
            return 'Scanning';
        case 'ready':
            return library.root?.children.length === 0 ? 'No playable files' : '';
    }
}

export function createFileTreePanel(context: PanelContext): Panel {
    const { library, session, store } = context;
    const expandedPaths = new Set<string>();
    let rowsByPath = new Map<string, HTMLButtonElement>();
    let selectedRow: HTMLButtonElement | null = null;
    let renderedRoot: LibraryDirectory | null = null;
    // Counts file clicks, so that an open which a newer click replaced never reaches the session
    let openRequest = 0;

    const titleElement = createElement('span', { className: 'file-tree-title' });
    const grantButton = createElement('button', { text: 'Grant access' });
    const pickButton = createElement('button', { text: 'Pick folder' });
    const statusElement = createElement('div', { className: 'file-tree-status' });
    const rowsElement = createElement('div', { className: 'file-tree-rows' });
    const element = createElement('section', { className: 'file-tree-panel' }, [
        createElement('header', { className: 'file-tree-header' }, [ titleElement, grantButton, pickButton ]),
        statusElement,
        rowsElement
    ]);

    const openFile = async (path: string): Promise<void> => {
        openRequest += 1;
        const request = openRequest;
        const media = await library.resolveMedia(path);
        if (request === openRequest) {
            await session.openMedia(media);
        }
    };

    const renderSelection = (selectedPath: string | null): void => {
        selectedRow?.classList.remove(SELECTED_ROW_CLASS);
        selectedRow?.removeAttribute('aria-current');
        selectedRow = selectedPath === null ? null : rowsByPath.get(selectedPath) ?? null;
        selectedRow?.classList.add(SELECTED_ROW_CLASS);
        selectedRow?.setAttribute('aria-current', 'true');
    };

    // Folder clicks render the rows again, through renderRows below
    const onEntryClick = (entry: LibraryEntry): void => {
        switch (entry.kind) {
            case 'directory':
                if (!expandedPaths.delete(entry.path)) {
                    expandedPaths.add(entry.path);
                }
                renderRows();
                return;
            case 'file':
                openFile(entry.path).catch(reportCommandRejection);
                return;
        }
    };

    const createRow = ({ depth, entry }: VisibleLibraryEntry): HTMLButtonElement => {
        const row = createElement(
            'button',
            { attributes: { title: entry.path }, className: 'file-tree-row' },
            [ createElement('span', { className: 'file-tree-name', text: entry.name }) ]
        );
        row.style.setProperty(DEPTH_PROPERTY, String(depth));
        switch (entry.kind) {
            case 'directory':
                row.setAttribute('aria-expanded', String(expandedPaths.has(entry.path)));
                break;
            case 'file':
                // How many subtitle files the library found beside the file
                if (entry.subtitlePaths.length > 0) {
                    row.append(createElement('span', { className: 'file-tree-badge', text: `+${entry.subtitlePaths.length} sub` }));
                }
                break;
        }
        row.addEventListener('click', (): void => {
            onEntryClick(entry);
        });
        return row;
    };

    const renderRows = (): void => {
        const { root, selectedPath } = store.getState().library;
        const visibleEntries = root === null ? [] : listVisibleLibraryEntries(root, expandedPaths);
        const rows: HTMLButtonElement[] = [];
        rowsByPath = new Map<string, HTMLButtonElement>();
        for (const visibleEntry of visibleEntries) {
            const row = createRow(visibleEntry);
            rows.push(row);
            rowsByPath.set(visibleEntry.entry.path, row);
        }
        replaceChildren(rowsElement, rows);
        selectedRow = null;
        renderSelection(selectedPath);
    };

    pickButton.addEventListener('click', (): void => {
        library.pickDirectory().catch(reportCommandRejection);
    });
    grantButton.addEventListener('click', (): void => {
        library.restore(true).catch(reportCommandRejection);
    });

    const unsubscribe = subscribeSelection(store, (state: SandboxState): LibraryState => state.library, (libraryState: LibraryState): void => {
        const rootName = libraryState.root?.name ?? '';
        titleElement.textContent = rootName === '' ? UNNAMED_LIBRARY_TITLE : rootName;
        grantButton.hidden = libraryState.status !== 'permission-needed';
        const status = describeLibraryStatus(libraryState);
        statusElement.textContent = status;
        statusElement.hidden = status === '';
        if (libraryState.root === renderedRoot) {
            renderSelection(libraryState.selectedPath);
            return;
        }
        renderedRoot = libraryState.root;
        renderRows();
    });

    return { destroy: unsubscribe, element };
}
