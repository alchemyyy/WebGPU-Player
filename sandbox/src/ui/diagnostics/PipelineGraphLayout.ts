// The pipeline graph's layout: a presentation plan as nodes and texture edges, positioned left to right in plan order.
import type {
    PlannedOutput,
    PlannedPass,
    PlannedTexture,
    PresentationPlan
} from 'webgpu-player/presentation/passes/PassTypes';

import type { ActiveRoute } from '../../contracts/SandboxContracts';
import { formatDimensions, formatExtent, VALUE_SEPARATOR } from './DiagnosticsFormat';

/** The graph's geometry in CSS pixels; the panel applies it inline, so no stylesheet restates it. */
export const PIPELINE_GRAPH_GEOMETRY = Object.freeze({
    /** How far the shallowest arc reaches beyond the nodes */
    arcDepth: 18,
    /** How much further an arc reaches for each column it spans beyond the shallowest */
    arcDepthStep: 12,
    columnGap: 44,
    /** The room an edge label takes beside its edge */
    labelHeight: 14,
    lineHeight: 15,
    /** The space around the nodes and arcs */
    margin: 8,
    nodePadding: 6,
    nodeWidth: 228
});

export type PipelineGraphPoint = Readonly<{
    x: number
    y: number
}>;

/**
 * - 'title': the node's name.
 * - 'detail': its kind, mapping, or target.
 * - 'step': one color step it runs after its core.
 */
export type PipelineGraphLineRole = 'detail' | 'step' | 'title';

export type PipelineGraphLine = Readonly<{
    role: PipelineGraphLineRole
    text: string
}>;

export type PipelineGraphNodeKind = 'canvas' | 'pass' | 'source';

export type PipelineGraphNode = Readonly<{
    height: number
    id: string
    kind: PipelineGraphNodeKind
    lines: readonly PipelineGraphLine[]
    width: number
    x: number
    y: number
}>;

/**
 * - 'adjacent': to the next column, between the facing sides of the nodes.
 * - 'forward': past at least one column, arcing below the nodes.
 * - 'backward': to the same or an earlier column, arcing above the nodes, as a history read of a later pass's texture does.
 */
export type PipelineGraphEdgeRoute = 'adjacent' | 'backward' | 'forward';

/** One texture read, the source read, or the canvas write, as a cubic Bezier from its writer to its reader. */
export type PipelineGraphEdge = Readonly<{
    end: PipelineGraphPoint
    endControl: PipelineGraphPoint
    fromNodeId: string
    /** 0 reads the current frame, -1 the previous frame, and so on */
    historyOffset: number
    /** The history offset as a pass header writes it, such as [-1], or null for a current-frame read */
    label: string | null
    /** The center of the label, beside the edge's midpoint */
    labelPosition: PipelineGraphPoint
    route: PipelineGraphEdgeRoute
    start: PipelineGraphPoint
    startControl: PipelineGraphPoint
    /** The texture the edge carries, or null for the source read and the canvas write */
    textureId: string | null
    toNodeId: string
}>;

export type PipelineGraphLayout = Readonly<{
    edges: readonly PipelineGraphEdge[]
    height: number
    nodes: readonly PipelineGraphNode[]
    width: number
}>;

const SOURCE_NODE_ID = 'source';
const CANVAS_NODE_ID = 'canvas';
const PASS_NODE_ID_PREFIX = 'pass-';
const SOURCE_COLUMN = 0;
const TARGET_PREFIX = '-> ';
const CANVAS_NAME = 'canvas';
// A forward edge that skips no column is adjacent, so forward arcs span at least two columns
const MINIMUM_FORWARD_ARC_SPAN = 2;
// B(1/2) of a cubic Bezier weighs its end points 1 and its control points 3, over 8
const BEZIER_MIDPOINT_CONTROL_WEIGHT = 3;
const BEZIER_MIDPOINT_DIVISOR = 8;
const HALF = 0.5;

/**
 * Where an edge meets a node.
 * Adjacent edges use the facing sides; arcs leave from the right half of a node's top or bottom and arrive on its left half.
 */
type PortSide = 'bottom-in' | 'bottom-out' | 'left' | 'right' | 'top-in' | 'top-out';

