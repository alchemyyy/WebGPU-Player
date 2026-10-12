import { createPQColorMetadata } from '../src/color/ColorMetadata';
import { createBuiltinChain } from '../src/presentation/passes/builtin/BuiltinChains';
import { createPlannedOutput } from '../src/presentation/passes/PresentationExecutor';
import { planPresentation } from '../src/presentation/passes/PresentationPlanner';
import { createHDRToSDRRenderSettings } from '../src/presentation/RenderSettings';
import { READBACK_CANVAS_FORMATS } from '../src/presentation/WebGPUConstants';

const ROUTE = 'I420P10:bt2020-ncl:bt2020:limited:pq:hdr10plus';
// A default plan's module depends on no size and no canvas format, so any valid facts and SDR format plan the production module
const PLAN_DIMENSION = 1;
const PLAN_CANVAS_FORMAT = READBACK_CANVAS_FORMATS[0];
// The probe compiles one module, and a chain without user passes plans exactly one
const EXPECTED_PASS_COUNT = 1;

const metadata = createPQColorMetadata();
const plan = planPresentation({
    chain: createBuiltinChain({
        format: 'I420P10',
        hdrOutput: false,
        metadata,
        route: 'raw-yuv',
        settings: createHDRToSDRRenderSettings()
    }),
    device: { features: new Set<string>(), maximumTextureDimension: PLAN_DIMENSION },
    facts: {
        frameRate: null,
        hdrOutput: false,
        hdrSource: true,
        outputHeight: PLAN_DIMENSION,
        outputWidth: PLAN_DIMENSION,
        sourceHeight: PLAN_DIMENSION,
        sourceWidth: PLAN_DIMENSION
    },
    output: createPlannedOutput(false, PLAN_CANVAS_FORMAT),
    passes: []
});
if (plan.passes.length !== EXPECTED_PASS_COUNT) {
    throw new Error(`plan: ${plan.passes.length} passes, expected ${EXPECTED_PASS_COUNT}`);
}

process.stdout.write(JSON.stringify({
    route: ROUTE,
    shaderCode: plan.passes[0].code
}));
