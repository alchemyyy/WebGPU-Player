const UNHANDLED_REJECTION_EVENT = 'unhandledrejection';

const handledDecodeFailures = new WeakSet<object>();

/**
 * Remembers a failure the worker caught, so the duplicate rejection Mediabunny leaves behind is not reported as unhandled.
 * After a custom decoder rejects, Mediabunny 1.52.2 queues the decoder's close() behind the failed call without a handler, and that call rejects again with the same error.
 */
export function markHandledDecodeFailure(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
        handledDecodeFailures.add(error);
    }
}

/**
 * Keeps the scope from reporting an unhandled rejection whose reason the worker already caught.
 * Such a rejection is a close() that Mediabunny skipped, so `onSuppressed` learns that a failed decoder stays open.
 */
export function suppressHandledDecodeFailureRejections(
    scope: Pick<EventTarget, 'addEventListener'>,
    onSuppressed: () => void = (): void => undefined
): void {
    scope.addEventListener(UNHANDLED_REJECTION_EVENT, (event: Event): void => {
        const reason: unknown = (event as PromiseRejectionEvent).reason;
        if (typeof reason === 'object' && reason !== null && handledDecodeFailures.has(reason)) {
            event.preventDefault();
            onSuppressed();
        }
    });
}
