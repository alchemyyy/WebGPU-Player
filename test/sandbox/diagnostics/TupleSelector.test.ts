import { describe, expect, it } from 'vitest';

import { createTupleSelector } from '../../../sandbox/src/ui/diagnostics/TupleSelector';

type TestState = Readonly<{
    first: Readonly<{ value: number }>
    second: string
}>;

const FIRST_VALUE = 1;
const SECOND_VALUE = 'second';
const CHANGED_SECOND_VALUE = 'changed';

function selectBoth(state: TestState): readonly [Readonly<{ value: number }>, string] {
    return [ state.first, state.second ];
}

describe('createTupleSelector', () => {
    it('returns the same tuple while every selected value is unchanged by reference', () => {
        const select = createTupleSelector(selectBoth);
        const state: TestState = { first: { value: FIRST_VALUE }, second: SECOND_VALUE };
        const selection = select(state);

        expect(select({ ...state })).toBe(selection);
    });

    it('returns a new tuple once a selected value changes', () => {
        const select = createTupleSelector(selectBoth);
        const state: TestState = { first: { value: FIRST_VALUE }, second: SECOND_VALUE };
        const selection = select(state);

        expect(select({ ...state, second: CHANGED_SECOND_VALUE })).toEqual([ state.first, CHANGED_SECOND_VALUE ]);
        expect(select({ ...state, first: { value: FIRST_VALUE } })).not.toBe(selection);
    });
});
