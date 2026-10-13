import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createFFmpegTool } from '../../../sandbox/src/session/FFmpegTool';
import { createProbeJSON, createVideoStreamJSON } from './ffprobeTestOutput';

type LogHandler = (event: { message: string, type: string }) => void;

// ffmpeg.wasm as its sources behave: a command logs, may write its output file, and reports an exit code
const ffmpegMocks = vi.hoisted(() => ({
    exitCode: 0,
    files: new Map<string, string>(),
    instances: [] as Array<Record<string, Mock>>,
    loggedLines: [] as string[],
    // The worker rejects with the error's text
    missingFileError: 'ErrnoError: FS error',
    output: null as string | null
}));

vi.mock('@ffmpeg/ffmpeg', () => ({
    FFFSType: { WORKERFS: 'WORKERFS' },
    FFmpeg: class {
        private readonly logHandlers = new Set<LogHandler>();

        constructor() {
            ffmpegMocks.instances.push(this as unknown as Record<string, Mock>);
        }

        createDir = vi.fn(() => Promise.resolve(true));
        deleteDir = vi.fn(() => Promise.resolve(true));
        deleteFile = vi.fn((path: string) => (
            ffmpegMocks.files.delete(path) ? Promise.resolve(true) : Promise.reject(ffmpegMocks.missingFileError)
        ));
        exec = vi.fn((args: string[]) => this.run(args));
        ffprobe = vi.fn((args: string[]) => this.run(args));
        load = vi.fn(() => Promise.resolve(true));
        mount = vi.fn(() => Promise.resolve(true));
        off = vi.fn((_event: string, handler: LogHandler): void => {
            this.logHandlers.delete(handler);
        });
        on = vi.fn((_event: string, handler: LogHandler): void => {
            this.logHandlers.add(handler);
        });
        readFile = vi.fn((path: string) => {
            const content = ffmpegMocks.files.get(path);
            return content === undefined ? Promise.reject(ffmpegMocks.missingFileError) : Promise.resolve(content);
        });
        terminate = vi.fn();
        unmount = vi.fn(() => Promise.resolve(true));

        /** Logs the configured lines, writes the output to the command's last argument, and reports the exit code. */
        private run(args: string[]): Promise<number> {
            for (const message of ffmpegMocks.loggedLines) {
                for (const handler of this.logHandlers) {
                    handler({ message, type: 'stderr' });
                }
            }
            if (ffmpegMocks.output !== null) {
                ffmpegMocks.files.set(String(args.at(-1)), ffmpegMocks.output);
            }
            return Promise.resolve(ffmpegMocks.exitCode);
        }
    }
}));

const MEDIA_FILE_NAME = 'feature.mkv';
// Every command mounts its file in the input folder of its own core
const MOUNT_DIRECTORY = '/input';
const OUTPUT_PATH = '/output';
const STREAM_PROBE_OPTIONS = [ '-show_format', '-show_streams' ];
const FIRST_FRAME_PROBE_OPTIONS = [ '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames' ];
const PROBE_OUTPUT = createProbeJSON([ createVideoStreamJSON() ]);
const WEBVTT_OUTPUT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour.\n';
const SUBTITLE_STREAM_INDEX = 2;
const LOGGED_LINES = [ 'first line', 'second line', 'third line', 'fourth line' ];
// A failure keeps the last three lines
const LAST_LOGGED_LINES = 'second line | third line | fourth line';
// What ffmpeg.wasm reports when ffprobe returns from main, failed or not
const FFPROBE_RETURNED_EXIT_CODE = -1;
// What exit_program reports for a command it ended, such as one with an unknown option
const EXIT_PROGRAM_FAILURE_CODE = 1;

function createMediaFile(): File {
    return new File([ 'media' ], MEDIA_FILE_NAME);
}

function getFFmpeg(): Record<string, Mock> {
    return ffmpegMocks.instances[0];
}

