// Makes a panel a drop target for files: it shows the drag over it and hands the dropped files to the panel.
import { carriesFiles } from './dom';

/** Hands every file dropped on the element to onFiles, and marks the element with activeClass while files are dragged over it. */
export function listenForDroppedFiles(element: HTMLElement, activeClass: string, onFiles: (files: File[]) => void): void {
    // Entering and leaving child elements fires in pairs, so the element is left once the count returns to zero
    let dragDepth = 0;
    element.addEventListener('dragenter', (event: DragEvent): void => {
        if (!carriesFiles(event)) {
            return;
        }
        event.preventDefault();
        dragDepth += 1;
        element.classList.add(activeClass);
    });
    element.addEventListener('dragover', (event: DragEvent): void => {
        if (!carriesFiles(event) || event.dataTransfer === null) {
            return;
        }
        // Cancelling dragover is what makes the element a drop target
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    });
    element.addEventListener('dragleave', (event: DragEvent): void => {
        if (!carriesFiles(event)) {
            return;
        }
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            element.classList.remove(activeClass);
        }
    });
    element.addEventListener('drop', (event: DragEvent): void => {
        if (!carriesFiles(event) || event.dataTransfer === null) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        dragDepth = 0;
        element.classList.remove(activeClass);
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
            onFiles(files);
        }
    });
}
