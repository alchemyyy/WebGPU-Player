import DolbyVisionRPUParser, {
    type DolbyVisionRPUContainerProfile,
    type DolbyVisionRPUSnapshot
} from './DolbyVisionRPUParser';

export type DolbyVisionRPUParserPort = {
    close: () => void
    parse: (rpuNALUnit: Uint8Array) => DolbyVisionRPUSnapshot
    parseAV1ITUTT35: (payload: Uint8Array) => DolbyVisionRPUSnapshot
    reset: () => void
};

export type DolbyVisionRPUParserSessionDependencies = {
    createParser: (wasmURL: string, containerProfile: DolbyVisionRPUContainerProfile) => Promise<DolbyVisionRPUParserPort>
};

type ParserInitializationResult = {
    error: unknown
    parser: DolbyVisionRPUParserPort | null
};

/** Creates a parser that gives an RPU whose header reveals no profile the container's. */
async function createContainerProfileParser(
    wasmURL: string,
    containerProfile: DolbyVisionRPUContainerProfile
): Promise<DolbyVisionRPUParserPort> {
    const parser = await DolbyVisionRPUParser.create(wasmURL);
    try {
        parser.setContainerProfile(containerProfile);
    } catch (error) {
        parser.close();
        throw error;
    }
    return parser;
}

const DEFAULT_DEPENDENCIES: DolbyVisionRPUParserSessionDependencies = {
    createParser: createContainerProfileParser
};

function releaseParser(parser: DolbyVisionRPUParserPort): void {
    try {
        parser.reset();
    } catch {
        // The parser is closed below even when its reset fails
    }
    try {
        parser.close();
    } catch {
        // Ownership still ends when an implementation throws during close
    }
}

/** Lazily owns one stateful parser without delaying ordinary HEVC packets. */
export default class DolbyVisionRPUParserSession {
    private closed = false;
    private initialization!: Promise<ParserInitializationResult>;
    private parser: DolbyVisionRPUParserPort | null = null;

    private constructor() {
        // Use create() so asynchronous initialization starts outside construction
    }

    /**
     * Starts non-blocking parser initialization for one decode generation.
     * The container's profile is what an RPU whose header reveals none takes, as FFmpeg's takes the configuration record's.
     */
    public static create(
        wasmURL: string,
        containerProfile: DolbyVisionRPUContainerProfile,
        dependencies: DolbyVisionRPUParserSessionDependencies = DEFAULT_DEPENDENCIES
    ): DolbyVisionRPUParserSession {
        const session = new DolbyVisionRPUParserSession();
        session.initialization = session.initializeParser(wasmURL, containerProfile, dependencies);
        return session;
    }

    private initializeParser(
        wasmURL: string,
        containerProfile: DolbyVisionRPUContainerProfile,
        dependencies: DolbyVisionRPUParserSessionDependencies
    ): Promise<ParserInitializationResult> {
        return dependencies.createParser(wasmURL, containerProfile).then(
            (parser: DolbyVisionRPUParserPort): ParserInitializationResult => {
                if (this.closed) {
                    releaseParser(parser);
                    return {
                        error: new Error('Dolby Vision parser session is closed'),
                        parser: null
                    };
                }
                this.parser = parser;
                return { error: null, parser };
            },
            (error: unknown): ParserInitializationResult => ({ error, parser: null })
        );
    }

    /** Parses one owned HEVC RPU NAL unit in decode order into transferable packed data. */
    public async parse(rpuNALUnit: Uint8Array): Promise<ArrayBuffer> {
        const parser = await this.waitForParser();
        return parser.parse(rpuNALUnit).packedData;
    }

    /**
     * Parses the owned ITU-T T.35 payload of one AV1 Dolby Vision metadata OBU in decode order into transferable packed data.
     * It shares the mapping and display metadata state of parse.
     */
    public async parseAV1ITUTT35(payload: Uint8Array): Promise<ArrayBuffer> {
        const parser = await this.waitForParser();
        return parser.parseAV1ITUTT35(payload).packedData;
    }

    /** Invalidates the generation and retires the parser. Later calls do nothing. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const parser = this.parser;
        this.parser = null;
        if (parser) {
            releaseParser(parser);
        }
    }

    private async waitForParser(): Promise<DolbyVisionRPUParserPort> {
        this.requireOpen();
        const initialization = await this.initialization;
        this.requireOpen();
        if (!initialization.parser) {
            throw initialization.error;
        }
        return initialization.parser;
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error('Dolby Vision parser session is closed');
        }
    }
}