const ROUTE_PORT_SIDES: Readonly<Record<PipelineGraphEdgeRoute, Readonly<{ from: PortSide; to: PortSide }>>> = Object.freeze({
    adjacent: { from: 'right', to: 'left' },
    backward: { from: 'top-out', to: 'top-in' },
    forward: { from: 'bottom-out', to: 'bottom-in' }
});

type GraphColumn = Readonly<{
    id: string
    kind: PipelineGraphNodeKind
    lines: readonly PipelineGraphLine[]
}>;

type ColumnEdge = Readonly<{
    fromColumn: number
    historyOffset: number
    textureId: string | null
    toColumn: number
}>;

type RoutedEdge = ColumnEdge & Readonly<{
    /** How far its arc reaches beyond the nodes; 0 for an adjacent edge */
    depth: number
    fromPortIndex: number
    route: PipelineGraphEdgeRoute
    toPortIndex: number
}>;

/**
 * Lays out a plan as the source, one node per planned pass in plan order, and the canvas, from left to right.
 * Edges follow the textures from the pass that writes each to every pass that reads it, history reads included.
 */
export function layoutPipelineGraph(plan: PresentationPlan, route: ActiveRoute | null): PipelineGraphLayout {
    const columns = describeColumns(plan, route);
    const edges = routeEdges(collectColumnEdges(plan));
    const geometry = PIPELINE_GRAPH_GEOMETRY;
    const backwardDepth = getMaximumDepth(edges, 'backward');
    const forwardDepth = getMaximumDepth(edges, 'forward');
    const nodesTop = geometry.margin + getArcRoom(backwardDepth);
    const nodes: PipelineGraphNode[] = [];
    let nodesBottom = nodesTop;
    for (const [ column, graphColumn ] of columns.entries()) {
        const height = getNodeHeight(graphColumn.lines.length);
        nodesBottom = Math.max(nodesBottom, nodesTop + height);
        nodes.push({
            height,
            id: graphColumn.id,
            kind: graphColumn.kind,
            lines: graphColumn.lines,
            width: geometry.nodeWidth,
            x: geometry.margin + column * (geometry.nodeWidth + geometry.columnGap),
            y: nodesTop
        });
    }
    const portCounts = countPorts(edges);
    const positionedEdges: PipelineGraphEdge[] = [];
    for (const edge of edges) {
        positionedEdges.push(positionEdge(edge, nodes, portCounts, nodesTop, nodesBottom));
    }
    return {
        edges: positionedEdges,
        height: nodesBottom + getArcRoom(forwardDepth) + geometry.margin,
        nodes,
        width: 2 * geometry.margin + columns.length * geometry.nodeWidth + (columns.length - 1) * geometry.columnGap
    };
}

/** Formats an edge as an SVG path. */
export function formatPipelineGraphEdgePath(edge: PipelineGraphEdge): string {
    const { end, endControl, start, startControl } = edge;
    return `M ${start.x} ${start.y} C ${startControl.x} ${startControl.y}, ${endControl.x} ${endControl.y}, ${end.x} ${end.y}`;
}

function describeColumns(plan: PresentationPlan, route: ActiveRoute | null): GraphColumn[] {
    const textures = new Map<string, PlannedTexture>();
    for (const texture of plan.textures) {
        textures.set(texture.id, texture);
    }
    const columns: GraphColumn[] = [];
    columns.push({ id: SOURCE_NODE_ID, kind: 'source', lines: describeSource(plan, route) });
    for (const [ index, pass ] of plan.passes.entries()) {
        columns.push({ id: `${PASS_NODE_ID_PREFIX}${index}`, kind: 'pass', lines: describePass(pass, textures) });
    }
    columns.push({ id: CANVAS_NODE_ID, kind: 'canvas', lines: describeCanvas(plan.output) });
    return columns;
}

