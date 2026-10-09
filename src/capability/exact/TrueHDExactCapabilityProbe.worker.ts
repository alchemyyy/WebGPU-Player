import {
    isTrueHDExactCapabilityWorkerRequest,
    type TrueHDExactCapabilityWorkerResponse
} from './TrueHDExactCapabilityProtocol';
import {
    createTrueHDExactCapabilityRunnerEnvironment,
    runTrueHDExactCapabilityQualification
} from './TrueHDExactCapabilityRunner';

let probeStarted = false;

async function handleRequest(value: unknown): Promise<void> {
    if (probeStarted || !isTrueHDExactCapabilityWorkerRequest(value)) {
        return;
    }
    probeStarted = true;
    const response: TrueHDExactCapabilityWorkerResponse = await runTrueHDExactCapabilityQualification(
        createTrueHDExactCapabilityRunnerEnvironment(value.decoderWASM)
    );
    globalThis.postMessage(response);
}

// eslint-disable-next-line sonarjs/post-message -- Dedicated workers do not receive window origins
globalThis.addEventListener('message', (event: MessageEvent<unknown>): void => {
    void handleRequest(event.data);
});
