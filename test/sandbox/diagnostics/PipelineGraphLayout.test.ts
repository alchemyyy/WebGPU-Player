import { describe, expect, it } from 'vitest';

import { createSDRColorMetadata } from 'webgpu-player/color/ColorMetadata';
import { createBuiltinChain } from 'webgpu-player/presentation/passes/builtin/BuiltinChains';
import { parsePassManifest } from 'webgpu-player/presentation/passes/PassManifest';
import type { PlannedPass, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';
import { planPresentation } from 'webgpu-player/presentation/passes/PresentationPlanner';
import { TEMPORAL_BLEND_KERNEL_PASS } from 'webgpu-player/presentation/passes/examples/TemporalBlendKernelPass';
import { createDefaultRenderSettings } from 'webgpu-player/presentation/RenderSettings';

import {
    formatPipelineGraphEdgePath,
    layoutPipelineGraph,
    PIPELINE_GRAPH_GEOMETRY,
    type PipelineGraphEdge,
    type PipelineGraphLayout,
    type PipelineGraphNode
} from '../../../sandbox/src/ui/diagnostics/PipelineGraphLayout';
import {
    createActiveRoute,
    createPlannedPass,
    createPlannedTexture,
    createPresentationPlan,
    createSampledBindings,
    TEST_CANVAS_OUTPUT
} from './diagnosticsTestState';

const SOURCE_WIDTH = 1920;
const SOURCE_HEIGHT = 1080;
const OUTPUT_WIDTH = 2560;
const OUTPUT_HEIGHT = 1440;
const MAXIMUM_TEXTURE_DIMENSION = 8192;
const STORAGE_FORMAT: GPUTextureFormat = 'rgba8unorm';

const SIGNAL_TEXTURE_ID = 'signal';
const KERNEL_TEXTURE_ID = 'pass:Sharpen';
const TEMPORAL_TEXTURE_ID = 'pass:Temporal';
const COMPUTE_TEXTURE_ID = 'pass:Compute';
const SIGNAL_LABEL = 'Presentation signal';
const KERNEL_LABEL = 'Presentation pass \'Sharpen\'';
const TEMPORAL_LABEL = 'Presentation pass \'Temporal\'';
const COMPUTE_LABEL = 'Presentation pass \'Compute\'';
const OUTPUT_LABEL = 'Presentation output';
const TRANSFER_DECODE_STEP = 'builtin.transfer-decode';
const TONE_MAP_STEP = 'builtin.tone-map';
const DITHER_STEP = 'builtin.dither';
const CURRENT_FRAME = 0;
const PREVIOUS_FRAME = -1;
const PREVIOUS_FRAME_LABEL = '[-1]';
const HISTORY_DEPTH = 1;
const WORKGROUP_COUNTS = [ 240, 135, 1 ] as const;
const WORKGROUP_TEXT = '240x135x1';
const TEMPORAL_PASS_NAME = 'Temporal blend';

const SOURCE_NODE_ID = 'source';
const CANVAS_NODE_ID = 'canvas';
const FIRST_PASS_NODE_ID = 'pass-0';
const SECOND_PASS_NODE_ID = 'pass-1';
const THIRD_PASS_NODE_ID = 'pass-2';
// Two ports on one side sit at a third and two thirds of it
const FIRST_OF_TWO_PORTS = 1 / 3;
const SECOND_OF_TWO_PORTS = 2 / 3;
const HALF = 0.5;

const ROUTE_DECODER = 'native';
const ROUTE_TRANSPORT = 'raw-planes';
const ROUTE_RAW_FORMAT = 'I420P10';
const ROUTE_DOLBY_VISION_PROFILE = 8;
const ROUTE_HDR_TRANSFER = 'pq';

function createSignalPass(overrides: Partial<PlannedPass> = {}): PlannedPass {
    return createPlannedPass({ colorSteps: [ TRANSFER_DECODE_STEP ], label: SIGNAL_LABEL, target: { kind: 'texture', textureId: SIGNAL_TEXTURE_ID }, ...overrides });
}

function createOutputPass(inputTextureId: string, overrides: Partial<PlannedPass> = {}): PlannedPass {
    return createPlannedPass({
        bindings: createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: inputTextureId } ]),
        colorSteps: [ TONE_MAP_STEP, DITHER_STEP ],
        coordinateMapping: 'object-fit',
        inputTextureId,
        label: OUTPUT_LABEL,
        ...overrides
    });
}

