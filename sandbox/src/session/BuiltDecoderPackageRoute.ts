// The dev server's route that lists the engine's built decoder packages; vite.config.ts serves it and the sandbox fetches it.
// It imports nothing, because the dev server's config loads it without the sandbox's aliases

/** The dev server's route that lists the files in the decoder package output folder, as JSON entries of a file name and the URL it is served at. */
export const BUILT_DECODER_PACKAGES_ROUTE = '/__sandbox/built-decoder-packages';

/** A file the dev server lists in the decoder package output folder. */
export type BuiltDecoderPackageEntry = Readonly<{ fileName: string, url: string }>;
