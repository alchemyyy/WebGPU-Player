// A select element whose options stand for values: a panel hands it labeled values and gets the chosen value back, never parsing option text.
import { createElement, replaceChildren } from '../dom';

export type Choice<Value> = Readonly<{ label: string; value: Value }>;

export type ChoiceSelect<Value> = Readonly<{
    element: HTMLSelectElement
    /** Replaces the options, keeping the selected value when the new choices hold it */
    setChoices: (choices: readonly Choice<Value>[]) => void
    /** Selects the option that holds a value, or none when no option holds it */
    setValue: (value: Value) => void
}>;

/** Lists the choices of a label record in its key order; typing the record by a union makes the list cover every member. */
export function listRecordChoices<Value extends string>(labels: Readonly<Record<Value, string>>): Choice<Value>[] {
    const choices: Choice<Value>[] = [];
    for (const [ value, label ] of Object.entries<string>(labels)) {
        choices.push({ label, value: value as Value });
    }
    return choices;
}

/** Creates an empty choice select that calls onChoose with the value of the option the user picks. */
export function createChoiceSelect<Value>(
    onChoose: (value: Value) => void,
    isSameValue: (firstValue: Value, secondValue: Value) => boolean = Object.is
): ChoiceSelect<Value> {
    const element = createElement('select');
    let choices: readonly Choice<Value>[] = [];
    // The options mirror the choices, so an option's index is its choice's index, and -1 means no option is selected
    element.addEventListener('change', (): void => {
        const selectedIndex = element.selectedIndex;
        if (selectedIndex >= 0) {
            onChoose(choices[selectedIndex].value);
        }
    });
    const setValue = (value: Value): void => {
        element.selectedIndex = choices.findIndex((choice: Choice<Value>): boolean => isSameValue(choice.value, value));
    };
    const setChoices = (nextChoices: readonly Choice<Value>[]): void => {
        const selectedIndex = element.selectedIndex;
        const previousChoices = choices;
        choices = nextChoices;
        replaceChildren(element, nextChoices.map((choice: Choice<Value>): HTMLOptionElement => createElement('option', { text: choice.label })));
        if (selectedIndex >= 0) {
            setValue(previousChoices[selectedIndex].value);
        }
    };
    return { element, setChoices, setValue };
}
