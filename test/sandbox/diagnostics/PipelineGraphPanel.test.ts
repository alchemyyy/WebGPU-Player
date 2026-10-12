import { describe, expect, it } from 'vitest';

import type { PassRejection, PlanReport, PresentationPlan } from 'webgpu-player/presentation/passes/PassTypes';

import { layoutPipelineGraph } from '../../../sandbox/src/ui/diagnostics/PipelineGraphLayout';
import type { PanelContext } from '../../../sandbox/src/ui/Panel';
import { createPipelineGraphPanel } from '../../../sandbox/src/ui/panels/PipelineGraphPanel';
import { createFakePanelContext } from '../shell/sandboxFakes';
import {
    createPlannedPass,
    createPlannedTexture,
    createPresentationPlan,
    createSampledBindings
} from './diagnosticsTestState';

const TEXTURE_WIDTH = 1920;
const TEXTURE_HEIGHT = 1080;
const TEMPORAL_TEXTURE_ID = 'pass:Temporal';
const TEMPORAL_LABEL = 'Presentation pass \'Temporal\'';
const OUTPUT_LABEL = 'Presentation output';
const CURRENT_FRAME = 0;
const PREVIOUS_FRAME = -1;
const PREVIOUS_FRAME_LABEL = '[-1]';
const COMPILE_ERROR_REJECTION: PassRejection = { detail: 'line 4: unknown identifier \'gain\'', name: 'Broken', reason: 'compile-error' };
const CONDITION_FALSE_REJECTION: PassRejection = { detail: 'hdr.source', name: 'HDR only', reason: 'condition-false' };
const EMPTY_REPORT: PlanReport = { activePasses: [], inactivePasses: [] };

const NODE_SELECTOR = '.pipeline-graph-node';
const EDGE_SELECTOR = '.pipeline-graph-edge';
const EDGE_LABEL_SELECTOR = '.pipeline-graph-edge-label';
const SCROLLER_SELECTOR = '.pipeline-graph-scroller';
const LEFT_OUT_SELECTOR = '.pipeline-graph-left-out';
const LEFT_OUT_PASS_SELECTOR = '.pipeline-graph-left-out-pass';

/** A temporal kernel that reads its own previous output, and the output pass over it. */
function createTemporalPlan(): PresentationPlan {
    return createPresentationPlan({
        passes: [
            createPlannedPass({
                bindings: createSampledBindings([ { historyOffset: PREVIOUS_FRAME, textureId: TEMPORAL_TEXTURE_ID } ]),
                label: TEMPORAL_LABEL,
                target: { kind: 'texture', textureId: TEMPORAL_TEXTURE_ID }
            }),
            createPlannedPass({
                bindings: createSampledBindings([ { historyOffset: CURRENT_FRAME, textureId: TEMPORAL_TEXTURE_ID } ]),
                inputTextureId: TEMPORAL_TEXTURE_ID,
                label: OUTPUT_LABEL
            })
        ],
        textures: [ createPlannedTexture({ height: TEXTURE_HEIGHT, historyDepth: -PREVIOUS_FRAME, id: TEMPORAL_TEXTURE_ID, width: TEXTURE_WIDTH }) ]
    });
}

function installPlan(context: PanelContext, plan: PresentationPlan | null, planReport: PlanReport = EMPTY_REPORT): void {
    context.store.setState(state => ({ presentation: { ...state.presentation, plan, report: planReport } }));
}

function requireElement(panelElement: HTMLElement, selector: string): HTMLElement {
    const element = panelElement.querySelector<HTMLElement>(selector);
    if (!element) {
        throw new Error(`missing ${selector}`);
    }
    return element;
}

describe('createPipelineGraphPanel', () => {
    it('takes no room until the presenter installs a plan', () => {
        const panel = createPipelineGraphPanel(createFakePanelContext());

        expect(panel.element.hidden).toBe(true);
        expect(panel.element.querySelectorAll(NODE_SELECTOR)).toHaveLength(0);
        panel.destroy();
    });

    it('draws the plan\'s nodes at their layout positions and an edge per read, labelling history reads', () => {
        const context = createFakePanelContext();
        const panel = createPipelineGraphPanel(context);
        const plan = createTemporalPlan();
        const layout = layoutPipelineGraph(plan, null);

        installPlan(context, plan);
        const nodes = panel.element.querySelectorAll<HTMLElement>(NODE_SELECTOR);

        expect(panel.element.hidden).toBe(false);
        expect(nodes).toHaveLength(layout.nodes.length);
        for (const [ index, node ] of layout.nodes.entries()) {
            expect(nodes[index].style.left).toBe(`${node.x}px`);
            expect(nodes[index].style.top).toBe(`${node.y}px`);
            expect(nodes[index].textContent).toBe(node.lines.map((line): string => line.text).join(''));
        }
        expect(panel.element.querySelectorAll(EDGE_SELECTOR)).toHaveLength(layout.edges.length);
        expect(panel.element.querySelectorAll(`${EDGE_SELECTOR}[data-history]`)).toHaveLength(1);
        expect(panel.element.querySelector(EDGE_LABEL_SELECTOR)?.textContent).toBe(PREVIOUS_FRAME_LABEL);
        panel.destroy();
    });

    it('lists the passes the plan left out with their reason and detail, toned by whether they failed', () => {
        const context = createFakePanelContext();
        const panel = createPipelineGraphPanel(context);
        const leftOut = requireElement(panel.element, LEFT_OUT_SELECTOR);

        installPlan(context, createTemporalPlan());

        expect(leftOut.hidden).toBe(true);
        installPlan(context, createTemporalPlan(), { activePasses: [], inactivePasses: [ COMPILE_ERROR_REJECTION, CONDITION_FALSE_REJECTION ] });
        const items = [ ...panel.element.querySelectorAll<HTMLElement>(LEFT_OUT_PASS_SELECTOR) ];

        expect(leftOut.hidden).toBe(false);
        expect(items.map((item: HTMLElement): string | null => item.textContent)).toEqual([
            `${COMPILE_ERROR_REJECTION.name}${COMPILE_ERROR_REJECTION.reason}: ${COMPILE_ERROR_REJECTION.detail}`,
            `${CONDITION_FALSE_REJECTION.name}${CONDITION_FALSE_REJECTION.reason}: ${CONDITION_FALSE_REJECTION.detail}`
        ]);
        expect(items.map((item: HTMLElement): string | undefined => item.dataset.tone)).toEqual([ 'failure', 'muted' ]);
        panel.destroy();
    });

    it('shows the left-out passes alone while no plan is installed', () => {
        const context = createFakePanelContext();
        const panel = createPipelineGraphPanel(context);

        installPlan(context, null, { activePasses: [], inactivePasses: [ COMPILE_ERROR_REJECTION ] });

        expect(panel.element.hidden).toBe(false);
        expect(requireElement(panel.element, SCROLLER_SELECTOR).hidden).toBe(true);
        expect(requireElement(panel.element, LEFT_OUT_SELECTOR).hidden).toBe(false);
        panel.destroy();
    });

    it('stops following the store once destroyed', () => {
        const context = createFakePanelContext();
        const panel = createPipelineGraphPanel(context);

        panel.destroy();
        installPlan(context, createTemporalPlan());

        expect(panel.element.querySelectorAll(NODE_SELECTOR)).toHaveLength(0);
    });
});
