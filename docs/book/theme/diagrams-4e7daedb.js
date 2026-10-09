// Pan and zoom for the book's PlantUML diagrams, in place on the page
// Each diagram link becomes a viewport: drag pans, Ctrl+wheel or a pinch zooms around the pointer, double-click zooms in, and a toolbar zooms, fits, or opens the SVG
// Without JavaScript the links still open the full-size SVG
(function () {
    'use strict';

    const MINIMUM_SCALE = 0.1;
    const MAXIMUM_SCALE = 8;
    const BUTTON_ZOOM_FACTOR = 1.25;
    const DOUBLE_CLICK_ZOOM_FACTOR = 2;
    // Math: a wheel delta of 100 pixels zooms by about 1.2x, and trackpad pinches send small deltas
    const WHEEL_ZOOM_RATE = 0.0018;
    const MAXIMUM_VIEWPORT_HEIGHT_FRACTION = 0.75;
    const LINE_DELTA_PIXELS = 16;

    /**
     * Creates a toolbar button that runs an action without starting a drag.
     * @param {string} label
     * @param {string} title
     * @param {() => void} action
     * @returns {HTMLButtonElement}
     */
    function createButton(label, title, action) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'diagram-button';
        button.textContent = label;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.addEventListener('click', action);
        return button;
    }

    /**
     * Turns one diagram link, holding one SVG image, into a pan and zoom viewer.
     * @param {HTMLAnchorElement} link
     */
    function createViewer(link) {
        const image = link.querySelector('img');
        if (!image) {
            return;
        }

        const viewer = document.createElement('div');
        viewer.className = `diagram-viewer ${link.className}`;
        const viewport = document.createElement('div');
        viewport.className = 'diagram-viewport';
        viewport.tabIndex = 0;
        viewport.setAttribute('role', 'img');
        viewport.setAttribute('aria-label', image.alt);
        image.draggable = false;
        viewport.appendChild(image);

        const state = { scale: 1, x: 0, y: 0, fitted: true };
        const pointers = new Map();
        let pinchDistance = 0;

        function getNaturalSize() {
            return { width: image.naturalWidth || 1, height: image.naturalHeight || 1 };
        }

        // Keeps the diagram centered when it is smaller than the viewport, and inside it otherwise
        function clampOffset(offset, scaledLength, viewportLength) {
            if (scaledLength <= viewportLength) {
                return (viewportLength - scaledLength) / 2;
            }
            return Math.min(0, Math.max(viewportLength - scaledLength, offset));
        }

        function render() {
            const naturalSize = getNaturalSize();
            state.x = clampOffset(state.x, naturalSize.width * state.scale, viewport.clientWidth);
            state.y = clampOffset(state.y, naturalSize.height * state.scale, viewport.clientHeight);
            image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
        }

        function getFitScale() {
            const naturalSize = getNaturalSize();
            return Math.min(1, viewport.clientWidth / naturalSize.width, viewport.clientHeight / naturalSize.height);
        }

        // Sizes the viewport to the diagram at column width, capped to part of the window, then fits the diagram
        function fit() {
            const naturalSize = getNaturalSize();
            const widthScale = Math.min(1, viewer.clientWidth / naturalSize.width);
            const height = Math.min(naturalSize.height * widthScale, window.innerHeight * MAXIMUM_VIEWPORT_HEIGHT_FRACTION);
            viewport.style.height = `${Math.ceil(height)}px`;
            state.scale = getFitScale();
            state.fitted = true;
            render();
        }

        // Math: keeps the diagram point under (pointX, pointY) fixed while the scale changes
        function zoomAt(factor, pointX, pointY) {
            const nextScale = Math.min(MAXIMUM_SCALE, Math.max(MINIMUM_SCALE, state.scale * factor));
            const appliedFactor = nextScale / state.scale;
            state.x = pointX - (pointX - state.x) * appliedFactor;
            state.y = pointY - (pointY - state.y) * appliedFactor;
            state.scale = nextScale;
            state.fitted = false;
            render();
        }

        function zoomAtCenter(factor) {
            zoomAt(factor, viewport.clientWidth / 2, viewport.clientHeight / 2);
        }

        function getLocalPoint(event) {
            const bounds = viewport.getBoundingClientRect();
            return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        }

        function getPinchDistance() {
            const [first, second] = [...pointers.values()];
            return Math.hypot(first.x - second.x, first.y - second.y);
        }

        function getPinchCenter() {
            const [first, second] = [...pointers.values()];
            return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        }

        viewport.addEventListener('pointerdown', event => {
            if (event.button !== 0) {
                return;
            }
            viewport.setPointerCapture(event.pointerId);
            pointers.set(event.pointerId, getLocalPoint(event));
            if (pointers.size === 2) {
                pinchDistance = getPinchDistance();
            }
            viewport.classList.add('diagram-dragging');
        });

        viewport.addEventListener('pointermove', event => {
            const previousPoint = pointers.get(event.pointerId);
            if (!previousPoint) {
                return;
            }
            const point = getLocalPoint(event);
            if (pointers.size === 1) {
                state.x += point.x - previousPoint.x;
                state.y += point.y - previousPoint.y;
                state.fitted = false;
                pointers.set(event.pointerId, point);
                render();
                return;
            }
            pointers.set(event.pointerId, point);
            const distance = getPinchDistance();
            if (pinchDistance > 0 && distance > 0) {
                const center = getPinchCenter();
                zoomAt(distance / pinchDistance, center.x, center.y);
            }
            pinchDistance = distance;
        });

        function endPointer(event) {
            pointers.delete(event.pointerId);
            pinchDistance = pointers.size === 2 ? getPinchDistance() : 0;
            if (pointers.size === 0) {
                viewport.classList.remove('diagram-dragging');
            }
        }
        viewport.addEventListener('pointerup', endPointer);
        viewport.addEventListener('pointercancel', endPointer);

        // A plain wheel scrolls the page; Ctrl+wheel and trackpad pinches, which browsers send as Ctrl+wheel, zoom
        viewport.addEventListener('wheel', event => {
            if (!event.ctrlKey && !event.metaKey) {
                return;
            }
            event.preventDefault();
            const deltaPixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * LINE_DELTA_PIXELS : event.deltaY;
            const point = getLocalPoint(event);
            zoomAt(Math.exp(-deltaPixels * WHEEL_ZOOM_RATE), point.x, point.y);
        }, { passive: false });

        viewport.addEventListener('dblclick', event => {
            const point = getLocalPoint(event);
            zoomAt(DOUBLE_CLICK_ZOOM_FACTOR, point.x, point.y);
        });

        viewport.addEventListener('keydown', event => {
            switch (event.key) {
                case '+':
                case '=':
                    zoomAtCenter(BUTTON_ZOOM_FACTOR);
                    break;
                case '-':
                    zoomAtCenter(1 / BUTTON_ZOOM_FACTOR);
                    break;
                case '0':
                    fit();
                    break;
                default:
                    return;
            }
            event.preventDefault();
        });

        const toolbar = document.createElement('div');
        toolbar.className = 'diagram-toolbar';
        toolbar.appendChild(createButton('+', 'Zoom in', () => zoomAtCenter(BUTTON_ZOOM_FACTOR)));
        toolbar.appendChild(createButton('−', 'Zoom out', () => zoomAtCenter(1 / BUTTON_ZOOM_FACTOR)));
        toolbar.appendChild(createButton('Fit', 'Fit to view', fit));
        const openLink = document.createElement('a');
        openLink.className = 'diagram-button';
        openLink.href = link.href;
        openLink.target = '_blank';
        openLink.rel = 'noopener';
        openLink.textContent = 'SVG';
        openLink.title = 'Open the SVG in a new tab';
        toolbar.appendChild(openLink);
        const hint = document.createElement('span');
        hint.className = 'diagram-hint';
        hint.textContent = 'Drag to pan; Ctrl+wheel, pinch, or double-click to zoom';
        toolbar.appendChild(hint);

        viewer.appendChild(viewport);
        viewer.appendChild(toolbar);
        link.replaceWith(viewer);

        // A theme switch reveals a hidden variant at zero width, so fit again whenever the viewer's width changes
        let observedWidth = -1;
        new ResizeObserver(() => {
            if (viewer.clientWidth === observedWidth || viewer.clientWidth === 0) {
                return;
            }
            observedWidth = viewer.clientWidth;
            if (state.fitted) {
                fit();
            } else {
                render();
            }
        }).observe(viewer);

        if (image.complete) {
            fit();
        } else {
            image.addEventListener('load', fit, { once: true });
        }
    }

    for (const link of document.querySelectorAll('.diagram > a')) {
        createViewer(link);
    }
})();