describe('FFmpegTool', () => {
    beforeEach(() => {
        ffmpegMocks.exitCode = 0;
        ffmpegMocks.files.clear();
        ffmpegMocks.instances.length = 0;
        ffmpegMocks.loggedLines = [];
        ffmpegMocks.output = null;
    });

    it('reads ffprobe output after the -1 a returned ffprobe reports, and terminates the core', async () => {
        ffmpegMocks.exitCode = FFPROBE_RETURNED_EXIT_CODE;
        ffmpegMocks.output = PROBE_OUTPUT;

        const output = await createFFmpegTool().probe(createMediaFile(), STREAM_PROBE_OPTIONS);

        expect(output).toBe(PROBE_OUTPUT);
        const ffmpeg = getFFmpeg();
        expect(ffmpeg.mount).toHaveBeenCalledWith('WORKERFS', { files: [ expect.any(File) ] }, MOUNT_DIRECTORY);
        expect(ffmpeg.ffprobe).toHaveBeenCalledWith([
            '-v',
            'error',
            '-show_error',
            ...STREAM_PROBE_OPTIONS,
            '-of',
            'json',
            `${MOUNT_DIRECTORY}/${MEDIA_FILE_NAME}`,
            '-o',
            OUTPUT_PATH
        ]);
        expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
    });

    it('runs every command on a fresh core, since ffprobe keeps its options in globals between runs', async () => {
        ffmpegMocks.exitCode = FFPROBE_RETURNED_EXIT_CODE;
        ffmpegMocks.output = PROBE_OUTPUT;
        const tool = createFFmpegTool();

        await tool.probe(createMediaFile(), FIRST_FRAME_PROBE_OPTIONS);
        await tool.probe(createMediaFile(), STREAM_PROBE_OPTIONS);

        expect(ffmpegMocks.instances).toHaveLength(2);
        for (const ffmpeg of ffmpegMocks.instances) {
            expect(ffmpeg.load).toHaveBeenCalledTimes(1);
            expect(ffmpeg.ffprobe).toHaveBeenCalledTimes(1);
            expect(ffmpeg.terminate).toHaveBeenCalledTimes(1);
        }
    });

    it('rejects an exit code exit_program reported with the last logged lines, and terminates the core', async () => {
        ffmpegMocks.exitCode = EXIT_PROGRAM_FAILURE_CODE;
        ffmpegMocks.loggedLines = [ ...LOGGED_LINES ];
        ffmpegMocks.output = PROBE_OUTPUT;

        await expect(createFFmpegTool().probe(createMediaFile(), STREAM_PROBE_OPTIONS)).rejects.toThrow(
            `ffprobe exit ${EXIT_PROGRAM_FAILURE_CODE}: ${LAST_LOGGED_LINES}`
        );

        expect(getFFmpeg().terminate).toHaveBeenCalledTimes(1);
    });

    it('rejects a command that wrote no output with the last logged lines', async () => {
        ffmpegMocks.exitCode = FFPROBE_RETURNED_EXIT_CODE;
        ffmpegMocks.loggedLines = [ ...LOGGED_LINES ];

        await expect(createFFmpegTool().probe(createMediaFile(), STREAM_PROBE_OPTIONS)).rejects.toThrow(
            `ffprobe wrote no output: ${LAST_LOGGED_LINES}`
        );
    });

    it('requires ffmpeg to exit 0, since ffmpeg always ends through exit_program', async () => {
        const tool = createFFmpegTool();
        ffmpegMocks.output = WEBVTT_OUTPUT;

        await expect(tool.convertSubtitleToWebVTT(createMediaFile(), SUBTITLE_STREAM_INDEX)).resolves.toBe(WEBVTT_OUTPUT);
        expect(getFFmpeg().exec).toHaveBeenCalledWith(expect.arrayContaining([ '-map', `0:${SUBTITLE_STREAM_INDEX}` ]));

        ffmpegMocks.exitCode = FFPROBE_RETURNED_EXIT_CODE;
        await expect(tool.convertSubtitleToWebVTT(createMediaFile(), SUBTITLE_STREAM_INDEX)).rejects.toThrow(
            `ffmpeg exit ${FFPROBE_RETURNED_EXIT_CODE}`
        );
    });
});
