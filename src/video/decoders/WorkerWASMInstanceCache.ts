type CachedWASMInstance<Instance> = {
    instance: Instance | null
    promise: Promise<Instance>
    source: unknown
};

/**
 * Holds the one instance of a WebAssembly decoder kit that a worker's decoders share, so the worker instantiates each kit once and every decoder creates only its own native context in it.
 * A failed instantiation is forgotten, and so is an instance whose code trapped, so the next decoder gets a fresh one.
 */
export default class WorkerWASMInstanceCache<Instance> {
    private cachedInstance: CachedWASMInstance<Instance> | null = null;

    /**
     * Returns the instance made from a source, such as a kit's glue factory or its binary's URL, and instantiates it on first use.
     * Another source replaces the cached instance, since a worker loads each kit from one source.
     */
    public load(source: unknown, instantiate: () => Promise<Instance>): Promise<Instance> {
        const currentInstance = this.cachedInstance;
        if (currentInstance && currentInstance.source === source) {
            return currentInstance.promise;
        }

        const cachedInstance: CachedWASMInstance<Instance> = {
            instance: null,
            promise: instantiate(),
            source
        };
        this.cachedInstance = cachedInstance;
        cachedInstance.promise = cachedInstance.promise.then(
            (instance: Instance): Instance => {
                cachedInstance.instance = instance;
                return instance;
            },
            (error: unknown): never => {
                if (this.cachedInstance === cachedInstance) {
                    this.cachedInstance = null;
                }
                throw error;
            }
        );
        return cachedInstance.promise;
    }

    /** Forgets an instance whose code trapped, so its memory is never trusted again; decoders that hold it keep it until they close. */
    public discard(instance: Instance): void {
        if (this.cachedInstance?.instance === instance) {
            this.cachedInstance = null;
        }
    }
}

/** Returns whether an error is a WebAssembly trap or an Emscripten abort, after which an instance's memory may be inconsistent. */
export function isWASMTrap(error: unknown): boolean {
    return error instanceof WebAssembly.RuntimeError;
}
