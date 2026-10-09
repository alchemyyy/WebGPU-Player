// Audio sink comparison shared by the audio output tests

type AudioSinkRequest = string | Readonly<{ type: 'none' }>;

/** Compares sinks the way browsers short-circuit a request for the current sink, which AudioContext.setSinkId settles without touching the output. */
export function isSameAudioSink(currentSink: AudioSinkRequest, requestedSink: AudioSinkRequest): boolean {
    if (typeof currentSink === 'string' || typeof requestedSink === 'string') {
        return currentSink === requestedSink;
    }
    return currentSink.type === requestedSink.type;
}
