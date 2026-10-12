// DOM construction helpers for the panels; text always goes through textContent, so file names and engine details never parse as markup.

// The drag data type of dropped files
const FILES_DRAG_TYPE = 'Files';

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

/** Sets an element's text only when it changed, so a refresh keeps any selection inside it. */
export function setTextContent(element: Element, text: string): void {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

/** How reconcileKeyedChildren finds, creates, and updates the view of each item. */
export type KeyedChildViews<Item, View> = Readonly<{
    createView: (item: Item) => View
    getElement: (view: View) => Element
    getKey: (item: Item) => string
    updateView: (view: View, item: Item, index: number) => void
}>;

/**
 * Brings a container's children to the items' order, reusing each item's view by its key and creating views only for new items, so focus and open state survive.
 * Stale views go first, so views that stay move only when the order changed.
 * Returns the views by key, for the next call.
 */
export function reconcileKeyedChildren<Item, View>(
    container: Element,
    previousViews: ReadonlyMap<string, View>,
    items: readonly Item[],
    childViews: KeyedChildViews<Item, View>
): Map<string, View> {
    const views = new Map<string, View>();
    const placements: (readonly [Item, View])[] = [];
    for (const item of items) {
        const key = childViews.getKey(item);
        const view = previousViews.get(key) ?? childViews.createView(item);
        views.set(key, view);
        placements.push([ item, view ]);
    }
    for (const [ key, view ] of previousViews) {
        if (!views.has(key)) {
            container.removeChild(childViews.getElement(view));
        }
    }
    for (const [ index, [ item, view ] ] of placements.entries()) {
        childViews.updateView(view, item, index);
        const element = childViews.getElement(view);
        const currentChild = container.children.item(index);
        if (currentChild !== element) {
            container.insertBefore(element, currentChild);
        }
    }
    return views;
}

/** Returns whether a drag carries files. */
export function carriesFiles(event: DragEvent): boolean {
    return event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes(FILES_DRAG_TYPE);
}

/** Returns the element a selector names, or throws naming the selector. */
export function requireElement<Type extends Element>(parent: ParentNode, selector: string): Type {
    const element = parent.querySelector<Type>(selector);
    if (!element) {
        throw new Error(`missing-element: ${selector}`);
    }
    return element;
}
