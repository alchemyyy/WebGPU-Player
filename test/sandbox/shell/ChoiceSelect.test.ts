import { describe, expect, it, vi } from 'vitest';

import { type Choice, createChoiceSelect, listRecordChoices } from '../../../sandbox/src/ui/panels/ChoiceSelect';

type Fruit = 'apple' | 'cherry' | 'pear';

const FRUIT_LABELS: Readonly<Record<Fruit, string>> = { apple: 'Apple', cherry: 'Cherry', pear: 'Pear' };
const OFF_CHOICE: Choice<string | null> = { label: 'Off', value: null };
const FIRST_CHOICE: Choice<string | null> = { label: 'First', value: 'first' };
const SECOND_CHOICE: Choice<string | null> = { label: 'Second', value: 'second' };
const MISSING_VALUE = 'missing';

/** Picks an option the way a user does, which fires change. */
function pickOption(select: HTMLSelectElement, optionIndex: number): void {
    select.selectedIndex = optionIndex;
    select.dispatchEvent(new Event('change'));
}

describe('ChoiceSelect', () => {
    it('lists a label record in key order', () => {
        expect(listRecordChoices(FRUIT_LABELS)).toEqual([
            { label: 'Apple', value: 'apple' },
            { label: 'Cherry', value: 'cherry' },
            { label: 'Pear', value: 'pear' }
        ]);
    });

    it('hands the chosen option value to the listener, including null', () => {
        const onChoose = vi.fn();
        const choiceSelect = createChoiceSelect<string | null>(onChoose);
        choiceSelect.setChoices([ OFF_CHOICE, FIRST_CHOICE, SECOND_CHOICE ]);
        expect(Array.from(choiceSelect.element.options, (option: HTMLOptionElement): string => option.text)).toEqual([ 'Off', 'First', 'Second' ]);

        pickOption(choiceSelect.element, 2);
        pickOption(choiceSelect.element, 0);
        expect(onChoose.mock.calls).toEqual([ [ SECOND_CHOICE.value ], [ OFF_CHOICE.value ] ]);
    });

    it('selects by value, and selects nothing for a value no option holds', () => {
        const choiceSelect = createChoiceSelect<string | null>(vi.fn());
        choiceSelect.setChoices([ OFF_CHOICE, FIRST_CHOICE, SECOND_CHOICE ]);
        choiceSelect.setValue(SECOND_CHOICE.value);
        expect(choiceSelect.element.selectedIndex).toBe(2);
        choiceSelect.setValue(MISSING_VALUE);
        expect(choiceSelect.element.selectedIndex).toBe(-1);
    });

    it('keeps the selected value across new choices, by the given equality', () => {
        const choiceSelect = createChoiceSelect<Readonly<{ id: number }>>(
            vi.fn(),
            (firstValue: Readonly<{ id: number }>, secondValue: Readonly<{ id: number }>): boolean => firstValue.id === secondValue.id
        );
        choiceSelect.setChoices([ { label: 'One', value: { id: 1 } }, { label: 'Two', value: { id: 2 } } ]);
        choiceSelect.setValue({ id: 2 });
        choiceSelect.setChoices([ { label: 'Zero', value: { id: 0 } }, { label: 'One', value: { id: 1 } }, { label: 'Two', value: { id: 2 } } ]);
        expect(choiceSelect.element.selectedIndex).toBe(2);
    });
});
