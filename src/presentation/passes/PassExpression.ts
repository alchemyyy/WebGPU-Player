import type {
    PassExpression,
    PassExpressionBinaryOperator,
    PassExpressionFacts,
    PassExpressionFunction
} from './PassTypes';

/** A malformed expression, or one that cannot be evaluated against its facts. */
export class PassExpressionError extends Error {
    readonly position: number;

    constructor(message: string, position: number) {
        super(message);
        this.name = 'PassExpressionError';
        this.position = position;
    }
}

type Token =
    | { kind: 'comma'; position: number }
    | { kind: 'identifier'; name: string; position: number }
    | { kind: 'number'; position: number; value: number }
    | { kind: 'operator'; operator: string; position: number }
    | { kind: 'parenthesis-close'; position: number }
    | { kind: 'parenthesis-open'; position: number };

type PendingOperator =
    | { arity: number; kind: 'call'; name: PassExpressionFunction; position: number }
    | { kind: 'binary'; operator: PassExpressionBinaryOperator; position: number }
    | { kind: 'parenthesis'; position: number }
    | { kind: 'unary'; operator: '!' | '-'; position: number };

const UNARY_PRECEDENCE = 7;

const BINARY_OPERATORS: ReadonlySet<string> = new Set<PassExpressionBinaryOperator>([
    '!=', '%', '&&', '*', '+', '-', '/', '<', '<=', '==', '>', '>=', '||'
]);

const FUNCTION_NAMES: ReadonlySet<string> = new Set<PassExpressionFunction>([ 'abs', 'ceil', 'floor', 'max', 'min', 'round' ]);

// Longest operators first, so <= never tokenizes as < followed by =
const OPERATORS: readonly string[] = [ '&&', '||', '<=', '>=', '==', '!=', '+', '-', '*', '/', '%', '<', '>', '!' ];

const NUMBER_PATTERN = /^\d+(\.\d+)?/;
const IDENTIFIER_PATTERN = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*/;
const WHITESPACE_PATTERN = /^\s+/;

function getPunctuationKind(character: string): 'comma' | 'parenthesis-close' | 'parenthesis-open' | null {
    switch (character) {
        case ',':
            return 'comma';
        case '(':
            return 'parenthesis-open';
        case ')':
            return 'parenthesis-close';
        default:
            return null;
    }
}

function getBinaryPrecedence(operator: PassExpressionBinaryOperator): number {
    switch (operator) {
        case '||':
            return 1;
        case '&&':
            return 2;
        case '==':
        case '!=':
            return 3;
        case '<':
        case '<=':
        case '>':
        case '>=':
            return 4;
        case '+':
        case '-':
            return 5;
        case '*':
        case '/':
        case '%':
            return 6;
    }
}

function getFunctionArity(name: PassExpressionFunction): number {
    switch (name) {
        case 'max':
        case 'min':
            return 2;
        case 'abs':
        case 'ceil':
        case 'floor':
        case 'round':
            return 1;
    }
}

function isBinaryOperator(operator: string): operator is PassExpressionBinaryOperator {
    return BINARY_OPERATORS.has(operator);
}

function isFunctionName(name: string): name is PassExpressionFunction {
    return FUNCTION_NAMES.has(name);
}

/** Reads the token at position, with the length of its source text. */
function readToken(text: string, position: number): { length: number; token: Token } {
    const remaining = text.slice(position);
    const punctuation = getPunctuationKind(remaining[0]);
    if (punctuation) {
        return { length: 1, token: { kind: punctuation, position } };
    }
    const numberMatch = NUMBER_PATTERN.exec(remaining);
    if (numberMatch) {
        return { length: numberMatch[0].length, token: { kind: 'number', position, value: Number(numberMatch[0]) } };
    }
    const identifierMatch = IDENTIFIER_PATTERN.exec(remaining);
    if (identifierMatch) {
        return { length: identifierMatch[0].length, token: { kind: 'identifier', name: identifierMatch[0], position } };
    }
    const operator = OPERATORS.find((candidate: string): boolean => remaining.startsWith(candidate));
    if (!operator) {
        throw new PassExpressionError(`Unexpected character '${remaining[0]}'`, position);
    }
    return { length: operator.length, token: { kind: 'operator', operator, position } };
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let position = 0;
    while (position < text.length) {
        const whitespace = WHITESPACE_PATTERN.exec(text.slice(position));
        if (whitespace) {
            position += whitespace[0].length;
            continue;
        }
        const { length, token } = readToken(text, position);
        tokens.push(token);
        position += length;
    }
    return tokens;
}

