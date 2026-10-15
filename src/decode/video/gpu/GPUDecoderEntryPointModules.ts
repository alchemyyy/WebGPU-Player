// Splits a GPU decoder's module, its prelude and body, into one module per entry point that holds only the declarations the entry point reaches.
// A pipeline processes its whole module, so each entry point compiling its own declarations cuts session start, most for large decoders.
// Every kept character stays at its line and column, so compile messages map back to the decoder's source as the whole module's do.
// The split understands WGSL's module scope: directives, attributes, and the fn, struct, const, override, var, alias, and const_assert declarations;
// a module with anything else, or one that cannot compile as written, stays whole. The engine book's decoder packages chapter describes it.

/** A token the split reads: an identifier or one punctuation character, with its place in the code; numbers, comments, and blank space are skipped. */
type Token = Readonly<{
    end: number
    identifier: boolean
    start: number
    text: string
}>;

/** A module-scope declaration: its code range, the name it declares, the identifiers it references, and whether every module keeps it. */
type Declaration = Readonly<{
    end: number
    function: boolean
    keptByEveryModule: boolean
    name: string | null
    references: ReadonlySet<string>
    start: number
}>;

// NOTE: the sticky and Unicode patterns are built by the constructor, since a typecheck that targets ES5 refuses those flags on literals
const IDENTIFIER_PATTERN = new RegExp(String.raw`[\p{XID_Start}_]\p{XID_Continue}*`, 'uy');
const HEXADECIMAL_NUMBER_PATTERN = new RegExp(String.raw`0[xX][0-9a-fA-F]*(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?\d+)?[iufh]?`, 'y');
const DECIMAL_NUMBER_PATTERN = new RegExp(String.raw`\d*(?:\.\d*)?(?:[eE][+-]?\d+)?[iufh]?`, 'y');
const DIGIT_PATTERN = /\d/;
const BLANK_PATTERN = /\s/;
const LINE_BREAK_PATTERN = /[\r\n]/;
const NON_LINE_BREAK_PATTERN = /[^\r\n]/g;
const LINE_COMMENT_START = '//';
const BLOCK_COMMENT_START = '/*';
const BLOCK_COMMENT_END = '*/';
const ATTRIBUTE_MARK = '@';
const STATEMENT_END = ';';
const TEMPLATE_START = '<';
const TEMPLATE_END = '>';
const BLOCK_START = '{';
const BLANK = ' ';
const CLOSERS: ReadonlyMap<string, string> = new Map([ [ '(', ')' ], [ '[', ']' ], [ '{', '}' ] ]);
const CLOSING_CHARACTERS: ReadonlySet<string> = new Set(CLOSERS.values());

/** Returns where a comment starting at an index ends, or -1 for a block comment left open; block comments nest, as WGSL's do. */
function skipComment(code: string, start: number): number {
    if (code.startsWith(LINE_COMMENT_START, start)) {
        let index = start + LINE_COMMENT_START.length;
        while (index < code.length && !LINE_BREAK_PATTERN.test(code[index])) {
            index += 1;
        }
        return index;
    }
    let depth = 0;
    let index = start;
    while (index < code.length) {
        if (code.startsWith(BLOCK_COMMENT_START, index)) {
            depth += 1;
            index += BLOCK_COMMENT_START.length;
        } else if (code.startsWith(BLOCK_COMMENT_END, index)) {
            depth -= 1;
            index += BLOCK_COMMENT_END.length;
            if (depth === 0) {
                return index;
            }
        } else {
            index += 1;
        }
    }
    return -1;
}

/** Returns where a number literal starting at an index ends, by WGSL's grammar, so letters after it read as an identifier of their own. */
function skipNumber(code: string, start: number): number {
    const pattern = code.startsWith('0x', start) || code.startsWith('0X', start) ? HEXADECIMAL_NUMBER_PATTERN : DECIMAL_NUMBER_PATTERN;
    pattern.lastIndex = start;
    pattern.exec(code);
    return Math.max(pattern.lastIndex, start + 1);
}

function startsNumber(code: string, index: number): boolean {
    return DIGIT_PATTERN.test(code[index]) || (code[index] === '.' && index + 1 < code.length && DIGIT_PATTERN.test(code[index + 1]));
}

/** Reads the code's identifiers and punctuation, or returns null for a block comment left open. */
function tokenize(code: string): Token[] | null {
    const tokens: Token[] = [];
    let index = 0;
    while (index < code.length) {
        const character = code[index];
        if (BLANK_PATTERN.test(character)) {
            index += 1;
        } else if (code.startsWith(LINE_COMMENT_START, index) || code.startsWith(BLOCK_COMMENT_START, index)) {
            index = skipComment(code, index);
            if (index < 0) {
                return null;
            }
        } else if (startsNumber(code, index)) {
            index = skipNumber(code, index);
        } else {
            IDENTIFIER_PATTERN.lastIndex = index;
            const identifier = IDENTIFIER_PATTERN.exec(code);
            if (identifier) {
                tokens.push({ end: index + identifier[0].length, identifier: true, start: index, text: identifier[0] });
                index += identifier[0].length;
            } else {
                tokens.push({ end: index + 1, identifier: false, start: index, text: character });
                index += 1;
            }
        }
    }
    return tokens;
}

