// The folder pickers: the File System Access directory picker where the browser has one, or else a folder file input, as in Firefox.
import type { AccessibleDirectoryHandle, DirectoryPickerWindow } from './FileSystemAccess';

/** What a pick produced: a directory handle, which persists across reloads, the files a folder input chose, or nothing. */
export type FolderPick =
    | Readonly<{ handle: AccessibleDirectoryHandle; kind: 'directory-handle' }>
    | Readonly<{ files: readonly File[]; kind: 'folder-files' }>
    | Readonly<{ kind: 'cancelled' }>
    | Readonly<{ kind: 'unsupported' }>;

const DIRECTORY_PICKER_ID = 'webgpu-player-sandbox-library';
// The directory picker rejects with this name when the user dismisses it
const PICKER_DISMISSED_ERROR_NAME = 'AbortError';
const FILE_INPUT_TYPE = 'file';

/** Returns whether the browser has the directory picker, the only picker whose folders can be restored after a reload. */
export function hasDirectoryPicker(): boolean {
    const pickerWindow: DirectoryPickerWindow = window;
    return pickerWindow.showDirectoryPicker !== undefined;
}

/** Opens a folder file input; resolves with its files, or cancelled when the user dismisses it. */
function pickFolderFiles(): Promise<FolderPick> {
    return new Promise<FolderPick>((resolve: (pick: FolderPick) => void): void => {
        const input = document.createElement('input');
        input.type = FILE_INPUT_TYPE;
        input.webkitdirectory = true;
        input.addEventListener('change', (): void => {
            resolve({ files: Array.from(input.files ?? []), kind: 'folder-files' });
        }, { once: true });
        input.addEventListener('cancel', (): void => {
            resolve({ kind: 'cancelled' });
        }, { once: true });
        input.click();
    });
}

/**
 * Opens the directory picker, or a folder file input where the browser has no directory picker.
 * Both need the activation of a user gesture, so call it from the gesture before any await.
 * It rejects only when the picker fails; a dismissed picker resolves as cancelled.
 */
export async function pickFolder(): Promise<FolderPick> {
    const pickerWindow: DirectoryPickerWindow = window;
    if (pickerWindow.showDirectoryPicker !== undefined) {
        try {
            const handle = await pickerWindow.showDirectoryPicker({ id: DIRECTORY_PICKER_ID, mode: 'read' });
            return { handle, kind: 'directory-handle' };
        } catch (error) {
            if (error instanceof DOMException && error.name === PICKER_DISMISSED_ERROR_NAME) {
                return { kind: 'cancelled' };
            }
            throw error;
        }
    }
    if ('webkitdirectory' in HTMLInputElement.prototype) {
        return pickFolderFiles();
    }
    return { kind: 'unsupported' };
}