function getPrecedence(pending: PendingOperator): number {
    switch (pending.kind) {
        case 'binary':
            return getBinaryPrecedence(pending.operator);
        case 'unary':
            return UNARY_PRECEDENCE;
        case 'call':
        case 'parenthesis':
            return 0;
    }
}

function isGroup(pending: PendingOperator): boolean {
    return pending.kind === 'call' || pending.kind === 'parenthesis';
}

/** An iterative shunting-yard parser over one expression's tokens. */
class PassExpressionParser {
    private expectingOperand = true;
    private readonly operands: PassExpression[] = [];
    private readonly pendingOperators: PendingOperator[] = [];
    private readonly tokens: readonly Token[];
    private tokenIndex = 0;

    constructor(tokens: readonly Token[]) {
        this.tokens = tokens;
    }

    parse(textLength: number): PassExpression {
        for (; this.tokenIndex < this.tokens.length; this.tokenIndex += 1) {
            this.readToken(this.tokens[this.tokenIndex]);
        }
        if (this.expectingOperand) {
            throw new PassExpressionError('Expression ends with an operator', textLength);
        }
        let pending = this.pendingOperators.pop();
        while (pending) {
            this.apply(pending);
            pending = this.pendingOperators.pop();
        }
        if (this.operands.length !== 1) {
            throw new PassExpressionError('Malformed expression', 0);
        }
        return this.operands[0];
    }

    private readToken(token: Token): void {
        switch (token.kind) {
            case 'number':
                this.requireOperandPosition(token.position, 'Unexpected number');
                this.operands.push({ kind: 'number', value: token.value });
                this.expectingOperand = false;
                return;
            case 'identifier':
                this.readIdentifier(token);
                return;
            case 'parenthesis-open':
                this.requireOperandPosition(token.position, 'Unexpected parenthesis');
                this.pendingOperators.push({ kind: 'parenthesis', position: token.position });
                return;
            case 'parenthesis-close':
                this.closeGroup(token.position);
                return;
            case 'comma':
                this.readComma(token.position);
                return;
            case 'operator':
                this.readOperator(token.operator, token.position);
                return;
        }
    }

    private requireOperandPosition(position: number, message: string): void {
        if (!this.expectingOperand) {
            throw new PassExpressionError(message, position);
        }
    }

    private readIdentifier(token: Extract<Token, { kind: 'identifier' }>): void {
        this.requireOperandPosition(token.position, `Unexpected identifier '${token.name}'`);
        if (this.tokens[this.tokenIndex + 1]?.kind !== 'parenthesis-open') {
            this.operands.push({ kind: 'identifier', name: token.name });
            this.expectingOperand = false;
            return;
        }
        if (!isFunctionName(token.name)) {
            throw new PassExpressionError(`Unknown function '${token.name}'`, token.position);
        }
        this.pendingOperators.push({ arity: 0, kind: 'call', name: token.name, position: token.position });
        // The call's open parenthesis is consumed with its name
        this.tokenIndex += 1;
    }

    private readComma(position: number): void {
        if (this.expectingOperand) {
            throw new PassExpressionError('Missing function argument', position);
        }
        if (!this.pendingOperators.some((pending: PendingOperator): boolean => pending.kind === 'call')) {
            throw new PassExpressionError('Comma outside a function call', position);
        }
        const group = this.unwindToGroup(position);
        if (group.kind !== 'call') {
            throw new PassExpressionError('Comma outside a function call', position);
        }
        this.pendingOperators.push({ ...group, arity: group.arity + 1 });
        this.expectingOperand = true;
    }

