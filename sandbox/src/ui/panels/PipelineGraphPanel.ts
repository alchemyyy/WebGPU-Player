// The panel that shows the active presentation plan as a flow graph, with the passes the plan left out beside it, and the deinterlacing control above it.
import { DEFAULT_DEINTERLACE_MODE, type DeinterlaceMode } from 'webgpu-player/presentation/DeinterlaceTimeline';
import type { PassRejection, PlanReport, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';

import type { ActiveRoute, SandboxState } from '../../contracts/SandboxContracts';
import { reportCommandRejection } from '../commands';
import { formatPassRejection, getPassRejectionTone } from '../diagnostics/DiagnosticsFormat';
import {
    formatPipelineGraphEdgePath,
    layoutPipelineGraph,
    PIPELINE_GRAPH_GEOMETRY,
    type PipelineGraphEdge,
    type PipelineGraphLayout,
    type PipelineGraphNode
} from '../diagnostics/PipelineGraphLayout';
import { createTupleSelector } from '../diagnostics/TupleSelector';
import { createElement, replaceChildren } from '../dom';
import type { Panel, PanelContext } from '../Panel';
import { subscribeSelection } from '../Store';
import { createChoiceSelect, listRecordChoices } from './ChoiceSelect';
import { createDefaultButton } from './DefaultButton';

import './PipelineGraphPanel.css';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ARROW_MARKER_ID = 'pipeline-graph-arrow';
// The arrowhead's length and width in CSS pixels; its tip sits on the edge's end
const ARROW_SIZE = 8;
const LEFT_OUT_TITLE = 'Left out';
const LINE_SEPARATOR = '\n';
const DEINTERLACE_TITLE = 'Deinterlacing';
// The modes in control order, with their labels; the record type makes the list cover every mode
const DEINTERLACE_MODE_LABELS: Readonly<Record<DeinterlaceMode, string>> = {
    'double-rate': 'Double rate',
    'single-rate': 'Single rate',
    off: 'Off'
};

type GraphInputs = readonly [plan: PresentationPlan | null, planReport: PlanReport, route: ActiveRoute | null];

/**
 * The graph shows once the presenter installs a plan, with the deinterlacing control above it; with neither a plan nor a left-out pass, the panel takes no room.
 * A deinterlacing plan's 'Presentation deinterlace' pass shows in the graph like any other, reading the signal's frame and the two before it.
 */
export function createPipelineGraphPanel(context: PanelContext): Panel {
    const { session, store } = context;
    const graph = createElement('div', { className: 'pipeline-graph' });
    const scroller = createElement('div', { className: 'pipeline-graph-scroller' }, [ graph ]);
    const leftOutList = createElement('ul', { className: 'pipeline-graph-left-out-list' });
    const leftOut = createElement('aside', { className: 'pipeline-graph-left-out' }, [
        createElement('h3', { className: 'pipeline-graph-left-out-title', text: LEFT_OUT_TITLE }),
        leftOutList
    ]);

    /** Sends a mode; a rejected one is reported, and the control returns to the session's mode. */
    const chooseDeinterlaceMode = (mode: DeinterlaceMode): void => {
        session.setDeinterlaceMode(mode).catch((error: unknown): void => {
            reportCommandRejection(error);
            deinterlaceSelect.setValue(store.getState().presentation.deinterlaceMode);
        });
    };
    const deinterlaceSelect = createChoiceSelect<DeinterlaceMode>(chooseDeinterlaceMode);
    deinterlaceSelect.setChoices(listRecordChoices(DEINTERLACE_MODE_LABELS));
    const deinterlaceDefaultButton = createDefaultButton(DEINTERLACE_MODE_LABELS[DEFAULT_DEINTERLACE_MODE], (): void => {
        chooseDeinterlaceMode(DEFAULT_DEINTERLACE_MODE);
    });
    const controls = createElement('label', { className: 'pipeline-graph-controls' }, [
        createElement('span', { text: DEINTERLACE_TITLE }),
        deinterlaceSelect.element,
        deinterlaceDefaultButton
    ]);
    const body = createElement('div', { className: 'pipeline-graph-body' }, [ scroller, leftOut ]);
    const element = createElement('section', { className: 'pipeline-graph-panel' }, [ controls, body ]);
    const unsubscribers: (() => void)[] = [
        subscribeSelection(
            store,
            createTupleSelector((state: SandboxState): GraphInputs => [ state.presentation.plan, state.presentation.report, state.route.active ]),
            ([ plan, planReport, route ]: GraphInputs): void => {
                scroller.hidden = plan === null;
                controls.hidden = plan === null;
                leftOut.hidden = planReport.inactivePasses.length === 0;
                element.hidden = scroller.hidden && leftOut.hidden;
                renderGraph(graph, plan, route);
                renderLeftOutPasses(leftOutList, planReport.inactivePasses);
            }
        ),
        subscribeSelection(store, (state: SandboxState): DeinterlaceMode => state.presentation.deinterlaceMode, (mode: DeinterlaceMode): void => {
            deinterlaceSelect.setValue(mode);
        })
    ];
    return {
        destroy: (): void => {
            for (const unsubscribe of unsubscribers) {
                unsubscribe();
            }
        },
        element
    };
}

/** Draws the plan's layout, sized to it; without a plan the graph is empty. */
function renderGraph(graph: HTMLElement, plan: PresentationPlan | null, route: ActiveRoute | null): void {
    if (plan === null) {
        replaceChildren(graph, []);
        return;
    }
    const layout = layoutPipelineGraph(plan, route);
    graph.style.width = `${layout.width}px`;
    graph.style.height = `${layout.height}px`;
    const children: Node[] = [];
    children.push(createEdgeLayer(layout));
    for (const node of layout.nodes) {
        children.push(createNodeElement(node));
    }
    replaceChildren(graph, children);
}

function renderLeftOutPasses(list: HTMLElement, rejections: readonly PassRejection[]): void {
    const items: Node[] = [];
    for (const rejection of rejections) {
        items.push(createElement('li', { attributes: { 'data-tone': getPassRejectionTone(rejection) }, className: 'pipeline-graph-left-out-pass' }, [
            createElement('span', { className: 'pipeline-graph-left-out-name', text: rejection.name }),
            createElement('span', { className: 'pipeline-graph-left-out-reason', text: formatPassRejection(rejection) })
        ]));
    }
    replaceChildren(list, items);
}

function createNodeElement(node: PipelineGraphNode): HTMLElement {
    const lines: Node[] = [];
    const lineTexts: string[] = [];
    for (const line of node.lines) {
        lines.push(createElement('div', { attributes: { 'data-role': line.role }, className: 'pipeline-graph-line', text: line.text }));
        lineTexts.push(line.text);
    }
    // The title repeats every line, since narrow nodes cut long ones short
    const element = createElement('div', {
        attributes: { 'data-kind': node.kind, title: lineTexts.join(LINE_SEPARATOR) },
        className: 'pipeline-graph-node'
    }, lines);
    element.style.left = `${node.x}px`;
    element.style.top = `${node.y}px`;
    element.style.width = `${node.width}px`;
    element.style.height = `${node.height}px`;
    element.style.padding = `${PIPELINE_GRAPH_GEOMETRY.nodePadding}px`;
    element.style.lineHeight = `${PIPELINE_GRAPH_GEOMETRY.lineHeight}px`;
    return element;
}

function createEdgeLayer(layout: PipelineGraphLayout): SVGSVGElement {
    const layer = createSVGElement('svg', {
        class: 'pipeline-graph-edges',
        height: String(layout.height),
        viewBox: `0 0 ${layout.width} ${layout.height}`,
        width: String(layout.width)
    });
    layer.append(createArrowMarker());
    for (const edge of layout.edges) {
        layer.append(createEdgePath(edge));
        if (edge.label !== null) {
            layer.append(createEdgeLabel(edge, edge.label));
        }
    }
    return layer;
}

function createArrowMarker(): SVGDefsElement {
    const marker = createSVGElement('marker', {
        id: ARROW_MARKER_ID,
        markerHeight: String(ARROW_SIZE),
        markerUnits: 'userSpaceOnUse',
        markerWidth: String(ARROW_SIZE),
        orient: 'auto',
        refX: String(ARROW_SIZE),
        refY: String(ARROW_SIZE / 2)
    });
    marker.append(createSVGElement('path', { class: 'pipeline-graph-arrow', d: `M 0 0 L ${ARROW_SIZE} ${ARROW_SIZE / 2} L 0 ${ARROW_SIZE} Z` }));
    const definitions = createSVGElement('defs', {});
    definitions.append(marker);
    return definitions;
}

function createEdgePath(edge: PipelineGraphEdge): SVGPathElement {
    const path = createSVGElement('path', {
        class: 'pipeline-graph-edge',
        d: formatPipelineGraphEdgePath(edge),
        'data-route': edge.route,
        'marker-end': `url(#${ARROW_MARKER_ID})`
    });
    if (edge.historyOffset !== 0) {
        path.setAttribute('data-history', String(edge.historyOffset));
    }
    return path;
}

function createEdgeLabel(edge: PipelineGraphEdge, label: string): SVGTextElement {
    const text = createSVGElement('text', {
        class: 'pipeline-graph-edge-label',
        x: String(edge.labelPosition.x),
        y: String(edge.labelPosition.y)
    });
    text.textContent = label;
    return text;
}

function createSVGElement<Tag extends keyof SVGElementTagNameMap>(
    tag: Tag,
    attributes: Readonly<Record<string, string>>
): SVGElementTagNameMap[Tag] {
    const element = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [ name, value ] of Object.entries(attributes)) {
        element.setAttribute(name, value);
    }
    return element;
}