function describeSource(plan: PresentationPlan, route: ActiveRoute | null): PipelineGraphLine[] {
    const lines: PipelineGraphLine[] = [];
    lines.push({ role: 'title', text: `Source: ${plan.sourceKind}` });
    if (route === null) {
        lines.push({ role: 'detail', text: 'route unknown' });
        return lines;
    }
    lines.push({ role: 'detail', text: `decoder ${route.videoDecoderBackend}` });
    const transport = `transport ${route.videoOutputMode}`;
    lines.push({ role: 'detail', text: route.rawVideoFrameFormat === null ? transport : `${transport} ${route.rawVideoFrameFormat}` });
    if (route.dolbyVisionProfile !== null) {
        lines.push({ role: 'detail', text: `Dolby Vision profile ${route.dolbyVisionProfile}` });
    }
    if (route.nativeHDRTransfer !== null) {
        lines.push({ role: 'detail', text: `native HDR ${route.nativeHDRTransfer}` });
    }
    return lines;
}

function describePass(pass: PlannedPass, textures: ReadonlyMap<string, PlannedTexture>): PipelineGraphLine[] {
    const lines: PipelineGraphLine[] = [];
    lines.push({ role: 'title', text: pass.label });
    lines.push({ role: 'detail', text: describePassKind(pass) });
    if (pass.target?.kind === 'output') {
        lines.push({ role: 'detail', text: `${TARGET_PREFIX}${CANVAS_NAME}` });
    }
    for (const textureId of getWrittenTextureIds(pass)) {
        lines.push({ role: 'detail', text: `${TARGET_PREFIX}${textureId}` });
        const texture = textures.get(textureId);
        if (texture) {
            lines.push({ role: 'detail', text: describeTexture(texture) });
        }
    }
    for (const step of pass.colorSteps) {
        lines.push({ role: 'step', text: step });
    }
    return lines;
}

function describePassKind(pass: PlannedPass): string {
    switch (pass.kind) {
        case 'render':
            return `${pass.kind}${VALUE_SEPARATOR}${pass.coordinateMapping}`;
        case 'compute':
            return pass.workgroupCounts === null ?
                `${pass.kind}${VALUE_SEPARATOR}indirect` :
                `${pass.kind}${VALUE_SEPARATOR}${formatExtent(pass.workgroupCounts)} workgroups`;
    }
}

/** A texture's size and format, and the depth of its history ring when it has one. */
function describeTexture(texture: PlannedTexture): string {
    const description = `${formatDimensions(texture.width, texture.height)} ${texture.format}`;
    return texture.historyDepth > 0 ? `${description}${VALUE_SEPARATOR}history ${texture.historyDepth}` : description;
}

function describeCanvas(output: PlannedOutput): PipelineGraphLine[] {
    const lines: PipelineGraphLine[] = [];
    lines.push({ role: 'title', text: 'Canvas' });
    lines.push({ role: 'detail', text: output.format });
    lines.push({ role: 'detail', text: `${output.colorSpace}${VALUE_SEPARATOR}${output.toneMapping} tone mapping` });
    return lines;
}

/** The textures a pass writes: a render pass's target, or a compute pass's storage bindings. */
function getWrittenTextureIds(pass: PlannedPass): string[] {
    const textureIds: string[] = [];
    if (pass.target?.kind === 'texture') {
        textureIds.push(pass.target.textureId);
    }
    for (const binding of pass.bindings) {
        if (binding.kind === 'texture' && binding.access === 'storage' && !textureIds.includes(binding.textureId)) {
            textureIds.push(binding.textureId);
        }
    }
    return textureIds;
}

/** Collects each distinct read: the source by the passes that read it, every sampled texture by its reader, and the canvas by the pass that draws it. */
function collectColumnEdges(plan: PresentationPlan): ColumnEdge[] {
    const writerColumns = getWriterColumns(plan.passes);
    const canvasColumn = plan.passes.length + 1;
    const edges: ColumnEdge[] = [];
    const edgeKeys = new Set<string>();
    for (const [ index, pass ] of plan.passes.entries()) {
        const column = index + 1;
        for (const edge of getPassEdges(pass, column, writerColumns, canvasColumn)) {
            const key = `${edge.fromColumn}:${edge.toColumn}:${edge.textureId ?? ''}:${edge.historyOffset}`;
            if (!edgeKeys.has(key)) {
                edgeKeys.add(key);
                edges.push(edge);
            }
        }
    }
    return edges;
}