    private readOperator(operator: string, position: number): void {
        if (this.expectingOperand) {
            if (operator !== '-' && operator !== '!') {
                throw new PassExpressionError(`Unexpected operator '${operator}'`, position);
            }
            this.pendingOperators.push({ kind: 'unary', operator, position });
            return;
        }
        if (!isBinaryOperator(operator)) {
            throw new PassExpressionError(`Unexpected operator '${operator}'`, position);
        }
        const binary: PendingOperator = { kind: 'binary', operator, position };
        const precedence = getPrecedence(binary);
        let top = this.pendingOperators.at(-1);
        // Binary operators are left-associative, so an equal precedence on the stack applies first
        while (top && !isGroup(top) && getPrecedence(top) >= precedence) {
            this.apply(top);
            this.pendingOperators.pop();
            top = this.pendingOperators.at(-1);
        }
        this.pendingOperators.push(binary);
        this.expectingOperand = true;
    }

    private closeGroup(position: number): void {
        const group = this.unwindToGroup(position);
        if (group.kind === 'call') {
            if (this.expectingOperand && group.arity > 0) {
                throw new PassExpressionError('Missing function argument', position);
            }
            // A call closes with one more argument than its commas, unless it has none
            this.apply({ ...group, arity: this.expectingOperand ? 0 : group.arity + 1 });
        } else if (this.expectingOperand) {
            throw new PassExpressionError('Empty parentheses', position);
        }
        this.expectingOperand = false;
    }

    /** Applies operators down to the innermost open parenthesis or call, and returns it without applying it. */
    private unwindToGroup(position: number): PendingOperator {
        let pending = this.pendingOperators.pop();
        while (pending && !isGroup(pending)) {
            this.apply(pending);
            pending = this.pendingOperators.pop();
        }
        if (!pending) {
            throw new PassExpressionError('Unbalanced parenthesis', position);
        }
        return pending;
    }

    private popOperand(position: number): PassExpression {
        const operand = this.operands.pop();
        if (!operand) {
            throw new PassExpressionError('Missing operand', position);
        }
        return operand;
    }

    private apply(pending: PendingOperator): void {
        switch (pending.kind) {
            case 'binary': {
                const right = this.popOperand(pending.position);
                const left = this.popOperand(pending.position);
                this.operands.push({ kind: 'binary', left, operator: pending.operator, right });
                return;
            }
            case 'unary':
                this.operands.push({ kind: 'unary', operand: this.popOperand(pending.position), operator: pending.operator });
                return;
            case 'call':
                this.applyCall(pending);
                return;
            case 'parenthesis':
                throw new PassExpressionError('Unbalanced parenthesis', pending.position);
        }
    }

    private applyCall(pending: Extract<PendingOperator, { kind: 'call' }>): void {
        const arity = getFunctionArity(pending.name);
        if (pending.arity !== arity) {
            throw new PassExpressionError(`${pending.name} takes ${arity} arguments, not ${pending.arity}`, pending.position);
        }
        const functionArguments: PassExpression[] = [];
        for (let argumentIndex = 0; argumentIndex < arity; argumentIndex += 1) {
            functionArguments.unshift(this.popOperand(pending.position));
        }
        this.operands.push({ arguments: functionArguments, kind: 'call', name: pending.name });
    }
}

/** Parses a size or condition expression of a pass header, such as `HOOKED.width * 2` or `output.width >= source.width`. */
export function parsePassExpression(text: string): PassExpression {
    const tokens = tokenize(text);
    if (tokens.length === 0) {
        throw new PassExpressionError('Empty expression', 0);
    }
    return new PassExpressionParser(tokens).parse(text.length);
}

function requireNonzeroDivisor(divisor: number): number {
    if (divisor === 0) {
        throw new PassExpressionError('Division by zero', 0);
    }
    return divisor;
}

