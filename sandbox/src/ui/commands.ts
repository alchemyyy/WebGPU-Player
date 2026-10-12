// How panels end the promises their commands return.

const COMMAND_REJECTED_CODE = 'command-rejected';

/**
 * Logs a rejected command; panels pass it to the command promise's catch.
 * A command records its failure in the state before it rejects, so this only keeps the rejection visible in the console.
 */
export function reportCommandRejection(error: unknown): void {
    console.error(COMMAND_REJECTED_CODE, error);
}