/** Signal, a kernel over it, and the output pass over the kernel. */
function createChainPlan(): PresentationPlan {
    return createPresentationPlan({
        passes: [
            createSignalPass(),
            createPlannedPass({
                bindings: createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID } ]),
                inputTextureId: SIGNAL_TEXTURE_ID,
                label: KERNEL_LABEL,
                target: { kind: 'texture', textureId: KERNEL_TEXTURE_ID }
            }),
            createOutputPass(KERNEL_TEXTURE_ID)
        ],
        textures: [
            createPlannedTexture({ height: SOURCE_HEIGHT, id: SIGNAL_TEXTURE_ID, width: SOURCE_WIDTH }),
            createPlannedTexture({ height: SOURCE_HEIGHT, id: KERNEL_TEXTURE_ID, width: SOURCE_WIDTH })
        ]
    });
}

/** Signal, a temporal kernel that also reads its own previous output, and the output pass. */
function createTemporalPlan(): PresentationPlan {
    return createPresentationPlan({
        passes: [
            createSignalPass(),
            createPlannedPass({
                bindings: createSampledBindings([
                    { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID },
                    { historyOffset: PREVIOUS_FRAME, textureId: TEMPORAL_TEXTURE_ID }
                ]),
                inputTextureId: SIGNAL_TEXTURE_ID,
                label: TEMPORAL_LABEL,
                target: { kind: 'texture', textureId: TEMPORAL_TEXTURE_ID }
            }),
            createOutputPass(TEMPORAL_TEXTURE_ID)
        ],
        textures: [
            createPlannedTexture({ height: SOURCE_HEIGHT, id: SIGNAL_TEXTURE_ID, width: SOURCE_WIDTH }),
            createPlannedTexture({ height: SOURCE_HEIGHT, historyDepth: HISTORY_DEPTH, id: TEMPORAL_TEXTURE_ID, width: SOURCE_WIDTH })
        ]
    });
}

function requireNode(layout: PipelineGraphLayout, nodeId: string): PipelineGraphNode {
    const node = layout.nodes.find((candidate: PipelineGraphNode): boolean => candidate.id === nodeId);
    if (!node) {
        throw new Error(`missing node ${nodeId}`);
    }
    return node;
}

function findEdges(layout: PipelineGraphLayout, fromNodeId: string, toNodeId: string): PipelineGraphEdge[] {
    return layout.edges.filter((edge: PipelineGraphEdge): boolean => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId);
}

function getLineTexts(node: PipelineGraphNode): string[] {
    return node.lines.map((line): string => line.text);
}

function getNodeBottom(node: PipelineGraphNode): number {
    return node.y + node.height;
}

