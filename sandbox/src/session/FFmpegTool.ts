// ffmpeg.wasm, loaded on first use: ffprobe tells what a local file holds, and ffmpeg converts its subtitles to WebVTT.
import { FFFSType, FFmpeg, type LogEvent } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

// Each command reads its file through a fresh WORKERFS mount, which reads the file lazily instead of copying it into memory
const MOUNT_DIRECTORY_PREFIX = '/input-';
const OUTPUT_PATH = '/output';
const TEXT_ENCODING = 'utf8';
// ffmpeg ends through exit_program, which reports its exit code
const FFMPEG_SUCCESS_EXIT_CODES: ReadonlySet<number> = new Set<number>([ 0 ]);
// NOTE: ffmpeg.wasm reports -1 whenever ffprobe returns from main, failed or not, because only exit_program sets the code
const FFPROBE_RETURNED_EXIT_CODE = -1;
const FFPROBE_SUCCESS_EXIT_CODES: ReadonlySet<number> = new Set<number>([ 0, FFPROBE_RETURNED_EXIT_CODE ]);
// A failure's detail keeps the last lines the tool logged, where FFmpeg names what failed
const MAXIMUM_FAILURE_LOG_LINES = 3;
const LOG_LINE_SEPARATOR = ' | ';
const QUIET_LOG_LEVEL = [ '-v', 'error' ];
// So ffprobe prints a file it cannot read as an error section in its output, which the output parsers throw
const SHOW_ERROR = '-show_error';
const JSON_OUTPUT_FORMAT = [ '-of', 'json' ];
const WEBVTT_OUTPUT = [ '-c:s', 'webvtt', '-f', 'webvtt' ];
// A subtitle file's first subtitle stream
const FIRST_SUBTITLE_STREAM = '0:s:0';

/** Runs ffprobe and ffmpeg over local files; one command runs at a time, in call order. */
export type FFmpegTool = Readonly<{
    /** Returns what ffprobe prints for a file as JSON with the given options, which is an error section when ffprobe cannot read the file */
    probe: (file: File, options: readonly string[]) => Promise<string>
    /** Returns a subtitle stream of a media file, or the first subtitle stream of a subtitle file when the index is null, as WebVTT text */
    convertSubtitleToWebVTT: (file: File, streamIndex: number | null) => Promise<string>
}>;

type MountedFile = Readonly<{
    directory: string
    path: string
}>;

export function createFFmpegTool(): FFmpegTool {
    let loadedFFmpeg: Promise<FFmpeg> | null = null;
    let queue: Promise<unknown> = Promise.resolve();
    let mountCount = 0;

    /** Loads the core once; a failed load is retried by the next command. */
    const loadFFmpeg = (): Promise<FFmpeg> => {
        if (loadedFFmpeg === null) {
            const ffmpeg = new FFmpeg();
            loadedFFmpeg = ffmpeg.load({ coreURL, wasmURL }).then((): FFmpeg => ffmpeg, (error: unknown): never => {
                loadedFFmpeg = null;
                ffmpeg.terminate();
                throw error;
            });
        }
        return loadedFFmpeg;
    };

    /** Runs commands one at a time, since one core runs one command at a time. */
    const enqueue = <Result>(task: () => Promise<Result>): Promise<Result> => {
        const run = queue.then(task, task);
        queue = run.catch((): void => undefined);
        return run;
    };

    const mountFile = async (ffmpeg: FFmpeg, file: File): Promise<MountedFile> => {
        mountCount += 1;
        const directory = `${MOUNT_DIRECTORY_PREFIX}${mountCount}`;
        await ffmpeg.createDir(directory);
        await ffmpeg.mount(FFFSType.WORKERFS, { files: [ file ] }, directory);
        return { directory, path: `${directory}/${file.name}` };
    };

    const unmountFile = async (ffmpeg: FFmpeg, mountedFile: MountedFile): Promise<void> => {
        await ffmpeg.unmount(mountedFile.directory);
        await ffmpeg.deleteDir(mountedFile.directory);
    };

    /**
     * Runs one command over a mounted file and returns its output file as text.
     * An exit code outside the tool's successful ones rejects with `<tool> exit <code>: <last logged lines>`, and a missing output with `<tool> wrote no output: <last logged lines>`.
     */
    const runCommand = (
        file: File,
        toolName: string,
        successExitCodes: ReadonlySet<number>,
        runTool: (ffmpeg: FFmpeg, inputPath: string) => Promise<number>
    ): Promise<string> => enqueue(async (): Promise<string> => {
        const ffmpeg = await loadFFmpeg();
        const loggedLines: string[] = [];
        const onLog = (event: LogEvent): void => {
            loggedLines.push(event.message);
            if (loggedLines.length > MAXIMUM_FAILURE_LOG_LINES) {
                loggedLines.shift();
            }
        };
        const mountedFile = await mountFile(ffmpeg, file);
        ffmpeg.on('log', onLog);
        try {
            const exitCode = await runTool(ffmpeg, mountedFile.path);
            if (!successExitCodes.has(exitCode)) {
                throw new Error(`${toolName} exit ${exitCode}: ${loggedLines.join(LOG_LINE_SEPARATOR)}`);
            }
            const output = await ffmpeg.readFile(OUTPUT_PATH, TEXT_ENCODING).catch((): never => {
                throw new Error(`${toolName} wrote no output: ${loggedLines.join(LOG_LINE_SEPARATOR)}`);
            });
            if (typeof output !== 'string') {
                throw new TypeError(`${toolName} output is not text`);
            }
            return output;
        } finally {
            ffmpeg.off('log', onLog);
            // A command that failed before writing left no output, and no later command may read a stale one
            await ffmpeg.deleteFile(OUTPUT_PATH).catch((): boolean => false);
            await unmountFile(ffmpeg, mountedFile);
        }
    });

    return {
        convertSubtitleToWebVTT: (file: File, streamIndex: number | null): Promise<string> => runCommand(
            file,
            'ffmpeg',
            FFMPEG_SUCCESS_EXIT_CODES,
            (ffmpeg: FFmpeg, inputPath: string): Promise<number> => ffmpeg.exec([
                ...QUIET_LOG_LEVEL,
                '-i',
                inputPath,
                '-map',
                streamIndex === null ? FIRST_SUBTITLE_STREAM : `0:${streamIndex}`,
                ...WEBVTT_OUTPUT,
                OUTPUT_PATH
            ])
        ),
        probe: (file: File, options: readonly string[]): Promise<string> => runCommand(
            file,
            'ffprobe',
            FFPROBE_SUCCESS_EXIT_CODES,
            (ffmpeg: FFmpeg, inputPath: string): Promise<number> => ffmpeg.ffprobe([
                ...QUIET_LOG_LEVEL,
                SHOW_ERROR,
                ...options,
                ...JSON_OUTPUT_FORMAT,
                inputPath,
                '-o',
                OUTPUT_PATH
            ])
        )
    };
}
