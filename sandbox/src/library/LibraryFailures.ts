// The library's failure codes, and how an error becomes a terse failure detail.

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

/** Returns an error's terse detail: a DOMException's name, such as NotFoundError, or else its message. */
export function describeError(error: unknown): string {
    if (error instanceof DOMException) {
        return error.name;
    }
    if (error instanceof Error) {
        return error.message === '' ? error.name : error.message;
    }
    return String(error);
}
