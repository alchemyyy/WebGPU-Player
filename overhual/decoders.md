# Decoders

Users can drop in a WGSL compute decoder for a video codec, beside the presentation passes.
A decoder takes compressed packets and writes decoded planes, entirely in compute shaders, on the presenter's GPU device.
The engine stays codec-agnostic: it demuxes, moves packets, keeps timestamps, manages the frame pool, and verifies a decoder before routing streams to it.

## What decodes well on a GPU

Good fits:
- Intra-only codecs with independently coded slices or tiles: ProRes, DNxHR, FFV1, Motion JPEG with restart markers, VC-2, and APV.
- JPEG 2000 and HTJ2K, whose code-blocks are entropy coded independently.
  The engine decodes 8-bit JPEG 2000 with OpenJPEG in WebAssembly today.
- Learned codecs, whose synthesis is convolutions.

Poor fits:
- H.264, HEVC, VP9, and AV1: their entropy decoding is serial within a slice, tile, or wavefront row, which many streams do not split, so a WGSL decoder is rarely real-time at 4K.
  Those codecs keep their WebCodecs and WebAssembly routes.

## Module

A decoder is one WGSL module with several compute entry points and a `//!` header, plus an optional conformance vector.

```wgsl
//! name: ProRes 422
//! decoder: video
//! accepts: codec in [apch, apcn, apcs, apco], width <= 8192, height <= 4320
//! output: I422P10
//! references: 0
//! reorder: 0
//! packet: 16 MiB
//! state: 64 KiB
//! buffer: slice_dispatch, indirect, 12
//! requires: subgroups
//! dispatch: parse_frame_header, 1
//! dispatch: decode_slices, indirect slice_dispatch
//! dispatch: inverse_transform, stream.width / 16, stream.height / 16
//! vector: prores-422-hq.mov, frames 0-2, sha256 <hash of the decoded planes>

@compute @workgroup_size(1)
fn parse_frame_header() {
    // Reads the frame header from packet_bytes and writes the slice count into slice_dispatch
}
```

| Directive | Meaning |
| --- | --- |
| `decoder` | `video` |
| `accepts` | The streams it takes: container codec identifiers and limits on stream facts |
| `output` | The plane format it writes, such as `I420P10` or `I422P10` |
| `references` | The pool slots it keeps as references |
| `reorder` | How many frames presentation order can trail decode order |
| `packet` | The largest packet, which sizes the ring |
| `state` | The size of a persistent buffer for decoder state |
| `buffer` | A named scratch buffer; `indirect` makes it usable for indirect dispatch |
| `requires` | Optional device features and limits |
| `dispatch` | Entry points in order, each with a workgroup count expression or `indirect <buffer>` |
| `vector` | The conformance vector, the frames to check, and the expected hash |

The generated prelude binds:
- `packet_bytes`: the ring of packets, read-only;
- `packet`: the packet's offset, size, index, keyframe and reset flags, and output slot, through one uniform buffer with dynamic offsets, so a packet never creates a bind group;
- `config`: the codec private data from the container;
- `stream`: the stream facts, including each plane's offset and row pitch within a slot;
- `state`: the persistent state buffer;
- `pool`: the frame pool, with helpers that write samples to the output slot and read reference slots;
- `status`: errors, freed slots, and header-parse facts, read back asynchronously;
- the named scratch buffers.

Dispatch counts that depend on the bitstream come from `dispatchWorkgroupsIndirect`, written by an earlier entry point, so the CPU never reads the bitstream.

## Route

- Ingress: the worker demuxes as usual and posts compressed packets to the page instead of frames.
  The page writes each packet into a ring buffer on the GPU, which is the only CPU to GPU transfer, at compressed size.
- Placement: the decoder runs on the presenter's device, on the main thread, because decoded frames must stay in GPU memory; a decoder on any other device would need a readback.
- Frames: decoded planes live in a frame pool, one storage buffer of slots, which the fixed `SIGNAL` stage reads directly, so a frame is never copied, not even on the GPU.
  - Core WebGPU has no 16-bit storage texture formats such as `r16uint`, which is why planes are buffers.
  - Today's raw planes are integer textures read with four loads per bilinear sample, so reading planes from a buffer costs about the same.
- Timing: presentation times come from the container; with `reorder: N`, the engine presents slots in timestamp order, holding back up to N frames.
- Slots: a decoder without references frees a slot when presentation releases it.
  A decoder with references reports freed slots in its status buffer, which the engine reads back asynchronously a few frames behind; the pool holds enough spare slots that nothing waits on that read.
- Credits: free slots are the route's frame credits.
- Pacing: the page submits decode work in per-frame units right after a presentation submit, and only as far ahead as the pool allows, so presentation never queues behind more than one frame of decode work on the shared queue.
- Seeking: the worker restarts at the preceding keyframe from the container's index, and that packet carries the reset flag, which clears the decoder's state.
- Metadata: per-frame metadata the decoder extracts, such as dynamic HDR metadata, goes to a buffer that presentation passes read on the GPU.
- Temporal: presentation passes read the history of decoded frames from pool slots directly; the pool keeps a slot until neither the decoder nor history needs it.

## Selection and verification

- A decoder takes a stream when the stream matches `accepts`, its vector passed on the current device, and policy allows it.
  By default engine routes come first, and user decoders take streams no engine route plays, unless the user prefers a decoder.
- The vector check works like route authorization: decode the vector, read back the planes, and compare them with the declared hash.
  The result is cached per device and decoder hash, and checked again after a device loss.
- A decoder without a vector runs only when the user forces it, and reports as unverified.
- Stream facts the planner needs (size, plane format, color description) come from the container, or from one readback of the decoder's header parse when the stream starts; nothing is read back per frame.
- The demuxer must pass through packets of codecs it does not recognize, with the container's codec identifier and private data.

## Limits and features

- The pool is one storage buffer, so the engine requests `maxBufferSize` and `maxStorageBufferBindingSize` large enough for it; a stream whose pool exceeds what the adapter allows is not eligible for that decoder.
- Features cannot be added to a device after it is created, so the engine creates its device with every optional feature that installed decoders and passes declare, where the adapter offers it.

## Failures

- WGSL is bounds-checked, so a malformed bitstream cannot corrupt memory, but it can make a decoder loop until the GPU watchdog fires and the device is lost.
- A decoder shares the presenter's device, so its fault takes presentation down too.
  Recovery rebuilds without the decoder and disables it for the session, and the session falls back as any failed route does.
- An error the decoder reports in its status buffer ends the attempt the same way, without a device loss.

## Out of scope

- Audio decoders.
- Hybrid decoders, with entropy decoding in WebAssembly and reconstruction in WGSL, which need user code beyond WGSL.