function isPunctuation(token: Token | undefined, text: string): boolean {
    return token !== undefined && !token.identifier && token.text === text;
}

/** Returns the index of the token that closes the bracket at an index, or -1 when the brackets do not balance. */
function findClosingToken(tokens: readonly Token[], openIndex: number): number {
    const expectedClosers: string[] = [];
    for (let index = openIndex; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.identifier) {
            continue;
        }
        const closer = CLOSERS.get(token.text);
        if (closer !== undefined) {
            expectedClosers.push(closer);
        } else if (CLOSING_CHARACTERS.has(token.text)) {
            if (expectedClosers.pop() !== token.text) {
                return -1;
            }
            if (expectedClosers.length === 0) {
                return index;
            }
        }
    }
    return -1;
}

/** Returns the index of the first token at bracket depth 0 from an index that is the given punctuation, skipping bracketed runs, or -1. */
function findTopLevelToken(tokens: readonly Token[], fromIndex: number, text: string): number {
    let index = fromIndex;
    while (index < tokens.length) {
        const token = tokens[index];
        if (isPunctuation(token, text)) {
            return index;
        }
        if (!token.identifier && CLOSERS.has(token.text)) {
            index = findClosingToken(tokens, index);
            if (index < 0) {
                return -1;
            }
        } else if (!token.identifier && CLOSING_CHARACTERS.has(token.text)) {
            return -1;
        }
        index += 1;
    }
    return -1;
}

/** Returns the index after a declaration's attributes, each `@name` with an optional bracketed argument list, or -1 for a malformed one. */
function skipAttributes(tokens: readonly Token[], fromIndex: number): number {
    let index = fromIndex;
    while (isPunctuation(tokens[index], ATTRIBUTE_MARK)) {
        if (!tokens[index + 1]?.identifier) {
            return -1;
        }
        index += 2;
        if (isPunctuation(tokens[index], '(')) {
            const closingIndex = findClosingToken(tokens, index);
            if (closingIndex < 0) {
                return -1;
            }
            index = closingIndex + 1;
        }
    }
    return index;
}

/** Returns the index of the identifier a `var` declares: after its template list, which holds only an address space and access mode. */
function findVariableNameIndex(tokens: readonly Token[], keywordIndex: number): number {
    let index = keywordIndex + 1;
    if (isPunctuation(tokens[index], TEMPLATE_START)) {
        while (index < tokens.length && !isPunctuation(tokens[index], TEMPLATE_END)) {
            index += 1;
        }
        index += 1;
    }
    return index;
}

/** The token range a declaration ends with, and the index of its name token, or null without one; -1 marks a malformed declaration. */
type DeclarationShape = Readonly<{
    lastIndex: number
    nameIndex: number | null
}>;

/** Reads the shape of the declaration whose keyword is at an index, or returns null for a keyword the split does not know or a malformed declaration. */
function readDeclarationShape(tokens: readonly Token[], keywordIndex: number): DeclarationShape | null {
    const keyword = tokens[keywordIndex];
    let shape: DeclarationShape;
    switch (keyword.text) {
        case 'fn':
        case 'struct': {
            // A function's body is its first block at depth 0, after its parameters and return type
            const blockIndex = findTopLevelToken(tokens, keywordIndex + 2, BLOCK_START);
            shape = { lastIndex: blockIndex < 0 ? -1 : findClosingToken(tokens, blockIndex), nameIndex: keywordIndex + 1 };
            break;
        }
        case 'const':
        case 'override':
        case 'alias':
            shape = { lastIndex: findTopLevelToken(tokens, keywordIndex + 1, STATEMENT_END), nameIndex: keywordIndex + 1 };
            break;
        case 'var':
            shape = { lastIndex: findTopLevelToken(tokens, keywordIndex + 1, STATEMENT_END), nameIndex: findVariableNameIndex(tokens, keywordIndex) };
            break;
        // Directives and module-scope assertions name nothing, and every module keeps them
        case 'const_assert':
        case 'diagnostic':
        case 'enable':
        case 'requires':
            shape = { lastIndex: findTopLevelToken(tokens, keywordIndex + 1, STATEMENT_END), nameIndex: null };
            break;
        default:
            return null;
    }
    if (shape.lastIndex < 0 || (shape.nameIndex !== null && !tokens[shape.nameIndex]?.identifier)) {
        return null;
    }
    return shape;
}

