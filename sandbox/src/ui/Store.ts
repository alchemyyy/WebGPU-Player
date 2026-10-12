// A minimal observable store: one immutable state object, shallow-merged updates, and selector subscriptions.

export type StateListener<State> = (state: State, previousState: State) => void;

export type Store<State extends object> = {
    getState: () => State
    /** Shallow-merges an update into the state and notifies listeners once */
    setState: (update: Partial<State> | ((state: State) => Partial<State>)) => void
    subscribe: (listener: StateListener<State>) => () => void
};

export function createStore<State extends object>(initialState: State): Store<State> {
    let state = initialState;
    const listeners = new Set<StateListener<State>>();
    return {
        getState: (): State => state,
        setState: (update: Partial<State> | ((currentState: State) => Partial<State>)): void => {
            const previousState = state;
            const partialState = typeof update === 'function' ? update(state) : update;
            state = { ...state, ...partialState };
            for (const listener of listeners) {
                listener(state, previousState);
            }
        },
        subscribe: (listener: StateListener<State>): (() => void) => {
            listeners.add(listener);
            return (): void => {
                listeners.delete(listener);
            };
        }
    };
}

/**
 * Calls listener with the selected value now and whenever it changes by reference.
 * Every update replaces only what changed, so a panel that selects its slice re-renders only for that slice.
 */
export function subscribeSelection<State extends object, Selection>(
    store: Store<State>,
    select: (state: State) => Selection,
    listener: (selection: Selection) => void
): () => void {
    let selection = select(store.getState());
    listener(selection);
    return store.subscribe((state: State): void => {
        const nextSelection = select(state);
        if (Object.is(nextSelection, selection)) {
            return;
        }
        selection = nextSelection;
        listener(nextSelection);
    });
}
