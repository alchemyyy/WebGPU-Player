// ffmpeg.wasm, a fresh core per command: ffprobe tells what a local file holds, and ffmpeg converts its subtitles to WebVTT.
import { FFFSType, FFmpeg, type LogEvent } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

// The command reads its file through a WORKERFS mount, which reads the file lazily instead of copying it into memory
const MOUNT_DIRECTORY = '/input';
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

/**
 * Loads a core for one command, since a core keeps a command's state for the next.
 * NOTE: ffprobe keeps its options in globals, so on a used core a stream probe kept the frame probe's -show_frames and walked every frame of its file, which never ends for a large one
 */
async function loadFFmpeg(): Promise<FFmpeg> {
    const ffmpeg = new FFmpeg();
    try {
        await ffmpeg.load({ coreURL, wasmURL });
    } catch (error) {
        ffmpeg.terminate();
        throw error;
    }
    return ffmpeg;
}

export function createFFmpegTool(): FFmpegTool {
    let queue: Promise<unknown> = Promise.resolve();

    /** Runs commands one at a time, so only one core holds its memory at a time. */
    const enqueue = <Result>(task: () => Promise<Result>): Promise<Result> => {
        const run = queue.then(task, task);
        queue = run.catch((): void => undefined);
        return run;
    };

    /**
     * Runs one command over a mounted file on a fresh core and returns its output file as text.
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
        ffmpeg.on('log', (event: LogEvent): void => {
            loggedLines.push(event.message);
            if (loggedLines.length > MAXIMUM_FAILURE_LOG_LINES) {
                loggedLines.shift();
            }
        });
        try {
            await ffmpeg.createDir(MOUNT_DIRECTORY);
            await ffmpeg.mount(FFFSType.WORKERFS, { files: [ file ] }, MOUNT_DIRECTORY);
            const exitCode = await runTool(ffmpeg, `${MOUNT_DIRECTORY}/${file.name}`);
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
            // The core goes with its mount, its output, and its state
            ffmpeg.terminate();
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
