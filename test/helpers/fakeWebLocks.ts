// The Web Locks of one origin, shared by the pages a test opens: a page requests through its own view, and a page that stops frees its locks, as a browser frees a crashed page's.
// Only exclusive locks are granted: a request for a held lock waits for its release, or answers null at once with ifAvailable.
import type { CapabilityProbeLocks } from 'webgpu-player/capability/CapabilityProbeStore';

export type FakeWebLocks = Readonly<{
    /** Returns a page's view of the locks */
    forPage: (pageId: string) => CapabilityProbeLocks
    /** Frees every lock a page holds, as a browser does once the page stops */
    stopPage: (pageId: string) => void
}>;

type RequestArguments<Value> = [ LockGrantedCallback<Value> ] | [ LockOptions, LockGrantedCallback<Value> ];

export function createFakeWebLocks(): FakeWebLocks {
    // Each held lock's name, with the page that holds it, and the grants that wait for each name
    const holders = new Map<string, string>();
    const waitingGrants = new Map<string, Array<() => void>>();

    const releaseLock = (name: string): void => {
        holders.delete(name);
        waitingGrants.get(name)?.shift()?.();
    };

    const grantLock = <Value>(name: string, pageId: string, callback: LockGrantedCallback<Value>): Promise<Value> => {
        holders.set(name, pageId);
        const lock = { mode: 'exclusive', name } as Lock;
        // The lock stays held until the callback's result settles
        return Promise.resolve().then(() => callback(lock)).finally((): void => {
            if (holders.get(name) === pageId) {
                releaseLock(name);
            }
        });
    };

    const forPage = (pageId: string): CapabilityProbeLocks => {
        const request = <Value>(name: string, ...requestArguments: RequestArguments<Value>): Promise<Value> => {
            const [ options, callback ] = requestArguments.length === 1 ? [ {}, requestArguments[0] ] : requestArguments;
            if (!holders.has(name)) {
                return grantLock(name, pageId, callback);
            }
            if (options.ifAvailable === true) {
                return Promise.resolve().then(() => callback(null));
            }
            return new Promise<Value>((resolve, reject) => {
                const grants = waitingGrants.get(name) ?? [];
                grants.push((): void => {
                    grantLock(name, pageId, callback).then(resolve, reject);
                });
                waitingGrants.set(name, grants);
            });
        };
        return { request } as unknown as CapabilityProbeLocks;
    };

    return {
        forPage,
        stopPage: (pageId: string): void => {
            for (const [ name, holder ] of [ ...holders ]) {
                if (holder === pageId) {
                    releaseLock(name);
                }
            }
        }
    };
}
