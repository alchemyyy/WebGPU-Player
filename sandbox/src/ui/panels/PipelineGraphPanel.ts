// The panel that shows the active presentation plan as a flow graph, with the passes the plan left out beside it.
import type { PassRejection, PlanReport, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';

import type { ActiveRoute, SandboxState } from '../../contracts/SandboxContracts';
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

import './PipelineGraphPanel.css';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ARROW_MARKER_ID = 'pipeline-graph-arrow';
// The arrowhead's length and width in CSS pixels; its tip sits on the edge's end
const ARROW_SIZE = 8;
const LEFT_OUT_TITLE = 'Left out';
const LINE_SEPARATOR = '\n';

type GraphInputs = readonly [plan: PresentationPlan | null, planReport: PlanReport, route: ActiveRoute | null];

/** The graph shows once the presenter installs a plan; with neither a plan nor a left-out pass, the panel takes no room. */
export function createPipelineGraphPanel(context: PanelContext): Panel {
    const graph = createElement('div', { className: 'pipeline-graph' });
    const scroller = createElement('div', { className: 'pipeline-graph-scroller' }, [ graph ]);
    const leftOutList = createElement('ul', { className: 'pipeline-graph-left-out-list' });
    const leftOut = createElement('aside', { className: 'pipeline-graph-left-out' }, [
        createElement('h3', { className: 'pipeline-graph-left-out-title', text: LEFT_OUT_TITLE }),
        leftOutList
    ]);
    const element = createElement('section', { className: 'pipeline-graph-panel' }, [ scroller, leftOut ]);
    const destroy = subscribeSelection(
        context.store,
        createTupleSelector((state: SandboxState): GraphInputs => [ state.presentation.plan, state.presentation.report, state.route.active ]),
        ([ plan, planReport, route ]: GraphInputs): void => {
            scroller.hidden = plan === null;
            leftOut.hidden = planReport.inactivePasses.length === 0;
            element.hidden = scroller.hidden && leftOut.hidden;
            renderGraph(graph, plan, route);
            renderLeftOutPasses(leftOutList, planReport.inactivePasses);
        }
    );
    return { destroy, element };
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
