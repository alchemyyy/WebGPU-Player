// The File System Access members the library uses that TypeScript's DOM library lacks.
// They are module types rather than global augmentations, so the engine's sources, which share this TypeScript program, never see them.

export type FileSystemPermissionMode = 'read' | 'readwrite';

export type FileSystemHandlePermissionDescriptor = Readonly<{ mode: FileSystemPermissionMode }>;

/** A directory handle with the permission and iteration members of the File System Access API. */
export interface AccessibleDirectoryHandle extends FileSystemDirectoryHandle {
    queryPermission(descriptor: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    /** Its entries; the API types them as FileSystemHandle, which is always one of these two */
    values(): AsyncIterableIterator<AccessibleDirectoryHandle | FileSystemFileHandle>;
}

export type DirectoryPickerOptions = Readonly<{
    /** Reopens the picker in the folder the last pick with this id chose */
    id: string
    mode: FileSystemPermissionMode
}>;

/** The window, with the directory picker where the browser has one. */
export type DirectoryPickerWindow = Window & Readonly<{
    showDirectoryPicker?: (options: DirectoryPickerOptions) => Promise<AccessibleDirectoryHandle>
}>;
