# Temporal

## Reads

- A pass declares history reads on a stage or a saved name, such as `RGB[-1]` and `RGB[-2]`.
- A pass can also declare a persistent state buffer that survives from frame to frame, for example a smoothed scene peak for dynamic tone mapping.

## Rings

- A stage that is read with history N gets a ring of N + 1 owned textures.
- The producing pass renders straight into the current slot; readers bind the earlier slots.
- The bind groups for every ring position are built with the plan, so a new frame only selects a set and never creates one.
- No frame is ever copied into history.

## Advancing and resetting

- History advances only on a new frame, never on a redraw.
- It resets on a seek, a new generation, a video epoch change, a timestamp discontinuity, or a plan change that affects the stage.
- The globals carry `history_valid`, from 0 to N, so a pass can blend toward its non-temporal result while history refills.
- The globals carry the number of frames `CustomDecodeSession.takeFrame` dropped since the last presented frame, so a pass can treat a skip as a soft reset.

## Ownership

- History never holds a `VideoFrame` or an external texture.
  External textures expire, and a held frame would keep one of the decoder's frame credits, which are 4 for `VideoFrame` output and 2 for raw planes.
- On the external route, the planner materializes the earliest stage that a temporal pass reads, at source resolution, into the ring.
  That render is the only cost temporal support adds, and it exists only while a temporal pass is active.

## Memory

- A pass declares the components it needs, and the ring uses the smallest format that holds them.
- At 4K, luma-only history costs 16.6 MB per slot as `r16float`, against 66.4 MB as `rgba16float`.
- At 1080p, every figure is a quarter of that.