function evaluateBinary(operator: PassExpressionBinaryOperator, left: number, right: number): number {
    switch (operator) {
        case '+':
            return left + right;
        case '-':
            return left - right;
        case '*':
            return left * right;
        case '/':
            return left / requireNonzeroDivisor(right);
        case '%':
            return left % requireNonzeroDivisor(right);
        case '<':
            return Number(left < right);
        case '<=':
            return Number(left <= right);
        case '>':
            return Number(left > right);
        case '>=':
            return Number(left >= right);
        case '==':
            return Number(left === right);
        case '!=':
            return Number(left !== right);
        case '&&':
            return Number(left !== 0 && right !== 0);
        case '||':
            return Number(left !== 0 || right !== 0);
    }
}

function evaluateCall(name: PassExpressionFunction, values: readonly number[]): number {
    switch (name) {
        case 'abs':
            return Math.abs(values[0]);
        case 'ceil':
            return Math.ceil(values[0]);
        case 'floor':
            return Math.floor(values[0]);
        case 'max':
            return Math.max(values[0], values[1]);
        case 'min':
            return Math.min(values[0], values[1]);
        case 'round':
            return Math.round(values[0]);
    }
}

function getChildren(expression: PassExpression): readonly PassExpression[] {
    switch (expression.kind) {
        case 'number':
        case 'identifier':
            return [];
        case 'unary':
            return [ expression.operand ];
        case 'binary':
            return [ expression.left, expression.right ];
        case 'call':
            return expression.arguments;
    }
}

function evaluateNode(node: PassExpression, childValues: readonly number[], facts: PassExpressionFacts): number {
    switch (node.kind) {
        case 'number':
            return node.value;
        case 'identifier': {
            const fact = facts.get(node.name);
            if (fact === undefined) {
                throw new PassExpressionError(`Unknown identifier '${node.name}'`, 0);
            }
            return fact;
        }
        case 'unary':
            return node.operator === '-' ? -childValues[0] : Number(childValues[0] === 0);
        case 'binary':
            return evaluateBinary(node.operator, childValues[0], childValues[1]);
        case 'call':
            return evaluateCall(node.name, childValues);
    }
}

function readResult(results: ReadonlyMap<PassExpression, number>, node: PassExpression): number {
    const value = results.get(node);
    if (value === undefined) {
        throw new PassExpressionError('Expression evaluation order failed', 0);
    }
    return value;
}

/** Evaluates an expression against its identifiers' values; comparisons and logic yield 1 or 0. */
export function evaluatePassExpression(expression: PassExpression, facts: PassExpressionFacts): number {
    // Post-order traversal with an explicit stack: a node is evaluated once its children have been
    const results = new Map<PassExpression, number>();
    const pendingNodes: { expanded: boolean; node: PassExpression }[] = [{ expanded: false, node: expression }];
    let pending = pendingNodes.pop();
    while (pending) {
        const children = getChildren(pending.node);
        if (!pending.expanded && children.length > 0) {
            pendingNodes.push({ expanded: true, node: pending.node });
            for (const child of children) {
                pendingNodes.push({ expanded: false, node: child });
            }
        } else {
            const childValues = children.map((child: PassExpression): number => readResult(results, child));
            results.set(pending.node, evaluateNode(pending.node, childValues, facts));
        }
        pending = pendingNodes.pop();
    }

    const result = readResult(results, expression);
    if (!Number.isFinite(result)) {
        throw new PassExpressionError('Expression did not evaluate to a finite number', 0);
    }
    return result;
}

/** Returns every identifier an expression reads, in first-use order. */
export function collectPassExpressionIdentifiers(expression: PassExpression): string[] {
    const identifiers: string[] = [];
    const pendingNodes: PassExpression[] = [ expression ];
    let node = pendingNodes.pop();
    while (node) {
        if (node.kind === 'identifier' && !identifiers.includes(node.name)) {
            identifiers.push(node.name);
        }
        const children = getChildren(node);
        for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
            pendingNodes.push(children[childIndex]);
        }
        node = pendingNodes.pop();
    }
    return identifiers;
}
