// The library's failure codes.

export type LibraryFailureCode =
    | 'directory-picker-failed'
    | 'directory-picker-unsupported'
    | 'directory-unreadable'
    | 'file-unreadable'
    | 'media-not-found'
    | 'media-unreadable'
    | 'permission-denied'
    | 'permission-request-failed'
    | 'remembered-directory-unreadable'
    | 'remembered-directory-unsaved'
    | 'subtitle-unreadable';

/** Records a library failure in the state. */
export type LibraryFailureReporter = (code: LibraryFailureCode, detail: string) => void;
