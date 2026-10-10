// The audio decode worker, which a decode worker spawns for its decoded PCM attempts and keeps for its life
import { startAudioDecodeWorkerRuntime, type AudioDecodeWorkerScope } from './AudioDecodeWorkerRuntime';

startAudioDecodeWorkerRuntime(globalThis as unknown as AudioDecodeWorkerScope);
