// Memoized selection of several state values at once, for subscribeSelection.

/**
 * Wraps a selector that returns several values so it keeps returning the same tuple while every value is unchanged by reference.
 * subscribeSelection then notifies a panel only when one of the values it reads changes.
 */
export function createTupleSelector<State, Values extends readonly unknown[]>(
    select: (state: State) => Values
): (state: State) => Values {
    let previousValues: Values | null = null;
    return (state: State): Values => {
        const values = select(state);
        if (previousValues !== null && haveSameValues(previousValues, values)) {
            return previousValues;
        }
        previousValues = values;
        return values;
    };
}

function haveSameValues(first: readonly unknown[], second: readonly unknown[]): boolean {
    if (first.length !== second.length) {
        return false;
    }
    for (let index = 0; index < first.length; index += 1) {
        if (!Object.is(first[index], second[index])) {
            return false;
        }
    }
    return true;
}