/** Maps each texture to the column of the first pass that writes it. */
function getWriterColumns(passes: readonly PlannedPass[]): ReadonlyMap<string, number> {
    const writerColumns = new Map<string, number>();
    for (const [ index, pass ] of passes.entries()) {
        for (const textureId of getWrittenTextureIds(pass)) {
            if (!writerColumns.has(textureId)) {
                writerColumns.set(textureId, index + 1);
            }
        }
    }
    return writerColumns;
}

function getPassEdges(
    pass: PlannedPass,
    column: number,
    writerColumns: ReadonlyMap<string, number>,
    canvasColumn: number
): ColumnEdge[] {
    const edges: ColumnEdge[] = [];
    if (pass.inputTextureId === null) {
        edges.push({ fromColumn: SOURCE_COLUMN, historyOffset: 0, textureId: null, toColumn: column });
    }
    for (const binding of pass.bindings) {
        if (binding.kind !== 'texture' || binding.access !== 'sampled') {
            continue;
        }
        const writerColumn = writerColumns.get(binding.textureId);
        if (writerColumn !== undefined) {
            edges.push({ fromColumn: writerColumn, historyOffset: binding.historyOffset, textureId: binding.textureId, toColumn: column });
        }
    }
    if (pass.target?.kind === 'output') {
        edges.push({ fromColumn: column, historyOffset: 0, textureId: null, toColumn: canvasColumn });
    }
    return edges;
}

/** Routes each edge and gives it a port on each node side it uses, in edge order. */
function routeEdges(edges: readonly ColumnEdge[]): RoutedEdge[] {
    const nextPortIndexes = new Map<string, number>();
    const takePortIndex = (column: number, side: PortSide): number => {
        const key = getPortKey(column, side);
        const portIndex = nextPortIndexes.get(key) ?? 0;
        nextPortIndexes.set(key, portIndex + 1);
        return portIndex;
    };
    const routedEdges: RoutedEdge[] = [];
    for (const edge of edges) {
        const route = getEdgeRoute(edge);
        const sides = ROUTE_PORT_SIDES[route];
        routedEdges.push({
            ...edge,
            depth: getArcDepth(edge, route),
            fromPortIndex: takePortIndex(edge.fromColumn, sides.from),
            route,
            toPortIndex: takePortIndex(edge.toColumn, sides.to)
        });
    }
    return routedEdges;
}

function getEdgeRoute(edge: ColumnEdge): PipelineGraphEdgeRoute {
    const span = edge.toColumn - edge.fromColumn;
    if (span <= 0) {
        return 'backward';
    }
    return span < MINIMUM_FORWARD_ARC_SPAN ? 'adjacent' : 'forward';
}

/** Arcs over more columns reach further, so nested arcs stay apart. */
function getArcDepth(edge: ColumnEdge, route: PipelineGraphEdgeRoute): number {
    const geometry = PIPELINE_GRAPH_GEOMETRY;
    switch (route) {
        case 'adjacent':
            return 0;
        case 'forward':
            return geometry.arcDepth + (edge.toColumn - edge.fromColumn - MINIMUM_FORWARD_ARC_SPAN) * geometry.arcDepthStep;
        case 'backward':
            return geometry.arcDepth + (edge.fromColumn - edge.toColumn) * geometry.arcDepthStep;
    }
}

function getMaximumDepth(edges: readonly RoutedEdge[], route: PipelineGraphEdgeRoute): number {
    let maximumDepth = 0;
    for (const edge of edges) {
        if (edge.route === route) {
            maximumDepth = Math.max(maximumDepth, edge.depth);
        }
    }
    return maximumDepth;
}

/** The room arcs of a depth take beyond the nodes, with their labels; none without arcs. */
function getArcRoom(depth: number): number {
    return depth > 0 ? depth + PIPELINE_GRAPH_GEOMETRY.labelHeight : 0;
}

function getNodeHeight(lineCount: number): number {
    return 2 * PIPELINE_GRAPH_GEOMETRY.nodePadding + lineCount * PIPELINE_GRAPH_GEOMETRY.lineHeight;
}

function getPortKey(column: number, side: PortSide): string {
    return `${column}:${side}`;
}

