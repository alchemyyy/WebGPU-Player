// DOM construction helpers for the panels; text always goes through textContent, so file names and engine details never parse as markup.

export type ElementOptions = Readonly<{
    attributes?: Readonly<Record<string, string>>
    className?: string
    text?: string
}>;

/** Creates an element with optional class, attributes, text, and children. */
export function createElement<Tag extends keyof HTMLElementTagNameMap>(
    tag: Tag,
    options: ElementOptions = {},
    children: readonly Node[] = []
): HTMLElementTagNameMap[Tag] {
    const element = document.createElement(tag);
    if (options.className !== undefined) {
        element.className = options.className;
    }
    for (const [ name, value ] of Object.entries(options.attributes ?? {})) {
        element.setAttribute(name, value);
    }
    if (options.text !== undefined) {
        element.textContent = options.text;
    }
    element.append(...children);
    return element;
}

/** Replaces an element's children. */
export function replaceChildren(element: Element, children: readonly Node[]): void {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
    element.append(...children);
}

/** Returns the element a selector names, or throws naming the selector. */
export function requireElement<Type extends Element>(parent: ParentNode, selector: string): Type {
    const element = parent.querySelector<Type>(selector);
    if (!element) {
        throw new Error(`missing-element: ${selector}`);
    }
    return element;
}