describe('layoutPipelineGraph', () => {
    it('places the source, each planned pass in plan order, and the canvas from left to right', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(layout.nodes.map((node: PipelineGraphNode): string => node.id)).toEqual([
            SOURCE_NODE_ID,
            FIRST_PASS_NODE_ID,
            SECOND_PASS_NODE_ID,
            THIRD_PASS_NODE_ID,
            CANVAS_NODE_ID
        ]);
        expect(layout.nodes.map((node: PipelineGraphNode): string => node.kind)).toEqual([ 'source', 'pass', 'pass', 'pass', 'canvas' ]);
        for (const [ column, node ] of layout.nodes.entries()) {
            expect(node.x).toBe(PIPELINE_GRAPH_GEOMETRY.margin + column * (PIPELINE_GRAPH_GEOMETRY.nodeWidth + PIPELINE_GRAPH_GEOMETRY.columnGap));
            expect(node.y).toBe(PIPELINE_GRAPH_GEOMETRY.margin);
        }
    });

    it('sizes each node by its lines and the graph by its columns', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);
        const columnCount = layout.nodes.length;
        let tallestNodeHeight = 0;

        for (const node of layout.nodes) {
            expect(node.width).toBe(PIPELINE_GRAPH_GEOMETRY.nodeWidth);
            expect(node.height).toBe(2 * PIPELINE_GRAPH_GEOMETRY.nodePadding + node.lines.length * PIPELINE_GRAPH_GEOMETRY.lineHeight);
            tallestNodeHeight = Math.max(tallestNodeHeight, node.height);
        }
        expect(layout.width).toBe(2 * PIPELINE_GRAPH_GEOMETRY.margin + columnCount * PIPELINE_GRAPH_GEOMETRY.nodeWidth + (columnCount - 1) * PIPELINE_GRAPH_GEOMETRY.columnGap);
        expect(layout.height).toBe(2 * PIPELINE_GRAPH_GEOMETRY.margin + tallestNodeHeight);
    });

    it('labels the source with its kind and the active route', () => {
        const route = createActiveRoute({
            dolbyVisionProfile: ROUTE_DOLBY_VISION_PROFILE,
            nativeHDRTransfer: ROUTE_HDR_TRANSFER,
            rawVideoFrameFormat: ROUTE_RAW_FORMAT,
            videoDecoderBackend: ROUTE_DECODER,
            videoOutputMode: ROUTE_TRANSPORT
        });
        const plan = createChainPlan();

        expect(getLineTexts(requireNode(layoutPipelineGraph(plan, route), SOURCE_NODE_ID))).toEqual([
            `Source: ${plan.sourceKind}`,
            `decoder ${ROUTE_DECODER}`,
            `transport ${ROUTE_TRANSPORT} ${ROUTE_RAW_FORMAT}`,
            `Dolby Vision profile ${ROUTE_DOLBY_VISION_PROFILE}`,
            `native HDR ${ROUTE_HDR_TRANSFER}`
        ]);
        expect(getLineTexts(requireNode(layoutPipelineGraph(plan, null), SOURCE_NODE_ID))).toEqual([ `Source: ${plan.sourceKind}`, 'route unknown' ]);
    });

    it('describes a pass by its label, kind, coordinate mapping, target, and color steps', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);
        const kernelNode = requireNode(layout, SECOND_PASS_NODE_ID);
        const outputNode = requireNode(layout, THIRD_PASS_NODE_ID);

        expect(getLineTexts(kernelNode)).toEqual([ KERNEL_LABEL, 'render, identity', `-> ${KERNEL_TEXTURE_ID}`, `${SOURCE_WIDTH}x${SOURCE_HEIGHT} rgba16float` ]);
        expect(getLineTexts(outputNode)).toEqual([ OUTPUT_LABEL, 'render, object-fit', '-> canvas', TONE_MAP_STEP, DITHER_STEP ]);
        expect(outputNode.lines.map((line): string => line.role)).toEqual([ 'title', 'detail', 'detail', 'step', 'step' ]);
    });

    it('describes the canvas by its format, color space, and tone mapping', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(getLineTexts(requireNode(layout, CANVAS_NODE_ID))).toEqual([
            'Canvas',
            TEST_CANVAS_OUTPUT.format,
            `${TEST_CANVAS_OUTPUT.colorSpace}, ${TEST_CANVAS_OUTPUT.toneMapping} tone mapping`
        ]);
    });

    it('connects the source to its reader, each texture to its readers, and the output pass to the canvas', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);

        expect(layout.edges.map((edge: PipelineGraphEdge) => [ edge.fromNodeId, edge.toNodeId, edge.textureId, edge.route ])).toEqual([
            [ SOURCE_NODE_ID, FIRST_PASS_NODE_ID, null, 'adjacent' ],
            [ FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID, SIGNAL_TEXTURE_ID, 'adjacent' ],
            [ SECOND_PASS_NODE_ID, THIRD_PASS_NODE_ID, KERNEL_TEXTURE_ID, 'adjacent' ],
            [ THIRD_PASS_NODE_ID, CANVAS_NODE_ID, null, 'adjacent' ]
        ]);
        for (const edge of layout.edges) {
            expect(edge.historyOffset).toBe(CURRENT_FRAME);
            expect(edge.label).toBeNull();
        }
    });

    it('runs an edge between adjacent columns from the writer\'s right side to the reader\'s left side', () => {
        const layout = layoutPipelineGraph(createChainPlan(), null);
        const writer = requireNode(layout, FIRST_PASS_NODE_ID);
        const reader = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ edge ] = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(edge.start).toEqual({ x: writer.x + writer.width, y: writer.y + writer.height * HALF });
        expect(edge.end).toEqual({ x: reader.x, y: reader.y + reader.height * HALF });
        expect(edge.startControl.y).toBe(edge.start.y);
        expect(edge.endControl.y).toBe(edge.end.y);
        expect(formatPipelineGraphEdgePath(edge)).toBe(
            `M ${edge.start.x} ${edge.start.y} C ${edge.startControl.x} ${edge.startControl.y}, ${edge.endControl.x} ${edge.endControl.y}, ${edge.end.x} ${edge.end.y}`
        );
    });

    it('marks a history read with its offset and a texture with a history ring with its depth', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null);
        const [ historyEdge ] = findEdges(layout, SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(historyEdge.historyOffset).toBe(PREVIOUS_FRAME);
        expect(historyEdge.label).toBe(PREVIOUS_FRAME_LABEL);
        expect(historyEdge.textureId).toBe(TEMPORAL_TEXTURE_ID);
        expect(getLineTexts(requireNode(layout, SECOND_PASS_NODE_ID))).toContain(`${SOURCE_WIDTH}x${SOURCE_HEIGHT} rgba16float, history ${HISTORY_DEPTH}`);
    });

    it('arcs a read of the same or a later pass above the nodes, leaving room for the arc and its label', () => {
        const layout = layoutPipelineGraph(createTemporalPlan(), null);
        const node = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ historyEdge ] = findEdges(layout, SECOND_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(historyEdge.route).toBe('backward');
        expect(historyEdge.start.y).toBe(node.y);
        expect(historyEdge.end.y).toBe(node.y);
        // It leaves from the right half of the top and comes back on the left half
        expect(historyEdge.start.x).toBeGreaterThan(node.x + node.width * HALF);
        expect(historyEdge.end.x).toBeLessThan(node.x + node.width * HALF);
        expect(historyEdge.startControl.y).toBeLessThan(node.y);
        expect(historyEdge.labelPosition.y).toBeLessThan(node.y - PIPELINE_GRAPH_GEOMETRY.arcDepth);
        expect(node.y).toBe(PIPELINE_GRAPH_GEOMETRY.margin + PIPELINE_GRAPH_GEOMETRY.arcDepth + PIPELINE_GRAPH_GEOMETRY.labelHeight);
    });

    it('arcs a read that skips a column below the nodes, leaving room for the arc and its label', () => {
        const chain = createChainPlan();
        const plan = createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                chain.passes[1],
                createOutputPass(KERNEL_TEXTURE_ID, {
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: KERNEL_TEXTURE_ID },
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ])
                })
            ]
        });
        const layout = layoutPipelineGraph(plan, null);
        const [ skipEdge ] = findEdges(layout, FIRST_PASS_NODE_ID, THIRD_PASS_NODE_ID);
        let nodesBottom = 0;
        for (const node of layout.nodes) {
            nodesBottom = Math.max(nodesBottom, getNodeBottom(node));
        }

        expect(skipEdge.route).toBe('forward');
        expect(skipEdge.textureId).toBe(SIGNAL_TEXTURE_ID);
        expect(skipEdge.start.y).toBe(getNodeBottom(requireNode(layout, FIRST_PASS_NODE_ID)));
        expect(skipEdge.end.y).toBe(getNodeBottom(requireNode(layout, THIRD_PASS_NODE_ID)));
        expect(skipEdge.startControl.y).toBeGreaterThan(nodesBottom);
        expect(layout.height).toBe(nodesBottom + PIPELINE_GRAPH_GEOMETRY.arcDepth + PIPELINE_GRAPH_GEOMETRY.labelHeight + PIPELINE_GRAPH_GEOMETRY.margin);
    });

    it('spreads several edges between the same nodes over distinct ports', () => {
        const chain = createChainPlan();
        const plan = createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                createPlannedPass({
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID },
                        { historyOffset: PREVIOUS_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ]),
                    inputTextureId: SIGNAL_TEXTURE_ID,
                    label: KERNEL_LABEL
                })
            ]
        });
        const layout = layoutPipelineGraph(plan, null);
        const writer = requireNode(layout, FIRST_PASS_NODE_ID);
        const reader = requireNode(layout, SECOND_PASS_NODE_ID);
        const [ currentEdge, historyEdge ] = findEdges(layout, FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID);

        expect(currentEdge.start.y).toBeCloseTo(writer.y + writer.height * FIRST_OF_TWO_PORTS);
        expect(historyEdge.start.y).toBeCloseTo(writer.y + writer.height * SECOND_OF_TWO_PORTS);
        expect(currentEdge.end.y).toBeCloseTo(reader.y + reader.height * FIRST_OF_TWO_PORTS);
        expect(historyEdge.end.y).toBeCloseTo(reader.y + reader.height * SECOND_OF_TWO_PORTS);
        expect(historyEdge.label).toBe(PREVIOUS_FRAME_LABEL);
    });

    it('draws one edge for repeated reads of a texture at one offset', () => {
        const chain = createChainPlan();
        const plan = createPresentationPlan({
            ...chain,
            passes: [
                chain.passes[0],
                createOutputPass(SIGNAL_TEXTURE_ID, {
                    bindings: createSampledBindings([
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID },
                        { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID }
                    ])
                })
            ]
        });

        expect(findEdges(layoutPipelineGraph(plan, null), FIRST_PASS_NODE_ID, SECOND_PASS_NODE_ID)).toHaveLength(1);
    });

    it('shows a compute pass\'s workgroup counts and follows its storage texture to its reader', () => {
        const plan = createPresentationPlan({
            passes: [
                createSignalPass(),
                createPlannedPass({
                    bindings: [
                        ...createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: SIGNAL_TEXTURE_ID } ]),
                        { access: 'storage', binding: 1, historyOffset: CURRENT_FRAME, kind: 'texture', textureId: COMPUTE_TEXTURE_ID }
                    ],
                    inputTextureId: SIGNAL_TEXTURE_ID,
                    kind: 'compute',
                    label: COMPUTE_LABEL,
                    target: null,
                    workgroupCounts: WORKGROUP_COUNTS
                }),
                createOutputPass(COMPUTE_TEXTURE_ID)
            ],
            textures: [
                createPlannedTexture({ height: SOURCE_HEIGHT, id: SIGNAL_TEXTURE_ID, width: SOURCE_WIDTH }),
                createPlannedTexture({ format: STORAGE_FORMAT, height: SOURCE_HEIGHT, id: COMPUTE_TEXTURE_ID, storage: true, width: SOURCE_WIDTH })
            ]
        });
        const layout = layoutPipelineGraph(plan, null);

        expect(getLineTexts(requireNode(layout, SECOND_PASS_NODE_ID))).toEqual([
            COMPUTE_LABEL,
            `compute, ${WORKGROUP_TEXT} workgroups`,
            `-> ${COMPUTE_TEXTURE_ID}`,
            `${SOURCE_WIDTH}x${SOURCE_HEIGHT} ${STORAGE_FORMAT}`
        ]);
        expect(findEdges(layout, SECOND_PASS_NODE_ID, THIRD_PASS_NODE_ID).map((edge: PipelineGraphEdge): string | null => edge.textureId)).toEqual([ COMPUTE_TEXTURE_ID ]);
    });

    it('draws the planner\'s temporal pass reading its own previous output', () => {
        const plan = planPresentation({
            chain: createBuiltinChain({ format: 'I420', hdrOutput: false, metadata: createSDRColorMetadata(), route: 'raw-yuv', settings: createDefaultRenderSettings() }),
            device: { features: new Set<string>(), maximumTextureDimension: MAXIMUM_TEXTURE_DIMENSION },
            facts: {
                frameRate: null,
                hdrOutput: false,
                hdrSource: false,
                outputHeight: OUTPUT_HEIGHT,
                outputWidth: OUTPUT_WIDTH,
                sourceHeight: SOURCE_HEIGHT,
                sourceWidth: SOURCE_WIDTH
            },
            output: TEST_CANVAS_OUTPUT,
            passes: [ parsePassManifest(TEMPORAL_BLEND_KERNEL_PASS) ]
        });
        const layout = layoutPipelineGraph(plan, null);
        const historyEdges = layout.edges.filter((edge: PipelineGraphEdge): boolean => edge.historyOffset === PREVIOUS_FRAME);

        expect(historyEdges).toHaveLength(1);
        expect(historyEdges[0].route).toBe('backward');
        expect(historyEdges[0].fromNodeId).toBe(historyEdges[0].toNodeId);
        expect(requireNode(layout, historyEdges[0].toNodeId).lines[0].text).toContain(TEMPORAL_PASS_NAME);
        expect(findEdges(layout, SOURCE_NODE_ID, FIRST_PASS_NODE_ID)).toHaveLength(1);
    });
});