function countPorts(edges: readonly RoutedEdge[]): ReadonlyMap<string, number> {
    const portCounts = new Map<string, number>();
    for (const edge of edges) {
        const sides = ROUTE_PORT_SIDES[edge.route];
        for (const key of [ getPortKey(edge.fromColumn, sides.from), getPortKey(edge.toColumn, sides.to) ]) {
            portCounts.set(key, (portCounts.get(key) ?? 0) + 1);
        }
    }
    return portCounts;
}

/** Spreads a side's ports evenly: along a facing side, or over the left or right half of a top or bottom. */
function getPortPoint(node: PipelineGraphNode, side: PortSide, portIndex: number, portCount: number): PipelineGraphPoint {
    const fraction = (portIndex + 1) / (portCount + 1);
    const bottom = node.y + node.height;
    switch (side) {
        case 'left':
            return { x: node.x, y: node.y + node.height * fraction };
        case 'right':
            return { x: node.x + node.width, y: node.y + node.height * fraction };
        case 'bottom-in':
            return { x: node.x + node.width * HALF * fraction, y: bottom };
        case 'bottom-out':
            return { x: node.x + node.width * HALF * (1 + fraction), y: bottom };
        case 'top-in':
            return { x: node.x + node.width * HALF * fraction, y: node.y };
        case 'top-out':
            return { x: node.x + node.width * HALF * (1 + fraction), y: node.y };
    }
}

function positionEdge(
    edge: RoutedEdge,
    nodes: readonly PipelineGraphNode[],
    portCounts: ReadonlyMap<string, number>,
    nodesTop: number,
    nodesBottom: number
): PipelineGraphEdge {
    const fromNode = nodes[edge.fromColumn];
    const toNode = nodes[edge.toColumn];
    const sides = ROUTE_PORT_SIDES[edge.route];
    const start = getPortPoint(fromNode, sides.from, edge.fromPortIndex, portCounts.get(getPortKey(edge.fromColumn, sides.from)) ?? 1);
    const end = getPortPoint(toNode, sides.to, edge.toPortIndex, portCounts.get(getPortKey(edge.toColumn, sides.to)) ?? 1);
    const labelOffset = PIPELINE_GRAPH_GEOMETRY.labelHeight * HALF;
    let startControl: PipelineGraphPoint;
    let endControl: PipelineGraphPoint;
    let labelPosition: PipelineGraphPoint;
    switch (edge.route) {
        case 'adjacent': {
            const halfSpan = (end.x - start.x) * HALF;
            startControl = { x: start.x + halfSpan, y: start.y };
            endControl = { x: end.x - halfSpan, y: end.y };
            labelPosition = { x: (start.x + end.x) * HALF, y: (start.y + end.y) * HALF - labelOffset };
            break;
        }
        case 'forward': {
            const apexY = nodesBottom + edge.depth;
            const controlY = getArcControlY(apexY, start.y, end.y);
            startControl = { x: start.x, y: controlY };
            endControl = { x: end.x, y: controlY };
            labelPosition = { x: (start.x + end.x) * HALF, y: apexY + labelOffset };
            break;
        }
        case 'backward': {
            const apexY = nodesTop - edge.depth;
            const controlY = getArcControlY(apexY, start.y, end.y);
            startControl = { x: start.x, y: controlY };
            endControl = { x: end.x, y: controlY };
            labelPosition = { x: (start.x + end.x) * HALF, y: apexY - labelOffset };
            break;
        }
    }
    return {
        end,
        endControl,
        fromNodeId: fromNode.id,
        historyOffset: edge.historyOffset,
        label: edge.historyOffset === 0 ? null : `[${edge.historyOffset}]`,
        labelPosition,
        route: edge.route,
        start,
        startControl,
        textureId: edge.textureId,
        toNodeId: toNode.id
    };
}

/**
 * Returns the height both control points of an arc take so that its midpoint reaches the apex.
 * With control points at one height c, B(1/2).y = (y0 + 6c + y3) / 8, so c = (8 apex - y0 - y3) / 6.
 */
function getArcControlY(apexY: number, startY: number, endY: number): number {
    return (BEZIER_MIDPOINT_DIVISOR * apexY - startY - endY) / (2 * BEZIER_MIDPOINT_CONTROL_WEIGHT);
}
