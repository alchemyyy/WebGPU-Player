// Reads the `//!` header that starts every decoder package's manifest, video or audio: one `name: value` directive per line.

/** One `//!` directive of a decoder header. */
export type DecoderHeaderDirective = Readonly<{
    line: number
    name: string
    value: string
}>;

/** A header line that is no directive: the detail quotes it, at its 1-based line. */
export class DecoderHeaderError extends Error {
    readonly detail: string;
    readonly line: number;

    constructor(detail: string, line: number) {
        super(detail);
        this.name = 'DecoderHeaderError';
        this.detail = detail;
        this.line = line;
    }
}

/** Returns the name a decoder's `error:` directives give an error code, or `code <code>` for a code they do not name. */
export function getDecoderErrorName(errorNames: ReadonlyMap<number, string>, code: number): string {
    return errorNames.get(code) ?? `code ${code}`;
}

const HEADER_PREFIX = '//!';
const DIRECTIVE_PATTERN = /^\/\/!\s*([A-Za-z]+(?:-[A-Za-z]+)*)\s*:(.*)$/;
// The directive that names a decoder's kind
const DECODER_KIND_DIRECTIVE = 'decoder';

/**
 * Reads the leading `//!` lines of a decoder source; a blank `//!` line is allowed and skipped.
 * Returns the directives in order and the 1-based line where the body starts; throws a DecoderHeaderError for a line that is no directive.
 */
export function readDecoderHeader(lines: readonly string[]): { bodyFirstLine: number; directives: DecoderHeaderDirective[] } {
    const directives: DecoderHeaderDirective[] = [];
    let lineIndex = 0;
    for (; lineIndex < lines.length && lines[lineIndex].trimStart().startsWith(HEADER_PREFIX); lineIndex += 1) {
        const text = lines[lineIndex].trim();
        if (text === HEADER_PREFIX) {
            continue;
        }
        const match = DIRECTIVE_PATTERN.exec(text);
        const line = lineIndex + 1;
        if (!match) {
            throw new DecoderHeaderError(`'${text}'`, line);
        }
        directives.push({ line, name: match[1], value: match[2].trim() });
    }
    return { bodyFirstLine: lineIndex + 1, directives };
}

/** Returns the kind a decoder source's header names, such as video or audio, or null when it names none or is malformed. */
export function readDecoderKind(source: string): string | null {
    try {
        const { directives } = readDecoderHeader(source.split(/\r?\n/));
        return directives.find((directive: DecoderHeaderDirective): boolean => directive.name === DECODER_KIND_DIRECTIVE)?.value ?? null;
    } catch (error) {
        if (error instanceof DecoderHeaderError) {
            return null;
        }
        throw error;
    }
}
