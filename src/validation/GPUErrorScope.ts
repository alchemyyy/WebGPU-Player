import { VALIDATION_ERROR_FILTER } from '../presentation/WebGPUConstants';

/** What synchronous GPU calls returned, and the validation error they raised, or null when they raised none. */
export type CapturedValidation<Value> = {
    validationError: Promise<GPUError | null>
    value: Value
};

/** Pops an error scope without reading it, for cleanup after an authorization step that left the scope pushed. */
export function discardErrorScope(device: GPUDevice): void {
    // popErrorScope can throw synchronously after device loss
    // eslint-disable-next-line sonarjs/no-try-promise
    try {
        void device.popErrorScope().catch((): void => undefined);
    } catch {
        // Device loss can synchronously invalidate the scope stack
    }
}

/**
 * Runs synchronous GPU calls, such as an encode and its submit, in a validation scope of their own, and pops it before returning.
 * Every authorization started with a device shares its one scope stack, so a scope held across an await could be popped by
 * another authorization, each then reading the other's errors; the caller awaits `validationError` after its completion instead.
 */
export function captureValidationErrors<Value>(device: GPUDevice, calls: () => Value): CapturedValidation<Value> {
    device.pushErrorScope(VALIDATION_ERROR_FILTER);
    let value: Value;
    try {
        value = calls();
    } catch (error) {
        discardErrorScope(device);
        throw error;
    }
    const validationError = device.popErrorScope();
    // A caller that fails at a later await never reads the scope, and device loss can reject it
    void validationError.catch((): void => undefined);
    return { validationError, value };
}
