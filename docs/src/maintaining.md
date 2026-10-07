# Maintaining this book

The book is the engine's only documentation, for people and for coding agents
alike. It is built with [mdBook](https://github.com/rust-lang/mdBook) 0.5.

## Build and read it

1. Install mdBook once: `cargo install mdbook --version 0.5.4 --locked`.
2. From the engine root, run `mdbook serve docs --open` while editing; it
   rebuilds on every save.
3. Before committing, run `mdbook build docs`. It writes the ignored
   `docs/book/` and fails on a broken `SUMMARY.md`.

`docs/book.toml` holds the configuration, and `docs/src/SUMMARY.md` the table
of contents. A chapter that is not listed in `SUMMARY.md` is not built.

## When to update it

Update the chapter in the same change that alters what it describes:

- a route, a probe, a route key, or an eligibility rule: [Negotiation and
  routes](negotiation.md) and [HEVC and Dolby Vision support](codec-support.md);
- a file added, moved, or removed: [Module map](module-map.md), and
  [Repository layout](layout.md) for a folder;
- a decoder or a build step: [WebAssembly decoders](decoders.md);
- a vector or a generator: [Codec vectors](codec-vectors.md);
- a settled investigation: [Decisions](decisions.md). Treat it as append-only:
  revise an entry when the facts change, rather than adding a contradicting
  one.

## How to write it

- Record durable facts: architecture, routes, layout, procedures, and
  decisions. Git already records history and working-tree state, so there are
  no changelogs, status snapshots, or "uncommitted" notes.
- Write procedures as recipes: what you need, numbered steps, then how to
  check the result.
- Prefer plain sentences and short lists. Use a table only for data that has
  columns. Keep bold, callouts, and decoration out.
- Use ASCII only.
- Follow the path conventions in the [Introduction](introduction.md): engine
  paths from the engine root, host paths from the plugin root marked (host).
- Never include credentials, server addresses, item IDs, media titles or
  paths, or absolute machine paths.