/** Returns the identifiers of a token range but the one at the excluded index. */
function collectReferences(tokens: readonly Token[], firstIndex: number, lastIndex: number, excludedIndex: number | null): Set<string> {
    const references = new Set<string>();
    for (let index = firstIndex; index <= lastIndex; index += 1) {
        if (tokens[index].identifier && index !== excludedIndex) {
            references.add(tokens[index].text);
        }
    }
    return references;
}

/** Reads the module-scope declarations in order, or returns null for code the split does not understand. */
function readDeclarations(tokens: readonly Token[]): Declaration[] | null {
    const declarations: Declaration[] = [];
    let index = 0;
    while (index < tokens.length) {
        // An empty declaration is a lone semicolon, which no module needs
        if (isPunctuation(tokens[index], STATEMENT_END)) {
            index += 1;
            continue;
        }
        const keywordIndex = skipAttributes(tokens, index);
        if (keywordIndex < 0 || !tokens[keywordIndex]?.identifier) {
            return null;
        }
        const shape = readDeclarationShape(tokens, keywordIndex);
        if (!shape) {
            return null;
        }
        declarations.push({
            end: tokens[shape.lastIndex].end,
            function: tokens[keywordIndex].text === 'fn',
            keptByEveryModule: shape.nameIndex === null,
            name: shape.nameIndex === null ? null : tokens[shape.nameIndex].text,
            references: collectReferences(tokens, index, shape.lastIndex, shape.nameIndex),
            start: tokens[index].start
        });
        index = shape.lastIndex + 1;
    }
    return declarations;
}

/** Returns blank text that keeps a removed range's line breaks and, after the last one, its width, so the code after it keeps its line and column. */
function blankText(text: string): string {
    let lastLineBreak = -1;
    for (let index = text.length - 1; index >= 0; index -= 1) {
        if (LINE_BREAK_PATTERN.test(text[index])) {
            lastLineBreak = index;
            break;
        }
    }
    return text.replace(NON_LINE_BREAK_PATTERN, '').concat(BLANK.repeat(text.length - lastLineBreak - 1));
}

/** Returns the declarations an entry point reaches, the ones every module keeps included, through the names they reference. */
function findReachedDeclarations(
    entryPoint: Declaration,
    declarations: readonly Declaration[],
    declarationsByName: ReadonlyMap<string, Declaration>
): Set<Declaration> {
    const reached = new Set<Declaration>();
    const pending: Declaration[] = [ entryPoint, ...declarations.filter((declaration: Declaration): boolean => declaration.keptByEveryModule) ];
    for (let declaration = pending.pop(); declaration !== undefined; declaration = pending.pop()) {
        if (reached.has(declaration)) {
            continue;
        }
        reached.add(declaration);
        for (const reference of declaration.references) {
            const referenced = declarationsByName.get(reference);
            if (referenced !== undefined && !reached.has(referenced)) {
                pending.push(referenced);
            }
        }
    }
    return reached;
}

/** Returns the code with every declaration but the kept ones blanked, comments between declarations included. */
function createKeptCode(code: string, declarations: readonly Declaration[], kept: ReadonlySet<Declaration>): string {
    const parts: string[] = [];
    let blankStart = 0;
    for (const declaration of declarations) {
        if (!kept.has(declaration)) {
            continue;
        }
        parts.push(blankText(code.slice(blankStart, declaration.start)), code.slice(declaration.start, declaration.end));
        blankStart = declaration.end;
    }
    parts.push(blankText(code.slice(blankStart)));
    return parts.join('');
}

/**
 * Returns each entry point's module: the code with every module-scope declaration the entry point does not reach blanked, every kept character at its line and column.
 * Returns null when the code holds anything the split does not understand, a name declared twice, or an entry point no function declares;
 * such code compiles whole, which reports its errors as WGSL defines them.
 */
export function splitGPUDecoderModule(code: string, entryPoints: readonly string[]): ReadonlyMap<string, string> | null {
    const tokens = tokenize(code);
    const declarations = tokens === null ? null : readDeclarations(tokens);
    if (declarations === null) {
        return null;
    }
    const declarationsByName = new Map<string, Declaration>();
    for (const declaration of declarations) {
        if (declaration.name === null) {
            continue;
        }
        if (declarationsByName.has(declaration.name)) {
            return null;
        }
        declarationsByName.set(declaration.name, declaration);
    }
    const modules = new Map<string, string>();
    for (const entryPoint of entryPoints) {
        const entryPointDeclaration = declarationsByName.get(entryPoint);
        if (!entryPointDeclaration?.function) {
            return null;
        }
        modules.set(entryPoint, createKeptCode(code, declarations, findReachedDeclarations(entryPointDeclaration, declarations, declarationsByName)));
    }
    return modules;
}
